import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPrimaryLeadPlanWork, mergePlanTaskRefs, planWorkGoalId } from '../src/shared/planWork.ts';

const plan = {
  num: '042',
  title: 'Refactor plan dispatch flow',
  file: '/brain/plans/042-refactor-plan-dispatch-flow.md',
  status: 'PENDING',
  mtime: 1720000000000,
};

const work = buildPrimaryLeadPlanWork(
  plan,
  '# Refactor plan dispatch flow\n\nCreate objective and delegated manager tasks.',
  'lead',
  'default',
  1720000000000,
);

assert.equal(work.goal.id, planWorkGoalId(plan));
assert.match(work.goal.id, /^goal_plan_[a-z0-9]+$/);
assert.equal(work.goal.status, 'active');
assert.equal(work.goal.priority, 'general');
assert.equal(work.goal.autopilot, false);
assert.equal(work.goal.agent, 'lead');
assert.equal(work.goal.team, 'default');
assert.match(work.goal.content, /Work > Plans/);
assert.match(work.goal.content, /Source Plan/);
assert.match(work.objective, new RegExp(work.goal.id));
assert.match(work.objective, /primary-lead delegation/);
assert.equal(work.subtask.agent, 'lead');
assert.deepEqual(work.subtask.dependsOn, []);
assert.match(work.subtask.description, new RegExp(work.goal.id));
assert.match(work.subtask.description, /Source brain plan/);
assert.match(work.subtask.description, /do not do the whole plan yourself/);
assert.match(work.subtask.description, /close only after child tasks/);
assert.ok(work.subtask.description.length <= 400, 'lead parent task description should preserve critical instructions inside the createPlan clip limit');

const same = buildPrimaryLeadPlanWork(plan, 'changed body', 'lead', 'default', 1720000000001);
assert.equal(same.goal.id, work.goal.id, 'same brain plan should reuse a stable goal/objective id');

const different = buildPrimaryLeadPlanWork({ ...plan, file: '/brain/plans/043-other.md' }, '', 'lead', 'default');
assert.notEqual(different.goal.id, work.goal.id, 'different brain plan should get a distinct objective id');

assert.deepEqual(
  mergePlanTaskRefs(['#one', '#two'], ['#two', '#three'], 3),
  ['#one', '#two', '#three'],
  'plan task refs should deduplicate while preserving current progress',
);
assert.deepEqual(
  mergePlanTaskRefs(['#one', '#two', '#three'], ['#four'], 2),
  ['#three', '#four'],
  'plan task history should stay bounded',
);

const plansView = await readFile(new URL('../src/renderer/views/Plans.tsx', import.meta.url), 'utf8');
assert.match(plansView, /const openForGoal = currentTasks\.filter/, 're-running Work should inspect existing live plan tasks');
assert.match(plansView, /continuing existing work without duplicate fanout/, 'plans should continue existing work instead of creating duplicate task batches');
assert.match(plansView, /setInterval\(\(\) => \{ void reloadProgress\(\); \}, 30_000\)/, 'plan cards should refresh live task progress at a bounded cadence');
