import assert from 'node:assert/strict';
import { allTeamsAgentsPollDelay, eventsInvalidateViews, snapshotConnectionAfterFailure, viewNeedsAllTeamsAgents } from '../src/renderer/store.ts';

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
