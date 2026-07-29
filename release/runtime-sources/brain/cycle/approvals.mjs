import { brainGet, brainPost } from '../brain-client.mjs';
import { db } from '../db.mjs';
import { validateGraphEdges } from '../sources.mjs';

function approvalRequestOptions(options = {}) {
  return {
    strict: false,
    timeoutMs: Number(process.env.BRAIN_CYCLE_APPROVAL_TIMEOUT_MS ?? 120_000),
    ...options,
  };
}

function withGovernance(payload = {}, governance = {}, overrides = {}) {
  return {
    ...payload,
    governance: {
      ...(governance ?? {}),
      ...(payload.governance ?? {}),
      ...(overrides ?? {}),
    },
  };
}

function contradictionKeys(contradictions) {
  const keys = new Set();
  for (const item of contradictions) {
    for (const field of item.fields ?? []) keys.add(`${item.entity_id}:${field}`);
  }
  return keys;
}

function contradictionMetaMap(contradictions = []) {
  const map = new Map();
  for (const item of contradictions) {
    for (const detail of item.details ?? []) {
      map.set(`${item.entity_id}:${detail.field}`, detail);
    }
  }
  return map;
}

function contradictionEvidence(detail = {}) {
  const claims = Array.isArray(detail.claims) ? detail.claims : [];
  const sourceFactIds = [...new Set(claims.map(claim => Number(claim.id)).filter(Number.isInteger))];
  const sourceTextUnitIds = [...new Set(claims.flatMap(claim => claim.text_unit_ids ?? claim.textUnitIds ?? []).map(Number).filter(Number.isInteger))];
  const competingValues = claims.map(claim => ({
    fact_id: Number(claim.id),
    value: claim.value,
    source: claim.source ?? '',
    confidence: Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : null,
    observed_at: claim.observed_at ?? null,
    text_unit_ids: (claim.text_unit_ids ?? claim.textUnitIds ?? []).map(Number).filter(Number.isInteger),
  }));
  const confidences = competingValues.map(value => value.confidence).filter(Number.isFinite);
  const confidence = confidences.length
    ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000) / 1000
    : null;
  return { claims, sourceFactIds, sourceTextUnitIds, competingValues, confidence };
}

function edgeRepairRiskLevel(candidate = {}) {
  return candidate.issues?.some(code => code === 'invalid_kind' || code === 'orphaned_from' || code === 'orphaned_to')
    ? 'high'
    : 'medium';
}

function edgeRepairQualityMarker(candidate = {}) {
  if (candidate.issues?.some(code => code === 'invalid_kind' || code === 'orphaned_from' || code === 'orphaned_to')) return 'broken';
  if (candidate.issues?.includes('low_evidence')) return 'weak';
  if (candidate.issues?.includes('stale')) return 'stale';
  return 'review';
}

function edgeRepairSuggestedReason(candidate = {}) {
  return (candidate.issue_messages ?? []).join('; ') || 'graph edge flagged for manual review';
}

export async function createContradictionApprovals({ currentContradictions, previousReport, governance = {} }) {
  const threshold = Math.max(2, Number(process.env.BRAIN_CONTRADICTION_CONSECUTIVE_CYCLES ?? 2) || 2);
  const previousKeys = contradictionKeys(previousReport?.contradictions ?? []);
  const currentMeta = contradictionMetaMap(currentContradictions);
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'fact.contradiction')
    .map(a => `${a.subject}:${a.payload?.field}`));
  const created = [];

  for (const contradiction of currentContradictions) {
    for (const detail of contradiction.details ?? []) {
      const key = `${contradiction.entity_id}:${detail.field}`;
      const cycleCount = Number(currentMeta.get(key)?.consecutive_cycle_count ?? 1);
      if (!previousKeys.has(key) || pendingKeys.has(key) || cycleCount < threshold) continue;
      const evidence = contradictionEvidence(detail);
      const payload = {
        entity_id: contradiction.entity_id,
        field: detail.field,
        claims: evidence.claims,
        competing_values: evidence.competingValues,
        source_fact_ids: evidence.sourceFactIds,
        source_text_unit_ids: evidence.sourceTextUnitIds,
        confidence: evidence.confidence,
        observed_in_consecutive_cycles: true,
        consecutive_cycle_count: cycleCount,
        contradiction_policy: {
          schema_version: 'contradiction-policy.v1',
          trigger_kind: 'consecutive-cycle-repeat',
          threshold_cycles: threshold,
        },
        proposed_resolution: {
          schema_version: 'fact-contradiction-resolution.v1',
          apply_route: '/proposals/:id/apply',
          required_fields: ['winning_fact_id'],
          allowed_losing_status: ['disputed', 'superseded'],
          reversible: true,
          rollback_inverse_action: 'facts.restore-statuses',
          default_losing_status: 'disputed',
        },
      };
      const approval = await brainPost('/approvals', {
        kind: 'fact.contradiction',
        subject: contradiction.entity_id,
        payload: withGovernance(payload, governance, {
          risk: {
            schema_version: 'risk.v1',
            level: 'medium',
            score: 0.7,
            category: 'knowledge-integrity',
            action: 'review-required',
            reversible: true,
          },
          inverse_op: {
            kind: 'fact.status.restore',
            ready: false,
            ref: null,
            metadata: { losing_status_options: ['superseded', 'disputed', 'active'] },
          },
          audit: {
            rubric_version: 'curator.v1',
            rubric_id: 'fact.contradiction.default',
            checks: ['cross-source-conflict', 'winning-fact-selected', 'inverse-op-recorded'],
            notes: [`triggered after ${cycleCount} consecutive cycles`],
          },
          queue: {
            queued_at: Math.floor(Date.now() / 1000),
            review_required: true,
            review_sla_seconds: 86400,
          },
          quality_marker: 'disputed',
          human_attention: { required: true, level: 'medium', reason: 'repeated contradiction across cycles' },
        }),
        risk_level: 'medium',
        requested_by: 'brain-cycle',
      }, approvalRequestOptions());
      created.push({ id: approval.data?.id, ...payload });
      pendingKeys.add(key);
    }
  }

  return created;
}

