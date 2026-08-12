import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAuthorizedProjectInventory,
  isCoordinatorChatTarget,
  isPrimaryLeadChatTarget,
  shouldDelegatePrimaryLeadRequest,
  stripDirectLeadOverride,
} from '../src/shared/chatDelegation.ts';
import {
  fanOutObjective,
  fanOutObjectiveToActiveTeamLeads,
  isRepositoryAuthorityObjective,
} from '../src/main/work.ts';
import { ManagerError } from '../../idctl/src/api/client.ts';
import { formatTaskRetrievalResponse, isCompletedTaskResultRequest, isTaskRetrievalOnlyRequest } from '../src/shared/taskRetrieval.ts';

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
assert.equal(isCoordinatorChatTarget('bob', 'bob'), true);
assert.equal(isCoordinatorChatTarget('worker', 'bob'), false);
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
assert.equal(
  isTaskRetrievalOnlyRequest('Return the completed legal deliverables from #dcfc0409. Do not delegate or mark new work.'),
  true,
);
assert.equal(isTaskRetrievalOnlyRequest('Implement the work in #dcfc0409 without delegation.'), false);
assert.equal(isCompletedTaskResultRequest('Return the public funding address from completed task #2d87fb3d.'), true);
assert.equal(isCompletedTaskResultRequest('Implement the remaining work in task #2d87fb3d.'), false);
const retrieval = formatTaskRetrievalResponse([{
  ref: '#dcfc0409',
  found: true,
  team: 'legal',
  task: {
    title: 'Prepare legal deliverables',
    status: 'done',
    workflowState: 'validated',
    createdAt: 1,
  },
  completionReply: 'Legal deliverable: terms and privacy review complete.',
  structuredDeliverables: { evmAddresses: [], urls: [], outcomeResult: { result: 'Policy packet stored' } },
}]);
assert.match(retrieval, /No delegation or new work was started/);
assert.match(retrieval, /Policy packet stored/);
assert.match(retrieval, /terms and privacy review complete/);

