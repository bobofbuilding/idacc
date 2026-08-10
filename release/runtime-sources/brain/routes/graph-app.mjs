import { readFileSync } from 'node:fs';

import { classifyEntityEdgeFreshness, entityEdgeFreshnessThresholds } from '../edge-semantics.mjs';
import { collectGraphQualityMetrics } from '../brain-graph-quality-metrics.mjs';
import { requestHasValidBearer, requiredRequestToken } from '../http.mjs';

const GRAPH_APP_NODE_LIMIT_DEFAULT = 500;
const GRAPH_APP_NODE_LIMIT_MAX = 2500;
const GRAPH_APP_EDGE_LIMIT_DEFAULT = 3200;
const GRAPH_APP_EDGE_LIMIT_MAX = 12000;
const GRAPH_APP_LEARN_MATERIAL_TYPE = 'learn-material';
const GRAPH_APP_LEARN_ENTITY_RESERVE_MAX = 64;
const GRAPH_APP_LEARN_SYNC_SCHEMA_VERSION = 3;

const GRAPH_APP_KINDS = new Set(['all', 'skills', 'entities']);
const GRAPH_APP_TAG_MODE = new Set(['any', 'all']);
const GRAPH_APP_VIEWS = Object.freeze({
  overview: { label: 'Overview', kind: 'all', types: [] },
  knowledge: { label: 'Knowledge', kind: 'entities', types: ['entity', 'concept', 'fact', 'memory', 'reference'] },
  fleet: { label: 'Fleet', kind: 'entities', types: ['team', 'agent'] },
  work: { label: 'Work', kind: 'entities', types: ['goal', 'task', 'route', 'query', 'tool'] },
  sources: { label: 'Sources', kind: 'entities', types: ['source', 'document', 'reference', 'repo', 'learn-material'] },
  skills: { label: 'Skills', kind: 'skills', types: [] },
});
const SENSITIVE_GRAPH_DATA_KEY_RE = /private_?key|creator_?key|secret|api_?key|auth|bearer|password|seed|mnemonic|credential|(^|[_-])token($|[_-])|access_?token|refresh_?token|session_?token/i;
const SAFE_ENTITY_DATA_KEYS = new Set([
  'id',
  'agentId',
  'agent_id',
  'internalId',
  'internal_id',
  'name',
  'alias',
  'team',
  'runtime',
  'model',
  'status',
  'port',
  'pid',
  'domain',
  'tokenId',
  'token_id',
  'skillmesh_address',
  'skillmesh_key_index',
  'skillmesh_key_path',
  'ows_wallet',
  'ows_address',
  'wallet_address',
  'skills',
]);

function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function clampInt(value, fallback, min, max) {
  // Absent query params arrive as null/undefined/''; Number() coerces those to 0
  // (finite), which would silently clamp to `min` instead of using the fallback.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function authorizeGraphApp({ req, res, path }) {
  const required = requiredRequestToken(path);
  if (!required) return false;
  if (requestHasValidBearer(req, required)) return false;
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Bearer realm="brain-graph-app"',
  });
  res.end('Unauthorized - provide an Authorization: Bearer header\n');
  return true;
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function normalizeKind(searchParams, fallback = 'all') {
  const kind = String(searchParams.get('kind') ?? fallback).toLowerCase();
  return GRAPH_APP_KINDS.has(kind) ? kind : 'all';
}

function filterList(value, { maxItems = 16, maxLength = 80 } = {}) {
  return [...new Set(String(value ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => (
      item
      && item.length <= maxLength
      && !/[\u0000-\u001f\u007f"\\]/u.test(item)
    )))]
    .slice(0, maxItems);
}

function normalizeView(searchParams) {
  const view = String(searchParams.get('view') ?? 'overview').trim().toLowerCase();
  return Object.hasOwn(GRAPH_APP_VIEWS, view) ? view : 'overview';
}

function normalizeTagMode(searchParams) {
  const mode = String(searchParams.get('tag_mode') ?? searchParams.get('tagMode') ?? 'any').toLowerCase();
  return GRAPH_APP_TAG_MODE.has(mode) ? mode : 'any';
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function appendTagConditions(conditions, params, column, tags, tagMode) {
  if (!tags.length) return;
  const clauses = tags.map(tag => {
    params.push(`%"${escapeLike(tag)}"%`);
    return `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`;
  });
  conditions.push(`(${clauses.join(tagMode === 'all' ? ' AND ' : ' OR ')})`);
}

function parseTags(value) {
  const tags = parseJson(value, []);
  return Array.isArray(tags) ? tags.map(String) : [];
}

function safeGraphScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .filter(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(item => typeof item === 'string' && item.length > 120 ? item.slice(0, 120) : item)
      .slice(0, 24);
  }
  return null;
}

function sanitizeEntityData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data: {}, redaction: null };
  }
  const safe = {};
  let omitted = 0;
  let sensitive = 0;
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_GRAPH_DATA_KEY_RE.test(key)) {
      sensitive++;
      omitted++;
      continue;
    }
    if (!SAFE_ENTITY_DATA_KEYS.has(key)) {
      omitted++;
      continue;
    }
    const safeValue = safeGraphScalar(value);
    if (safeValue === null) {
      omitted++;
      continue;
    }
    safe[key] = safeValue;
  }
  return {
    data: safe,
    redaction: omitted
      ? {
          rawDataExposed: false,
          omittedFieldCount: omitted,
          sensitiveKeyCount: sensitive,
          policy: 'Graph app returns only public matching/display fields; raw entity data, private keys, auth tokens, wallet secrets, and complex metadata are withheld.',
        }
      : null,
  };
}

function learnBrainSyncCurrent(sync) {
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) return false;
  if (sync.schemaVersion !== GRAPH_APP_LEARN_SYNC_SCHEMA_VERSION || sync.exactEntity !== true) return false;
  if (sync.entity !== true || sync.sourceEntity !== true || sync.facts !== true || sync.edges !== true) return false;
  const expected = Math.max(0, Number(sync.expectedEdgeCount ?? 0) || 0);
  const actual = Math.max(0, Number(sync.edgeCount ?? 0) || 0);
  return expected === 0 || actual >= expected;
}

function learnMaterialPublicData(rawData) {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return {};
  const sync = rawData.brainSync && typeof rawData.brainSync === 'object' && !Array.isArray(rawData.brainSync)
    ? rawData.brainSync
    : null;
  const out = {};
  if (typeof rawData.packetReady === 'boolean') out.packetReady = rawData.packetReady;
  if (!sync) return out;
  const expected = Math.max(0, Number(sync.expectedEdgeCount ?? 0) || 0);
  const actual = Math.max(0, Number(sync.edgeCount ?? 0) || 0);
  out.brainSyncStatus = String(sync.status || '');
  out.brainSyncSchemaVersion = Number(sync.schemaVersion ?? 0) || 0;
  out.brainSyncEdges = `${actual}/${expected}`;
  out.brainSyncCurrent = learnBrainSyncCurrent(sync);
  return out;
}

function entityGroupForRow(row, type, rawData) {
  const entityType = String(type || 'entity').toLowerCase();
  if (entityType === 'agent') {
    const team = String(rawData?.team ?? '').trim();
    return team ? `team:${team}` : 'agent:unscoped';
  }
  if (entityType === 'team') {
    const team = String(rawData?.idacc_team ?? row.name ?? row.id ?? '').replace(/^team:/, '').trim();
    return team ? `team:${team}` : 'team';
  }
  if (entityType === GRAPH_APP_LEARN_MATERIAL_TYPE) {
    const status = String(row.status || rawData?.status || rawData?.brainSync?.status || 'unknown').toLowerCase();
    return `learn:${status || 'unknown'}`;
  }
  return type || 'entity';
}

function agentTeamEntityId(row) {
  const rawData = parseJson(row.data, {});
  const teamId = String(rawData?.teamId ?? '').trim();
  if (teamId) return `team:id:${encodeURIComponent(teamId)}`;
  const team = String(rawData?.team ?? '').trim()
    || (/^agent:([^:]+):/.exec(String(row.id ?? ''))?.[1] ?? '').trim();
  return team ? `team:${team}` : '';
}

function learnMaterialSummary(db) {
  const rows = db.prepare(`
    SELECT status, data
    FROM entities
    WHERE type=?
      AND (status IS NULL OR status != 'merged')
  `).all(GRAPH_APP_LEARN_MATERIAL_TYPE);
  const summary = {
    total: rows.length,
    ready: 0,
    blocked: 0,
    failed: 0,
    removed: 0,
    other: 0,
    brainSynced: 0,
    brainPending: 0,
  };
  for (const row of rows) {
    const status = String(row.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status]++;
    else summary.other++;
    if (status !== 'ready') continue;
    const rawData = parseJson(row.data, {});
    const sync = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData.brainSync : null;
    if (learnBrainSyncCurrent(sync)) summary.brainSynced++;
    else summary.brainPending++;
  }
  return summary;
}

function graphBoolean(searchParams, names, fallback) {
  for (const name of names) {
    const raw = searchParams.get(name);
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  }
  return fallback;
}

function learnMaterialReserve(limit) {
  if (limit <= 0) return 0;
  return Math.min(limit, GRAPH_APP_LEARN_ENTITY_RESERVE_MAX, Math.max(1, Math.ceil(limit * 0.25)));
}

function compareEntityRowsByFreshness(a, b) {
  return (Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))
    || String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id));
}

function skillNodeFromRow(row, { matched = true } = {}) {
  return {
    id: `skill-node:${row.skill_id}`,
    raw_id: String(row.skill_id),
    label: row.name,
    description: row.description ?? '',
    type: 'skill',
    group: row.domain || 'skill',
    tags: parseTags(row.tags),
    useCount: Number(row.use_count ?? 0),
    computeCost: Number(row.compute_cost ?? 0),
    chainable: row.chainable === 1,
    updatedAt: Number(row.updated_at ?? 0),
    source: 'skill_nodes',
    matched,
    neighbor: !matched,
  };
}

function entityNodeFromRow(row, { matched = true } = {}) {
  const isAgent = String(row.type || '').toLowerCase() === 'agent' || String(row.id || '').startsWith('agent:');
  const rawData = parseJson(row.data, {});
  const safeData = sanitizeEntityData(rawData);
  const type = row.type || 'entity';
  const data = type === GRAPH_APP_LEARN_MATERIAL_TYPE
    ? { ...safeData.data, ...learnMaterialPublicData(rawData) }
    : safeData.data;
  return {
    id: `entity:${row.id}`,
    raw_id: String(row.id),
    label: row.name || row.id,
    description: row.description ?? '',
    type,
    group: entityGroupForRow(row, type, rawData),
    tags: parseTags(row.tags),
    data,
    dataRedaction: safeData.redaction,
    status: row.status ?? '',
    statusAuthority: isAgent ? 'brain-entity-cache' : undefined,
    statusAuthorityLabel: isAgent ? 'Brain entity status snapshot; use the IDACC /fleet-report overlay before lifecycle decisions.' : undefined,
    source: row.source ?? '',
    updatedAt: Number(row.updated_at ?? 0),
    matched,
    neighbor: !matched,
  };
}

