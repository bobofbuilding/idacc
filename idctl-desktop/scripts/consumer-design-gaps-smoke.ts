import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScheduleEntry } from '../../idctl/src/api/client.ts';
import { getChat, patchChat, saveChat } from '../src/main/chatstore.ts';
import { saveLoop } from '../src/main/loopstore.ts';
import {
  DREAM_DAILY_DAYS,
  DREAM_LEGACY_SCHEDULE_PREFIX,
  DREAM_SCHEDULE_OBJECTIVE,
  dreamScheduleDaysLabel,
  dreamScheduleTime,
  isDreamSchedule,
  scheduledDreamArchives,
} from '../src/shared/dreamSchedule.ts';
import { exactQueryActivity, mergeExactQueryActivity } from '../src/shared/chatActivity.ts';
import { MAX_LOOP_STEPS } from '../src/shared/loopLimits.ts';
import { reconcileScheduleSnapshot } from '../src/shared/scheduleSnapshot.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schedule: ScheduleEntry = {
  id: 'cal_dream_1',
  title: 'Calendar: lead',
  kind: 'calendar',
  active: true,
  deliveryMode: 'talk',
  sourceType: 'cli',
  targets: ['lead'],
  intervalSeconds: null,
  timezone: 'Europe/Lisbon',
  localTimeSeconds: 4 * 3600 + 30 * 60,
  localDate: null,
  daysOfWeek: 'mon,tue,wed,thu,fri',
  message: DREAM_SCHEDULE_OBJECTIVE,
  createdAt: 1_750_000_000,
  lastRunAt: 1_750_100_000,
  lastStatus: 'sent',
};

assert.equal(isDreamSchedule(schedule), true);
assert.equal(isDreamSchedule({ kind: 'calendar', message: `${DREAM_LEGACY_SCHEDULE_PREFIX} legacy report` }), true);
assert.equal(isDreamSchedule({ kind: 'heartbeat', message: DREAM_SCHEDULE_OBJECTIVE }), false);
assert.equal(dreamScheduleTime(schedule), '04:30');
assert.equal(dreamScheduleDaysLabel(schedule.daysOfWeek), 'weekdays');
assert.equal(dreamScheduleDaysLabel(DREAM_DAILY_DAYS), 'daily');

const archived = scheduledDreamArchives([schedule], {
  lead: [
    {
      id: 11,
      type: 'schedule.received',
      timestamp: 1_750_100_000_000,
      data: {
        query_id: 'query_dream_1',
        schedule: { id: schedule.id, kind: 'calendar' },
      },
    },
    {
      id: 12,
      type: 'query.completed',
      timestamp: 1_750_100_020_000,
      data: {
        query_id: 'query_unrelated',
        result: { result: 'must not be archived' },
      },
    },
    {
      id: 13,
      type: 'query.completed',
      timestamp: 1_750_100_030_000,
      data: {
        query_id: 'query_dream_1',
        result: { result: '## Consolidation\n- durable scheduled result' },
      },
    },
  ],
}, 'default');

assert.equal(archived.length, 1);
assert.equal(archived[0].id, 'dream_scheduled_query_dream_1');
assert.equal(archived[0].content, '## Consolidation\n- durable scheduled result');
assert.deepEqual(archived[0].source, {
  kind: 'schedule',
  scheduleId: schedule.id,
  queryId: 'query_dream_1',
});
assert.equal(
  scheduledDreamArchives([schedule], { lead: [] }, 'default').length,
  0,
  'a completion without the exact scheduled receipt must not be archived',
);
assert.equal(
  scheduledDreamArchives([], {
    lead: [
      {
        type: 'schedule.received',
        timestamp: 1_750_100_000_000,
        data: {
          query_id: 'query_removed_schedule',
          message: DREAM_SCHEDULE_OBJECTIVE,
          schedule: { id: 'removed_schedule', kind: 'calendar' },
        },
      },
      {
        type: 'query.completed',
        timestamp: 1_750_100_030_000,
        data: {
          query_id: 'query_removed_schedule',
          result: { result: '## Consolidation\n- replacement-safe result' },
        },
      },
    ],
  }, 'default').length,
  1,
  'a durable Dream receipt remains recognizable after its schedule is replaced',
);
assert.equal(
  scheduledDreamArchives([schedule], {
    lead: [
      {
        type: 'schedule.received',
        timestamp: 1_750_100_000_000,
        query_id: 'query_top_level',
        data: { schedule: { id: schedule.id, kind: 'calendar' } },
      },
      {
        type: 'query.completed',
        timestamp: 1_750_100_030_000,
        query_id: 'query_top_level',
        data: { result: { result: 'top-level query id compatibility' } },
      },
    ],
  }, 'default').length,
  1,
  'top-level Manager query ids remain compatible with exact receipt/completion joins',
);

