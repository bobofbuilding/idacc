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
  || !applicationVersion
  || separator < 0
) {
  console.error(
    'usage: run-review-builder.mjs --platform mac|win|linux '
    + '--application-version X.Y.Z-review.N [--policy-only] -- <electron-builder arguments>',
  );
  process.exit(2);
}

const sourceVersion = JSON.parse(
  readFileSync(join(desktop, 'package.json'), 'utf8'),
).version;
if (
  !new RegExp(`^${sourceVersion.replaceAll('.', '\\.')}\\-review\\.[1-9][0-9]*$`)
    .test(applicationVersion)
) {
  fail('review application version must be <source-version>-review.<positive-run-number>');
}
if (
  process.env.IDACC_REVIEW_BUILD !== '1'
  || process.env.IDACC_REVIEW_VERSION !== applicationVersion
) {
  fail('review builder requires the exact review build identity in its environment');
}

const rawBuilderArgs = args.slice(separator + 1);
const requiredArgument = (value) => {
  if (!rawBuilderArgs.includes(value)) fail(`review builder is missing required argument ${value}`);
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
  fail(`review builder target must contain exactly one ${expectedPlatformFlag} platform flag`);
}
requiredArgument(`--config.extraMetadata.version=${applicationVersion}`);
const publishFlags = rawBuilderArgs
  .map((value, index) => ({ value, index }))
  .filter(({ value }) => value === '--publish' || value.startsWith('--publish='));
if (publishFlags.length !== 1) {
  fail('review builder must contain exactly one --publish policy');
}
const [{ value: publishFlag, index: publishIndex }] = publishFlags;
const publishPolicy = publishFlag === '--publish'
  ? rawBuilderArgs[publishIndex + 1]
  : publishFlag.slice('--publish='.length);
if (publishPolicy !== 'never') {
  fail('review builder must use --publish never');
}
if (platform === 'mac') {
  for (const value of [
    '--config.mac.identity=-',
    '--config.mac.notarize=false',
    '--config.mac.hardenedRuntime=false',
    '--config.mac.requirements=build/review-requirements.txt',
    '--config.dmg.sign=false',
  ]) requiredArgument(value);
}
if (platform === 'win') requiredArgument('--config.win.signExecutable=false');

process.chdir(desktop);
const parsed = configureBuildCommand(createYargs()).parse(rawBuilderArgs);
const normalized = normalizeOptions(parsed);
const config = normalized.config;
if (!config || typeof config === 'string') fail('review builder configuration is unavailable');
const normalizedPlatforms = normalized.targets instanceof Map
  ? [...normalized.targets.keys()].map((target) => target?.buildConfigurationKey)
  : [];
if (
  normalizedPlatforms.length !== 1
  || normalizedPlatforms[0] !== platform
) {
  fail(`review builder normalized target does not match ${platform}`);
}
if (normalized.publish !== 'never') {
  fail('review builder normalized publish policy did not remain fail-closed');
}
normalized.publish = 'never';
if (
  config.publish?.provider !== 'github'
  || config.publish?.owner !== 'bobofbuilding'
  || config.publish?.repo !== 'idacc'
  || config.publish?.releaseType !== 'release'
) {
  fail('review builder must retain only the compiled public IDACC publisher');
}
if (config.extraMetadata?.version !== applicationVersion) {
  fail('review builder package identity does not match the workflow identity');
}
if (platform === 'mac') {
  if (
    config.mac?.identity !== '-'
    || config.mac?.notarize !== 'false'
    || config.mac?.hardenedRuntime !== 'false'
    || config.mac?.requirements !== 'build/review-requirements.txt'
    || config.dmg?.sign !== 'false'
  ) {
    fail('review builder did not retain the stable ad-hoc review identity without notarization');
  }
  config.mac.notarize = false;
  config.mac.hardenedRuntime = false;
  config.dmg.sign = false;
}
if (platform === 'win') {
  if (config.win?.signExecutable !== 'false') {
    fail('review builder did not explicitly disable Windows executable signing');
  }
  config.win.signExecutable = false;
}

if (policyOnly) {
  process.stdout.write('review builder policy: ok\n');
} else {
  await build(normalized);
}
