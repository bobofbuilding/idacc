import { createLearningTask } from '../learning-policy.mjs';

// Map a recorded task signal (entity status, timeline topic, or data flag) to an
// outcome bucket. Only signals the listener actually records are recognised; an
// unknown signal yields null so it is counted as "uncorrelated".
function outcomeBucketForSignal(signal) {
  const value = String(signal ?? '').toLowerCase();
  if (['done', 'completed', 'task:done', 'task:completed'].includes(value)) return 'completed';
  if (['removed', 'reverted', 'rolled_back', 'task:removed', 'task:reverted'].includes(value)) return 'reverted';
  if (['blocked', 'task:blocked'].includes(value)) return 'blocked';
  if (['failed', 'error', 'task:failed'].includes(value)) return 'failed';
  if (['rejected', 'task:rejected'].includes(value)) return 'rejected';
  return null;
}

// Join a set of task ids to the outcomes the listener has ingested for them.
// Task lifecycle lives both as the task entity's status column and as task:*
// timeline events; learning rollbacks/blocked learning-tasks add reverted/blocked.
export function correlateTaskOutcomes(db, taskIds = [], { parseJson = JSON.parse } = {}) {
  const buckets = { completed: 0, failed: 0, blocked: 0, reverted: 0, rejected: 0 };
  const ids = [...new Set((taskIds ?? []).map(String).filter(Boolean))];
  let correlated = 0;
  for (const taskId of ids) {
    const entityId = taskId.startsWith('task:') ? taskId : `task:${taskId}`;
    let bucket = null;
    const entity = db.prepare(`SELECT status, data FROM entities WHERE id=?`).get(entityId);
    if (entity) {
      bucket = outcomeBucketForSignal(entity.status);
      if (!bucket) {
        const data = parseJson(entity.data, {});
        bucket = outcomeBucketForSignal(data.outcome ?? data.result_status ?? data.resultStatus);
      }
    }
    if (!bucket) {
      const event = db.prepare(`
        SELECT type FROM timeline
        WHERE subject IN (?, ?) AND type LIKE 'task:%'
          AND type IN ('task:done','task:completed','task:removed','task:reverted','task:failed','task:blocked','task:rejected')
        ORDER BY created_at DESC LIMIT 1
      `).get(taskId, entityId.slice('task:'.length));
      if (event) bucket = outcomeBucketForSignal(event.type);
    }
    if (bucket) {
      buckets[bucket]++;
      correlated++;
    }
  }
  const total = correlated;
  return {
    correlated: total,
    uncorrelated: ids.length - total,
    buckets,
    // completed-good ÷ total correlated outcomes
    outcome_rate: total ? Math.round((buckets.completed / total) * 1000) / 1000 : null,
  };
}

