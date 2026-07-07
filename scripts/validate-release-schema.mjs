#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const mode = args.find((arg) => arg.startsWith('--')) || '--files';
const explicitVersion = args.find((arg) => !arg.startsWith('--')) || '';
const errors = [];

function readJson(relativePath) {
  const file = join(root, relativePath);
  if (!existsSync(file)) {
    errors.push(`${relativePath} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`${relativePath} is not valid JSON: ${err.message}`);
    return null;
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}

function packageVersion(relativePath, expected) {
  const json = readJson(relativePath);
  if (!json) return;
  expect(
    json.version === expected,
    `${relativePath} version ${json.version || '(missing)'} does not match ${expected}`,
  );
}

function lockVersion(relativePath, expected) {
  const json = readJson(relativePath);
  if (!json) return;
  expect(
    json.version === expected,
    `${relativePath} top-level version ${json.version || '(missing)'} does not match ${expected}`,
  );
  const rootPackageVersion = json.packages?.['']?.version;
  expect(
    rootPackageVersion === expected,
    `${relativePath} packages[""].version ${rootPackageVersion || '(missing)'} does not match ${expected}`,
  );
}

const desktop = readJson('idctl-desktop/package.json');
const version = explicitVersion || desktop?.version || '';

expect(Boolean(version), 'idctl-desktop/package.json must define the canonical version');
expect(/^\d+\.\d+\.\d+$/.test(version), `canonical version must be plain semver X.Y.Z; got ${version || '(missing)'}`);
expect(!explicitVersion || explicitVersion === desktop?.version, `requested version ${explicitVersion} does not match idctl-desktop/package.json ${desktop?.version || '(missing)'}`);

packageVersion('idctl-desktop/package.json', version);
lockVersion('idctl-desktop/package-lock.json', version);
packageVersion('idctl/package.json', version);
lockVersion('idctl/package-lock.json', version);

const changelogPath = join(root, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  errors.push('CHANGELOG.md is missing');
} else {
  const changelog = readFileSync(changelogPath, 'utf8');
  expect(
    new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\](?:\\s|$)`, 'm').test(changelog),
    `CHANGELOG.md is missing a ## [${version}] entry`,
  );
}

if (mode === '--postcommit' || mode === '--publish') {
  const subject = runGit(['log', '-1', '--pretty=%s']);
  expect(subject.startsWith(`v${version}:`), `HEAD commit subject must start with v${version}:; got ${subject || '(missing)'}`);
}

if (mode === '--publish') {
  const tag = `v${version}`;
  const tagsAtHead = runGit(['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean);
  expect(tagsAtHead.includes(tag), `${tag} must point at HEAD before publishing`);
}

if (errors.length) {
  console.error('release schema validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`✓ release schema valid for v${version} (${mode.replace(/^--/, '')})`);
