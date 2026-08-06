#!/usr/bin/env node
/**
 * Deterministic Brain cycle.
 *
 * Runs indexing, promotes stable repeated facts into shared memories, creates
 * curator approvals for repeated contradictions, checks eval quality, then
 * records one compact cycle report in the timeline.
 */

import {
  brainGet,
  brainPost,
  createTraceContext,
  recordScriptFailure,
  recordTraceEvent,
  scriptEnvelope,
  scriptFailureEnvelope,
  traceEndEvent,
  traceGenerationEvent,
  traceStartEvent,
  traceSpanEvent,
  BRAIN_URL,
} from './brain-client.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  db,
  upsertFact,
  upsertTextUnitsFromSource,
  linkTextUnitToEntities,
  linkFactsForTextUnit,
  inferEdgesFromTextUnits,
  upsertEntityEdge,
  buildDeterministicCommunities,
  storeMemory,
} from './db.mjs';
import { pruneTimeline } from './maintenance.mjs';
import { createLearningTask, mineCorrectionPatterns, recoverExpiredLearningTaskLeases } from './learning-policy.mjs';
import { detectKnowledgeGapSignals } from './knowledge-gap-detector.mjs';
import {
  createContradictionApprovals,
  createEdgeRepairApprovals,
  createEvalFixturePromotionApprovals,
  createEvalFixtureRetireApprovals,
  createInstructionLifecycleApprovals,
  createMemoryRetireApprovals,
  createSkillRevisionApprovals,
} from './cycle/approvals.mjs';
import { runCurator } from './cycle/curator.mjs';
import { digestConfiguredRepos } from './cycle/repo-digestion.mjs';
import { evalQuality } from './cycle/eval-quality.mjs';
import { instructionScopeSnapshot, sourcePrecisionSnapshot } from './cycle/snapshots.mjs';
import {
  buildTrajectoryHeuristic,
  recordPhaseImprovementOutcomes,
  trajectoryReflectionCandidates,
} from './cycle/next-recommendations.mjs';
import { PROMPTS, promptVersion } from './prompt-config.mjs';
import { startParentDeathWatchdog } from './parent-watchdog.mjs';

const CYCLE_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Run mode: --dry-run / test-scope ──────────────────────────────────────────
// A safe preview mode that exercises every READ + compute phase but performs ZERO
// mutations (no direct DB writes, no mutating HTTP POSTs, no LLM /ask, no
// CycleReport persisted). It prints the report it WOULD have written with
// `dry_run: true`. Combine with BRAIN_URL + BRAIN_DB_PATH pointing at a throwaway
// brain to verify the cycle end-to-end without touching the live instance.
const CLI_ARGS = process.argv.slice(2);
const DRY_RUN = CLI_ARGS.includes('--dry-run')
  || CLI_ARGS.includes('--plan')
  || boolEnv(process.env.BRAIN_CYCLE_DRY_RUN, false);

