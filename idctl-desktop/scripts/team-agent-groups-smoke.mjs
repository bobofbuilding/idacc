import assert from 'node:assert/strict';
import { mapTeamAgentGroups } from '../src/shared/teamAgentGroups.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let active = 0;
let maxActive = 0;
const groups = await mapTeamAgentGroups(['alpha', 'beta', 'alpha', '', 'gamma', 'delta'], async (team) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await sleep(10);
  active -= 1;
  return [`${team}-agent`];
}, 2);

assert.deepEqual(groups.map((group) => group.team), ['alpha', 'beta', 'gamma', 'delta']);
assert.deepEqual(groups.map((group) => group.agents[0]), ['alpha-agent', 'beta-agent', 'gamma-agent', 'delta-agent']);
assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);

const partial = await mapTeamAgentGroups(['ok', 'fails'], async (team) => {
  if (team === 'fails') throw new Error('boom');
  return ['ok-agent'];
});

assert.deepEqual(partial, [
  { team: 'ok', agents: ['ok-agent'] },
  { team: 'fails', agents: [] },
]);

console.log('team-agent-groups smoke ok');
