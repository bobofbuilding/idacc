#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  productionBuilderArgs,
  signingIdentityErrors,
} from './release-signing-policy.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(desktop, 'scripts', 'release-preflight.mjs');
const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const secretNames = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'MACOS_EXPECTED_SIGNING_IDENTITY',
  'MACOS_EXPECTED_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_EXPECTED_PUBLISHER_SUBJECT',
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

const macTeam = 'IDACC12345';
const macIdentity = `IDACC Contributors (${macTeam})`;
const validMacIdentityEnv = {
  ...cleanEnv,
  MACOS_EXPECTED_TEAM_ID: macTeam,
  MACOS_EXPECTED_SIGNING_IDENTITY: macIdentity,
  CSC_NAME: macIdentity,
  APPLE_TEAM_ID: macTeam,
};
const windowsSubject = 'CN=IDACC Contributors, O=IDACC Contributors, C=US';
const validWindowsIdentityEnv = {
  ...cleanEnv,
  WINDOWS_EXPECTED_PUBLISHER_SUBJECT: windowsSubject,
};
assert.deepEqual(signingIdentityErrors('mac', validMacIdentityEnv), []);
assert.deepEqual(signingIdentityErrors('win', validWindowsIdentityEnv), []);
assert.match(
  signingIdentityErrors('mac', {
    ...validMacIdentityEnv,
    MACOS_EXPECTED_TEAM_ID: 'WRONG12345',
  }).join(' '),
  /production Team ID|configured production Team ID|exactly equal/,
);
assert.match(
  signingIdentityErrors('win', {
    ...validWindowsIdentityEnv,
    WINDOWS_EXPECTED_PUBLISHER_SUBJECT: 'IDACC Contributors',
  }).join(' '),
  /exact full production certificate subject DN/,
);
assert.deepEqual(
  productionBuilderArgs('mac', ['--mac', 'dmg', 'zip'], validMacIdentityEnv).slice(-2),
  [
    '--config.forceCodeSigning=true',
    `--config.mac.identity=${macIdentity}`,
  ],
);
assert.deepEqual(
  productionBuilderArgs('win', ['--win', 'nsis'], validWindowsIdentityEnv).slice(-2),
  [
    '--config.forceCodeSigning=true',
    `--config.win.signtoolOptions.publisherName=${windowsSubject}`,
  ],
);
assert.throws(
  () => productionBuilderArgs('win', ['--win', 'nsis'], cleanEnv),
  /WINDOWS_EXPECTED_PUBLISHER_SUBJECT/,
);

assert.equal(run([]).status, 0, 'native unsigned preflight should remain available for CI evidence builds');

if (platform === 'mac') {
  const missing = run(['--require-signing']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CSC_LINK is required/);
  assert.match(missing.stderr, /notarization credentials are required/);

  const signedEnv = {
    ...validMacIdentityEnv,
    CSC_LINK: 'base64-placeholder',
    CSC_KEY_PASSWORD: 'placeholder',
    APPLE_ID: 'release@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'placeholder',
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
    ...validWindowsIdentityEnv,
    WIN_CSC_LINK: 'base64-placeholder',
    WIN_CSC_KEY_PASSWORD: 'placeholder',
  }).status, 0);
} else {
  assert.equal(run([]).status, 0);
}

const publisherFixture = mkdtempSync(join(tmpdir(), 'idacc-publisher-policy-'));
try {
  const publisherConfig = join(publisherFixture, 'app-update.yml');
  writeFileSync(
    publisherConfig,
    `provider: github\npublisherName:\n  - '${windowsSubject}'\n`,
  );
  const publisherVerifier = join(desktop, 'scripts', 'verify-packaged-publisher.mjs');
  const acceptedPublisher = spawnSync(process.execPath, [publisherVerifier, publisherConfig], {
    cwd: desktop,
    env: validWindowsIdentityEnv,
    encoding: 'utf8',
  });
  assert.equal(acceptedPublisher.status, 0, acceptedPublisher.stderr);
  writeFileSync(publisherConfig, "provider: github\npublisherName: 'CN=Wrong, O=Wrong'\n");
  const rejectedPublisher = spawnSync(process.execPath, [publisherVerifier, publisherConfig], {
    cwd: desktop,
    env: validWindowsIdentityEnv,
    encoding: 'utf8',
  });
  assert.notEqual(rejectedPublisher.status, 0);
  assert.match(rejectedPublisher.stderr, /does not contain exactly the expected full publisher subject DN/);
} finally {
  rmSync(publisherFixture, { recursive: true, force: true });
}

console.log(`release preflight smoke: ok (${platform})`);
