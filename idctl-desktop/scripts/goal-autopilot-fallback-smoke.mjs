import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');
const goaldriver = await readFile(new URL('../src/main/goaldriver.ts', import.meta.url), 'utf8');
const goalsView = await readFile(new URL('../src/renderer/views/Goals.tsx', import.meta.url), 'utf8');

assert.match(
  work,
  /WORK_USE_TASK_MANAGER_PLANNER[\s\S]*return \{ client, agent: fallbackLead, kind: 'lead' \}/,
  'Work decomposition should use the team lead by default instead of serializing through task-manager',
);
assert.match(
  goaldriver,
  /\/task sync-autopilot-goals --limit/,
  'IDACC should trigger the manager-owned Autopilot producer instead of creating competing task fanout',
);
assert.match(
  goaldriver,
  /enabled:\s*true/,
  'Goal driver master default should be enabled; per-goal Autopilot remains the opt-in',
);
assert.match(
  goaldriver,
  /maxOpenTasksPerGoal:\s*3/,
  'Goal driver should request a bounded number of manager-owned tasks per pass',
);
assert.match(
  work,
  /--lead-coordination/,
  'Work dispatch should pass the explicit manager flag for lead coordination packets',
);
assert.match(
  goaldriver,
  /The manager is the durable owner of goal execution/,
  'Goal driver should document the single-producer ownership boundary',
);
assert.match(goalsView, /Live manager task progress for this goal/, 'Goals should show actual live manager progress instead of only lifetime task refs');
assert.match(goalsView, /tasks\/run/, 'Goal driver control should describe the manager task request cap accurately');
