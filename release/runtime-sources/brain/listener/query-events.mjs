import { stableEvalArtifactHash } from '../eval-artifact-hash.mjs';
import { normalizeSourceOrigins } from '../source-origins.mjs';
import { agentSourceId, prefixedEntityId, querySourceId } from './provenance.mjs';

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

export async function handleQueryLearning(deps, ev, {
  topic,
  subject,
  data,
  agentName,
  agentId = '',
  ingest,
} = {}) {
  const queryId = prefixedEntityId('query', subject ?? data?.queryId ?? ev.seq, `query:${ev.seq}`);
  const queryEntityId = queryId;
  const querySource = querySourceId(queryId);
  const agentEntityId = agentId || (agentName ? `agent:${encodeURIComponent(agentName)}` : '');
  const agentSource = agentName
    ? agentSourceId(agentName)
    : agentEntityId
      ? agentSourceId(agentEntityId)
      : querySource;
  const taskId = prefixedEntityId('task', data?.task_id ?? data?.taskId ?? '', '');
  const queryLabel = queryId.startsWith('query:') ? queryId.slice('query:'.length) : queryId;
  const retrievalRoute = data?.retrieval_route ?? data?.retrievalRoute ?? 'query';
  const usedSourceIds = usedSourceIdsFromEventData(data);
  const volunteeredSourceIds = volunteeredSourceIdsFromEventData(data);
  const acceptedSourceIds = deps.canonicalSourceIds(usedSourceIds);
  const volunteeredCanonicalSourceIds = deps.canonicalSourceIds(volunteeredSourceIds);
  const hasUsedFeedback = hasUsedSourceFeedback(data);
  const prompt = data?.prompt ?? data?.query ?? data?.message ?? `Query ${queryLabel}`;

  await deps.postFacts(
    [
      ...(agentEntityId ? [{
        entity_id: agentEntityId,
        field: 'last_query_route',
        value: retrievalRoute,
        source: agentSource,
        confidence: 0.85,
        context: { query_id: queryId, event_seq: ev.seq, task_id: taskId },
      }] : []),
      ...(agentEntityId ? [{
        entity_id: agentEntityId,
        field: 'query_feedback_supplied',
        value: hasUsedFeedback ? 'yes' : 'no',
        source: agentSource,
        confidence: 0.75,
        context: { query_id: queryId, event_seq: ev.seq },
      }] : []),
      { entity_id: queryEntityId, field: 'last_route', value: retrievalRoute, source: querySource, confidence: 0.8, context: { event_seq: ev.seq, task_id: taskId } },
      { entity_id: queryEntityId, field: 'used_source_count', value: acceptedSourceIds.length, source: querySource, confidence: 0.8, context: { event_seq: ev.seq, task_id: taskId } },
      { entity_id: queryEntityId, field: 'volunteered_source_count', value: volunteeredCanonicalSourceIds.length, source: querySource, confidence: 0.75, context: { event_seq: ev.seq, task_id: taskId } },
      ...(typeof data?.durationMs === 'number' ? [{ entity_id: queryEntityId, field: 'last_latency_ms', value: data.durationMs, source: querySource, confidence: 0.75, context: { event_seq: ev.seq } }] : []),
      ...(prompt ? [{ entity_id: queryEntityId, field: 'last_query_prompt', value: deps.compact(prompt, 700), source: querySource, confidence: 0.75, context: { event_seq: ev.seq, task_id: taskId } }] : []),
    ],
    deps.eventIdempotencyKey?.(ev, 'facts:query-learning'),
  );

  if (topic === 'query:delivered' && hasUsedSourceFeedback(data)) {
    const routeIds = [retrievalRoute];
    const sourceOrigins = normalizeSourceOrigins(
      data?.brain_context?.cited?.source_origins
      ?? data?.brainContext?.cited?.source_origins
      ?? data?.metadata?.source_origins
      ?? data?.metadata?.sourceOrigins
      ?? {},
      [...acceptedSourceIds, ...volunteeredCanonicalSourceIds],
    );
    const queryText = prompt;
    const evalArtifactHash = stableEvalArtifactHash({
      query_text: queryText,
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
      agent_id: agentName ?? '',
    });
    const evalPayload = {
      query_text: queryText,
      route: retrievalRoute,
      route_ids: routeIds,
      agent_id: agentName ?? '',
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
      latency_ms: data?.durationMs ?? null,
      metadata: { automatic: true, event_seq: ev.seq, query_id: queryId, source_origins: sourceOrigins },
      ...(deps.eventIdempotencyKey
        ? { idempotency_key: deps.eventIdempotencyKey(ev, 'eval-capture:query-delivered') }
        : {}),
    };
    await deps.validateManagerContractEvent(ev, {
      subject: queryId,
      items: [{ type: 'eval_feedback', payload: evalPayload }],
    });
    await deps.brainPost('/eval/capture', evalPayload);
    await deps.recordSuccessfulTrajectory(ev, {
      taskId: evalPayload.task_id,
      queryId,
      agentId: agentName ?? '',
      intent: evalPayload.query_text,
      route: evalPayload.route,
      usedSourceIds: evalPayload.accepted_ids,
      volunteeredSourceIds: evalPayload.volunteered_source_ids,
      commands: data?.commands ?? [],
      tests: data?.tests ?? data?.test_commands ?? data?.testCommands ?? [],
      result: data?.result ?? data?.response ?? {},
      metadata: { source: 'query:delivered' },
    });
  } else if (topic === 'query:delivered') {
    await deps.recordFeedbackMissing(ev, {
      taskId,
      queryId,
      agentId: agentName ?? '',
      queryText: data?.prompt ?? data?.query ?? data?.message ?? `Query ${queryLabel}`,
      volunteeredSourceIds: volunteeredCanonicalSourceIds,
    });
  }
  const learnedArtifact = data?.learned_artifact ?? data?.learnedArtifact;
  if (learnedArtifact) {
    await deps.validateManagerContractEvent(ev, {
      subject: queryId,
      items: [{ type: 'learned_artifact', payload: learnedArtifact }],
    });
  }
  await deps.ingestLearnedArtifact(ev, learnedArtifact, ingest?.textUnitIds ?? []);
}
