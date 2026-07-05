import assert from 'node:assert/strict';
import { agentIsLive, primaryLeadReadiness } from '../src/shared/planRouting.ts';

assert.equal(agentIsLive('running'), true);
assert.equal(agentIsLive('online'), true);
assert.equal(agentIsLive('stopped'), false);
assert.equal(agentIsLive('crashed'), false);
assert.equal(agentIsLive(''), false);

assert.deepEqual(
  primaryLeadReadiness(
    'lead',
    'default',
    [{ team: 'default', lead: 'lead', activeCount: 1, totalCount: 3 }],
    [],
  ),
  { ok: true },
  'live manager lead match should allow plan delegation',
);

assert.deepEqual(
  primaryLeadReadiness(
    'lead',
    'default',
    [],
    [{ name: 'lead', status: 'running', team: 'default' }],
    'default',
  ),
  { ok: true },
  'local current-team roster should be enough when all-teams data is not loaded on Plans',
);

const wrongLead = primaryLeadReadiness(
  'lead',
  'default',
  [{ team: 'default', lead: 'ops-lead', activeCount: 2, totalCount: 3 }],
  [],
);
assert.equal(wrongLead.ok, false);
assert.match(wrongLead.reason, /not the active lead/);
assert.match(wrongLead.reason, /ops-lead/);

const stopped = primaryLeadReadiness(
  'lead',
  'default',
  [{ team: 'default', lead: null, activeCount: 0, totalCount: 3 }],
  [{ name: 'lead', status: 'stopped', team: 'default' }],
);
assert.equal(stopped.ok, false);
assert.match(stopped.reason, /not running/);