export function buildSkillProposalReport(db, { limit = 200, parseJson = JSON.parse } = {}) {
  const eventRows = db.prepare(`
    SELECT * FROM timeline
    WHERE type IN ('skill:proposal-held','skill:proposal-retry-ready','skill:proposal-retry-blocked','skill:proposal-retry-consumed','skill:proposed','skill:rejected','skill:published','skill:feedback')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(r => ({ ...r, data: parseJson(r.data, {}), tags: parseJson(r.tags, []) }));
  const approvalRows = db.prepare(`
    SELECT * FROM approvals
    WHERE kind LIKE 'skill.%'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(r => ({ ...r, payload: parseJson(r.payload, {}), resolution: parseJson(r.resolution, {}) }));

  const byGap = new Map();
  const ensure = (gap) => {
    const key = String(gap || 'unknown');
    if (!byGap.has(key)) byGap.set(key, {
      gap: key,
      held: 0,
      retryReady: 0,
      retryBlocked: 0,
      retryConsumed: 0,
      proposed: 0,
      rejected: 0,
      published: 0,
      feedbackCount: 0,
      helpfulCount: 0,
      avgHelpfulness: null,
      helpfulnessSum: 0,
      approvalsPending: 0,
      approvalsApproved: 0,
      approvalsRejected: 0,
      invalidCitations: 0,
      invalidCitationIssues: {},
      invalidCitationSources: {},
      demand: 0,
      taskIds: new Set(),
      feedbackSamples: [],
      sourceTextUnitIds: new Set(),
      factIds: new Set(),
      firstSeen: null,
      lastSeen: null,
      publishLatencySeconds: null,
      feedbackFirstSeen: null,
      negativeLastSeen: null,
    });
    return byGap.get(key);
  };

  for (const event of eventRows) {
    const row = ensure(event.subject);
    if (event.type === 'skill:proposal-held') row.held++;
    if (event.type === 'skill:proposal-retry-ready') row.retryReady++;
    if (event.type === 'skill:proposal-retry-blocked') row.retryBlocked++;
    if (event.type === 'skill:proposal-retry-consumed') row.retryConsumed++;
    if (event.type === 'skill:proposed') row.proposed++;
    if (event.type === 'skill:rejected') row.rejected++;
    if (event.type === 'skill:published') row.published++;
    if (['skill:rejected', 'skill:proposal-held', 'skill:proposal-retry-blocked'].includes(event.type)) {
      row.negativeLastSeen = row.negativeLastSeen == null ? event.created_at : Math.max(row.negativeLastSeen, event.created_at);
    }
    if (event.type === 'skill:feedback') {
      row.feedbackFirstSeen = row.feedbackFirstSeen == null ? event.created_at : Math.min(row.feedbackFirstSeen, event.created_at);
      row.feedbackCount++;
      if (event.data.helpful === true || Number(event.data.helpfulness) > 0) row.helpfulCount++;
      const score = Number(event.data.helpfulness);
      if (Number.isFinite(score)) row.helpfulnessSum += score;
      const taskId = event.data.task_id ?? event.data.taskId ?? null;
      const skillUsedIds = Array.isArray(event.data.skill_used_ids ?? event.data.skillUsedIds)
        ? (event.data.skill_used_ids ?? event.data.skillUsedIds).map(String)
        : [];
      const sourceTextUnitIds = Array.isArray(event.data.source_text_unit_ids ?? event.data.sourceTextUnitIds)
        ? (event.data.source_text_unit_ids ?? event.data.sourceTextUnitIds).map(Number).filter(Number.isInteger)
        : [];
      row.feedbackSamples.push({
        task_id: taskId,
        agent_id: event.data.agent_id ?? event.data.agentId ?? null,
        helpfulness: Number.isFinite(score) ? score : null,
        helpful: event.data.helpful === true || Number(event.data.helpfulness) > 0,
        skill_used_ids: skillUsedIds,
        source_text_unit_ids: sourceTextUnitIds,
      });
      if (taskId) row.taskIds.add(String(taskId));
    }
    const invalid = event.data?.citation_validation?.invalid ?? event.data?.citationValidation?.invalid ?? [];
    if (Array.isArray(invalid) && invalid.length) {
      row.invalidCitations += invalid.length;
      for (const source of invalid) {
        const issues = source.issues?.length ? source.issues : ['invalid'];
        for (const issue of issues) {
          row.invalidCitationIssues[issue] = (row.invalidCitationIssues[issue] ?? 0) + 1;
          row.invalidCitationSources[issue] ??= [];
          if (source.source_id && !row.invalidCitationSources[issue].includes(source.source_id)) {
            row.invalidCitationSources[issue].push(source.source_id);
          }
        }
      }
    }
    row.demand = Math.max(row.demand, Number(event.data.demand ?? 0));
    for (const id of event.data.source_text_unit_ids ?? event.data.sourceTextUnitIds ?? []) row.sourceTextUnitIds.add(Number(id));
    for (const id of event.data.fact_ids ?? event.data.factIds ?? []) row.factIds.add(Number(id));
    row.firstSeen = row.firstSeen == null ? event.created_at : Math.min(row.firstSeen, event.created_at);
    row.lastSeen = row.lastSeen == null ? event.created_at : Math.max(row.lastSeen, event.created_at);
  }

  for (const approval of approvalRows) {
    const row = ensure(approval.subject || approval.payload.gap);
    if (approval.status === 'pending') row.approvalsPending++;
    if (approval.status === 'approved' || approval.status === 'resolved') row.approvalsApproved++;
    if (approval.status === 'rejected') row.approvalsRejected++;
    for (const id of approval.payload.task_ids ?? approval.payload.taskIds ?? []) row.taskIds.add(String(id));
    for (const id of approval.payload.source_text_unit_ids ?? approval.payload.sourceTextUnitIds ?? []) row.sourceTextUnitIds.add(Number(id));
    for (const id of approval.payload.fact_ids ?? approval.payload.factIds ?? []) row.factIds.add(Number(id));
    row.demand = Math.max(row.demand, Number(approval.payload.demand ?? 0));
    row.firstSeen = row.firstSeen == null ? approval.created_at : Math.min(row.firstSeen, approval.created_at);
    row.lastSeen = row.lastSeen == null ? approval.created_at : Math.max(row.lastSeen, approval.created_at);
  }

  const gaps = [...byGap.values()].map(row => {
    const taskIds = [...row.taskIds].filter(Boolean);
    const outcomes = correlateTaskOutcomes(db, taskIds, { parseJson });
    // A proposal lineage was "revised/superseded after being used" when a
    // negative event (rejected / held / retry-blocked) landed after the first
    // time one of its tasks reported feedback on the proposal.
    const revisedAfterUse = Boolean(
      row.feedbackFirstSeen != null && row.negativeLastSeen != null && row.negativeLastSeen >= row.feedbackFirstSeen
    );
    return {
      ...row,
      taskIds,
      feedbackSamples: row.feedbackSamples.slice(0, 10),
      sourceTextUnitIds: [...row.sourceTextUnitIds].filter(Number.isInteger),
      factIds: [...row.factIds].filter(Number.isInteger),
      evidenceCoverage: (row.sourceTextUnitIds.size || row.factIds.size) ? 1 : 0,
      avgHelpfulness: row.feedbackCount ? Math.round((row.helpfulnessSum / row.feedbackCount) * 1000) / 1000 : null,
      taskOutcomes: outcomes,
      outcome_rate: outcomes.outcome_rate,
      revised_after_use: revisedAfterUse,
      revision_after_use_rate: row.feedbackCount ? (revisedAfterUse ? 1 : 0) : null,
    };
  }).sort((a, b) => b.lastSeen - a.lastSeen);
  const citationRepairCandidates = citationRepairCandidatesFromGaps(gaps);

  return {
    totals: {
      held: gaps.reduce((n, r) => n + r.held, 0),
      retryReady: gaps.reduce((n, r) => n + r.retryReady, 0),
      retryBlocked: gaps.reduce((n, r) => n + r.retryBlocked, 0),
      retryConsumed: gaps.reduce((n, r) => n + r.retryConsumed, 0),
      proposed: gaps.reduce((n, r) => n + r.proposed, 0),
      rejected: gaps.reduce((n, r) => n + r.rejected, 0),
      published: gaps.reduce((n, r) => n + r.published, 0),
      approvalsPending: gaps.reduce((n, r) => n + r.approvalsPending, 0),
      approvalsApproved: gaps.reduce((n, r) => n + r.approvalsApproved, 0),
      approvalsRejected: gaps.reduce((n, r) => n + r.approvalsRejected, 0),
      invalidCitations: gaps.reduce((n, r) => n + r.invalidCitations, 0),
      invalidCitationIssues: gaps.reduce((acc, r) => {
        for (const [issue, count] of Object.entries(r.invalidCitationIssues)) {
          acc[issue] = (acc[issue] ?? 0) + count;
        }
        return acc;
      }, {}),
      feedbackCount: gaps.reduce((n, r) => n + r.feedbackCount, 0),
      helpfulCount: gaps.reduce((n, r) => n + r.helpfulCount, 0),
      gaps: gaps.length,
      citationRepairCandidates: citationRepairCandidates.length,
      taskOutcomes: (() => {
        const totals = { completed: 0, failed: 0, blocked: 0, reverted: 0, rejected: 0 };
        let correlated = 0;
        let uncorrelated = 0;
        for (const gap of gaps) {
          for (const key of Object.keys(totals)) totals[key] += gap.taskOutcomes.buckets[key] ?? 0;
          correlated += gap.taskOutcomes.correlated;
          uncorrelated += gap.taskOutcomes.uncorrelated;
        }
        return {
          correlated,
          uncorrelated,
          buckets: totals,
          outcome_rate: correlated ? Math.round((totals.completed / correlated) * 1000) / 1000 : null,
        };
      })(),
      revisedAfterUse: gaps.filter(r => r.revised_after_use).length,
      revisionAfterUseRate: (() => {
        const withFeedback = gaps.filter(r => r.feedbackCount > 0);
        return withFeedback.length
          ? Math.round((withFeedback.filter(r => r.revised_after_use).length / withFeedback.length) * 1000) / 1000
          : null;
      })(),
    },
    gaps,
    citationRepair: {
      candidates: citationRepairCandidates,
      candidateCount: citationRepairCandidates.length,
      issueClasses: citationRepairCandidates.reduce((acc, candidate) => {
        acc[candidate.issue] = (acc[candidate.issue] ?? 0) + candidate.count;
        return acc;
      }, {}),
    },
  };
}

function citationRepairAction(issue) {
  if (issue === 'unknown') return 'citation.repair';
  if (issue === 'stale') return 'source.refresh';
  if (['superseded', 'disputed', 'retired', 'expired'].includes(issue)) return 'source.mark_stale';
  return 'proposal.reject';
}

function citationRepairCandidatesFromGaps(gaps = []) {
  const candidates = [];
  for (const gap of gaps) {
    if (!(gap.held || gap.retryBlocked) || !gap.invalidCitations) continue;
    for (const [issue, count] of Object.entries(gap.invalidCitationIssues ?? {})) {
      const invalidSourceIds = [...new Set(gap.invalidCitationSources?.[issue] ?? [])];
      candidates.push({
        gap: gap.gap,
        issue,
        count,
        invalid_source_ids: invalidSourceIds,
        suggested_action: citationRepairAction(issue),
        suggested_reason: `${count} invalid citation(s) for ${gap.gap} are ${issue}.`,
        last_seen: gap.lastSeen,
      });
    }
  }
  return candidates.sort((a, b) => b.count - a.count || b.last_seen - a.last_seen);
}

function pendingCitationRepairTaskExists(db, { gap, issue, action, parseJson }) {
  const rows = db.prepare(`
    SELECT payload FROM learning_tasks
    WHERE kind=? AND subject=? AND status IN ('queued','assigned','in_progress','blocked')
    LIMIT 50
  `).all(action, gap);
  return rows.some(row => parseJson(row.payload, {}).citation_issue === issue);
}

export function createCitationRepairTasks(db, { limit = 25, source = 'brain', parseJson = JSON.parse } = {}) {
  const report = buildSkillProposalReport(db, { limit: 1000, parseJson });
  const created = [];
  const skipped = [];
  for (const candidate of report.citationRepair.candidates.slice(0, limit)) {
    const action = candidate.suggested_action;
    if (pendingCitationRepairTaskExists(db, { gap: candidate.gap, issue: candidate.issue, action, parseJson })) {
      skipped.push({ ...candidate, skipped_reason: 'pending learning task exists' });
      continue;
    }
    const taskId = createLearningTask(db, {
      kind: action,
      subject: candidate.gap,
      priority: 70 + Number(candidate.count ?? 0),
      evidenceIds: { source_ids: candidate.invalid_source_ids },
      payload: {
        gap: candidate.gap,
        citation_issue: candidate.issue,
        invalid_source_ids: candidate.invalid_source_ids,
        suggested_action: action,
        suggested_reason: candidate.suggested_reason,
        source,
      },
    });
    created.push({ ...candidate, learning_task_id: taskId });
  }
  return { candidates: report.citationRepair.candidates, created, skipped };
}

export async function handleSkillRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson }) {
  if (method === 'GET' && path === '/skill-proposals/report') {
    const limit = Math.min(Number(searchParams.get('limit') ?? 200), 1000);
    send(res, 200, { ok: true, ...buildSkillProposalReport(db, { limit, parseJson }) });
    return true;
  }

  if (method === 'POST' && path === '/skill-proposals/repair-tasks') {
    const b = await readBody(req);
    const result = createCitationRepairTasks(db, {
      limit: Math.min(Number(b.limit ?? 25), 100),
      source: b.source ?? 'brain',
      parseJson,
    });
    send(res, 200, { ok: true, ...result });
    return true;
  }

  return false;
}
