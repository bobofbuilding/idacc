import { createHash } from 'node:crypto';

function canonicalize(value, { arrayItem = false } = {}) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return arrayItem ? null : undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, { arrayItem: true }));
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalize(value[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, { arrayItem: true }));
}

export function canonicalContentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function deriveIdempotencyKey(parentKey, suffix) {
  const parent = normalizeIdempotencyKey(parentKey, { required: true });
  const operation = String(suffix ?? '').replace(/[\u0000-\u001f\u007f]/g, '') || 'operation';
  const label = operation.slice(0, 80);
  const digest = createHash('sha256')
    .update(parent)
    .update('\0')
    .update(operation)
    .digest('hex');
  return `derived:${label}:${digest}`;
}

export function normalizeIdempotencyKey(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    const error = new Error('idempotency_key is required');
    error.status = 400;
    error.code = 'idempotency_key_required';
    throw error;
  }
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    const error = new Error('idempotency_key must be a non-empty printable string of at most 512 characters');
    error.status = 400;
    error.code = 'invalid_idempotency_key';
    throw error;
  }
  return value.trim();
}

export function idempotencyConflict(resource, idempotencyKey, existingId = null) {
  const error = new Error(`${resource} idempotency key was already used with different canonical content`);
  error.status = 409;
  error.code = 'idempotency_conflict';
  error.idempotencyKey = idempotencyKey;
  error.existingId = existingId;
  return error;
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function timelineCanonicalContent({ source, type, subject = '', data = {}, tags = [] } = {}) {
  return canonicalJson({
    source: String(source ?? ''),
    type: String(type ?? ''),
    subject: String(subject ?? ''),
    data,
    tags,
  });
}

function existingTimelineCanonicalContent(row) {
  return timelineCanonicalContent({
    source: row.source,
    type: row.type,
    subject: row.subject,
    data: parseStoredJson(row.data, null),
    tags: parseStoredJson(row.tags, null),
  });
}

export function insertIdempotentTimeline(db, {
  source,
  type,
  subject = '',
  data = {},
  tags = [],
  idempotencyKey = null,
} = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const canonicalContent = timelineCanonicalContent({ source, type, subject, data, tags });
  if (key) {
    const existing = db.prepare(`
      SELECT id, source, type, subject, data, tags
      FROM timeline
      WHERE idempotency_key=?
    `).get(key);
    if (existing) {
      if (existingTimelineCanonicalContent(existing) !== canonicalContent) {
        throw idempotencyConflict('timeline event', key, Number(existing.id));
      }
      return { id: Number(existing.id), deduplicated: true };
    }
  }

  try {
    const result = db.prepare(`
      INSERT INTO timeline (source, type, subject, data, tags, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(source ?? ''),
      String(type ?? ''),
      String(subject ?? ''),
      canonicalJson(data ?? {}),
      canonicalJson(tags ?? []),
      key,
    );
    return { id: Number(result.lastInsertRowid), deduplicated: false };
  } catch (error) {
    if (!key || !/unique/i.test(String(error?.message ?? ''))) throw error;
    const existing = db.prepare(`
      SELECT id, source, type, subject, data, tags
      FROM timeline
      WHERE idempotency_key=?
    `).get(key);
    if (!existing || existingTimelineCanonicalContent(existing) !== canonicalContent) {
      throw idempotencyConflict('timeline event', key, Number(existing?.id ?? 0) || null);
    }
    return { id: Number(existing.id), deduplicated: true };
  }
}

export function idempotencyErrorBody(error) {
  return {
    ok: false,
    error: {
      type: error?.status === 409 ? 'brain.idempotency_conflict' : 'brain.validation',
      code: error?.code ?? 'idempotency_error',
      message: error?.message ?? 'idempotency error',
      idempotency_key: error?.idempotencyKey ?? null,
      existing_id: error?.existingId ?? null,
    },
  };
}

export function readIdempotencyReceipt(db, {
  scope,
  idempotencyKey,
  canonicalContent,
} = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!key) return null;
  const row = db.prepare(`
    SELECT content_hash, result
    FROM idempotency_receipts
    WHERE scope=? AND idempotency_key=?
  `).get(String(scope ?? ''), key);
  if (!row) return null;
  const contentHash = canonicalContentHash(canonicalContent);
  if (row.content_hash !== contentHash) {
    throw idempotencyConflict(`${scope} operation`, key);
  }
  return {
    deduplicated: true,
    result: parseStoredJson(row.result, {}),
  };
}

export function writeIdempotencyReceipt(db, {
  scope,
  idempotencyKey,
  canonicalContent,
  result = {},
} = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!key) return null;
  db.prepare(`
    INSERT INTO idempotency_receipts
      (scope, idempotency_key, content_hash, result)
    VALUES (?, ?, ?, ?)
  `).run(
    String(scope ?? ''),
    key,
    canonicalContentHash(canonicalContent),
    canonicalJson(result ?? {}),
  );
  return { deduplicated: false, result };
}
