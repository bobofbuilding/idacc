#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/;
const REQUIRED_FILES = [
  'SHA256SUMS',
  'release-index.json',
  'release-index.sha256',
  'latest-mac.yml',
  'latest.yml',
  'latest-linux.yml',
  'IDACC-provenance-darwin-arm64.tar.gz',
  'IDACC-provenance-darwin-x64.tar.gz',
  'IDACC-provenance-win32-x64.tar.gz',
  'IDACC-provenance-linux-x64.tar.gz',
];
const REQUIRED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
];
const REQUIRED_INSTALLER_SUFFIXES = [
  '.dmg',
  '.zip',
  '.exe',
  '.AppImage',
  '.deb',
];

function fail(message) {
  console.error(`release promotion verification failed: ${message}`);
  process.exit(1);
}

function option(name) {
  const matches = args.reduce((indices, value, index) => (
    value === name ? [...indices, index] : indices
  ), []);
  if (matches.length !== 1) fail(`${name} must be provided exactly once`);
  const value = args[matches[0] + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function assertSafeName(name, label) {
  if (typeof name !== 'string' || basename(name) !== name || !SAFE_NAME.test(name)) {
    fail(`${label} must be a safe basename`);
  }
}

function assertHash(hash, label) {
  if (!HEX_64.test(hash || '')) fail(`${label} must be a lowercase SHA-256`);
}

function readAssetDirectory(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    fail(`${label} must be a real directory`);
  }
  const names = readdirSync(path, { withFileTypes: true }).map((entry) => {
    assertSafeName(entry.name, `${label} entry ${entry.name}`);
    if (!entry.isFile()) fail(`${label} entry ${entry.name} must be a regular file`);
    return entry.name;
  }).sort((left, right) => left.localeCompare(right));
  if (!names.length) fail(`${label} must not be empty`);
  return names;
}

async function fingerprintAssets(directory, names, label) {
  const fingerprints = new Map();
  for (const name of names) {
    const path = join(directory, name);
    try {
      fingerprints.set(name, {
        size: statSync(path).size,
        sha256: await sha256File(path),
      });
    } catch (error) {
      fail(`${label} asset ${name} could not be hashed: ${error.message}`);
    }
  }
  return fingerprints;
}

function assertSameNames(expected, actual, label) {
  if (
    expected.length !== actual.length
    || expected.some((name, index) => name !== actual[index])
  ) {
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    fail(`${label} asset set differs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

function readChecksums(path, label) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail(`${label} is empty`);
  const checksums = new Map();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) fail(`${label} has an invalid checksum line`);
    const [, hash, name] = match;
    assertSafeName(name, `${label} entry ${name}`);
    assertHash(hash, `${label} entry ${name}`);
    if (checksums.has(name)) fail(`${label} has duplicate entry ${name}`);
    checksums.set(name, hash);
  }
  return checksums;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateBundle(directory, names, fingerprints, label, expectedCommit) {
  for (const name of REQUIRED_FILES) {
    if (!names.includes(name)) fail(`${label} is missing ${name}`);
  }
  for (const suffix of REQUIRED_INSTALLER_SUFFIXES) {
    if (!names.some((name) => name.endsWith(suffix))) {
      fail(`${label} is missing a ${suffix} release artifact`);
    }
  }

  const expectedChecksumNames = names
    .filter((name) => name !== 'SHA256SUMS')
    .sort((left, right) => left.localeCompare(right));
  const checksums = readChecksums(join(directory, 'SHA256SUMS'), `${label} SHA256SUMS`);
  assertSameNames(
    expectedChecksumNames,
    [...checksums.keys()].sort((left, right) => left.localeCompare(right)),
    `${label} checksum`,
  );
  for (const [name, expectedHash] of checksums) {
    const actualHash = fingerprints.get(name)?.sha256;
    if (actualHash !== expectedHash) fail(`${label} checksum mismatch for ${name}`);
  }

  const indexChecksumLines = readFileSync(join(directory, 'release-index.sha256'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  if (indexChecksumLines.length !== 1) fail(`${label} release-index.sha256 must have exactly one entry`);
  const indexChecksum = indexChecksumLines[0].match(/^([0-9a-f]{64}) {2}release-index\.json$/);
  if (!indexChecksum) fail(`${label} release-index.sha256 has an invalid entry`);
  if (fingerprints.get('release-index.json')?.sha256 !== indexChecksum[1]) {
    fail(`${label} release-index checksum mismatch`);
  }

  const index = readJson(join(directory, 'release-index.json'), `${label} release index`);
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.schemaVersion !== 1) {
    fail(`${label} release index schemaVersion must be 1`);
  }
  if (index.application?.commit !== expectedCommit) {
    fail(`${label} release index is for commit ${index.application?.commit || 'missing'}, expected ${expectedCommit}`);
  }
  if (!Array.isArray(index.releases)) fail(`${label} release index releases must be an array`);
  const targets = index.releases.map((release) => release?.target).sort();
  assertSameNames(REQUIRED_TARGETS, targets, `${label} platform target`);

  if (!Array.isArray(index.artifacts) || !index.artifacts.length) {
    fail(`${label} release index artifacts must be a non-empty array`);
  }
  const indexedNames = new Set();
  for (const [position, artifact] of index.artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail(`${label} release index artifact ${position} must be an object`);
    }
    assertSafeName(artifact.name, `${label} release index artifact ${position}`);
    assertHash(artifact.sha256, `${label} release index artifact ${artifact.name}`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      fail(`${label} release index artifact ${artifact.name} has an invalid size`);
    }
    if (indexedNames.has(artifact.name)) {
      fail(`${label} release index has duplicate artifact ${artifact.name}`);
    }
    indexedNames.add(artifact.name);
    if (!names.includes(artifact.name)) {
      fail(`${label} release index artifact ${artifact.name} is missing`);
    }
    const fingerprint = fingerprints.get(artifact.name);
    if (fingerprint?.size !== artifact.size) {
      fail(`${label} release index size mismatch for ${artifact.name}`);
    }
    if (fingerprint.sha256 !== artifact.sha256) {
      fail(`${label} release index hash mismatch for ${artifact.name}`);
    }
  }
}

const reference = resolve(option('--reference'));
const candidate = resolve(option('--candidate'));
const expectedCommit = option('--expected-commit');
const runId = option('--run-id');
if (!HEX_40.test(expectedCommit)) fail('--expected-commit must be a full lowercase Git commit');
if (!POSITIVE_INTEGER.test(runId)) fail('--run-id must be a positive workflow run ID');

const referenceNames = readAssetDirectory(reference, 'immutable run artifact');
const candidateNames = readAssetDirectory(candidate, 'draft');
const referenceFingerprints = await fingerprintAssets(
  reference,
  referenceNames,
  'immutable run artifact',
);
const candidateFingerprints = await fingerprintAssets(candidate, candidateNames, 'draft');
validateBundle(
  reference,
  referenceNames,
  referenceFingerprints,
  'immutable run artifact',
  expectedCommit,
);
validateBundle(candidate, candidateNames, candidateFingerprints, 'draft', expectedCommit);
assertSameNames(referenceNames, candidateNames, 'draft versus immutable run');

for (const name of referenceNames) {
  const referenceFingerprint = referenceFingerprints.get(name);
  const candidateFingerprint = candidateFingerprints.get(name);
  if (
    referenceFingerprint.size !== candidateFingerprint.size
    || referenceFingerprint.sha256 !== candidateFingerprint.sha256
  ) {
    fail(`draft asset ${name} does not match immutable artifact from successful run ${runId}`);
  }
}

console.log(
  `release promotion verification: ${candidateNames.length} draft assets match immutable successful run ${runId} at ${expectedCommit}`,
);
