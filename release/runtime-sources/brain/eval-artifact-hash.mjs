import { createHash } from 'node:crypto';

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return [...new Set(values)];
}

export function normalizeStringList(value) {
  return uniqueSorted(asList(value).map((item) => String(item).trim()).filter(Boolean)).sort();
}

export function normalizeRouteIds(value, fallback = []) {
  const input = asList(value).length ? value : fallback;
  return normalizeStringList(input);
}

export function normalizeRouteAckState(routeAckState, routeIds = [], route = '') {
  const normalizedRoutes = normalizeRouteIds(routeIds, route ? [route] : []);
  const state = routeAckState && typeof routeAckState === 'object' && !Array.isArray(routeAckState)
    ? { ...routeAckState }
    : {};

  if (!Object.keys(state).length) {
    if (typeof routeAckState === 'string') {
      const key = normalizedRoutes[0] || String(route || '').trim();
      if (key) state[key] = routeAckState;
    }
    if (!Object.keys(state).length && normalizedRoutes.length) {
      for (const id of normalizedRoutes) {
        if (id) state[id] = 'acknowledged';
      }
    }
    return state;
  }

  const normalized = {};
  for (const [key, value] of Object.entries(state)) {
    const routeId = String(key).trim();
    if (!routeId) continue;
    const ackValue = String(value ?? 'acknowledged').trim();
    normalized[routeId] = ackValue || 'acknowledged';
  }
  for (const routeId of normalizedRoutes) {
    if (!normalized[routeId]) normalized[routeId] = 'acknowledged';
  }
  return normalized;
}

function asSet(values = []) {
  const out = [];
  const set = new Set();
  for (const value of asList(values)) {
    const text = String(value ?? '').trim();
    if (!text || set.has(text)) continue;
    set.add(text);
    out.push(text);
  }
  return out;
}

export function stableEvalArtifactHash(payload = {}) {
  const routeAckState = normalizeRouteAckState(payload.route_ack_state ?? payload.routeAckState ?? {}, payload.route_ids ?? [payload.route ?? ''], payload.route ?? '');
  const body = {
    query_text: String(payload.query_text ?? ''),
    route: String(payload.route ?? ''),
    task_id: String(payload.task_id ?? ''),
    agent_id: String(payload.agent_id ?? ''),
    route_ids: normalizeRouteIds(payload.route_ids, [payload.route ?? '']).sort(),
    required_source_ids: normalizeStringList(payload.required_source_ids).sort(),
    required_acceptance_ids: normalizeStringList(payload.required_acceptance_ids).sort(),
    used_ids: normalizeStringList(payload.used_ids).sort(),
    accepted_ids: normalizeStringList(payload.accepted_ids).sort(),
    volunteered_source_ids: normalizeStringList(payload.volunteered_source_ids).sort(),
    route_ack_state: Object.fromEntries(Object.entries(routeAckState).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    returned_entity_ids: asSet(payload.returned_entity_ids).sort(),
    returned_text_unit_ids: asSet(payload.returned_text_unit_ids).sort(),
    returned_fact_ids: asSet(payload.returned_fact_ids).sort(),
  };

  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
