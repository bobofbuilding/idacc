export function scalarId(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text && !text.includes('[object Object]') ? text : '';
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['id', 'uuid', 'name', 'query_id', 'queryId', 'task_id', 'taskId', 'short_id', 'shortId']) {
    const found = scalarId(value[key]);
    if (found) return found;
  }
  return '';
}

function prefixedSourceId(prefix, value, fallback = 'brain-listener') {
  const text = scalarId(value);
  if (!text) return fallback;
  const normalizedPrefix = `${prefix}:`;
  return text.startsWith(normalizedPrefix) ? text : `${normalizedPrefix}${text}`;
}

export function prefixedEntityId(prefix, value, fallback = '') {
  return prefixedSourceId(prefix, value, fallback);
}

export function learnedArtifactSourceId(scope, fallback = 'brain-listener') {
  const value = typeof scope === 'object' && scope !== null
    ? scope.scopeId ?? scope.taskId ?? scope.queryId ?? scope.agentId ?? scope.eventSeq
    : scope;
  return prefixedSourceId('learned-artifact', value, fallback);
}

export function taskSourceId(taskId, fallback = 'brain-listener') {
  return prefixedSourceId('task', taskId, fallback);
}

export function querySourceId(queryId, fallback = 'brain-listener') {
  return prefixedSourceId('query', queryId, fallback);
}

export function agentSourceId(agentName, fallback = 'brain-listener') {
  return prefixedSourceId('agent', agentName, fallback);
}
