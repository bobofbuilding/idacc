#!/usr/bin/env node
/**
 * brain-eval.mjs — Brain eval-replay harness & regression gate (Plan 22, item 17).
 *
 * The GAP this fills: the eval *routes* (routes/eval.mjs: /eval/capture, /eval/replay)
 * and the in-cycle quality check (cycle/eval-quality.mjs) already exist, but there is
 * no standalone orchestrator an operator/CI can run around a scoring/retrieval change.
 * This tool REUSES those endpoints (it adds no retrieval logic of its own):
 *
 *   - snapshot : re-execute every captured eval query NOW and record the retrieved
 *                source-id set per query (reuses POST /query/fts|local|global|drift, or
 *                POST /eval/replay {fixture_mode} for promoted fixtures).
 *   - baseline : snapshot, written to a file (run this BEFORE a scoring change).
 *   - compare  : snapshot again (run AFTER the change), diff against the baseline, and
 *                report Jaccard + top-1 overlap per query plus recall vs ground truth,
 *                then GATE: exit non-zero if a tuning change drops recall / overlap.
 *   - retrieval-metrics : run every ground-truth eval query through ALL retrieval modes
 *                (fts|local|global|drift) and report a per-mode quality table —
 *                precision@k, recall@k, MRR, NDCG@k, source coverage, answerable rate,
 *                and p50/p95 latency. With --baseline it GATEs: exit non-zero if any
 *                ranked metric drops > --max-metric-drop or p95 latency regresses
 *                > --max-latency-regress. Lets you compare modes head-to-head AND block
 *                tuning changes that quietly degrade retrieval quality.
 *
 * Config is via flags or env; the only network dependency is the Brain HTTP API
 * (BRAIN_URL, default http://127.0.0.1:4200), reached through brain-client.mjs.
 *
 * Usage:
 *   node brain-eval.mjs baseline  [--source queries|fixtures] [--route R] [--limit N] [--out PATH] [--json]
 *   node brain-eval.mjs compare   --baseline PATH [opts] [--min-jaccard X] [--min-top1 X] [--max-recall-drop X] [--min-recall X] [--report PATH] [--json] [--fail-on-empty]
 *   node brain-eval.mjs snapshot  [--source ...] [--route R] [--limit N] [--json]
 *   node brain-eval.mjs retrieval-metrics [--k N] [--modes fts,local,global,drift] [--limit N] [--retrieve-limit N] [--out PATH] [--baseline PATH] [--max-metric-drop X] [--max-latency-regress X] [--report PATH] [--json] [--fail-on-empty]
 *
 * Exit codes: 0 = pass/no-regression, 1 = GATE FAILED (regression), 2 = usage/IO error.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brainPost } from './brain-client.mjs';

const DEFAULTS = {
  source: process.env.BRAIN_EVAL_SOURCE || 'queries',
  limit: Number(process.env.BRAIN_EVAL_LIMIT ?? 200),
  minJaccard: Number(process.env.BRAIN_EVAL_MIN_JACCARD ?? 0.8),
  minTop1: Number(process.env.BRAIN_EVAL_MIN_TOP1 ?? 0.9),
  maxRecallDrop: Number(process.env.BRAIN_EVAL_MAX_RECALL_DROP ?? 0.05),
  minRecall: Number(process.env.BRAIN_EVAL_MIN_RECALL ?? 0),
};

// ──────────────────────────── small utils ────────────────────────────
function round(n, p = 3) { return n == null ? null : Math.round(n * 10 ** p) / 10 ** p; }
function mean(xs) { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

export function jaccard(a = [], b = []) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;            // both empty ⇒ identical
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}
export function top1Match(a = [], b = []) {
  if (!a.length || !b.length) return null;               // undefined when either side is empty
  return a[0] === b[0];
}
export function recall(returned = [], truth = []) {
  if (!truth.length) return null;                        // no ground truth ⇒ not scored
  const R = new Set(returned);
  let hit = 0;
  for (const t of truth) if (R.has(t)) hit++;
  return hit / truth.length;
}

const canon = {
  entity: (id) => (id == null || id === '' ? null : `entity:${id}`),
  fact: (id) => (id == null || id === '' ? null : `fact:${id}`),
  text: (id) => (id == null || id === '' ? null : `text:${id}`),
};

// ──────────────────────────── retrieval-quality metrics (pure) ────────────────────────────
// All take an ORDERED `returned` id list and a `truth` SET of relevant source ids (binary
// relevance). They return null when there is no ground truth (so they are skipped, never
// counted as 0) — mirroring recall() above. k caps the rank depth that is scored.

export function precisionAtK(returned = [], truth = [], k = 5) {
  if (!truth.length) return null;                        // no ground truth ⇒ not scored
  const top = returned.slice(0, k);
  if (!top.length) return 0;                             // returned nothing ⇒ 0 precision
  const T = new Set(truth);
  let hit = 0;
  for (const id of top) if (T.has(id)) hit++;
  return hit / top.length;
}

export function recallAtK(returned = [], truth = [], k = 5) {
  if (!truth.length) return null;
  const top = new Set(returned.slice(0, k));
  let hit = 0;
  for (const t of truth) if (top.has(t)) hit++;
  return hit / truth.length;
}

// Mean Reciprocal Rank: 1/(rank of first relevant hit), 0 if none in `returned`.
export function reciprocalRank(returned = [], truth = []) {
  if (!truth.length) return null;
  const T = new Set(truth);
  for (let i = 0; i < returned.length; i++) if (T.has(returned[i])) return 1 / (i + 1);
  return 0;
}

// Normalized Discounted Cumulative Gain @k with binary relevance.
export function ndcgAtK(returned = [], truth = [], k = 5) {
  if (!truth.length) return null;
  const T = new Set(truth);
  const top = returned.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) if (T.has(top[i])) dcg += 1 / Math.log2(i + 2);
  const idealHits = Math.min(truth.length, k);           // best case: all relevant ranked first
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// Source coverage: fraction of ground-truth sources surfaced ANYWHERE in `returned`
// (depth-independent). Distinct from recall@k — a mode may surface a source but rank it
// past k; coverage still credits it. Answers "can this mode reach the source at all?".
export function sourceCoverage(returned = [], truth = []) {
  if (!truth.length) return null;
  const R = new Set(returned);
  let hit = 0;
  for (const t of truth) if (R.has(t)) hit++;
  return hit / truth.length;
}

export function percentile(xs = [], p = 50) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

// ──────────────────────────── snapshot (REUSES brain endpoints) ────────────────────────────
// Returns { source, route, items: [{ key, query_text, route, returned[], truth[], recall }] }
export async function snapshot({ source = DEFAULTS.source, route = null, limit = DEFAULTS.limit } = {}) {
  if (source === 'fixtures') return snapshotFixtures({ route, limit });
  return snapshotQueries({ route, limit });
}

async function snapshotFixtures({ route, limit }) {
  // Reuse runEvalFixtureReplay via the route: it re-executes retrieval at request time
  // and returns returned_source_ids (ordered) + required_source_ids (ground truth).
  const r = await brainPost('/eval/replay', { fixture_mode: true, route, limit }, { strict: false });
  const results = r.data?.fixtureReplay?.results ?? [];
  const items = results.map((res) => ({
    key: `fixture:${res.fixture_id}`,
    query_text: res.query_text,
    route: res.route,
    returned: (res.returned_source_ids ?? []).map(String),
    truth: (res.required_source_ids ?? []).map(String),
    recall: recall((res.returned_source_ids ?? []).map(String), (res.required_source_ids ?? []).map(String)),
  }));
  return { source: 'fixtures', route: route ?? 'all', items };
}

async function snapshotQueries({ route, limit }) {
  // Pull captured eval queries (read-only), then RE-EXECUTE each via the matching /query route.
  const replay = await brainPost('/eval/replay', { limit, route }, { strict: false });
  const samples = replay.data?.samples ?? [];
  const items = [];
  for (const s of samples) {
    const q = s.query_text;
    if (!q) continue;
    const r = normalizeReplayRoute(s.route);
    const returned = await reExecute(r, q);
    const truth = (s.accepted_ids ?? []).map(String);
    items.push({ key: `eval:${s.id}`, query_text: q, route: r, returned, truth, recall: recall(returned, truth) });
  }
  return { source: 'queries', route: route ?? 'all', items };
}

function normalizeReplayRoute(route) {
  const r = String(route ?? 'local').toLowerCase();
  if (['fts', 'local', 'global', 'drift', 'questions'].includes(r)) return r;
  if (r.includes('question')) return 'questions';
  if (r.includes('global')) return 'global';
  if (r.includes('drift')) return 'drift';
  if (r.includes('fts')) return 'fts';
  return 'local';
}

async function reExecute(route, q, limit = 10) {
  const path = route === 'global'
    ? '/query/global'
    : route === 'drift'
      ? '/query/drift'
      : route === 'questions'
        ? '/query/questions'
      : route === 'fts'
        ? '/query/fts'
        : '/query/local';
  // Query routes currently consume `q`, while some eval callers still use `query`.
  // Send both with the same value so route variants cannot replay an empty search.
  const r = await brainPost(path, { q, query: q, limit }, { strict: false });
  // The /query/* routes wrap their payload in the standard envelope { ok, data: {...}, meta }.
  // Unwrap one level (falling back to the raw body if a route ever returns payload at top level)
  // so entities/facts/textUnits/reports are read from the right place.
  const d = r.data?.data ?? r.data ?? {};
  if (route === 'global') {
    const ids = [];
    for (const rep of d.reports ?? []) {
      for (const u of rep.source_text_unit_ids ?? []) ids.push(canon.text(u));
      for (const f of rep.fact_ids ?? []) ids.push(canon.fact(f));
    }
    return ids.filter(Boolean);
  }
  if (route === 'drift') {
    return [
      ...(d.local?.entities ?? []).map((e) => canon.entity(e.id)),
      ...(d.local?.facts ?? []).map((f) => canon.fact(f.id)),
      ...(d.local?.textUnits ?? []).map((u) => canon.text(u.id)),
      ...(d.reports ?? []).flatMap((rep) => [
        ...(rep.source_text_unit_ids ?? []).map((u) => canon.text(u)),
        ...(rep.fact_ids ?? []).map((f) => canon.fact(f)),
      ]),
    ].filter(Boolean);
  }
  if (route === 'questions') {
    return [
      ...(d.local?.entities ?? []).map((e) => canon.entity(e.id)),
      ...(d.local?.facts ?? []).map((f) => canon.fact(f.id)),
      ...(d.local?.textUnits ?? []).map((u) => canon.text(u.id)),
    ].filter(Boolean);
  }
  // local: entities → facts → textUnits (same order runEvalFixtureReplay uses)
  return [
    ...(d.entities ?? []).map((e) => canon.entity(e.id)),
    ...(d.facts ?? []).map((f) => canon.fact(f.id)),
    ...(d.textUnits ?? []).map((u) => canon.text(u.id)),
  ].filter(Boolean);
}

// ──────────────────────────── compare + gate ────────────────────────────
export function compareSnapshots(baseline, candidate, thresholds = {}) {
  const t = { ...DEFAULTS, ...thresholds };
  const baseItems = new Map((baseline.items ?? []).map((i) => [i.key, i]));
  const perQuery = [];
  for (const cur of candidate.items ?? []) {
    const base = baseItems.get(cur.key);
    if (!base) continue;
    perQuery.push({
      key: cur.key,
      query_text: cur.query_text,
      route: cur.route,
      jaccard: round(jaccard(base.returned, cur.returned)),
      top1: top1Match(base.returned, cur.returned),
      recall_baseline: round(base.recall),
      recall_candidate: round(cur.recall),
      recall_delta: base.recall != null && cur.recall != null ? round(cur.recall - base.recall) : null,
      returned_baseline: base.returned,
      returned_candidate: cur.returned,
    });
  }

  const matched = perQuery.length;
  const meanJaccard = mean(perQuery.map((p) => p.jaccard));
  const top1Vals = perQuery.map((p) => p.top1).filter((v) => v !== null);
  const top1Rate = top1Vals.length ? top1Vals.filter(Boolean).length / top1Vals.length : null;
  const baselineRecall = mean(perQuery.map((p) => p.recall_baseline));
  const candidateRecall = mean(perQuery.map((p) => p.recall_candidate));
  const recallDrop = baselineRecall != null && candidateRecall != null ? baselineRecall - candidateRecall : null;
  const regressions = perQuery
    .filter((p) => p.recall_delta != null && p.recall_delta < 0)
    .sort((a, b) => a.recall_delta - b.recall_delta);

  // per-route recall deltas
  const byRoute = {};
  for (const p of perQuery) {
    const r = (byRoute[p.route] ??= { baseline: [], candidate: [] });
    if (p.recall_baseline != null) r.baseline.push(p.recall_baseline);
    if (p.recall_candidate != null) r.candidate.push(p.recall_candidate);
  }
  const routeRecall = Object.fromEntries(Object.entries(byRoute).map(([k, v]) => {
    const b = mean(v.baseline), c = mean(v.candidate);
    return [k, { baseline: round(b), candidate: round(c), drop: b != null && c != null ? round(b - c) : null }];
  }));

  // Gate — only enforce metrics that are computable (null ⇒ not enough data, skip)
  const failures = [];
  if (matched === 0) failures.push('no overlapping queries between baseline and candidate');
  if (meanJaccard != null && meanJaccard < t.minJaccard) failures.push(`mean Jaccard ${round(meanJaccard)} < min ${t.minJaccard}`);
  if (top1Rate != null && top1Rate < t.minTop1) failures.push(`top-1 overlap ${round(top1Rate)} < min ${t.minTop1}`);
  if (recallDrop != null && recallDrop > t.maxRecallDrop) failures.push(`recall dropped ${round(recallDrop)} > max allowed ${t.maxRecallDrop}`);
  if (t.minRecall > 0 && candidateRecall != null && candidateRecall < t.minRecall) failures.push(`candidate recall ${round(candidateRecall)} < floor ${t.minRecall}`);
  for (const [route, rr] of Object.entries(routeRecall)) {
    if (rr.drop != null && rr.drop > t.maxRecallDrop) failures.push(`route '${route}' recall dropped ${rr.drop} > max ${t.maxRecallDrop}`);
  }

  return {
    thresholds: { minJaccard: t.minJaccard, minTop1: t.minTop1, maxRecallDrop: t.maxRecallDrop, minRecall: t.minRecall },
    matched,
    baselineItems: baseline.items?.length ?? 0,
    candidateItems: candidate.items?.length ?? 0,
    meanJaccard: round(meanJaccard),
    top1Rate: round(top1Rate),
    baselineRecall: round(baselineRecall),
    candidateRecall: round(candidateRecall),
    recallDrop: round(recallDrop),
    routeRecall,
    regressionCount: regressions.length,
    worstRegressions: regressions.slice(0, 10).map((p) => ({ key: p.key, query_text: p.query_text, recall_delta: p.recall_delta, jaccard: p.jaccard })),
    passed: failures.length === 0,
    failures,
    perQuery,
  };
}

// ──────────────────────────── retrieval-metrics harness ────────────────────────────
// Extends the snapshot/compare gate (above) into a per-MODE quality harness: every captured
// eval query (that has ground truth) is re-executed through EACH retrieval mode so the modes
// can be ranked head-to-head on precision@k / recall@k / MRR / NDCG@k / source-coverage /
// latency. Reuses the same /query/* endpoints — no retrieval logic of its own.

export const RETRIEVAL_MODES = ['fts', 'local', 'global', 'drift', 'questions'];

export const METRIC_DEFAULTS = {
  k: Number(process.env.BRAIN_EVAL_K ?? 5),
  perRouteLimit: Number(process.env.BRAIN_EVAL_RETRIEVE_LIMIT ?? 10),
  maxMetricDrop: Number(process.env.BRAIN_EVAL_MAX_METRIC_DROP ?? 0.05),
  maxLatencyRegress: Number(process.env.BRAIN_EVAL_MAX_LATENCY_REGRESS ?? 0.5), // p95 may grow ≤50%
};

const RANKED_METRIC_KEYS = ['precisionAtK', 'recallAtK', 'mrr', 'ndcgAtK', 'sourceCoverage'];

async function reExecuteTimed(route, q, limit) {
  const t0 = performance.now();
  let returned = [];
  try { returned = await reExecute(route, q, limit); } catch { returned = []; }
  return { returned, latency_ms: round(performance.now() - t0, 2) };
}

// Pull captured eval queries WITH ground truth, then run each through every requested mode.
// Returns { source, modes, k, items: [{ key, query_text, truth[], perMode: { mode: {returned[], latency_ms} } }] }.
export async function retrievalSnapshot({
  modes = RETRIEVAL_MODES,
  limit = DEFAULTS.limit,
  perRouteLimit = METRIC_DEFAULTS.perRouteLimit,
  k = METRIC_DEFAULTS.k,
} = {}) {
  const replay = await brainPost('/eval/replay', { limit }, { strict: false });
  const samples = replay.data?.samples ?? [];
  const items = [];
  for (const s of samples) {
    const q = s.query_text;
    if (!q) continue;
    const truth = (s.accepted_ids ?? []).map(String);
    if (!truth.length) continue;                         // metrics need ground truth
    const perMode = {};
    for (const mode of modes) perMode[mode] = await reExecuteTimed(mode, q, perRouteLimit);
    items.push({ key: `eval:${s.id}`, query_text: q, truth, perMode });
  }
  return { source: 'queries', modes, k, items };
}

// Aggregate a retrievalSnapshot into a per-mode metric table.
export function computeRetrievalMetrics(snapshot, { k = snapshot?.k ?? METRIC_DEFAULTS.k } = {}) {
  const modes = snapshot?.modes ?? RETRIEVAL_MODES;
  const items = snapshot?.items ?? [];
  const byMode = {};
  for (const mode of modes) {
    const rows = [];
    for (const item of items) {
      const pm = item.perMode?.[mode];
      if (!pm) continue;
      rows.push({
        precision: precisionAtK(pm.returned, item.truth, k),
        recall: recallAtK(pm.returned, item.truth, k),
        rr: reciprocalRank(pm.returned, item.truth),
        ndcg: ndcgAtK(pm.returned, item.truth, k),
        coverage: sourceCoverage(pm.returned, item.truth),
        latency: pm.latency_ms,
        answerable: (pm.returned?.length ?? 0) > 0 ? 1 : 0,
      });
    }
    const scored = rows.filter((r) => r.recall != null);
    const latencies = rows.map((r) => r.latency);
    byMode[mode] = {
      queries: rows.length,
      scored: scored.length,
      precisionAtK: round(mean(scored.map((r) => r.precision))),
      recallAtK: round(mean(scored.map((r) => r.recall))),
      mrr: round(mean(scored.map((r) => r.rr))),
      ndcgAtK: round(mean(scored.map((r) => r.ndcg))),
      sourceCoverage: round(mean(scored.map((r) => r.coverage))),
      answerableRate: round(mean(rows.map((r) => r.answerable))),
      latencyMs: { mean: round(mean(latencies), 1), p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    };
  }
  return { k, modes, totalQueries: items.length, scoredQueries: items.length, byMode };
}

// Gate a candidate metric table against a baseline: fail if any ranked metric drops more than
// maxMetricDrop, or any mode's p95 latency regresses more than maxLatencyRegress (fractional).
export function compareRetrievalMetrics(baseline, candidate, thresholds = {}) {
  const t = { ...METRIC_DEFAULTS, ...thresholds };
  const modes = candidate?.modes ?? Object.keys(candidate?.byMode ?? {});
  const failures = [];
  const perMode = {};
  let comparedModes = 0;
  for (const mode of modes) {
    const b = baseline?.byMode?.[mode];
    const c = candidate?.byMode?.[mode];
    if (!b || !c) continue;
    comparedModes++;
    const deltas = {};
    for (const m of RANKED_METRIC_KEYS) {
      const bv = b[m], cv = c[m];
      if (bv == null || cv == null) { deltas[m] = null; continue; }
      deltas[m] = round(cv - bv);
      if (bv - cv > t.maxMetricDrop) failures.push(`[${mode}] ${m} dropped ${round(bv - cv)} (${bv}→${cv}) > max ${t.maxMetricDrop}`);
    }
    const bl = b.latencyMs?.p95, cl = c.latencyMs?.p95;
    let latencyP95Delta = null;
    if (bl != null && cl != null && bl > 0) {
      latencyP95Delta = round((cl - bl) / bl);
      if (latencyP95Delta > t.maxLatencyRegress) {
        failures.push(`[${mode}] p95 latency regressed ${Math.round(latencyP95Delta * 100)}% (${bl}→${cl}ms) > max ${Math.round(t.maxLatencyRegress * 100)}%`);
      }
    }
    perMode[mode] = { deltas, latencyP95Delta };
  }
  return {
    thresholds: { maxMetricDrop: t.maxMetricDrop, maxLatencyRegress: t.maxLatencyRegress },
    comparedModes,
    perMode,
    passed: failures.length === 0,
    failures,
  };
}

function printMetricsTable(metrics) {
  const pad = (s, n) => String(s ?? '—').padEnd(n);
  const padNum = (v, n) => String(v == null ? '—' : v).padStart(n);
  console.error(`[brain-eval] retrieval-metrics k=${metrics.k} queries=${metrics.totalQueries}`);
  console.error(`  ${pad('mode', 8)} ${pad('scored', 6)} ${pad('P@k', 6)} ${pad('R@k', 6)} ${pad('MRR', 6)} ${pad('NDCG', 6)} ${pad('cover', 6)} ${pad('ans', 6)} ${pad('p95ms', 7)}`);
  for (const mode of metrics.modes) {
    const m = metrics.byMode[mode] ?? {};
    console.error(`  ${pad(mode, 8)} ${padNum(m.scored, 6)} ${padNum(m.precisionAtK, 6)} ${padNum(m.recallAtK, 6)} ${padNum(m.mrr, 6)} ${padNum(m.ndcgAtK, 6)} ${padNum(m.sourceCoverage, 6)} ${padNum(m.answerableRate, 6)} ${padNum(m.latencyMs?.p95, 7)}`);
  }
}

// ──────────────────────────── CLI ────────────────────────────
function parseArgs(argv) {
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; }
    else { flags[key] = next; i++; }
  }
  return { cmd, flags };
}

function snapshotOptsFromFlags(f) {
  return {
    source: f.source ?? DEFAULTS.source,
    route: f.route ?? null,
    limit: f.limit != null ? Number(f.limit) : DEFAULTS.limit,
  };
}

function printSnapshotSummary(snap) {
  const withTruth = snap.items.filter((i) => i.recall != null);
  const r = mean(withTruth.map((i) => i.recall));
  console.error(`[brain-eval] snapshot source=${snap.source} route=${snap.route} items=${snap.items.length} scored=${withTruth.length} meanRecall=${round(r)}`);
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const json = !!flags.json;

  if (cmd === 'snapshot') {
    const snap = await snapshot(snapshotOptsFromFlags(flags));
    if (json) console.log(JSON.stringify(snap, null, 2));
    else printSnapshotSummary(snap);
    if (flags.out) writeFileSync(String(flags.out), JSON.stringify(snap, null, 2));
    process.exit(0);
  }

  if (cmd === 'baseline') {
    const snap = await snapshot(snapshotOptsFromFlags(flags));
    const out = String(flags.out ?? 'brain-eval-baseline.json');
    writeFileSync(out, JSON.stringify(snap, null, 2));
    printSnapshotSummary(snap);
    console.error(`[brain-eval] baseline written → ${out}`);
    if (json) console.log(JSON.stringify({ ok: true, out, items: snap.items.length }, null, 2));
    process.exit(0);
  }

  if (cmd === 'retrieval-metrics' || cmd === 'metrics') {
    const modes = flags.modes ? String(flags.modes).split(',').map((s) => s.trim()).filter(Boolean) : RETRIEVAL_MODES;
    const k = flags.k != null ? Number(flags.k) : METRIC_DEFAULTS.k;
    const snap = await retrievalSnapshot({
      modes,
      k,
      limit: flags.limit != null ? Number(flags.limit) : DEFAULTS.limit,
      perRouteLimit: flags['retrieve-limit'] != null ? Number(flags['retrieve-limit']) : METRIC_DEFAULTS.perRouteLimit,
    });
    const metrics = computeRetrievalMetrics(snap, { k });

    if (flags.out) writeFileSync(String(flags.out), JSON.stringify(metrics, null, 2));

    // No baseline ⇒ report-only (write a baseline with --out, gate later with --baseline).
    if (!flags.baseline) {
      if (json) console.log(JSON.stringify(metrics, null, 2));
      else printMetricsTable(metrics);
      if (metrics.totalQueries === 0) console.error('[brain-eval] note: 0 ground-truth eval queries — capture queries with accepted_ids to populate metrics.');
      process.exit(0);
    }

    // Baseline given ⇒ regression gate.
    const basePath = String(flags.baseline);
    if (!existsSync(basePath)) { console.error(`[brain-eval] --baseline ${basePath} not found`); process.exit(2); }
    const baseline = JSON.parse(readFileSync(basePath, 'utf8'));
    const result = compareRetrievalMetrics(baseline, metrics, {
      maxMetricDrop: flags['max-metric-drop'] != null ? Number(flags['max-metric-drop']) : METRIC_DEFAULTS.maxMetricDrop,
      maxLatencyRegress: flags['max-latency-regress'] != null ? Number(flags['max-latency-regress']) : METRIC_DEFAULTS.maxLatencyRegress,
    });
    if (flags.report) writeFileSync(String(flags.report), JSON.stringify({ baseline: basePath, metrics, result }, null, 2));

    const noData = result.comparedModes === 0 || metrics.totalQueries === 0;
    const skipped = noData && !flags['fail-on-empty'];
    if (json) {
      console.log(JSON.stringify({ metrics, result, gateStatus: skipped ? 'skipped_no_data' : result.passed ? 'pass' : 'fail' }, null, 2));
    } else {
      printMetricsTable(metrics);
      const status = skipped ? 'SKIPPED (no comparable data)' : result.passed ? 'PASS ✅' : 'FAIL ❌';
      console.error(`[brain-eval] METRICS GATE ${status} — modes compared=${result.comparedModes}`);
      if (!skipped) for (const f of result.failures) console.error(`  ✗ ${f}`);
    }
    process.exit(!result.passed && !skipped ? 1 : 0);
  }

  if (cmd === 'compare' || cmd === 'gate') {
    const basePath = String(flags.baseline ?? '');
    if (!basePath || !existsSync(basePath)) {
      console.error(`[brain-eval] --baseline <path> required and must exist (got: ${basePath || 'none'})`);
      process.exit(2);
    }
    const baseline = JSON.parse(readFileSync(basePath, 'utf8'));
    const candidate = await snapshot(snapshotOptsFromFlags(flags));
    const result = compareSnapshots(baseline, candidate, {
      minJaccard: flags['min-jaccard'] != null ? Number(flags['min-jaccard']) : DEFAULTS.minJaccard,
      minTop1: flags['min-top1'] != null ? Number(flags['min-top1']) : DEFAULTS.minTop1,
      maxRecallDrop: flags['max-recall-drop'] != null ? Number(flags['max-recall-drop']) : DEFAULTS.maxRecallDrop,
      minRecall: flags['min-recall'] != null ? Number(flags['min-recall']) : DEFAULTS.minRecall,
    });

    const emptyData = (baseline.items?.length ?? 0) === 0 || candidate.items.length === 0 || result.matched === 0;
    if (emptyData && !flags['fail-on-empty']) {
      console.error('[brain-eval] WARNING: no comparable eval data (empty baseline/candidate or no overlap) — nothing to gate. Pass --fail-on-empty to treat this as a failure.');
    }

    if (flags.report) writeFileSync(String(flags.report), JSON.stringify({ baseline: basePath, candidate: snapshotOptsFromFlags(flags), result }, null, 2));
    const skipped = emptyData && !flags['fail-on-empty'];
    if (json) {
      console.log(JSON.stringify({ ...result, gateStatus: skipped ? 'skipped_no_data' : result.passed ? 'pass' : 'fail' }, null, 2));
    } else {
      const status = skipped ? 'SKIPPED (no comparable data)' : result.passed ? 'PASS ✅' : 'FAIL ❌';
      console.error(`[brain-eval] GATE ${status} — matched=${result.matched} meanJaccard=${result.meanJaccard} top1=${result.top1Rate} recall ${result.baselineRecall}→${result.candidateRecall} (drop ${result.recallDrop})`);
      if (!skipped) for (const f of result.failures) console.error(`  ✗ ${f}`);
      for (const r of result.worstRegressions) console.error(`  ↓ ${r.key} "${String(r.query_text).slice(0, 60)}" recallΔ=${r.recall_delta} jaccard=${r.jaccard}`);
    }

    const gateFails = !result.passed && !skipped;
    process.exit(gateFails ? 1 : 0);
  }

  console.error('Usage: node brain-eval.mjs <baseline|compare|snapshot|retrieval-metrics> [--source queries|fixtures] [--route R] [--limit N] [--k N] [--modes fts,local,global,drift] [--retrieve-limit N] [--out PATH] [--baseline PATH] [--min-jaccard X] [--min-top1 X] [--max-recall-drop X] [--min-recall X] [--max-metric-drop X] [--max-latency-regress X] [--report PATH] [--json] [--fail-on-empty]');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('[brain-eval] error:', err?.message ?? err); process.exit(2); });
}
