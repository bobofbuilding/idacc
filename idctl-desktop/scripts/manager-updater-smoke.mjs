import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseManagerUpdaterArguments, parseManagerUpdaterResult } from '../src/main/managerUpdater.ts';

const parsed = parseManagerUpdaterArguments([
  '/opt/homebrew/bin/node',
  '/Users/example/Projects/idacc-stack/id-agents/scripts/manager-auto-update.mjs',
  '--target', '/Users/example/Projects/idacc-stack/id-agents',
  '--manager-url', 'http://127.0.0.1:4100/',
  '--source', 'https://github.com/bobofbuilding/id-agents.git',
  '--branch', 'main',
  '--state', '/Users/example/.id-agents/manager-update.json',
  '--lock', '/Users/example/.id-agents/manager-update.lock',
], '/Users/example');

assert.equal(parsed.target, '/Users/example/Projects/idacc-stack/id-agents');
assert.equal(parsed.managerUrl, 'http://127.0.0.1:4100');
assert.equal(parsed.source, 'https://github.com/bobofbuilding/id-agents.git');
assert.equal(parsed.branch, 'main');

assert.deepEqual(
  parseManagerUpdaterResult('fetching\nbuilding\n{"status":"deferred","version":"0.1.121","activeQueries":2}\n'),
  { status: 'deferred', version: '0.1.121', activeQueries: 2 },
);
assert.equal(parseManagerUpdaterResult('Manager update already running; skipping this cycle.\n'), null);
assert.throws(() => parseManagerUpdaterArguments(['node'], '/Users/example'), /invalid ProgramArguments/);

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/renderer/views/Settings.tsx', import.meta.url), 'utf8');
const syncDomainsSource = readFileSync(new URL('../src/shared/syncDomains.ts', import.meta.url), 'utf8');
for (const method of ['managerUpdate:status', 'managerUpdate:check', 'managerUpdate:apply']) {
  assert.match(mainSource, new RegExp(method));
  assert.match(settingsSource, new RegExp(method));
}
assert.match(settingsSource, /Update & sync manager/);
assert.match(syncDomainsSource, /managerUpdate:apply/);

console.log('manager updater smoke: ok');
