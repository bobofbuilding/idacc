import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const work = await readFile(new URL('../src/main/work.ts', import.meta.url), 'utf8');
const goaldriver = await readFile(new URL('../src/main/goaldriver.ts', import.meta.url), 'utf8');
const settingsSchema = await readFile(new URL('../../idctl/src/settings/schema.ts', import.meta.url), 'utf8');
const goalsView = await readFile(new URL('../src/renderer/views/Goals.tsx', import.meta.url), 'utf8');
const workLearningStatus = await readFile(new URL('../src/renderer/views/WorkLearningStatus.tsx', import.meta.url), 'utf8');
const tasksView = await readFile(new URL('../src/renderer/views/Tasks.tsx', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

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
  /defaultGoalDriverSettings/,
  'Desktop goal cadence should consume the shared first-run default',
);
assert.match(
  settingsSchema,
  /defaultGoalDriverSettings[\s\S]*enabled:\s*true[\s\S]*goalDriver:\s*defaultGoalDriverSettings\(\)/,
  'Fresh profiles should persist the enabled global master while per-goal Autopilot remains the opt-in',
);
assert.match(
  settingsSchema,
  /maxOpenTasksPerGoal:\s*3/,
  'Goal driver should default to bounded goal starts per cycle',
);
assert.match(
  work,
  /--lead-coordination/,
  'Work dispatch should pass the explicit manager flag for lead coordination packets',
);
assert.match(
  goaldriver,
  /The Manager is the authoritative goal executor[\s\S]*single producer/,
  'Goal driver should document the single-producer ownership boundary',
);
assert.match(goalsView, /Live manager task progress for this goal/, 'Goals should show actual live manager progress instead of only lifetime task refs');
assert.match(goalsView, /starts\/cycle/, 'Goal driver control should describe its per-cycle coordination limit accurately');
assert.match(goalsView, /last automated/, 'Goals should distinguish automation activity from local edit age');
assert.match(
  main,
  /function kickGoalDriverAfterMutation[\s\S]*?goalDriver:syncNow[\s\S]*?^}/m,
  'Saving a goal should sync the manager control state without force-running Autopilot',
);
assert.doesNotMatch(
  main.match(/function kickGoalDriverAfterMutation[\s\S]*?^}/m)?.[0] ?? '',
  /goalDriver:runOnce/,
  'Saving a goal must not bypass the configured cadence',
);
assert.match(
  tasksView,
  /tab === 'goals'.*tab === 'learn'.*tab === 'schedule'.*tab === 'loops'.*tab === 'dream'/,
  'The requested Work tabs should share one Active Learning status surface',
);
assert.match(workLearningStatus, /Goal autopilot[\s\S]*Learn queue[\s\S]*Recurring work[\s\S]*Brain maintenance/, 'The Work status surface should expose the coordinated automation lifecycle');
