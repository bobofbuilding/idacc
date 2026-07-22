import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  effectiveManagerLatestVersion,
  managerUpdaterInvocation,
  managerBootstrapScriptCandidates,
  managerUpdaterEnvironment,
  parseManagerUpdaterArguments,
  parseManagerUpdaterResult,
} from '../src/main/managerUpdater.ts';

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
assert.equal(parsed.sqlitePath, '/Users/example/.id-agents/id-agents.db');
assert.equal(parsed.serviceConfigured, true);

const customState = parseManagerUpdaterArguments([
  '/opt/homebrew/bin/node',
  '/Users/example/Projects/idacc-stack/id-agents/scripts/manager-auto-update.mjs',
], '/Users/example', { SQLITE_PATH: '/Volumes/AgentData/id-agents.db' });
assert.equal(customState.sqlitePath, '/Volumes/AgentData/id-agents.db');
assert.deepEqual(
  managerUpdaterInvocation({ ...customState, nodePath: '/usr/bin/env' }, true),
  {
    command: '/usr/bin/env',
    args: [
      'node',
      '/Users/example/Projects/idacc-stack/id-agents/scripts/manager-auto-update.mjs',
      '--target', '/Users/example/Projects/idacc-stack/id-agents',
      '--manager-url', 'http://127.0.0.1:4100',
      '--source', 'https://github.com/bobofbuilding/id-agents.git',
      '--branch', 'main',
      '--state', '/Users/example/.id-agents/manager-update.json',
      '--lock', '/Users/example/.id-agents/manager-update.lock',
      '--dry-run',
    ],
  },
);

assert.deepEqual(
  parseManagerUpdaterResult('fetching\nbuilding\n{"status":"deferred","version":"0.1.121","activeQueries":2}\n'),
  { status: 'deferred', version: '0.1.121', activeQueries: 2 },
);
assert.equal(parseManagerUpdaterResult('Manager update already running; skipping this cycle.\n'), null);
assert.equal(effectiveManagerLatestVersion('0.1.122', '0.1.121'), '0.1.122');
assert.equal(effectiveManagerLatestVersion('0.1.122', '0.1.123'), '0.1.123');
assert.equal(effectiveManagerLatestVersion('0.1.123', undefined), '0.1.123');
assert.throws(() => parseManagerUpdaterArguments(['node'], '/Users/example'), /invalid ProgramArguments/);
const packagedEnvironment = managerUpdaterEnvironment('/Users/example', {
  HOME: '/Users/example',
  PATH: '/usr/bin:/bin',
});
assert.equal(packagedEnvironment.HOME, '/Users/example');
assert.equal(packagedEnvironment.npm_config_update_notifier, 'false');
assert.deepEqual(packagedEnvironment.PATH?.split(':').slice(0, 4), [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/Users/example/.local/bin',
  '/Users/example/.npm-global/bin',
]);
assert.match(packagedEnvironment.PATH || '', /\/usr\/bin:\/bin$/);
assert.deepEqual(
  managerBootstrapScriptCandidates('/Applications/IDACC.app/Contents/Resources', '/repo/idctl-desktop'),
  [
    '/Applications/IDACC.app/Contents/Resources/scripts/install-idacc-stack.mjs',
    '/repo/idctl-desktop/scripts/install-idacc-stack.mjs',
    '/repo/scripts/install-idacc-stack.mjs',
  ],
);

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/renderer/views/Settings.tsx', import.meta.url), 'utf8');
const syncDomainsSource = readFileSync(new URL('../src/shared/syncDomains.ts', import.meta.url), 'utf8');
for (const method of ['managerUpdate:status', 'managerUpdate:check', 'managerUpdate:apply', 'managerUpdate:bootstrap']) {
  assert.match(mainSource, new RegExp(method));
  assert.match(settingsSource, new RegExp(method));
}
assert.match(settingsSource, /Update & sync manager/);
assert.match(settingsSource, /Install current manager/);
assert.match(settingsSource, /Missing after restart:/);
assert.match(syncDomainsSource, /managerUpdate:\(apply\|bootstrap\)/);

console.log('manager updater smoke: ok');
