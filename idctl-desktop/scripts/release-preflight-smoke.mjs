#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(desktop, 'scripts', 'release-preflight.mjs');
const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const secretNames = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
];
const cleanEnv = { ...process.env };
for (const name of secretNames) delete cleanEnv[name];

function run(args, env = cleanEnv) {
  return spawnSync(process.execPath, [script, '--platform', platform, ...args], {
    cwd: desktop,
    env,
    encoding: 'utf8',
  });
}

assert.equal(run([]).status, 0, 'native unsigned preflight should remain available for CI evidence builds');

if (platform === 'mac') {
  const missing = run(['--require-signing']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CSC_LINK is required/);
  assert.match(missing.stderr, /notarization credentials are required/);

  const signedEnv = {
    ...cleanEnv,
    CSC_LINK: 'base64-placeholder',
    CSC_KEY_PASSWORD: 'placeholder',
    APPLE_ID: 'release@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'placeholder',
    APPLE_TEAM_ID: 'TEAMID',
  };
  assert.equal(run(['--require-signing'], signedEnv).status, 0);
  const disabled = run(['--require-signing'], { ...signedEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.notEqual(disabled.status, 0);
  assert.match(disabled.stderr, /cannot disable certificate discovery/);
} else if (platform === 'win') {
  const missing = run(['--require-signing']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /WIN_CSC_LINK or CSC_LINK is required/);
  assert.equal(run(['--require-signing'], {
    ...cleanEnv,
    WIN_CSC_LINK: 'base64-placeholder',
    WIN_CSC_KEY_PASSWORD: 'placeholder',
  }).status, 0);
} else {
  assert.equal(run([]).status, 0);
}

console.log(`release preflight smoke: ok (${platform})`);