function entityEdgeProvenanceSummary(row) {
  const stored = parseJson(row.provenance, {});
  const textUnitIds = parseJson(row.text_unit_ids, []);
  const textUnitCount = Array.isArray(textUnitIds) ? textUnitIds.length : 0;
  return {
    method: typeof stored?.method === 'string' ? stored.method : 'asserted',
    source: typeof stored?.source === 'string' ? stored.source : 'manual',
    evidenceCount: Math.max(0, Number(row.evidence_count ?? 0) || 0),
    textUnitCount,
    promptVersion: String(row.prompt_version ?? ''),
  };
}

function buildSkillGraph({ db, q, tags, tagMode, limit, edgeLimit, includeNeighbors }) {
  const like = `%${q}%`;
  const params = [];
  const conditions = [];
  if (q) {
    conditions.push('(name LIKE ? OR description LIKE ? OR domain LIKE ? OR tags LIKE ?)');
    params.push(like, like, like, like);
  }
  appendTagConditions(conditions, params, 'tags', tags, tagMode);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT skill_id, name, description, domain, tags, compute_cost, chainable, use_count, updated_at
    FROM skill_nodes
    ${where}
    ORDER BY use_count DESC, updated_at DESC, skill_id ASC
    LIMIT ?
  `).all(...params, limit);

  const matchIds = rows.map(row => Number(row.skill_id));
  const rowsById = new Map(rows.map(row => [Number(row.skill_id), row]));
  if (includeNeighbors && (q || tags.length) && matchIds.length) {
    const ph = placeholders(matchIds.length);
    const neighborLimit = Math.max(0, limit);
    const neighborRows = db.prepare(`
      SELECT DISTINCT n.skill_id, n.name, n.description, n.domain, n.tags, n.compute_cost, n.chainable, n.use_count, n.updated_at
      FROM skill_nodes n
      JOIN skill_edges e ON (
        (e.from_id IN (${ph}) AND e.to_id = n.skill_id)
        OR (e.to_id IN (${ph}) AND e.from_id = n.skill_id)
      )
      WHERE n.skill_id NOT IN (${ph})
      ORDER BY n.use_count DESC, n.updated_at DESC, n.skill_id ASC
      LIMIT ?
    `).all(...matchIds, ...matchIds, ...matchIds, neighborLimit);
    for (const row of neighborRows) rowsById.set(Number(row.skill_id), row);
  }

  const allRows = [...rowsById.values()];
  const rawIds = allRows.map(row => Number(row.skill_id));
  const rawIdSet = new Set(rawIds);
  const matchIdSet = new Set(matchIds);
  const nodes = allRows.map(row => skillNodeFromRow(row, { matched: matchIdSet.has(Number(row.skill_id)) }));

  let links = [];
  if (rawIds.length) {
    const ph = placeholders(rawIds.length);
    links = db.prepare(`
      SELECT from_id, to_id, kind, weight
      FROM skill_edges
      WHERE from_id IN (${ph}) AND to_id IN (${ph})
      ORDER BY weight DESC, kind ASC
      LIMIT ?
    `).all(...rawIds, ...rawIds, edgeLimit)
      .filter(row => rawIdSet.has(Number(row.from_id)) && rawIdSet.has(Number(row.to_id)))
      .map(row => ({
        id: `skill-edge:${row.from_id}:${row.to_id}:${row.kind}`,
        source: `skill-node:${row.from_id}`,
        target: `skill-node:${row.to_id}`,
        label: row.kind,
        kind: row.kind,
        weight: Number(row.weight ?? 1),
        graph: 'skills',
      }));
  }

  return { nodes, links };
}

function buildEntityGraph({ db, q, types, tags, tagMode, limit, edgeLimit, includeNeighbors, freshnessOptions }) {
  const params = [];
  const conditions = [`(status IS NULL OR status != 'merged')`];
  if (q) {
    const like = `%${q}%`;
    conditions.push('(id LIKE ? OR name LIKE ? OR description LIKE ? OR type LIKE ? OR tags LIKE ? OR data LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  if (types.length) {
    conditions.push(`LOWER(type) IN (${placeholders(types.length)})`);
    params.push(...types);
  }
  appendTagConditions(conditions, params, 'tags', tags, tagMode);
  const rows = db.prepare(`
    SELECT id, type, name, description, source, data, tags, status, updated_at
    FROM entities
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, name ASC
    LIMIT ?
  `).all(...params, limit);

  const matchIds = rows.map(row => String(row.id));
  const rowsById = new Map(rows.map(row => [String(row.id), row]));
  const reservedLearnMaterialIds = new Set();
  if (!q && !types.length && !tags.length && limit > 0) {
    const reserve = learnMaterialReserve(limit);
    const learnRows = db.prepare(`
      SELECT id, type, name, description, source, data, tags, status, updated_at
      FROM entities
      WHERE (status IS NULL OR status != 'merged')
        AND type=?
      ORDER BY updated_at DESC, name ASC
      LIMIT ?
    `).all(GRAPH_APP_LEARN_MATERIAL_TYPE, reserve);
    for (const row of learnRows) {
      reservedLearnMaterialIds.add(String(row.id));
      rowsById.set(String(row.id), row);
    }
  }
  if (includeNeighbors && (q || types.length || tags.length) && matchIds.length) {
    const ph = placeholders(matchIds.length);
    const neighborLimit = Math.max(0, limit);
    const neighborRows = db.prepare(`
      SELECT DISTINCT n.id, n.type, n.name, n.description, n.source, n.data, n.tags, n.status, n.updated_at
      FROM entities n
      JOIN entity_edges e ON (
        (e.from_id IN (${ph}) AND e.to_id = n.id)
        OR (e.to_id IN (${ph}) AND e.from_id = n.id)
      )
      WHERE n.id NOT IN (${ph})
        AND (n.status IS NULL OR n.status != 'merged')
      ORDER BY n.updated_at DESC, n.name ASC
      LIMIT ?
    `).all(...matchIds, ...matchIds, ...matchIds, neighborLimit);
    for (const row of neighborRows) rowsById.set(String(row.id), row);
  }
  let orgAnchorCount = 0;
  if (types.includes('agent') && matchIds.length) {
    const teamIds = [...new Set(rows.map(agentTeamEntityId).filter(Boolean))];
    if (teamIds.length) {
      const ph = placeholders(teamIds.length);
      const teamRows = db.prepare(`
        SELECT id, type, name, description, source, data, tags, status, updated_at
        FROM entities
        WHERE id IN (${ph})
          AND (status IS NULL OR status != 'merged')
      `).all(...teamIds);
      for (const row of teamRows) {
        if (!rowsById.has(String(row.id))) orgAnchorCount++;
        rowsById.set(String(row.id), row);
      }
    }
  }

  let allRows = [...rowsById.values()];
  if (!q && !types.length && !tags.length && allRows.length > limit) {
    allRows = allRows
      .sort((a, b) => {
        const aReserved = reservedLearnMaterialIds.has(String(a.id)) ? 0 : 1;
        const bReserved = reservedLearnMaterialIds.has(String(b.id)) ? 0 : 1;
        return (aReserved - bReserved) || compareEntityRowsByFreshness(a, b);
      })
      .slice(0, limit);
  }
  const rawIds = allRows.map(row => String(row.id));
  const rawIdSet = new Set(rawIds);
  const matchIdSet = new Set(matchIds);
  const nodes = allRows.map(row => entityNodeFromRow(row, { matched: matchIdSet.has(String(row.id)) }));

  let links = [];
  if (rawIds.length) {
    const ph = placeholders(rawIds.length);
    links = db.prepare(`
      SELECT from_id, to_id, kind, weight, confidence, provenance, description, evidence_count, text_unit_ids, prompt_version, updated_at
      FROM entity_edges
      WHERE from_id IN (${ph}) AND to_id IN (${ph})
      ORDER BY weight DESC, evidence_count DESC, updated_at DESC
      LIMIT ?
    `).all(...rawIds, ...rawIds, edgeLimit)
      .filter(row => rawIdSet.has(String(row.from_id)) && rawIdSet.has(String(row.to_id)))
      .map(row => {
        const freshness = classifyEntityEdgeFreshness(row.updated_at, freshnessOptions);
        return {
          id: `entity-edge:${row.from_id}:${row.to_id}:${row.kind}`,
          source: `entity:${row.from_id}`,
          target: `entity:${row.to_id}`,
          label: row.kind,
          // `kind` stays for existing graph clients; `type` is the explicit
          // semantic name for entity-edge relation typing.
          kind: row.kind,
          type: row.kind,
          weight: Number(row.weight ?? 1),
          confidence: Number(row.confidence ?? 0.5),
          description: row.description ?? '',
          evidenceCount: Number(row.evidence_count ?? 0),
          provenance: entityEdgeProvenanceSummary(row),
          updatedAt: Number(row.updated_at ?? 0),
          freshness: {
            classification: freshness.classification,
            ageSeconds: freshness.ageSeconds,
          },
          graph: 'entities',
        };
      });
  }

  return { nodes, links, learnMaterialReserveCount: reservedLearnMaterialIds.size, orgAnchorCount };
}

function buildIdentityBridgeLinks(nodes) {
  const skillIds = new Set();
  const entityIds = new Set();
  for (const node of nodes) {
    if (node.id.startsWith('skill-node:')) skillIds.add(node.raw_id);
    if (node.id.startsWith('entity:')) entityIds.add(node.raw_id);
  }
  return [...skillIds]
    .filter(skillId => entityIds.has(`skill:${skillId}`))
    .map(skillId => ({
      id: `identity-bridge:skill-node:${skillId}:entity:skill:${skillId}:same-as`,
      source: `skill-node:${skillId}`,
      target: `entity:skill:${skillId}`,
      label: 'same-as',
      kind: 'same-as',
      weight: 1,
      graph: 'identity',
      bridge: true,
    }));
}

function addFacetRows(target, rows, key) {
  for (const row of rows) {
    const value = String(row?.[key] ?? '').trim().toLowerCase();
    if (!value) continue;
    target.set(value, (target.get(value) ?? 0) + Math.max(0, Number(row.count ?? 0) || 0));
  }
}

function rankedFacet(map, key, limit = 120) {
  return [...map.entries()]
    .map(([value, count]) => ({ [key]: value, count }))
    .sort((a, b) => (b.count - a.count) || String(a[key]).localeCompare(String(b[key])))
    .slice(0, limit);
}

function graphAppFacets(db, { includeSkills, includeEntities }) {
  const tags = new Map();
  const types = new Map();
  const groups = new Map();
  if (includeSkills) {
    addFacetRows(tags, db.prepare(`
      SELECT LOWER(TRIM(CAST(j.value AS TEXT))) AS tag, COUNT(DISTINCT s.skill_id) AS count
      FROM skill_nodes s,
           json_each(CASE WHEN json_valid(s.tags)
             THEN CASE WHEN json_type(s.tags)='array' THEN s.tags ELSE '[]' END
             ELSE '[]' END) j
      WHERE TRIM(CAST(j.value AS TEXT)) != ''
      GROUP BY LOWER(TRIM(CAST(j.value AS TEXT)))
    `).all(), 'tag');
    addFacetRows(groups, db.prepare(`
      SELECT LOWER(COALESCE(NULLIF(TRIM(domain), ''), 'skill')) AS facet_group, COUNT(*) AS count
      FROM skill_nodes
      GROUP BY LOWER(COALESCE(NULLIF(TRIM(domain), ''), 'skill'))
    `).all(), 'facet_group');
    types.set('skill', Number(db.prepare('SELECT COUNT(*) AS count FROM skill_nodes').get()?.count ?? 0));
  }
  if (includeEntities) {
    addFacetRows(tags, db.prepare(`
      SELECT LOWER(TRIM(CAST(j.value AS TEXT))) AS tag, COUNT(DISTINCT e.id) AS count
      FROM entities e,
           json_each(CASE WHEN json_valid(e.tags)
             THEN CASE WHEN json_type(e.tags)='array' THEN e.tags ELSE '[]' END
             ELSE '[]' END) j
      WHERE (e.status IS NULL OR e.status != 'merged')
        AND TRIM(CAST(j.value AS TEXT)) != ''
      GROUP BY LOWER(TRIM(CAST(j.value AS TEXT)))
    `).all(), 'tag');
    const entityTypes = db.prepare(`
      SELECT LOWER(COALESCE(NULLIF(TRIM(type), ''), 'entity')) AS facet_type, COUNT(*) AS count
      FROM entities
      WHERE status IS NULL OR status != 'merged'
      GROUP BY LOWER(COALESCE(NULLIF(TRIM(type), ''), 'entity'))
    `).all();
    addFacetRows(types, entityTypes, 'facet_type');
    addFacetRows(groups, entityTypes, 'facet_type');
  }
  return {
    tags: rankedFacet(tags, 'tag'),
    types: rankedFacet(types, 'type'),
    groups: rankedFacet(groups, 'group'),
  };
}

export function buildGraphAppPayload({ db, searchParams } = {}) {
  const view = normalizeView(searchParams);
  const preset = GRAPH_APP_VIEWS[view];
  const kind = normalizeKind(searchParams, preset.kind);
  const q = String(searchParams.get('q') ?? '').trim().slice(0, 160);
  const explicitTypes = searchParams.has('types') || searchParams.has('type');
  const types = explicitTypes
    ? filterList(searchParams.get('types') ?? searchParams.get('type'))
    : [...preset.types];
  const tags = filterList(searchParams.get('tags'), { maxItems: 12, maxLength: 64 });
  const tagMode = normalizeTagMode(searchParams);
  const limit = clampInt(searchParams.get('limit'), GRAPH_APP_NODE_LIMIT_DEFAULT, 1, GRAPH_APP_NODE_LIMIT_MAX);
  const edgeLimit = clampInt(searchParams.get('edge_limit') ?? searchParams.get('edgeLimit'), GRAPH_APP_EDGE_LIMIT_DEFAULT, 0, GRAPH_APP_EDGE_LIMIT_MAX);
  const includeNeighbors = graphBoolean(searchParams, ['neighbors', 'include_neighbors', 'includeNeighbors'], true);
  const includeSkills = kind === 'all' || kind === 'skills';
  const includeEntities = kind === 'all' || kind === 'entities';
  const nodeLimitPerGraph = kind === 'all' ? Math.max(1, Math.ceil(limit / 2)) : limit;
  const edgeLimitPerGraph = kind === 'all' ? Math.max(0, Math.ceil(edgeLimit / 2)) : edgeLimit;
  const freshnessThresholds = entityEdgeFreshnessThresholds();
  const freshnessOptions = { nowSeconds: Math.floor(Date.now() / 1000), ...freshnessThresholds };

  const parts = [];
  if (includeSkills) parts.push(buildSkillGraph({ db, q, tags, tagMode, limit: nodeLimitPerGraph, edgeLimit: edgeLimitPerGraph, includeNeighbors }));
  if (includeEntities) parts.push(buildEntityGraph({ db, q, types, tags, tagMode, limit: nodeLimitPerGraph, edgeLimit: edgeLimitPerGraph, includeNeighbors, freshnessOptions }));

  const nodes = parts.flatMap(part => part.nodes);
  const bridgeLinks = includeSkills && includeEntities ? buildIdentityBridgeLinks(nodes) : [];
  const links = [...parts.flatMap(part => part.links), ...bridgeLinks];
  const graphQuality = collectGraphQualityMetrics(db);
  const orphanEntityIds = new Set(graphQuality.details.orphan_node_ids);
  const degreeById = new Map(nodes.map(node => [node.id, 0]));
  for (const link of links) {
    degreeById.set(link.source, (degreeById.get(link.source) ?? 0) + 1);
    degreeById.set(link.target, (degreeById.get(link.target) ?? 0) + 1);
  }
  for (const node of nodes) {
    node.degree = degreeById.get(node.id) ?? 0;
    if (node.id.startsWith('entity:')) node.graphQuality = { orphan: orphanEntityIds.has(node.raw_id) };
  }

  nodes.sort((a, b) => (b.degree - a.degree) || String(a.label).localeCompare(String(b.label)));
  const facets = graphAppFacets(db, { includeSkills, includeEntities });

  return {
    nodes,
    links,
    meta: {
      generatedAt: new Date().toISOString(),
      view,
      views: Object.entries(GRAPH_APP_VIEWS).map(([id, definition]) => ({ id, label: definition.label })),
      kind,
      q,
      type: types.length === 1 ? types[0] : '',
      types,
      tags,
      tagMode,
      facets,
      limit,
      edgeLimit,
      includeNeighbors,
      nodeCount: nodes.length,
      linkCount: links.length,
      identityBridgeCount: bridgeLinks.length,
      learnMaterialReserveCount: parts.reduce((sum, part) => sum + Number(part.learnMaterialReserveCount ?? 0), 0),
      orgAnchorCount: parts.reduce((sum, part) => sum + Number(part.orgAnchorCount ?? 0), 0),
      learnMaterialSummary: learnMaterialSummary(db),
      entityEdgeFreshnessThresholds: freshnessThresholds,
      graphQuality: {
        measuredAt: graphQuality.measured_at,
        computationMs: graphQuality.computation_ms,
        values: graphQuality.values,
        results: graphQuality.results,
        graphTotals: graphQuality.graph_totals,
      },
      graphShape: 'node-link',
      nodeIdPrefix: { skills: 'skill-node:', entities: 'entity:' },
      sourceAuthority: 'idacc-synced-brain-readonly-snapshot',
      sourceAuthorityLabel: 'IDACC-synced Brain read-only snapshot; graph rows come from Brain storage, while agent lifecycle truth comes only from the live /fleet-report overlay when an unambiguous match exists.',
      mutationPolicy: 'read-only-dashboard',
      readRoute: 'GET /graph/app/data',
      idaccAuthority: {
        owner: 'IDACC manager',
        graphRoute: 'GET /graph/app/data',
        lifecycleRoute: 'GET /fleet-report',
        readOnly: true,
        cachePolicy: 'no-store',
        secretPolicy: 'raw entity data, private keys, auth tokens, wallet secrets, and manager metadata are not exposed in graph payloads',
      },
    },
  };
}

let graph3dVendorCache = null;

function graph3dVendorBundle() {
  if (graph3dVendorCache) return graph3dVendorCache;
  graph3dVendorCache = readFileSync(
    new URL('../node_modules/3d-force-graph/dist/3d-force-graph.min.js', import.meta.url),
  );
  return graph3dVendorCache;
}

export async function handleGraphAppRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  db,
  send,
} = {}) {
  if (method !== 'GET') return false;

  if (path === '/graph/app' || path === '/dashboard/graph') {
    if (authorizeGraphApp({ req, res, path })) return true;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
    res.end(GRAPH_APP_HTML);
    return true;
  }

  if (path === '/graph/app/vendor/3d-force-graph.min.js') {
    if (authorizeGraphApp({ req, res, path })) return true;
    try {
      const bundle = graph3dVendorBundle();
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': bundle.length,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(bundle);
    } catch {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('3D renderer unavailable; use the 2D view.\n');
    }
    return true;
  }

  if (path === '/graph/app/data') {
    if (authorizeGraphApp({ req, res, path })) return true;
    const payload = buildGraphAppPayload({ db, searchParams });
    send(res, 200, {
      ok: true,
      data: payload,
      nodes: payload.nodes,
      links: payload.links,
      meta: payload.meta,
      profile: 'local',
    });
    return true;
  }

  if (path === '/graph/quality') {
    if (authorizeGraphApp({ req, res, path })) return true;
    const freshDays = clampInt(searchParams.get('fresh_days') ?? searchParams.get('freshDays'), undefined, 0, 3650);
    const staleDays = clampInt(searchParams.get('stale_days') ?? searchParams.get('staleDays'), undefined, 0, 3650);
    const data = collectGraphQualityMetrics(db, { freshDays, staleDays });
    send(res, 200, { ok: true, data, ...data, profile: 'local' });
    return true;
  }

  return false;
}

export const GRAPH_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brain Graph</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101214;
    --panel: #181b1f;
    --panel-2: #20242a;
    --line: #343a42;
    --text: #e7ecef;
    --muted: #9aa6ad;
    --accent: #59c3a6;
    --warn: #e3b955;
    --danger: #ee6a5f;
  }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body {
    display: grid;
    grid-template-rows: auto 1fr;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    display: grid;
    grid-template-columns: minmax(180px, 0.7fr) minmax(0, 2.3fr);
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    background: #14171a;
  }
  h1 { font-size: 15px; margin: 0; letter-spacing: 0; font-weight: 650; }
  .meta { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .controls {
    display: flex;
    min-width: 0;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  input, select, button, a.button {
    height: 32px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
  }
  input { width: min(34vw, 320px); padding: 0 10px; }
  select { padding: 0 28px 0 8px; }
  button, a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    cursor: pointer;
    text-decoration: none;
  }
  button:hover, a.button:hover, input:focus, select:focus { border-color: var(--accent); outline: none; }
  main {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(260px, 24vw, 340px);
  }
  body.focus-mode main { grid-template-columns: 1fr; }
  body.focus-mode aside { display: none; }
  #stage {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: #0f1113;
  }
  canvas { width: 100%; height: 100%; display: block; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  #graph3d { position: absolute; inset: 0; }
  #graph3d canvas { cursor: move; }
  .renderer-hidden { display: none !important; }
  #status {
    position: absolute;
    left: 12px;
    bottom: 12px;
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgba(16, 18, 20, 0.86);
    color: var(--muted);
    font-size: 12px;
    pointer-events: none;
  }
  #qualityLegend {
    position: absolute;
    top: 12px;
    left: 12px;
    max-width: min(520px, calc(100% - 24px));
    padding: 7px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgba(16, 18, 20, 0.9);
    color: var(--muted);
    font-size: 11px;
    pointer-events: none;
  }
  #qualityLegend b { color: var(--text); font-weight: 600; }
  aside {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto auto 1fr;
    border-left: 1px solid var(--line);
    background: var(--panel);
  }
  .section { padding: 12px; border-bottom: 1px solid var(--line); min-width: 0; }
  .section:last-child { border-bottom: 0; overflow: auto; }
  .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
  #searchResults { max-height: 170px; overflow: auto; }
  #tagFilters { max-height: 180px; overflow: auto; }
  .result, .neighbor {
    display: block;
    width: 100%;
    padding: 5px 7px;
    border-radius: 5px;
    color: var(--text);
    background: transparent;
    border: 0;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .result:hover, .neighbor:hover { background: var(--panel-2); }
  .toggle {
    height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--muted);
    background: var(--panel);
    white-space: nowrap;
  }
  .toggle input { width: auto; min-width: 0; height: auto; margin: 0; accent-color: var(--accent); }
  #details h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.25; letter-spacing: 0; }
  #details p { margin: 0 0 8px; color: var(--muted); }
  .kv { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 6px; margin: 5px 0; }
  .kv b { color: var(--muted); font-weight: 500; }
  .pill {
    display: inline-block;
    max-width: 100%;
    padding: 2px 6px;
    margin: 2px 4px 2px 0;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    margin: 2px 4px 2px 0;
    padding: 0 8px;
    border-radius: 999px;
    color: var(--muted);
    background: transparent;
  }
  .tag-chip.active { color: var(--text); border-color: var(--accent); background: rgba(89, 195, 166, 0.12); }
  .tag-chip small { opacity: 0.7; }
  .empty { color: var(--muted); }
  .error { color: var(--danger); }
  @media (max-width: 1200px) {
    header { grid-template-columns: minmax(170px, 0.55fr) minmax(0, 2.45fr); }
    .controls { gap: 6px; }
    .controls input { width: auto; flex: 1 1 220px; }
  }
  @media (max-width: 800px) {
    body { overflow: auto; }
    header { grid-template-columns: 1fr; }
    .controls { justify-content: flex-start; }
    input { width: 100%; min-width: 180px; }
    main { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 58vh) auto; }
    aside { border-left: 0; border-top: 1px solid var(--line); }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>Brain Graph · Read Only</h1>
    <div class="meta" id="meta">Loading...</div>
    <div class="meta">IDACC-synced Brain view: graph rows are read-only Brain storage, while agent lifecycle, optional provider identity, and capability summaries come from the live /fleet-report overlay when an unambiguous manager row matches.</div>
  </div>
  <div class="controls">
    <input id="query" type="search" placeholder="Search graph" autocomplete="off">
    <select id="renderMode" aria-label="Rendering mode">
      <option value="3d" selected>3D view</option>
      <option value="2d">2D view</option>
    </select>
    <select id="view" aria-label="Graph view">
      <option value="overview">Overview</option>
      <option value="knowledge">Knowledge</option>
      <option value="fleet">Fleet</option>
      <option value="work">Work</option>
      <option value="sources">Sources</option>
      <option value="skills">Skills</option>
    </select>
    <select id="kind" aria-label="Graph">
      <option value="all">All</option>
      <option value="skills">Skills</option>
      <option value="entities">Entities</option>
    </select>
    <select id="type" aria-label="Entity type">
      <option value="">All entity types</option>
      <option value="learn-material">Learn materials</option>
      <option value="source">Sources</option>
      <option value="goal">Goals</option>
      <option value="team">Teams</option>
      <option value="agent">Agents</option>
      <option value="task">Tasks</option>
    </select>
    <select id="limit" aria-label="Limit">
      <option value="160">160</option>
      <option value="260">260</option>
      <option value="500" selected>500</option>
      <option value="1000">1000</option>
      <option value="2000">2000</option>
      <option value="2500">2500</option>
    </select>
    <select id="tagMode" aria-label="Tag matching">
      <option value="any">Any tag</option>
      <option value="all">All tags</option>
    </select>
    <label class="toggle" title="Include one-hop neighbors for filtered graph searches. Off keeps org views direct and lighter."><input id="neighborsToggle" type="checkbox"> Neighbors</label>
    <label class="toggle" title="Color entity edges by confidence, provenance, and freshness; ring globally orphaned entity nodes."><input id="qualityToggle" type="checkbox" checked> Quality</label>
    <button id="fitView" type="button">Fit</button>
    <button id="toggleSidebar" type="button">Focus</button>
    <button id="reload" type="button">Refresh Snapshot</button>
    <button id="popout" type="button">Pop Out</button>
    <a id="jsonLink" class="button" href="/graph/app/data" target="_blank" rel="noreferrer">JSON Snapshot</a>
    <a class="button" href="/dashboard">Dashboard</a>
  </div>
</header>
<main>
  <section id="stage">
    <canvas id="graph"></canvas>
    <div id="graph3d" class="renderer-hidden"></div>
    <div id="qualityLegend">Quality metrics loading...</div>
    <div id="status">Loading graph...</div>
  </section>
  <aside>
    <div class="section">
      <div class="label">Tags · click to filter</div>
      <div id="tagFilters"><span class="empty">Loading tags...</span></div>
    </div>
    <div class="section">
      <div class="label">Matches</div>
      <div id="searchResults"><span class="empty">No matches</span></div>
    </div>
    <div class="section" id="details">
      <div class="label">Selection</div>
      <span class="empty">Select a node</span>
    </div>
    <div class="section">
      <div class="label">Neighbors</div>
      <div id="neighbors"><span class="empty">None</span></div>
    </div>
  </aside>
</main>
<script src="/graph/app/vendor/3d-force-graph.min.js"></script>
<script>
(function () {
  var canvas = document.getElementById('graph');
  var ctx = canvas.getContext('2d');
  var graph3dEl = document.getElementById('graph3d');
  var stage = document.getElementById('stage');
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');
  var queryEl = document.getElementById('query');
  var renderModeEl = document.getElementById('renderMode');
  var viewEl = document.getElementById('view');
  var kindEl = document.getElementById('kind');
  var typeEl = document.getElementById('type');
  var limitEl = document.getElementById('limit');
  var tagModeEl = document.getElementById('tagMode');
  var neighborsToggleEl = document.getElementById('neighborsToggle');
  var qualityToggleEl = document.getElementById('qualityToggle');
  var qualityLegendEl = document.getElementById('qualityLegend');
  var reloadEl = document.getElementById('reload');
  var fitViewEl = document.getElementById('fitView');
  var toggleSidebarEl = document.getElementById('toggleSidebar');
  var popoutEl = document.getElementById('popout');
  var jsonLinkEl = document.getElementById('jsonLink');
  var resultsEl = document.getElementById('searchResults');
  var tagFiltersEl = document.getElementById('tagFilters');
  var detailsEl = document.getElementById('details');
  var neighborsEl = document.getElementById('neighbors');
  var urlParams = new URLSearchParams(window.location.search);
  var palette = ['#59c3a6', '#e3b955', '#8cb4ff', '#d990e8', '#ee6a5f', '#7ed37e', '#e99b63', '#9aa6ad'];
  var graph = { nodes: [], links: [], meta: {} };
  var graph3d = null;
  var graph3dNodesById = new Map();
  var activeTypes = [];
  var activeTags = [];
  var VIEW_PRESETS = {
    overview: { kind: 'all', types: [] },
    knowledge: { kind: 'entities', types: ['entity', 'concept', 'fact', 'memory', 'reference'] },
    fleet: { kind: 'entities', types: ['team', 'agent'] },
    work: { kind: 'entities', types: ['goal', 'task', 'route', 'query', 'tool'] },
    sources: { kind: 'entities', types: ['source', 'document', 'reference', 'repo', 'learn-material'] },
    skills: { kind: 'skills', types: [] }
  };
  var nodesById = new Map();
  var AMBIGUOUS_MATCH = { ambiguous: true };
  var selected = null;
  var graphLoadedAt = 0;
  var fleetOverlayLoadedAt = 0;
  var GRAPH_SNAPSHOT_STALE_MS = 120000;
  var LAYOUT_MAX_FRAMES = 900;
  var LAYOUT_MIN_FRAMES = 120;
  var LAYOUT_PAIRWISE_NODE_LIMIT = 360;
  var LAYOUT_MAX_REPULSION_PAIRS = 45000;
  var LAYOUT_CONTINUOUS_ENTRY_STEP = 0.02;
  var LAYOUT_BURST_FRAMES = 18;
  var LAYOUT_REST_MS = 42;
  var LAYOUT_CONTINUOUS_REST_MS = 66;
  var LAYOUT_WATCHDOG_MS = 1000;
  var LAYOUT_CONTINUOUS_FORCE_SCALE = 0.18;
  var LAYOUT_CONTINUOUS_MIN_STEP = 0.09;
  var LAYOUT_CONTINUOUS_DRIFT_FORCE = 0.034;
  var layoutActive = false;
  var layoutContinuousRelaxation = false;
  var layoutFrames = 0;
  var layoutBurstFrames = 0;
  var layoutLastMaxStep = 0;
  var loadSeq = 0;
  var hovered = null;
  var width = 1;
  var height = 1;
  var dpr = 1;
  var pan = { x: 0, y: 0 };
  var scale = 1;
  var draggingNode = null;
  var draggingCanvas = false;
  var lastPointer = null;
  var initialized = false;
  var renderQueued = false;
  var renderTimer = null;
  var lastFrameAt = 0;

  function setSelectIfValid(el, value) {
    if (!value) return;
    var options = Array.prototype.slice.call(el.options || []);
    if (options.some(function (option) { return option.value === value; })) el.value = value;
  }

  if (urlParams.has('q')) queryEl.value = urlParams.get('q') || '';
  setSelectIfValid(renderModeEl, urlParams.get('render'));
  setSelectIfValid(viewEl, urlParams.get('view'));
  setSelectIfValid(kindEl, urlParams.get('kind'));
  setSelectIfValid(typeEl, urlParams.get('type'));
  setSelectIfValid(tagModeEl, urlParams.get('tag_mode'));
  var initialPreset = VIEW_PRESETS[viewEl.value] || VIEW_PRESETS.overview;
  activeTypes = urlParams.has('types')
    ? String(urlParams.get('types') || '').split(',').map(normalized).filter(Boolean)
    : (typeEl.value ? [typeEl.value] : initialPreset.types.slice());
  activeTags = String(urlParams.get('tags') || '').split(',').map(normalized).filter(Boolean).slice(0, 12);
  if (!urlParams.has('kind')) kindEl.value = initialPreset.kind;
  if (activeTypes.length) kindEl.value = 'entities';
  setSelectIfValid(limitEl, urlParams.get('limit'));
  if (urlParams.has('neighbors')) {
    neighborsToggleEl.checked = !['0', 'false', 'no', 'off'].includes(String(urlParams.get('neighbors') || '').trim().toLowerCase());
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function colorFor(group) {
    var text = String(group || 'default');
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  function normalized(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function rendererIs3d() {
    return renderModeEl.value === '3d' && !!graph3d;
  }

  function linkEndpointId(value) {
    return value && typeof value === 'object' ? value.id : value;
  }

  function linkTouchesSelection(link) {
    if (!selected) return false;
    return linkEndpointId(link.source) === selected.id || linkEndpointId(link.target) === selected.id;
  }

  function graphLinkColor(link) {
    if (linkTouchesSelection(link)) return 'rgba(231,236,239,0.92)';
    if (qualityToggleEl.checked && link.graph === 'entities') {
      var freshness = link.freshness && link.freshness.classification;
      var provenanceCovered = link.provenance && (link.provenance.method || link.provenance.textUnitCount > 0);
      if (freshness === 'stale') return 'rgba(238,106,95,0.7)';
      if (Number(link.confidence || 0) < 0.7) return 'rgba(227,185,85,0.62)';
      if (!provenanceCovered) return 'rgba(217,144,232,0.62)';
      return 'rgba(89,195,166,0.48)';
    }
    return 'rgba(154,166,173,0.22)';
  }

  function graphNodeColor(node) {
    if (selected && selected.id === node.id) return '#ffffff';
    return colorFor(node.group || node.type);
  }

  function graphNodeLabel(node) {
    var tags = Array.isArray(node.tags) && node.tags.length ? ' · #' + node.tags.slice(0, 4).join(' #') : '';
    return '<b>' + escapeHtml(node.label || node.id) + '</b><br><span>' + escapeHtml(node.type || 'node') + escapeHtml(tags) + '</span>';
  }

  function build3dData() {
    var total = Math.max(1, graph.nodes.length);
    var golden = Math.PI * (3 - Math.sqrt(5));
    var nodes = graph.nodes.map(function (node, index) {
      var y = 1 - (index / Math.max(1, total - 1)) * 2;
      var radius = Math.sqrt(Math.max(0, 1 - y * y));
      var angle = golden * index;
      return Object.assign({}, node, {
        x: Math.cos(angle) * radius * 220,
        y: y * 220,
        z: Math.sin(angle) * radius * 220
      });
    });
    var links = graph.links.map(function (link) {
      return Object.assign({}, link, {
        source: linkEndpointId(link.source),
        target: linkEndpointId(link.target)
      });
    });
    graph3dNodesById = new Map(nodes.map(function (node) { return [node.id, node]; }));
    return { nodes: nodes, links: links };
  }

  function refresh3dStyle() {
    if (!graph3d) return;
    graph3d
      .nodeColor(graphNodeColor)
      .nodeVal(function (node) { return Math.max(1.8, Math.min(16, 2 + Math.sqrt(Math.max(0, node.degree || 0)) * 1.7)); })
      .linkColor(graphLinkColor)
      .linkWidth(function (link) { return linkTouchesSelection(link) ? 2.2 : Math.max(0.35, Math.min(1.4, Number(link.weight || 1) * 0.45)); })
      .linkDirectionalParticles(function (link) { return linkTouchesSelection(link) ? 2 : 0; })
      .linkDirectionalParticleWidth(1.8);
  }

  function render3dGraph() {
    if (!graph3d) return;
    var count = graph.nodes.length;
    graph3d
      .nodeResolution(count > 1200 ? 4 : count > 600 ? 6 : 10)
      .linkOpacity(count > 1200 ? 0.16 : 0.26)
      .warmupTicks(count > 1200 ? 8 : count > 600 ? 16 : 28)
      .cooldownTicks(count > 1200 ? 80 : 140)
      .graphData(build3dData());
    refresh3dStyle();
  }

  function ensure3dRenderer() {
    if (graph3d) return true;
    if (typeof window.ForceGraph3D !== 'function') return false;
    try {
      graph3d = window.ForceGraph3D()(graph3dEl)
        .backgroundColor('#0f1113')
        .showNavInfo(false)
        .nodeId('id')
        .nodeLabel(graphNodeLabel)
        .nodeOpacity(0.9)
        .linkSource('source')
        .linkTarget('target')
        .linkDirectionalParticleSpeed(0.006)
        .onNodeHover(function (node) {
          hovered = node ? nodesById.get(node.id) || null : null;
        })
        .onNodeClick(function (node) {
          selectNode(nodesById.get(node.id));
        });
      graph3d.width(width).height(height);
      return true;
    } catch (error) {
      graph3d = null;
      console.warn('3D renderer unavailable; falling back to 2D', error);
      return false;
    }
  }

  function applyRendererMode() {
    if (renderModeEl.value === '3d' && !ensure3dRenderer()) renderModeEl.value = '2d';
    var use3d = rendererIs3d();
    canvas.classList.toggle('renderer-hidden', use3d);
    graph3dEl.classList.toggle('renderer-hidden', !use3d);
    if (use3d) {
      clearQueuedRender();
      graph3d.width(width).height(height);
      render3dGraph();
    } else {
      restartLayout();
    }
    refreshSnapshotAge();
    syncLinks();
  }

  function fitCurrentView() {
    if (rendererIs3d()) {
      graph3d.zoomToFit(650, 72);
      return;
    }
    pan.x = width / 2;
    pan.y = height / 2;
    scale = 1;
    requestRender();
  }

  function isAgentNode(node) {
    return normalized(node.type) === 'agent' || String(node.raw_id || node.id || '').startsWith('agent:');
  }

  function agentNameFromNode(node) {
    var data = node && node.data && typeof node.data === 'object' ? node.data : {};
    if (data.name) return String(data.name).trim();
    var raw = String(node.raw_id || node.id || '');
    if (raw.startsWith('agent:')) {
      try { return decodeURIComponent(raw.slice('agent:'.length)); } catch {}
      return raw.slice('agent:'.length);
    }
    return String(node.label || '').trim();
  }

  function agentTeamFromNode(node) {
    var data = node && node.data && typeof node.data === 'object' ? node.data : {};
    return String(data.team || node.team || '').trim();
  }

  function uniqueSet(map, key, value) {
    if (!key) return;
    var current = map.get(key);
    if (current === AMBIGUOUS_MATCH) return;
    if (current) map.set(key, AMBIGUOUS_MATCH);
    else map.set(key, value);
  }

  function fleetAuthority(fleet) {
    var source = String(fleet && fleet.source || '');
    return fleet && fleet.authority || (source === 'brain-cache' ? 'cache' : source === 'live-manager-partial' ? 'partial' : source === 'live-manager' ? 'live' : 'unknown');
  }

  function buildFleetIndex(agents) {
    var byId = new Map();
    var byTeamName = new Map();
    var byName = new Map();
    agents.forEach(function (agent) {
      if (agent.id) byId.set(String(agent.id), agent);
      var name = normalized(agent.name);
      var team = normalized(agent.team);
      uniqueSet(byName, name, agent);
      uniqueSet(byTeamName, team && name ? team + '/' + name : '', agent);
    });
    return { byId: byId, byTeamName: byTeamName, byName: byName };
  }

  async function fetchFleetOverlay() {
    try {
      var response = await fetch('/fleet-report', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      return { error: error.message, fleet: null };
    }
  }

  function liveFleetMatch(node, index) {
    var data = node && node.data && typeof node.data === 'object' ? node.data : {};
    var internalId = String(data.internalId || data.agentId || data.id || '').trim();
    if (internalId && index.byId.has(internalId)) return { agent: index.byId.get(internalId), method: 'internal id' };
    var name = normalized(agentNameFromNode(node));
    var team = normalized(agentTeamFromNode(node));
    var teamMatch = team && name ? index.byTeamName.get(team + '/' + name) : null;
    if (teamMatch === AMBIGUOUS_MATCH) return { ambiguous: true, method: 'team/name' };
    if (teamMatch) return { agent: teamMatch, method: 'team/name' };
    var nameMatch = index.byName.get(name);
    if (nameMatch === AMBIGUOUS_MATCH) return { ambiguous: true, method: 'name' };
    if (nameMatch) return { agent: nameMatch, method: 'unique name' };
    return null;
  }

  function applyFleetOverlay(report) {
    fleetOverlayLoadedAt = Date.now();
    var agentNodes = graph.nodes.filter(isAgentNode);
    var summary = {
      source: report && report.fleet && report.fleet.source || 'unavailable',
      authority: fleetAuthority(report && report.fleet),
      agentNodes: agentNodes.length,
      matched: 0,
      ambiguous: 0,
      unmatched: 0,
      status: 'unavailable',
      generatedAt: report && report.generatedAt || null,
      loadedAt: fleetOverlayLoadedAt
    };
    graph.meta.fleetOverlay = summary;
    if (!agentNodes.length) return;
    var fleet = report && report.fleet || null;
    var agents = Array.isArray(fleet && fleet.agents) ? fleet.agents : [];
    if (!fleet || !agents.length) {
      agentNodes.forEach(function (node) {
        node.fleetStatusAuthority = 'fleet-unavailable';
        node.fleetStatusAuthorityLabel = 'Live Fleet overlay unavailable; use Fleet or Agents before lifecycle decisions.';
      });
      summary.unmatched = agentNodes.length;
      return;
    }
    if (summary.authority !== 'live' && summary.authority !== 'partial') {
      summary.status = summary.authority === 'cache' ? 'cache-only' : 'non-authoritative';
      summary.unmatched = agentNodes.length;
      agentNodes.forEach(function (node) {
        node.fleetStatusAuthority = 'fleet-cache-only';
        node.fleetStatusAuthorityLabel = 'Fleet report is not live authority; graph keeps Brain entity status only.';
      });
      return;
    }
    summary.status = summary.authority;
    var index = buildFleetIndex(agents);
    agentNodes.forEach(function (node) {
      var match = liveFleetMatch(node, index);
      if (!match) {
        summary.unmatched += 1;
        node.fleetStatusAuthority = 'unmatched-live-fleet';
        node.fleetStatusAuthorityLabel = 'No unambiguous live Fleet row matched this graph agent; Brain entity status was not overwritten.';
        return;
      }
      if (match.ambiguous) {
        summary.ambiguous += 1;
        node.fleetStatusAuthority = 'ambiguous-live-fleet-match';
        node.fleetStatusAuthorityLabel = 'Multiple live Fleet rows matched by ' + match.method + '; Brain entity status was not overwritten.';
        return;
      }
      var agent = match.agent;
      var liveStatus = agent.status || '-';
      var liveStatusNorm = String(liveStatus).toLowerCase();
      var healthLabel = liveStatusNorm === 'online' || liveStatusNorm === 'ok';
      summary.matched += 1;
      node.liveFleetStatus = liveStatus;
      node.liveFleetStatusLabel = healthLabel ? 'health label: ' + liveStatus : liveStatus;
      node.liveFleetRunningProof = liveStatusNorm === 'running' && summary.authority === 'live';
      node.liveFleetTeam = agent.team || '-';
      node.liveFleetRuntime = agent.runtime || '-';
      node.liveFleetModel = agent.model || '-';
      node.liveFleetId = agent.id || '';
      node.liveFleetSkillmesh = agent.skillmesh && agent.skillmesh.address || '';
      node.liveFleetSkillCount = agent.capabilities && agent.capabilities.skillCount || 0;
      node.fleetStatusAuthority = summary.authority === 'live' ? 'live-manager' : 'live-manager-partial';
      node.fleetStatusAuthorityLabel = 'Matched by ' + match.method + ' against the IDACC ' + (summary.authority === 'live' ? 'live manager' : 'partial manager') + ' Fleet snapshot; Brain entity status remains separate. Only exact running is process-running proof; online/ok are health labels.';
    });
  }

  function fleetOverlayMetaText() {
    var overlay = graph.meta && graph.meta.fleetOverlay;
    if (!overlay || !overlay.agentNodes) return '';
    if (overlay.status === 'unavailable') return ' · Fleet overlay unavailable';
    return ' · Fleet overlay ' + overlay.matched + '/' + overlay.agentNodes + ' matched from ' + overlay.source + (overlay.ambiguous ? ', ' + overlay.ambiguous + ' ambiguous' : '');
  }

  function snapshotAgeText() {
    if (!graphLoadedAt) return '';
    var ageMs = Date.now() - graphLoadedAt;
    var ageSec = Math.max(0, Math.floor(ageMs / 1000));
    var ageText = ageSec < 120 ? ageSec + 's old' : Math.floor(ageSec / 60) + 'm old';
    return 'Snapshot ' + ageText + (ageMs > GRAPH_SNAPSHOT_STALE_MS ? ' · refresh before routing, identity, or lifecycle decisions' : '');
  }

  function learnMaterialMetaText() {
    var summary = graph.meta && graph.meta.learnMaterialSummary;
    if (!summary || !summary.total) return '';
    var text = ' · Learn ' + (summary.brainSynced || 0) + '/' + (summary.ready || 0) + ' ready synced';
    if (summary.brainPending) text += ', ' + summary.brainPending + ' pending';
    if (summary.blocked) text += ', ' + summary.blocked + ' blocked';
    return text;
  }

  function fleetOverlayAgeText() {
    if (!fleetOverlayLoadedAt || !(graph.meta && graph.meta.fleetOverlay)) return '';
    var ageMs = Date.now() - fleetOverlayLoadedAt;
    var ageSec = Math.max(0, Math.floor(ageMs / 1000));
    var ageText = ageSec < 120 ? ageSec + 's old' : Math.floor(ageSec / 60) + 'm old';
    return ' · Fleet overlay ' + ageText + (ageMs > GRAPH_SNAPSHOT_STALE_MS ? ' · refresh before lifecycle decisions' : '');
  }

  function snapshotIsStale() {
    return !!graphLoadedAt && (Date.now() - graphLoadedAt) > GRAPH_SNAPSHOT_STALE_MS;
  }

  function confirmFreshSnapshotAction(action) {
    if (!snapshotIsStale()) return true;
    return confirm('Graph snapshot is stale. Refresh Snapshot before ' + action + ' if this will inform routing, identity, or lifecycle decisions. Continue with the stale snapshot?');
  }

  function refreshSnapshotAge() {
    if (!graphLoadedAt || !graph.nodes.length) return;
    var text = statusText();
    statusEl.textContent = text;
  }

  function layoutStatusText() {
    if (!graph.nodes.length) return '';
    if (layoutContinuousRelaxation) return ' · layout continuously relaxing';
    var budget = Math.max(1, layoutFrameBudget());
    var percent = Math.max(1, Math.min(99, Math.floor((layoutFrames / budget) * 100)));
    return ' · layout relaxing ' + percent + '%';
  }

  function statusText() {
    var controls = rendererIs3d() ? 'Drag to orbit, scroll to zoom' : 'Drag to pan, scroll to zoom';
    return controls + ' · read-only Brain graph snapshot · ' + snapshotAgeText() + fleetOverlayAgeText() + (rendererIs3d() ? '' : layoutStatusText());
  }

  function renderGraphChrome() {
    var filterText = graph.meta.types && graph.meta.types.length ? ' · types ' + graph.meta.types.join(', ') : '';
    if (graph.meta.tags && graph.meta.tags.length) filterText += ' · tags ' + graph.meta.tags.map(function (tag) { return '#' + tag; }).join(' ');
    metaEl.textContent = graph.meta.nodeCount + ' nodes, ' + graph.meta.linkCount + ' links · ' + (graph.meta.view || 'overview') + ' · ' + graph.meta.kind + filterText + ' · ' + new Date(graph.meta.generatedAt).toLocaleTimeString() + learnMaterialMetaText() + ' · ' + (graph.meta.sourceAuthorityLabel || graph.meta.sourceAuthority || 'read-only') + fleetOverlayMetaText();
    statusEl.textContent = graph.nodes.length ? statusText() : 'No graph rows';
  }

  function resize() {
    var rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (graph3d) graph3d.width(width).height(height);
    if (!initialized) {
      pan.x = width / 2;
      pan.y = height / 2;
    }
    if (initialized) requestRender();
  }

  function worldFromEvent(event) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - pan.x) / scale,
      y: (event.clientY - rect.top - pan.y) / scale
    };
  }

  function screenPoint(node) {
    return { x: node.x * scale + pan.x, y: node.y * scale + pan.y };
  }

  function setInitialPositions() {
    if (!graph.nodes.length) {
      layoutActive = false;
      layoutContinuousRelaxation = false;
      pan.x = width / 2;
      pan.y = height / 2;
      scale = 1;
      initialized = true;
      requestRender();
      return;
    }
    var n = graph.nodes.length || 1;
    var radius = Math.max(90, Math.min(width, height) * 0.32);
    graph.nodes.forEach(function (node, index) {
      var angle = (Math.PI * 2 * index) / n;
      var ring = radius * (0.55 + ((index % 5) * 0.1));
      node.x = Math.cos(angle) * ring;
      node.y = Math.sin(angle) * ring;
      node.vx = 0;
      node.vy = 0;
      node.layoutPhase = (index * 2.399963229728653) % (Math.PI * 2);
      node.color = colorFor(node.group || node.type);
      node.radius = Math.max(5, Math.min(18, 5 + Math.sqrt(Math.max(0, node.degree || 0)) * 2.2));
    });
    pan.x = width / 2;
    pan.y = height / 2;
    scale = 1;
    initialized = true;
    restartLayout();
  }

  function restartLayout() {
    layoutActive = true;
    layoutContinuousRelaxation = false;
    layoutFrames = 0;
    layoutBurstFrames = 0;
    layoutLastMaxStep = 0;
    clearQueuedRender();
    requestRender();
  }

  function clearQueuedRender() {
    if (renderTimer) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderQueued = false;
  }

  function wakeLayout() {
    if (!graph.nodes.length) return;
    layoutActive = true;
    layoutBurstFrames = 0;
    clearQueuedRender();
    requestRender();
  }

  function layoutWatchdog() {
    refreshSnapshotAge();
    if (document.hidden || !graph.nodes.length) return;
    var frameAge = lastFrameAt ? Date.now() - lastFrameAt : Infinity;
    if (!layoutActive || frameAge > LAYOUT_WATCHDOG_MS) wakeLayout();
  }

  function requestRender(delayMs) {
    if (rendererIs3d()) {
      clearQueuedRender();
      return;
    }
    if (document.hidden) {
      clearQueuedRender();
      return;
    }
    if ((!delayMs || delayMs <= 0) && renderTimer) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
      renderQueued = false;
    }
    if (renderQueued) return;
    renderQueued = true;
    if (delayMs && delayMs > 0) {
      renderTimer = window.setTimeout(function () {
        renderTimer = null;
        requestAnimationFrame(animate);
      }, delayMs);
      return;
    }
    requestAnimationFrame(animate);
  }

  function graphSizeClass() {
    var count = graph.nodes.length;
    if (count > 700) return 'huge';
    if (count > 520) return 'large';
    if (count > LAYOUT_PAIRWISE_NODE_LIMIT) return 'medium-large';
    return 'normal';
  }

  function layoutFrameBudget() {
    var size = graphSizeClass();
    if (size === 'huge') return LAYOUT_MAX_FRAMES;
    if (size === 'large') return Math.floor(LAYOUT_MAX_FRAMES * 0.84);
    if (size === 'medium-large') return Math.floor(LAYOUT_MAX_FRAMES * 0.68);
    return LAYOUT_MAX_FRAMES;
  }

  function layoutMinimumFrames() {
    var size = graphSizeClass();
    if (size === 'huge') return Math.floor(LAYOUT_MIN_FRAMES * 2.3);
    if (size === 'large') return Math.floor(LAYOUT_MIN_FRAMES * 1.9);
    if (size === 'medium-large') return Math.floor(LAYOUT_MIN_FRAMES * 1.5);
    return LAYOUT_MIN_FRAMES;
  }

  function layoutFrameDelay() {
    if (layoutContinuousRelaxation) return LAYOUT_CONTINUOUS_REST_MS;
    if (graph.nodes.length <= LAYOUT_PAIRWISE_NODE_LIMIT) return 0;
    layoutBurstFrames += 1;
    if (layoutBurstFrames < LAYOUT_BURST_FRAMES) return 0;
    layoutBurstFrames = 0;
    return LAYOUT_REST_MS;
  }

  function applyRepulsion(a, b, repel, forceScale) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var dist2 = dx * dx + dy * dy + 0.01;
    var force = Math.min(2.8, repel / dist2) * forceScale;
    var dist = Math.sqrt(dist2);
    var fx = (dx / dist) * force;
    var fy = (dy / dist) * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }

  function stepPairwiseRepulsion(nodes, repel) {
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      for (var j = i + 1; j < nodes.length; j++) {
        applyRepulsion(a, nodes[j], repel, 1);
      }
    }
  }

  function stepSampledRepulsion(nodes, repel, forceMultiplier) {
    var sampleCount = Math.max(8, Math.min(nodes.length - 1, Math.floor(LAYOUT_MAX_REPULSION_PAIRS / Math.max(1, nodes.length))));
    var forceScale = Math.min(2.4, Math.max(1, ((nodes.length - 1) / Math.max(1, sampleCount)) * 0.32));
    var span = nodes.length - 1;
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      for (var sample = 1; sample <= sampleCount; sample++) {
        var offset = Math.max(1, Math.floor((sample * span) / sampleCount));
        var j = (i + offset) % nodes.length;
        if (j !== i) applyRepulsion(a, nodes[j], repel, forceScale * forceMultiplier);
      }
    }
  }

  function stepLayout() {
    var nodes = graph.nodes;
    var links = graph.links;
    if (!nodes.length) return 0;
    var maxStep = 0;
    var forceMultiplier = layoutContinuousRelaxation ? LAYOUT_CONTINUOUS_FORCE_SCALE : 1;
    var repel = nodes.length > 700 ? 4200 : nodes.length > 420 ? 3400 : 5200;
    if (nodes.length > LAYOUT_PAIRWISE_NODE_LIMIT || layoutContinuousRelaxation) stepSampledRepulsion(nodes, repel, forceMultiplier);
    else stepPairwiseRepulsion(nodes, repel);
    links.forEach(function (link) {
      var source = nodesById.get(link.source);
      var target = nodesById.get(link.target);
      if (!source || !target) return;
      var dx = target.x - source.x;
      var dy = target.y - source.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var desired = (nodes.length > 520 ? 118 : nodes.length > LAYOUT_PAIRWISE_NODE_LIMIT ? 104 : 90) + Math.max(0, 8 - Number(link.weight || 1)) * 4;
      var force = (dist - desired) * 0.006 * Math.max(0.25, Math.min(1.5, Number(link.weight || 1))) * forceMultiplier;
      var fx = (dx / dist) * force;
      var fy = (dy / dist) * force;
      if (!source.fixed) { source.vx += fx; source.vy += fy; }
      if (!target.fixed) { target.vx -= fx; target.vy -= fy; }
    });
    nodes.forEach(function (node, index) {
      if (node.fixed) return;
      if (layoutContinuousRelaxation) {
        var phase = layoutFrames * 0.045 + (node.layoutPhase || index * 0.37);
        node.vx += Math.cos(phase) * LAYOUT_CONTINUOUS_DRIFT_FORCE;
        node.vy += Math.sin(phase * 0.91) * LAYOUT_CONTINUOUS_DRIFT_FORCE;
      }
      node.vx += -node.x * 0.0008 * forceMultiplier;
      node.vy += -node.y * 0.0008 * forceMultiplier;
      node.vx *= layoutContinuousRelaxation ? 0.74 : 0.82;
      node.vy *= layoutContinuousRelaxation ? 0.74 : 0.82;
      var maxDelta = layoutContinuousRelaxation ? 0.7 : 6;
      var dx = Math.max(-maxDelta, Math.min(maxDelta, node.vx));
      var dy = Math.max(-maxDelta, Math.min(maxDelta, node.vy));
      if (layoutContinuousRelaxation && Math.abs(dx) < LAYOUT_CONTINUOUS_MIN_STEP && Math.abs(dy) < LAYOUT_CONTINUOUS_MIN_STEP) {
        var driftPhase = layoutFrames * 0.035 + (node.layoutPhase || index * 0.37);
        dx += Math.cos(driftPhase) * LAYOUT_CONTINUOUS_MIN_STEP;
        dy += Math.sin(driftPhase) * LAYOUT_CONTINUOUS_MIN_STEP;
      }
      node.x += dx;
      node.y += dy;
      maxStep = Math.max(maxStep, Math.abs(dx), Math.abs(dy));
    });
    return maxStep;
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    graph.links.forEach(function (link) {
      var source = nodesById.get(link.source);
      var target = nodesById.get(link.target);
      if (!source || !target) return;
      var active = selected && (link.source === selected.id || link.target === selected.id);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      var qualityColor = null;
      if (qualityToggleEl.checked && link.graph === 'entities') {
        var freshness = link.freshness && link.freshness.classification;
        var provenanceCovered = link.provenance && (link.provenance.method || link.provenance.textUnitCount > 0);
        qualityColor = freshness === 'stale' ? 'rgba(238,106,95,0.78)' :
          Number(link.confidence || 0) < 0.7 ? 'rgba(227,185,85,0.72)' :
          !provenanceCovered ? 'rgba(217,144,232,0.72)' :
          'rgba(89,195,166,0.58)';
      }
      ctx.strokeStyle = active ? 'rgba(231,236,239,0.86)' : qualityColor || 'rgba(154,166,173,0.22)';
      ctx.lineWidth = active ? 1.8 / scale : 0.9 / scale;
      ctx.stroke();
    });
    graph.nodes.forEach(function (node) {
      var isSelected = selected && selected.id === node.id;
      var isHovered = hovered && hovered.id === node.id;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.globalAlpha = isSelected || isHovered ? 1 : 0.88;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = (isSelected ? 3 : isHovered ? 2 : 1) / scale;
      ctx.strokeStyle = isSelected ? '#ffffff' : isHovered ? '#e3b955' : 'rgba(255,255,255,0.28)';
      ctx.stroke();
      if (qualityToggleEl.checked && node.graphQuality && node.graphQuality.orphan) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 4 / scale, 0, Math.PI * 2);
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = 'rgba(238,106,95,0.95)';
        ctx.stroke();
      }
    });
    var labelThreshold = graph.nodes.length < 70 ? 0 : graph.nodes.length < 220 ? 4 : graph.nodes.length < 520 ? 10 : 18;
    graph.nodes.forEach(function (node) {
      var show = (node.degree || 0) >= labelThreshold || (selected && selected.id === node.id) || (hovered && hovered.id === node.id);
      if (!show) return;
      ctx.font = (selected && selected.id === node.id ? '12px' : '11px') + ' -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      ctx.fillStyle = 'rgba(231,236,239,0.92)';
      ctx.textAlign = 'center';
      ctx.fillText(String(node.label || node.id).slice(0, 32), node.x, node.y - node.radius - 6);
    });
    ctx.restore();
  }

  function animate() {
    renderQueued = false;
    if (document.hidden) return;
    lastFrameAt = Date.now();
    if (graph.nodes.length && !layoutActive) layoutActive = true;
    if (layoutActive) {
      var maxStep = stepLayout();
      layoutLastMaxStep = maxStep;
      layoutFrames += 1;
      if (!layoutContinuousRelaxation && (layoutFrames > layoutFrameBudget() || (layoutFrames >= layoutMinimumFrames() && maxStep < LAYOUT_CONTINUOUS_ENTRY_STEP))) {
        layoutContinuousRelaxation = true;
        layoutBurstFrames = 0;
        refreshSnapshotAge();
      } else if (layoutFrames % (layoutContinuousRelaxation ? 90 : 30) === 0) {
        refreshSnapshotAge();
      }
    }
    draw();
    if (graph.nodes.length) requestRender(layoutFrameDelay());
  }

  function selectNode(node) {
    selected = node || null;
    renderDetails();
    renderNeighbors();
    if (rendererIs3d()) {
      refresh3dStyle();
      var node3d = selected && graph3dNodesById.get(selected.id);
      if (node3d && Number.isFinite(node3d.x) && Number.isFinite(node3d.y) && Number.isFinite(node3d.z)) {
        var distance = Math.hypot(node3d.x, node3d.y, node3d.z) || 1;
        var ratio = 1 + 90 / distance;
        graph3d.cameraPosition(
          { x: node3d.x * ratio, y: node3d.y * ratio, z: node3d.z * ratio },
          node3d,
          700,
        );
      }
    } else {
      requestRender();
    }
    if (selected && !rendererIs3d()) {
      var pt = screenPoint(selected);
      if (pt.x < 40 || pt.x > width - 40 || pt.y < 40 || pt.y > height - 40) {
        pan.x = width / 2 - selected.x * scale;
        pan.y = height / 2 - selected.y * scale;
      }
    }
  }

  function nearestNode(event) {
    var world = worldFromEvent(event);
    var best = null;
    var bestDist = Infinity;
    graph.nodes.forEach(function (node) {
      var dx = node.x - world.x;
      var dy = node.y - world.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var threshold = Math.max(12, node.radius + 5 / scale);
      if (dist < threshold && dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    });
    return best;
  }

  function renderSearchResults() {
    var q = queryEl.value.trim().toLowerCase();
    var matches = graph.nodes
      .filter(function (node) {
        if (!q) return false;
        return String(node.label || '').toLowerCase().includes(q) ||
          String(node.raw_id || node.id).toLowerCase().includes(q) ||
          String(node.description || '').toLowerCase().includes(q) ||
          String(node.type || '').toLowerCase().includes(q) ||
          (Array.isArray(node.tags) && node.tags.some(function (tag) { return normalized(tag).includes(q); }));
      })
      .slice(0, 40);
    if (!matches.length) {
      resultsEl.innerHTML = '<span class="empty">No matches</span>';
      return;
    }
    resultsEl.innerHTML = matches.map(function (node) {
      return '<button class="result" data-id="' + escapeHtml(node.id) + '">' +
        escapeHtml(node.label || node.id) +
        ' <span class="empty">' + escapeHtml(node.type || '') + '</span></button>';
    }).join('');
  }

  function renderTagFilters() {
    var facets = graph.meta && graph.meta.facets && Array.isArray(graph.meta.facets.tags)
      ? graph.meta.facets.tags
      : [];
    var counts = new Map(facets.map(function (row) { return [normalized(row.tag), Number(row.count || 0)]; }));
    var ordered = activeTags.concat(facets.map(function (row) { return normalized(row.tag); }))
      .filter(function (tag, index, all) { return tag && all.indexOf(tag) === index; })
      .slice(0, 80);
    if (!ordered.length) {
      tagFiltersEl.innerHTML = '<span class="empty">No tags in this view</span>';
      return;
    }
    tagFiltersEl.innerHTML = ordered.map(function (tag) {
      var active = activeTags.includes(tag);
      return '<button class="tag-chip' + (active ? ' active' : '') + '" type="button" data-tag="' + escapeHtml(tag) + '" aria-pressed="' + (active ? 'true' : 'false') + '">#' + escapeHtml(tag) + '<small>' + escapeHtml(counts.get(tag) || '') + '</small></button>';
    }).join('');
  }

  function renderDetails() {
    if (!selected) {
      detailsEl.innerHTML = '<div class="label">Selection</div><span class="empty">Select a node</span>';
      return;
    }
    var tags = Array.isArray(selected.tags) ? selected.tags : [];
    detailsEl.innerHTML =
      '<div class="label">Selection</div>' +
      '<h2>' + escapeHtml(selected.label || selected.id) + '</h2>' +
      '<p>' + escapeHtml(selected.description || selected.raw_id || selected.id) + '</p>' +
      '<div class="kv"><b>Type</b><span>' + escapeHtml(selected.type || '-') + '</span></div>' +
      '<div class="kv"><b>Group</b><span>' + escapeHtml(selected.group || '-') + '</span></div>' +
      '<div class="kv"><b>Degree</b><span>' + escapeHtml(selected.degree || 0) + '</span></div>' +
      '<div class="kv"><b>Source</b><span>' + escapeHtml(selected.source || '-') + '</span></div>' +
      (selected.status ? '<div class="kv"><b>Status</b><span>' + escapeHtml(selected.status) + '</span></div>' : '') +
      (selected.data && selected.data.brainSyncStatus ? '<div class="kv"><b>Brain sync</b><span>' + escapeHtml(selected.data.brainSyncStatus) + ' · edges ' + escapeHtml(selected.data.brainSyncEdges || '-') + ' · current ' + escapeHtml(selected.data.brainSyncCurrent ? 'yes' : 'no') + '</span></div>' : '') +
      (selected.statusAuthorityLabel ? '<div class="kv"><b>Status auth</b><span>' + escapeHtml(selected.statusAuthorityLabel) + '</span></div>' : '') +
      (selected.liveFleetStatus ? '<div class="kv"><b>Fleet</b><span>' + escapeHtml(selected.liveFleetStatusLabel || selected.liveFleetStatus) + ' · ' + escapeHtml(selected.liveFleetTeam || '-') + ' · ' + escapeHtml(selected.liveFleetRuntime || '-') + ' · ' + escapeHtml(selected.liveFleetModel || '-') + '</span></div>' : '') +
      (selected.liveFleetSkillmesh ? '<div class="kv"><b>Optional provider</b><span>' + escapeHtml(selected.liveFleetSkillmesh) + ' · skills ' + escapeHtml(selected.liveFleetSkillCount || 0) + ' · secrets redacted</span></div>' : '') +
      (selected.fleetStatusAuthorityLabel ? '<div class="kv"><b>Fleet auth</b><span>' + escapeHtml(selected.fleetStatusAuthorityLabel) + '</span></div>' : '') +
      (selected.dataRedaction ? '<div class="kv"><b>Data auth</b><span>' + escapeHtml(selected.dataRedaction.policy) + '</span></div>' : '') +
      (tags.length ? '<div class="kv"><b>Tags</b><span>' + tags.slice(0, 10).map(function (tag) { return '<span class="pill">' + escapeHtml(tag) + '</span>'; }).join('') + '</span></div>' : '');
  }

  function renderNeighbors() {
    if (!selected) {
      neighborsEl.innerHTML = '<span class="empty">None</span>';
      return;
    }
    var related = [];
    graph.links.forEach(function (link) {
      var otherId = null;
      if (link.source === selected.id) otherId = link.target;
      if (link.target === selected.id) otherId = link.source;
      if (!otherId) return;
      var other = nodesById.get(otherId);
      if (other) related.push({ node: other, link: link });
    });
    related.sort(function (a, b) { return (b.node.degree || 0) - (a.node.degree || 0); });
    if (!related.length) {
      neighborsEl.innerHTML = '<span class="empty">None</span>';
      return;
    }
    neighborsEl.innerHTML = related.slice(0, 60).map(function (item) {
      return '<button class="neighbor" data-id="' + escapeHtml(item.node.id) + '">' +
        escapeHtml(item.node.label || item.node.id) +
        ' <span class="empty">' + escapeHtml(item.link.kind || '') + '</span></button>';
    }).join('');
  }

  function graphParams() {
    var params = new URLSearchParams();
    params.set('view', viewEl.value);
    params.set('render', renderModeEl.value);
    params.set('kind', activeTypes.length || typeEl.value ? 'entities' : kindEl.value);
    params.set('limit', limitEl.value);
    params.set('neighbors', neighborsToggleEl.checked ? '1' : '0');
    params.set('tag_mode', tagModeEl.value);
    if (activeTypes.length) params.set('types', activeTypes.join(','));
    else if (typeEl.value) params.set('type', typeEl.value);
    if (activeTags.length) params.set('tags', activeTags.join(','));
    if (queryEl.value.trim()) params.set('q', queryEl.value.trim());
    return params;
  }

  function dataUrl() {
    var params = graphParams();
    return '/graph/app/data?' + params.toString();
  }

  function appUrl() {
    var params = graphParams();
    return '/graph/app?' + params.toString();
  }

  function syncLinks() {
    jsonLinkEl.href = dataUrl();
  }

  function renderQualityLegend() {
    if (!qualityToggleEl.checked) {
      qualityLegendEl.textContent = 'Quality overlay off';
      return;
    }
    var quality = graph.meta && graph.meta.graphQuality;
    if (!quality || !quality.values) {
      qualityLegendEl.textContent = 'Quality metrics unavailable';
      return;
    }
    var values = quality.values;
    var confidence = values.edge_confidence_distribution || {};
    qualityLegendEl.innerHTML = '<b>Quality</b> · orphan ' + (Number(values.orphan_node_rate || 0) * 100).toFixed(1) +
      '% · duplicate ' + (Number(values.duplicate_edge_rate || 0) * 100).toFixed(1) +
      '% · confidence ' + Number(confidence.mean || 0).toFixed(2) +
      ' · provenance ' + (Number(values.edge_provenance_coverage_rate || 0) * 100).toFixed(1) +
      '% · fresh ' + (Number(values.edge_freshness_rate || 0) * 100).toFixed(1) +
      '% · <span style="color:#59c3a6">healthy</span> <span style="color:#e3b955">low confidence</span> <span style="color:#ee6a5f">stale/orphan</span>';
  }

  async function loadGraph() {
    var seq = ++loadSeq;
    statusEl.textContent = 'Loading graph...';
    fleetOverlayLoadedAt = 0;
    syncLinks();
    try {
      var fleetPromise = fetchFleetOverlay();
      var response = await fetch(dataUrl(), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var body = await response.json();
      var payload = body.data || body;
      graph = {
        nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
        links: Array.isArray(payload.links) ? payload.links : [],
        meta: payload.meta || {}
      };
      nodesById = new Map(graph.nodes.map(function (node) { return [node.id, node]; }));
      graph.links = graph.links.filter(function (link) { return nodesById.has(link.source) && nodesById.has(link.target); });
      graphLoadedAt = Date.now();
      selected = null;
      hovered = null;
      activeTags = Array.isArray(graph.meta.tags) ? graph.meta.tags.map(normalized).filter(Boolean) : activeTags;
      activeTypes = Array.isArray(graph.meta.types) ? graph.meta.types.map(normalized).filter(Boolean) : activeTypes;
      setInitialPositions();
      renderTagFilters();
      renderSearchResults();
      renderDetails();
      renderNeighbors();
      renderQualityLegend();
      renderGraphChrome();
      applyRendererMode();
      fleetPromise.then(function (report) {
        if (seq !== loadSeq) return;
        applyFleetOverlay(report);
        renderDetails();
        renderNeighbors();
        renderGraphChrome();
        requestRender();
      });
    } catch (error) {
      graph = { nodes: [], links: [], meta: {} };
      graphLoadedAt = 0;
      nodesById = new Map();
      metaEl.textContent = 'Graph unavailable';
      statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      renderSearchResults();
      renderTagFilters();
      renderDetails();
      renderNeighbors();
      renderQualityLegend();
    }
  }

  canvas.addEventListener('pointerdown', function (event) {
    canvas.setPointerCapture(event.pointerId);
    lastPointer = { x: event.clientX, y: event.clientY };
    var node = nearestNode(event);
    if (node) {
      draggingNode = node;
      node.fixed = true;
      selectNode(node);
    } else {
      draggingCanvas = true;
    }
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', function (event) {
    var nextHovered = nearestNode(event);
    if (hovered !== nextHovered) {
      hovered = nextHovered;
      requestRender();
    }
    if (!lastPointer) return;
    if (draggingNode) {
      var world = worldFromEvent(event);
      draggingNode.x = world.x;
      draggingNode.y = world.y;
      draggingNode.vx = 0;
      draggingNode.vy = 0;
      requestRender();
    } else if (draggingCanvas) {
      pan.x += event.clientX - lastPointer.x;
      pan.y += event.clientY - lastPointer.y;
      requestRender();
    }
    lastPointer = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener('pointerup', function () {
    if (draggingNode) draggingNode.fixed = false;
    if (draggingNode) restartLayout();
    else requestRender();
    draggingNode = null;
    draggingCanvas = false;
    lastPointer = null;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var before = {
      x: (event.clientX - rect.left - pan.x) / scale,
      y: (event.clientY - rect.top - pan.y) / scale
    };
    var factor = event.deltaY < 0 ? 1.08 : 0.92;
    scale = Math.max(0.18, Math.min(3.5, scale * factor));
    pan.x = event.clientX - rect.left - before.x * scale;
    pan.y = event.clientY - rect.top - before.y * scale;
    requestRender();
  }, { passive: false });

  resultsEl.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-id]');
    if (!button) return;
    selectNode(nodesById.get(button.getAttribute('data-id')));
  });

  neighborsEl.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-id]');
    if (!button) return;
    selectNode(nodesById.get(button.getAttribute('data-id')));
  });

  tagFiltersEl.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-tag]');
    if (!button) return;
    var tag = normalized(button.getAttribute('data-tag'));
    if (!tag) return;
    if (activeTags.includes(tag)) activeTags = activeTags.filter(function (candidate) { return candidate !== tag; });
    else if (activeTags.length < 12) activeTags = activeTags.concat(tag);
    renderTagFilters();
    syncLinks();
    loadGraph();
  });

  queryEl.addEventListener('input', function () {
    renderSearchResults();
    syncLinks();
    window.clearTimeout(queryEl._timer);
    queryEl._timer = window.setTimeout(loadGraph, 350);
  });
  kindEl.addEventListener('change', function () {
    activeTypes = [];
    typeEl.value = '';
    syncLinks();
    loadGraph();
  });
  typeEl.addEventListener('change', function () {
    activeTypes = typeEl.value ? [typeEl.value] : [];
    if (activeTypes.length) kindEl.value = 'entities';
    syncLinks();
    loadGraph();
  });
  viewEl.addEventListener('change', function () {
    var preset = VIEW_PRESETS[viewEl.value] || VIEW_PRESETS.overview;
    kindEl.value = preset.kind;
    activeTypes = preset.types.slice();
    typeEl.value = '';
    activeTags = [];
    syncLinks();
    loadGraph();
  });
  renderModeEl.addEventListener('change', applyRendererMode);
  tagModeEl.addEventListener('change', function () {
    syncLinks();
    if (activeTags.length) loadGraph();
  });
  limitEl.addEventListener('change', function () {
    syncLinks();
    loadGraph();
  });
  neighborsToggleEl.addEventListener('change', function () {
    syncLinks();
    loadGraph();
  });
  qualityToggleEl.addEventListener('change', function () {
    renderQualityLegend();
    if (rendererIs3d()) refresh3dStyle();
    else requestRender();
  });
  fitViewEl.addEventListener('click', fitCurrentView);
  toggleSidebarEl.addEventListener('click', function () {
    document.body.classList.toggle('focus-mode');
    toggleSidebarEl.textContent = document.body.classList.contains('focus-mode') ? 'Details' : 'Focus';
    window.setTimeout(resize, 0);
  });
  reloadEl.addEventListener('click', loadGraph);
  popoutEl.addEventListener('click', function () {
    if (!confirmFreshSnapshotAction('opening a popout')) return;
    window.open(appUrl(), 'brainGraphApp', 'popup=yes,width=1280,height=840');
  });
  jsonLinkEl.addEventListener('click', function (event) {
    if (!confirmFreshSnapshotAction('opening the JSON snapshot')) event.preventDefault();
  });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && graph.nodes.length) wakeLayout();
  });

  resize();
  loadGraph();
  window.setInterval(layoutWatchdog, LAYOUT_WATCHDOG_MS);
  requestRender();
})();
</script>
</body>
</html>`;
