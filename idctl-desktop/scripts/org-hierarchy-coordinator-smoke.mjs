import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { activeCoordinators } = await import('../src/main/orgSync.ts');

const coordinators = activeCoordinators({
  default: 'lead',
  'ops-team': 'ops-lead',
  'operations-team': 'ops-lead',
  skillmesh: 'skillmesh-ops-lead',
  'skillmesh-ops': 'skillmesh-ops-lead',
  public: 'public-lead',
}, ['default', 'operations-team', 'skillmesh-ops', 'public']);

assert.deepEqual(coordinators, {
  default: 'lead',
  'operations-team': 'ops-lead',
  'skillmesh-ops': 'skillmesh-ops-lead',
});

const teamsSource = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');
assert.ok(
  teamsSource.includes("const coordChoices = t.name === PRIMARY_TEAM ? ags.filter")
    && !teamsSource.includes('const runningAgents = ags.filter(isRunnableAgent);'),
  'coordinator selection should use roster membership rather than process liveness',
);
assert.ok(
  teamsSource.includes("{ requireRunnable: false }")
    && teamsSource.includes("coordinator but cannot receive work until it is running"),
  'stopped coordinators should remain configurable while execution readiness stays visible',
);
assert.ok(
  teamsSource.includes('Set coordinator failed:')
    && teamsSource.includes('is now the team coordinator'),
  'coordinator writes should report manager failures and confirmed persistence',
);

console.log('org hierarchy coordinator smoke: ok');
