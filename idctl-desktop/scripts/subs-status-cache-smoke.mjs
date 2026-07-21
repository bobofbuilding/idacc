import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const subscriptions = await readFile(new URL('../src/main/subscriptions.ts', import.meta.url), 'utf8');
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
for (const path of ['.nvm/versions/node', '.volta/bin', '.asdf/shims', '.mise/shims', '.local/share/pnpm']) {
  assert.ok(subscriptions.includes(path), `packaged CLI discovery should include ${path}`);
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
  teams.includes("'subs:cachedStatus'") && !teams.includes("'subs:status').catch(() => ({}))"),
  'Teams Build catalog should use cached subscription status and avoid CLI probes on tab entry',
);

console.log('subscription status cache guard ok');