export async function createMemoryRetireApprovals(governance = {}) {
  const report = await brainGet('/brain/learning-report?days=90', approvalRequestOptions());
  const candidates = report.data?.report?.memoryRetirement?.candidates ?? [];
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'memory.retire')
    .map(a => a.subject));
  const created = [];

  for (const candidate of candidates.slice(0, Number(process.env.BRAIN_CYCLE_MEMORY_RETIRE_LIMIT ?? 10))) {
    if (pendingKeys.has(candidate.source_id)) continue;
    const approval = await brainPost('/approvals', {
      kind: 'memory.retire',
      subject: candidate.source_id,
      payload: withGovernance({
        memory_id: candidate.id,
        agent_id: candidate.agent_id,
        key: candidate.key,
        ignored_count: candidate.ignored_count,
        last_volunteered_at: candidate.last_volunteered_at,
        last_used_at: candidate.last_used_at,
        score: candidate.score,
        evidence: candidate.content,
        suggested_reason: candidate.suggestedReason,
      }, governance, {
        quality_marker: candidate.score <= 0.2 ? 'degraded' : 'weak',
        human_attention: { required: false, level: 'medium', reason: 'memory retirement review' },
      }),
      risk_level: 'medium',
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({ id: approval.data?.id, memory_id: candidate.id, source_id: candidate.source_id, score: candidate.score });
    pendingKeys.add(candidate.source_id);
  }

  return created;
}

export async function createInstructionLifecycleApprovals(governance = {}) {
  const report = await brainGet('/brain/learning-report?days=90', approvalRequestOptions());
  const candidates = report.data?.report?.instructionFeedback?.candidates ?? [];
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'team.instruction.retire' || a.kind === 'team.instruction.supersede')
    .map(a => `${a.kind}:${a.subject}`));
  const created = [];

  for (const candidate of candidates.slice(0, Number(process.env.BRAIN_CYCLE_INSTRUCTION_LIFECYCLE_LIMIT ?? 10))) {
    const kind = candidate.suggestedAction;
    const subject = candidate.key || candidate.source_id;
    const key = `${kind}:${subject}`;
    if (pendingKeys.has(key)) continue;
    const approval = await brainPost('/approvals', {
      kind,
      subject,
      payload: withGovernance({
        memory_id: candidate.id,
        key: candidate.key,
        project: candidate.project,
        ignored_count: candidate.ignored_count,
        used_count: candidate.used_count,
        harmful_count: candidate.harmful_count,
        last_volunteered_at: candidate.last_volunteered_at,
        last_used_at: candidate.last_used_at,
        current_instruction: candidate.content,
        suggested_reason: candidate.suggestedReason,
      }, governance, {
        human_attention: {
          required: candidate.harmful_count > 0,
          level: candidate.harmful_count > 0 ? 'high' : 'medium',
          reason: candidate.harmful_count > 0 ? 'harmful instruction evidence observed' : 'instruction lifecycle review',
        },
      }),
      risk_level: candidate.harmful_count > 0 ? 'high' : 'medium',
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({ id: approval.data?.id, kind, memory_id: candidate.id, subject, reason: candidate.suggestedReason });
    pendingKeys.add(key);
  }

  return created;
}

export async function createEvalFixturePromotionApprovals(governance = {}) {
  const report = await brainGet('/brain/learning-report?days=90', approvalRequestOptions());
  const candidates = report.data?.report?.fixturePromotion?.candidates ?? [];
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'eval.fixture.promote')
    .map(a => String(a.payload?.eval_query_id ?? a.payload?.evalQueryId ?? a.subject)));
  const created = [];

  for (const candidate of candidates.slice(0, Number(process.env.BRAIN_CYCLE_FIXTURE_PROMOTE_LIMIT ?? 10))) {
    const subject = String(candidate.eval_query_id);
    if (pendingKeys.has(subject)) continue;
    const approval = await brainPost('/approvals', {
      kind: 'eval.fixture.promote',
      subject,
      payload: withGovernance({
        eval_query_id: candidate.eval_query_id,
        query_text: candidate.query_text,
        route: candidate.route,
        agent_id: candidate.agent_id,
        task_id: candidate.task_id,
        latency_ms: candidate.latency_ms,
        required_source_ids: candidate.required_source_ids,
        required_strings: candidate.required_strings,
        accepted_source_ids: candidate.accepted_source_ids,
        returned_source_ids: candidate.returned_source_ids,
        score: candidate.score,
        suggested_reason: candidate.suggestedReason,
      }, governance, {
        quality_marker: candidate.score >= 0.8 ? 'strong' : 'candidate',
      }),
      risk_level: 'low',
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({ id: approval.data?.id, eval_query_id: candidate.eval_query_id, score: candidate.score });
    pendingKeys.add(subject);
  }

  return created;
}

export async function createEvalFixtureRetireApprovals(governance = {}) {
  const report = await brainGet('/brain/learning-report?days=90', approvalRequestOptions());
  const lifecycle = report.data?.report?.fixtureLifecycle ?? {};
  const minFailures = Number(process.env.BRAIN_CYCLE_FIXTURE_RETIRE_FAILURES ?? 3);
  const candidates = [
    ...(lifecycle.stale ?? []).map(fixture => ({
      ...fixture,
      suggested_reason: fixture.stale_reason || `stale fixture evidence: ${(fixture.evidence?.issues ?? []).join(', ')}`,
    })),
    ...(lifecycle.failing ?? [])
      .filter(fixture => Number(fixture.failure_count ?? 0) >= minFailures)
      .map(fixture => ({
        ...fixture,
        suggested_reason: `fixture failed replay ${fixture.failure_count} times`,
      })),
  ];
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'eval.fixture.retire')
    .map(a => String(a.payload?.fixture_id ?? a.payload?.fixtureId ?? a.subject)));
  const created = [];

  for (const candidate of candidates.slice(0, Number(process.env.BRAIN_CYCLE_FIXTURE_RETIRE_LIMIT ?? 10))) {
    const subject = String(candidate.id);
    if (pendingKeys.has(subject)) continue;
    const approval = await brainPost('/approvals', {
      kind: 'eval.fixture.retire',
      subject,
      payload: withGovernance({
        fixture_id: candidate.id,
        eval_query_id: candidate.eval_query_id,
        query_text: candidate.query_text,
        route: candidate.route,
        status: candidate.status,
        stale_reason: candidate.stale_reason,
        failure_count: candidate.failure_count,
        invalid_source_ids: candidate.evidence?.invalid_source_ids ?? [],
        evidence_issues: candidate.evidence?.issues ?? [],
        suggested_reason: candidate.suggested_reason,
      }, governance, {
        quality_marker: 'degraded',
        human_attention: { required: false, level: 'low', reason: 'fixture retirement review' },
      }),
      risk_level: 'low',
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({ id: approval.data?.id, fixture_id: candidate.id, reason: candidate.suggested_reason });
    pendingKeys.add(subject);
  }

  return created;
}

export async function createEdgeRepairApprovals({
  governance = {},
  database = db,
  get = brainGet,
  post = brainPost,
} = {}) {
  const limit = Math.max(Number(process.env.BRAIN_CYCLE_EDGE_REPAIR_LIMIT ?? 25) || 25, 0);
  const pending = await get('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'edge.repair')
    .map(a => a.subject));
  const created = [];
  const candidates = validateGraphEdges(database).filter(candidate => !candidate.valid);

  for (const candidate of candidates.slice(0, limit)) {
    if (pendingKeys.has(candidate.edge_ref)) continue;
    const riskLevel = edgeRepairRiskLevel(candidate);
    const suggestedReason = edgeRepairSuggestedReason(candidate);
    const approval = await post('/approvals', {
      kind: 'edge.repair',
      subject: candidate.edge_ref,
      payload: withGovernance({
        table: candidate.table,
        edge_id: candidate.edge_id,
        edge_ref: candidate.edge_ref,
        issues: candidate.issues,
        issue_messages: candidate.issue_messages,
        edge_snapshot: candidate.snapshot,
        suggested_reason: suggestedReason,
        proposed_repair: { action: 'update', fields: {} },
        repair_policy: {
          schema_version: 'edge-repair-review.v1',
          reviewed_queue: true,
          auto_apply: false,
          allowed_actions: ['update'],
        },
      }, governance, {
        risk: {
          schema_version: 'risk.v1',
          level: riskLevel,
          score: riskLevel === 'high' ? 0.85 : 0.6,
          category: 'graph-integrity',
          action: 'review-required',
          reversible: true,
        },
        inverse_op: {
          kind: 'edge.restore',
          ready: false,
          ref: null,
          metadata: { table: candidate.table, edge_id: candidate.edge_id },
        },
        audit: {
          rubric_version: 'curator.v1',
          rubric_id: 'edge.repair.default',
          checks: ['edge-scanned', 'review-required', 'no-auto-apply'],
          notes: candidate.issue_messages ?? [],
        },
        queue: {
          queued_at: Math.floor(Date.now() / 1000),
          review_required: true,
          review_sla_seconds: riskLevel === 'high' ? 14400 : 86400,
        },
        quality_marker: edgeRepairQualityMarker(candidate),
        human_attention: { required: true, level: riskLevel === 'high' ? 'high' : 'medium', reason: 'graph edge repair requires explicit review' },
      }),
      risk_level: riskLevel,
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({
      id: approval.data?.id,
      subject: candidate.edge_ref,
      table: candidate.table,
      edge_id: candidate.edge_id,
      issues: candidate.issues,
      risk_level: riskLevel,
    });
    pendingKeys.add(candidate.edge_ref);
  }

  return created;
}

export async function createSkillRevisionApprovals(governance = {}) {
  const report = await brainGet('/skill-proposals/report?limit=1000', approvalRequestOptions());
  const gaps = report.data?.gaps ?? [];
  const pending = await brainGet('/approvals?status=pending&limit=200', approvalRequestOptions());
  const pendingKeys = new Set((pending.data?.approvals ?? [])
    .filter(a => a.kind === 'skill.revise' || a.kind === 'skill.remove')
    .map(a => `${a.kind}:${a.subject}`));
  const created = [];
  const minFeedback = Number(process.env.BRAIN_CYCLE_SKILL_REVISE_MIN_FEEDBACK ?? 2);
  const maxHelpfulness = Number(process.env.BRAIN_CYCLE_SKILL_REVISE_MAX_HELPFULNESS ?? 0.34);

  for (const gap of gaps) {
    if (gap.published < 1) continue;
    if (gap.feedbackCount < minFeedback) continue;
    if (gap.avgHelpfulness == null || gap.avgHelpfulness > maxHelpfulness) continue;
    const kind = gap.helpfulCount === 0 && gap.feedbackCount >= minFeedback + 1 ? 'skill.remove' : 'skill.revise';
    const key = `${kind}:${gap.gap}`;
    if (pendingKeys.has(key) || gap.approvalsPending > 0) continue;
    const approval = await brainPost('/approvals', {
      kind,
      subject: gap.gap,
      payload: withGovernance({
        gap: gap.gap,
        published: gap.published,
        feedback_count: gap.feedbackCount,
        helpful_count: gap.helpfulCount,
        avg_helpfulness: gap.avgHelpfulness,
        demand: gap.demand,
        task_ids: gap.taskIds,
        feedback_samples: gap.feedbackSamples,
        source_text_unit_ids: gap.sourceTextUnitIds,
        fact_ids: gap.factIds,
        suggested_reason: `Published skill feedback averaged ${gap.avgHelpfulness} over ${gap.feedbackCount} samples.`,
      }, governance, {
        quality_marker: kind === 'skill.remove' ? 'degraded' : 'weak',
        human_attention: { required: kind === 'skill.remove', level: kind === 'skill.remove' ? 'high' : 'medium', reason: 'skill quality review' },
      }),
      risk_level: kind === 'skill.remove' ? 'high' : 'medium',
      requested_by: 'brain-cycle',
    }, approvalRequestOptions());
    created.push({ id: approval.data?.id, kind, gap: gap.gap, avg_helpfulness: gap.avgHelpfulness });
    pendingKeys.add(key);
  }

  return created;
}
