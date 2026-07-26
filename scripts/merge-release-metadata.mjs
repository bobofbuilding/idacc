#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  readJson,
  sha256File,
  validateRuntimeLock,
} from './lib/runtime-provenance.mjs';

const args = process.argv.slice(2);
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/;
const REQUIRED_METADATA = [
  ['runtimeLock', 'runtime-lock.json'],
  ['runtimeManifest', 'runtime-manifest.json'],
  ['sbom', 'SBOM.cdx.json'],
  ['thirdPartyNotices', 'THIRD_PARTY_NOTICES.md'],
];

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function fail(message) {
  console.error(`release metadata merge failed: ${message}`);
  process.exit(1);
}

function assertSafeName(value, label) {
  if (typeof value !== 'string' || basename(value) !== value || !SAFE_NAME.test(value)) {
    fail(`${label} must be a safe basename`);
  }
}

function assertHash(value, label) {
  if (!HEX_64.test(value || '')) fail(`${label} must be a lowercase SHA-256`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readChecksums(path) {
  const entries = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) fail(`${path} has an invalid checksum line`);
    const [, hash, name] = match;
    assertSafeName(name, `checksum entry ${name}`);
    if (entries.has(name)) fail(`${path} contains duplicate checksum entry ${name}`);
    entries.set(name, hash);
  }
  return entries;
}

const metadataDirectories = options('--metadata').map((path) => resolve(path));
const output = resolve(option('--output', join(process.cwd(), 'release-index')));
if (!metadataDirectories.length) fail('at least one --metadata directory is required');

const releases = [];
const seenTargets = new Set();
const seenArtifacts = new Set();
let expectedApplication = '';
let expectedComponents = '';
let expectedRuntimeLock = '';