async function main(): Promise<void> {
  const chat = await readFile(new URL('../src/renderer/views/Chat.tsx', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../src/renderer/views/Dashboard.tsx', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
  const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');

  assert.match(chat, /isPrimaryLeadChatTarget\(team, target, store\.coordinator\)/, 'pinned Dashboard Chat should still recognize the default-team primary lead');
  assert.match(chat, /shouldDelegatePrimaryLeadRequest\(text\)/, 'Chat should classify actionable primary-lead work locally');
  assert.match(chat, /isTaskRetrievalOnlyRequest\(text\)/, 'explicit exact-task retrieval must bypass agent delegation');
  assert.match(chat, /isCompletedTaskResultRequest\(text\)/, 'completed-result lookups must resolve without manager delegation');
  assert.match(chat, /formatTaskRetrievalResponse\(taskContexts\)/, 'retrieval-only replies must come from durable Manager evidence');
  assert.match(chat, /'tasks:context'/, 'exact task references must be grounded in current Manager task evidence');
  assert.match(chat, /AUTHORITATIVE MANAGER TASK EVIDENCE/, 'non-terminal exact-task questions must still supersede stale agent memory');
  assert.match(chat, /work:fanoutToTeamLeads/, 'Chat should use deterministic main-process delegation');
  assert.match(chat, /work:delegateToCoordinator/, 'direct coordinator Chat work should be materialized as a manager-backed task');
  assert.match(chat, /isCoordinatorChatTarget\(target, store\.coordinator\)/, 'named team coordinators should not receive an untracked prose-only work request');
  assert.match(chat, /scopedMessage, team, projectId \|\| undefined/, 'Chat should pass its selected project into lead delegation');
  assert.match(chat, /Open \{taskRef\} in Work/, 'duplicate-task failures should link directly to the blocking Work task');
  assert.match(chat, /sessionStorage\.setItem\('idacc:tasks:search', taskRef\)/, 'the Work link should focus the exact blocking task');
  assert.match(dashboard, /<Chat store=\{store\} navigate=\{navigate\}/, 'Dashboard Chat should forward navigation to duplicate-task recovery links');
  assert.match(bridge, /fanOutObjectiveToActiveTeamLeads/, 'the bridge should expose active team-lead fan-out');
  assert.match(bridge, /delegateObjectiveToCoordinator/, 'the bridge should expose tracked direct-coordinator delegation');
  assert.match(work, /resolveActiveTeamLeadTargets\(client, currentTeam\)/, 'team leads should be resolved from fresh manager state');
  assert.match(work, /repository remote\/default branch/, 'operations fan-out should include an early release preflight');
  assert.match(work, /export async function delegateObjectiveToCoordinator/, 'direct coordinator requests should create a durable parent task');

  const dispatched: Array<{ team: string; command: string }> = [];
  const activeQueries: Record<string, number> = {};
  const taskRows: Record<string, Record<string, any[]>> = {};
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
    tasksByStatus: async (status: string) => taskRows[team]?.[status] ?? [],
    activeAgentQueries: async () => ({ count: activeQueries[team] ?? 0, queries: [] }),
    remote: async (command: string) => {
      dispatched.push({ team, command });
      if (command.includes('/agent') && command.includes('ops-lead') && command.endsWith(' start')) {
        rosters['operations-team'][0].status = 'running';
      } else if (command.startsWith('/agent ') && command.endsWith(' start')) {
        throw new Error('agent start unavailable in smoke fixture');
      }
      if (command.startsWith('/task create ')) {
        const owner = command.match(/--owner\s+([^\s]+)/)?.[1]?.replace(/^"|"$/g, '') || '';
        return {
          ok: true,
          result: {
            task: {
              shortId: '#created',
              name: 'audit-reconcile-authorized-projects',
              ownerName: owner,
              status: 'doing',
            },
          },
        };
      }
      return { ok: true, result: { queryId: `query-${team}` } };
    },
    withTeam: (next: string) => makeClient(next),
  });
  const result = await fanOutObjectiveToActiveTeamLeads(makeClient('default'), 'Audit every project and ship verified fixes.', 'default', 'tcp', '/workspace/projects/tcp');
  assert.deepEqual(result.map((row) => [row.team, row.status]), [['operations-team', 'dispatched']]);
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /\/agent "ops-lead" start/.test(row.command)), 'the configured stopped operations lead should be started');
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /^\/task create "Audit reconcile authorized projects" --owner ops-lead\b/.test(row.command)), 'repository work must create the named operations task under ops-lead');
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /--project "tcp"/.test(row.command)), 'project-scoped Chat delegation must preserve the project on the parent task');
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /Project root: \/workspace\/projects\/tcp/.test(row.command)), 'project-scoped Chat delegation must preserve the exact project checkout path');
  assert.equal(dispatched.some((row) => /content-moderator/.test(row.command)), false, 'an active specialist must not replace the configured operations lead');

  dispatched.length = 0;
  activeQueries.legal = 3;
  const policyResult = await fanOutObjectiveToActiveTeamLeads(
    makeClient('default'),
    'Delegate this IDACC agent policy to the General Council, implement it as the guiding legal policy, and make any required Brain updates for Bittrees projects.',
    'default',
  );
  assert.deepEqual(policyResult.map((row) => [row.team, row.lead, row.status]), [['legal', 'general-counsel', 'dispatched']]);
  assert.ok(dispatched.some((row) => row.team === 'legal' && /^\/task create\b/.test(row.command) && /--owner general-counsel\b/.test(row.command)), 'General Council requests must create a durable legal/general-counsel coordination task');
  assert.ok(policyResult[0]?.taskRef, 'a lead prompt is not reported without its durable Work reference');
  assert.equal(dispatched.some((row) => row.team === 'operations-team'), false, 'explicit General Council requests must not spill into operations');
  assert.equal(policyResult[0]?.status, 'dispatched', 'a lead with three active queries must still accept a fourth parallel request');

  dispatched.length = 0;
  taskRows['operations-team'] = {
    todo: [{ name: 'audit-reconcile-authorized-projects', shortId: 'audit-open', title: 'Audit reconcile authorized projects', status: 'todo' }],
    doing: [],
    done: [],
  };
  const reuseResult = await fanOutObjectiveToActiveTeamLeads(makeClient('default'), 'Audit every project and ship verified fixes.', 'default');
  assert.deepEqual(reuseResult.map((row) => [row.team, row.lead, row.status]), [['operations-team', 'ops-lead', 'dispatched']]);
  assert.match(reuseResult[0]?.detail || '', /reused open task audit-open; jumpstart requested/);
  assert.ok(dispatched.some((row) => row.team === 'operations-team' && /\/task jumpstart-stalled --task "audit-open"/.test(row.command)), 'open repository audit task should be jumpstarted');
  assert.equal(dispatched.some((row) => /^\/task create\b/.test(row.command)), false, 'open repository audit task should be reused instead of recreated');

  dispatched.length = 0;
  taskRows['operations-team'] = {
    todo: [],
    doing: [],
    done: [{ name: 'audit-reconcile-authorized-projects', shortId: 'audit-done', title: 'Audit reconcile authorized projects', status: 'done' }],
  };
  const freshResult = await fanOutObjectiveToActiveTeamLeads(makeClient('default'), 'Audit every project and ship verified fixes again.', 'default');
  assert.deepEqual(freshResult.map((row) => [row.team, row.lead, row.status]), [['operations-team', 'ops-lead', 'dispatched']]);
  assert.match(freshResult[0]?.detail || '', /created fresh task .*previous audit-reconcile-authorized-projects is terminal/);
  const createRow = dispatched.find((row) => row.team === 'operations-team' && /^\/task create\b/.test(row.command));
  assert.ok(createRow, 'terminal repository audit history should create a fresh tracked run');
  assert.match(createRow.command, /^\/task create "Audit reconcile authorized projects \d{8}t\d{6}z" --owner ops-lead\b/);
  assert.match(createRow.command, / --plan "audit-reconcile-authorized-projects-\d{8}t\d{6}z"/);
  assert.doesNotMatch(createRow.command, /^\/task create "Audit reconcile authorized projects" --owner ops-lead\b/, 'terminal history must not recreate the fixed task slug');

  const duplicateClient: any = {
    ...makeClient('operations-team'),
    async remote() {
      throw new ManagerError('existing_task_found', 409, {
        existing_task: 'finish-bounties-interface',
        existing_task_ref: '#c1ee4ddf',
        existing_status: 'doing',
        existing_title: 'Finish Bounties interface',
        existing_owner: 'coder',
        suggested_action: 'status-check',
      });
    },
    withTeam() { return this; },
  };
  const duplicateResult = await fanOutObjective(
    duplicateClient,
    'Finish the Bounties interface.',
    ['operations-team'],
    'bounties',
    '/workspace/projects/bounties',
  );
  assert.equal(duplicateResult[0]?.status, 'deferred');
  assert.equal(duplicateResult[0]?.existingTask?.ref, '#c1ee4ddf');
  assert.equal(duplicateResult[0]?.existingTask?.owner, 'coder');
  assert.match(duplicateResult[0]?.detail || '', /existing task #c1ee4ddf .* is doing with coder; open Work → Tasks to status-check it/);

  console.log('chat primary-lead delegation guard ok');
}

main().then(
  () => process.exit(0),
  (error) => { console.error(error); process.exit(1); },
);
