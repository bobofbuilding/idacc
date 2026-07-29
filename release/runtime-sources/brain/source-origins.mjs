import { canonicalSourceId, normalizeSourceIds } from './source-ids.mjs';

function createSourceOriginMap() {
  return Object.create(null);
}

export const CANONICAL_SOURCE_ORIGINS = Object.freeze([
  'lexical',
  'related_entity',
  'repo_affinity',
  'historical_precision',
  'shared_memory',
  'trajectory_memory',
  'pinned_task_context',
]);

const SOURCE_ORIGIN_ALIASES = new Map([
  ['alias', 'related_entity'],
  ['repo_affinity', 'repo_affinity'],
  ['repo_entity', 'repo_affinity'],
  ['related_entity', 'related_entity'],
  ['trajectory_memory', 'trajectory_memory'],
  ['shared_memory', 'shared_memory'],
  ['historical_precision', 'historical_precision'],
  ['lexical', 'lexical'],
  ['pinned_task_context', 'pinned_task_context'],
  ['task_context', 'pinned_task_context'],
  ['task_pinned_context', 'pinned_task_context'],
]);

function normalizeOriginLabel(origin) {
  if (origin === undefined || origin === null) return null;
  const text = String(origin).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  return SOURCE_ORIGIN_ALIASES.get(lower) ?? lower;
}

export function canonicalSourceOriginId(sourceId) {
  if (sourceId === undefined || sourceId === null) return null;
  const text = String(sourceId).trim();
  if (!text) return null;
  if (text.startsWith('entity:') || text.startsWith('text:') || text.startsWith('fact:') || text.startsWith('memory:')) {
    return text;
  }
  return canonicalSourceId('entity', text);
}

export function normalizeSourceOrigins(sourceOrigins = {}, allowedSourceIds = []) {
  const allowed = new Set(normalizeSourceIds(allowedSourceIds).canonical);
  const normalized = createSourceOriginMap();
  if (!sourceOrigins || typeof sourceOrigins !== 'object' || Array.isArray(sourceOrigins)) return normalized;

  for (const [sourceId, rawOrigins] of Object.entries(sourceOrigins)) {
    const canonicalSourceId = canonicalSourceOriginId(sourceId);
    if (!canonicalSourceId) continue;
    if (allowed.size && !allowed.has(canonicalSourceId)) continue;

    const origins = Array.isArray(rawOrigins) ? rawOrigins : [rawOrigins];
    const cleaned = origins.map(normalizeOriginLabel).filter(Boolean);
    if (!cleaned.length) continue;

    const existing = Array.isArray(normalized[canonicalSourceId]) ? normalized[canonicalSourceId] : (normalized[canonicalSourceId] = []);
    for (const origin of cleaned) {
      if (!existing.includes(origin)) existing.push(origin);
    }
  }

  return normalized;
}

export function mergeSourceOrigins(...maps) {
  const merged = createSourceOriginMap();
  for (const map of maps) {
    const normalized = normalizeSourceOrigins(map);
    for (const [sourceId, origins] of Object.entries(normalized)) {
      const existing = Array.isArray(merged[sourceId]) ? merged[sourceId] : (merged[sourceId] = []);
      for (const origin of origins) {
        if (!existing.includes(origin)) existing.push(origin);
      }
    }
  }
  return merged;
}

export function addSourceOrigin(originMap, sourceId, origin) {
  const canonicalId = canonicalSourceOriginId(sourceId);
  const normalizedOrigin = normalizeOriginLabel(origin);
  if (!canonicalId || !normalizedOrigin) return originMap;
  const existing = Array.isArray(originMap[canonicalId]) ? originMap[canonicalId] : (originMap[canonicalId] = []);
  if (!existing.includes(normalizedOrigin)) existing.push(normalizedOrigin);
  return originMap;
}
