export async function recordSuccessfulTrajectory({
  brainPost,
  compact,
  canonicalSourceIds,
  eventIdempotencyKey,
}, ev, {
  taskId = '',
  queryId = '',
  agentId = '',
  intent = '',
  route = '',
  usedSourceIds = [],
  volunteeredSourceIds = [],
  changedFiles = [],
  commands = [],
  tests = [],
  result = {},
  metadata = {},
} = {}) {
  const accepted = canonicalSourceIds(usedSourceIds);
  if (!accepted.length) return null;
  const subject = taskId || queryId || ev.subject || '';
  const streamId = String(
    ev?.stream_id
    ?? ev?.streamId
    ?? ev?.team_id
    ?? ev?.teamId
    ?? ev?.team
    ?? 'default',
  );
  const eventKey = eventIdempotencyKey
    ? eventIdempotencyKey(ev, 'successful-trajectory')
    : `manager-event:${encodeURIComponent(streamId)}:${encodeURIComponent(String(ev?.seq ?? 'unknown'))}`;
  const key = `trajectory:${eventKey}`;
  const occurredAt = Number(ev?.occurred_at ?? ev?.occurredAt);
  const recordedAt = Number.isFinite(occurredAt) && occurredAt >= 0
    ? new Date(occurredAt < 100_000_000_000 ? occurredAt * 1000 : occurredAt).toISOString()
    : null;
  const trajectory = {
    task_id: taskId,
    query_id: queryId,
    agent_id: agentId,
    route,
    intent: String(intent ?? '').slice(0, 1000),
    accepted_source_ids: accepted,
    volunteered_source_ids: canonicalSourceIds(volunteeredSourceIds),
    changed_files: Array.isArray(changedFiles) ? changedFiles.map(String).slice(0, 50) : [],
    commands: Array.isArray(commands) ? commands.map(compact).slice(0, 25) : [],
    tests: Array.isArray(tests) ? tests.map(compact).slice(0, 25) : [],
    result: typeof result === 'object' ? result : { value: result },
    event_seq: ev.seq,
    event_topic: ev.topic,
    recorded_at: recordedAt,
    metadata,
  };
  const content = [
    `Successful task trajectory for ${subject || agentId || 'unknown task'}.`,
    `Agent: ${agentId || 'unknown'}. Route: ${route || 'unknown'}.`,
    trajectory.intent ? `Intent: ${trajectory.intent}` : '',
    `Accepted sources: ${accepted.join(', ')}.`,
    trajectory.changed_files.length ? `Changed files: ${trajectory.changed_files.join(', ')}.` : '',
    trajectory.tests.length ? `Tests: ${trajectory.tests.join(' | ')}.` : '',
    `Trajectory JSON: ${JSON.stringify(trajectory)}`,
  ].filter(Boolean).join('\n');
  return brainPost('/memory/task-trajectories', {
    key,
    content,
    tags: ['trajectory', 'successful-task', 'self-learning', agentId, route].filter(Boolean),
    shared: true,
    metadata: trajectory,
  }, { strict: false });
}
