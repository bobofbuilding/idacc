#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const { load } = requireFromDesktop('js-yaml');
const args = process.argv.slice(2);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/;

function fail(message) {
  console.error(`update descriptor verification failed: ${message}`);
  process.exit(1);
}

function option(name) {
  const positions = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (positions.length !== 1) fail(`${name} must be provided exactly once`);
  const value = args[positions[0] + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

for (let index = 0; index < args.length; index += 2) {
  if (!['--directory', '--version', '--channel'].includes(args[index]) || !args[index + 1]) {
    fail('usage: scripts/verify-update-descriptors.mjs --directory <release-assets> --version X.Y.Z [--channel review]');
  }
}

const directory = resolve(option('--directory'));
const version = option('--version');
const channelPositions = args.flatMap((arg, index) => arg === '--channel' ? [index] : []);
if (channelPositions.length > 1) fail('--channel may be provided at most once');
const channel = channelPositions.length ? String(args[channelPositions[0] + 1] || '') : 'latest';
if (!['latest', 'review'].includes(channel)) fail('--channel must be latest or review');
const versionPattern = /^\d+\.\d+\.\d+$/;
if (!versionPattern.test(version)) fail('--version does not match the selected update channel');

function safeName(value, label) {
  const name = String(value || '');
  if (basename(name) !== name || !SAFE_NAME.test(name)) fail(`${label} is not a safe asset basename`);
  return name;
}

function sameNames(expected, actual, label) {
  const left = [...expected].sort((a, b) => a.localeCompare(b));
  const right = [...actual].sort((a, b) => a.localeCompare(b));
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) {
    const missing = left.filter((name) => !right.includes(name));
    const extra = right.filter((name) => !left.includes(name));
    fail(`${label} differs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

function canonicalSha512(value, label) {
  const digest = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) fail(`${label} has an invalid SHA-512`);
  const bytes = Buffer.from(digest, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== digest) {
    fail(`${label} must contain a canonical 64-byte SHA-512`);
  }
  return digest;
}

function readChecksums() {
  const text = readFileSync(join(directory, 'SHA256SUMS'), 'utf8');
  if (!text.endsWith('\n')) fail('SHA256SUMS must end with a newline');
  const result = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) fail('SHA256SUMS contains an invalid line');
    const name = safeName(match[2], 'SHA256SUMS entry');
    if (name === 'SHA256SUMS' || result.has(name)) fail(`SHA256SUMS contains invalid duplicate entry ${name}`);
    result.set(name, match[1]);
  }
  return result;
}

async function fingerprint(name) {
  const path = join(directory, name);
  const info = lstatSync(path);
  if (!info.isFile()) fail(`${name} must be a regular file`);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (size !== statSync(path).size) fail(`${name} changed while it was being verified`);
  return {
    size,
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64'),
  };
}

const expectedInstallers = [
  `ID-Agents-Control-Center-${version}-arm64.dmg`,
  `ID-Agents-Control-Center-${version}-x64.dmg`,
  `ID-Agents-Control-Center-${version}-arm64.zip`,
  `ID-Agents-Control-Center-${version}-x64.zip`,
  `ID-Agents-Control-Center-${version}-x64.exe`,
  `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
  `ID-Agents-Control-Center-${version}-amd64.deb`,
];
const installerSuffixes = ['.dmg', '.zip', '.exe', '.AppImage', '.deb'];
const actualFiles = readdirSync(directory, { withFileTypes: true });
if (actualFiles.some((entry) => !entry.isFile())) fail('release asset directory must contain regular files only');
const actualNames = actualFiles.map((entry) => safeName(entry.name, 'release asset'));
sameNames(
  expectedInstallers,
  actualNames.filter((name) => installerSuffixes.some((suffix) => name.endsWith(suffix))),
  'exact versioned consumer installer matrix',
);

const checksums = readChecksums();
sameNames(
  actualNames.filter((name) => name !== 'SHA256SUMS'),
  checksums.keys(),
  'release asset set versus SHA256SUMS',
);

const fingerprints = new Map();
for (const name of expectedInstallers) {
  const result = await fingerprint(name);
  fingerprints.set(name, result);
  if (checksums.get(name) !== result.sha256) fail(`${name} does not match SHA256SUMS`);
}

const expectations = new Map([
  [`${channel}-mac.yml`, {
    files: [
      `ID-Agents-Control-Center-${version}-arm64.zip`,
      `ID-Agents-Control-Center-${version}-x64.zip`,
    ],
    primary: `ID-Agents-Control-Center-${version}-x64.zip`,
  }],
  [`${channel}.yml`, {
    files: [`ID-Agents-Control-Center-${version}-x64.exe`],
    primary: `ID-Agents-Control-Center-${version}-x64.exe`,
  }],
  [`${channel}-linux.yml`, {
    files: [
      `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
      `ID-Agents-Control-Center-${version}-amd64.deb`,
    ],
    primary: `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
  }],
]);

for (const [descriptorName, expected] of expectations) {
  const bytes = readFileSync(join(directory, descriptorName));
  if (checksums.get(descriptorName) !== createHash('sha256').update(bytes).digest('hex')) {
    fail(`${descriptorName} does not match SHA256SUMS`);
  }
  let descriptor;
  try {
    descriptor = load(bytes.toString('utf8'));
  } catch (error) {
    fail(`${descriptorName} is invalid YAML: ${error.message}`);
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fail(`${descriptorName} must be a YAML object`);
  }
  if (String(descriptor.version || '') !== version) {
    fail(`${descriptorName} version is ${descriptor.version || 'missing'}, expected ${version}`);
  }
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) {
    fail(`${descriptorName} files must be a non-empty array`);
  }
  const seen = new Map();
  for (const record of descriptor.files) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail(`${descriptorName} contains an invalid file record`);
    }
    const name = safeName(record.url, `${descriptorName} file`);
    if (seen.has(name)) fail(`${descriptorName} contains duplicate file ${name}`);
    const payload = fingerprints.get(name);
    if (!payload) fail(`${descriptorName} references non-installer ${name}`);
    if (Number(record.size) !== payload.size) fail(`${descriptorName} size does not match ${name}`);
    if (name.endsWith('.AppImage')) {
      const blockMapSize = Number(record.blockMapSize);
      if (
        !Number.isSafeInteger(blockMapSize)
        || blockMapSize <= 0
        || blockMapSize >= payload.size - 4
      ) {
        fail(`${descriptorName} ${name} has an invalid embedded blockMapSize`);
      }
    } else if (record.blockMapSize != null) {
      fail(`${descriptorName} ${name} must not claim an embedded block map`);
    }
    const sha512 = canonicalSha512(record.sha512, `${descriptorName} ${name}`);
    if (sha512 !== payload.sha512) fail(`${descriptorName} SHA-512 does not match ${name}`);
    seen.set(name, sha512);
  }
  sameNames(expected.files, seen.keys(), `${descriptorName} exact updater file set`);
  const primary = safeName(descriptor.path, `${descriptorName} path`);
  if (primary !== expected.primary) {
    fail(`${descriptorName} primary path is ${primary}, expected ${expected.primary}`);
  }
  if (canonicalSha512(descriptor.sha512, `${descriptorName} primary`) !== seen.get(primary)) {
    fail(`${descriptorName} primary SHA-512 does not select ${primary}`);
  }
}

console.log(
  `Update descriptors verified for ${version}: exact installer matrix and macOS, Windows, Linux payload bytes match.`,
);
