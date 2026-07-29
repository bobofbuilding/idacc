import { createHash } from 'node:crypto';

import { createLearningTask } from './learning-policy.mjs';

const OPEN_TASK_STATUSES = ['queued', 'assigned', 'in_progress', 'blocked'];
const DEDUPE_TASK_STATUSES = [...OPEN_TASK_STATUSES, 'completed'];

const OWNER_ROUTES = {
  research: { team: 'research', owner_route: 'research-lead', assignee: 'research-lead' },
  engineering: { team: 'engineering-team', owner_route: 'engineering-lead', assignee: 'engineering-lead' },
  onchain: { team: 'onchain-execution', owner_route: 'onchain-lead', assignee: 'onchain-lead' },
  security: { team: 'technology-security', owner_route: 'security-router', assignee: 'security-router' },
  legal: { team: 'legal', owner_route: 'general-counsel', assignee: 'general-counsel' },
  ops: { team: 'ops-team', owner_route: 'ops-lead', assignee: 'ops-lead' },
};

const ROUTE_RULES = [
  {
    route: 'engineering',
    reason: 'skill, catalog, and marketplace implementation knowledge is owned by engineering',
    patterns: [
      /\bmarketplace\b/i,
      /\bcatalog\b/i,
      /\bplugin\b/i,
      /\bmcp\b/i,
      /\bskill(?:s| proposal| publish| revision)?\b/i,
    ],
  },
  {
    route: 'onchain',
    reason: 'wallet, contract, and treasury knowledge is owned by the onchain team',
    patterns: [
      /\bonchain\b/i,
      /\bwallet\b/i,
      /\btoken\b/i,
      /\bnft\b/i,
      /\bcontract\b/i,
      /\bsolana\b/i,
      /\brpc\b/i,
      /\balchemy\b/i,
      /\btransaction\b/i,
      /\btreasury\b/i,
      /\bcapital\b/i,
      /\bvault\b/i,
      /\baddress\b/i,
      /\bhyperliquid\b/i,
    ],
  },
  {
    route: 'security',
    reason: 'security-sensitive gaps should route to the security team',
    patterns: [
      /\bsecurity\b/i,
      /\bauth(?:entication|orization)?\b/i,
      /\bsecret(?:s)?\b/i,
      /\bcredential(?:s)?\b/i,
      /\bvuln(?:erability)?\b/i,
      /\bexploit\b/i,
      /\bpermission(?:s)?\b/i,
      /\bpolicy\b/i,
      /\bsandbox\b/i,
    ],
  },
  {
    route: 'legal',
    reason: 'policy, privacy, and legal gaps belong with legal review',
    patterns: [
      /\blegal\b/i,
      /\bprivacy\b/i,
      /\bterms\b/i,
      /\blicen[sc]e\b/i,
      /\bcompliance\b/i,
      /\bgdpr\b/i,
      /\bcontract law\b/i,
    ],
  },
  {
    route: 'ops',
    reason: 'runtime, deployment, and scheduler gaps belong with operations',
    patterns: [
      /\bops\b/i,
      /\bscheduler\b/i,
      /\bdeploy(?:ment)?\b/i,
      /\bruntime\b/i,
      /\blaunchd\b/i,
      /\bmonitor(?:ing)?\b/i,
      /\bincident\b/i,
      /\bservice\b/i,
      /\bworker\b/i,
      /\bheartbeat\b/i,
    ],
  },
  {
    route: 'engineering',
    reason: 'product and code implementation gaps belong with engineering',
    patterns: [
      /\bengineering\b/i,
      /\bfrontend\b/i,
      /\bbackend\b/i,
      /\breact\b/i,
      /\btypescript\b/i,
      /\bjavascript\b/i,
      /\bnode\b/i,
      /\bapi\b/i,
      /\broute\b/i,
      /\bbuild\b/i,
      /\btest\b/i,
      /\bui\b/i,
      /\brepo\b/i,
      /\bserver\b/i,
    ],
  },
];

