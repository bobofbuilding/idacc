/**
 * Curator governance step (Plan 22, item 19).
 *
 * Closes the self-improving loop: each cycle the brain CREATES pending
 * approvals (cycle/approvals.mjs + brain-cycle phases) and the apply route
 * EXECUTES approved ones (recording a rollback record + timeline event per
 * apply). What was missing was the curator: the step that decides, each cycle,
 * which pending approvals to auto-approve + apply now vs. leave proposed.
 *
 * This curator is a DETERMINISTIC policy engine, not an LLM agent — the safe
 * path needs no model, so it runs at exactly $0 and is fully auditable. It
 * builds ON the existing routes (POST /approvals/:id/resolve then
 * POST /approvals/:id/apply); it does not re-implement applying.
 *
 * Hard guardrails (an approval is auto-applied only if ALL hold):
 *   1. its kind is on the allowlist of known safe + reversible kinds, AND
 *   2. it was created at an allowed risk_level (default: 'low' only), AND
 *   3. the per-cycle apply cap has not been reached.
 * Everything else is left pending (proposed) for human review. Because the
 * apply route records a learning_rollback_record for every applied approval,
 * each auto-apply is reversible by construction (zero hard deletes that are
 * not individually reversible). Risky kinds (memory.retire, skill.remove,
 * team.instruction.*, fact.contradiction, fuzzy merges, …) are never
 * auto-applied — they stay in the queue for a human.
 *
 * Optional (default OFF): a local-model advisory pass over the DEFERRED items
 * could attach a triage note — but it never changes the auto-apply decision,
 * which stays deterministic. Kept out of the default path to hold cost at $0.
 */

import { brainGet, brainPost } from '../brain-client.mjs';

// Low-risk, reversible, and supported by the apply route (each has a registered
// inverse: eval.fixture.promote -> eval.fixture.delete, eval.fixture.retire ->
// eval.fixture.restore). These are the only kinds the cycle currently emits at
// risk_level 'low'.
export const DEFAULT_AUTO_APPLY_KINDS = ['eval.fixture.promote', 'eval.fixture.retire'];
export const DEFAULT_AUTO_APPLY_RISK = ['low'];
export const DEFAULT_REVIEW_ONLY_KINDS = ['fact.contradiction', 'edge.repair'];

