import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'idacc-goals-plan-separation-'));
process.env.IDCTL_CONFIG = join(tmp, 'config.json');

const {
  getGoal,
  isPlanObjectiveGoal,
  listGoals,
  saveGoal,
} = await import('../src/main/goalstore.ts');

try {
  const now = 1720000000000;
  saveGoal({
    id: 'goal_user_keep',
    title: 'Build a real user goal',
    idea: 'real goal',
    agent: 'lead',
    team: 'default',
    status: 'active',
    priority: 'primary',
    autopilot: false,
    content: '# Build a real user goal',
    createdAt: now,
    updatedAt: now,
  });
  saveGoal({
    id: 'goal_plan_legacy',
    title: 'Plan: leaked legacy plan objective',
    idea: 'Work live brain plan 070 - agent portal',
    agent: 'lead',
    team: 'default',
    status: 'active',
    priority: 'general',
    autopilot: false,
    content: '# Plan: leaked legacy plan objective',
    driver: { note: 'Created from brain plan 070 - agent portal' },
    createdAt: now,
    updatedAt: now,
  });
  saveGoal({
    id: 'goal_plan_tagged',
    title: 'Plan: tagged plan objective',
    idea: 'Work live brain plan 071 - agent portal',
    agent: 'lead',
    team: 'default',
    origin: 'plans',
    status: 'active',
    priority: 'general',
    autopilot: false,
    content: '# Plan: tagged plan objective',
    createdAt: now,
    updatedAt: now,
  });

  const visible = listGoals('default');
  assert.deepEqual(visible.map((g) => g.id), ['goal_user_keep']);
  assert.equal(visible[0].origin, 'goals');

  const all = listGoals('default', { includePlanObjectives: true });
  assert.deepEqual(new Set(all.map((g) => g.id)), new Set(['goal_user_keep', 'goal_plan_legacy', 'goal_plan_tagged']));
  assert.equal(all.find((g) => g.id === 'goal_plan_legacy')?.origin, 'plans');
  assert.equal(all.find((g) => g.id === 'goal_plan_tagged')?.origin, 'plans');

  const legacy = getGoal('goal_plan_legacy');
  assert.ok(legacy);
  assert.equal(legacy.origin, 'plans');
  assert.equal(isPlanObjectiveGoal(legacy), true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
