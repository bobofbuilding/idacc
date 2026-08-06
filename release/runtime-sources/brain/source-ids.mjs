export function canonicalSourceId(kind, id) {
  if (id === undefined || id === null || id === '') return null;
  const text = String(id);
  if (kind === 'entity') return text.startsWith('entity:') ? text : `entity:${text}`;
  if (kind === 'text') return text.startsWith('text:') ? text : `text:${text}`;
  if (kind === 'fact') return text.startsWith('fact:') ? text : `fact:${text}`;
  return text;
}

export function normalizeSourceIds(ids = []) {
  const raw = [];
  const canonical = [];
  for (const value of Array.isArray(ids) ? ids : []) {
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    raw.push(text);
    if (text.startsWith('entity:') || text.startsWith('text:') || text.startsWith('fact:') || text.startsWith('memory:')) {
      canonical.push(text);
    } else if (/^\d+$/.test(text)) {
      canonical.push(canonicalSourceId('text', text));
      canonical.push(canonicalSourceId('fact', text));
    } else {
      canonical.push(canonicalSourceId('entity', text));
    }
  }
  return { raw: [...new Set(raw)], canonical: [...new Set(canonical.filter(Boolean))] };
}

export function canonicalSourceIds(ids = []) {
  return normalizeSourceIds(ids).canonical;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return fallback;
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function backfillEvalSourceIds(db) {
  const tableInfo = db.prepare(`PRAGMA table_info(eval_queries)`).all();
  if (!Array.isArray(tableInfo) || tableInfo.length === 0) {
    return { scanned: 0, updated: 0 };
  }

  const columnNames = tableInfo.map((row) => row.name);
  const hasColumn = (name) => columnNames.includes(name);

  const selectColumns = ['id', 'accepted_ids', 'volunteered_source_ids', 'metadata'];
  if (hasColumn('route_ids')) selectColumns.push('route_ids');
  if (hasColumn('required_source_ids')) selectColumns.push('required_source_ids');
  if (hasColumn('required_acceptance_ids')) selectColumns.push('required_acceptance_ids');
  if (hasColumn('used_ids')) selectColumns.push('used_ids');
  if (hasColumn('route_ack_state')) selectColumns.push('route_ack_state');

  const rows = db.prepare(`SELECT ${selectColumns.join(', ')} FROM eval_queries`).all();
  if (!rows.length) return { scanned: 0, updated: 0 };

  const assignments = ['accepted_ids=?', 'volunteered_source_ids=?'];
  if (hasColumn('route_ids')) assignments.push('route_ids=?');
  if (hasColumn('required_source_ids')) assignments.push('required_source_ids=?');
  if (hasColumn('required_acceptance_ids')) assignments.push('required_acceptance_ids=?');
  if (hasColumn('used_ids')) assignments.push('used_ids=?');
  if (hasColumn('route_ack_state')) assignments.push('route_ack_state=?');
  assignments.push('metadata=?');
  const update = db.prepare(`UPDATE eval_queries SET ${assignments.join(', ')} WHERE id=?`);

  let updated = 0;
  for (const row of rows) {
    const acceptedRaw = parseJson(row.accepted_ids, []);
    const volunteeredRaw = parseJson(row.volunteered_source_ids, []);
    const accepted = normalizeSourceIds(acceptedRaw);
    const volunteered = normalizeSourceIds(volunteeredRaw);
    const routeIds = hasColumn('route_ids') ? normalizeSourceIds(parseJson(row.route_ids, [])).canonical : [];
    const requiredSourceIds = hasColumn('required_source_ids')
      ? normalizeSourceIds(parseJson(row.required_source_ids, accepted.canonical)).canonical
      : accepted.canonical;
    const requiredAcceptanceIds = hasColumn('required_acceptance_ids')
      ? normalizeSourceIds(parseJson(row.required_acceptance_ids, accepted.canonical)).canonical
      : accepted.canonical;
    const usedIds = hasColumn('used_ids')
      ? normalizeSourceIds(parseJson(row.used_ids, accepted.canonical)).canonical
      : accepted.canonical;
    let routeAckState = hasColumn('route_ack_state') ? parseJson(row.route_ack_state, {}) : {};
    if (!routeAckState || typeof routeAckState !== 'object' || Array.isArray(routeAckState)) routeAckState = {};
    if (Object.keys(routeAckState).length === 0 && routeIds.length) {
      const state = {};
      for (const route of routeIds) state[route] = 'acknowledged';
      routeAckState = state;
    }

    const metadata = parseJson(row.metadata, {});
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) continue;

    const nextMetadata = { ...metadata };
    let changed = false;
    if (!sameJson(acceptedRaw, accepted.canonical)) {
      if (!Array.isArray(nextMetadata.accepted_ids_raw)) nextMetadata.accepted_ids_raw = accepted.raw;
      changed = true;
    }
    if (!sameJson(volunteeredRaw, volunteered.canonical)) {
      if (!Array.isArray(nextMetadata.volunteered_source_ids_raw)) nextMetadata.volunteered_source_ids_raw = volunteered.raw;
      changed = true;
    }
    if (hasColumn('required_source_ids') && !sameJson(parseJson(row.required_source_ids, []), requiredSourceIds)) {
      changed = true;
    }
    if (hasColumn('required_acceptance_ids') && !sameJson(parseJson(row.required_acceptance_ids, []), requiredAcceptanceIds)) {
      changed = true;
    }
    if (hasColumn('used_ids') && !sameJson(parseJson(row.used_ids, []), usedIds)) {
      changed = true;
    }
    if (hasColumn('route_ids') && !sameJson(parseJson(row.route_ids, []), routeIds)) {
      changed = true;
    }
    if (hasColumn('route_ack_state') && !sameJson(parseJson(row.route_ack_state, {}), routeAckState)) {
      changed = true;
    }
    if (!changed) continue;

    nextMetadata.source_id_backfilled = true;
    const values = [
      JSON.stringify(accepted.canonical),
      JSON.stringify(volunteered.canonical),
    ];
    if (hasColumn('route_ids')) values.push(JSON.stringify(routeIds));
    if (hasColumn('required_source_ids')) values.push(JSON.stringify(requiredSourceIds));
    if (hasColumn('required_acceptance_ids')) values.push(JSON.stringify(requiredAcceptanceIds));
    if (hasColumn('used_ids')) values.push(JSON.stringify(usedIds));
    if (hasColumn('route_ack_state')) values.push(JSON.stringify(routeAckState));
    values.push(JSON.stringify(nextMetadata));
    values.push(row.id);
    update.run(...values);
    updated += 1;
  }
  return { scanned: rows.length, updated };
}
