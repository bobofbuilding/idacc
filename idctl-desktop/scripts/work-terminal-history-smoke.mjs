import assert from 'node:assert/strict';
import { fanOutObjectiveToActiveTeamLeads } from '../src/main/work.ts';

const objective = 'Audit every project and ship verified fixes.';
const canonicalName = 'audit-reconcile-authorized-projects';
const scenario = process.argv[2] || 'all';

function makeClient(tasksByStatus, remote) {
  const client = {
    team: 'default',
    async teams() {
      return [
        { id: 'default', name: 'default', agentCount: 1 },
        { id: 'operations-team', name: 'operations-team', agentCount: 1 },
      ];
    },
    async agents() {
      return [{
        id: 'ops-lead',
        name: 'ops-lead',
        status: 'running',
        port: 4101,
        createdAt: Date.now(),
      }];
    },
    tasksByStatus,
    remote,
    async activeAgentQueries() { return { count: 0, queries: [] }; },
    withTeam(team) { return { ...this, team }; },
  };
  return client;
}

if (scenario === 'all' || scenario === 'terminal') {
  const commands = [];
  const statuses = [];
  const completed = {
    shortId: '#a6c3b790',
    name: canonicalName,
    title: 'Audit reconcile authorized projects',
    status: 'done',
    ownerName: 'ops-lead',
    createdAt: Date.now() - 60_000,
  };
  const client = makeClient(
    async (status) => {
      statuses.push(status);
      return status === 'done' ? [completed] : [];
    },
    async (command) => {
      commands.push(command);
      if (/^\/task create "Audit reconcile authorized projects"\b/.test(command)) {
        throw new Error(`existing_task_found: ${canonicalName}`);
      }
      if (/^\/task create\b/.test(command)) {
        return { ok: true, result: { task: { shortId: '#fresh001', name: `${canonicalName}-fresh`, status: 'doing', ownerName: 'ops-lead' } } };
      }
      return { ok: true, result: { queryId: 'query-fresh' } };
    },
  );

  const result = await fanOutObjectiveToActiveTeamLeads(client, objective, 'default');

  assert.ok(statuses.includes('done'), 'repository reruns must inspect terminal history before creating a task');
  assert.equal(result[0]?.status, 'dispatched', 'completed history must permit a fresh tracked run');
  assert.ok(
    commands.some((command) => /^\/task create\b/.test(command) && !/^\/task create "Audit reconcile authorized projects"\b/.test(command)),
    'the fresh run must use a collision-free task identity instead of the completed canonical name',
  );
  assert.equal(commands.some((command) => /jumpstart-stalled.*#a6c3b790/.test(command)), false, 'completed work must never be jumpstarted');
}

if (scenario === 'all' || scenario === 'open') {
  const commands = [];
  const statuses = [];
  const open = {
    shortId: '#open001',
    name: canonicalName,
    title: 'Audit reconcile authorized projects',
    status: 'doing',
    ownerName: 'ops-lead',
    createdAt: Date.now(),
  };
  const client = makeClient(
    async (status) => {
      statuses.push(status);
      return status === 'doing' ? [open] : [];
    },
    async (command) => {
      commands.push(command);
      return { ok: true, result: { queryId: 'query-reused' } };
    },
  );

  const result = await fanOutObjectiveToActiveTeamLeads(client, objective, 'default');

  assert.deepEqual(statuses, ['todo', 'doing'], 'open-task reuse should remain bounded to live task states');
  assert.equal(result[0]?.status, 'dispatched');
  assert.match(result[0]?.detail || '', /reused open task #open001; jumpstart requested/);
  assert.equal(commands.filter((command) => /^\/task create\b/.test(command)).length, 0, 'an open canonical task must not be duplicated');
  assert.deepEqual(commands, ['/task jumpstart-stalled --task "#open001"']);
}

console.log('work terminal-history regression smoke passed');
