import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const materialstore = await readFile(new URL('../src/main/materialstore.ts', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const syncDomains = await readFile(new URL('../src/shared/syncDomains.ts', import.meta.url), 'utf8');

assert.match(
  materialstore,
  /function recommendationId\(/,
  'Learn recommendations should use stable ids so reprocessing does not duplicate task creation',
);
assert.match(
  materialstore,
  /function mergeExistingRecommendations\(/,
  'Learn processing should preserve prior accepted/deferred automation state across reprocessing',
);
assert.match(
  materialstore,
  /function shouldAutoCreateLearnTask[\s\S]*activeGoalMatches[\s\S]*length > 0/,
  'Learn should only auto-create tasks after active-goal matching',
);
assert.match(
  materialstore,
  /bridgeCall\('work:createPlan'[\s\S]*dispatch: false[\s\S]*lane: 'todo'[\s\S]*respectOwners: true/,
  'Learn task automation should create queued Work tasks through the guarded work:createPlan path',
);
assert.match(
  materialstore,
  /export async function markRecommendation[\s\S]*autoCreateLearnTasks\(material\)[\s\S]*resumed after review/,
  'Clearing the last blocking Learn recommendation should resume guarded task automation',
);
assert.match(
  materialstore,
  /notifyMaterialChange\('tasks', material\)/,
  'Learn task automation should emit a narrow task refresh event',
);
assert.match(
  materialstore,
  /export async function autoCreatePendingLearnTasks[\s\S]*Learn task automation backfill/,
  'Already-processed Learn materials should be backfilled into queued Work tasks',
);
assert.match(
  materialstore,
  /LEARN_TASK_AUTOMATION_RETRY_MS/,
  'Deferred Learn task automation should be cooldown-gated before retrying',
);
assert.match(
  main,
  /reason === 'tasks' \? 'materials:tasks' : 'materials:changed'/,
  'Main process should publish the task-specific Learn sync event',
);
assert.match(
  main,
  /autoCreatePendingLearnTasks\(\{ limit: hasQueued \? 2 : 6 \}\)/,
  'Learn queue runner should backfill eligible task recommendations while idle',
);
assert.match(
  main,
  /case 'materials:autoCreateTasks'/,
  'Main process should expose an explicit Learn task automation backfill hook',
);
assert.match(
  syncDomains,
  /\^materials:tasks\$[\s\S]*'tasks'[\s\S]*'work'[\s\S]*'dashboard'/,
  'materials:tasks should refresh task/work/dashboard views',
);
