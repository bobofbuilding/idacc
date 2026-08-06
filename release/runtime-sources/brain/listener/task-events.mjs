import { stableEvalArtifactHash } from '../eval-artifact-hash.mjs';
import { normalizeSourceOrigins } from '../source-origins.mjs';
import { prefixedEntityId, taskSourceId } from './provenance.mjs';

function hasUsedSourceFeedback(data = {}) {
  return Array.isArray(data?.used_source_ids) || Array.isArray(data?.usedSourceIds);
}

function usedSourceIdsFromEventData(data = {}) {
  return data?.used_source_ids
    ?? data?.usedSourceIds
    ?? [];
}

function volunteeredSourceIdsFromEventData(data = {}) {
  return data?.volunteered_source_ids
    ?? data?.volunteeredSourceIds
    ?? data?.brain_context?.cited?.canonical_source_ids
    ?? data?.brainContext?.cited?.canonical_source_ids
    ?? [];
}

function feedbackCaptureStateFromEventData(data = {}, volunteeredSourceIds = []) {
  if (hasUsedSourceFeedback(data)) return 'used_sources_provided';
  if (Array.isArray(volunteeredSourceIds) && volunteeredSourceIds.length > 0) return 'volunteered_only';
  return 'totally_missing';
}

export async function handleTaskCompletionLearning(deps, ev, { actor, subject, data, ingest } = {}) {
  const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
  const source = taskSourceId(taskId);
  const taskLabel = taskId.startsWith('task:') ? taskId.slice('task:'.length) : taskId;
  const retrievalRoute = data?.retrieval_route ?? data?.retrievalRoute ?? 'task';
  const usedSourceIds = usedSourceIdsFromEventData(data);
  const volunteeredSourceIds = volunteeredSourceIdsFromEventData(data);
  const acceptedSourceIds = deps.canonicalSourceIds(usedSourceIds);
  const volunteeredCanonicalSourceIds = deps.canonicalSourceIds(volunteeredSourceIds);
  const hasUsedFeedback = hasUsedSourceFeedback(data);
  const feedbackCaptureState = feedbackCaptureStateFromEventData(data, volunteeredCanonicalSourceIds);
  const taskSummary = data?.summary ? deps.compact(data.summary, 1200) : null;

  await deps.postFacts([
    { entity_id: taskId, field: 'completion_route', value: retrievalRoute, source, confidence: 0.85, context: { event_seq: ev.seq, source_text_unit_ids: ingest?.textUnitIds ?? [] } },
    { entity_id: taskId, field: 'used_source_count', value: acceptedSourceIds.length, source, confidence: 0.85, context: { event_seq: ev.seq } },
    { entity_id: taskId, field: 'volunteered_source_count', value: volunteeredCanonicalSourceIds.length, source, confidence: 0.75, context: { event_seq: ev.seq } },
    { entity_id: taskId, field: 'feedback_supplied', value: hasUsedFeedback ? 'yes' : 'no', source, confidence: 0.75, context: { event_seq: ev.seq, source_text_unit_ids: ingest?.textUnitIds ?? [] } },
    { entity_id: taskId, field: 'feedback_capture_state', value: feedbackCaptureState, source, confidence: 0.8, context: { event_seq: ev.seq, source_text_unit_ids: ingest?.textUnitIds ?? [] } },
    ...(taskSummary ? [{ entity_id: taskId, field: 'last_result_summary', value: taskSummary, source, confidence: 0.75, context: { event_seq: ev.seq, source_text_unit_ids: ingest?.textUnitIds ?? [] } }] : []),
  ], deps.eventIdempotencyKey?.(ev, 'facts:task-learning'));

  if (hasUsedFeedback) {
    const routeIds = [retrievalRoute];
    const sourceOrigins = normalizeSourceOrigins(
      data?.brain_context?.cited?.source_origins
      ?? data?.brainContext?.cited?.source_origins
      ?? data?.metadata?.source_origins
      ?? data?.metadata?.sourceOrigins
      ?? {},
      [...acceptedSourceIds, ...volunteeredCanonicalSourceIds],
    );
    const evalArtifactHash = stableEvalArtifactHash({
      query_text: data?.title ?? data?.prompt ?? `Task ${taskLabel}`,
      route: retrievalRoute,
      route_ids: routeIds,
      required_source_ids: acceptedSourceIds,
      required_acceptance_ids: acceptedSourceIds,
      used_ids: acceptedSourceIds,
      accepted_ids: acceptedSourceIds,
      volunteered_source_ids: volunteeredCanonicalSourceIds,
      returned_entity_ids: [],
      returned_text_unit_ids: ingest?.textUnitIds ?? [],
      returned_fact_ids: [],
      task_id: taskId,
      agent_id: actor ?? data?.assignee ?? '',
    });
    const evalPayload = {
      query_text: data?.title ?? data?.prompt ?? `Task ${taskLabel}`,
      route: retrievalRoute,
      route_ids: routeIds,
      agent_id: actor ?? data?.assignee ?? '',
      task_id: taskId,
      returned_text_unit_ids: ingest?.textUnitIds ?? [],
      accepted_ids: acceptedSourceIds,
      required_source_ids: acceptedSourceIds,
      required_acceptance_ids: acceptedSourceIds,
      used_ids: acceptedSourceIds,
      artifact_hash: evalArtifactHash,
      route_ack_state: Object.fromEntries(routeIds.map((id) => [id, 'acknowledged'])),
      volunteered_source_ids: volunteeredCanonicalSourceIds,
      skill_used_ids: data?.skill_used_ids ?? data?.skillUsedIds ?? data?.learned_artifact?.skill_used_ids ?? data?.learnedArtifact?.skillUsedIds ?? [],
      skill_helpfulness: data?.skill_helpfulness ?? data?.skillHelpfulness ?? data?.learned_artifact?.skill_helpfulness ?? data?.learnedArtifact?.skillHelpfulness ?? null,
      metadata: { automatic: true, event_seq: ev.seq, source: 'task:done', source_origins: sourceOrigins },
      ...(deps.eventIdempotencyKey
        ? { idempotency_key: deps.eventIdempotencyKey(ev, 'eval-capture:task-completion') }
        : {}),
    };
    await deps.validateManagerContractEvent(ev, {
      subject: taskId,
      items: [{ type: 'eval_feedback', payload: evalPayload }],
    });
    await deps.brainPost('/eval/capture', evalPayload);
    await deps.recordSuccessfulTrajectory(ev, {
      taskId,
      agentId: actor ?? data?.assignee ?? '',
      intent: data?.title ?? data?.prompt ?? `Task ${subject}`,
      route: evalPayload.route,
      usedSourceIds: evalPayload.accepted_ids,
      volunteeredSourceIds: evalPayload.volunteered_source_ids,
      changedFiles: data?.changedFiles ?? data?.changed_files ?? [],
      commands: data?.commands ?? [],
      tests: data?.tests ?? data?.test_commands ?? data?.testCommands ?? [],
      result: data?.result ?? data?.finalAnswer ?? {},
      metadata: { source: 'task:done' },
    });
  } else {
    await deps.recordFeedbackMissing(ev, {
      taskId,
      agentId: actor ?? data?.assignee ?? '',
      queryText: data?.title ?? data?.prompt ?? `Task ${taskLabel}`,
      volunteeredSourceIds: volunteeredCanonicalSourceIds,
    });
  }
  const learnedArtifact = data?.learned_artifact ?? data?.learnedArtifact;
  if (learnedArtifact) {
    await deps.validateManagerContractEvent(ev, {
      subject: taskId,
      items: [{ type: 'learned_artifact', payload: learnedArtifact }],
    });
  }
  await deps.ingestLearnedArtifact(ev, learnedArtifact, ingest?.textUnitIds ?? []);
}
