import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shouldDelegatePrimaryLeadRequest, stripDirectLeadOverride } from '../src/shared/chatDelegation.ts';
import { fanOutObjectiveToActiveTeamLeads } from '../src/main/work.ts';

assert.equal(shouldDelegatePrimaryLeadRequest('delegate this to the other team leads'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('audit each project, push updates, resolve conflicts, and merge into main'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('please repair the setup issue'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('what is happening with setup?'), false);
assert.equal(shouldDelegatePrimaryLeadRequest('hello, how are you?'), false);
assert.equal(shouldDelegatePrimaryLeadRequest('/direct audit every project'), false);
assert.equal(stripDirectLeadOverride('/direct audit every project'), 'audit every project');

async function main(): Promise<void> {
  const chat = await readFile(new URL('../src/renderer/views/Chat.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
  const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');

  assert.match(chat, /target === defaultTarget && !teamOverride/, 'only the primary lead chat should auto-delegate');
  assert.match(chat, /shouldDelegatePrimaryLeadRequest\(text\)/, 'Chat should classify actionable primary-lead work locally');
  assert.match(chat, /work:fanoutToTeamLeads/, 'Chat should use deterministic main-process delegation');
  assert.match(bridge, /fanOutObjectiveToActiveTeamLeads/, 'the bridge should expose active team-lead fan-out');
  assert.match(work, /resolveActiveTeamLeadTargets\(client, currentTeam\)/, 'team leads should be resolved from fresh manager state');

  const dispatched: Array<{ team: string; command: string }> = [];
  const rosters: Record<string, Array<{ id: string; name: string; status: string; port: number; createdAt: number }>> = {
    default: [{ id: 'primary', name: 'lead', status: 'running', port: 4101, createdAt: Date.now() }],
    engineering: [{ id: 'eng-lead', name: 'engineering-lead', status: 'running', port: 4102, createdAt: Date.now() }],
    dormant: [{ id: 'dormant-lead', name: 'dormant-lead', status: 'stopped', port: 4103, createdAt: Date.now() }],
  };
  const makeClient = (team: string): any => ({
    team,
    teams: async () => Object.keys(rosters).map((name) => ({ id: name, name, agentCount: rosters[name].length })),
    agents: async () => rosters[team] || [],
    tasksByStatus: async () => [],
    activeAgentQueries: async () => ({ count: 0, queries: [] }),
    remote: async (command: string) => {
      dispatched.push({ team, command });
      return { ok: true, result: { queryId: `query-${team}` } };
    },
    withTeam: (next: string) => makeClient(next),
  });
  const result = await fanOutObjectiveToActiveTeamLeads(makeClient('default'), 'Audit every project and ship verified fixes.', 'default');
  assert.deepEqual(result.map((row) => [row.team, row.status]), [['engineering', 'dispatched']]);
  assert.equal(dispatched.length, 1, 'only active non-default team leads should receive work');
  assert.equal(dispatched[0].team, 'engineering');
  assert.match(dispatched[0].command, /^\/ask engineering-lead\b/);

  console.log('chat primary-lead delegation guard ok');
}

void main();
