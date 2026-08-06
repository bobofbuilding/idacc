#!/usr/bin/env node
/**
 * Brain entity-edge graph quality metrics.
 *
 * This module intentionally does not use brainHealthSignals()/orphanStale:
 * those health signals blend entity connectivity with agent-memory staleness.
 * Here an orphan is only an active entity with no incident active entity edge.
 *
 * Usage:
 *   node brain-graph-quality-metrics.mjs [--url http://localhost:4200] [--json]
 *   node brain-graph-quality-metrics.mjs --baseline [--json]
 *
 * Exit codes: 0 when every target passes, 1 when any target fails, 2 on error.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brainRequestHeaders } from './brain-client.mjs';
import {
  classifyEntityEdgeFreshness,
  entityEdgeFreshnessThresholds,
} from './edge-semantics.mjs';

export const GRAPH_QUALITY_TARGETS = Object.freeze({
  orphan_node_rate: {
    target: 0.10,
    direction: 'lte',
    label: 'Active entity nodes without an incident active edge',
  },
  duplicate_edge_rate: {
    target: 0.01,
    direction: 'lte',
    label: 'Duplicate directed (from, to, kind) entity edges',
  },
  edge_confidence_distribution: {
    statistic: 'mean',
    target: 0.70,
    direction: 'gte',
    label: 'Mean edge confidence',
  },
  edge_provenance_coverage_rate: {
    target: 0.80,
    direction: 'gte',
    label: 'Edges carrying explicit or text-unit provenance',
  },
  edge_freshness_rate: {
    target: 0.80,
    direction: 'gte',
    label: 'Edges refreshed in the configured fresh window',
  },
});

export const DEFAULT_FRESH_DAYS = 7;
export const DEFAULT_STALE_DAYS = 30;

const INACTIVE_ENTITY_STATUSES = new Set(['merged', 'deleted', 'archived', 'retired', 'removed']);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function populatedProvenance(value) {
  const parsed = parseJson(value, value);
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
  return typeof parsed === 'string' ? parsed.trim().length > 0 : Boolean(parsed);
}

function textUnitIds(edge) {
  const parsed = parseJson(edge.text_unit_ids ?? edge.textUnitIds, []);
  return Array.isArray(parsed) ? parsed.filter(value => value !== null && value !== '') : [];
}

function edgeHasExplicitProvenance(edge) {
  return [
    edge.provenance,
    edge.provenance_method,
    edge.provenanceMethod,
    edge.provenance_type,
    edge.provenanceType,
    edge.source_classification,
    edge.sourceClassification,
  ].some(populatedProvenance);
}

export function classifyEdgeFreshness(updatedAt, {
  nowMs = Date.now(),
  freshDays,
  staleDays,
} = {}) {
  const thresholdInput = {};
  if (freshDays != null) thresholdInput.freshMaxAgeSeconds = Math.max(0, Number(freshDays) || 0) * 86_400;
  if (staleDays != null) thresholdInput.staleAfterSeconds = Math.max(0, Number(staleDays) || 0) * 86_400;
  return classifyEntityEdgeFreshness(updatedAt, {
    nowSeconds: Math.floor(nowMs / 1000),
    ...thresholdInput,
  }).classification;
}

function nearestRank(sorted, percentile) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function activeEntity(node) {
  return !INACTIVE_ENTITY_STATUSES.has(String(node.status ?? 'active').trim().toLowerCase());
}

function edgeIdPart(edge, snake, camel) {
  return String(edge[snake] ?? edge[camel] ?? '');
}

function confidenceForEdge(edge) {
  const explicit = finiteNumber(edge.confidence);
  if (explicit !== null) return { value: clamp01(explicit), source: 'confidence' };
  const weight = finiteNumber(edge.weight);
  if (weight !== null) return { value: clamp01(weight), source: 'weight_proxy' };
  return { value: 0, source: 'missing' };
}

function resultValue(values, key, target) {
  if (target.statistic) return values[key]?.[target.statistic] ?? 0;
  return values[key] ?? 0;
}

function passes(value, target) {
  return target.direction === 'gte' ? value >= target.target : value <= target.target;
}

export function evaluateGraphQuality(values, targets = GRAPH_QUALITY_TARGETS) {
  const results = {};
  let allPass = true;
  for (const [key, target] of Object.entries(targets)) {
    const value = resultValue(values, key, target);
    const pass = passes(value, target);
    if (!pass) allPass = false;
    results[key] = { value, ...target, pass };
  }
  return { results, all_pass: allPass };
}

export function computeGraphQualityMetrics({
  nodes = [],
  edges = [],
  nowMs = Date.now(),
  freshDays,
  staleDays,
} = {}) {
  const configuredThresholds = entityEdgeFreshnessThresholds({
    freshMaxAgeSeconds: freshDays == null ? undefined : Math.max(0, Number(freshDays) || 0) * 86_400,
    staleAfterSeconds: staleDays == null ? undefined : Math.max(0, Number(staleDays) || 0) * 86_400,
  });
  const configuredFreshDays = configuredThresholds.freshMaxAgeSeconds / 86_400;
  const configuredStaleDays = configuredThresholds.staleAfterSeconds / 86_400;
  const activeNodes = nodes.filter(activeEntity);
  const activeNodeIds = new Set(activeNodes.map(node => String(node.id ?? node.entity_id ?? '')));
  const activeEdges = edges.filter(edge => {
    const from = edgeIdPart(edge, 'from_id', 'from');
    const to = edgeIdPart(edge, 'to_id', 'to');
    return activeNodeIds.has(from) && activeNodeIds.has(to);
  });

  const incidentNodeIds = new Set();
  const signatures = new Set();
  let duplicateEdges = 0;
  let provenanceCoveredEdges = 0;
  let explicitProvenanceEdges = 0;
  let legacyTextUnitProvenanceEdges = 0;
  let freshEdges = 0;
  const freshnessDistribution = { fresh: 0, aging: 0, stale: 0 };
  const confidenceSourceCounts = { confidence: 0, weight_proxy: 0, missing: 0 };
  const confidences = [];

  for (const edge of activeEdges) {
    const from = edgeIdPart(edge, 'from_id', 'from');
    const to = edgeIdPart(edge, 'to_id', 'to');
    const kind = String(edge.kind ?? edge.type ?? '');
    incidentNodeIds.add(from);
    incidentNodeIds.add(to);

    const signature = JSON.stringify([from, to, kind]);
    if (signatures.has(signature)) duplicateEdges++;
    else signatures.add(signature);

    const confidence = confidenceForEdge(edge);
    confidences.push(confidence.value);
    confidenceSourceCounts[confidence.source]++;

    const explicitProvenance = edgeHasExplicitProvenance(edge);
    const legacyProvenance = textUnitIds(edge).length > 0;
    if (explicitProvenance) explicitProvenanceEdges++;
    if (legacyProvenance) legacyTextUnitProvenanceEdges++;
    if (explicitProvenance || legacyProvenance) provenanceCoveredEdges++;

    const explicitFreshness = String(edge.freshness ?? edge.freshness_status ?? edge.freshnessStatus ?? '').toLowerCase();
    const freshness = ['fresh', 'aging', 'stale'].includes(explicitFreshness)
      ? explicitFreshness
      : classifyEdgeFreshness(edge.updated_at ?? edge.updatedAt, {
        nowMs,
        freshDays: configuredFreshDays,
        staleDays: configuredStaleDays,
      });
    freshnessDistribution[freshness]++;
    if (freshness === 'fresh') freshEdges++;
  }

  const sortedConfidences = [...confidences].sort((a, b) => a - b);
  const confidenceSum = sortedConfidences.reduce((sum, value) => sum + value, 0);
  const edgeCount = activeEdges.length;
  const orphanNodeIds = activeNodes
    .map(node => String(node.id ?? node.entity_id ?? ''))
    .filter(id => id && !incidentNodeIds.has(id));

  const values = {
    orphan_node_rate: activeNodes.length ? orphanNodeIds.length / activeNodes.length : 0,
    duplicate_edge_rate: edgeCount ? duplicateEdges / edgeCount : 0,
    edge_confidence_distribution: {
      count: sortedConfidences.length,
      mean: sortedConfidences.length ? round(confidenceSum / sortedConfidences.length) : 0,
      p10: round(nearestRank(sortedConfidences, 0.10) ?? 0),
      p50: round(nearestRank(sortedConfidences, 0.50) ?? 0),
      p90: round(nearestRank(sortedConfidences, 0.90) ?? 0),
      min: round(sortedConfidences[0] ?? 0),
      max: round(sortedConfidences.at(-1) ?? 0),
      source_counts: confidenceSourceCounts,
      primary_source: confidenceSourceCounts.confidence > 0 ? 'confidence' : 'weight_proxy',
    },
    edge_provenance_coverage_rate: edgeCount ? provenanceCoveredEdges / edgeCount : 0,
    edge_freshness_rate: edgeCount ? freshEdges / edgeCount : 0,
  };
  values.orphan_node_rate = round(values.orphan_node_rate);
  values.duplicate_edge_rate = round(values.duplicate_edge_rate);
  values.edge_provenance_coverage_rate = round(values.edge_provenance_coverage_rate);
  values.edge_freshness_rate = round(values.edge_freshness_rate);

  return {
    measured_at: new Date(nowMs).toISOString(),
    graph_scope: 'active entity nodes and entity edges whose endpoints are both active',
    configuration: { fresh_days: configuredFreshDays, stale_days: configuredStaleDays },
    graph_totals: {
      entity_nodes: nodes.length,
      active_entity_nodes: activeNodes.length,
      entity_edges: edges.length,
      active_entity_edges: edgeCount,
      orphan_nodes: orphanNodeIds.length,
      duplicate_edges: duplicateEdges,
      provenance_covered_edges: provenanceCoveredEdges,
      explicit_provenance_edges: explicitProvenanceEdges,
      legacy_text_unit_provenance_edges: legacyTextUnitProvenanceEdges,
      fresh_edges: freshEdges,
    },
    values,
    distributions: { edge_freshness: freshnessDistribution },
    details: { orphan_node_ids: orphanNodeIds },
    targets: GRAPH_QUALITY_TARGETS,
    ...evaluateGraphQuality(values),
  };
}

export function collectGraphQualityMetrics(db, options = {}) {
  const startedAt = performance.now();
  const nodes = db.prepare(`
    SELECT id, status
    FROM entities
  `).all();
  // Keep the pass bounded to fields that participate in the metrics. Edge
  // descriptions can be large and are irrelevant to this read-only overlay.
  const edges = db.prepare(`
    SELECT from_id, to_id, kind, weight, confidence, provenance,
           text_unit_ids, updated_at
    FROM entity_edges
  `).all();
  const metrics = computeGraphQualityMetrics({ nodes, edges, ...options });
  metrics.computation_ms = round(performance.now() - startedAt, 3);
  return metrics;
}

// Static baseline captured from the local Brain graph after this metric contract
// was introduced. Re-run the CLI for current measurements; --baseline is fixed.
export const BASELINE_2026_07_11 = Object.freeze({
  measured_at: '2026-07-11T17:48:23.294Z',
  graph_scope: 'active entity nodes and entity edges whose endpoints are both active',
  configuration: { fresh_days: 7, stale_days: 30 },
  graph_totals: {
    entity_nodes: 351,
    active_entity_nodes: 349,
    entity_edges: 19458,
    active_entity_edges: 13094,
    orphan_nodes: 34,
    duplicate_edges: 0,
    provenance_covered_edges: 13094,
    explicit_provenance_edges: 13094,
    legacy_text_unit_provenance_edges: 11743,
    fresh_edges: 13094,
  },
  values: {
    orphan_node_rate: 0.097421,
    duplicate_edge_rate: 0,
    edge_confidence_distribution: {
      count: 13094,
      mean: 0.5,
      p10: 0.5,
      p50: 0.5,
      p90: 0.5,
      min: 0.5,
      max: 0.5,
      source_counts: { confidence: 13094, weight_proxy: 0, missing: 0 },
      primary_source: 'confidence',
    },
    edge_provenance_coverage_rate: 1,
    edge_freshness_rate: 1,
  },
  distributions: { edge_freshness: { fresh: 13094, aging: 0, stale: 0 } },
  details: { orphan_node_ids: [], orphan_node_ids_omitted_from_snapshot: true },
});

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function graphQualityReport(data, { json = false } = {}) {
  const evaluated = data.results ? data : { ...data, targets: GRAPH_QUALITY_TARGETS, ...evaluateGraphQuality(data.values) };
  if (json) return JSON.stringify(evaluated, null, 2);
  const lines = [
    `Brain Graph Quality Metrics  ${evaluated.measured_at}`,
    `Scope: ${evaluated.graph_scope}`,
    `Totals: ${evaluated.graph_totals.active_entity_nodes} active entities  ${evaluated.graph_totals.active_entity_edges} active edges`,
  ];
  for (const [key, result] of Object.entries(evaluated.results)) {
    const direction = result.direction === 'gte' ? '≥' : '≤';
    lines.push(`${result.pass ? '✓' : '✗'} ${result.label}: ${formatPercent(result.value)} (target ${direction}${formatPercent(result.target)})`);
  }
  const confidence = evaluated.values.edge_confidence_distribution;
  lines.push(`Confidence: mean ${confidence.mean.toFixed(3)}  p10 ${confidence.p10.toFixed(3)}  p50 ${confidence.p50.toFixed(3)}  p90 ${confidence.p90.toFixed(3)}  source ${confidence.primary_source}`);
  if (evaluated.computation_ms != null) lines.push(`Computation: ${evaluated.computation_ms.toFixed(3)} ms`);
  lines.push(`Result: ${Object.values(evaluated.results).filter(result => result.pass).length}/${Object.keys(evaluated.results).length} passing`);
  return lines.join('\n');
}

async function main() {
  const json = process.argv.includes('--json');
  if (process.argv.includes('--baseline')) {
    const baseline = { ...BASELINE_2026_07_11, targets: GRAPH_QUALITY_TARGETS, ...evaluateGraphQuality(BASELINE_2026_07_11.values) };
    console.log(graphQualityReport(baseline, { json }));
    return baseline.all_pass ? 0 : 1;
  }
  const urlIndex = process.argv.indexOf('--url');
  const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : 'http://localhost:4200';
  const freshIndex = process.argv.indexOf('--fresh-days');
  const staleIndex = process.argv.indexOf('--stale-days');
  const query = new URLSearchParams();
  if (freshIndex >= 0) query.set('fresh_days', process.argv[freshIndex + 1]);
  if (staleIndex >= 0) query.set('stale_days', process.argv[staleIndex + 1]);
  const response = await fetch(`${baseUrl}/graph/quality${query.size ? `?${query}` : ''}`, {
    headers: brainRequestHeaders(),
  });
  if (!response.ok) throw new Error(`GET /graph/quality → ${response.status}`);
  const body = await response.json();
  const data = body.data ?? body;
  console.log(graphQualityReport(data, { json }));
  return data.all_pass ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error(`Error collecting graph quality metrics: ${error.message}`);
      process.exitCode = 2;
    });
}
