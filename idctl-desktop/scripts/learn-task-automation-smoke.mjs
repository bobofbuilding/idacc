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
  /function shouldAutoCreateLearnTask[\s\S]*activeGoalMatches[\s\S]*length\) return false/,
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
  /learnPrimaryDirectivePrompt[\s\S]*coordinate recursive learning against active goals/,
  'Learn should route materials to the primary lead as recursive active-goal learning directives',
);
assert.match(
  materialstore,
  /learnSecondaryDirectivePrompt[\s\S]*SECONDARY\/default validator/,
  'Learn should route materials through secondary/default validators for goal-fit validation',
);
assert.match(
  materialstore,
  /learnTeamLeadDirectivePrompt[\s\S]*Use or assign the canonical Learn task references below[\s\S]*Do not create another task/,
  'Learn team-lead prompts should reuse canonical tasks instead of recursively creating duplicates',
);
assert.match(
  materialstore,
  /export async function routePendingLearnMaterials[\s\S]*Learning directive routed via primary\/secondary\/team-lead flow/,
  'Already-processed Learn materials should be backfilled through role-aware lead routing',
);
assert.match(
  materialstore,
  /LEARN_ROUTING_DISPATCH_TIMEOUT_MS[\s\S]*bridgeCall\('remote', \[`\/ask \$\{agent\}/,
  'Learn lead routing should use bounded remote dispatches so slow agents cannot block the queue runner',
);
assert.doesNotMatch(
  materialstore,
  /Do not create tasks, goals, schedules, files, commits, or status changes from this digest/,
  'Learn lead routing must not prohibit all downstream task creation from goal-relevant material',
);
assert.match(
  materialstore,
  /LEARN_TASK_AUTOMATION_RETRY_MS/,
  'Deferred Learn task automation should be cooldown-gated before retrying',
);
assert.match(
  materialstore,
  /LEARN_MAX_TASKS_PER_MATERIAL = 2[\s\S]*LEARN_MAX_AUTOMATION_ATTEMPTS = 3/,
  'Learn automation should use a bounded canonical task set and bounded retries',
);
assert.match(
  materialstore,
  /function learnGoalContextFingerprint[\s\S]*activeGoalMatches[\s\S]*routedTeams/,
  'Learn progression should reopen only when active-goal or routed-team context changes',
);
assert.match(
  materialstore,
  /autoTaskStatus = 'parked'[\s\S]*Bounded fan-out/,
  'Excess recommendations should be parked instead of retried forever',
);
assert.match(
  materialstore,
  /legacyUnboundedRetry[\s\S]*Previous unbounded retry cycle parked[\s\S]*resetLegacyRetry/,
  'Existing unbounded retry records should be parked but reopen on explicit reprocessing',
);
assert.match(
  materialstore,
  /function retryBackoffMs[\s\S]*LEARN_RETRY_BACKOFF_CAP_MS/,
  'Failed automation should use capped exponential backoff',
);
assert.match(
  materialstore,
  /function mergeLearnRoutingResults[\s\S]*isLearnRoutingSatisfied/,
  'Role routing should preserve successful deliveries across retries',
);
assert.match(
  materialstore,
  /LEARN_MAX_ROUTING_ATTEMPTS = 3[\s\S]*routingAttempts >= LEARN_MAX_ROUTING_ATTEMPTS/,
  'Learn routing should park an unchanged incomplete route after bounded attempts',
);
assert.match(
  materialstore,
  /legacyRoutingEvents[\s\S]*legacyRoutingEvents >= LEARN_MAX_ROUTING_ATTEMPTS/,
  'Existing materials with repeated legacy routing attempts should stop without another retry storm',
);
assert.match(
  materialstore,
  /const deliveries: Array<Promise<void>>[\s\S]*await Promise\.all\(deliveries\)/,
  'Independent primary, validator, and team-lead routing should dispatch in parallel',
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
  /routePendingLearnMaterials\(\{ limit: hasQueued \? 1 : 3 \}\)/,
  'Learn queue runner should backfill role-aware lead routing while idle',
);
assert.match(
  main,
  /case 'materials:autoCreateTasks'/,
  'Main process should expose an explicit Learn task automation backfill hook',
);
assert.match(
  main,
  /case 'materials:routeLeads'/,
  'Main process should expose an explicit Learn lead-routing backfill hook',
);
assert.match(
  syncDomains,
  /\^materials:\(autoCreateTasks\|routeLeads\)\$[\s\S]*'tasks'[\s\S]*'work'[\s\S]*'dashboard'/,
  'materials lead/task automation should refresh task/work/dashboard views',
);
