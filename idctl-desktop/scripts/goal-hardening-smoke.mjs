import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'idacc-goal-hardening-'));
process.env.IDCTL_CONFIG = join(tmp, 'config.json');

const { saveGoal } = await import('../src/main/goalstore.ts');
const {
  buildActiveGoalInstructions,
  dedupeGoalInstructionMemories,
  goalBrainEntity,
  goalDriverControlValue,
  goalDriverNextRunAt,
  normalizeGoalDriverConfig,
} = await import('../src/main/goaldriver.ts');

const now = 1_720_000_000_000;
const base = {
  id: 'goal-one',
  title: 'Improve task throughput',
  idea: 'Improve task throughput',
  agent: 'lead',
  team: 'default',
  origin: 'goals',
  status: 'active',
  priority: 'primary',
  autopilot: true,
  content: '# Improve task throughput\n\n- Reduce stalled work.',
  createdAt: now,
  updatedAt: now,
};

try {
  saveGoal(base);
  assert.throws(
    () => saveGoal({ ...base, id: 'goal-two', title: '  Improve **task** throughput  ' }),
    /duplicate goal:.*goal-one/,
  );
  saveGoal({
    ...base,
    id: 'goal-three',
    title: 'Improve long-term memory',
    idea: 'Improve long-term memory',
    content: '# Improve long-term memory\n\n- Preserve validated facts.',
  });

  const instructions = buildActiveGoalInstructions('default', [
    base,
    {
      ...base,
      id: 'goal-three',
      title: 'Improve long-term memory',
      autopilot: false,
      priority: 'secondary',
      content: '# Improve long-term memory\n\n- Preserve validated facts.',
    },
  ]);
  assert.equal((instructions.match(/## Active goals/g) || []).length, 1);
  assert.equal((instructions.match(/goal-one/g) || []).length, 1);
  assert.equal((instructions.match(/goal-three/g) || []).length, 1);
  assert.match(instructions, /\[Primary · Autopilot\]/);
  assert.doesNotMatch(instructions, /Active autopilot goals|Active Work goals/);
  assert.deepEqual(goalBrainEntity(base), {
    id: 'goal:goal-one',
    type: 'goal',
    name: 'Improve task throughput',
    status: 'active',
    tags: ['goal', 'primary', 'dashboard-state', 'autopilot'],
    data: {
      team: 'default',
      priority: 'primary',
      agent: 'lead',
      autopilot: true,
    },
    exactId: true,
    mergeAliases: false,
  });
  assert.deepEqual(
    dedupeGoalInstructionMemories([
      { mem_key: 'goals:autopilot:default', project: 'default' },
      { mem_key: 'goals:active:default', project: 'default' },
      { mem_key: 'policy:default', project: 'default' },
    ]).map((memory) => memory.mem_key),
    ['goals:active:default', 'policy:default'],
  );

  assert.deepEqual(normalizeGoalDriverConfig({ enabled: true, cadenceMs: 1, maxOpenTasksPerGoal: 99 }), {
    enabled: true,
    cadenceMs: 5 * 60 * 1000,
    maxOpenTasksPerGoal: 12,
  });
  assert.deepEqual(normalizeGoalDriverConfig(undefined), {
    enabled: true,
    cadenceMs: 15 * 60 * 1000,
    maxOpenTasksPerGoal: 3,
  });
  assert.equal(normalizeGoalDriverConfig({ enabled: false }).enabled, false);
  assert.deepEqual(goalDriverControlValue({ enabled: true, cadenceMs: 30 * 60 * 1000, maxOpenTasksPerGoal: 3 }), {
    schemaVersion: 1,
    enabled: true,
    cadenceMs: 30 * 60 * 1000,
    maxTasksPerRun: 3,
  });
  assert.equal(goalDriverNextRunAt(
    { enabled: true, cadenceMs: 30 * 60 * 1000, maxOpenTasksPerGoal: 3 },
    { lastCompletedAt: now },
  ), now + 30 * 60 * 1000);
  assert.equal(goalDriverNextRunAt(
    { enabled: true, cadenceMs: 30 * 60 * 1000, maxOpenTasksPerGoal: 3 },
    { lastStartedAt: now, lastCompletedAt: now - 60 * 1000 },
  ), now + 30 * 60 * 1000);
  assert.equal(goalDriverNextRunAt(
    { enabled: false, cadenceMs: 30 * 60 * 1000, maxOpenTasksPerGoal: 3 },
    { lastCompletedAt: now },
  ), null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
