import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');
const goaldriver = await readFile(new URL('../src/main/goaldriver.ts', import.meta.url), 'utf8');

assert.match(
  work,
  /WORK_USE_TASK_MANAGER_PLANNER[\s\S]*return \{ client, agent: fallbackLead, kind: 'lead' \}/,
  'Work decomposition should use the team lead by default instead of serializing through task-manager',
);
assert.match(
  goaldriver,
  /function deterministicGoalLeadSubtasks/,
  'Goal driver should have a deterministic team-lead fallback when decomposition cannot run',
);
assert.match(
  goaldriver,
  /enabled:\s*true/,
  'Goal driver master default should be enabled; per-goal Autopilot remains the opt-in',
);
assert.match(
  goaldriver,
  /maxOpenTasksPerGoal:\s*8/,
  'Goal driver default open-task cap should allow bounded team-lead fanout',
);
assert.match(
  goaldriver,
  /GOAL_LEAD_OWNER_OPEN_TASK_CAP\s*=\s*4/,
  'Goal driver should allow team leads a bounded coordination queue instead of blocking at one open task plus one query',
);
assert.match(
  goaldriver,
  /function pickWakeableLead/,
  'Goal driver should include parked but wakeable team leads in goal fanout target resolution',
);
assert.match(
  goaldriver,
  /allowInactiveOwners:\s*true/,
  'Goal driver should preserve parked team-lead owners so the manager can wake them for assigned goal work',
);
assert.match(
  goaldriver,
  /ownerOpenTaskCap:\s*GOAL_LEAD_OWNER_OPEN_TASK_CAP/,
  'Goal driver should use a higher explicit owner cap for team-lead coordination fanout',
);
assert.match(
  goaldriver,
  /leadCoordination:\s*true/,
  'Goal driver should mark Autopilot team-lead packets as lead coordination work',
);
assert.match(
  work,
  /--lead-coordination/,
  'Work dispatch should pass the explicit manager flag for lead coordination packets',
);
assert.match(
  goaldriver,
  /deterministicGoalLeadSubtasks\(goal, targets, slots, 'default-team Autopilot direct team-lead fanout'\)/,
  'Default-team Autopilot should create bounded team-lead tasks directly instead of serializing on a planner',
);
assert.doesNotMatch(
  goaldriver,
  /waiting on \$\{openTagged\.length\} open goal task/,
  'Goal driver should top up toward the cap instead of waiting for every open goal task to finish',
);
assert.match(
  goaldriver,
  /existing open goal task\(s\) remain/,
  'Goal driver metadata should report existing open goal tasks while still attempting top-up fanout',
);
assert.match(
  goaldriver,
  /via direct fanout/,
  'Goal driver metadata should explain when task creation used direct fanout',
);
