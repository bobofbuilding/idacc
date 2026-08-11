import assert from 'node:assert/strict';
import { normalizeAgentRecord, normalizeManagerEvent, normalizeTaskRecord } from './client.ts';

const event = normalizeManagerEvent({
  seq: '42',
  topic: 'query:delivered',
  actor: { id: 'agent_123', name: 'builder' },
  subject: { query_id: 'query_1' },
  data: { message_preview: 'done' },
  occurredAt: '1780000000000',
});

assert.equal(event?.seq, 42);
assert.equal(event?.actor, 'builder');
assert.equal(event?.subject, 'query_1');
assert.equal(event?.occurred_at, 1780000000000);
assert.notEqual(String(event?.actor), '[object Object]');

const task = normalizeTaskRecord({
  short_id: '#abc12345',
  title: 'Ship the relay guard',
  status: undefined,
  owner_name: 1234,
  project_id: 'bounties',
  workflow_state: 'validated',
  validation_detail: { verdict: 'approved', completion_query_id: 'query_done_1' },
  outcome_detail: { result: { address: '0xacfbD241aE6D4DF4805D99e759503e64AB993cd4' } },
  completion_evidence: { result: 'Durable completion reply' },
  created_at: '1780000000',
  completed_at: null,
});

assert.equal(task?.shortId, '#abc12345');
assert.equal(task?.status, 'todo');
assert.equal(task?.ownerName, '1234');
assert.equal(task?.projectId, 'bounties');
assert.equal(task?.workflowState, 'validated');
assert.equal(task?.validationDetail?.completion_query_id, 'query_done_1');
assert.deepEqual(task?.outcomeDetail?.result, { address: '0xacfbD241aE6D4DF4805D99e759503e64AB993cd4' });
assert.deepEqual(task?.completionEvidence, { result: 'Durable completion reply' });
assert.equal(task?.createdAt, 1780000000000);
assert.equal(task?.completedAt, null);

const millisecondTask = normalizeTaskRecord({
  title: 'Keep millisecond timestamps stable',
  created_at: 1780000000123,
  updated_at: '1780000001123',
});
assert.equal(millisecondTask?.createdAt, 1780000000123);
assert.equal(millisecondTask?.updatedAt, 1780000001123);

assert.equal(normalizeTaskRecord(null), null);
assert.equal(normalizeManagerEvent(null), null);

const starterAgent = normalizeAgentRecord({
  id: 'agent_starter',
  name: 'coder',
  status: 'running',
  metadata: { skills: ['brain', 'catalog'] },
  brainTools: {
    skillInstalled: true,
    mcpAttached: true,
    mcpServerCount: '5',
    runtimeSupportsMcp: true,
    activeToolAccess: true,
  },
});
assert.deepEqual(starterAgent?.brainTools, {
  skillInstalled: true,
  mcpAttached: true,
  mcpServerCount: 5,
  runtimeSupportsMcp: true,
  activeToolAccess: true,
});

const malformedBrainTools = normalizeAgentRecord({
  id: 'agent_malformed',
  name: 'malformed',
  brainTools: {
    skillInstalled: 'true',
    mcpAttached: { value: true },
    activeToolAccess: 1,
  },
});
assert.equal(malformedBrainTools?.brainTools, undefined);

console.log('[managerNormalization.test] OK');
