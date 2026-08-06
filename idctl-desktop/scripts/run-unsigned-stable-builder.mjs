#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(desktop, 'package.json'));
const {
  build,
  configureBuildCommand,
  createYargs,
  normalizeOptions,
} = requireFromDesktop('electron-builder/out/builder.js');

function fail(message) {
  throw new Error(message);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
}

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const platform = option(args, '--platform');
const applicationVersion = option(args, '--application-version');
const policyOnly = args.includes('--policy-only');
if (
  !['mac', 'win', 'linux'].includes(platform)
  || !/^\d+\.\d+\.\d+$/.test(applicationVersion)
  || separator < 0
) {
  console.error(
    'usage: run-unsigned-stable-builder.mjs --platform mac|win|linux '
    + '--application-version X.Y.Z [--policy-only] -- <electron-builder arguments>',
  );
  process.exit(2);
}

const sourceVersion = JSON.parse(
  readFileSync(join(desktop, 'package.json'), 'utf8'),
).version;
if (applicationVersion !== sourceVersion) {
  fail('unsigned stable application version must exactly match the source version');
}
if (
  process.env.IDACC_UNSIGNED_STABLE_BUILD !== '1'
  || process.env.IDACC_UNSIGNED_STABLE_VERSION !== applicationVersion
) {
  fail('unsigned stable builder requires the exact stable build identity in its environment');
}
for (const signingVariable of [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_EXPECTED_PUBLISHER_SUBJECT',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]) {
  if (String(process.env[signingVariable] || '').trim()) {
    fail(`unsigned stable builder refuses signing input ${signingVariable}`);
  }
  // Electron Builder resolves an explicitly empty CSC_LINK as the current
  // directory on macOS and then attempts to import it as a certificate.
  // Absence, together with the policy below, is the fail-closed state.
  delete process.env[signingVariable];
}

const rawBuilderArgs = args.slice(separator + 1);
const requiredArgument = (value) => {
  if (!rawBuilderArgs.includes(value)) {
    fail(`unsigned stable builder is missing required argument ${value}`);
  }
};
const platformFlags = rawBuilderArgs.filter((value) => (
  value === '--mac'
  || value.startsWith('--mac=')
  || value === '--win'
  || value.startsWith('--win=')
  || value === '--linux'
  || value.startsWith('--linux=')
));
const expectedPlatformFlag = `--${platform}`;
if (
  platformFlags.length !== 1
  || !(
    platformFlags[0] === expectedPlatformFlag
    || platformFlags[0].startsWith(`${expectedPlatformFlag}=`)
  )
) {
  fail(`unsigned stable builder target must contain exactly one ${expectedPlatformFlag} platform flag`);
}
requiredArgument(`--config.extraMetadata.version=${applicationVersion}`);
requiredArgument('--config.publish.channel=latest');
const publishFlags = rawBuilderArgs
  .map((value, index) => ({ value, index }))
  .filter(({ value }) => value === '--publish' || value.startsWith('--publish='));
if (publishFlags.length !== 1) {
  fail('unsigned stable builder must contain exactly one --publish policy');
}
const [{ value: publishFlag, index: publishIndex }] = publishFlags;
const publishPolicy = publishFlag === '--publish'
  ? rawBuilderArgs[publishIndex + 1]
  : publishFlag.slice('--publish='.length);
if (publishPolicy !== 'never') {
  fail('unsigned stable builder must use --publish never');
}
if (platform === 'mac') {
  for (const value of [
    '--config.mac.identity=-',
    '--config.mac.notarize=false',
    '--config.mac.hardenedRuntime=false',
    '--config.mac.requirements=build/review-requirements.txt',
    '--config.mac.signIgnore=/Contents/Resources/idacc-runtime/',
    '--config.afterSign=scripts/unsigned-stable-after-sign.mjs',
    '--config.dmg.sign=false',
  ]) requiredArgument(value);
}
if (platform === 'win') requiredArgument('--config.win.signExecutable=false');

process.chdir(desktop);
const parsed = configureBuildCommand(createYargs()).parse(rawBuilderArgs);
const normalized = normalizeOptions(parsed);
const config = normalized.config;
if (!config || typeof config === 'string') {
  fail('unsigned stable builder configuration is unavailable');
}
const normalizedPlatforms = normalized.targets instanceof Map
  ? [...normalized.targets.keys()].map((target) => target?.buildConfigurationKey)
  : [];
if (
  normalizedPlatforms.length !== 1
  || normalizedPlatforms[0] !== platform
) {
  fail(`unsigned stable builder normalized target does not match ${platform}`);
}
if (normalized.publish !== 'never') {
  fail('unsigned stable builder normalized publish policy did not remain fail-closed');
}
normalized.publish = 'never';
if (
  config.publish?.provider !== 'github'
  || config.publish?.owner !== 'bobofbuilding'
  || config.publish?.repo !== 'idacc'
  || config.publish?.releaseType !== 'release'
  || config.publish?.channel !== 'latest'
) {
  fail('unsigned stable builder must retain only the compiled public IDACC publisher');
}
if (config.extraMetadata?.version !== applicationVersion) {
  fail('unsigned stable builder package identity does not match the workflow identity');
}
if (platform === 'mac') {
  if (
    config.mac?.identity !== '-'
    || config.mac?.notarize !== 'false'
    || config.mac?.hardenedRuntime !== 'false'
    || config.mac?.requirements !== 'build/review-requirements.txt'
    || config.mac?.signIgnore !== '/Contents/Resources/idacc-runtime/'
    || config.afterSign !== 'scripts/unsigned-stable-after-sign.mjs'
    || config.dmg?.sign !== 'false'
  ) {
    fail('unsigned stable builder did not retain the ad-hoc macOS policy');
  }
  config.mac.notarize = false;
  config.mac.hardenedRuntime = false;
  config.mac.signIgnore = '/Contents/Resources/idacc-runtime/';
  config.dmg.sign = false;
}
if (platform === 'win') {
  if (config.win?.signExecutable !== 'false') {
    fail('unsigned stable builder did not explicitly disable Windows executable signing');
  }
  config.win.signExecutable = false;
}

if (policyOnly) {
  process.stdout.write('unsigned stable builder policy: ok\n');
} else {
  await build(normalized);
}
