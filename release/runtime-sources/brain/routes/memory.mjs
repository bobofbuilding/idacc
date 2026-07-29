const DURABLE_MEMORY_STATUSES = new Set([
  'active',
  'superseded',
  'retired',
  'needs-source',
  'needs-review',
  'archived',
  'rejected',
  'disputed',
]);
const CHATTER_RE = /\b(started|starting|will update|ping|pinged|waiting|claimed|acknowledged|looking into|back soon)\b/i;
const VOLATILE_SUBJECT_RE = /\b(repo head|dirty state|query status|runtime health|queue length)\b/i;
const VOLATILE_CLAIM_TYPES = new Set(['telemetry', 'current_status', 'observation']);

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function normalizeMemoryRow(row) {
  if (!row) return row;
  const durableCandidate = safeJson(row.durable_metadata, {});
  return {
    ...row,
    durable_candidate: Object.keys(durableCandidate).length ? durableCandidate : null,
  };
}

function normalizeMemoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(normalizeMemoryRow);
}

function normalizeStatus(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return DURABLE_MEMORY_STATUSES.has(normalized) ? normalized : null;
}

function normalizeStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function normalizeDurableCandidate(body = {}) {
  const raw = body.durable_candidate ?? body.durableCandidate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const confidenceRaw = raw.confidence;
  return {
    subject: String(raw.subject ?? '').trim(),
    predicate: String(raw.predicate ?? '').trim(),
    value: raw.value ?? null,
    claim_type: String(raw.claim_type ?? raw.claimType ?? '').trim(),
    scope: String(raw.scope ?? '').trim(),
    source_ids: normalizeStringList(raw.source_ids ?? raw.sourceIds ?? []),
    owner: String(raw.owner ?? '').trim(),
    confidence: confidenceRaw == null || confidenceRaw === ''
      ? null
      : (Number.isFinite(Number(confidenceRaw)) ? Number(confidenceRaw) : null),
    freshness: String(raw.freshness ?? '').trim(),
    update_path: String(raw.update_path ?? raw.updatePath ?? '').trim(),
    confidence_reason: String(raw.confidence_reason ?? raw.confidenceReason ?? '').trim(),
    source_recovery: String(raw.source_recovery ?? raw.sourceRecovery ?? '').trim(),
    validator_state: String(raw.validator_state ?? raw.validatorState ?? '').trim(),
  };
}

function durableValidationError(code, message, details = {}) {
  return {
    ok: false,
    error: {
      type: code,
      code,
      message,
      details,
    },
  };
}

function evaluateDurableMemoryWrite({ body = {}, candidate = null, validateSourceIds, db }) {
  const content = String(body.content ?? '');
  const shared = body.shared === true;
  const status = normalizeStatus(body.status);
  const sourceValidation = candidate?.source_ids?.length ? validateSourceIds(db, candidate.source_ids) : [];
  const invalidSourceIds = sourceValidation.filter((item) => !item.valid).map((item) => item.source_id);
  const missingFields = [];
  if (candidate) {
    if (!candidate.source_ids.length || invalidSourceIds.length) missingFields.push('source_ids');
    if (!candidate.owner) missingFields.push('owner');
    if (candidate.confidence == null) missingFields.push('confidence');
    if (!candidate.freshness) missingFields.push('freshness');
    if (!candidate.update_path) missingFields.push('update_path');
  }
  const hasLocalScope = ['task_id', 'taskId', 'turn_id', 'turnId', 'session_id', 'sessionId']
    .some((field) => String(body[field] ?? '').trim());
  const looksLikeChatter = CHATTER_RE.test(content);
  const subject = `${candidate?.subject ?? ''} ${candidate?.predicate ?? ''}`.trim();
  const volatileCandidate = Boolean(
    candidate
    && VOLATILE_CLAIM_TYPES.has(candidate.claim_type)
    && VOLATILE_SUBJECT_RE.test(subject),
  );

  if (shared && hasLocalScope && looksLikeChatter) {
    return {
      ok: false,
      decision: 'reject',
      error_code: 'durable_memory_task_local_chatter',
      message: 'task-local chatter cannot be stored as durable shared memory',
      recommended_state: 'rejected',
      has_local_scope: true,
      looks_like_chatter: true,
    };
  }

  if (volatileCandidate) {
    return {
      ok: true,
      decision: 'hold-out',
      recommended_state: 'archived',
      missing_fields: missingFields,
      invalid_source_ids: invalidSourceIds,
      active_durable: false,
      shared_visible: false,
      volatile_candidate: true,
      source_validation: sourceValidation,
    };
  }

  if (candidate && missingFields.length) {
    const recommendedState = missingFields.includes('source_ids') ? 'needs-source' : 'needs-review';
    return {
      ok: false,
      decision: missingFields.includes('source_ids') ? 'reject' : 'downgrade',
      error_code: 'durable_memory_validation_failed',
      message: 'durable memory candidate is missing required metadata',
      missing_fields: missingFields,
      invalid_source_ids: invalidSourceIds,
      recommended_state: recommendedState,
      active_durable: false,
      shared_visible: false,
      source_validation: sourceValidation,
    };
  }

  if (candidate) {
    return {
      ok: true,
      decision: 'promote-active',
      recommended_state: status && status !== 'active' ? status : 'active',
      missing_fields: [],
      invalid_source_ids: [],
      active_durable: status == null || status === 'active',
      shared_visible: shared && (status == null || status === 'active'),
      source_validation: sourceValidation,
    };
  }

  return {
    ok: true,
    decision: 'save',
    recommended_state: status ?? 'active',
    missing_fields: [],
    invalid_source_ids: [],
    active_durable: (status ?? 'active') === 'active',
    shared_visible: shared && (status ?? 'active') === 'active',
    source_validation: [],
  };
}

