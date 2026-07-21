#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeManagerConfig,
  parseArgs,
  persistManagerConfig,
  renderLaunchAgent,
} from './install-idacc-stack.mjs';

const parsed = parseArgs(['--project-dir', '~/Stack', '--manager-port', '4200', '--no-open'], { HOME: '/Users/test' });
assert.equal(parsed.projectDir, '/Users/test/Stack');
assert.equal(parsed.managerDir, '/Users/test/Stack/id-agents');
assert.equal(parsed.managerUrl, 'http://127.0.0.1:4200');
assert.equal(parsed.open, false);

const managerOnly = parseArgs(['--project-dir', '~/Stack', '--manager-only', '--no-open'], { HOME: '/Users/test' });
assert.equal(managerOnly.managerOnly, true);
assert.equal(managerOnly.managerDir, '/Users/test/Stack/id-agents');

const original = {
  version: 1,
  managers: [{ name: 'remote', url: 'https://manager.example' }, { name: 'local', url: 'http://old', apiKey: 'preserve-me' }],
  providers: [{ name: 'ollama', enabled: true }],
  customFutureField: { keep: true },
};
const merged = mergeManagerConfig(original, 'http://127.0.0.1:4100');
assert.equal(merged.defaultManager, 'local');
assert.equal(merged.managers.length, 2);
assert.deepEqual(merged.providers, original.providers);
assert.deepEqual(merged.customFutureField, original.customFutureField);
assert.equal(merged.managers.find((manager) => manager.name === 'local').apiKey, 'preserve-me');
assert.equal(merged.managers.find((manager) => manager.name === 'local').url, 'http://127.0.0.1:4100');

const root = mkdtempSync(join(tmpdir(), 'idacc-stack-smoke-'));
const config = join(root, '.config', 'idctl', 'config.json');
mkdirSync(join(root, '.config', 'idctl'), { recursive: true });
writeFileSync(config, `${JSON.stringify(original)}\n`);
persistManagerConfig(config, 'http://127.0.0.1:4300');
const saved = JSON.parse(readFileSync(config, 'utf8'));
assert.equal(saved.managers.find((manager) => manager.name === 'local').url, 'http://127.0.0.1:4300');
assert.equal(saved.managers.find((manager) => manager.name === 'local').apiKey, 'preserve-me');

writeFileSync(config, '{broken');
assert.throws(
  () => persistManagerConfig(config, 'http://127.0.0.1:4100'),
  /Refusing to overwrite unparseable IDACC config/,
);

const plist = renderLaunchAgent({
  managerDir: '/Users/test/ID & Agents',
  managerPort: 4100,
  logDir: '/Users/test/Logs',
  home: '/Users/test',
  path: '/usr/bin:/bin',
  nodePath: '/usr/local/bin/node',
});
assert.match(plist, /io\.bittrees\.idagents-manager/);
assert.match(plist, /ID &amp; Agents/);
assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
assert.match(plist, /<key>AGENT_MANAGER_PORT<\/key><string>4100<\/string>/);

console.log('install-idacc-stack smoke passed');
