import assert from 'node:assert/strict';
import { canonicalTeamName, matchingExistingTeamName, sameLogicalTeam } from './teamNames.ts';

assert.equal(canonicalTeamName('Operations Team'), 'ops-team');
assert.equal(canonicalTeamName('operations-team'), 'ops-team');
assert.equal(sameLogicalTeam('operations-team', 'ops-team'), true);
assert.equal(sameLogicalTeam('skillmesh-ops', 'ops-team'), false);
assert.equal(
  matchingExistingTeamName('ops-team', ['default', 'operations-team', 'research']),
  'operations-team',
  'legacy manager team names should win over creating a duplicate canonical team',
);
assert.equal(
  matchingExistingTeamName('ops-team', ['default', 'ops-team', 'operations-team']),
  'ops-team',
  'an exact manager team name should win when both names exist',
);
assert.equal(matchingExistingTeamName('onchain', ['onchain-execution']), 'onchain-execution');
assert.equal(matchingExistingTeamName('new-team', ['default']), undefined);

console.log('team name compatibility tests passed');
