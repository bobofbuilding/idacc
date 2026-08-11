import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allTeamsAgentsPollDelay,
  eventLoopEpochIsCurrent,
  eventsInvalidateViews,
  initializeEventStreamCursor,
  reconcileEventStreamCursor,
  snapshotConnectionAfterFailure,
  viewNeedsAllTeamsAgents,
} from '../src/renderer/store.ts';

const storeSource = readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf8');
const tasksSource = readFileSync(new URL('../src/renderer/views/Tasks.tsx', import.meta.url), 'utf8');
assert.match(
  storeSource,
  /\}, \[needsAllTeamsAgents, tick\]\);/,
  'an explicit fleet refresh must immediately reload the all-team roster used by HR rows',
);
assert.match(tasksSource, /const ownerStopped = owned && !!ownerAgent && !liveAgent\(ownerAgent\.status\)/,
  'Doing tasks must stop advertising working when their known owner is stopped');
assert.match(tasksSource, /owner stopped · recovery needed/,
  'stopped-owner tasks must expose a recovery state instead of a live-working badge');

const ev = (topic) => ({ topic, payload: {}, timestamp: Date.now() });

assert.equal(viewNeedsAllTeamsAgents('dashboard'), true);
assert.equal(viewNeedsAllTeamsAgents('tasks'), true);
assert.equal(viewNeedsAllTeamsAgents('teams'), true);
assert.equal(viewNeedsAllTeamsAgents('settings'), false);
assert.equal(viewNeedsAllTeamsAgents('inbox'), false);
assert.equal(viewNeedsAllTeamsAgents('modules'), true);
assert.equal(viewNeedsAllTeamsAgents('projects'), true);
assert.equal(viewNeedsAllTeamsAgents('identity'), true);
assert.equal(viewNeedsAllTeamsAgents('computer'), true);

assert.equal(allTeamsAgentsPollDelay('dashboard'), 15000);
assert.equal(allTeamsAgentsPollDelay('tasks'), 15000);
assert.equal(allTeamsAgentsPollDelay('teams'), 60000);
assert.equal(allTeamsAgentsPollDelay('modules'), 60000);

assert.equal(snapshotConnectionAfterFailure(1), 'connecting');
assert.equal(snapshotConnectionAfterFailure(2), 'offline');
assert.equal(snapshotConnectionAfterFailure(3), 'offline');

assert.equal(eventsInvalidateViews([ev('task:created')], 'tasks'), true);
assert.equal(eventsInvalidateViews([ev('task:created')], 'dashboard'), true);
assert.equal(eventsInvalidateViews([ev('task:created')], 'settings'), false);

assert.equal(eventsInvalidateViews([ev('agent:started')], 'teams'), true);
assert.equal(eventsInvalidateViews([ev('agent:started')], 'computer'), true);
assert.equal(eventsInvalidateViews([ev('agent:started')], 'inbox'), false);

assert.equal(eventsInvalidateViews([ev('comms:message')], 'dashboard'), false);
assert.equal(eventsInvalidateViews([ev('learn:ready')], 'tasks'), true);

// A renderer origin can outlive multiple app profiles, all of which commonly
// contain a team named "default". Prove that the legacy team-only cursor is
// migrated once, then each Manager stream advances independently.
class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();
storage.setItem('idacc:event-cursor:default', '500');

const profileA = initializeEventStreamCursor(
  'default',
  { stream_id: 'profile-a-team-id', next_seq: 500 },
  storage,
);
assert.deepEqual(profileA, { seq: 500, streamId: 'profile-a-team-id' });

// The Manager recognizes that A's seq 500 cannot belong to fresh stream B.
// cursor_reset is authoritative: zero replaces 500 instead of Math.max
// preserving the stale value forever.
const profileBReset = reconcileEventStreamCursor(
  'default',
  profileA,
  { stream_id: 'profile-b-team-id', next_seq: 0, cursor_reset: true },
  storage,
);
assert.deepEqual(profileBReset, {
  cursor: { seq: 0, streamId: 'profile-b-team-id' },
  acceptEvents: false,
  clearEvents: true,
});

const profileB = initializeEventStreamCursor(
  'default',
  { stream_id: 'profile-b-team-id', next_seq: 0 },
  storage,
);
assert.deepEqual(profileB, { seq: 0, streamId: 'profile-b-team-id' });

const profileBAdvanced = reconcileEventStreamCursor(
  'default',
  profileB,
  { stream_id: 'profile-b-team-id', next_seq: 1, cursor_reset: false },
  storage,
);
assert.deepEqual(profileBAdvanced, {
  cursor: { seq: 1, streamId: 'profile-b-team-id' },
  acceptEvents: true,
  clearEvents: false,
});

// Ordinary same-stream responses remain monotonic.
const profileBOutOfOrder = reconcileEventStreamCursor(
  'default',
  profileBAdvanced.cursor,
  { stream_id: 'profile-b-team-id', next_seq: 0, cursor_reset: false },
  storage,
);
assert.equal(profileBOutOfOrder.cursor.seq, 1);
assert.equal(profileBOutOfOrder.clearEvents, false);

// A delayed long-poll response from the previous team/profile must fail closed
// after the stream epoch changes, even before React runs effect cleanup.
assert.equal(eventLoopEpochIsCurrent(true, 7, 7), true);
assert.equal(eventLoopEpochIsCurrent(false, 7, 7), false);
assert.equal(eventLoopEpochIsCurrent(true, 8, 7), false);

// Switching back restores A's exact stream cursor, not B's team-label cursor.
const profileARestored = initializeEventStreamCursor(
  'default',
  { stream_id: 'profile-a-team-id', next_seq: 500 },
  storage,
);
assert.deepEqual(profileARestored, { seq: 500, streamId: 'profile-a-team-id' });
