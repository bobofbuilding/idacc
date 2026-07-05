import assert from 'node:assert/strict';
import { createAndDispatchPlan } from '../src/main/work.ts';

const remoteCommands = [];
const dispatchCommands = [];

const client = {
  team: 'research',
  async agents() {
    return [
      {
        id: 'agent-lead',
        name: 'research-lead',
        status: 'running',
        port: 4101,
        createdAt: Date.now(),
        runtime: 'claude-code-cli',
      },
      {
        id: 'agent-worker',
        name: 'writer',
        status: 'running',
        port: 4102,
        createdAt: Date.now(),
        runtime: 'provider:lmstudio',
      },
    ];
  },
  async remote(command) {
    remoteCommands.push(command);
    return {
      ok: true,
      result: {
        task: {
          shortId: '#abc123',
          name: 'inventory-brain-quality',
        },
      },
    };
  },
  async dispatch(command) {
    dispatchCommands.push(command);
    return 'unexpected direct dispatch';
  },
  async tasks() {
    return [];
  },
  async tasksByStatus() {
    return [];
  },
  async activeAgentQueries() {
    return { count: 0, queries: [] };
  },
  withTeam() {
    return this;
  },
};

const result = await createAndDispatchPlan(
  client,
  'Build a cleaner Brain knowledge base.',
  [
    {
      title: 'Inventory Brain fact quality',
      description: 'Create a lead-owned parent that the manager should delegate.',
      agent: 'research-lead',
      dependsOn: [],
    },
  ],
  {
    dispatch: true,
    respectOwners: true,
    allowCoordinatorOwners: true,
  },
);

await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(remoteCommands.length, 2, 'lead-owned parent task should be created and kicked off');
assert.match(remoteCommands[0], /--owner research-lead/, 'parent task should stay assigned to the coordinator');
assert.match(remoteCommands[1], /^\/ask research-lead\b/, 'lead-owned parent should receive the delegation kickoff');
assert.match(remoteCommands[1], /delegated child tasks/i, 'kickoff should require child task reporting when the lead delegates');
assert.equal(dispatchCommands.length, 0, 'work kickoff should use manager remote queueing, not blocking dispatch');
assert.equal(result.created.length, 1);
assert.equal(result.created[0].ok, true);
assert.equal(result.created[0].agent, 'research-lead');
assert.equal(result.created[0].deferred, false, 'coordinator-owned parent should not suppress kickoff');
assert.match(result.created[0].warning || '', /kicked off for manager delegation/);
assert.equal(result.dispatched, 1);
assert.equal(result.deferred, 0);

remoteCommands.length = 0;
dispatchCommands.length = 0;

const askFailClient = {
  ...client,
  async remote(command) {
    remoteCommands.push(command);
    if (/^\/ask\b/.test(command)) throw new Error('query cap reached');
    return {
      ok: true,
      result: {
        task: {
          shortId: '#askfail',
          name: 'ask-fail-task',
        },
      },
    };
  },
};

const rejectedDispatch = await createAndDispatchPlan(
  askFailClient,
  'Create a task but fail dispatch.',
  [
    {
      title: 'Dispatch should not be counted',
      description: 'The manager accepts task creation but rejects the agent ask.',
      agent: 'writer',
      dependsOn: [],
    },
  ],
  {
    dispatch: true,
    respectOwners: true,
  },
);

assert.equal(remoteCommands.filter((cmd) => /^\/task create\b/.test(cmd)).length, 1);
assert.equal(remoteCommands.filter((cmd) => /^\/ask\b/.test(cmd)).length, 1);
assert.equal(rejectedDispatch.created.length, 1);
assert.equal(rejectedDispatch.created[0].ok, true);
assert.equal(rejectedDispatch.created[0].dispatched, false, 'failed /ask must not be reported as dispatched');
assert.match(rejectedDispatch.created[0].error || '', /dispatch failed: query cap reached/);
assert.equal(rejectedDispatch.dispatched, 0);
assert.equal(rejectedDispatch.deferred, 1);

remoteCommands.length = 0;
dispatchCommands.length = 0;

const busyOwnerClient = {
  ...client,
  async tasksByStatus(status) {
    if (status !== 'doing') return [];
    return [
      {
        title: 'Existing writer work',
        status: 'doing',
        ownerName: 'writer',
        shortId: '#busy001',
        createdAt: Date.now(),
      },
    ];
  },
  async activeAgentQueries() {
    return { count: 0, queries: [] };
  },
};

const guarded = await createAndDispatchPlan(
  busyOwnerClient,
  'Write another report.',
  [
    {
      title: 'Write second report',
      description: 'Should wait until the writer has capacity.',
      agent: 'writer',
      dependsOn: [],
    },
  ],
  {
    dispatch: true,
    respectOwners: true,
  },
);

assert.equal(remoteCommands.length, 0, 'busy owner guard must not create a queued live task');
assert.equal(dispatchCommands.length, 0, 'busy owner guard must not dispatch deferred work');
assert.equal(guarded.created.length, 1);
assert.equal(guarded.created[0].ok, false);
assert.equal(guarded.created[0].deferred, true);
assert.match(guarded.created[0].error || '', /capacity deferred/);
assert.equal(guarded.dispatched, 0);
assert.equal(guarded.deferred, 1);

remoteCommands.length = 0;
dispatchCommands.length = 0;

const cappedFanoutClient = {
  ...client,
  async agents() {
    return [
      {
        id: 'agent-lead',
        name: 'research-lead',
        status: 'running',
        port: 4101,
        createdAt: Date.now(),
        runtime: 'claude-code-cli',
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `agent-worker-${i + 1}`,
        name: `worker-${i + 1}`,
        status: 'running',
        port: 4110 + i,
        createdAt: Date.now(),
        runtime: 'provider:lmstudio',
      })),
    ];
  },
};

const capped = await createAndDispatchPlan(
  cappedFanoutClient,
  'Create too many live tasks.',
  Array.from({ length: 5 }, (_, i) => ({
    title: `Fanout task ${i + 1}`,
    description: `Task ${i + 1} should be considered by the planner.`,
    agent: `worker-${i + 1}`,
    dependsOn: [],
  })),
  {
    dispatch: true,
    respectOwners: true,
  },
);

const taskCreates = remoteCommands.filter((cmd) => /^\/task create\b/.test(cmd));
assert.equal(taskCreates.length, 3, 'live task creation should be capped per plan by default');
assert.equal(capped.created.length, 5, 'deferred over-cap proposals should remain visible to the caller');
assert.equal(capped.created.filter((task) => task.ok).length, 3);
assert.equal(capped.created.filter((task) => task.deferred && !task.ok).length, 2);
assert.match(capped.created[3].warning || '', /live task creation cap 3 reached/);