function boolEnv(value, fallback = false) {
  const raw = String(value ?? '').toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// Mutating-POST gate. In dry-run, record intent and skip the write so the phase
// can still compute + report what it WOULD do. In a real run this is brainPost.
async function cyclePost(path, body, opts) {
  if (DRY_RUN) return { ok: true, data: { dry_run: true, skipped: true }, meta: { dryRun: true, method: 'POST', path } };
  return brainPost(path, body, {
    timeoutMs: Number(process.env.BRAIN_CYCLE_HTTP_TIMEOUT_MS ?? 120_000),
    ...(opts ?? {}),
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function factValueKey(value) {
  return JSON.stringify(value ?? null);
}

function factText(fact) {
  return `${fact.entity_id}.${fact.field} = ${JSON.stringify(fact.value)}`;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function cycleIdFromTimestamp(iso = '') {
  return `cycle:${String(iso).replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function decisionTraceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function sourceTextUnitIdsFromFacts(facts) {
  const ids = [];
  for (const fact of facts) {
    const ctx = fact.context ?? {};
    ids.push(...asArray(ctx.source_text_unit_ids), ...asArray(ctx.sourceTextUnitIds), ...asArray(ctx.text_unit_ids), ...asArray(ctx.textUnitIds));
  }
  return [...new Set(ids.map(Number).filter(Number.isInteger))];
}

async function getPreviousCycleReport() {
  const timeline = await brainGet('/timeline?source=brain-cycle&type=brain:cycle-report&limit=1', { strict: false });
  return timeline.data?.events?.[0]?.data ?? null;
}

async function collectEntityFacts(limit = 500) {
  const entitiesResponse = await brainGet(`/entities?limit=${limit}`, { strict: false });
  const entities = entitiesResponse.data?.entities ?? [];
  const factsByEntity = new Map();
  const contradictions = [];

  for (const entity of entities) {
    const factsResponse = await brainGet(`/entities/${encodeURIComponent(entity.id)}/facts`, { strict: false });
    const payload = factsResponse.data;
    if (!payload) continue;
    factsByEntity.set(entity.id, payload);
    if (payload.contradictions?.length) {
      contradictions.push({
        entity_id: entity.id,
        fields: payload.contradictions.map((c) => c.field),
        details: payload.contradictions,
      });
    }
  }

  return { entities, factsByEntity, contradictions };
}

function previousContradictionCountMap(previousReport = {}) {
  const map = new Map();
  for (const entity of previousReport?.contradictions ?? []) {
    for (const detail of entity.details ?? []) {
      map.set(`${entity.entity_id}:${detail.field}`, Number(detail.consecutive_cycle_count ?? 1));
    }
  }
  return map;
}

function annotateContradictions(contradictions = [], previousReport = {}) {
  const previous = previousContradictionCountMap(previousReport);
  return contradictions.map((entity) => ({
    ...entity,
    details: (entity.details ?? []).map((detail) => {
      const key = `${entity.entity_id}:${detail.field}`;
      const previousCount = previous.get(key) ?? 0;
      return {
        ...detail,
        consecutive_cycle_count: previousCount + 1,
      };
    }),
  }));
}

async function promoteRepeatedFacts(factsByEntity) {
  const promoted = [];
  const minSources = Number(process.env.BRAIN_MEMORY_PROMOTION_MIN_SOURCES ?? 2);

  for (const [entityId, payload] of factsByEntity.entries()) {
    const contradictoryFields = new Set(asArray(payload.contradictions).map(c => c.field));
    for (const [field, facts] of Object.entries(payload.fields ?? {})) {
      if (contradictoryFields.has(field)) continue;
      const byValue = new Map();
      for (const fact of facts) {
        const key = factValueKey(fact.value);
        if (!byValue.has(key)) byValue.set(key, []);
        byValue.get(key).push(fact);
      }
      for (const [valueKey, matchingFacts] of byValue.entries()) {
        const sources = new Set(matchingFacts.map(f => f.source).filter(Boolean));
        if (sources.size < minSources) continue;
        const factIds = matchingFacts.map(f => Number(f.id)).filter(Number.isInteger);
        const textUnitIds = sourceTextUnitIdsFromFacts(matchingFacts);
        const memoryKey = `learned:${entityId}:${field}:${Buffer.from(valueKey).toString('base64url').slice(0, 24)}`;
        const content = [
          `Repeated stable fact: ${factText(matchingFacts[0])}.`,
          `Sources: ${[...sources].join(', ')}.`,
          `Source fact IDs: ${factIds.join(', ')}.`,
          textUnitIds.length ? `Source text unit IDs: ${textUnitIds.join(', ')}.` : '',
        ].filter(Boolean).join(' ');
        await cyclePost(`/memory/${encodeURIComponent('brain-cycle')}`, {
          key: memoryKey,
          content,
          tags: ['learned', 'cross-agent', 'brain-cycle', entityId, field],
          shared: true,
        });
        await cyclePost('/timeline', {
          source: 'brain-cycle',
          type: 'brain:memory-promoted',
          subject: entityId,
          data: { entity_id: entityId, field, value: matchingFacts[0].value, fact_ids: factIds, source_text_unit_ids: textUnitIds, sources: [...sources], memory_key: memoryKey },
          tags: ['brain', 'memory', 'learned'],
        });
        promoted.push({ entity_id: entityId, field, fact_ids: factIds, source_text_unit_ids: textUnitIds, sources: [...sources], memory_key: memoryKey });
      }
    }
  }

  return promoted;
}

async function createCitationRepairTasks() {
  const response = await cyclePost('/skill-proposals/repair-tasks', {
    limit: Number(process.env.BRAIN_CYCLE_CITATION_REPAIR_LIMIT ?? 10),
    source: 'brain-cycle',
  }, { strict: false });
  return {
    created: response.data?.created ?? [],
    skipped: response.data?.skipped ?? [],
    candidate_count: (response.data?.candidates ?? []).length,
  };
}

async function correctionMiningDryRun() {
  const thresholds = process.env.BRAIN_CORRECTION_MINE_THRESHOLDS
    ? JSON.parse(process.env.BRAIN_CORRECTION_MINE_THRESHOLDS)
    : {};
  return mineCorrectionPatterns(db, {
    days: Number(process.env.BRAIN_CORRECTION_MINE_DAYS ?? 14),
    limit: Number(process.env.BRAIN_CORRECTION_MINE_LIMIT ?? 1000),
    threshold: Number(process.env.BRAIN_CORRECTION_MINE_THRESHOLD ?? 2),
    thresholds,
    cooldownDays: Number(process.env.BRAIN_CORRECTION_MINE_COOLDOWN_DAYS ?? 7),
    create: false,
    source: 'brain-cycle',
  });
}

async function recoverLearningTaskLeases() {
  return recoverExpiredLearningTaskLeases(db, {
    limit: Number(process.env.BRAIN_CYCLE_LEARNING_TASK_RECOVER_LIMIT ?? 100),
    source: 'brain-cycle',
  });
}

async function createWeakRetrievalPhaseTasks() {
  const metrics = await brainGet(`/metrics/learning?days=${Number(process.env.BRAIN_CYCLE_PHASE_METRICS_DAYS ?? 7)}`, { strict: false });
  const warnings = metrics.data?.warnings ?? [];
  const weakPhaseWarnings = warnings.filter(warning => warning.kind === 'weak_retrieval_phases');
  const phases = weakPhaseWarnings.flatMap(warning => warning.phases ?? []);
  const created = [];
  const skipped = [];
  for (const phase of phases) {
    const subject = String(phase.phase ?? 'unknown');
    const existing = db.prepare(`
      SELECT id, status FROM learning_tasks
      WHERE kind='context.phase.improve' AND subject=? AND status IN ('queued','assigned','in_progress','blocked')
      ORDER BY created_at DESC LIMIT 1
    `).get(subject);
    if (existing) {
      skipped.push({ phase: subject, reason: 'open_task_exists', task_id: existing.id, status: existing.status });
      continue;
    }
    const response = await cyclePost('/learning-tasks', {
      kind: 'context.phase.improve',
      subject,
      priority: Math.max(1, Number(phase.volunteered ?? 0) - Number(phase.used ?? 0)),
      source: 'brain-cycle',
      payload: {
        phase,
        source: 'brain-cycle',
        recommendation: 'Inspect retrieval phase sources, adjust ranking/budgeting, and add or retire context evidence based on accepted-source precision.',
      },
    }, { strict: false });
    if (response.data?.task) created.push(response.data.task);
  }
  return { created, skipped, candidate_count: phases.length };
}

async function createKnowledgeGapResearchTasks() {
  return detectKnowledgeGapSignals(db, {
    days: Number(process.env.BRAIN_GAP_DETECTOR_DAYS ?? 14),
    feedbackLimit: Number(process.env.BRAIN_GAP_DETECTOR_FEEDBACK_LIMIT ?? 200),
    evalLimit: Number(process.env.BRAIN_GAP_DETECTOR_EVAL_LIMIT ?? 200),
    lowPrecisionThreshold: Number(process.env.BRAIN_GAP_DETECTOR_LOW_PRECISION_THRESHOLD ?? 0.2),
    maxCreate: Number(process.env.BRAIN_GAP_DETECTOR_MAX_CREATE ?? 25),
    source: 'brain-cycle',
    create: !DRY_RUN,
  });
}

function evalQualityWarningSubject(warning = '') {
  const normalized = String(warning).trim().replace(/\s+/g, ' ');
  return `eval-quality:${normalized.slice(0, 220)}`;
}

async function createEvalQualityRepairTasks(evalQualityResult = {}) {
  const warnings = Array.isArray(evalQualityResult.warnings) ? evalQualityResult.warnings : [];
  const created = [];
  const skipped = [];
  for (const warning of warnings) {
    const subject = evalQualityWarningSubject(warning);
    const existing = db.prepare(`
      SELECT id, status FROM learning_tasks
      WHERE kind='eval.quality.repair' AND subject=? AND status IN ('queued','assigned','in_progress','blocked')
      ORDER BY created_at DESC LIMIT 1
    `).get(subject);
    if (existing) {
      skipped.push({ subject, reason: 'open_task_exists', task_id: existing.id, status: existing.status });
      continue;
    }
    if (DRY_RUN) {
      skipped.push({ subject, reason: 'dry-run' });
      continue;
    }
    const taskId = createLearningTask(db, {
      kind: 'eval.quality.repair',
      subject,
      assignee: 'default/researcher',
      priority: 2,
      payload: {
        warning,
        eval_summary: evalQualityResult.summary ?? {},
        recommendation: 'Inspect accepted eval rows, returned source ids, and retrieval/source budgeting. Propose a source-coverage or acceptance-recall fix with evidence before changing routing policy.',
        review_gate: 'No retrieval policy, memory, instruction, or source metadata change is applied by this task creator.',
      },
    });
    created.push({ id: taskId, subject, warning });
  }
  return { created, skipped, candidate_count: warnings.length };
}

async function recordPhaseImprovementOutcomesPhase() {
  if (DRY_RUN) return { created: [], skipped: ['dry-run'], candidate_count: 0 };
  const created = recordPhaseImprovementOutcomes(db, {
    source: 'brain-cycle',
    lookbackDays: Number(process.env.BRAIN_PHASE_IMPROVEMENT_LOOKBACK_DAYS ?? 7),
    forwardDays: Number(process.env.BRAIN_PHASE_IMPROVEMENT_FORWARD_DAYS ?? 7),
    minDelta: Number(process.env.BRAIN_PHASE_IMPROVEMENT_MIN_DELTA ?? 0.05),
  });
  return { created, skipped: [], candidate_count: created.length };
}

async function compactTrajectoryReflectionPhase() {
  const candidates = trajectoryReflectionCandidates(db, {
    limit: Number(process.env.BRAIN_TRAJECTORY_REFLECTION_LIMIT ?? 25),
  });
  const created = [];
  const skipped = [];
  for (const candidate of candidates) {
    const heuristic = buildTrajectoryHeuristic(candidate);
    if (DRY_RUN) {
      skipped.push({ key: heuristic.key, reason: 'dry-run' });
      continue;
    }
    const stored = storeMemory({
      agentId: 'task-trajectories',
      key: heuristic.key,
      content: heuristic.content,
      tags: heuristic.tags,
      shared: true,
    });
    if (!Number.isInteger(stored.id)) {
      skipped.push({ key: heuristic.key, reason: 'store_failed' });
      continue;
    }
    await brainPost('/timeline', {
      source: 'brain-cycle',
      type: 'brain:trajectory-heuristic-compacted',
      subject: String(stored.id),
      data: {
        memory_id: stored.id,
        source_memory_id: candidate.source_memory_id,
        source_memory_key: candidate.source_memory_key,
        heuristic: heuristic.heuristic,
      },
      tags: ['brain', 'trajectory', 'heuristic', 'self-learning'],
    }, { strict: false });
    created.push({
      memory_id: stored.id,
      key: heuristic.key,
      source_memory_id: candidate.source_memory_id,
    });
  }
  return { created, skipped, candidate_count: candidates.length };
}

// Plan 26 baseline: the deterministic cycle must stay LLM-free unless the
// operator explicitly opts in. Set BRAIN_CONSOLIDATION_TAKES=1/true/yes/on to
// synthesize "take" facts through the manager /ask path; all index/report phases
// still run without it.
function consolidationEnabled() {
  return boolEnv(process.env.BRAIN_CONSOLIDATION_TAKES, false);
}

// Default lookback is 24h (Plan 22: "when ≥3 observations/facts about an entity
// land in 24h … the 24h delay filters noise"). Override with
// BRAIN_CONSOLIDATION_LOOKBACK_DAYS (fractional days allowed, e.g. 0.5 = 12h).
function consolidationLookbackDays() {
  return Math.max(Number(process.env.BRAIN_CONSOLIDATION_LOOKBACK_DAYS ?? 1), 0.01);
}

function consolidationCandidates() {
  const since = Math.floor(Date.now() / 1000) - consolidationLookbackDays() * 86400;
  const minFacts = Math.max(Number(process.env.BRAIN_CONSOLIDATION_MIN_FACTS ?? 3), 2);
  const limit = Math.max(Number(process.env.BRAIN_CONSOLIDATION_CANDIDATES ?? 3), 1);
  const rows = db.prepare(`
    SELECT * FROM facts
    WHERE status='active' AND field!='take' AND observed_at >= ?
    ORDER BY entity_id, observed_at DESC
    LIMIT 1000
  `).all(since).map(row => ({ ...row, value: parseJson(row.value, null), context: parseJson(row.context, {}) }));
  const groups = new Map();
  for (const row of rows) {
    const key = row.entity_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([entity_id, facts]) => ({ entity_id, facts }))
    .filter(candidate => candidate.facts.length >= minFacts)
    .sort((a, b) => b.facts.length - a.facts.length)
    .slice(0, limit);
}

function extractTake(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  try {
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (typeof parsed.take === 'string') return parsed.take.trim();
    }
  } catch {}
  return raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .replace(/^take:\s*/i, '')
    .trim()
    .slice(0, 1000);
}

function normalizeAlias(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bootstrapEntityAliases() {
  const rows = db.prepare(`
    SELECT id, name, source FROM entities
    WHERE id NOT IN (
      SELECT entity_id FROM entity_aliases WHERE kind='canonical' AND status='active'
    )
    LIMIT 1000
  `).all();
  const stmt = db.prepare(`
    INSERT INTO entity_aliases (entity_id, alias, normalized, kind, source, status, updated_at)
    VALUES (?, ?, ?, 'canonical', ?, 'active', unixepoch())
    ON CONFLICT(entity_id, normalized) DO UPDATE SET
      kind='canonical',
      status='active',
      updated_at=unixepoch()
  `);
  let created = 0;
  for (const row of rows) {
    const normalized = normalizeAlias(row.name);
    if (!normalized) continue;
    stmt.run(row.id, row.name, normalized, row.source ?? 'brain-cycle');
    created++;
  }
  return created;
}

function canonicalEntityForAliasGroup(entityIds = []) {
  const rows = db.prepare(`
    SELECT id, status, updated_at FROM entities
    WHERE id IN (${entityIds.map(() => '?').join(',')})
    ORDER BY status='active' DESC, updated_at DESC, length(id) ASC, id ASC
  `).all(...entityIds);
  return rows[0]?.id ?? entityIds.slice().sort()[0];
}

function mergeExactAliasGroup({ normalized, entityIds }) {
  const canonicalId = canonicalEntityForAliasGroup(entityIds);
  const losers = entityIds.filter(id => id !== canonicalId);
  const merged = [];
  const parseTextUnitIds = (value) => {
    try {
      const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
      return [...new Set((Array.isArray(parsed) ? parsed : []).map(Number).filter(Number.isInteger))];
    } catch {
      return [];
    }
  };
  for (const loserId of losers) {
    const before = {
      loser: db.prepare(`SELECT * FROM entities WHERE id=?`).get(loserId),
      canonical: db.prepare(`SELECT * FROM entities WHERE id=?`).get(canonicalId),
      facts: db.prepare(`SELECT id, entity_id FROM facts WHERE entity_id=?`).all(loserId),
      text_units: db.prepare(`SELECT entity_id, text_unit_id, relation FROM entity_text_units WHERE entity_id=?`).all(loserId),
      edges: db.prepare(`SELECT * FROM entity_edges WHERE from_id=? OR to_id=?`).all(loserId, loserId),
      aliases: db.prepare(`SELECT id, entity_id, alias, normalized, kind, status FROM entity_aliases WHERE entity_id=?`).all(loserId),
    };
    db.prepare(`UPDATE facts SET entity_id=? WHERE entity_id=?`).run(canonicalId, loserId);
    // Re-parent the loser's text-unit links to the canonical entity. UPDATE OR
    // IGNORE moves every link that does not collide with one the canonical entity
    // already holds; colliding duplicates simply remain on the (now
    // status='merged', query-excluded) loser. No DELETE — the merge stays fully
    // reversible (Plan 22 guardrail: status flips only, zero hard deletes).
    db.prepare(`UPDATE OR IGNORE entity_text_units SET entity_id=? WHERE entity_id=?`).run(canonicalId, loserId);
    const updateEdge = db.prepare(`UPDATE entity_edges SET from_id=?, to_id=?, updated_at=unixepoch() WHERE id=?`);
    const collisionStmt = db.prepare(`SELECT 1 FROM entity_edges WHERE from_id=? AND to_id=? AND kind=? AND id != ?`);
    for (const edge of before.edges) {
      const from = edge.from_id === loserId ? canonicalId : edge.from_id;
      const to = edge.to_id === loserId ? canonicalId : edge.to_id;
      if (!from || !to || from === to) continue;
      if (collisionStmt.get(from, to, edge.kind, edge.id)) {
        upsertEntityEdge({
          from,
          to,
          kind: edge.kind,
          weight: edge.weight,
          description: edge.description,
          textUnitIds: parseTextUnitIds(edge.text_unit_ids),
          evidenceCount: edge.evidence_count,
          promptVersion: edge.prompt_version,
        });
      } else {
        updateEdge.run(from, to, edge.id);
      }
    }
    db.prepare(`
      INSERT INTO entity_edges (from_id, to_id, kind, weight, description, evidence_count, text_unit_ids, updated_at)
      VALUES (?, ?, 'alias-of', 1.0, ?, 0, '[]', unixepoch())
      ON CONFLICT(from_id, to_id, kind) DO UPDATE SET updated_at=unixepoch(), weight=MAX(weight, 1.0)
    `).run(loserId, canonicalId, `Exact normalized alias merge: ${normalized}`);
    // Copy the loser's active aliases onto the canonical entity (so the loser's
    // name keeps resolving), then FLIP the loser's own alias rows to
    // status='merged' instead of deleting them — reversible, and excluded from
    // the active-alias dedup scan so the merge does not re-trigger.
    db.prepare(`
      INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized, kind, source, status, created_at, updated_at)
      SELECT ?, alias, normalized, kind, 'brain-cycle', status, created_at, unixepoch()
      FROM entity_aliases
      WHERE entity_id=? AND status='active'
    `).run(canonicalId, loserId);
    db.prepare(`UPDATE entity_aliases SET status='merged', updated_at=unixepoch() WHERE entity_id=? AND status!='merged'`).run(loserId);
    db.prepare(`
      UPDATE entities
      SET status='merged',
          data=json_set(COALESCE(NULLIF(data, ''), '{}'), '$.merged_into', ?, '$.merged_by', 'brain-cycle', '$.merged_reason', ?),
          updated_at=unixepoch()
      WHERE id=?
    `).run(canonicalId, `exact-alias:${normalized}`, loserId);
    const timeline = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
      .run('brain-cycle', 'entity:alias-exact-merged', canonicalId, JSON.stringify({
        normalized,
        canonical_entity_id: canonicalId,
        merged_entity_id: loserId,
        before,
        reversible: true,
        hard_delete: false,
      }), JSON.stringify(['brain', 'entity', 'alias', 'merge']));
    merged.push({ canonical_entity_id: canonicalId, merged_entity_id: loserId, normalized, timeline_event_id: Number(timeline.lastInsertRowid) });
  }
  return merged;
}

function tokenSet(value) {
  return new Set(normalizeAlias(value).split(' ').filter(Boolean));
}

function tokenSimilarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter(token => right.has(token)).length;
  return intersection / Math.max(left.size, right.size);
}

function createFuzzyAliasApprovals(limit = 10, governance = {}, { dryRun = false } = {}) {
  const rows = db.prepare(`
    SELECT id, type, name FROM entities
    WHERE COALESCE(status, 'active') != 'merged'
    ORDER BY updated_at DESC
    LIMIT 500
  `).all();
  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].type !== rows[j].type) continue;
      const left = normalizeAlias(rows[i].name);
      const right = normalizeAlias(rows[j].name);
      if (!left || !right || left === right) continue;
      const similarity = tokenSimilarity(left, right);
      if (similarity < Number(process.env.BRAIN_ALIAS_FUZZY_THRESHOLD ?? 0.67)) continue;
      candidates.push({ left: rows[i], right: rows[j], similarity });
    }
  }
  const created = [];
  for (const candidate of candidates.sort((a, b) => b.similarity - a.similarity).slice(0, limit)) {
    const subject = [candidate.left.id, candidate.right.id].sort().join('|');
    const existing = db.prepare(`
      SELECT id FROM approvals
      WHERE kind='entity.alias.fuzzy_merge' AND subject=? AND status='pending'
      LIMIT 1
    `).get(subject);
    if (existing) continue;
    const payload = {
      candidates: [
        { entity_id: candidate.left.id, name: candidate.left.name },
        { entity_id: candidate.right.id, name: candidate.right.name },
      ],
      similarity: Math.round(candidate.similarity * 1000) / 1000,
      reversible: true,
      hard_delete: false,
      recommendation: 'Review whether these entities should be merged as aliases. If accepted, keep an alias edge and rollback metadata.',
      governance: {
        ...governance,
        quality_marker: 'candidate',
        human_attention: { required: true, level: 'medium', reason: 'fuzzy alias merge review' },
      },
    };
    if (dryRun) {
      created.push({ approval_id: null, subject, similarity: payload.similarity, dry_run: true });
      continue;
    }
    const approval = db.prepare(`
      INSERT INTO approvals (kind, subject, payload, risk_level, requested_by)
      VALUES ('entity.alias.fuzzy_merge', ?, ?, 'medium', 'brain-cycle')
    `).run(subject, JSON.stringify(payload));
    created.push({ approval_id: Number(approval.lastInsertRowid), subject, similarity: payload.similarity });
  }
  return created;
}

function runAliasDedupPhase(governance = {}, { dryRun = false } = {}) {
  // In dry-run we skip the canonical-alias bootstrap write, so the exact-group
  // preview reflects only aliases already present (it can under-count merges that
  // a real run would create after bootstrapping). That trade-off keeps dry-run a
  // pure read.
  const canonical_aliases_created = dryRun ? 0 : bootstrapEntityAliases();
  const exactGroups = db.prepare(`
    SELECT normalized, json_group_array(DISTINCT entity_id) AS entity_ids, COUNT(DISTINCT entity_id) AS entity_count
    FROM entity_aliases
    WHERE status='active' AND normalized!=''
    GROUP BY normalized
    HAVING entity_count > 1
    ORDER BY entity_count DESC, normalized
    LIMIT 50
  `).all();
  const exact_merges = [];
  for (const group of exactGroups) {
    const entityIds = parseJson(group.entity_ids, []);
    if (dryRun) {
      exact_merges.push({ normalized: group.normalized, entity_ids: entityIds, planned: true });
    } else {
      exact_merges.push(...mergeExactAliasGroup({ normalized: group.normalized, entityIds }));
    }
  }
  const fuzzy_candidates = createFuzzyAliasApprovals(Number(process.env.BRAIN_ALIAS_FUZZY_LIMIT ?? 10), governance, { dryRun });
  return {
    canonical_aliases_created,
    exact_groups: exactGroups.length,
    exact_merges,
    fuzzy_candidates,
    reversible: true,
    hard_delete: false,
    dry_run: dryRun,
  };
}

// Plan 22 locked decision #1: the consolidation reasoning step reuses the proven
// manager `/ask <local-agent>` dispatch and MUST target a local ollama-runtime
// agent so the nightly cycle costs ~$0 (not the cloud fleet). The runtime↔model
// binding is owned manager-side (only the `ollama` runtime is local — see
// src/lib/local-model-gate.ts), so the cycle's contract is: route to a known
// local agent (configurable) and make that routing explicit + logged. Override
// the target with BRAIN_CONSOLIDATION_{TEAM,AGENT,MODEL}.
function consolidationRouting() {
  return {
    dispatch: '/ask',
    team: process.env.BRAIN_CONSOLIDATION_TEAM ?? 'default',
    agent: process.env.BRAIN_CONSOLIDATION_AGENT ?? 'summary-formatter',
    model: process.env.BRAIN_CONSOLIDATION_MODEL ?? '',
    runtime_expectation: 'ollama-local',
  };
}

async function askConsolidationAgent(prompt, { traceContext } = {}) {
  const managerUrl = process.env.MANAGER_URL ?? 'http://127.0.0.1:4100';
  const { team, agent, model } = consolidationRouting();
  const timeoutMs = Math.max(Number(process.env.BRAIN_CONSOLIDATION_TIMEOUT_MS ?? 45_000), 1000);
  const waitSeconds = Math.max(1, Math.min(Math.ceil(timeoutMs / 1000), 30));
  const headers = { 'Content-Type': 'application/json', 'X-Id-Team': team };
  const body = { command: `/ask ${agent} ${prompt}` };
  // Optional explicit local-model pin. Harmless if the manager ignores the field;
  // the agent's own runtime still governs which model actually serves the ask.
  if (model) body.model = model;
  const remote = await fetch(`${managerUrl}/remote`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const started = Date.now();
  const payload = await remote.json().catch(() => ({}));
  const queryId = payload?.result?.queryId ?? payload?.queryId;
  if (!remote.ok || !queryId) throw new Error(`manager ask failed: ${remote.status}`);
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${managerUrl}/query/${encodeURIComponent(queryId)}?wait=${waitSeconds}`, {
      headers: { 'X-Id-Team': team },
    });
    const result = await response.json().catch(() => ({}));
    if (result.status === 'delivered') return String(result.result?.result ?? result.result?.message ?? result.result ?? '');
    if (result.status === 'failed' || result.status === 'expired') throw new Error(`manager query ${result.status}`);
  }
  throw new Error('manager query timeout');
}

async function createConsolidationTakes({ dryRun = false, traceContext = null } = {}) {
  const routing = consolidationRouting();
  const phase = {
    enabled: consolidationEnabled(),
    dry_run: dryRun,
    routing,
    prompt_version: promptVersion('factTake'),
    agent: routing.agent,
    team: routing.team,
    lookback_days: consolidationLookbackDays(),
    created: [],
    skipped: [],
    errors: [],
    candidate_count: 0,
  };
  if (!phase.enabled) return phase;

  const candidates = consolidationCandidates();
  phase.candidate_count = candidates.length;
  // Dry-run: report the candidates a real run would synthesize takes for, but make
  // no LLM call and write nothing.
  if (dryRun) {
    phase.skipped = candidates.map(candidate => ({
      entity_id: candidate.entity_id,
      reason: 'dry-run',
      source_fact_ids: candidate.facts.map(fact => Number(fact.id)).filter(Number.isInteger),
    }));
    return phase;
  }
  for (const candidate of candidates) {
    const factIds = candidate.facts.map(fact => Number(fact.id)).filter(Number.isInteger);
    const existing = db.prepare(`
      SELECT id FROM facts
      WHERE entity_id=? AND field='take' AND source='brain-cycle' AND status='active'
        AND context LIKE ?
      LIMIT 1
    `).get(candidate.entity_id, `%${factIds[0]}%`);
    if (existing) {
      phase.skipped.push({ entity_id: candidate.entity_id, reason: 'existing_take', fact_id: existing.id });
      continue;
    }
    const prompt = [
      ...PROMPTS.factTake.instructions,
      '',
      `Entity: ${candidate.entity_id}`,
      ...candidate.facts.slice(0, 8).map(fact => `- #${fact.id} ${fact.field}: ${JSON.stringify(fact.value)} (source: ${fact.source})`),
    ].join('\n');
    try {
      const rawStarted = Date.now();
      if (traceContext) {
        await recordTraceEvent(traceGenerationEvent(traceContext, {
          phase: 'consolidation',
          status: 'started',
          provider: 'manager',
          model: routing.model || 'agent-default',
          metadata: { agent: phase.agent, team: phase.team, candidate_entity_id: candidate.entity_id, prompt_version: phase.prompt_version, prompt_chars: prompt.length },
        }), { dryRun });
      }
      const raw = await askConsolidationAgent(prompt, { traceContext });
      if (traceContext) {
        await recordTraceEvent(traceGenerationEvent(traceContext, {
          phase: 'consolidation',
          status: 'ok',
          provider: 'manager',
          model: routing.model || 'agent-default',
          startedAt: new Date(rawStarted).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - rawStarted,
          metadata: { agent: phase.agent, team: phase.team, candidate_entity_id: candidate.entity_id, prompt_version: phase.prompt_version, response_chars: raw.length },
        }), { dryRun });
      }
      const take = extractTake(raw);
      if (!take) {
        phase.skipped.push({ entity_id: candidate.entity_id, reason: 'empty_take' });
        continue;
      }
      const result = upsertFact({
        entity_id: candidate.entity_id,
        field: 'take',
        value: take,
        source: 'brain-cycle',
        confidence: 0.65,
        context: {
          phase: 'consolidation_takes',
          agent: phase.agent,
          team: phase.team,
          prompt_version: phase.prompt_version,
          source_fact_ids: factIds,
          raw_result: raw.slice(0, 2000),
        },
      });
      await cyclePost('/timeline', {
        source: 'brain-cycle',
        type: 'brain:take-consolidated',
        subject: candidate.entity_id,
        data: { entity_id: candidate.entity_id, take, fact_id: result.id, source_fact_ids: factIds, prompt_version: phase.prompt_version, agent: phase.agent, team: phase.team },
        tags: ['brain', 'cycle', 'take', 'consolidation'],
      }, { strict: false });
      phase.created.push({ entity_id: candidate.entity_id, fact_id: result.id, source_fact_ids: factIds });
    } catch (err) {
      if (traceContext) {
        await recordTraceEvent(traceGenerationEvent(traceContext, {
          phase: 'consolidation',
          status: 'error',
          provider: 'manager',
          model: routing.model || 'agent-default',
          metadata: { agent: phase.agent, team: phase.team, candidate_entity_id: candidate.entity_id, prompt_version: phase.prompt_version, error: String(err?.message ?? err).slice(0, 300) },
        }), { dryRun });
      }
      phase.errors.push({ entity_id: candidate.entity_id, message: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return phase;
}

// ─── Phase 3: embed (sqlite-vec) ───────────────────────────────────────────────
function embedPhaseEnabled() {
  // OFF by default: requires a reachable local embedding model (ollama). FTS5 /
  // keyword retrieval is the always-on default and is unaffected by this phase —
  // embeddings are purely additive (vectors are unioned with keyword at query
  // time, with keyword fallback when sqlite-vec is unavailable).
  return boolEnv(process.env.BRAIN_EMBED_PHASE, false);
}

function vectorReadinessStatus() {
  const count = (sql, ...params) => {
    try { return Number(db.prepare(sql).get(...params)?.c ?? 0); }
    catch { return 0; }
  };
  const requiredRoutes = String(process.env.BRAIN_VECTOR_REQUIRED_EVAL_ROUTES ?? 'fts,local,global,drift')
    .split(',')
    .map(route => route.trim())
    .filter(Boolean);
  const evalBaselines = Object.fromEntries(requiredRoutes.map(route => [
    route,
    count(`SELECT COUNT(*) c FROM eval_queries WHERE route=?`, route),
  ]));
  const evidence = {
    text_units: count(`SELECT COUNT(*) c FROM text_units`),
    entity_text_units: count(`SELECT COUNT(*) c FROM entity_text_units`),
    fact_text_units: count(`SELECT COUNT(*) c FROM fact_text_units`),
    entity_edges_with_evidence: count(`SELECT COUNT(*) c FROM entity_edges WHERE COALESCE(evidence_count, 0) > 0 OR text_unit_ids != '[]'`),
  };
  const missingRoutes = requiredRoutes.filter(route => !evalBaselines[route]);
  const evidenceReady = evidence.text_units > 0 && (evidence.entity_text_units > 0 || evidence.fact_text_units > 0);
  return {
    ready: evidenceReady && missingRoutes.length === 0,
    evidence_ready: evidenceReady,
    baseline_ready: missingRoutes.length === 0,
    required_routes: requiredRoutes,
    missing_routes: missingRoutes,
    eval_baselines: evalBaselines,
    evidence,
    fallback: 'fts5_keyword_and_embedding_json_scan',
  };
}

function runEmbedSubprocess({ provider, model, limit, timeoutMs }) {
  const script = resolvePath(CYCLE_DIR, 'operator-tools', 'refresh-source-embeddings.mjs');
  const args = [script, '--provider', provider || 'auto', '--limit', String(limit)];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: CYCLE_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('embed subprocess timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`embed exited ${code}: ${(stderr || stdout).slice(0, 300)}`));
      try { resolve(JSON.parse(stdout).data ?? {}); } catch { resolve({ raw: stdout.slice(0, 500) }); }
    });
  });
}

// Plan 22 Layer 6 / phase 5: embed new/changed facts+text for sqlite-vec by
// shelling out to the offline refresh tool. Default mode is subscription-first
// (`openai`) with local fallbacks (`ollama`, then deterministic-local).
// Additive + best-effort: a missing model is reported but never fails the
// deterministic cycle.
async function runEmbedPhase({ dryRun = false, traceContext = null } = {}) {
  const provider = process.env.BRAIN_EMBED_PROVIDER ?? process.env.BRAIN_EMBEDDING_PROVIDER ?? 'auto';
  const model = process.env.BRAIN_EMBED_MODEL ?? process.env.BRAIN_EMBEDDING_MODEL ?? '';
  const limit = Math.max(Number(process.env.BRAIN_EMBED_LIMIT ?? 200), 1);
  const timeoutMs = Math.max(Number(process.env.BRAIN_EMBED_TIMEOUT_MS ?? 120_000), 1000);
  const phase = { enabled: embedPhaseEnabled(), provider, model, limit, dry_run: dryRun, ran: false };
  if (!phase.enabled) { phase.skipped = 'disabled'; return phase; }
  if (dryRun) { phase.skipped = 'dry-run'; return phase; }
  phase.readiness = vectorReadinessStatus();
  if (!phase.readiness.ready) {
    phase.skipped = 'vector-readiness';
    return phase;
  }
  try {
    const startedAt = Date.now();
    if (traceContext) {
      await recordTraceEvent(traceGenerationEvent(traceContext, {
        phase: 'embed',
        status: 'started',
        provider,
        model,
        metadata: { limit },
      }), { dryRun });
    }
    phase.result = await runEmbedSubprocess({ provider, model, limit, timeoutMs });
    phase.ran = true;
    if (traceContext) {
      await recordTraceEvent(traceGenerationEvent(traceContext, {
        phase: 'embed',
        status: 'ok',
        provider,
        model,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        metadata: { limit, batches: phase.result?.batches ?? 0, written: phase.result?.written ?? 0 },
      }), { dryRun });
    }
    const event = await cyclePost('/timeline', {
      source: 'brain-cycle',
      type: 'brain:embed-phase',
      subject: 'embeddings',
      data: { provider, model, limit, ...phase.result },
      tags: ['brain', 'cycle', 'embed'],
    }, { strict: false });
    phase.timelineEventId = event.data?.id ?? null;
  } catch (err) {
    if (traceContext) {
      await recordTraceEvent(traceGenerationEvent(traceContext, {
        phase: 'embed',
        status: 'error',
        provider,
        model,
        metadata: { limit, error: String(err?.message ?? err).slice(0, 300) },
      }), { dryRun });
    }
    phase.error = String(err?.message ?? err).slice(0, 300);
  }
  return phase;
}

// ─── Phase 1: prune / age ──────────────────────────────────────────────────────
// Ages low-value timeline noise and reports stale/expired memories. Reversible by
// design: timeline pruning (observability, not knowledge) is the Plan 22-
// sanctioned retention path and rolls up before removal; memories are only ever
// SOFT-expired (status flip) and only when explicitly enabled — zero hard deletes.
async function runPruneAgePhase({ dryRun = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const staleDays = Math.max(Number(process.env.BRAIN_PRUNE_MEMORY_STALE_DAYS ?? 90), 1);
  const staleCutoff = now - staleDays * 86400;
  const countExpired = () => {
    try { return db.prepare(`SELECT COUNT(*) c FROM agent_memories WHERE expires_at IS NOT NULL AND expires_at <= ?`).get(now).c; }
    catch { return 0; }
  };
  const countStale = () => {
    try { return db.prepare(`SELECT COUNT(*) c FROM agent_memories WHERE status='active' AND COALESCE(updated_at, created_at, 0) < ?`).get(staleCutoff).c; }
    catch { return 0; }
  };
  const phase = {
    dry_run: dryRun,
    reversible: true,
    hard_delete: false,
    expired_memories: countExpired(),
    stale_memories: countStale(),
    timeline_pruned: 0,
    memory_soft_expired: 0,
  };
  if (dryRun) return phase;

  if (boolEnv(process.env.BRAIN_PRUNE_TIMELINE, true)) {
    try { phase.timeline_pruned = pruneTimeline(); }
    catch (err) { phase.timeline_error = String(err?.message ?? err).slice(0, 200); }
  }
  if (boolEnv(process.env.BRAIN_PRUNE_SOFT_EXPIRE_MEMORIES, false) && phase.expired_memories > 0) {
    try {
      const r = db.prepare(`UPDATE agent_memories SET status='expired' WHERE status != 'expired' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now);
      phase.memory_soft_expired = r.changes;
    } catch (err) { phase.memory_error = String(err?.message ?? err).slice(0, 200); }
  }
  const event = await cyclePost('/timeline', {
    source: 'brain-cycle',
    type: 'brain:prune-age',
    subject: 'maintenance',
    data: phase,
    tags: ['brain', 'cycle', 'prune', 'maintenance'],
  }, { strict: false });
  phase.timelineEventId = event.data?.id ?? null;
  return phase;
}

// ─── Indexing phases (Plan 25 G8) ───────────────────────────────────────────────
// The old bundled POST /brain/index (relink+infer+cluster+reports) is split into
// ordered steps so cluster+reports run AFTER alias dedup and chunk runs BEFORE
// link/infer. These call db.mjs helpers directly (same pattern as alias dedup) so
// the cycle owns the ordering; all are dry-run safe (no writes in dry-run).

// link: relink recent text units to entities AND facts (Track A G9 fact links).
function runLinkPhase({ dryRun = false } = {}) {
  if (dryRun) return { dry_run: true, entityLinks: 0, factLinks: 0, relinked: 0 };
  const limit = Math.min(Number(process.env.BRAIN_CYCLE_RELINK_LIMIT ?? 1000), 5000);
  const ids = db.prepare(`SELECT id FROM text_units ORDER BY updated_at DESC LIMIT ?`).all(limit).map(r => r.id);
  let entityLinks = 0;
  let factLinks = 0;
  for (const id of ids) {
    entityLinks += linkTextUnitToEntities(id);
    factLinks += linkFactsForTextUnit(id);
  }
  return { entityLinks, factLinks, relinked: ids.length };
}

// infer: deterministic auto-edges from co-mention evidence.
function runInferPhase({ dryRun = false } = {}) {
  if (dryRun) return { dry_run: true };
  return inferEdgesFromTextUnits({ limit: Math.min(Number(process.env.BRAIN_CYCLE_EDGE_LIMIT ?? 1000), 5000) });
}

// cluster + reports: deterministic communities (runs AFTER dedup so members are
// canonical). buildDeterministicCommunities also writes the community_reports.
function runClusterPhase({ dryRun = false } = {}) {
  if (dryRun) return { dry_run: true, communities: 0, communityReports: 0, communityReportsSkippedMissingSources: 0 };
  return buildDeterministicCommunities();
}

async function runIndexPhase({ dryRun = false } = {}) {
  const relinkLimit = Math.min(Number(process.env.BRAIN_CYCLE_RELINK_LIMIT ?? 1000), 5000);
  const edgeLimit = Math.min(Number(process.env.BRAIN_CYCLE_EDGE_LIMIT ?? 1000), 5000);

  if (dryRun) {
    const linkResult = runLinkPhase({ dryRun: true });
    const inferResult = runInferPhase({ dryRun: true });
    const clusterResult = runClusterPhase({ dryRun: true });
    return {
      dry_run: true,
      source: '/brain/index',
      ...linkResult,
      ...inferResult,
      ...clusterResult,
      timelineEventId: null,
    };
  }

  const response = await cyclePost('/brain/index', { relinkLimit, edgeLimit }, {
    strict: false,
    timeoutMs: Number(process.env.BRAIN_CYCLE_INDEX_TIMEOUT_MS ?? 120_000),
  });
  const data = response.data ?? {};
  return {
    dry_run: false,
    source: '/brain/index',
    entityLinks: Number(data.entityLinks ?? data.entity_links ?? 0),
    factLinks: Number(data.factLinks ?? data.fact_links ?? 0),
    relinked: Number(data.relinked ?? 0),
    edges: Number(data.edges ?? 0),
    communities: Number(data.communities ?? 0),
    splitComponents: Number(data.splitComponents ?? data.split_components ?? 0),
    communityReports: Number(data.communityReports ?? data.community_reports ?? 0),
    communityReportsSkippedMissingSources: Number(data.communityReportsSkippedMissingSources ?? data.skipped_missing_sources ?? 0),
    timelineEventId: Number.isInteger(data.timelineEventId) ? data.timelineEventId : null,
  };
}

// G7: broaden phase-2 chunking beyond git repos — chunk facts/memories/plans/
// skill defs/timeline rollups into the text_unit evidence layer via Track A's
// upsertTextUnitsFromSource (which also links entities + facts). Bounded and
// deterministic; each source kind is capped and isolated by try/catch.
async function runSourceChunkingPhase(cycleId, { dryRun = false } = {}) {
  const phase = { dry_run: dryRun, sources: {}, text_units: 0, chunks: 0, errors: [] };
  if (dryRun) { phase.skipped = 'dry-run'; return phase; }
  if (!boolEnv(process.env.BRAIN_CYCLE_SOURCE_CHUNKING, true)) { phase.skipped = 'disabled'; return phase; }
  const limit = Math.max(1, Number(process.env.BRAIN_CYCLE_CHUNK_LIMIT ?? 50));
  const ingest = (sourceKind, sourceId, title, content, parser) => {
    const text = String(content ?? '').trim();
    if (!text) return;
    try {
      const r = upsertTextUnitsFromSource({
        sourceKind, sourceId, title, content: text,
        metadata: { allowSmall: true, cycle_source: true },
        processConfig: { allow_small: true, parser, prompt_version: 'cycle-chunk-v1', strategy: 'recursive' },
      });
      phase.text_units += r.textUnitIds.length;
      phase.chunks += r.chunks;
      phase.sources[sourceKind] = (phase.sources[sourceKind] ?? 0) + 1;
    } catch (err) {
      phase.errors.push({ sourceKind, sourceId, error: String(err?.message ?? err).slice(0, 120) });
    }
  };

  try {
    for (const s of db.prepare(`SELECT skill_id, name, description, tags FROM skill_nodes ORDER BY updated_at DESC LIMIT ?`).all(limit)) {
      ingest('skill-definition', `skill:${s.skill_id}`, String(s.name ?? ''), `${s.name}\n${s.description}\n${parseJson(s.tags, []).join(' ')}`, 'producer:skill-definition');
    }
  } catch (err) { phase.errors.push({ sourceKind: 'skill-definition', error: String(err?.message ?? err).slice(0, 120) }); }

  try {
    for (const mrow of db.prepare(`SELECT id, content FROM agent_memories WHERE visibility='shared' AND status='active' ORDER BY created_at DESC LIMIT ?`).all(limit)) {
      ingest('memory-summary', `memory:${mrow.id}`, `memory ${mrow.id}`, mrow.content, 'producer:memory-summary');
    }
  } catch (err) { phase.errors.push({ sourceKind: 'memory-summary', error: String(err?.message ?? err).slice(0, 120) }); }

  try {
    for (const fr of db.prepare(`SELECT entity_id, group_concat(field || '=' || value, '; ') AS rollup FROM facts WHERE status='active' GROUP BY entity_id ORDER BY MAX(observed_at) DESC LIMIT ?`).all(limit)) {
      ingest('fact-context', `facts:${fr.entity_id}`, `facts ${fr.entity_id}`, `${fr.entity_id}: ${fr.rollup}`, 'producer:fact-context');
    }
  } catch (err) { phase.errors.push({ sourceKind: 'fact-context', error: String(err?.message ?? err).slice(0, 120) }); }

  try {
    const configuredPlansDir = String(process.env.BRAIN_PLANS_DIR ?? '').trim();
    if (configuredPlansDir) {
      const plansDir = resolvePath(configuredPlansDir);
      if (!existsSync(plansDir)) {
        phase.errors.push({ sourceKind: 'project-doc', error: 'configured living-plan directory is unavailable' });
      } else {
        for (const f of readdirSync(plansDir).filter(name => name.endsWith('.md')).sort().slice(0, limit)) {
          ingest('project-doc', `plan:${f}`, f, readFileSync(resolvePath(plansDir, f), 'utf8'), 'markdown');
        }
      }
    }
  } catch (err) { phase.errors.push({ sourceKind: 'project-doc', error: String(err?.message ?? err).slice(0, 120) }); }

  try {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const recent = db.prepare(`SELECT type, COUNT(*) c FROM timeline WHERE created_at >= ? GROUP BY type ORDER BY c DESC LIMIT 30`).all(since);
    if (recent.length) ingest('timeline-rollup', `timeline:rollup`, `timeline rollup ${cycleId}`, recent.map(r => `${r.type}: ${r.c}`).join('\n'), 'timeline-rollup');
  } catch (err) { phase.errors.push({ sourceKind: 'timeline-rollup', error: String(err?.message ?? err).slice(0, 120) }); }

  try {
    const rows = db.prepare(`
      SELECT id, source, type, subject, data, created_at
      FROM timeline
      WHERE type IN ('brain:cycle-report','brain:health-score','brain:indexed','brain:learning-report')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    for (const row of rows) {
      ingest('operational-report', `timeline:${row.id}`, `operational report ${row.type}`, [
        `Timeline event ${row.id}: ${row.type}`,
        `Source: ${row.source}`,
        `Subject: ${row.subject}`,
        `Created: ${row.created_at}`,
        `Report data: ${row.data}`,
      ].join('\n'), 'producer:operational-report');
    }
  } catch (err) { phase.errors.push({ sourceKind: 'operational-report', error: String(err?.message ?? err).slice(0, 120) }); }

  return phase;
}

// G10: generate + persist skill/provider safety reports in the report phase (not
// just on-demand). Pulls provider reputation, deep-dives flagged/low-score nodes,
// and writes one brain:safety-report timeline event citing timeline event IDs AND
// text_unit IDs (per the Plan 25 non-goal).
async function runSafetyReportsPhase({ dryRun = false } = {}) {
  const phase = { dry_run: dryRun, prompt_version: promptVersion('safetyReport'), providers_scanned: 0, generated: 0, reports: [] };
  if (!boolEnv(process.env.BRAIN_CYCLE_SAFETY_REPORTS, true)) { phase.skipped = 'disabled'; return phase; }
  const limit = Math.max(1, Number(process.env.BRAIN_CYCLE_SAFETY_LIMIT ?? 25));
  const scoreThreshold = Number(process.env.BRAIN_CYCLE_SAFETY_SCORE_THRESHOLD ?? 60);
  const timeoutMs = Number(process.env.BRAIN_CYCLE_SAFETY_TIMEOUT_MS ?? 120_000);
  const rep = await brainGet(`/providers/reputation?limit=${limit}`, { strict: false, timeoutMs });
  const providers = rep.data?.providers ?? rep.data?.data?.providers ?? [];
  phase.providers_scanned = providers.length;
  const selected = providers
    .filter(p => /^\d+$/.test(String(p.skill_id)))
    .filter(p => Number(p.critical_flags ?? 0) > 0 || (typeof p.score === 'number' && p.score < scoreThreshold))
    .slice(0, limit);
  for (const p of selected) {
    const sr = await brainGet(`/graph/nodes/${p.skill_id}/safety-report`, { strict: false, timeoutMs });
    const d = sr.data?.data ?? sr.data;
    if (!d) continue;
    phase.reports.push({
      skill_id: p.skill_id,
      name: p.name,
      score: p.score,
      risk_level: d.risk_level,
      severity: d.severity,
      approval_required: d.approval_required,
      critical_flags: d.critical_flags,
      prompt_version: d.prompt_version ?? phase.prompt_version,
      timeline_event_ids: (d.evidence ?? []).map(e => e.timeline_event_id).filter(Number.isInteger),
      text_unit_ids: Array.isArray(d.text_unit_ids) ? d.text_unit_ids : [],
    });
  }
  phase.generated = phase.reports.length;
  if (phase.providers_scanned || phase.reports.length) {
    await cyclePost('/timeline', {
      source: 'brain-cycle',
      type: 'brain:safety-report',
      subject: 'skill-safety',
      data: {
        prompt_version: phase.prompt_version,
        providers_scanned: phase.providers_scanned,
        generated: phase.generated,
        reports: phase.reports,
        high_risk: phase.reports.filter(r => r.risk_level === 'high').map(r => r.skill_id),
        cites_timeline_event_ids: true,
        cites_text_unit_ids: true,
      },
      tags: ['brain', 'cycle', 'safety', phase.reports.some(r => r.risk_level === 'high') ? 'warning' : 'ok'],
    }, { strict: false, timeoutMs });
  }
  return phase;
}

async function main() {
  const startedAt = new Date().toISOString();
  const cycleId = cycleIdFromTimestamp(startedAt);
  const governanceRefs = {
    cycle_id: cycleId,
    eval_replay_ref: { route: '/eval/replay', method: 'POST', limit: Number(process.env.BRAIN_CYCLE_EVAL_LIMIT ?? 200) },
    control_center_ref: '/dashboard/health',
  };
  const traceContext = createTraceContext({ source: 'brain-cycle', subject: cycleId, name: 'brain-cycle' });
  // Startup banner → stderr (stdout stays a clean JSON envelope). Surfaces the
  // resolved run config so verification can confirm dry-run, target brain, and
  // the local-model routing for consolidation (locked decision #1).
  const consolidationCfg = consolidationRouting();
  console.error(`[brain-cycle] start cycle=${cycleId} dry_run=${DRY_RUN} brain=${BRAIN_URL}`);
  console.error(`[brain-cycle] consolidation enabled=${consolidationEnabled()} lookback=${consolidationLookbackDays()}d dispatch=/ask team=${consolidationCfg.team} agent=${consolidationCfg.agent} model=${consolidationCfg.model || '(agent-default)'} runtime=${consolidationCfg.runtime_expectation}`);
  console.error(`[brain-cycle] embed enabled=${embedPhaseEnabled()} provider=${process.env.BRAIN_EMBED_PROVIDER ?? 'ollama'} model=${process.env.BRAIN_EMBED_MODEL ?? 'nomic-embed-text'}`);
  await recordTraceEvent(traceStartEvent(traceContext, {
    phase: 'cycle',
    metadata: { dry_run: DRY_RUN, brain: BRAIN_URL },
  }), { dryRun: DRY_RUN });

  const previousReport = await getPreviousCycleReport();
  const phaseOrder = [];
  const span = async (phase, startedAtMs, metadata = {}, status = 'ok') => {
    await recordTraceEvent(traceSpanEvent(traceContext, {
      phase,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      metadata: { dry_run: DRY_RUN, ...metadata },
    }), { dryRun: DRY_RUN });
  };

  // Plan 25 G8 ordered pipeline: prune -> chunk -> link -> infer -> dedup ->
  // cluster -> reports -> eval -> embed (cluster+reports now run AFTER dedup,
  // and chunk runs BEFORE link/infer).

  // 1. prune/age
  let phaseStart = Date.now();
  const prune_age = await runPruneAgePhase({ dryRun: DRY_RUN });
  phaseOrder.push('prune');
  await span('prune-age', phaseStart, { timeline_pruned: prune_age.timeline_pruned ?? 0, memory_soft_expired: prune_age.memory_soft_expired ?? 0 });

  // 2. chunk — git repos + broadened sources (facts/memories/plans/skills/timeline)
  phaseStart = Date.now();
  const repo_digestion = DRY_RUN ? { digested: [], refresh_tasks: [], skipped: ['dry-run'] } : await digestConfiguredRepos(db);
  const source_chunking = await runSourceChunkingPhase(cycleId, { dryRun: DRY_RUN });
  phaseOrder.push('chunk');
  await span('chunk', phaseStart, { repos: repo_digestion.digested?.length ?? 0, source_text_units: source_chunking.text_units ?? 0 });

  // 3. index — delegate the deterministic relink/infer/community phase to /brain/index
  phaseStart = Date.now();
  const indexed = await runIndexPhase({ dryRun: DRY_RUN });
  phaseOrder.push('link');
  await span('link', phaseStart, {
    entity_links: Number(indexed.entityLinks ?? 0),
    fact_links: Number(indexed.factLinks ?? 0),
  });
  phaseOrder.push('infer');
  await span('infer', phaseStart, {
    edges: Number(indexed.edges ?? 0),
  });

  // 4. dedup — exact alias merges (auto), fuzzy -> proposals
  const approvals = await brainGet('/approvals?status=pending&limit=200', {
    strict: false,
    timeoutMs: Number(process.env.BRAIN_CYCLE_APPROVAL_TIMEOUT_MS ?? 120_000),
  });
  const { factsByEntity, contradictions: rawContradictions } = await collectEntityFacts(Number(process.env.BRAIN_CYCLE_ENTITY_LIMIT ?? 500));
  const contradictions = annotateContradictions(rawContradictions, previousReport);
  phaseStart = Date.now();
  const alias_dedup = runAliasDedupPhase(governanceRefs, { dryRun: DRY_RUN });
  phaseOrder.push('dedup');
  await span('dedup', phaseStart, { exact_merges: alias_dedup.exact_merges?.length ?? 0, fuzzy: alias_dedup.fuzzy_candidates?.length ?? 0 });

  phaseOrder.push('cluster');
  await span('cluster', phaseStart, {
    communities: Number(indexed.communities ?? 0),
    splits: Number(indexed.splitComponents ?? 0),
  });

  // 5. reports — community reports are written by /brain/index; generate + persist safety reports
  phaseStart = Date.now();
  const safety_reports = await runSafetyReportsPhase({ dryRun: DRY_RUN });
  phaseOrder.push('reports');
  await span('reports', phaseStart, { community_reports: Number(indexed.communityReports ?? 0), safety_reports: safety_reports.generated ?? 0 });

  // governance + facts (post-dedup canonical entities)
  const promotedMemories = await promoteRepeatedFacts(factsByEntity);
  const contradictionApprovals = DRY_RUN ? [] : await createContradictionApprovals({ currentContradictions: contradictions, previousReport, governance: governanceRefs });
  const edgeRepairApprovals = DRY_RUN ? [] : await createEdgeRepairApprovals({ governance: governanceRefs });
  const memoryRetireApprovals = DRY_RUN ? [] : await createMemoryRetireApprovals(governanceRefs);
  const instructionLifecycleApprovals = DRY_RUN ? [] : await createInstructionLifecycleApprovals(governanceRefs);
  const evalFixturePromotionApprovals = DRY_RUN ? [] : await createEvalFixturePromotionApprovals(governanceRefs);
  const evalFixtureRetireApprovals = DRY_RUN ? [] : await createEvalFixtureRetireApprovals(governanceRefs);
  const skillRevisionApprovals = DRY_RUN ? [] : await createSkillRevisionApprovals(governanceRefs);
  const citationRepairTasks = await createCitationRepairTasks();
  const learning_task_recovery = DRY_RUN ? { recovered: [], skipped: ['dry-run'] } : await recoverLearningTaskLeases();

  // 8. eval
  phaseStart = Date.now();
  const eval_quality = DRY_RUN ? { summary: {}, warnings: [], skipped: 'dry-run' } : await evalQuality(previousReport);
  phaseOrder.push('eval');
  await span('eval', phaseStart, { warnings: eval_quality.warnings?.length ?? 0 });
  const eval_quality_repair_tasks = await createEvalQualityRepairTasks(eval_quality);
  const weak_phase_learning_tasks = await createWeakRetrievalPhaseTasks();
  const knowledge_gap_research_tasks = await createKnowledgeGapResearchTasks();
  const phase_improvement_outcomes = await recordPhaseImprovementOutcomesPhase();
  const trajectory_reflection = await compactTrajectoryReflectionPhase();
  const source_precision_snapshot = DRY_RUN ? null : await sourcePrecisionSnapshot();
  const instruction_scope_snapshot = DRY_RUN ? null : await instructionScopeSnapshot();
  const correction_mining = await correctionMiningDryRun();
  const consolidationStart = Date.now();
  const consolidation_takes = await createConsolidationTakes({ dryRun: DRY_RUN, traceContext });
  await span('consolidation-takes', consolidationStart, { created: consolidation_takes.created?.length ?? 0, errors: consolidation_takes.errors?.length ?? 0 });

  // 9. embed
  const embedStart = Date.now();
  const embed = await runEmbedPhase({ dryRun: DRY_RUN, traceContext });
  phaseOrder.push('embed');
  await span('embed', embedStart, { ran: Boolean(embed.ran), skipped: embed.skipped ?? '', error: embed.error ?? '' });

  // Curator governance step: auto-apply safe + reversible approvals (within hard
  // guardrails), leave risky ones proposed. Deterministic, ~$0. Dry-run safe.
  const curator = await runCurator({
    post: cyclePost,
    get: brainGet,
    logTimeline: !DRY_RUN,
    env: { ...process.env, BRAIN_CURATOR_DRY_RUN: DRY_RUN ? '1' : (process.env.BRAIN_CURATOR_DRY_RUN ?? '') },
  });
  await span('curator', Date.now(), { applied: curator.applied?.length ?? 0, failed: curator.failed?.length ?? 0 });
  const pendingApprovalCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM approvals WHERE status='pending'`).get()?.c ?? (approvals.data?.approvals ?? []).length);
  const warnings = [];
  if (pendingApprovalCount) warnings.push(`${pendingApprovalCount} pending approvals`);
  if (contradictions.length) warnings.push(`${contradictions.length} entities have contradictory facts`);
  warnings.push(...eval_quality.warnings);
  if (eval_quality_repair_tasks.created.length) warnings.push(`${eval_quality_repair_tasks.created.length} eval quality repair tasks created`);
  if (weak_phase_learning_tasks.created.length) warnings.push(`${weak_phase_learning_tasks.created.length} weak retrieval phase learning tasks created`);
  if (knowledge_gap_research_tasks.created.length) warnings.push(`${knowledge_gap_research_tasks.created.length} knowledge gap research tasks created`);
  if (phase_improvement_outcomes.created.length) warnings.push(`${phase_improvement_outcomes.created.length} phase improvement outcomes recorded`);
  if (trajectory_reflection.created.length) warnings.push(`${trajectory_reflection.created.length} trajectory heuristics compacted`);
  if (Number(indexed.communityReportsSkippedMissingSources ?? 0) > 0) warnings.push(`${indexed.communityReportsSkippedMissingSources} community reports skipped for missing source citations`);
  if (consolidation_takes.errors.length) warnings.push(`${consolidation_takes.errors.length} consolidation take errors`);
  if (alias_dedup.exact_merges.length) warnings.push(`${alias_dedup.exact_merges.length} exact alias merges applied`);
  if (alias_dedup.fuzzy_candidates.length) warnings.push(`${alias_dedup.fuzzy_candidates.length} fuzzy alias merge approvals queued`);
  if (edgeRepairApprovals.length) warnings.push(`${edgeRepairApprovals.length} edge repair approvals queued`);
  if (curator.applied?.length) warnings.push(`${curator.applied.length} approvals auto-applied by curator`);
  if (curator.failed?.length) warnings.push(`${curator.failed.length} curator auto-apply failures`);
  const status = warnings.length ? 'warn' : 'ok';
  const quality = eval_quality.warnings.length ? 'degraded' : 'stable';
  const attentionReasons = [
    ...(contradictionApprovals.length ? ['contradiction approvals queued'] : []),
    ...(edgeRepairApprovals.length ? ['edge repair approvals queued'] : []),
    ...(alias_dedup.fuzzy_candidates.length ? ['fuzzy alias proposals queued'] : []),
    ...eval_quality.warnings.map(warning => `eval replay quality warning: ${warning}`),
    ...(consolidation_takes.errors.length ? ['consolidation take errors'] : []),
  ];
  const humanAttention = {
    required: attentionReasons.length > 0,
    level: contradictionApprovals.length || edgeRepairApprovals.length || consolidation_takes.errors.length ? 'high' : warnings.length ? 'medium' : 'low',
    reasons: attentionReasons,
  };

  const report = {
    cycle_id: cycleId,
    previous_cycle_id: previousReport?.cycle_id ?? null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    status,
    quality,
    human_attention: humanAttention,
    prune_age,
    source_chunking,
    safety_reports,
    phase_order: phaseOrder,
    indexed,
    community_reports: {
      generated: Number(indexed.communityReports ?? 0),
      skipped_missing_sources: Number(indexed.communityReportsSkippedMissingSources ?? 0),
      prompt_version: promptVersion('communityReport'),
      citation_required: true,
    },
    embed,
    repo_digestion,
    pending_approvals: pendingApprovalCount,
    alias_dedup,
    promoted_memories: promotedMemories,
    contradiction_approvals: contradictionApprovals,
    edge_repair_approvals: edgeRepairApprovals,
    memory_retire_approvals: memoryRetireApprovals,
    instruction_lifecycle_approvals: instructionLifecycleApprovals,
    eval_fixture_promotion_approvals: evalFixturePromotionApprovals,
    eval_fixture_retire_approvals: evalFixtureRetireApprovals,
    skill_revision_approvals: skillRevisionApprovals,
    curator,
    citation_repair_tasks: citationRepairTasks,
    learning_task_recovery,
    weak_phase_learning_tasks,
    knowledge_gap_research_tasks,
    phase_improvement_outcomes,
    trajectory_reflection,
    correction_mining: {
      candidates: correction_mining.candidates.slice(0, 25),
      candidate_count: correction_mining.candidates.length,
    },
    consolidation_takes,
    contradictions: contradictions.slice(0, 50).map(c => ({
      entity_id: c.entity_id,
      fields: c.fields,
      details: (c.details ?? []).map(detail => ({
        field: detail.field,
        claims: detail.claims ?? [],
        consecutive_cycle_count: detail.consecutive_cycle_count ?? 1,
      })),
    })),
    eval_quality,
    eval_quality_repair_tasks,
    source_precision_snapshot,
    instruction_scope_snapshot,
    refs: {
      decision_trace_id: `decision-trace:${cycleId}`,
      eval_replay_ref: governanceRefs.eval_replay_ref,
      control_center_ref: governanceRefs.control_center_ref,
      learning_dashboard_ref: '/dashboard/learning',
    },
    warnings,
  };
  report.phases = [
    {
      order: 1,
      name: 'chunk',
      source: 'repo_digestion',
      completed: true,
      dry_run: DRY_RUN,
      digested_repos: Array.isArray(repo_digestion.digested) ? repo_digestion.digested.length : 0,
      timeline_event_ids: Array.isArray(repo_digestion.digested) ? repo_digestion.digested.map(repo => repo.timelineEventId).filter(Number.isInteger) : [],
    },
    {
      order: 2,
      name: 'link',
      source: '/brain/index',
      completed: true,
      entity_links: Number(indexed.entityLinks ?? 0),
      fact_links: Number(indexed.factLinks ?? 0),
      timeline_event_id: Number.isInteger(indexed.timelineEventId) ? indexed.timelineEventId : null,
    },
    {
      order: 3,
      name: 'infer',
      source: '/brain/index',
      completed: true,
      edges: Number(indexed.edges ?? 0),
      timeline_event_id: Number.isInteger(indexed.timelineEventId) ? indexed.timelineEventId : null,
    },
    {
      order: 4,
      name: 'cluster',
      source: '/brain/index',
      completed: true,
      communities: Number(indexed.communities ?? 0),
      split_components: Number(indexed.splitComponents ?? 0),
      timeline_event_id: Number.isInteger(indexed.timelineEventId) ? indexed.timelineEventId : null,
    },
    {
      order: 5,
      name: 'summarize',
      source: '/brain/index',
      completed: true,
      community_reports: Number(indexed.communityReports ?? 0),
      skipped_missing_sources: Number(indexed.communityReportsSkippedMissingSources ?? 0),
      timeline_event_id: Number.isInteger(indexed.timelineEventId) ? indexed.timelineEventId : null,
    },
    {
      order: 6,
      name: 'report',
      source: 'brain:cycle-report',
      completed: true,
      timeline_event_id: null,
    },
  ];
  report.refs.decision_trace_hash = decisionTraceHash({
    cycle_id: report.cycle_id,
    previous_cycle_id: report.previous_cycle_id,
    status: report.status,
    quality: report.quality,
    pending_approvals: report.pending_approvals,
    indexed: report.indexed,
    community_reports: report.community_reports,
    contradiction_approvals: report.contradiction_approvals,
    edge_repair_approvals: report.edge_repair_approvals,
    memory_retire_approvals: report.memory_retire_approvals,
    instruction_lifecycle_approvals: report.instruction_lifecycle_approvals,
    eval_fixture_promotion_approvals: report.eval_fixture_promotion_approvals,
    eval_fixture_retire_approvals: report.eval_fixture_retire_approvals,
    skill_revision_approvals: report.skill_revision_approvals,
    eval_quality_repair_tasks: report.eval_quality_repair_tasks,
    weak_phase_learning_tasks: report.weak_phase_learning_tasks,
    consolidation_takes: report.consolidation_takes,
    phases: report.phases,
    warnings: report.warnings,
  });
  // The CycleReport itself is the one timeline event every run must emit. In
  // dry-run it is built + printed but NOT persisted (cyclePost no-ops).
  const event = await cyclePost('/timeline', {
    source: 'brain-cycle',
    type: 'brain:cycle-report',
    subject: cycleId,
    data: report,
    tags: ['brain', 'cycle', status, quality, humanAttention.required ? 'human-attention' : 'autonomous', ...(DRY_RUN ? ['dry-run'] : [])],
  });
  report.phases[report.phases.length - 1].timeline_event_id = event.data?.id ?? null;
  await recordTraceEvent(traceEndEvent(traceContext, {
    phase: 'cycle',
    status: status,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
    metadata: { warnings: warnings.length, quality, dry_run: DRY_RUN },
  }), { dryRun: DRY_RUN });

  console.log(JSON.stringify(scriptEnvelope({ timelineEventId: event.data?.id ?? null, ...report }, { script: 'brain-cycle' }), null, 2));
}

let stopping = false;
let stopParentWatchdog = () => {};
const shutdown = (reason) => {
  if (stopping) return;
  stopping = true;
  stopParentWatchdog();
  console.warn(`[brain-cycle] shutting down (${reason})`);
  process.exit(0);
};
stopParentWatchdog = startParentDeathWatchdog(() => shutdown('parent-exit'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('exit', () => stopParentWatchdog());

main().catch(async (err) => {
  await recordScriptFailure({ script: 'brain-cycle', error: err });
  console.log(JSON.stringify(scriptFailureEnvelope(err, {
    script: 'brain-cycle',
    hint: 'inspect the cycle phase that failed and rerun the cycle against a healthy Brain',
    retry_command: 'node brain-cycle.mjs',
    risk: { level: 'medium', action: 'retry' },
  }), null, 2));
  process.exit(1);
}).finally(() => stopParentWatchdog());
