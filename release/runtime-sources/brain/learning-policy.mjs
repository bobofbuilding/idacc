import { canonicalSourceIds, sourceIssues, sourceRow } from './sources.mjs';

export function parseLearningTask(row, parseJson) {
  return {
    ...row,
    evidence_ids: parseJson(row.evidence_ids, {}),
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, {}),
  };
}

export function parseRollbackRecord(row, parseJson) {
  return {
    ...row,
    before_state: parseJson(row.before_state, {}),
    after_state: parseJson(row.after_state, {}),
    metadata: parseJson(row.metadata, {}),
  };
}

export function createLearningTask(db, {
  kind,
  subject = '',
  approvalId = null,
  assignee = '',
  status = 'queued',
  priority = 0,
  evidenceIds = {},
  payload = {},
  result = {},
  idempotencyKey = null,
  idempotencyHash = null,
} = {}) {
  const r = db.prepare(`
    INSERT INTO learning_tasks
      (kind, subject, approval_id, assignee, status, priority, evidence_ids, payload, result, idempotency_key, idempotency_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    subject,
    approvalId,
    assignee,
    status,
    priority,
    JSON.stringify(evidenceIds ?? {}),
    JSON.stringify(payload ?? {}),
    JSON.stringify(result ?? {}),
    idempotencyKey,
    idempotencyHash,
  );
  return Number(r.lastInsertRowid);
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeRetryThresholds(value = '') {
  const defaults = {
    default: Number(process.env.BRAIN_LEARNING_TASK_RETRY_THRESHOLD ?? 3),
    'citation.repair': 3,
    'source.refresh': 2,
    'source.mark_stale': 2,
    'proposal.reject': 2,
    'correction.pattern': 3,
    'skill.revision': 3,
    'knowledge.gap.research': 3,
  };
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value);
    for (const [kind, threshold] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      const n = Number(threshold);
      if (Number.isFinite(n) && n > 0) defaults[kind] = Math.floor(n);
    }
  } catch {
    for (const part of String(value).split(',')) {
      const [kind, threshold] = part.split(':').map(s => s?.trim());
      const n = Number(threshold);
      if (kind && Number.isFinite(n) && n > 0) defaults[kind] = Math.floor(n);
    }
  }
  return defaults;
}

function retryThresholdFor(kind, thresholds = normalizeRetryThresholds(process.env.BRAIN_LEARNING_TASK_RETRY_THRESHOLDS ?? '')) {
  return Number(thresholds[kind] ?? thresholds.default ?? 3);
}

function insertTimeline(db, { source = 'learning-policy', type, subject = '', data = {}, tags = [] }) {
  const r = db.prepare(`
    INSERT INTO timeline (source, type, subject, data, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, type, subject, JSON.stringify(data ?? {}), JSON.stringify(tags ?? []));
  return Number(r.lastInsertRowid);
}

function pendingEscalationExists(db, taskId) {
  const row = db.prepare(`
    SELECT id FROM approvals
    WHERE kind='learning-task.escalate' AND subject=? AND status='pending'
    LIMIT 1
  `).get(String(taskId));
  return !!row;
}

function createEscalationApproval(db, task, payload, retryThreshold, source) {
  if (pendingEscalationExists(db, task.id)) return null;
  const r = db.prepare(`
    INSERT INTO approvals (kind, subject, payload, risk_level, requested_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'learning-task.escalate',
    String(task.id),
    JSON.stringify({
      learning_task_id: task.id,
      kind: task.kind,
      subject: task.subject,
      assignee: task.assignee,
      retry_count: Number(payload.retry_count ?? 0),
      retry_threshold: retryThreshold,
      lease_expires_at: payload.lease_expires_at ?? null,
      evidence_ids: safeJson(task.evidence_ids, {}),
      task_payload: payload,
      suggested_reason: `Learning task ${task.id} exceeded retry threshold ${retryThreshold}.`,
    }),
    'medium',
    source,
  );
  return Number(r.lastInsertRowid);
}

export function recoverExpiredLearningTaskLeases(db, {
  now = nowSeconds(),
  limit = 100,
  source = 'learning-policy',
  retryThresholds = normalizeRetryThresholds(process.env.BRAIN_LEARNING_TASK_RETRY_THRESHOLDS ?? ''),
} = {}) {
  const rows = db.prepare(`
    SELECT * FROM learning_tasks
    WHERE status IN ('assigned','in_progress')
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(Math.max(Number(limit) || 100, 1));
  const recovered = [];
  const escalated = [];
  const expired = [];

  for (const row of rows) {
    const payload = safeJson(row.payload, {});
    const leaseExpiresAt = Number(payload.lease_expires_at ?? 0);
    if (!leaseExpiresAt || leaseExpiresAt >= now) continue;

    const retryCount = Number(payload.retry_count ?? 0) + 1;
    const threshold = retryThresholdFor(row.kind, retryThresholds);
    const nextPayload = {
      ...payload,
      retry_count: retryCount,
      previous_assignee: row.assignee || payload.claimed_by || '',
      expired_at: now,
      last_expired_lease_expires_at: leaseExpiresAt,
    };
    delete nextPayload.claimed_by;
    delete nextPayload.claimed_at;
    delete nextPayload.lease_expires_at;

    insertTimeline(db, {
      source,
      type: 'learning-task:expired',
      subject: String(row.id),
      data: { id: row.id, kind: row.kind, subject: row.subject, assignee: row.assignee, retry_count: retryCount, retry_threshold: threshold, lease_expires_at: leaseExpiresAt },
      tags: ['learning-task', 'lease', 'expired'],
    });
    expired.push({ id: row.id, kind: row.kind, retry_count: retryCount, retry_threshold: threshold });

    if (retryCount >= threshold) {
      const approvalId = createEscalationApproval(db, row, nextPayload, threshold, source);
      db.prepare(`
        UPDATE learning_tasks
        SET status='blocked', assignee='', payload=?, updated_at=unixepoch()
        WHERE id=? AND status IN ('assigned','in_progress')
      `).run(JSON.stringify({
        ...nextPayload,
        blocked_reason: `retry threshold ${threshold} exceeded`,
        escalation_approval_id: approvalId ?? payload.escalation_approval_id ?? null,
      }), row.id);
      insertTimeline(db, {
        source,
        type: 'learning-task:escalated',
        subject: String(row.id),
        data: { id: row.id, kind: row.kind, subject: row.subject, retry_count: retryCount, retry_threshold: threshold, approval_id: approvalId },
        tags: ['learning-task', 'escalated'],
      });
      escalated.push({ id: row.id, kind: row.kind, retry_count: retryCount, retry_threshold: threshold, approval_id: approvalId });
    } else {
      db.prepare(`
        UPDATE learning_tasks
        SET status='queued', assignee='', payload=?, updated_at=unixepoch()
        WHERE id=? AND status IN ('assigned','in_progress')
      `).run(JSON.stringify(nextPayload), row.id);
      insertTimeline(db, {
        source,
        type: 'learning-task:requeued',
        subject: String(row.id),
        data: { id: row.id, kind: row.kind, subject: row.subject, retry_count: retryCount, retry_threshold: threshold },
        tags: ['learning-task', 'requeued'],
      });
      recovered.push({ id: row.id, kind: row.kind, retry_count: retryCount, retry_threshold: threshold });
    }
  }

  return { expired, recovered, escalated };
}

export function recordLearningRollback(db, {
  approvalId = null,
  kind,
  subject = '',
  inverseAction,
  beforeState = {},
  afterState = {},
  metadata = {},
  createdBy = 'brain',
} = {}) {
  const r = db.prepare(`
    INSERT INTO learning_rollback_records
      (approval_id, kind, subject, inverse_action, before_state, after_state, metadata, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    approvalId,
    kind,
    subject,
    inverseAction,
    JSON.stringify(beforeState ?? {}),
    JSON.stringify(afterState ?? {}),
    JSON.stringify(metadata ?? {}),
    createdBy,
  );
  return Number(r.lastInsertRowid);
}

export const CORRECTION_PATTERNS = [
  {
    class: 'wrong_path',
    label: 'Wrong path',
    priority: 70,
    regex: /\b(no such file|enoent|wrong path|path .*not found|cannot find .*file|file not found)\b/i,
    instruction: 'Verify project-relative paths with rg --files or ls before acting on them, and include the confirmed path in task notes when a correction is needed.',
  },
  {
    class: 'stale_route',
    label: 'Stale route',
    priority: 75,
    regex: /\b(404|not found|route skew|stale route|endpoint .*missing|unknown endpoint)\b/i,
    instruction: 'Check /health routeInventory or the local router before relying on Brain API routes, and update stale route references when they are corrected.',
  },
  {
    class: 'wrong_command',
    label: 'Wrong command',
    priority: 65,
    regex: /\b(command not found|unknown command|invalid option|usage:|wrong command|bad flag)\b/i,
    instruction: 'Validate command syntax against package scripts, local help output, or existing operator tools before repeating a failed command.',
  },
  {
    class: 'missing_env',
    label: 'Missing environment',
    priority: 80,
    regex: /\b(missing env|environment variable|required env|api key|private key|token required|unauthorized|forbidden)\b/i,
    instruction: 'Check required environment variables and secret prerequisites before running tools that touch providers, deployments, wallets, or authenticated APIs.',
  },
  {
    class: 'missing_source_feedback',
    label: 'Missing source feedback',
    priority: 60,
    regex: /\b(missing source|uncited|citation|source id|unsupported summary|needs provenance|no evidence)\b/i,
    instruction: 'Attach concrete Brain source IDs or explain why no source exists before promoting learned facts, summaries, skill gaps, or recommendations.',
  },
  {
    class: 'deploy_failure',
    label: 'Deploy failure',
    priority: 85,
    regex: /\b(deploy failed|deployment failed|build failed|vercel failed|readiness gate failed|health check failed|rollback)\b/i,
    instruction: 'For deployment work, run the readiness gate and capture failing check names, logs, and rollback steps before marking the task complete.',
  },
  {
    class: 'repeated_denied_action',
    label: 'Repeated denied action',
    priority: 90,
    regex: /\b(denied|rejected|not approved|approval required|blocked by policy|do not run|permission denied)\b/i,
    instruction: 'When an action is denied or requires approval, stop repeating it and open or reference the relevant approval before continuing.',
  },
];

function parseJson(value, fallback = {}) {
  return safeJson(value, fallback);
}

function eventText(event) {
  const data = typeof event.data === 'string' ? parseJson(event.data, {}) : (event.data ?? {});
  const tags = typeof event.tags === 'string' ? parseJson(event.tags, []) : (event.tags ?? []);
  return [
    event.source,
    event.type,
    event.subject,
    data.message,
    data.error,
    data.reason,
    data.command,
    data.path,
    data.route,
    data.check,
    data.status,
    Array.isArray(tags) ? tags.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function eventGroupKey(event) {
  const data = typeof event.data === 'string' ? parseJson(event.data, {}) : (event.data ?? {});
  return String(
    data.task_id ?? data.taskId ??
    data.query_id ?? data.queryId ??
    data.check_id ?? data.checkId ??
    data.run_id ?? data.runId ??
    data.session_id ?? data.sessionId ??
    event.subject ??
    event.source ??
    'global'
  );
}

function classifyCorrectionEvent(event) {
  const text = eventText(event);
  return CORRECTION_PATTERNS.filter(pattern => pattern.regex.test(text));
}

function pendingLearningTaskExists(db, { kind, subject, correctionClass }) {
  const rows = db.prepare(`
    SELECT payload FROM learning_tasks
    WHERE kind=? AND subject=? AND status IN ('queued','assigned','in_progress','blocked')
    LIMIT 50
  `).all(kind, subject);
  return rows.some(row => parseJson(row.payload, {}).correction_class === correctionClass);
}

function recentLearningTaskExists(db, { kind, subject, correctionClass, since }) {
  const rows = db.prepare(`
    SELECT payload FROM learning_tasks
    WHERE kind=? AND subject=? AND created_at >= ?
    LIMIT 100
  `).all(kind, subject, since);
  return rows.some(row => parseJson(row.payload, {}).correction_class === correctionClass);
}

function pendingApprovalExists(db, { kind, subject, correctionClass }) {
  const rows = db.prepare(`
    SELECT payload FROM approvals
    WHERE kind=? AND subject=? AND status='pending'
    LIMIT 50
  `).all(kind, subject);
  return rows.some(row => parseJson(row.payload, {}).correction_class === correctionClass);
}

function recentApprovalExists(db, { kind, subject, correctionClass, since }) {
  const rows = db.prepare(`
    SELECT payload FROM approvals
    WHERE kind=? AND subject=? AND created_at >= ?
    LIMIT 100
  `).all(kind, subject, since);
  return rows.some(row => parseJson(row.payload, {}).correction_class === correctionClass);
}

function normalizeThresholds(thresholds = {}) {
  const out = {};
  for (const [key, value] of Object.entries(thresholds && typeof thresholds === 'object' ? thresholds : {})) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}

export function mineCorrectionPatterns(db, {
  days = 14,
  limit = 1000,
  threshold = 2,
  thresholds = {},
  cooldownDays = 7,
  source = 'mine-corrections',
  create = false,
} = {}) {
  const since = Math.floor(Date.now() / 1000) - Math.max(Number(days) || 14, 1) * 86400;
  const cooldownSince = Math.floor(Date.now() / 1000) - Math.max(Number(cooldownDays) || 7, 0) * 86400;
  const perClassThresholds = normalizeThresholds(thresholds);
  const rows = db.prepare(`
    SELECT * FROM timeline
    WHERE created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(since, Math.max(Number(limit) || 1000, 1));

  const groups = new Map();
  for (const row of rows) {
    for (const pattern of classifyCorrectionEvent(row)) {
      const groupKey = eventGroupKey(row);
      const key = `${pattern.class}:${groupKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          correction_class: pattern.class,
          label: pattern.label,
          subject: groupKey,
          count: 0,
          priority: pattern.priority,
          evidence_timeline_ids: [],
          first_seen: row.created_at,
          last_seen: row.created_at,
          proposed_instruction: pattern.instruction,
          sample_messages: [],
          learning_task_id: null,
          approval_id: null,
          skipped_reason: '',
        });
      }
      const group = groups.get(key);
      group.count++;
      group.first_seen = Math.min(group.first_seen, row.created_at);
      group.last_seen = Math.max(group.last_seen, row.created_at);
      group.evidence_timeline_ids.push(row.id);
      if (group.sample_messages.length < 3) group.sample_messages.push(eventText(row).slice(0, 500));
    }
  }

  const candidates = [...groups.values()]
    .filter(group => group.count >= Math.max(perClassThresholds[group.correction_class] ?? Number(threshold) ?? 2, 1))
    .sort((a, b) => b.priority - a.priority || b.count - a.count || b.last_seen - a.last_seen);

  if (!create) return { candidates, created: [] };

  const created = [];
  for (const candidate of candidates) {
    const kind = 'correction.pattern';
    if (pendingLearningTaskExists(db, { kind, subject: candidate.subject, correctionClass: candidate.correction_class })) {
      candidate.skipped_reason = 'pending learning task exists';
      continue;
    }
    if (recentLearningTaskExists(db, { kind, subject: candidate.subject, correctionClass: candidate.correction_class, since: cooldownSince })) {
      candidate.skipped_reason = 'cooldown learning task exists';
      continue;
    }
    const approvalKind = 'team.instruction.update';
    let approvalId = null;
    if (!pendingApprovalExists(db, { kind: approvalKind, subject: candidate.subject, correctionClass: candidate.correction_class })) {
      if (recentApprovalExists(db, { kind: approvalKind, subject: candidate.subject, correctionClass: candidate.correction_class, since: cooldownSince })) {
        candidate.skipped_reason = 'cooldown approval exists';
        continue;
      }
      const approval = db.prepare(`
        INSERT INTO approvals (kind, subject, payload, risk_level, requested_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        approvalKind,
        candidate.subject,
        JSON.stringify({
          correction_class: candidate.correction_class,
          label: candidate.label,
          proposed_instruction: candidate.proposed_instruction,
          evidence_timeline_ids: candidate.evidence_timeline_ids,
          sample_messages: candidate.sample_messages,
          suggested_reason: `${candidate.label} appeared ${candidate.count} times in the last ${days} day(s).`,
        }),
        candidate.priority >= 85 ? 'high' : 'medium',
        source,
      );
      approvalId = Number(approval.lastInsertRowid);
    }
    const taskId = createLearningTask(db, {
      kind,
      subject: candidate.subject,
      approvalId,
      priority: candidate.priority + candidate.count,
      evidenceIds: { timeline_event_ids: candidate.evidence_timeline_ids },
      payload: {
        correction_class: candidate.correction_class,
        label: candidate.label,
        proposed_instruction: candidate.proposed_instruction,
        sample_messages: candidate.sample_messages,
        approval_kind: approvalKind,
      },
    });
    candidate.learning_task_id = taskId;
    candidate.approval_id = approvalId;
    created.push(candidate);
  }

  return { candidates, created };
}

function updateSource(db, sourceId, action, { reason = '', source = 'learning-policy', approvalId = null } = {}) {
  const found = sourceRow(db, sourceId);
  if (!found) throw Object.assign(new Error(`source not found: ${sourceId}`), { status: 400 });
  const before = found.row;
  if (action === 'refresh') {
    if (found.kind === 'entity') db.prepare(`UPDATE entities SET status=COALESCE(NULLIF(status,''),'active'), updated_at=unixepoch() WHERE id=?`).run(found.key);
    else if (found.kind === 'fact') db.prepare(`UPDATE facts SET status='active', observed_at=unixepoch() WHERE id=?`).run(found.key);
    else if (found.kind === 'text') {
      const metadata = { ...safeJson(before.metadata, {}), refreshed_by: source, refreshed_reason: reason };
      if (metadata.status === 'stale') delete metadata.status;
      db.prepare(`UPDATE text_units SET metadata=?, updated_at=unixepoch() WHERE id=?`).run(JSON.stringify(metadata), found.key);
    } else if (found.kind === 'memory') db.prepare(`UPDATE agent_memories SET status='active', expires_at=NULL WHERE id=?`).run(found.key);
  } else if (action === 'mark_stale') {
    if (found.kind === 'entity') db.prepare(`UPDATE entities SET status='stale', updated_at=unixepoch() WHERE id=?`).run(found.key);
    else if (found.kind === 'fact') db.prepare(`UPDATE facts SET status='stale', observed_at=unixepoch() WHERE id=?`).run(found.key);
    else if (found.kind === 'text') {
      const metadata = { ...safeJson(before.metadata, {}), status: 'stale', stale_reason: reason, marked_stale_by: source };
      db.prepare(`UPDATE text_units SET metadata=?, updated_at=unixepoch() WHERE id=?`).run(JSON.stringify(metadata), found.key);
    } else if (found.kind === 'memory') db.prepare(`UPDATE agent_memories SET status='stale' WHERE id=?`).run(found.key);
  } else {
    throw Object.assign(new Error(`unsupported source action: ${action}`), { status: 400 });
  }
  const after = sourceRow(db, sourceId)?.row ?? {};
  const rollbackId = recordLearningRollback(db, {
    approvalId,
    kind: `source.${action}`,
    subject: sourceId,
    inverseAction: action === 'refresh' ? 'restore_source_state' : 'restore_source_state',
    beforeState: before,
    afterState: after,
    metadata: { reason, source },
    createdBy: source,
  });
  return { source_id: sourceId, kind: found.kind, rollback_id: rollbackId, before, after };
}

function retryHeldProposal(db, task, sourceIds, { source = 'learning-policy' } = {}) {
  const validation = canonicalSourceIds(sourceIds).map(id => sourceIssues(db, id));
  const invalid = validation.filter(row => !row.valid);
  const type = invalid.length ? 'skill:proposal-retry-blocked' : 'skill:proposal-retry-ready';
  insertTimeline(db, {
    source,
    type,
    subject: task.subject,
    data: {
      learning_task_id: task.id,
      gap: task.subject,
      checked_source_ids: validation.map(row => row.source_id),
      invalid,
      citation_validation: { valid: invalid.length === 0, sources: validation, invalid },
    },
    tags: ['skill', 'proposal', 'citation', invalid.length ? 'blocked' : 'ready'],
  });
  return { retry: { ready: invalid.length === 0, invalid, checked: validation.length } };
}

export function completeLearningTask(db, taskRow, result = {}, {
  source = 'learning-policy',
  parseJson: parse = safeJson,
} = {}) {
  const task = typeof taskRow.payload === 'string' ? parseLearningTask(taskRow, parse) : taskRow;
  const taskResult = result && typeof result === 'object' ? result : {};
  const payload = task.payload ?? {};
  const reason = String(taskResult.reason ?? taskResult.summary ?? payload.suggested_reason ?? '').slice(0, 2000);
  const applied = [];

  if (task.kind === 'citation.repair') {
    const repairedIds = canonicalSourceIds(
      taskResult.repaired_source_ids ?? taskResult.repairedSourceIds ??
      taskResult.valid_source_ids ?? taskResult.validSourceIds ??
      taskResult.source_ids ?? taskResult.sourceIds ?? payload.invalid_source_ids ?? []
    );
    if (!repairedIds.length) throw Object.assign(new Error('citation.repair requires repaired_source_ids or source_ids'), { status: 400 });
    const validation = repairedIds.map(id => sourceIssues(db, id));
    const invalid = validation.filter(row => !row.valid);
    if (invalid.length) throw Object.assign(new Error('citation.repair sources are still invalid'), { status: 400, details: invalid });
    insertTimeline(db, {
      source,
      type: 'citation:repaired',
      subject: task.subject,
      data: { learning_task_id: task.id, repaired_source_ids: repairedIds, reason },
      tags: ['citation', 'repaired', 'learning-task'],
    });
    applied.push({ action: 'citation.repair', source_ids: repairedIds });
    applied.push(retryHeldProposal(db, task, repairedIds, { source }));
  } else if (task.kind === 'source.refresh') {
    const sourceIds = canonicalSourceIds(taskResult.source_ids ?? taskResult.sourceIds ?? taskResult.refreshed_source_ids ?? taskResult.refreshedSourceIds ?? payload.invalid_source_ids ?? []);
    if (!sourceIds.length) throw Object.assign(new Error('source.refresh requires source_ids'), { status: 400 });
    const refreshed = sourceIds.map(id => updateSource(db, id, 'refresh', { reason, source, approvalId: task.approval_id }));
    insertTimeline(db, {
      source,
      type: 'source:refreshed',
      subject: task.subject,
      data: { learning_task_id: task.id, source_ids: sourceIds, rollback_ids: refreshed.map(row => row.rollback_id), reason },
      tags: ['source', 'refreshed', 'learning-task'],
    });
    applied.push({ action: 'source.refresh', sources: refreshed.map(({ source_id, rollback_id }) => ({ source_id, rollback_id })) });
    applied.push(retryHeldProposal(db, task, sourceIds, { source }));
  } else if (task.kind === 'source.mark_stale') {
    const sourceIds = canonicalSourceIds(taskResult.source_ids ?? taskResult.sourceIds ?? taskResult.stale_source_ids ?? taskResult.staleSourceIds ?? payload.invalid_source_ids ?? []);
    if (!sourceIds.length) throw Object.assign(new Error('source.mark_stale requires source_ids'), { status: 400 });
    const marked = sourceIds.map(id => updateSource(db, id, 'mark_stale', { reason, source, approvalId: task.approval_id }));
    insertTimeline(db, {
      source,
      type: 'source:marked-stale',
      subject: task.subject,
      data: { learning_task_id: task.id, source_ids: sourceIds, rollback_ids: marked.map(row => row.rollback_id), reason },
      tags: ['source', 'stale', 'learning-task'],
    });
    applied.push({ action: 'source.mark_stale', sources: marked.map(({ source_id, rollback_id }) => ({ source_id, rollback_id })) });
    applied.push(retryHeldProposal(db, task, sourceIds, { source }));
  } else if (task.kind === 'proposal.reject') {
    const approvalRows = db.prepare(`
      SELECT * FROM approvals
      WHERE kind LIKE 'skill.%' AND status='pending' AND subject=?
      LIMIT 25
    `).all(task.subject);
    const rejected = [];
    for (const approval of approvalRows) {
      const before = { ...approval, payload: safeJson(approval.payload, {}), resolution: safeJson(approval.resolution, {}) };
      db.prepare(`
        UPDATE approvals
        SET status='rejected', resolution=?, resolved_at=unixepoch()
        WHERE id=? AND status='pending'
      `).run(JSON.stringify({ reason, source, learning_task_id: task.id }), approval.id);
      const afterRow = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(approval.id);
      const after = { ...afterRow, payload: safeJson(afterRow.payload, {}), resolution: safeJson(afterRow.resolution, {}) };
      const rollbackId = recordLearningRollback(db, {
        approvalId: approval.id,
        kind: 'proposal.reject',
        subject: task.subject,
        inverseAction: 'restore_approval_pending',
        beforeState: before,
        afterState: after,
        metadata: { reason, source, learning_task_id: task.id },
        createdBy: source,
      });
      rejected.push({ approval_id: approval.id, rollback_id: rollbackId });
    }
    insertTimeline(db, {
      source,
      type: 'proposal:rejected',
      subject: task.subject,
      data: { learning_task_id: task.id, rejected, reason },
      tags: ['proposal', 'rejected', 'learning-task'],
    });
    insertTimeline(db, {
      source,
      type: 'skill:rejected',
      subject: task.subject,
      data: { learning_task_id: task.id, rejected, reason },
      tags: ['skill', 'rejected', 'learning-task'],
    });
    applied.push({ action: 'proposal.reject', rejected });
  } else if (task.kind === 'skill.revision' || task.kind === 'correction.pattern') {
    if (!String(taskResult.summary ?? taskResult.outcome ?? '').trim()) {
      throw Object.assign(new Error(`${task.kind} requires summary or outcome`), { status: 400 });
    }
    insertTimeline(db, {
      source,
      type: `learning-task:${task.kind}:completed`,
      subject: task.subject,
      data: { learning_task_id: task.id, result: taskResult },
      tags: ['learning-task', task.kind],
    });
    applied.push({ action: task.kind });
  } else if (task.kind === 'context.phase.improve') {
    const summary = String(taskResult.summary ?? taskResult.outcome ?? '').trim();
    if (!summary) {
      throw Object.assign(new Error('context.phase.improve requires summary or outcome'), { status: 400 });
    }
    const phaseName = String(payload.phase?.phase ?? task.subject ?? '').trim();
    insertTimeline(db, {
      source,
      type: 'learning-task:context.phase.improve:completed',
      subject: task.subject,
      data: {
        learning_task_id: task.id,
        phase: phaseName,
        summary,
        result: taskResult,
      },
      tags: ['learning-task', 'context.phase.improve'],
    });
    applied.push({ action: 'context.phase.improve', phase: phaseName, summary });
  } else if (task.kind === 'knowledge.gap.research') {
    const summary = String(taskResult.summary ?? taskResult.outcome ?? '').trim();
    if (!summary) {
      throw Object.assign(new Error('knowledge.gap.research requires summary or outcome'), { status: 400 });
    }
    insertTimeline(db, {
      source,
      type: 'learning-task:knowledge.gap.research:completed',
      subject: task.subject,
      data: {
        learning_task_id: task.id,
        owner_route: task.payload?.route?.owner_route ?? null,
        team: task.payload?.route?.team ?? null,
        summary,
        result: taskResult,
      },
      tags: ['learning-task', 'knowledge.gap.research'],
    });
    applied.push({
      action: 'knowledge.gap.research',
      owner_route: task.payload?.route?.owner_route ?? null,
      summary,
    });
  } else {
    throw Object.assign(new Error(`unsupported learning task kind: ${task.kind}`), { status: 400 });
  }

  insertTimeline(db, {
    source,
    type: 'learning-task:applied',
    subject: String(task.id),
    data: { id: task.id, kind: task.kind, subject: task.subject, applied },
    tags: ['learning-task', 'applied'],
  });
  return { applied };
}