export async function handleMemoryRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  db,
  readBody,
  send,
  getSharedMemories,
  getMemories,
  searchMemories,
  storeMemory,
  validateSourceIds,
  deleteMemory,
  getOldUnkeyedMemories,
  memByKey,
  decorateMemoryRows = (rows) => rows,
  decorateMemoryRow = (row) => row,
  controllerScopeUserId = (id) => id,
} = {}) {
  const scopedUserId = () => {
    const explicit = searchParams.get('user_id') ?? searchParams.get('userId') ?? '';
    const controllerId = searchParams.get('controller_id') ?? searchParams.get('controllerId') ?? '';
    return explicit || (controllerId ? controllerScopeUserId(controllerId) : '');
  };

  if (method === 'GET' && path === '/memory/shared') {
    const mems = decorateMemoryRows(normalizeMemoryRows(getSharedMemories({
      q: searchParams.get('q') ?? undefined,
      tag: searchParams.get('tag') ?? undefined,
      limit: Number(searchParams.get('limit') ?? 20),
      project: searchParams.get('project') ?? '',
      taskId: searchParams.get('task_id') ?? searchParams.get('taskId') ?? '',
      sessionId: searchParams.get('session_id') ?? searchParams.get('sessionId') ?? '',
      userId: scopedUserId(),
      turnId: searchParams.get('turn_id') ?? searchParams.get('turnId') ?? '',
      includeRetired: searchParams.get('includeRetired') === 'true' || searchParams.get('include_retired') === 'true',
    })));
    send(res, 200, { memories: mems });
    return true;
  }

  let m = path.match(/^\/memory\/([^/]+)\/summarize$/);
  if (method === 'POST' && m) {
    const b = await readBody(req);
    const agentId = decodeURIComponent(m[1]);
    const dryRun = b.dryRun === true;
    const olderThanDays = Number(b.olderThanDays ?? 7);
    const keepCount = Number(b.keepCount ?? 20);
    const entries = getOldUnkeyedMemories(agentId, olderThanDays, keepCount);
    if (!dryRun) {
      const ids = entries.map(e => e.id).join(',');
      if (ids) db.prepare(`DELETE FROM agent_memories WHERE id IN (${ids})`).run();
    }
    const content = entries.map(e => `[${new Date(e.created_at * 1000).toISOString()}] ${e.content}`).join('\n');
    send(res, 200, {
      entries: entries.length,
      content,
      dryRun,
      instruction: 'Summarize the content field into a concise digest, then POST it back as a keyed memory.',
    });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)\/_old$/);
  if (method === 'DELETE' && m) {
    const agentId = decodeURIComponent(m[1]);
    const olderThanDays = Number(searchParams.get('olderThanDays') ?? 30);
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    const r = db.prepare(
      `DELETE FROM agent_memories WHERE agent_id=? AND mem_key IS NULL AND created_at < ?`
    ).run(agentId, cutoff);
    send(res, 200, { ok: true, deleted: r.changes });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)\/search$/);
  if (method === 'GET' && m) {
    const mems = decorateMemoryRows(normalizeMemoryRows(searchMemories(
      decodeURIComponent(m[1]),
      searchParams.get('q') ?? '',
      Number(searchParams.get('limit') ?? 10),
      {
        project: searchParams.get('project') ?? '',
        taskId: searchParams.get('task_id') ?? searchParams.get('taskId') ?? '',
        sessionId: searchParams.get('session_id') ?? searchParams.get('sessionId') ?? '',
        userId: scopedUserId(),
        turnId: searchParams.get('turn_id') ?? searchParams.get('turnId') ?? '',
      },
    )));
    send(res, 200, { memories: mems });
    return true;
  }

  if (method === 'POST' && path === '/memory/validate') {
    const body = await readBody(req);
    const candidate = normalizeDurableCandidate(body);
    const evaluation = evaluateDurableMemoryWrite({ body, candidate, validateSourceIds, db });
    send(res, 200, {
      ok: true,
      advisory: true,
      mode: String(body.mode ?? 'advisory').toLowerCase() || 'advisory',
      decision: evaluation.decision,
      recommended_state: evaluation.recommended_state,
      missing_fields: evaluation.missing_fields ?? [],
      invalid_source_ids: evaluation.invalid_source_ids ?? [],
      active_durable: evaluation.active_durable ?? false,
      shared_visible: evaluation.shared_visible ?? false,
      mutates: false,
      source_validation: evaluation.source_validation ?? [],
    });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)$/);
  if (method === 'GET' && m) {
    const mems = decorateMemoryRows(normalizeMemoryRows(getMemories(decodeURIComponent(m[1]), {
      limit: Number(searchParams.get('limit') ?? 20),
      offset: Number(searchParams.get('offset') ?? 0),
      tag: searchParams.get('tag') ?? undefined,
      project: searchParams.get('project') ?? '',
      taskId: searchParams.get('task_id') ?? searchParams.get('taskId') ?? '',
      sessionId: searchParams.get('session_id') ?? searchParams.get('sessionId') ?? '',
      userId: scopedUserId(),
      turnId: searchParams.get('turn_id') ?? searchParams.get('turnId') ?? '',
      includeRetired: searchParams.get('includeRetired') === 'true' || searchParams.get('include_retired') === 'true',
    })));
    send(res, 200, { memories: mems });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)$/);
  if (method === 'POST' && m) {
    const body = await readBody(req);
    if (Array.isArray(body)) {
      send(res, 400, durableValidationError(
        'durable_memory_bulk_mutation_forbidden',
        'bulk durable-memory mutation is not supported',
        { route: path, mutated_existing_count: 0 },
      ));
      return true;
    }
    if (!body.content) {
      send(res, 400, { error: 'content required' });
      return true;
    }
    const normalizedStatus = body.status == null ? null : normalizeStatus(body.status);
    if (body.status != null && !normalizedStatus) {
      send(res, 400, durableValidationError(
        'durable_memory_invalid_status',
        'invalid memory status',
        { allowed_statuses: [...DURABLE_MEMORY_STATUSES] },
      ));
      return true;
    }
    const candidate = normalizeDurableCandidate(body);
    const evaluation = evaluateDurableMemoryWrite({ body, candidate, validateSourceIds, db });
    if (String(body.mode ?? '').toLowerCase() === 'enforced' && !evaluation.ok && evaluation.error_code === 'durable_memory_validation_failed') {
      send(res, 400, durableValidationError(
        evaluation.error_code,
        evaluation.message,
        {
          decision: evaluation.decision,
          recommended_state: evaluation.recommended_state,
          missing_fields: evaluation.missing_fields ?? [],
          invalid_source_ids: evaluation.invalid_source_ids ?? [],
          mutated_existing_count: 0,
        },
      ));
      return true;
    }
    if (!evaluation.ok) {
      send(res, 400, durableValidationError(
        evaluation.error_code,
        evaluation.message,
        {
          decision: evaluation.decision,
          recommended_state: evaluation.recommended_state,
          mutated_existing_count: 0,
        },
      ));
      return true;
    }
    const finalStatus = evaluation.recommended_state === 'active'
      ? (normalizedStatus ?? 'active')
      : evaluation.recommended_state ?? normalizedStatus ?? 'active';
    const stored = storeMemory({
      agentId: decodeURIComponent(m[1]),
      ...body,
      status: finalStatus,
      durable_candidate: candidate,
    });
    send(res, 200, {
      ok: true,
      memoryId: stored.id,
      similar: stored.similar,
      decision: evaluation.decision,
      stored_status: finalStatus,
      shared_visible: body.shared === true && finalStatus === 'active',
    });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)\/(.+)$/);
  if (method === 'DELETE' && m) {
    deleteMemory(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    send(res, 200, { ok: true });
    return true;
  }

  m = path.match(/^\/memory\/([^/]+)\/(.+)$/);
  if (method === 'GET' && m) {
    const r = decorateMemoryRow(normalizeMemoryRow(memByKey.get(decodeURIComponent(m[1]), decodeURIComponent(m[2]))));
    send(res, r ? 200 : 404, r ? { memory: r } : { error: 'not found' });
    return true;
  }

  return false;
}
