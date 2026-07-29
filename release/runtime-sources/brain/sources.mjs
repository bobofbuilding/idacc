function safeJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

export const KNOWN_SKILL_EDGE_KINDS = Object.freeze([
  'related',
  'composes',
  'requires',
  'same-domain',
  'supports-task',
  'validates-source',
  'requires-skill',
  'source-of',
  'supersedes',
]);

export const KNOWN_ENTITY_EDGE_KINDS = Object.freeze([
  ...KNOWN_SKILL_EDGE_KINDS,
  'alias-of',
  'co-mentioned',
  'derived-from',
  'fact-context',
  'implemented-by-skill',
  'member-of',
  'mentions',
  'reference-for',
  'uses',
]);

const KNOWN_SKILL_EDGE_KIND_SET = new Set(KNOWN_SKILL_EDGE_KINDS);
const KNOWN_ENTITY_EDGE_KIND_SET = new Set(KNOWN_ENTITY_EDGE_KINDS);

export function edgeReviewSubject(table, edgeId) {
  const normalizedTable = table === 'skill_edges' ? 'skill_edge' : 'entity_edge';
  return `${normalizedTable}:${Number(edgeId)}`;
}

export function parseEdgeReviewSubject(subject = '') {
  const match = String(subject ?? '').match(/^(entity_edge|skill_edge):(\d+)$/);
  if (!match) return null;
  return {
    table: match[1] === 'skill_edge' ? 'skill_edges' : 'entity_edges',
    edge_id: Number(match[2]),
  };
}

export function canonicalSourceIds(ids = []) {
  const out = [];
  for (const value of Array.isArray(ids) ? ids : []) {
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    if (text.startsWith('entity:') || text.startsWith('fact:') || text.startsWith('text:') || text.startsWith('memory:')) out.push(text);
    else if (/^\d+$/.test(text)) out.push(`text:${text}`, `fact:${text}`);
    else out.push(`entity:${text}`);
  }
  return [...new Set(out)];
}

export function sourceKindFromCanonical(id) {
  if (String(id).startsWith('entity:')) return 'entity';
  if (String(id).startsWith('text:')) return 'text';
  if (String(id).startsWith('fact:')) return 'fact';
  if (String(id).startsWith('memory:')) return 'memory';
  return 'source';
}

export function sourceRow(db, sourceId) {
  const id = String(sourceId ?? '');
  if (id.startsWith('entity:')) {
    const row = db.prepare(`SELECT * FROM entities WHERE id=?`).get(id.slice('entity:'.length));
    return row ? { kind: 'entity', key: row.id, row } : null;
  }
  if (id.startsWith('fact:')) {
    const n = Number(id.slice('fact:'.length));
    if (!Number.isInteger(n)) return null;
    const row = db.prepare(`SELECT * FROM facts WHERE id=?`).get(n);
    return row ? { kind: 'fact', key: row.id, row } : null;
  }
  if (id.startsWith('text:')) {
    const n = Number(id.slice('text:'.length));
    if (!Number.isInteger(n)) return null;
    const row = db.prepare(`SELECT * FROM text_units WHERE id=?`).get(n);
    return row ? { kind: 'text', key: row.id, row } : null;
  }
  if (id.startsWith('memory:')) {
    const n = Number(id.slice('memory:'.length));
    if (!Number.isInteger(n)) return null;
    const row = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(n);
    return row ? { kind: 'memory', key: row.id, row } : null;
  }
  return null;
}

function edgeEndpointExists(db, endpoint) {
  const id = String(endpoint ?? '').trim();
  if (!id) return false;
  if (id.startsWith('fact:')) {
    const n = Number(id.slice('fact:'.length));
    return Number.isInteger(n) && !!db.prepare(`SELECT 1 FROM facts WHERE id=?`).get(n);
  }
  if (id.startsWith('text:')) {
    const n = Number(id.slice('text:'.length));
    return Number.isInteger(n) && !!db.prepare(`SELECT 1 FROM text_units WHERE id=?`).get(n);
  }
  if (id.startsWith('memory:')) {
    const n = Number(id.slice('memory:'.length));
    return Number.isInteger(n) && !!db.prepare(`SELECT 1 FROM agent_memories WHERE id=?`).get(n);
  }
  if (id.startsWith('skill:')) {
    const n = Number(id.slice('skill:'.length));
    if (Number.isInteger(n) && db.prepare(`SELECT 1 FROM skill_nodes WHERE skill_id=?`).get(n)) return true;
  }
  if (id.startsWith('source:')) return id.length > 'source:'.length;
  return !!db.prepare(`SELECT 1 FROM entities WHERE id=?`).get(id);
}