for (const directory of metadataDirectories) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    fail(`metadata input must be a directory: ${directory}`);
  }
  const releaseManifestPath = join(directory, 'release-manifest.json');
  const checksumsPath = join(directory, 'SHA256SUMS');
  for (const [label, path] of [
    ['release manifest', releaseManifestPath],
    ['checksums', checksumsPath],
  ]) {
    if (!existsSync(path) || !lstatSync(path).isFile()) fail(`${label} not found at ${path}`);
  }

  const manifest = readJson(releaseManifestPath, `release manifest at ${releaseManifestPath}`);
  if (manifest.schemaVersion !== 1) fail(`${releaseManifestPath} schemaVersion must be 1`);
  if (typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) {
    fail(`${releaseManifestPath} generatedAt must be an ISO timestamp`);
  }
  if (!manifest.application || typeof manifest.application !== 'object' || Array.isArray(manifest.application)) {
    fail(`${releaseManifestPath} application must be an object`);
  }
  if (!HEX_40.test(manifest.application.commit || '')) {
    fail(`${releaseManifestPath} application.commit must be a full lowercase Git commit`);
  }
  if (typeof manifest.application.version !== 'string' || !manifest.application.version) {
    fail(`${releaseManifestPath} application.version must be present`);
  }
  if (!manifest.components || typeof manifest.components !== 'object' || Array.isArray(manifest.components)) {
    fail(`${releaseManifestPath} components must be an object`);
  }

  const platform = manifest.build?.platform;
  const arch = manifest.build?.arch;
  if (typeof platform !== 'string' || !/^[a-z0-9._-]+$/.test(platform)) {
    fail(`${releaseManifestPath} build.platform is invalid`);
  }
  if (typeof arch !== 'string' || !/^[a-z0-9._-]+$/.test(arch)) {
    fail(`${releaseManifestPath} build.arch is invalid`);
  }
  assertHash(manifest.trees?.runtime, `${releaseManifestPath} trees.runtime`);
  const target = `${platform}-${arch}`;
  if (seenTargets.has(target)) fail(`duplicate platform target ${target}`);
  seenTargets.add(target);

  const application = stableJson(manifest.application);
  const components = stableJson(manifest.components);
  if (!expectedApplication) expectedApplication = application;
  else if (expectedApplication !== application) fail(`${target} application provenance differs from the other targets`);
  if (!expectedComponents) expectedComponents = components;
  else if (expectedComponents !== components) fail(`${target} component provenance differs from the other targets`);

  const checksums = readChecksums(checksumsPath);
  const metadata = {};
  for (const [key, expectedName] of REQUIRED_METADATA) {
    const record = manifest.metadata?.[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail(`${releaseManifestPath} metadata.${key} must be an object`);
    }
    if (record.name !== expectedName) {
      fail(`${releaseManifestPath} metadata.${key}.name must be ${expectedName}`);
    }
    assertHash(record.sha256, `${releaseManifestPath} metadata.${key}.sha256`);
    const filePath = join(directory, expectedName);
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
      fail(`${target} metadata file not found: ${expectedName}`);
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== record.sha256) fail(`${target} metadata file hash mismatch: ${expectedName}`);
    if (checksums.get(expectedName) !== actualHash) fail(`${target} SHA256SUMS mismatch: ${expectedName}`);
    metadata[key] = { name: expectedName, sha256: actualHash };
  }
  if (!expectedRuntimeLock) expectedRuntimeLock = metadata.runtimeLock.sha256;
  else if (expectedRuntimeLock !== metadata.runtimeLock.sha256) {
    fail(`${target} runtime lock differs from the other targets`);
  }
  const runtimeLock = readJson(join(directory, metadata.runtimeLock.name), `${target} runtime lock`);
  const runtimeLockErrors = validateRuntimeLock(runtimeLock);
  if (runtimeLockErrors.length) fail(`${target} runtime lock is invalid: ${runtimeLockErrors.join('; ')}`);
  if (stableJson(runtimeLock.components) !== stableJson(manifest.components)) {
    fail(`${target} release manifest components differ from its runtime lock`);
  }
  const runtimeManifest = readJson(join(directory, metadata.runtimeManifest.name), `${target} runtime manifest`);
  if (runtimeManifest.schemaVersion !== 2) fail(`${target} runtime manifest schemaVersion must be 2`);
  for (const field of ['application', 'build', 'components', 'trees']) {
    if (stableJson(runtimeManifest[field]) !== stableJson(manifest[field])) {
      fail(`${target} release manifest ${field} differs from its runtime manifest`);
    }
  }

  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
    fail(`${releaseManifestPath} artifacts must contain at least one artifact`);
  }
  const artifacts = manifest.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail(`${releaseManifestPath} artifacts[${index}] must be an object`);
    }
    assertSafeName(artifact.name, `${releaseManifestPath} artifacts[${index}].name`);
    assertHash(artifact.sha256, `${releaseManifestPath} artifacts[${index}].sha256`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      fail(`${releaseManifestPath} artifacts[${index}].size must be a non-negative safe integer`);
    }
    if (seenArtifacts.has(artifact.name)) fail(`duplicate release artifact name ${artifact.name}`);
    seenArtifacts.add(artifact.name);
    if (checksums.get(artifact.name) !== artifact.sha256) {
      fail(`${target} SHA256SUMS mismatch: ${artifact.name}`);
    }
    return {
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const releaseManifestSha256 = sha256File(releaseManifestPath);
  if (checksums.get('release-manifest.json') !== releaseManifestSha256) {
    fail(`${target} SHA256SUMS mismatch: release-manifest.json`);
  }
  const expectedChecksumNames = new Set([
    'release-manifest.json',
    ...REQUIRED_METADATA.map(([, name]) => name),
    ...artifacts.map((artifact) => artifact.name),
  ]);
  for (const name of checksums.keys()) {
    if (!expectedChecksumNames.has(name)) fail(`${target} SHA256SUMS has undeclared entry: ${name}`);
  }
  for (const name of expectedChecksumNames) {
    if (!checksums.has(name)) fail(`${target} SHA256SUMS is missing entry: ${name}`);
  }
  releases.push({
    target,
    platform,
    arch,
    generatedAt: manifest.generatedAt,
    runtimeTree: manifest.trees.runtime,
    trees: manifest.trees,
    metadata,
    releaseManifest: {
      name: `${target}/release-manifest.json`,
      sha256: releaseManifestSha256,
    },
    artifacts,
  });
}

releases.sort((a, b) => a.target.localeCompare(b.target));
const application = JSON.parse(expectedApplication);
const components = JSON.parse(expectedComponents);
const generatedAt = releases
  .map((release) => release.generatedAt)
  .sort((a, b) => Date.parse(a) - Date.parse(b))
  .at(-1);
const artifacts = releases.flatMap((release) => release.artifacts.map((artifact) => ({
  ...artifact,
  platform: release.platform,
  arch: release.arch,
  runtimeTree: release.runtimeTree,
  releaseManifestSha256: release.releaseManifest.sha256,
}))).sort((a, b) => a.name.localeCompare(b.name));

const index = {
  schemaVersion: 1,
  generatedAt,
  application,
  components,
  releases,
  artifacts,
};

mkdirSync(output, { recursive: true });
const indexPath = join(output, 'release-index.json');
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
const indexHash = sha256File(indexPath);
writeFileSync(join(output, 'release-index.sha256'), `${indexHash}  release-index.json\n`);

console.log(`Release metadata index generated → ${output}`);
console.log(`  ${releases.length} platform target(s)`);
console.log(`  ${artifacts.length} release artifact(s)`);
console.log(`  release-index sha256 ${indexHash}`);
