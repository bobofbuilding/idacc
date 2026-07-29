function safeJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function shapeSourceContent(kind, row) {
  if (kind === 'entity') {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      description: row.description,
      status: row.status,
      tags: safeJson(row.tags, []),
      data: safeJson(row.data, {}),
      updated_at: row.updated_at,
    };
  }
  if (kind === 'fact') {
    return {
      id: row.id,
      entity_id: row.entity_id,
      field: row.field,
      value: safeJson(row.value, row.value),
      source: row.source,
      confidence: row.confidence,
      status: row.status,
      observed_at: row.observed_at,
      context: safeJson(row.context, {}),
    };
  }
  if (kind === 'text') {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      source_kind: row.source_kind,
      source_id: row.source_id,
      metadata: safeJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  if (kind === 'memory') {
    return {
      id: row.id,
      agent_id: row.agent_id,
      mem_key: row.mem_key,
      content: row.content,
      status: row.status,
      created_at: row.created_at,
    };
  }
  return row;
}

export async function handleSourceRoutes({
  method,
  path,
  req,
  res,
  db,
  readBody,
  send,
  validateSourceIds,
  sourceRow,
  canonicalSourceIds,
} = {}) {
  if (method === 'POST' && path === '/sources/validate') {
    const b = await readBody(req);
    const sourceIds = b.source_ids ?? b.sourceIds ?? b.canonical_source_ids ?? b.canonicalSourceIds ?? [];
    const sources = validateSourceIds(db, sourceIds);
    const invalid = sources.filter(source => !source.valid);
    send(res, 200, {
      ok: true,
      sources,
      summary: {
        checked: sources.length,
        valid: sources.length - invalid.length,
        invalid: invalid.length,
      },
    });
    return true;
  }

  // Generic resolver: fetch the actual record behind any canonical
  // (entity:/fact:/text:/memory:) or bare-numeric citation ID. Bare numeric
  // IDs are ambiguous (could be a fact or a text unit), so every candidate
  // kind is tried and reported.
  const m = method === 'GET' && path !== '/sources/validate' ? path.match(/^\/sources\/([^/]+)$/) : null;
  if (m) {
    const rawId = decodeURIComponent(m[1]);
    const candidates = canonicalSourceIds([rawId]);
    const matches = [];
    for (const candidate of candidates) {
      const found = sourceRow(db, candidate);
      if (found) matches.push({ source_id: candidate, kind: found.kind, content: shapeSourceContent(found.kind, found.row) });
    }
    if (!matches.length) {
      send(res, 404, {
        error: 'not found',
        source_id: rawId,
        candidates,
        hint: 'no entity/fact/text-unit/memory record matches this ID; use POST /sources/validate to check status',
      });
      return true;
    }
    if (matches.length === 1) {
      send(res, 200, { ok: true, ...matches[0] });
      return true;
    }
    send(res, 200, { ok: true, ambiguous: true, matches });
    return true;
  }

  return false;
}