const activity = [
  { seq: 1, at: 100, agent: 'lead', team: 'default', kind: 'tool', summary: 'exact one', queryId: 'q1' },
  { seq: 2, at: 110, agent: 'lead', team: 'default', kind: 'delegate', summary: 'other work', queryId: 'q2' },
  { seq: 3, at: 120, agent: 'lead', team: 'default', kind: 'read', summary: 'untagged' },
];
assert.deepEqual(exactQueryActivity(activity, 'q1').map((step) => step.summary), ['exact one']);
assert.deepEqual(exactQueryActivity(activity, ''), []);
const mergedActivity = mergeExactQueryActivity(
  [activity[0]],
  [
    activity[0],
    { seq: 1, at: 200, agent: 'lead', team: 'default', kind: 'tool', summary: 'after restart', queryId: 'q1' },
    activity[1],
  ],
  'q1',
  10,
);
assert.deepEqual(
  mergedActivity.map((step) => step.summary),
  ['exact one', 'after restart'],
  'overlapping polls dedupe, while a reused sequence after Manager restart remains distinct',
);

const aggregateSchedules = [
  { id: 'alpha-stale', team: 'alpha', active: false },
  { id: 'beta-kept', team: 'beta', active: true },
];
const localSchedules = [{ id: 'alpha-current', active: true }];
assert.deepEqual(
  reconcileScheduleSnapshot(aggregateSchedules, localSchedules, 'alpha'),
  {
    all: [
      { id: 'beta-kept', team: 'beta', active: true },
      { id: 'alpha-current', team: 'alpha', active: true },
    ],
    local: [{ id: 'alpha-current', team: 'alpha', active: true }],
  },
  'the direct active-team read replaces stale aggregate rows without dropping other teams',
);
assert.deepEqual(
  reconcileScheduleSnapshot(null, localSchedules, 'alpha')?.local.map((item) => item.id),
  ['alpha-current'],
  'an all-team compatibility failure falls back to the active-team schedule read',
);
assert.deepEqual(
  reconcileScheduleSnapshot(null, localSchedules, 'alpha', aggregateSchedules)?.all.map((item) => item.id),
  ['beta-kept', 'alpha-current'],
  'a display refresh retains previously verified other-team rows during an all-team outage',
);
assert.deepEqual(
  reconcileScheduleSnapshot(aggregateSchedules, null, 'alpha')?.local.map((item) => item.id),
  ['alpha-stale'],
  'a direct active-team failure falls back to the all-team aggregate',
);
assert.equal(reconcileScheduleSnapshot(null, null, 'alpha'), null);