const EXPLICIT_SOURCE_ROUTES = [
  { regex: /\b(entity|memory|fact|text):(?:repo|project):(?:skills?|catalog|marketplace)\b/i, route: 'engineering', reason: 'explicit capability project source id' },
  { regex: /\b(entity|memory|fact|text):(?:repo|project):(?:capital|treasury|vault)\b/i, route: 'onchain', reason: 'explicit treasury/onchain project source id' },
  { regex: /\b(entity|memory|fact|text):(?:repo|project):(?:app|client|manager|service)\b/i, route: 'engineering', reason: 'explicit engineering project source id' },
  { regex: /\b(entity|memory|fact|text):(?:repo|project):(?:brain|knowledge|research)\b/i, route: 'research', reason: 'explicit research project source id' },
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function compactText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function descriptorHash(value = '') {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

function signalDescriptor({ taskId = '', queryId = '', queryText = '', canonicalSourceIds = [], fallback = '' } = {}) {
  if (taskId) return `task:${taskId}`;
  if (queryId) return `query:${queryId}`;
  if (queryText) return `query-text:${descriptorHash(compactText(queryText).toLowerCase())}`;
  if (canonicalSourceIds.length) return `sources:${descriptorHash(canonicalSourceIds.join('|'))}`;
  return `signal:${descriptorHash(fallback || 'unknown')}`;
}

function recentTaskSignalKeys(db, { since = 0 } = {}) {
  const rows = db.prepare(`
    SELECT subject, status, payload
    FROM learning_tasks
    WHERE kind='knowledge.gap.research'
      AND status IN (${DEDUPE_TASK_STATUSES.map(() => '?').join(',')})
      AND created_at >= ?
  `).all(...DEDUPE_TASK_STATUSES, since);
  const keys = new Map();
  for (const row of rows) {
    const payload = parseJson(row.payload, {});
    if (payload.signal_key) keys.set(String(payload.signal_key), row.status);
    if (row.subject) keys.set(String(row.subject), row.status);
  }
  return keys;
}

function inferOwnerRoute({
  queryText = '',
  query_text = '',
  canonicalSourceIds = [],
  canonical_source_ids = [],
  sourceOrigins = {},
  source_origins = {},
} = {}) {
  const resolvedQueryText = queryText || query_text;
  const resolvedSourceIds = canonicalSourceIds.length ? canonicalSourceIds : canonical_source_ids;
  const resolvedSourceOrigins = Object.keys(sourceOrigins).length ? sourceOrigins : source_origins;
  const haystack = compactText([
    resolvedQueryText,
    resolvedSourceIds.join(' '),
    Object.entries(resolvedSourceOrigins).map(([sourceId, origins]) => `${sourceId} ${asArray(origins).join(' ')}`).join(' '),
  ].join(' '));

  for (const hint of EXPLICIT_SOURCE_ROUTES) {
    if (hint.regex.test(haystack)) {
      return {
        ...OWNER_ROUTES[hint.route],
        route_key: hint.route,
        routing_reason: hint.reason,
      };
    }
  }

  let best = { route: 'research', score: 0, reason: 'default research fallback for uncategorized knowledge gaps' };
  for (const rule of ROUTE_RULES) {
    const score = rule.patterns.reduce((total, pattern) => total + (pattern.test(haystack) ? 1 : 0), 0);
    if (score > best.score) {
      best = { route: rule.route, score, reason: rule.reason };
    }
  }

  return {
    ...OWNER_ROUTES[best.route],
    route_key: best.route,
    routing_reason: best.reason,
  };
}

function priorityForAggregate(signal = {}) {
  const base = signal.signal_types.includes('feedback_missing') ? 4 : 2;
  const zeroAcceptance = signal.min_precision === 0 ? 2 : 0;
  return Math.max(1, Math.min(10, base + zeroAcceptance + Math.min(signal.signal_count ?? 1, 4)));
}

function buildFeedbackMissingSignals(db, {
  since,
  limit,
} = {}) {
  const rows = db.prepare(`
    SELECT id, subject, data, created_at
    FROM timeline
    WHERE type='context:feedback-missing' AND created_at >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(since, limit);

  return rows.map((row) => {
    const data = parseJson(row.data, {});
    const canonicalSourceIds = uniqueStrings(data.canonical_source_ids);
    return {
      signal_type: 'feedback_missing',
      task_id: String(data.task_id ?? ''),
      query_id: String(data.query_id ?? ''),
      query_text: compactText(data.query_text ?? ''),
      canonical_source_ids: canonicalSourceIds,
      source_origins: data.source_origins && typeof data.source_origins === 'object' ? data.source_origins : {},
      volunteered_source_ids: canonicalSourceIds,
      accepted_ids: [],
      precision: 0,
      evidence: { timeline_event_ids: [Number(row.id)] },
      created_at: Number(row.created_at ?? 0),
      fallback: `timeline:${row.id}`,
    };
  }).filter((row) => row.canonical_source_ids.length || row.query_text);
}

function buildLowConfidenceEvalSignals(db, {
  since,
  limit,
  lowPrecisionThreshold,
} = {}) {
  const rows = db.prepare(`
    SELECT id, query_text, agent_id, task_id, accepted_ids, volunteered_source_ids, metadata, created_at
    FROM eval_queries
    WHERE created_at >= ? AND volunteered_source_ids != '[]'
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(since, limit);

  const signals = [];
  for (const row of rows) {
    const acceptedIds = uniqueStrings(parseJson(row.accepted_ids, []));
    const volunteeredSourceIds = uniqueStrings(parseJson(row.volunteered_source_ids, []));
    if (!volunteeredSourceIds.length) continue;
    const acceptedSet = new Set(acceptedIds);
    const used = volunteeredSourceIds.filter((sourceId) => acceptedSet.has(sourceId)).length;
    const precision = volunteeredSourceIds.length ? Math.round((used / volunteeredSourceIds.length) * 1000) / 1000 : null;
    if (precision == null || precision > lowPrecisionThreshold) continue;
    const metadata = parseJson(row.metadata, {});
    signals.push({
      signal_type: 'low_confidence_eval',
      task_id: String(row.task_id ?? ''),
      query_id: '',
      query_text: compactText(row.query_text ?? ''),
      canonical_source_ids: volunteeredSourceIds,
      source_origins: metadata.source_origins && typeof metadata.source_origins === 'object' ? metadata.source_origins : {},
      volunteered_source_ids: volunteeredSourceIds,
      accepted_ids: acceptedIds,
      precision,
      evidence: { eval_query_ids: [Number(row.id)] },
      created_at: Number(row.created_at ?? 0),
      fallback: `eval:${row.id}`,
    });
  }
  return signals;
}

function aggregateSignals(signals = []) {
  const aggregates = new Map();
  for (const signal of signals) {
    const owner = inferOwnerRoute(signal);
    const descriptor = signalDescriptor({
      taskId: signal.task_id,
      queryId: signal.query_id,
      queryText: signal.query_text,
      canonicalSourceIds: signal.canonical_source_ids,
      fallback: signal.fallback,
    });
    const signalKey = `${owner.owner_route}:${descriptor}`;
    const current = aggregates.get(signalKey) ?? {
      signal_key: signalKey,
      descriptor,
      subject: signalKey,
      route: owner,
      signal_types: [],
      signal_count: 0,
      query_texts: [],
      canonical_source_ids: [],
      volunteered_source_ids: [],
      accepted_ids: [],
      task_ids: [],
      query_ids: [],
      source_origins: {},
      timeline_event_ids: [],
      eval_query_ids: [],
      min_precision: null,
      latest_created_at: 0,
      routing_reason: owner.routing_reason,
    };
    current.signal_types = uniqueStrings([...current.signal_types, signal.signal_type]);
    current.signal_count += 1;
    current.query_texts = uniqueStrings([...current.query_texts, signal.query_text]);
    current.canonical_source_ids = uniqueStrings([...current.canonical_source_ids, ...signal.canonical_source_ids]);
    current.volunteered_source_ids = uniqueStrings([...current.volunteered_source_ids, ...signal.volunteered_source_ids]);
    current.accepted_ids = uniqueStrings([...current.accepted_ids, ...signal.accepted_ids]);
    current.task_ids = uniqueStrings([...current.task_ids, signal.task_id]);
    current.query_ids = uniqueStrings([...current.query_ids, signal.query_id]);
    current.latest_created_at = Math.max(current.latest_created_at, Number(signal.created_at ?? 0));
    if (signal.precision != null) {
      current.min_precision = current.min_precision == null ? signal.precision : Math.min(current.min_precision, signal.precision);
    }
    current.timeline_event_ids = [...new Set([...current.timeline_event_ids, ...asArray(signal.evidence?.timeline_event_ids).map(Number).filter(Number.isInteger)])];
    current.eval_query_ids = [...new Set([...current.eval_query_ids, ...asArray(signal.evidence?.eval_query_ids).map(Number).filter(Number.isInteger)])];
    for (const [sourceId, origins] of Object.entries(signal.source_origins ?? {})) {
      current.source_origins[sourceId] = uniqueStrings([...(current.source_origins[sourceId] ?? []), ...asArray(origins)]);
    }
    aggregates.set(signalKey, current);
  }
  return [...aggregates.values()];
}

function gapPayload(aggregate = {}, {
  detectorSource,
  lowPrecisionThreshold,
} = {}) {
  return {
    signal_key: aggregate.signal_key,
    signal_types: aggregate.signal_types,
    detector: {
      source: detectorSource,
      low_precision_threshold: lowPrecisionThreshold,
      latest_created_at: aggregate.latest_created_at,
      signal_count: aggregate.signal_count,
      min_precision: aggregate.min_precision,
    },
    route: aggregate.route,
    query_texts: aggregate.query_texts,
    task_ids: aggregate.task_ids,
    query_ids: aggregate.query_ids,
    canonical_source_ids: aggregate.canonical_source_ids,
    volunteered_source_ids: aggregate.volunteered_source_ids,
    accepted_ids: aggregate.accepted_ids,
    source_origins: aggregate.source_origins,
    routing_reason: aggregate.routing_reason,
    recommended_action: 'Research the missing knowledge, validate the sources, and save reusable findings back into Brain.',
  };
}

export function detectKnowledgeGapSignals(db, {
  days = Number(process.env.BRAIN_GAP_DETECTOR_DAYS ?? 14),
  feedbackLimit = Number(process.env.BRAIN_GAP_DETECTOR_FEEDBACK_LIMIT ?? 200),
  evalLimit = Number(process.env.BRAIN_GAP_DETECTOR_EVAL_LIMIT ?? 200),
  lowPrecisionThreshold = Number(process.env.BRAIN_GAP_DETECTOR_LOW_PRECISION_THRESHOLD ?? 0.2),
  maxCreate = Number(process.env.BRAIN_GAP_DETECTOR_MAX_CREATE ?? 25),
  source = 'brain-gap-detector',
  create = true,
} = {}) {
  const safeDays = Math.max(1, Number(days) || 14);
  const since = Math.floor(Date.now() / 1000) - (safeDays * 86400);
  const safeLowPrecisionThreshold = Math.max(0, Math.min(1, Number(lowPrecisionThreshold) || 0.2));
  const safeMaxCreate = Math.max(0, Math.min(100, Math.floor(Number(maxCreate) || 25)));
  const feedbackSignals = buildFeedbackMissingSignals(db, { since, limit: Math.max(1, Number(feedbackLimit) || 200) });
  const lowConfidenceSignals = buildLowConfidenceEvalSignals(db, {
    since,
    limit: Math.max(1, Number(evalLimit) || 200),
    lowPrecisionThreshold: safeLowPrecisionThreshold,
  });
  const aggregates = aggregateSignals([...feedbackSignals, ...lowConfidenceSignals])
    .sort((a, b) => (b.signal_count - a.signal_count) || (b.latest_created_at - a.latest_created_at));
  const priorSignals = recentTaskSignalKeys(db, { since });
  const created = [];
  const skipped = [];

  for (const aggregate of aggregates) {
    if (created.length >= safeMaxCreate) {
      skipped.push({ signal_key: aggregate.signal_key, reason: 'over_cap' });
      continue;
    }
    const priorStatus = priorSignals.get(aggregate.signal_key) ?? priorSignals.get(aggregate.subject);
    if (priorStatus) {
      skipped.push({
        signal_key: aggregate.signal_key,
        reason: priorStatus === 'completed' ? 'completed_task_exists' : 'open_task_exists',
        status: priorStatus,
      });
      continue;
    }
    const payload = gapPayload(aggregate, {
      detectorSource: source,
      lowPrecisionThreshold: safeLowPrecisionThreshold,
    });
    const taskData = {
      kind: 'knowledge.gap.research',
      subject: aggregate.subject,
      assignee: aggregate.route.assignee,
      priority: priorityForAggregate(aggregate),
      evidence_ids: {
        timeline_event_ids: aggregate.timeline_event_ids,
        eval_query_ids: aggregate.eval_query_ids,
      },
      payload,
    };
    if (!create) {
      created.push({ dry_run: true, task: taskData });
      continue;
    }
    const taskId = createLearningTask(db, {
      kind: taskData.kind,
      subject: taskData.subject,
      assignee: taskData.assignee,
      priority: taskData.priority,
      evidenceIds: taskData.evidence_ids,
      payload: taskData.payload,
    });
    const task = db.prepare(`SELECT * FROM learning_tasks WHERE id=?`).get(taskId);
    created.push({
      id: taskId,
      ...taskData,
      task,
    });
    priorSignals.set(aggregate.signal_key, 'queued');
    priorSignals.set(aggregate.subject, 'queued');
  }

  return {
    window_days: safeDays,
    low_precision_threshold: safeLowPrecisionThreshold,
    scanned: {
      feedback_missing: feedbackSignals.length,
      low_confidence_eval: lowConfidenceSignals.length,
      candidates: aggregates.length,
    },
    created,
    skipped,
  };
}
