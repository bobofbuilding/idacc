import assert from 'node:assert/strict';
import { delegateObjectiveToTeamLeads } from '../src/main/work.ts';
import { syncDomainsForMethod } from '../src/shared/syncDomains.ts';

function agent(name, status = 'running', runtime = 'claude-code-cli') {
  return {
    id: `agent-${name}`,
    name,
    status,
    port: 4100,
    createdAt: Date.now(),
    runtime,
  };
}

const dispatchCommands = [];
const remoteCommands = [];
let taskSeq = 0;
let dispatchMode = 'normal';

const rosters = {
  default: [agent('lead'), agent('coder'), agent('researcher')],
  research: [agent('research-lead'), agent('analyst', 'running', 'provider:lmstudio')],
  engineering: [agent('engineering-lead'), agent('implementer', 'running', 'provider:lmstudio')],
  'ops-team': [],
};

function makeClient(team = 'default') {
  return {
    team,
    async teams() {
      return [
        { id: 'default', name: 'default', agentCount: rosters.default.length },
        { id: 'research', name: 'research', agentCount: rosters.research.length },
        { id: 'engineering', name: 'engineering', agentCount: rosters.engineering.length },
      ];
    },
    async agents() {
      return rosters[team] ?? [];
    },
    async dispatch(command) {
      dispatchCommands.push({ team, command });
      if (dispatchMode === 'fail') throw new Error('agent failed');
      const available = command.match(/Assignable agents:\n([\s\S]*?)\n\nReturn ONLY/)?.[1] ?? '';
      assert.match(available, /research-lead/, 'planner prompt should offer active research lead');
      assert.match(available, /engineering-lead/, 'planner prompt should offer active engineering lead');
      assert.doesNotMatch(available, /\bcoder\b/, 'planner prompt should not offer default validators as execution owners');
      assert.doesNotMatch(available, /\bresearcher\b/, 'planner prompt should not offer default validators as execution owners');
      assert.doesNotMatch(command, /ADVISORY decomposition|fleet task manager/i, 'planner prompt must not create visible advisory draft traffic');
      return JSON.stringify([
        {
          title: 'Research remaining plan risks',
          description: 'Find plan blockers and summarize evidence for implementation.',
          agent: 'research-lead',
          dependsOn: [],
        },
        {
          title: 'Implement plan dispatch changes',
          description: 'Patch the implementation after the research packet is available.',
          agent: 'engineering-lead',
          dependsOn: [0],
        },
      ]);
    },
    async remote(command) {
      remoteCommands.push({ team, command });
      if (/^\/task create\b/.test(command)) {
        taskSeq += 1;
        return {
          ok: true,
          result: {
            task: {
              shortId: `#plan${taskSeq}`,
              name: `plan-team-lead-${taskSeq}`,
            },
          },
        };
      }
      if (/^\/ask\b/.test(command)) {
        return { ok: true, result: { queryId: `q-${team}-${taskSeq}` } };
      }
      return { ok: true, result: {} };
    },
    async tasksByStatus() {
      return [];
    },
    async activeAgentQueries() {
      return { count: 0, queries: [] };
    },
    withTeam(nextTeam) {
      return makeClient(nextTeam);
    },
  };
}

const result = await delegateObjectiveToTeamLeads(
  makeClient(),
  'goal goal_plan_smoke: Work a live brain plan through primary-lead delegation.',
  { currentTeam: 'default', primaryLead: 'lead' },
);

await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(result.ok, true);
assert.equal(result.targetCount, 2);
assert.equal(result.subtasks.length, 2);
assert.equal(result.created.filter((task) => task.ok).length, 2);
assert.equal(result.dispatched, 2);
assert.equal(result.deferred, 0);
assert.deepEqual(result.errors, [], 'normal team-lead kickoff warnings should not become blocker errors');
assert.deepEqual(result.created.map((task) => `${task.team}/${task.lead}`).sort(), ['engineering/engineering-lead', 'research/research-lead']);
assert.ok(dispatchCommands.some((row) => row.team === 'default' && /^\/ask lead\b/.test(row.command)), 'plan decomposition should go through the primary lead by default');
assert.ok(!dispatchCommands.some((row) => /\b(task-master|task-manager)\b/.test(row.command)), 'task-master should not be the default decomposition choke point');

const creates = remoteCommands.filter((row) => /^\/task create\b/.test(row.command));
const asks = remoteCommands.filter((row) => /^\/ask\b/.test(row.command));
assert.equal(creates.length, 2, 'each selected team lead should get a live task row');
assert.equal(asks.length, 2, 'each selected team lead task should be kicked off');
assert.ok(creates.some((row) => row.team === 'research' && /--owner research-lead/.test(row.command)));
assert.ok(creates.some((row) => row.team === 'engineering' && /--owner engineering-lead/.test(row.command)));
assert.ok(creates.every((row) => /child \/task rows/.test(row.command)), 'team-lead packet should require child task creation');
assert.ok(asks.some((row) => row.team === 'research' && /^\/ask research-lead\b/.test(row.command)));
assert.ok(asks.some((row) => row.team === 'engineering' && /^\/ask engineering-lead\b/.test(row.command)));

dispatchCommands.length = 0;
remoteCommands.length = 0;
taskSeq = 0;
dispatchMode = 'fail';
const fallback = await delegateObjectiveToTeamLeads(
  makeClient(),
  'goal goal_plan_fallback: Work a live brain plan even when the planner agent fails.',
  { currentTeam: 'default', primaryLead: 'lead' },
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(fallback.ok, true, 'planner failure should still create durable team-lead task rows');
assert.equal(fallback.targetCount, 2);
assert.equal(fallback.subtasks.length, 2);
assert.equal(fallback.created.filter((task) => task.ok).length, 2);
assert.equal(fallback.dispatched, 2);
assert.match(fallback.errors.join('; '), /deterministic team-lead fallback/);
assert.deepEqual(fallback.created.map((task) => `${task.team}/${task.lead}`).sort(), ['engineering/engineering-lead', 'research/research-lead']);
const fallbackCreates = remoteCommands.filter((row) => /^\/task create\b/.test(row.command));
assert.equal(fallbackCreates.length, 2, 'fallback should create one coordination task per active team lead');
assert.ok(fallbackCreates.every((row) => /Planner fallback/.test(row.command)));

const noLeadClient = makeClient();
dispatchMode = 'normal';
rosters.research = [agent('research-lead', 'stopped')];
rosters.engineering = [agent('engineering-lead', 'offline')];
const blocked = await delegateObjectiveToTeamLeads(noLeadClient, 'goal goal_plan_blocked: Work a plan.', {
  currentTeam: 'default',
  primaryLead: 'lead',
});
assert.equal(blocked.ok, false);
assert.match(blocked.errors.join('; '), /no active non-default team leads/);
assert.deepEqual(
  syncDomainsForMethod('work:delegateToTeamLeads').sort(),
  ['brain', 'dashboard', 'tasks', 'work'],
  'team-lead delegation must refresh visible task/work state',
);