const chat = readFileSync(join(root, 'src/renderer/views/Chat.tsx'), 'utf8');
assert.match(chat, /mergeExactQueryActivity\(prev, r\.items, running\.queryId, 60\)/);
assert.match(chat, /mergeExactQueryActivity\(actSteps, r\.items, inf\.queryId, 80\)/);
assert.match(chat, /if \(polling\) return/);
assert.match(chat, /patchActiveSession/);
assert.match(chat, /\{ appendMessages: m \}/);
assert.match(chat, /Delete blocked: this chat changed while confirmation was open/);
assert.match(chat, /permanently discards that pending reply/);
assert.doesNotMatch(chat, /function patch\(fn:/);
assert.doesNotMatch(chat, /traceLines\(|storeEventsRef|time-windowed annotation/);
assert.doesNotMatch(chat, /since < 0|actCursor = -1/);

const dream = readFileSync(join(root, 'src/renderer/views/Dream.tsx'), 'utf8');
assert.match(dream, /dreams:archiveScheduled/);
assert.match(dream, /call<TeamSchedule\[]>\('schedules:allTeams'\)/);
assert.match(dream, /scheduleStamp\(confirmedReplacing\) !== scheduleStamp\(replacing\)/);
assert.match(dream, /dispatchWorkToTeam/);
assert.match(dream, /Save schedule/);
assert.match(dream, /pauseSchedule/);
assert.match(dream, /runs while IDACC is open; resumes after restart/);
assert.match(dream, /if \(allSchedules\) \{/);
assert.doesNotMatch(dream, /call<ScheduleEntry\[]>\('schedules'\)/);

const settings = readFileSync(join(root, 'src/renderer/views/Settings.tsx'), 'utf8');
assert.match(settings, /SETTINGS_CONCURRENCY_REFRESH_MS = 3_000/);
assert.match(settings, /window\.setInterval\(refresh, SETTINGS_CONCURRENCY_REFRESH_MS\)/);
assert.match(settings, /concServerValueRef/);
assert.match(settings, /concRefreshPromiseRef/);
assert.match(settings, /concSaveRef/);
assert.match(settings, /subActionRef/);
assert.match(settings, /updateApplyRef/);
assert.match(settings, /Number\.isInteger\(n\)/);
assert.match(settings, /window\.idagents\?\.copyText/);
assert.match(settings, /clipboard access is unavailable/);
assert.match(settings, /live · running/);
assert.match(settings, /setManualCopy\(copied \? null : \{ label, text \}\)/);
assert.match(settings, /Copy manually · \{manualCopy\.label\}/);
assert.match(settings, /<textarea[\s\S]*?readOnly[\s\S]*?manualCopy\.text/);
assert.doesNotMatch(settings, /copy the (?:install |sign-in )?command from the dialog/i);

const scheduleView = readFileSync(join(root, 'src/renderer/views/Schedule.tsx'), 'utf8');
assert.match(scheduleView, /Heartbeat objective for/);
assert.match(scheduleView, /check-in state could not be re-verified/);
assert.match(scheduleView, /changed while confirmation was open/);
assert.match(scheduleView, /while IDACC is open/);
assert.match(scheduleView, /Promise\.allSettled/);
assert.match(scheduleView, /call<ScheduleEntry\[]>\('schedules'\)/);
assert.match(scheduleView, /if \(snapshot\) \{/);

const loopsView = readFileSync(join(root, 'src/renderer/views/Loops.tsx'), 'utf8');
const loopStore = readFileSync(join(root, 'src/main/loopstore.ts'), 'utf8');
assert.equal(MAX_LOOP_STEPS, 20);
assert.throws(
  () => saveLoop({
    id: 'oversized-loop',
    title: 'Oversized',
    goal: 'must be rejected',
    team: 'alpha',
    steps: Array.from({ length: MAX_LOOP_STEPS + 1 }, (_, index) => ({ agent: 'lead', task: `step ${index + 1}` })),
    createdAt: 1,
    updatedAt: 1,
  }),
  new RegExp(`at most ${MAX_LOOP_STEPS} steps`),
  'the profile store rejects rather than truncates an oversized chain',
);
assert.match(loopsView, /MAX_LOOP_STEPS/);
assert.match(loopStore, /loop must contain at most \$\{MAX_LOOP_STEPS\} steps/);
assert.doesNotMatch(loopStore, /\.slice\(0,\s*20\)/);
assert.match(loopsView, /!isDreamSchedule\(s\)/);
assert.match(loopsView, /dispatchWorkToTeam/);
assert.match(loopsView, /readSchedulesForTeam/);
assert.match(loopsView, /builderActionRef/);
assert.doesNotMatch(loopsView, /catch \(\(\) => \[\]\)/);
assert.doesNotMatch(loopsView, /24\/7|app is closed/i);

const productSpec = readFileSync(join(root, '..', 'docs', 'PRODUCT_SPEC.md'), 'utf8');
assert.doesNotMatch(productSpec, /24\/7|app is closed|IDACC was closed|draft caps 12|generic failure/i);
assert.match(productSpec, /share one 20-step limit/);

const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8');
assert.match(main, /startScheduledDreamArchiveLoop/);
assert.match(main, /scheduledDreamArchives/);
assert.match(main, /getDream\(candidate\.id\)/);

const chatStore = readFileSync(join(root, 'src/main/chatstore.ts'), 'utf8');
assert.match(chatStore, /appendMessages\?: ChatMessage\[]/);
assert.match(chatStore, /p\.appendMessages\.map\(stripPending\)/);

const previousConfig = process.env.IDCTL_CONFIG;
const chatStoreTmp = mkdtempSync(join(tmpdir(), 'idacc-chat-patch-'));
process.env.IDCTL_CONFIG = join(chatStoreTmp, 'config.json');
try {
  saveChat({
    id: 'concurrency-smoke',
    title: 'Before',
    named: false,
    unread: false,
    inflight: null,
    team: 'alpha',
    target: 'lead',
    projectId: '',
    messages: [{ id: 1, role: 'you', who: 'you', text: 'question' }],
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(patchChat('concurrency-smoke', {
    appendMessages: [
      { id: 2, role: 'agent', who: 'lead', text: 'pending' },
      { id: 3, role: 'system', who: '', text: 'notice' },
    ],
  }).ok, true);
  assert.equal(patchChat('concurrency-smoke', {
    title: 'Renamed',
    named: true,
    patchMessage: { id: 2, patch: { text: 'delivered' } },
  }).ok, true);
  const patchedChat = getChat('concurrency-smoke');
  assert.equal(patchedChat?.title, 'Renamed');
  assert.equal(patchedChat?.named, true);
  assert.deepEqual(
    patchedChat?.messages.map((message) => [message.id, message.text]),
    [[1, 'question'], [2, 'delivered'], [3, 'notice']],
    'targeted metadata, batch append, and reply patches preserve one another',
  );
} finally {
  if (previousConfig === undefined) delete process.env.IDCTL_CONFIG;
  else process.env.IDCTL_CONFIG = previousConfig;
  rmSync(chatStoreTmp, { recursive: true, force: true });
}

const bridge = readFileSync(join(root, 'src/main/bridge.ts'), 'utf8');
assert.match(bridge, /'dreams:scheduledRuns'/);
assert.match(bridge, /teamClient\.agents\(\)/);
assert.match(bridge, /schedule\.targets/);

console.log('consumer design gaps smoke: ok');