function parseList(value, fallback) {
  if (value == null || value === '') return fallback;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function curatorPolicy(env = process.env) {
  return {
    enabled: bool(env.BRAIN_CURATOR_ENABLED, true),
    dryRun: bool(env.BRAIN_CURATOR_DRY_RUN, false),
    autoApplyKinds: parseList(env.BRAIN_CURATOR_AUTOAPPLY_KINDS, DEFAULT_AUTO_APPLY_KINDS),
    autoApplyRisk: parseList(env.BRAIN_CURATOR_AUTOAPPLY_RISK, DEFAULT_AUTO_APPLY_RISK),
    reviewOnlyKinds: parseList(env.BRAIN_CURATOR_REVIEW_ONLY_KINDS, DEFAULT_REVIEW_ONLY_KINDS),
    maxApplies: Math.max(Number(env.BRAIN_CURATOR_MAX_APPLIES ?? 25) || 25, 0),
    scanLimit: Math.min(Math.max(Number(env.BRAIN_CURATOR_SCAN_LIMIT ?? 200) || 200, 1), 200),
    source: env.BRAIN_CURATOR_SOURCE ?? 'curator',
  };
}

/**
 * Pure decision: should this approval be auto-applied or deferred?
 * Exported for unit testing the guardrails without any I/O.
 */
export function classifyApproval(approval = {}, policy = curatorPolicy()) {
  const kind = approval.kind;
  const risk = String(approval.risk_level ?? approval.riskLevel ?? 'medium').toLowerCase();
  if (policy.reviewOnlyKinds.includes(kind)) {
    return { decision: 'defer', reason: 'review_only_kind', kind, risk };
  }
  if (!policy.autoApplyKinds.includes(kind)) {
    return { decision: 'defer', reason: 'kind_not_allowlisted', kind, risk };
  }
  if (!policy.autoApplyRisk.includes(risk)) {
    return { decision: 'defer', reason: 'risk_above_threshold', kind, risk };
  }
  return { decision: 'auto_apply', reason: 'safe_reversible', kind, risk };
}

/**
 * Run one curator pass. Returns a structured report; also writes a single
 * `curator:cycle` timeline event (unless logTimeline is false). The per-apply
 * `approval:applied` / rollback records are written by the apply route itself.
 */
export async function runCurator({
  get = brainGet,
  post = brainPost,
  env = process.env,
  policy = curatorPolicy(env),
  logTimeline = true,
} = {}) {
  const result = {
    started_at: new Date().toISOString(),
    policy: {
      enabled: policy.enabled,
      dry_run: policy.dryRun,
      auto_apply_kinds: policy.autoApplyKinds,
      auto_apply_risk: policy.autoApplyRisk,
      review_only_kinds: policy.reviewOnlyKinds,
      max_applies: policy.maxApplies,
    },
    scanned: 0,
    applied: [],
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

  for (const approval of approvals) {
    const verdict = classifyApproval(approval, policy);

    if (verdict.decision === 'defer') {
      const key = `${verdict.kind}:${verdict.risk}`;
      result.deferred_by_kind_risk[key] = (result.deferred_by_kind_risk[key] ?? 0) + 1;
      result.deferred.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, reason: verdict.reason });
      continue;
    }

    // auto_apply — enforce the per-cycle cap (bounded blast radius).
    if (result.applied.length >= policy.maxApplies) {
      result.skipped_over_cap += 1;
      result.deferred.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, reason: 'over_cap' });
      continue;
    }

    if (policy.dryRun) {
      result.applied.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, dry_run: true });
      continue;
    }

    try {
      // Build ON the existing routes: approve, then apply. The apply route
      // records the rollback record + per-item timeline event.
      const resolved = await post(`/approvals/${approval.id}/resolve`, {
        status: 'approved',
        resolution: { by: policy.source, reason: 'curator auto-approve (safe + reversible, within guardrails)' },
      }, { strict: false });
      if (!resolved.ok || resolved.data?.error) {
        throw new Error(resolved.data?.error ?? `resolve failed (HTTP ${resolved.meta?.status})`);
      }

      const applied = await post(`/approvals/${approval.id}/apply`, { source: policy.source }, { strict: false });
      if (!applied.ok || applied.data?.error) {
        throw new Error(applied.data?.error ?? `apply failed (HTTP ${applied.meta?.status})`);
      }

      result.applied.push({
        id: approval.id,
        kind: verdict.kind,
        risk: verdict.risk,
        timeline_event_id: applied.data?.timelineEventId ?? null,
        rollback_record_id: applied.data?.rollbackRecordId ?? null,
      });
    } catch (err) {
      result.failed.push({ id: approval.id, kind: verdict.kind, risk: verdict.risk, error: String(err?.message ?? err).slice(0, 300) });
    }
  }

  result.finished_at = new Date().toISOString();

  if (logTimeline) {
    await post('/timeline', {
      source: policy.source,
      type: 'curator:cycle',
      subject: 'governance',
      data: {
        scanned: result.scanned,
        applied: result.applied,
        applied_count: result.applied.length,
        deferred_count: result.deferred.length,
        deferred_by_kind_risk: result.deferred_by_kind_risk,
        failed: result.failed,
        failed_count: result.failed.length,
        skipped_over_cap: result.skipped_over_cap,
        dry_run: policy.dryRun,
        policy: result.policy,
      },
      tags: ['brain', 'curator', 'governance', result.failed.length ? 'warning' : 'ok'],
    }, { strict: false });
  }

  return result;
}