function edgeSnapshot(row = {}, table) {
  const snapshot = {
    id: Number(row.id),
    table,
    from_id: row.from_id,
    to_id: row.to_id,
    kind: row.kind,
    weight: Number(row.weight ?? 0) || 0,
    evidence_count: Number(row.evidence_count ?? 0) || 0,
    updated_at: Number(row.updated_at ?? 0) || 0,
  };
  if (table === 'entity_edges') {
    snapshot.description = row.description ?? '';
    snapshot.text_unit_ids = safeJson(row.text_unit_ids, []);
    snapshot.prompt_version = row.prompt_version ?? '';
  }
  return snapshot;
}

function edgeIssueSeverity(issues = []) {
  if (issues.some(code => code === 'invalid_kind' || code === 'orphaned_from' || code === 'orphaned_to')) return 'high';
  if (issues.length) return 'medium';
  return 'none';
}

function edgeIssueMessages({ table, kind, from_id, to_id, issues = [], minEvidenceCount }) {
  return issues.map((code) => {
    if (code === 'invalid_kind') return `unknown ${table} kind "${kind}"`;
    if (code === 'orphaned_from') return `from_id "${from_id}" has no backing node`;
    if (code === 'orphaned_to') return `to_id "${to_id}" has no backing node`;
    if (code === 'low_evidence') return `evidence_count is below ${minEvidenceCount}`;
    if (code === 'stale') return 'updated_at is stale';
    return code;
  });
}

export function graphEdgeIssues(db, row = {}, {
  table = 'entity_edges',
  now = Math.floor(Date.now() / 1000),
  staleDays = Number(process.env.BRAIN_EDGE_STALE_DAYS ?? 180),
  minEvidenceCount = Number(process.env.BRAIN_EDGE_MIN_EVIDENCE_COUNT ?? 1),
} = {}) {
  const staleCutoff = now - Math.max(staleDays, 1) * 86400;
  const issues = [];
  const evidenceCount = Math.max(0, Number(row.evidence_count ?? 0) || 0);
  const updatedAt = Math.max(0, Number(row.updated_at ?? 0) || 0);
  const kind = String(row.kind ?? '');
  const kindSet = table === 'skill_edges' ? KNOWN_SKILL_EDGE_KIND_SET : KNOWN_ENTITY_EDGE_KIND_SET;

  if (!kindSet.has(kind)) issues.push('invalid_kind');
  if (table === 'skill_edges') {
    const fromId = Number(row.from_id);
    const toId = Number(row.to_id);
    if (!Number.isInteger(fromId) || !db.prepare(`SELECT 1 FROM skill_nodes WHERE skill_id=?`).get(fromId)) issues.push('orphaned_from');
    if (!Number.isInteger(toId) || !db.prepare(`SELECT 1 FROM skill_nodes WHERE skill_id=?`).get(toId)) issues.push('orphaned_to');
  } else {
    if (!edgeEndpointExists(db, row.from_id)) issues.push('orphaned_from');
    if (!edgeEndpointExists(db, row.to_id)) issues.push('orphaned_to');
  }
  if (evidenceCount < Math.max(0, minEvidenceCount)) issues.push('low_evidence');
  if (!updatedAt || updatedAt < staleCutoff) issues.push('stale');

  const severity = edgeIssueSeverity(issues);
  const messages = edgeIssueMessages({
    table,
    kind,
    from_id: row.from_id,
    to_id: row.to_id,
    issues,
    minEvidenceCount: Math.max(0, minEvidenceCount),
  });

  return {
    edge_id: Number(row.id),
    edge_ref: edgeReviewSubject(table, row.id),
    table,
    exists: true,
    valid: issues.length === 0,
    severity,
    issues,
    issue_messages: messages,
    kind,
    from_id: row.from_id,
    to_id: row.to_id,
    evidence_count: evidenceCount,
    updated_at: updatedAt,
    snapshot: edgeSnapshot(row, table),
  };
}

