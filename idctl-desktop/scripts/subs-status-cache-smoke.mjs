import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const subscriptions = await readFile(new URL('../src/main/subscriptions.ts', import.meta.url), 'utf8');
const onboarding = await readFile(new URL('../src/main/consumerOnboarding.ts', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
const readCallCache = await readFile(new URL('../src/shared/readCallCache.ts', import.meta.url), 'utf8');
const settings = await readFile(new URL('../src/renderer/views/Settings.tsx', import.meta.url), 'utf8');
const teams = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');

assert.ok(
  subscriptions.includes('maxAgeMs?: number') && subscriptions.includes('staleOk?: boolean'),
  'subscription status options should support non-default cache windows',
);
assert.ok(
  subscriptions.includes('export function cachedSubsStatus()'),
  'main process should expose a cached-only subscription snapshot for render-heavy views',
);
assert.ok(
  subscriptions.includes("install: 'npm install -g @anthropic-ai/claude-code'")
    && subscriptions.includes("install: 'npm install -g @openai/codex'"),
  'primary Claude and Codex subscription runtimes should expose reviewed installers',
);
for (const pathParts of [
  ["'.nvm', 'versions', 'node'"],
  ['VOLTA_HOME', "'.volta', 'bin'"],
  ["'.asdf', 'shims'"],
  ["'.mise', 'shims'"],
  ["'.local', 'share', 'pnpm'"],
]) {
  assert.ok(pathParts.every((part) => subscriptions.includes(part)), `packaged CLI discovery should include ${pathParts.join(' / ')}`);
}
assert.ok(
  subscriptions.includes("localeCompare(a.name, undefined, { numeric: true })"),
  'nvm discovery should prefer the newest Node install',
);
assert.ok(
  subscriptions.includes('now - subsStatusCache.at < maxAgeMs'),
  'subscription status cache should honor caller-provided maxAgeMs',
);
assert.ok(
  subscriptions.includes('latestSubsStatusRequestSequence === requestSequence')
    && subscriptions.includes('latestAssignmentSubsStatusRequestSequence === requestSequence')
    && subscriptions.includes('subsStatusGeneration === generation'),
  'both subscription cache lanes must publish only their newest request generation',
);
assert.ok(
  subscriptions.includes('if (subsStatusInflight === request) subsStatusInflight = null')
    && subscriptions.includes('if (assignmentSubsStatusInflight === request) assignmentSubsStatusInflight = null')
    && subscriptions.includes('subsStatusInflight = null;')
    && subscriptions.includes('assignmentSubsStatusInflight = null;'),
  'subscription invalidation and completion must not retain or clear the wrong overlapping request',
);
assert.ok(
  onboarding.includes('latestStatusRequestSequence === requestSequence')
    && onboarding.includes('if (options.force) cachedStatus = null'),
  'forced onboarding must supersede older cached/in-flight status publication',
);
assert.ok(
  readCallCache.includes("if (method === 'subs:status') return [];")
    && readCallCache.includes("(first as { force?: unknown }).force === true"),
  'both legacy and object-form forced subscription reads must supersede the canonical outer cache',
);
assert.ok(
  main.includes("case 'subs:cachedStatus':") && main.includes('cachedSubsStatus() ?? {}'),
  'IPC should expose cached-only subscription status without spawning CLI probes',
);
assert.ok(
  main.includes('typeof args[0] ===') && main.includes('SubsStatusOptions'),
  'IPC should pass object subscription status options through to the main checker',
);
assert.ok(
  settings.includes("{ force: !!options.force, maxAgeMs: options.force ? 0 : SUB_AUTO_REFRESH_MS }"),
  'Settings non-manual refresh should use the longer auto-refresh cache window',
);
assert.ok(
  settings.includes("'subs:status', true"),
  'install detection should still force provider status checks',
);
assert.ok(
  settings.includes('Provider CLIs are separate vendor tools and are not bundled with IDACC.'),
  'Settings should explain why a fresh IDACC install can show missing provider CLIs',
);
assert.ok(
  settings.includes('○ checking…'),
  'Settings should not report a sign-in state before the first provider probe',
);
assert.ok(
  settings.includes('const [pendingSignin, setPendingSignin]')
    && settings.includes('async function confirmSignin(provider: SubKey)')
    && settings.includes('I’ve finished — re-check'),
  'managed subscription sign-in should wait for explicit user completion before a forced status check',
);
assert.ok(
  !settings.includes('setTimeout(() => void refreshManagedSubscriptions({ force: true }), 4000)'),
  'managed subscription sign-in should not assume a fixed OAuth completion time',
);
assert.ok(
  teams.includes("'subs:assignmentStatus'") && teams.includes("'runtime:probe'") && teams.includes('Refresh runtimes'),
  'Teams Build should refresh assignable subscription readiness and model catalogs only after an explicit action',
);
assert.ok(
  subscriptions.includes("'grok', 'antigravity', 'copilot', 'kiro-cli'")
    && subscriptions.includes('subsStatusForRuntimes'),
  'assignment readiness should cover executable secondary subscription CLIs and support batch-scoped rechecks',
);
assert.ok(
  bridge.includes('subsStatusForRuntimes(rowsIn.map((row) => row.runtime))')
    && !bridge.includes("for (const rt of ['grok', 'antigravity'])"),
  'runtime verification must not promote Grok or Antigravity from a curated model catalog without live CLI readiness',
);
assert.ok(
  bridge.includes('client.runtimePreflight(runtime, model || undefined)')
    && bridge.includes('The bundled Agent manager cannot verify runtime assignments.'),
  'Team Builder must require manager-authoritative runtime/model preflight before spawn',
);
assert.ok(
  bridge.includes('spawnRuntime: preflight.runtime')
    && bridge.includes('spawnModel: preflight.model || undefined'),
  'onboarding must use the exact runtime/model pair resolved by manager preflight',
);
assert.ok(
  teams.includes('!runtimeCatalogChecking && Boolean(targetTeam)')
    && teams.includes('Wait for subscription and local runtime readiness checks to finish.'),
  'Team Builder must not dispatch while authoritative runtime readiness is still pending',
);

console.log('subscription status cache guard ok');
