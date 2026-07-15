import assert from 'node:assert/strict';

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

console.log('org hierarchy coordinator smoke: ok');