export function validateGraphEdges(db, {
  now = Math.floor(Date.now() / 1000),
  staleDays = Number(process.env.BRAIN_EDGE_STALE_DAYS ?? 180),
  minEvidenceCount = Number(process.env.BRAIN_EDGE_MIN_EVIDENCE_COUNT ?? 1),
  tables = ['entity_edges', 'skill_edges'],
} = {}) {
  const results = [];
  const scanEntityEdges = tables.includes('entity_edges');
  const scanSkillEdges = tables.includes('skill_edges');
  if (scanEntityEdges) {
    const rows = db.prepare(`SELECT * FROM entity_edges ORDER BY id ASC`).all();
    for (const row of rows) results.push(graphEdgeIssues(db, row, { table: 'entity_edges', now, staleDays, minEvidenceCount }));
  }
  if (scanSkillEdges) {
    const rows = db.prepare(`SELECT * FROM skill_edges ORDER BY id ASC`).all();
    for (const row of rows) results.push(graphEdgeIssues(db, row, { table: 'skill_edges', now, staleDays, minEvidenceCount }));
  }
  return results.sort((a, b) => {
    const severityRank = { high: 0, medium: 1, none: 2 };
    const severityDelta = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
    if (severityDelta) return severityDelta;
    if (a.table !== b.table) return a.table.localeCompare(b.table);
    return Number(a.edge_id) - Number(b.edge_id);
  });
}

export function sourceIssues(db, sourceId, {
  now = Math.floor(Date.now() / 1000),
  staleDays = Number(process.env.BRAIN_CITATION_STALE_DAYS ?? 180),
} = {}) {
  const staleCutoff = now - Math.max(staleDays, 1) * 86400;
  const found = sourceRow(db, sourceId);
  const id = String(sourceId ?? '');
  const issues = [];
  if (!found) return { source_id: id, kind: sourceKindFromCanonical(id), exists: false, status: 'unknown', valid: false, issues: ['unknown'] };
  const result = { source_id: id, kind: found.kind, exists: true, status: found.row.status ?? 'active', issues };
  if (found.kind === 'entity') {
    result.updated_at = found.row.updated_at ?? null;
    if (found.row.status && !['active', 'online', 'offline'].includes(found.row.status)) issues.push(found.row.status);
    if (found.row.updated_at && found.row.updated_at < staleCutoff) issues.push('stale');
  } else if (found.kind === 'fact') {
    result.observed_at = found.row.observed_at ?? null;
    if (found.row.status && found.row.status !== 'active') issues.push(found.row.status);
    if (found.row.observed_at && found.row.observed_at < staleCutoff) issues.push('stale');
  } else if (found.kind === 'text') {
    const metadata = safeJson(found.row.metadata, {});
    result.status = metadata.status ?? 'active';
    result.updated_at = found.row.updated_at ?? null;
    if (metadata.status && metadata.status !== 'active') issues.push(metadata.status);
    if (found.row.updated_at && found.row.updated_at < staleCutoff) issues.push('stale');
  } else if (found.kind === 'memory') {
    result.created_at = found.row.created_at ?? null;
    if (found.row.status && found.row.status !== 'active') issues.push(found.row.status);
    if (found.row.expires_at && found.row.expires_at <= now) issues.push('expired');
    if (found.row.created_at && found.row.created_at < staleCutoff) issues.push('stale');
  }
  result.valid = issues.length === 0;
  return result;
}

export function validateSourceIds(db, sourceIds = [], options = {}) {
  return canonicalSourceIds(sourceIds).map(id => sourceIssues(db, id, options));
}
