/**
 * Deterministic maintenance routing for queued governance items that should not
 * be auto-approved, but can be converted into downstream work.
 *
 * This intentionally does not call /approvals/:id/apply. It only routes known
 * non-authorization approval kinds into learning tasks, then resolves the queue
 * item as "routed" so it stops clogging the pending approval count.
 */

import { brainGet, brainPost } from '../brain-client.mjs';

export const DEFAULT_ROUTABLE_APPROVAL_KINDS = ['skill.proposal.evidence_invalid', 'skill.publish'];
export const DEFAULT_ROUTABLE_APPROVAL_RISK = ['low', 'medium'];
export const OPEN_LEARNING_TASK_STATUSES = ['queued', 'assigned', 'in_progress', 'blocked'];

function parseList(value, fallback) {
  if (value == null || value === '') return fallback;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function maintenancePolicy(env = process.env) {
  return {
    enabled: bool(env.BRAIN_MAINTENANCE_FLOW_ENABLED, true),
    dryRun: bool(env.BRAIN_MAINTENANCE_DRY_RUN, false),
    routableKinds: parseList(env.BRAIN_MAINTENANCE_ROUTABLE_KINDS, DEFAULT_ROUTABLE_APPROVAL_KINDS),
    routableRisk: parseList(env.BRAIN_MAINTENANCE_ROUTABLE_RISK, DEFAULT_ROUTABLE_APPROVAL_RISK),
    maxRoutes: Math.max(Number(env.BRAIN_MAINTENANCE_MAX_ROUTES ?? 50) || 50, 0),
    scanLimit: Math.min(Math.max(Number(env.BRAIN_MAINTENANCE_SCAN_LIMIT ?? 200) || 200, 1), 200),
    source: env.BRAIN_MAINTENANCE_SOURCE ?? 'brain-maintenance',
  };
}

export function classifyMaintenanceApproval(approval = {}, policy = maintenancePolicy()) {
  const kind = approval.kind;
  const risk = String(approval.risk_level ?? approval.riskLevel ?? 'medium').toLowerCase();
  if (!policy.routableKinds.includes(kind)) {
    return { decision: 'defer', reason: 'kind_not_routable', kind, risk };
  }
  if (kind === 'skill.publish' && !skillPublishNeedsEvidence(approval)) {
    return { decision: 'defer', reason: 'publish_evidence_ready_for_review', kind, risk };
  }
  if (!policy.routableRisk.includes(risk)) {
    return { decision: 'defer', reason: 'risk_above_routing_threshold', kind, risk };
  }
  return { decision: 'route_to_work', reason: kind === 'skill.publish' ? 'publish_needs_evidence_repair' : 'non_apply_repair_task', kind, risk };
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function skillPublishNeedsEvidence(approval = {}) {
  const payload = approval.payload || {};
  if (approval.kind !== 'skill.publish') return false;
  const snippets = arrayValue(payload.evidence_snippets ?? payload.evidenceSnippets);
  const facts = arrayValue(payload.fact_ids ?? payload.factIds);
  const demand = Number(payload.demand ?? 0);
  return payload.reason === 'template-fallback-low-confidence' || (snippets.length === 0 && facts.length === 0 && demand <= 1);
}

function repairKey(approval = {}) {
  const payload = approval.payload || {};
  const subject = payload.gap
    ?? payload.skill
    ?? payload.skill_id
    ?? payload.skillId
    ?? payload.definition?.name
    ?? approval.subject
    ?? '';
  return `${approval.kind}:${String(subject).trim().toLowerCase()}`;
}

function repairTaskPayload(approval = {}) {
  const payload = approval.payload || {};
  const publishRepair = approval.kind === 'skill.publish';
  return {
    approval_kind: approval.kind,
    approval_id: approval.id,
    approval_subject: approval.subject ?? '',
    repair_key: repairKey(approval),
    gap: payload.gap ?? payload.skill ?? payload.skill_id ?? payload.skillId ?? payload.definition?.name ?? approval.subject ?? '',
    reason: publishRepair
      ? 'Low-confidence publish proposal needs evidence before it can be reviewed for publication.'
      : payload.hold_reason ?? payload.suggested_reason ?? payload.suggestedReason ?? payload.reason ?? 'repair missing or invalid skill evidence',
    approval_payload: payload,
    review_gate: publishRepair
      ? 'no skill was published; task must provide evidence before a new publish proposal can be reviewed'
      : 'no approval was granted; task must provide evidence before any publish path resumes',
  };
}

function taskApprovalId(task = {}) {
  const payload = task.payload || {};
  const raw = task.approval_id ?? task.approvalId ?? payload.approval_id ?? payload.approvalId;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

async function loadOpenRepairTasks(get) {
  const tasks = [];
  for (const status of OPEN_LEARNING_TASK_STATUSES) {
    const response = await get(`/learning-tasks?status=${encodeURIComponent(status)}&limit=200`, { strict: false });
    for (const task of response.data?.tasks ?? response.tasks ?? []) {
      if (task.kind === 'skill.evidence.repair') tasks.push(task);
    }
  }
  return tasks;
}

function taskRepairKey(task = {}) {
  const payload = task.payload || {};
  return payload.repair_key ?? (payload.approval_kind && (payload.gap || task.subject)
    ? `${payload.approval_kind}:${String(payload.gap || task.subject).trim().toLowerCase()}`
    : null);
}

async function resolveRoutedApproval({ approval, post, policy, taskId, action = 'routed_to_learning_task' }) {
  const publishRepair = approval.kind === 'skill.publish';
  const resolved = await post(`/approvals/${approval.id}/resolve`, {
    status: 'resolved',
    resolution: {
      by: policy.source,
      action,
      learning_task_id: taskId,
      reason: action === 'already_routed_to_learning_task'
        ? 'A matching repair task is already open; no duplicate task was created and no publish approval was granted.'
        : publishRepair
          ? 'Low-confidence skill publish proposal was converted to evidence repair work; no skill was published.'
          : 'Evidence-invalid skill proposal was converted to a repair task; no publish approval was granted.',
    },
  }, { strict: false });
  if (!resolved.ok || resolved.data?.error) {
    throw new Error(resolved.data?.error ?? `approval resolve failed (HTTP ${resolved.meta?.status})`);
  }
}

async function routeEvidenceInvalidApproval({ approval, post, policy }) {
  const task = await post('/learning-tasks', {
    kind: 'skill.evidence.repair',
    subject: approval.subject ?? '',
    approval_id: approval.id,
    priority: Number(approval.payload?.demand ?? approval.payload?.priority ?? 0) || 0,
    evidence_ids: {
      source_text_unit_ids: approval.payload?.source_text_unit_ids ?? approval.payload?.sourceTextUnitIds ?? [],
      fact_ids: approval.payload?.fact_ids ?? approval.payload?.factIds ?? [],
      timeline_event_ids: approval.payload?.timeline_event_ids ?? approval.payload?.timelineEventIds ?? [],
    },
    payload: repairTaskPayload(approval),
    source: policy.source,
  }, { strict: false });
  if (!task.ok || task.data?.error) {
    throw new Error(task.data?.error ?? `learning task create failed (HTTP ${task.meta?.status})`);
  }

  const taskId = task.data?.task?.id ?? task.data?.id ?? null;
  await resolveRoutedApproval({ approval, post, policy, taskId });

  return { task_id: taskId };
}

export async function runMaintenanceFlow({
  get = brainGet,
  post = brainPost,
  env = process.env,
  policy = maintenancePolicy(env),
  logTimeline = true,
} = {}) {
  const result = {
    started_at: new Date().toISOString(),
    policy: {
      enabled: policy.enabled,
      dry_run: policy.dryRun,
      routable_kinds: policy.routableKinds,
      routable_risk: policy.routableRisk,
      max_routes: policy.maxRoutes,
    },
    scanned: 0,
    routed: [],
    deferred: [],
    failed: [],
    skipped_over_cap: 0,
    deferred_by_kind_risk: {},
  };

  if (!policy.enabled) {
    result.disabled = true;
    result.finished_at = new Date().toISOString();
    return result;
  }

  const pending = await get(`/approvals?status=pending&limit=${policy.scanLimit}`, { strict: false });
  const approvals = pending.data?.approvals ?? [];
  result.scanned = approvals.length;
  const openRepairTasks = policy.dryRun ? [] : await loadOpenRepairTasks(get);
  const openRepairByApproval = new Map(openRepairTasks
    .map(task => [taskApprovalId(task), task])
    .filter(([approvalId]) => approvalId != null));
  const openRepairByKey = new Map(openRepairTasks
    .map(task => [taskRepairKey(task), task])
    .filter(([key]) => key));

  for (const approval of approvals) {
    const verdict = classifyMaintenanceApproval(approval, policy);
    if (verdict.decision === 'defer') {
      const key = `${verdict.kind}:${verdict.risk}`;
      result.deferred_by_kind_risk[key] = (result.deferred_by_kind_risk[key] ?? 0) + 1;
      result.deferred.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, reason: verdict.reason });
      continue;
    }

    if (result.routed.length >= policy.maxRoutes) {
      result.skipped_over_cap += 1;
      result.deferred.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, reason: 'over_cap' });
      continue;
    }

    const existingTask = openRepairByApproval.get(Number(approval.id)) ?? openRepairByKey.get(repairKey(approval));
    if (policy.dryRun) {
      result.routed.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, dry_run: true, action: 'route_to_learning_task' });
      continue;
    }

    try {
      if (existingTask) {
        await resolveRoutedApproval({
          approval,
          post,
          policy,
          taskId: existingTask.id,
          action: 'already_routed_to_learning_task',
        });
        result.routed.push({
          id: approval.id,
          kind: verdict.kind,
          risk: verdict.risk,
          task_id: existingTask.id,
          existing_task: true,
        });
      } else {
        const routed = await routeEvidenceInvalidApproval({ approval, post, policy });
        const taskLike = {
          id: routed.task_id,
          kind: 'skill.evidence.repair',
          status: 'queued',
          approval_id: approval.id,
          payload: repairTaskPayload(approval),
        };
        if (routed.task_id != null) {
          openRepairByApproval.set(Number(approval.id), taskLike);
          openRepairByKey.set(repairKey(approval), taskLike);
        }
        result.routed.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, ...routed });
      }
    } catch (err) {
      result.failed.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, error: String(err?.message ?? err).slice(0, 300) });
    }
  }

  result.finished_at = new Date().toISOString();

  if (logTimeline) {
    await post('/timeline', {
      source: policy.source,
      type: 'maintenance:flow',
      subject: 'governance',
      data: {
        scanned: result.scanned,
        routed: result.routed,
        routed_count: result.routed.length,
        deferred_count: result.deferred.length,
        deferred_by_kind_risk: result.deferred_by_kind_risk,
        failed: result.failed,
        failed_count: result.failed.length,
        skipped_over_cap: result.skipped_over_cap,
        dry_run: policy.dryRun,
        policy: result.policy,
      },
      tags: ['brain', 'maintenance', 'governance', result.failed.length ? 'warning' : 'ok'],
    }, { strict: false });
  }

  return result;
}
