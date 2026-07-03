import assert from 'node:assert/strict';
import { normalizeManagerEvent, normalizeTaskRecord } from './client.ts';

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
  created_at: '1780000000',
  completed_at: null,
});

assert.equal(task?.shortId, '#abc12345');
assert.equal(task?.status, 'todo');
assert.equal(task?.ownerName, '1234');
assert.equal(task?.createdAt, 1780000000);
assert.equal(task?.completedAt, null);

assert.equal(normalizeTaskRecord(null), null);
assert.equal(normalizeManagerEvent(null), null);

console.log('[managerNormalization.test] OK');
