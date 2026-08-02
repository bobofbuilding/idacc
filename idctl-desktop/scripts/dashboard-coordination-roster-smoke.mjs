import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFleetStructureSnapshot } from '../src/renderer/fleetStructure.ts';

const dashboard = await readFile(new URL('../src/renderer/views/Dashboard.tsx', import.meta.url), 'utf8');
const teams = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');
const teamGraph = await readFile(new URL('../src/renderer/views/TeamGraph.tsx', import.meta.url), 'utf8');

assert.match(
  dashboard,
  /buildFleetStructureSnapshot\(/,
  'Dashboard should derive Live Coordination from the shared fleet snapshot',
);
assert.match(
  teams,
  /buildFleetStructureSnapshot\(/,
  'HR Structure and Manage should derive from the shared fleet snapshot',
);
assert.match(
  teams,
  /allKnownTeamNames\.map\(\(team\) => relayByTeam\.get\(team\) \?\? \{ team, delegates: null \}\)/,
  'Manage overview should retain canonical teams even when relay metadata is partial',
);
assert.match(
  teams,
  /normalizeSecondaryRows\(hier\.secondaries \?\? \[\]\)/,
  'Manage agent summaries should read validator scope from the same hierarchy as Structure',
);
assert.match(
  dashboard,
  /<CoordinationTree[^>]+fleetAgents=\{fleetStructure\.agents\}[^>]+coordinationTeams=\{coordinationTeams\}/,
  'Dashboard should pass the same canonical agents and teams into Live Coordination',
);
assert.match(
  dashboard,
  /useState<OrgHier>\(EMPTY_ORG_HIERARCHY\)/,
  'Live Coordination should begin with an honest empty hierarchy while Manager data loads',
);
assert.doesNotMatch(
  dashboard,
  /setHier\(h\.primary\s*\?\s*h\s*:/,
  'Dashboard must not invent a fallback primary hierarchy that HR Manager did not return',
);
assert.match(
  dashboard,
  /primary lead not configured/,
  'Dashboard should disclose a missing primary instead of drawing an invented lead',
);
assert.match(
  dashboard,
  /fleetAgents\.find\(\(agent\) => agent\.team === team && agent\.name === name\)/,
  'Dashboard should identify agents by team and name',
);
assert.doesNotMatch(
  dashboard,
  /\?\?\s*fleetAgents\.find\(\(agent\) => agent\.name === name\)/,
  'Dashboard must not borrow a same-named agent from another team',
);
assert.match(
  teamGraph,
  /isAgentLive\(agent\)/,
  'HR Structure should use the shared live-state classifier',
);
assert.match(
  dashboard,
  /controlStateWarning/,
  'Dashboard should surface Manager hierarchy compatibility warnings',
);

const snapshot = buildFleetStructureSnapshot({
  teams: [
    { id: 'team-default', name: 'default', agentCount: 1 },
    { id: 'team-public', name: 'public', agentCount: 0 },
  ],
  allAgents: [
    { id: 'default-lead', name: 'lead', team: 'default', status: 'running' },
    { id: 'ops-coder', name: 'coder', team: 'ops', status: 'running' },
    { id: 'research-coder', name: 'coder', team: 'research', status: 'stopped' },
  ],
  hierarchy: {
    primary: { team: 'default', agent: 'lead' },
    coordinators: { ops: 'coder', 'hierarchy-only': 'missing-lead' },
    secondaries: [{ team: 'leadership', agent: 'secondary', leadsTeams: ['research', 'secondary-only'] }],
    teams: ['default', 'ops', 'research'],
  },
});

assert.deepEqual(
  snapshot.teamNames,
  ['default', 'hierarchy-only', 'leadership', 'ops', 'research', 'secondary-only'],
  'Team rows, roster tags, coordinators, and secondary coverage should form one stable team set',
);
assert.equal(snapshot.teamNames.includes('public'), false, 'Reserved empty public team should stay hidden');
assert.equal(
  snapshot.agents.filter((agent) => agent.name === 'coder').length,
  2,
  'Same-named agents in different teams must remain separate fleet identities',
);
assert.equal(
  snapshot.groups.find((group) => group.team === 'research')?.agents[0]?.id,
  'research-coder',
  'Canonical groups should preserve the correct team-specific agent',
);

const activeFallback = buildFleetStructureSnapshot({
  teams: [],
  allAgents: [{ id: 'other-agent', name: 'other-agent', team: 'other-team', status: 'stopped' }],
  activeAgents: [{ id: 'active-only', name: 'active-only', status: 'running' }],
  activeTeam: 'current-team',
});
assert.equal(
  activeFallback.agents.find((agent) => agent.id === 'active-only')?.team,
  'current-team',
  'Active roster should backfill team identity while the cross-team roster loads',
);
assert.equal(activeFallback.agents.length, 2, 'Active roster should augment a partial cross-team roster');
assert.equal(activeFallback.groups.find((group) => group.team === 'current-team')?.agents.length, 1);

console.log('dashboard coordination roster smoke: ok');
