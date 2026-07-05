import assert from 'node:assert/strict';
import { eventsInvalidateViews, viewNeedsAllTeamsAgents } from '../src/renderer/store.ts';

const ev = (topic) => ({ topic, payload: {}, timestamp: Date.now() });

assert.equal(viewNeedsAllTeamsAgents('dashboard'), true);
assert.equal(viewNeedsAllTeamsAgents('tasks'), true);
assert.equal(viewNeedsAllTeamsAgents('teams'), true);
assert.equal(viewNeedsAllTeamsAgents('settings'), false);
assert.equal(viewNeedsAllTeamsAgents('wiki'), false);
assert.equal(viewNeedsAllTeamsAgents('inbox'), false);

assert.equal(eventsInvalidateViews([ev('task:created')], 'tasks'), true);
assert.equal(eventsInvalidateViews([ev('task:created')], 'dashboard'), true);
assert.equal(eventsInvalidateViews([ev('task:created')], 'settings'), false);
assert.equal(eventsInvalidateViews([ev('task:created')], 'wiki'), false);

assert.equal(eventsInvalidateViews([ev('agent:started')], 'teams'), true);
assert.equal(eventsInvalidateViews([ev('agent:started')], 'computer'), true);
assert.equal(eventsInvalidateViews([ev('agent:started')], 'inbox'), false);

assert.equal(eventsInvalidateViews([ev('comms:message')], 'dashboard'), false);
assert.equal(eventsInvalidateViews([ev('learn:ready')], 'tasks'), true);
