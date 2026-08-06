import { digestRepo } from '../repo-digestion.mjs';

export async function handleRepoRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson, upsertFact, upsertTextUnitsFromSource }) {
  if (method === 'GET' && path === '/repos') {
    const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
    const rows = db.prepare(`
      SELECT * FROM entities
      WHERE type='repo'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit).map(row => ({
      ...row,
      data: parseJson(row.data, {}),
      tags: parseJson(row.tags, []),
    }));
    send(res, 200, { ok: true, repos: rows });
    return true;
  }

  if (method === 'POST' && path === '/repos/digest') {
    const body = await readBody(req);
    try {
      const result = digestRepo(db, body, { upsertFact, upsertTextUnitsFromSource });
      send(res, 200, result);
    } catch (error) {
      send(res, error.status ?? 500, { error: error.message ?? 'repo digestion failed' });
    }
    return true;
  }

  return false;
}
