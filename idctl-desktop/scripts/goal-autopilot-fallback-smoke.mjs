import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');
const goaldriver = await readFile(new URL('../src/main/goaldriver.ts', import.meta.url), 'utf8');

assert.match(
  work,
  /planner\.kind === 'task-manager'[\s\S]*lead fallback decomposition[\s\S]*activePlanner = \{ client, agent: lead, kind: 'lead' \}/,
  'Work decomposition should fall back from a busy task-manager to the team lead planner',
);
assert.match(
  goaldriver,
  /function deterministicGoalLeadSubtasks/,
  'Goal driver should have a deterministic team-lead fallback when decomposition cannot run',
);
assert.match(
  goaldriver,
  /plannerFallbackReason[\s\S]*deterministicGoalLeadSubtasks\(goal, targets, slots, plannerFallbackReason\)/,
  'Default-team Autopilot should create bounded team-lead tasks when all planners are blocked',
);
assert.match(
  goaldriver,
  /via planner fallback/,
  'Goal driver metadata should explain when task creation used planner fallback',
);
