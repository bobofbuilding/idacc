import {
  idempotencyErrorBody,
  insertIdempotentTimeline,
  normalizeIdempotencyKey,
} from '../idempotency.mjs';

export async function handleTimelineRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  db,
  readBody,
  send,
} = {}) {
  if (method === 'GET' && path === '/timeline') {
    const source = searchParams.get('source') ?? undefined;
    const type = searchParams.get('type') ?? undefined;
    const since = Number(searchParams.get('since') ?? 0);
    const limit = Number(searchParams.get('limit') ?? 50);
    const conds = ['created_at > ?'];
    const params = [since];
    if (source) {
      conds.push('source=?');
      params.push(source);
    }
    if (type) {
      conds.push('type=?');
      params.push(type);
    }
    const rows = db.prepare(
      `SELECT * FROM timeline WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit);
    send(res, 200, { events: rows.map(r => ({ ...r, data: JSON.parse(r.data), tags: JSON.parse(r.tags) })) });
    return true;
  }

  if (method === 'POST' && path === '/timeline') {
    const b = await readBody(req);
    if (!b.source || !b.type) {
      send(res, 400, { error: 'source and type required' });
      return true;
    }
    const rawIdempotencyKey = b.idempotency_key ?? b.idempotencyKey ?? null;
    let idempotencyKey;
    try {
      idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    } catch (error) {
      send(res, error.status ?? 400, idempotencyErrorBody(error));
      return true;
    }
    const data = { ...(b.data ?? {}) };
    const subj = String(b.subject ?? '');
    const base = String(process.env.SKILLMESH_APP_URL ?? '').replace(/\/+$/, '');
    if (base && /^\d+$/.test(subj) && (b.source === 'skillmesh' || b.type?.startsWith?.('skill:'))) {
      data.links = { ...(data.links ?? {}), skillmesh: `${base}/skills?id=${subj}`, safety: `${base}/api/skills/${subj}/safety` };
    }
    try {
      const result = insertIdempotentTimeline(db, {
        source: b.source,
        type: b.type,
        subject: b.subject ?? '',
        data,
        tags: b.tags ?? [],
        idempotencyKey,
      });
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      send(res, error.status ?? 500, idempotencyErrorBody(error));
    }
    return true;
  }

  return false;
}
