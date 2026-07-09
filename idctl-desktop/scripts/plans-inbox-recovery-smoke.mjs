import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const plans = await readFile(new URL('../src/renderer/views/Plans.tsx', import.meta.url), 'utf8');
const inbox = await readFile(new URL('../src/renderer/views/Inbox.tsx', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const shared = await readFile(new URL('../src/shared/planInbox.ts', import.meta.url), 'utf8');

assert.ok(
  plans.includes('function relayPlanBlocker('),
  'Plans work failures should relay blockers through a shared formatter',
);
assert.ok(
  plans.includes('options: [\'Retry work pass\', \'Hold this plan\']'),
  'Plan failure decisions should offer retry and hold choices',
);
assert.ok(
  plans.includes('-> Inbox') && plans.includes('decision write failed'),
  'Plans UI should distinguish successful Inbox surfacing from local write failure',
);
assert.ok(
  inbox.includes('Retry with delegation fallback') && inbox.includes('Retry recovery pass') && inbox.includes('Pause plan'),
  'Plan failure Inbox questions should present solution-oriented recovery actions',
);
assert.ok(
  inbox.includes('Recommended: retry the work pass'),
  'Plan failure Inbox questions should include a concrete recommended next action',
);
assert.ok(
  plans.includes('Work > Plans saved objective') && plans.includes('could not create live delegated team-lead tasks'),
  'Plan delegation failures should surface a specific live-delegation blocker',
);
assert.ok(
  plans.includes('audit preflight skipped; delegation continues') &&
  plans.includes('blocker preflight skipped; continuing to delegation'),
  'Audit/blocker preflight transport failures should stay local and continue to delegation',
);
assert.ok(
  !plans.includes("key: 'audit-preflight'") && !plans.includes("key: 'blocker-preflight'"),
  'Audit/blocker preflight transport failures should not create user Inbox recovery cards',
);
assert.ok(
  inbox.includes('async function resolvePlanQuestion('),
  'Inbox should resolve Work > Plans recovery decisions locally instead of routing them to the lead',
);
assert.ok(
  inbox.includes("call('plans:recover'") && main.includes("case 'plans:recover'"),
  'Plan decisions should invoke the main-process recovery pass, not only flip local status',
);
assert.ok(
  inbox.includes('q.agent && !isSyntheticQuestion && !isBrainApproval && answer'),
  'Synthetic plan/learn questions must not dispatch decision text back to agents',
);
assert.ok(
  shared.includes("return 'resume'") && shared.includes("return 'pause'"),
  'Plan Inbox option classification should make Approve/retry resume, while hold/pause/manual stays paused',
);
assert.ok(
  main.includes("bridgeCall('work:delegateToTeamLeads'") && main.includes("setBrainPlanStatus(file, 'PARTIAL')"),
  'Approving a plan recovery should retry live delegation and advance the plan when tasks are created',
);
assert.ok(
  main.includes('dedupeKey: `plan:${file}:recovery`'),
  'Plan recovery blockers should use a stable dedupe key instead of embedding transient error text',
);
assert.ok(
  plans.includes("key: 'team-lead-delegation'"),
  'Plan blocker decisions should dedupe live delegation failures by failed phase instead of raw transport/capacity error text',
);

console.log('plans Inbox recovery guard ok');
