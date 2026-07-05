import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const plans = await readFile(new URL('../src/renderer/views/Plans.tsx', import.meta.url), 'utf8');
const inbox = await readFile(new URL('../src/renderer/views/Inbox.tsx', import.meta.url), 'utf8');

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
  plans.includes('Work > Plans saved objective') && plans.includes('could not create live delegated team-lead tasks'),
  'Plan delegation failures should surface a specific live-delegation blocker',
);
assert.ok(
  inbox.includes('async function resolvePlanQuestion('),
  'Inbox should resolve Work > Plans recovery decisions locally instead of routing them to the lead',
);
assert.ok(
  inbox.includes('q.agent && !isSyntheticQuestion && !isBrainApproval && answer'),
  'Synthetic plan/learn questions must not dispatch decision text back to agents',
);
assert.ok(
  inbox.includes("const status = /retry/i.test(option) ? 'PENDING' : 'PAUSED'"),
  'Retrying a plan decision should unpause the plan locally without creating another lead query',
);

console.log('plans Inbox recovery guard ok');
