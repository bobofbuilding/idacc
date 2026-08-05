import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAuthorizedProjectInventory,
  isPrimaryLeadChatTarget,
  shouldDelegatePrimaryLeadRequest,
  stripDirectLeadOverride,
} from '../src/shared/chatDelegation.ts';
import {
  fanOutObjectiveToActiveTeamLeads,
  isRepositoryAuthorityObjective,
} from '../src/main/work.ts';

assert.equal(shouldDelegatePrimaryLeadRequest('delegate this to the other team leads'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('audit each project, push updates, resolve conflicts, and merge into main'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('please repair the setup issue'), true);
assert.equal(shouldDelegatePrimaryLeadRequest('what is happening with setup?'), false);
assert.equal(shouldDelegatePrimaryLeadRequest('hello, how are you?'), false);
assert.equal(shouldDelegatePrimaryLeadRequest('/direct audit every project'), false);
assert.equal(stripDirectLeadOverride('/direct audit every project'), 'audit every project');
assert.equal(isPrimaryLeadChatTarget('default', 'lead', 'lead'), true);
assert.equal(isPrimaryLeadChatTarget('default', 'lead'), true);
assert.equal(isPrimaryLeadChatTarget('engineering-team', 'engineering-lead', 'engineering-lead'), false);
assert.equal(isPrimaryLeadChatTarget('default', 'coder', 'lead'), false);
const inventory = buildAuthorizedProjectInventory('audit each project one by one', [
  { id: 'alpha', name: 'Alpha', status: 'active', path: '/work/alpha', links: ['https://github.com/example/alpha'] },
  { id: 'paused', name: 'Paused', status: 'paused', path: '/work/paused' },
]);
assert.match(inventory, /id="alpha"/);
assert.match(inventory, /root="\/work\/alpha"/);
assert.match(inventory, /audit-reconcile-authorized-projects/);
assert.doesNotMatch(inventory, /\/work\/paused/);
assert.equal(isRepositoryAuthorityObjective('Audit every project and ship verified fixes.'), true);
assert.equal(isRepositoryAuthorityObjective('Update all git repositories and push verified fixes.'), true);
assert.equal(
  isRepositoryAuthorityObjective('Make any Brain updates required by this policy and support agent-led projects.'),
  false,
  'policy text mentioning updates and projects must not be treated as repository authority',
);

async function main(): Promise<void> {
  const chat = await readFile(new URL('../src/renderer/views/Chat.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
  const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');

  assert.match(chat, /isPrimaryLeadChatTarget\(team, target, store\.coordinator\)/, 'pinned Dashboard Chat should still recognize the default-team primary lead');
  assert.match(chat, /shouldDelegatePrimaryLeadRequest\(text\)/, 'Chat should classify actionable primary-lead work locally');
  assert.match(chat, /work:fanoutToTeamLeads/, 'Chat should use deterministic main-process delegation');
  assert.match(bridge, /fanOutObjectiveToActiveTeamLeads/, 'the bridge should expose active team-lead fan-out');
  assert.match(work, /resolveActiveTeamLeadTargets\(client, currentTeam\)/, 'team leads should be resolved from fresh manager state');

  const dispatched: Array<{ team: string; command: string }> = [];
  const activeQueries: Record<string, number> = {};
  const rosters: Record<string, Array<{ id: string; name: string; status: string; port: number; createdAt: number }>> = {
    default: [{ id: 'primary', name: 'lead', status: 'running', port: 4101, createdAt: Date.now() }],
    engineering: [{ id: 'eng-lead', name: 'engineering-lead', status: 'running', port: 4102, createdAt: Date.now() }],
    'operations-team': [
      { id: 'ops-lead', name: 'ops-lead', status: 'stopped', port: 4104, createdAt: Date.now() },
      { id: 'moderator', name: 'content-moderator', status: 'running', port: 4105, createdAt: Date.now() },
    ],
    legal: [
      { id: 'general-counsel', name: 'general-counsel', status: 'running', port: 4106, createdAt: Date.now() },
    ],
    dormant: [{ id: 'dormant-lead', name: 'dormant-lead', status: 'stopped', port: 4103, createdAt: Date.now() }],
  };
  const makeClient = (team: string): any => ({
    team,
    teams: async () => Object.keys(rosters).map((name) => ({ id: name, name, agentCount: rosters[name].length })),
    agents: async () => rosters[team] || [],
    tasksByStatus: async () => [],
    activeAgentQueries: async () => ({ count: activeQueries[team] ?? 0, queries: [] }),
    remote: async (command: string) => {
      dispatched.push({ team, command });
      if (command.includes('/agent') && command.includes('ops-lead') && command.endsWith(' start')) {
        rosters['operations-team'][0].status = 'running';
      }
      return { ok: true, result: { queryId: `query-${team}` } };
    },
    withTeam: (next: string) => makeClient(next),
  });
  const result = await fanOutObjectiveToActiveTeamLeads(makeClient('default'), 'Audit every project and ship verified fixes.', 'default');
  assert.deepEqual(result.map((row) => [row.team, row.status]), [['operations-team', 'dispatched']]);
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /\/agent "ops-lead" start/.test(row.command)), 'the configured stopped operations lead should be started');
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /^\/task create "Audit reconcile authorized projects" --owner ops-lead\b/.test(row.command)), 'repository work must create the named operations task under ops-lead');
  assert.equal(dispatched.some((row) => /content-moderator/.test(row.command)), false, 'an active specialist must not replace the configured operations lead');

  dispatched.length = 0;
  activeQueries.legal = 3;
  const policyResult = await fanOutObjectiveToActiveTeamLeads(
    makeClient('default'),
    'Delegate this IDACC agent policy to the General Council, implement it as the guiding legal policy, and make any required Brain updates for Bittrees projects.',
    'default',
  );
  assert.deepEqual(policyResult.map((row) => [row.team, row.lead, row.status]), [['legal', 'general-counsel', 'dispatched']]);
  assert.ok(dispatched.some((row) => row.team === 'legal' && /^\/ask general-counsel\b/.test(row.command)), 'General Council requests must route directly to legal/general-counsel');
  assert.equal(dispatched.some((row) => row.team === 'operations-team'), false, 'explicit General Council requests must not spill into operations');
  assert.equal(policyResult[0]?.status, 'dispatched', 'a lead with three active queries must still accept a fourth parallel request');

  console.log('chat primary-lead delegation guard ok');
}

void main();
