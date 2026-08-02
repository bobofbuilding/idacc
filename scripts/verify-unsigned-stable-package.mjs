#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const asar = requireFromDesktop('@electron/asar');
const args = process.argv.slice(2);

function fail(message) {
  console.error(`unsigned stable package verification failed: ${message}`);
  process.exit(1);
}

function option(name) {
  const positions = args.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1) fail(`${name} must be supplied exactly once`);
  const value = String(args[positions[0] + 1] || '').trim();
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

for (let index = 0; index < args.length; index += 2) {
  if (!['--unpacked', '--version', '--platform', '--arch'].includes(args[index])) {
    fail(`unknown argument ${args[index] || '(missing)'}`);
  }
}

const unpacked = resolve(option('--unpacked'));
const version = option('--version');
const platform = option('--platform');
const arch = option('--arch');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version must be plain semver');
if (!['darwin', 'win32', 'linux'].includes(platform)) fail('platform is invalid');
if (!['arm64', 'x64'].includes(arch)) fail('architecture is invalid');

const resources = platform === 'darwin'
  ? join(unpacked, 'Contents', 'Resources')
  : join(unpacked, 'resources');
const archive = join(resources, 'app.asar');
if (!existsSync(archive)) fail('packaged app.asar is missing');

function archiveJson(path, label) {
  try {
    return JSON.parse(asar.extractFile(archive, path).toString('utf8'));
  } catch (error) {
    fail(`${label} is unavailable or invalid: ${error.message}`);
  }
}

const packaged = archiveJson('package.json', 'packaged package identity');
const buildMode = archiveJson('out/build-mode.json', 'packaged build provenance');
if (packaged.version !== version) fail(`packaged version is ${packaged.version || 'missing'}`);
if (buildMode.mode !== 'production') fail('package is not a production-mode build');
if (buildMode.reviewOnly !== false) fail('package is incorrectly marked review-only');
if (buildMode.updaterEnabled !== true) fail('stable updater is not compiled into the package');
if (buildMode.updaterChannel !== 'production') fail('package does not use the stable updater channel');
if (buildMode.sourceVersion !== version || buildMode.applicationVersion !== version) {
  fail('source, application, and release versions do not agree');
}
if (buildMode.mainProcessStartupPolicy?.mode !== 'production') {
  fail('main process does not use the production startup policy');
}
if (!/^[0-9a-f]{64}$/.test(String(buildMode.runtimeManifestSha256 || ''))) {
  fail('packaged Manager/Brain runtime manifest is not bound by digest');
}
if (platform === 'win32') {
  if (
    buildMode.windowsJobHost?.available !== true
    || buildMode.windowsJobHost?.verificationMode !== 'sha256'
    || buildMode.windowsJobHost?.expectedPublisher
    || !/^[0-9a-f]{64}$/.test(String(buildMode.windowsJobHost?.executableSha256 || ''))
  ) {
    fail('unsigned Windows helper does not use exact SHA-256 verification');
  }
}

const updateConfig = join(resources, 'app-update.yml');
if (!existsSync(updateConfig)) fail('packaged updater configuration is missing');
const updateText = readFileSync(updateConfig, 'utf8');
if (
  !/^provider: github$/m.test(updateText)
  || !/^owner: bobofbuilding$/m.test(updateText)
  || !/^repo: idacc$/m.test(updateText)
  || /^channel: review$/m.test(updateText)
) {
  fail('packaged updater is not bound to the stable public GitHub feed');
}

console.log(`Unsigned stable package verified for ${version} on ${platform}-${arch}.`);
