#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalRepository,
  validateRuntimeLock,
} from './lib/runtime-provenance.mjs';
import { RUNTIME_SOURCE_UPSTREAM_MAPPING } from './lib/runtime-source-capsule.mjs';
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
} from '../idctl-desktop/scripts/main-process-startup-policy.mjs';

const EXPECTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
]);
const BASE_PROVENANCE_METADATA_NAMES = [
  'runtime-lock.json',
  'runtime-manifest.json',
  'SBOM.cdx.json',
  'THIRD_PARTY_NOTICES.md',
  'release-manifest.json',
];
const BRAIN_RUNTIME_CAPSULE_NAME = 'brain-runtime-capsule.json';
const ROOT_CAPSULE_PROPERTIES = [
  ['idacc:brain-distribution-mode', 'vendored-capsule'],
  ['idacc:brain-capsule-manifest-sha256', 'manifestSha256'],
  ['idacc:brain-capsule-tree-sha256', 'treeSha256'],
];
const BRAIN_CAPSULE_PROPERTIES = [
  ['idacc:distribution-mode', 'vendored-capsule'],
  ['idacc:capsule-manifest-sha256', 'manifestSha256'],
  ['idacc:capsule-tree-sha256', 'treeSha256'],
];
const RUNTIME_SOURCE_CREDENTIAL_NOTE =
  'no private runtime-source credential was used; the scoped automatic github.token '
  + 'read the public IDACC and pinned Manager repositories and wrote only the '
  + 'pending/final review status on the exact IDACC commit; Brain came from the '
  + 'verified vendored runtime capsule';

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid option sequence near ${name || '(end)'}`);
    }
    if (result.has(name)) fail(`duplicate option: ${name}`);
    result.set(name, value);
  }
  return result;
}

function required(options, name) {
  const value = String(options.get(name) || '').trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256File(path) {
  const digest = createHash('sha256');
  digest.update(readFileSync(path));
  return digest.digest('hex');
}

function exactJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function walkRegularFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`review artifacts cannot contain symlinks: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
      else fail(`review artifacts contain an unsupported filesystem entry: ${path}`);
    }
  };
  visit(root);
  return result.sort();
}

function isUpdaterSidecar(name) {
  const lower = basename(name).toLowerCase();
  return (
    lower === 'app-update.yml'
    || /^(?:latest|review)(?:-[a-z0-9-]+)?\.ya?ml$/.test(lower)
    || lower.endsWith('.blockmap')
  );
}

function isInstaller(name) {
  const lower = basename(name).toLowerCase();
  return (
    lower.endsWith('.dmg')
    || lower.endsWith('.zip')
    || lower.endsWith('.exe')
    || lower.endsWith('.appimage')
    || lower.endsWith('.deb')
  );
}

function validateCandidate(candidate) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(candidate)) {
    fail('review candidate label must be 8-128 portable characters');
  }
}

function validateCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('review source commit must be an exact lowercase SHA-1');
}

function validateRepository(repository) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) {
    fail('review source repository must be an exact GitHub owner/name pair');
  }
}

function repositoryPair(repository) {
  return canonicalRepository(repository).replace(/^github\.com\//, '');
}

function validateChecksumName(name, label) {
  if (
    !name
    || basename(name) !== name
    || name === '.'
    || name === '..'
    || name.startsWith('-')
    || name.includes('\\')
    || /[\0-\x1f\x7f]/.test(name)
  ) {
    fail(`${label} contains an unsafe checksum path: ${name || '(missing)'}`);
  }
  return name;
}

function readChecksums(path, label) {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) fail(`${label} must end with a newline`);
  const checksums = new Map();
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.some((line) => !line)) {
    fail(`${label} must contain only non-empty checksum records`);
  }
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail(`${label} contains an invalid checksum record`);
    const name = validateChecksumName(match[2], label);
    if (checksums.has(name)) fail(`${label} contains duplicate checksum path: ${name}`);
    checksums.set(name, match[1]);
  }
  return checksums;
}

function assertExactNames(actualNames, expectedNames, label) {
  const actual = new Set(actualNames);
  const expected = new Set(expectedNames);
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length || extra.length || actual.size !== actualNames.length) {
    fail(
      `${label} does not contain the exact expected files`
      + `${missing.length ? `; missing: ${missing.join(', ')}` : ''}`
      + `${extra.length ? `; unexpected: ${extra.join(', ')}` : ''}`,
    );
  }
}

function assertHex(value, length, label) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(String(value || ''))) {
    fail(`${label} must be a lowercase ${length}-character hexadecimal digest`);
  }
}

function provenanceMetadataNames(runtimeLock) {
  const names = [...BASE_PROVENANCE_METADATA_NAMES];
  if (runtimeLock.components.brain.distributionSource?.mode === 'vendored-capsule') {
    names.splice(names.length - 1, 0, BRAIN_RUNTIME_CAPSULE_NAME);
  }
  return names;
}

function validateCapsuleManifestIdentity(path, component, label) {
  const manifest = readJson(path, label);
  const expected = [
    ['schemaVersion', 1],
    ['component', 'brain'],
    ['repository', component.repository],
    ['commit', component.commit],
    ['tree', component.tree],
    ['version', component.version],
    ['packageLockSha256', component.packageLockSha256],
    ['entrypoint', component.entrypoint],
    ['serviceId', component.serviceId],
    ['upstreamMapping', RUNTIME_SOURCE_UPSTREAM_MAPPING],
    ['treeSha256', component.distributionSource.treeSha256],
  ];
  for (const [field, value] of expected) {
    if (manifest?.[field] !== value) {
      fail(`${label} ${field} does not match the runtime lock`);
    }
  }
}

function propertyValue(component, name, label) {
  const properties = Array.isArray(component?.properties) ? component.properties : [];
  const matches = properties.filter((property) => property?.name === name);
  if (matches.length > 1) fail(`${label} contains duplicate ${name} properties`);
  return matches.length ? String(matches[0]?.value || '') : undefined;
}

function validateCapsulePropertySet(component, definitions, source, label) {
  for (const [name, expectedKey] of definitions) {
    const expected = expectedKey === 'vendored-capsule'
      ? expectedKey
      : source?.[expectedKey];
    const actual = propertyValue(component, name, label);
    if (source) {
      if (actual !== expected) {
        fail(`${label} ${name} does not match the runtime lock`);
      }
    } else if (actual !== undefined) {
      fail(`${label} declares ${name} without a capsule-backed runtime lock`);
    }
  }
}

function validateSbomCapsuleProperties(sbom, runtimeLock, label) {
  const source = runtimeLock.components.brain.distributionSource || null;
  validateCapsulePropertySet(
    sbom.metadata?.component,
    ROOT_CAPSULE_PROPERTIES,
    source,
    `${label} application component`,
  );
  const brainComponents = Array.isArray(sbom.components)
    ? sbom.components.filter((component) => (
        Array.isArray(component?.properties)
        && component.properties.some((property) => (
          property?.name === 'idacc:component-source' && property?.value === 'brain'
        ))
        && propertyValue(component, 'idacc:commit', label)
          === runtimeLock.components.brain.commit
      ))
    : [];
  if (source && brainComponents.length !== 1) {
    fail(`${label} must contain exactly one locked Brain runtime component`);
  }
  for (const component of brainComponents) {
    validateCapsulePropertySet(
      component,
      BRAIN_CAPSULE_PROPERTIES,
      source,
      `${label} Brain runtime component`,
    );
  }
}

function validateApplicationVersion(sourceVersion, applicationVersion) {
  if (
    !/^\d+\.\d+\.\d+$/.test(sourceVersion)
    || !new RegExp(`^${sourceVersion.replaceAll('.', '\\.')}\\-review\\.[1-9][0-9]*$`)
      .test(applicationVersion)
  ) {
    fail('review application version must be <source-version>-review.<positive-run-number>');
  }
}

function generatedAt(epochInput) {
  const epoch = Number(epochInput);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    fail('review source-date epoch must be a positive integer');
  }
  return new Date(epoch * 1000).toISOString();
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value || ''))) {
    fail(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be a safe positive integer`);
  return parsed;
}

function assertTargetInstallerSet(target, artifacts) {
  const extensions = new Set(artifacts.map(({ name }) => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.appimage')) return 'appimage';
    return lower.slice(lower.lastIndexOf('.') + 1);
  }));
  const requiredExtensions = target.startsWith('darwin-')
    ? ['dmg', 'zip']
    : target === 'win32-x64'
      ? ['exe']
      : target === 'linux-x64'
        ? ['appimage', 'deb']
        : [];
  for (const extension of requiredExtensions) {
    if (!extensions.has(extension)) {
      fail(`${target} review record is missing a .${extension} package`);
    }
  }
}

function record(options) {
  const root = resolve(options.get('--root') || process.cwd());
  const output = resolve(required(options, '--output'));
  const installers = resolve(required(options, '--installers'));
  const updaterRoot = resolve(required(options, '--updater'));
  const buildModePath = resolve(required(options, '--build-mode'));
  const platform = required(options, '--platform');
  const arch = required(options, '--arch');
  const target = `${platform}-${arch}`;
  const candidate = required(options, '--candidate');
  const commit = required(options, '--commit');
  const repository = required(options, '--repository');
  const runUrl = required(options, '--run-url');
  const runAttempt = positiveInteger(required(options, '--run-attempt'), 'review run attempt');
  const epochInput = required(options, '--source-date-epoch');
  const applicationVersion = required(options, '--application-version');
  const pkg = readJson(join(root, 'idctl-desktop', 'package.json'), 'desktop package');

  if (!EXPECTED_TARGETS.has(target)) fail(`unsupported native review target: ${target}`);
  validateCandidate(candidate);
  validateCommit(commit);
  validateRepository(repository);
  validateApplicationVersion(pkg.version, applicationVersion);
  if (!candidate.startsWith(`v${applicationVersion}-`)) {
    fail('review candidate label must include the packaged prerelease identity');
  }
  if (!existsSync(installers) || !lstatSync(installers).isDirectory()) {
    fail(`review installer directory is missing: ${installers}`);
  }
  if (!existsSync(updaterRoot) || !lstatSync(updaterRoot).isDirectory()) {
    fail(`review updater directory is missing: ${updaterRoot}`);
  }

  const buildMode = readJson(buildModePath, 'review build mode');
  if (
    buildMode.mode !== 'production'
    || buildMode.reviewOnly !== true
    || buildMode.updaterEnabled !== true
    || buildMode.updaterChannel !== 'review'
    || buildMode.sourceVersion !== pkg.version
    || buildMode.applicationVersion !== applicationVersion
  ) {
    fail('packaged review build is not isolated to the review update channel');
  }

  const artifactPaths = walkRegularFiles(installers);
  if (artifactPaths.length < 1) fail(`${target} produced no review packages`);
  const artifacts = artifactPaths.map((path) => {
    const name = basename(path);
    if (isUpdaterSidecar(name)) fail(`updater sidecar entered review packages: ${name}`);
    if (!isInstaller(name)) fail(`unexpected file entered review packages: ${name}`);
    const appImage = name.toLowerCase().endsWith('.appimage');
    // Windows filesystems do not expose the POSIX executable bits used by
    // AppImage. The real linux-x64 record job still enforces this before
    // upload, while cross-platform policy smoke tests can exercise the same
    // bundle contract on Windows.
    if (appImage && process.platform !== 'win32' && (lstatSync(path).mode & 0o111) === 0) {
      fail(`${target} AppImage is not executable before Actions upload: ${name}`);
    }
    return {
      name,
      byteLength: lstatSync(path).size,
      sha256: sha256File(path),
      mode: appImage ? '0755' : '0644',
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(artifacts.map(({ name }) => name)).size !== artifacts.length) {
    fail(`${target} produced duplicate package names`);
  }
  assertTargetInstallerSet(target, artifacts);
  const updaterArtifacts = walkRegularFiles(updaterRoot).map((path) => {
    const name = basename(path);
    if (!isUpdaterSidecar(name) || name.toLowerCase() === 'app-update.yml') {
      fail(`unexpected review updater file: ${name}`);
    }
    return {
      name,
      byteLength: lstatSync(path).size,
      sha256: sha256File(path),
      mode: '0644',
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (!updaterArtifacts.some(({ name }) => name.toLowerCase().endsWith('.yml'))) {
    fail(`${target} review updater is missing its channel descriptor`);
  }

  const runtimeLock = readJson(join(root, 'release', 'runtime-lock.json'), 'runtime lock');
  const timestamp = generatedAt(epochInput);
  const payload = {
    schemaVersion: 1,
    kind: 'idacc-review-build',
    reviewOnly: true,
    productionReady: false,
    signed: false,
    notarized: false,
    updater: {
      enabled: true,
      channel: 'review',
      descriptorsIncluded: true,
      artifacts: updaterArtifacts,
    },
    candidate,
    generatedAt: timestamp,
    source: {
      repository,
      commit,
      version: pkg.version,
    },
    applicationVersion,
    target: {
      platform,
      arch,
      id: target,
    },
    components: runtimeLock.components,
    credentials: {
      signingNotarizationRelease: 'not-used',
      runtimeSourceCheckout: RUNTIME_SOURCE_CREDENTIAL_NOTE,
    },
    workflowRunUrl: runUrl,
    runAttempt,
    artifacts,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
}

function copyTree(source, destination) {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    fail(`review provenance directory is missing: ${source}`);
  }
  for (const sourcePath of walkRegularFiles(source)) {
    const relativePath = portablePath(source, sourcePath);
    if (isUpdaterSidecar(relativePath)) {
      fail(`updater sidecar entered review provenance: ${relativePath}`);
    }
    const destinationPath = join(destination, ...relativePath.split('/'));
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (existsSync(destinationPath)) fail(`duplicate review provenance path: ${destinationPath}`);
    copyFileSync(sourcePath, destinationPath);
  }
}

function validatePlatformProvenance({
  provenanceSource,
  installerRoot,
  record,
  target,
  repository,
  commit,
  sourceVersion,
}) {
  if (!existsSync(provenanceSource) || !lstatSync(provenanceSource).isDirectory()) {
    fail(`${target} review provenance directory is missing`);
  }
  const provenancePaths = walkRegularFiles(provenanceSource);
  const provenanceNames = provenancePaths.map((path) => portablePath(provenanceSource, path));
  const runtimeLockPath = join(provenanceSource, 'runtime-lock.json');
  if (!existsSync(runtimeLockPath) || !lstatSync(runtimeLockPath).isFile()) {
    fail(`${target} review provenance is missing runtime-lock.json`);
  }
  const runtimeLock = readJson(runtimeLockPath, `${target} runtime lock`);
  const runtimeLockErrors = validateRuntimeLock(runtimeLock);
  if (runtimeLockErrors.length) {
    fail(`${target} runtime lock is invalid: ${runtimeLockErrors.join('; ')}`);
  }
  const metadataNames = provenanceMetadataNames(runtimeLock);
  assertExactNames(
    provenanceNames,
    [...metadataNames, 'SHA256SUMS'],
    `${target} review provenance`,
  );

  const artifactRecords = Array.isArray(record.artifacts) ? record.artifacts : [];
  const artifactNames = artifactRecords.map((artifact) => (
    validateChecksumName(String(artifact?.name || ''), `${target} review record`)
  ));
  assertExactNames(
    artifactNames,
    [...new Set(artifactNames)],
    `${target} review record artifacts`,
  );

  const checksumsPath = join(provenanceSource, 'SHA256SUMS');
  const checksums = readChecksums(checksumsPath, `${target} provenance SHA256SUMS`);
  assertExactNames(
    [...checksums.keys()],
    [...artifactNames, ...metadataNames],
    `${target} provenance SHA256SUMS`,
  );

  for (const artifact of artifactRecords) {
    const name = String(artifact.name);
    const installerPath = join(installerRoot, name);
    if (!existsSync(installerPath) || !lstatSync(installerPath).isFile()) {
      fail(`${target} recorded review package is missing: ${installerPath}`);
    }
    const actualSha256 = sha256File(installerPath);
    const actualByteLength = lstatSync(installerPath).size;
    if (
      artifact.sha256 !== actualSha256
      || artifact.byteLength !== actualByteLength
      || checksums.get(name) !== actualSha256
    ) {
      fail(`${target} installer bytes, record, and provenance checksum do not match: ${name}`);
    }
  }

  for (const name of metadataNames) {
    const path = join(provenanceSource, name);
    if (checksums.get(name) !== sha256File(path)) {
      fail(`${target} provenance checksum does not match ${name}`);
    }
  }

  if (!exactJson(runtimeLock.components, record.components)) {
    fail(`${target} runtime lock components do not match the platform record`);
  }

  const runtimeManifest = readJson(
    join(provenanceSource, 'runtime-manifest.json'),
    `${target} runtime manifest`,
  );
  const releaseManifest = readJson(
    join(provenanceSource, 'release-manifest.json'),
    `${target} release manifest`,
  );
  const sourceApplication = runtimeManifest.application;
  if (
    runtimeManifest.schemaVersion !== 2
    || sourceApplication?.commit !== commit
    || sourceApplication?.version !== sourceVersion
    || sourceApplication?.dirty !== false
    || repositoryPair(sourceApplication?.repository) !== repositoryPair(repository)
    || runtimeManifest.generatedAt !== record.generatedAt
    || runtimeManifest.build?.platform !== record.target?.platform
    || runtimeManifest.build?.arch !== record.target?.arch
    || !exactJson(runtimeManifest.components, record.components)
    || !Array.isArray(runtimeManifest.files)
    || runtimeManifest.files.length < 1
  ) {
    fail(`${target} runtime manifest identity does not match the platform record`);
  }
  assertHex(sourceApplication.tree, 40, `${target} runtime manifest application tree`);
  for (const name of ['manager', 'brain', 'runtime']) {
    assertHex(runtimeManifest.trees?.[name], 64, `${target} runtime manifest ${name} tree`);
  }

  if (
    releaseManifest.schemaVersion !== 1
    || releaseManifest.generatedAt !== record.generatedAt
    || !exactJson(releaseManifest.application, runtimeManifest.application)
    || !exactJson(releaseManifest.build, runtimeManifest.build)
    || !exactJson(releaseManifest.components, record.components)
    || !exactJson(releaseManifest.trees, runtimeManifest.trees)
  ) {
    fail(`${target} release manifest identity does not match the runtime manifest and platform record`);
  }

  const releasedArtifacts = Array.isArray(releaseManifest.artifacts)
    ? releaseManifest.artifacts
    : [];
  const releasedByName = new Map();
  for (const artifact of releasedArtifacts) {
    const name = validateChecksumName(
      String(artifact?.name || ''),
      `${target} release manifest`,
    );
    if (releasedByName.has(name)) {
      fail(`${target} release manifest contains duplicate artifact: ${name}`);
    }
    releasedByName.set(name, artifact);
  }
  assertExactNames(
    [...releasedByName.keys()],
    artifactNames,
    `${target} release manifest artifacts`,
  );
  for (const artifact of artifactRecords) {
    const released = releasedByName.get(artifact.name);
    if (
      released?.sha256 !== artifact.sha256
      || released?.size !== artifact.byteLength
    ) {
      fail(`${target} release manifest artifact does not match the platform record: ${artifact.name}`);
    }
  }

  const releaseMetadata = releaseManifest.metadata;
  const releaseMetadataDefinitions = [
    ['runtimeLock', 'runtime-lock.json'],
    ['runtimeManifest', 'runtime-manifest.json'],
    ['sbom', 'SBOM.cdx.json'],
    ['thirdPartyNotices', 'THIRD_PARTY_NOTICES.md'],
    ...(runtimeLock.components.brain.distributionSource ? [[
      'brainRuntimeCapsule',
      BRAIN_RUNTIME_CAPSULE_NAME,
    ]] : []),
  ];
  if (!releaseMetadata || typeof releaseMetadata !== 'object' || Array.isArray(releaseMetadata)) {
    fail(`${target} release manifest metadata must be an object`);
  }
  assertExactNames(
    Object.keys(releaseMetadata),
    releaseMetadataDefinitions.map(([field]) => field),
    `${target} release manifest metadata`,
  );
  for (const [field, expectedName] of releaseMetadataDefinitions) {
    const metadata = releaseMetadata?.[field];
    if (
      metadata?.name !== expectedName
      || metadata?.sha256 !== sha256File(join(provenanceSource, expectedName))
    ) {
      fail(`${target} release manifest metadata does not match ${expectedName}`);
    }
  }
  const capsuleSource = runtimeLock.components.brain.distributionSource || null;
  if (capsuleSource) {
    const capsulePath = join(provenanceSource, BRAIN_RUNTIME_CAPSULE_NAME);
    if (
      releaseMetadata.brainRuntimeCapsule.sha256
        !== capsuleSource.manifestSha256
    ) {
      fail(`${target} Brain runtime capsule manifest hash does not match the runtime lock`);
    }
    validateCapsuleManifestIdentity(
      capsulePath,
      runtimeLock.components.brain,
      `${target} Brain runtime capsule manifest`,
    );
  }

  const sbom = readJson(join(provenanceSource, 'SBOM.cdx.json'), `${target} SBOM`);
  const sbomProperties = new Map(
    Array.isArray(sbom.metadata?.component?.properties)
      ? sbom.metadata.component.properties.map((property) => [
          String(property?.name || ''),
          String(property?.value || ''),
        ])
      : [],
  );
  if (
    sbom.bomFormat !== 'CycloneDX'
    || sbom.metadata?.component?.version !== sourceVersion
    || sbomProperties.get('idacc:commit') !== commit
    || sbomProperties.get('idacc:runtime-tree-sha256') !== runtimeManifest.trees.runtime
    || sbomProperties.get('idacc:manager-commit') !== record.components?.manager?.commit
    || sbomProperties.get('idacc:brain-commit') !== record.components?.brain?.commit
  ) {
    fail(`${target} SBOM identity does not match the runtime manifest and platform record`);
  }
  validateSbomCapsuleProperties(sbom, runtimeLock, `${target} SBOM`);

  return {
    artifactRecords,
    metadataNames,
    metadataChecksums: new Map(
      metadataNames.map((name) => [
        name,
        sha256File(join(provenanceSource, name)),
      ]),
    ),
  };
}

function writeNormalizedPlatformChecksums(
  destination,
  artifactRecords,
  metadataNames,
  metadataChecksums,
) {
  const lines = [
    ...artifactRecords.map(({ name, sha256: digest }) => (
      `${digest}  ../../installers/${name}`
    )),
    ...metadataNames.map((name) => (
      `${metadataChecksums.get(name)}  ${name}`
    )),
  ].sort();
  writeFileSync(join(destination, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function assemble(options) {
  const input = resolve(required(options, '--input'));
  const output = resolve(required(options, '--output'));
  const notice = resolve(required(options, '--notice'));
  const candidate = required(options, '--candidate');
  const commit = required(options, '--commit');
  const repository = required(options, '--repository');
  const sourceVersion = required(options, '--source-version');
  const applicationVersion = required(options, '--application-version');
  const runAttempt = positiveInteger(required(options, '--run-attempt'), 'assembly run attempt');

  validateCandidate(candidate);
  validateCommit(commit);
  validateRepository(repository);
  validateApplicationVersion(sourceVersion, applicationVersion);
  if (!candidate.startsWith(`v${applicationVersion}-`)) {
    fail('review candidate label must include the packaged prerelease identity');
  }
  if (!existsSync(input) || !lstatSync(input).isDirectory()) {
    fail(`downloaded review input directory is missing: ${input}`);
  }
  if (!existsSync(notice) || !lstatSync(notice).isFile()) {
    fail(`review notice is missing: ${notice}`);
  }
  if (existsSync(output) && readdirSync(output).length > 0) {
    fail(`review bundle output must start empty: ${output}`);
  }
  mkdirSync(output, { recursive: true });

  const recordPaths = walkRegularFiles(input).filter((path) => (
    portablePath(input, path).split('/').includes('platform-records')
    && path.toLowerCase().endsWith('.json')
  ));
  if (
    recordPaths.length < EXPECTED_TARGETS.size
    || recordPaths.length > EXPECTED_TARGETS.size * 50
  ) {
    fail(
      `expected ${EXPECTED_TARGETS.size}-${EXPECTED_TARGETS.size * 50} `
      + `native review records across workflow attempts, found ${recordPaths.length}`,
    );
  }

  const recordsByTarget = new Map();
  const seenTargetAttempts = new Set();
  for (const path of recordPaths) {
    const value = readJson(path, 'native review record');
    if (
      value.schemaVersion !== 1
      || value.kind !== 'idacc-review-build'
      || value.reviewOnly !== true
      || value.productionReady !== false
      || value.signed !== false
      || value.notarized !== false
      || value.updater?.enabled !== true
      || value.updater?.channel !== 'review'
      || value.updater?.descriptorsIncluded !== true
      || value.credentials?.signingNotarizationRelease !== 'not-used'
      || value.credentials?.runtimeSourceCheckout !== RUNTIME_SOURCE_CREDENTIAL_NOTE
    ) {
      fail(`invalid isolated review-channel record: ${path}`);
    }
    if (
      value.candidate !== candidate
      || value.source?.repository !== repository
      || value.source?.commit !== commit
      || value.source?.version !== sourceVersion
      || value.applicationVersion !== applicationVersion
    ) {
      fail(`review record does not match the requested exact source: ${path}`);
    }
    const target = String(value.target?.id || '');
    if (!EXPECTED_TARGETS.has(target)) {
      fail(`unsupported review target: ${target || '(missing)'}`);
    }
    const recordAttempt = positiveInteger(value.runAttempt, `${target} review record runAttempt`);
    if (recordAttempt > runAttempt) {
      fail(`${target} review record attempt ${recordAttempt} is newer than assembly attempt ${runAttempt}`);
    }
    const targetAttempt = `${target}\0${recordAttempt}`;
    if (seenTargetAttempts.has(targetAttempt)) {
      fail(`duplicate review target and run attempt: ${target} attempt ${recordAttempt}`);
    }
    seenTargetAttempts.add(targetAttempt);
    const current = recordsByTarget.get(target);
    if (!current || recordAttempt > current.runAttempt) {
      recordsByTarget.set(target, {
        path,
        value,
        runAttempt: recordAttempt,
      });
    }
  }
  if (
    recordsByTarget.size !== EXPECTED_TARGETS.size
    || [...EXPECTED_TARGETS].some((target) => !recordsByTarget.has(target))
  ) {
    fail('review inputs do not contain every required native target across workflow attempts');
  }
  const records = [...recordsByTarget.values()].sort((left, right) => (
    String(left.value.target.id).localeCompare(String(right.value.target.id))
  ));
  const targets = new Set();
  const targetRunAttempts = {};
  let commonComponents = '';
  let commonGeneratedAt = '';
  const allArtifacts = [];

  for (const { path, value } of records) {
    const target = String(value.target?.id || '');
    if (!EXPECTED_TARGETS.has(target) || targets.has(target)) {
      fail(`duplicate or unsupported review target: ${target || '(missing)'}`);
    }
    targets.add(target);
    targetRunAttempts[target] = positiveInteger(
      value.runAttempt,
      `${target} review record runAttempt`,
    );
    const serializedComponents = JSON.stringify(value.components);
    if (!commonComponents) commonComponents = serializedComponents;
    else if (serializedComponents !== commonComponents) {
      fail('native review records do not pin the same Manager and Brain components');
    }
    if (!commonGeneratedAt) commonGeneratedAt = String(value.generatedAt || '');
    else if (value.generatedAt !== commonGeneratedAt) {
      fail('native review records do not share one deterministic source timestamp');
    }

    const platformRoot = dirname(dirname(path));
    const installerRoot = join(platformRoot, 'installers');
    const updaterRoot = join(platformRoot, 'updater');
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    assertTargetInstallerSet(target, artifacts);
    const provenanceSource = join(platformRoot, 'provenance', target);
    const validatedProvenance = validatePlatformProvenance({
      provenanceSource,
      installerRoot,
      record: value,
      target,
      repository,
      commit,
      sourceVersion,
    });
    for (const artifact of artifacts) {
      const name = String(artifact?.name || '');
      if (basename(name) !== name || !isInstaller(name) || isUpdaterSidecar(name)) {
        fail(`invalid review package name in ${target}: ${name || '(missing)'}`);
      }
      const sourcePath = join(installerRoot, name);
      if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
        fail(`recorded review package is missing: ${sourcePath}`);
      }
      const actualSha256 = sha256File(sourcePath);
      const actualByteLength = lstatSync(sourcePath).size;
      if (artifact.sha256 !== actualSha256 || artifact.byteLength !== actualByteLength) {
        fail(`recorded review package bytes changed: ${name}`);
      }
      const expectedMode = name.toLowerCase().endsWith('.appimage') ? '0755' : '0644';
      if (artifact.mode !== expectedMode) {
        fail(`recorded review package mode is invalid: ${name}`);
      }
      const destinationPath = join(output, 'installers', name);
      mkdirSync(dirname(destinationPath), { recursive: true });
      if (existsSync(destinationPath)) fail(`duplicate review package name: ${name}`);
      copyFileSync(sourcePath, destinationPath);
      if (name.toLowerCase().endsWith('.appimage')) {
        chmodSync(destinationPath, 0o755);
      } else {
        chmodSync(destinationPath, 0o644);
      }
      allArtifacts.push({
        target,
        name,
        byteLength: actualByteLength,
        sha256: actualSha256,
        mode: name.toLowerCase().endsWith('.appimage') ? '0755' : '0644',
      });
    }

    const updaterArtifacts = Array.isArray(value.updater?.artifacts)
      ? value.updater.artifacts
      : [];
    if (
      value.updater?.enabled !== true
      || value.updater?.channel !== 'review'
      || value.updater?.descriptorsIncluded !== true
      || !updaterArtifacts.length
    ) {
      fail(`${target} review record does not bind its review updater assets`);
    }
    for (const artifact of updaterArtifacts) {
      const name = String(artifact?.name || '');
      if (basename(name) !== name || !isUpdaterSidecar(name) || name === 'app-update.yml') {
        fail(`invalid review updater asset in ${target}: ${name || '(missing)'}`);
      }
      const sourcePath = join(updaterRoot, name);
      if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
        fail(`recorded review updater asset is missing: ${sourcePath}`);
      }
      const actualSha256 = sha256File(sourcePath);
      const actualByteLength = lstatSync(sourcePath).size;
      if (artifact.sha256 !== actualSha256 || artifact.byteLength !== actualByteLength) {
        fail(`recorded review updater bytes changed: ${name}`);
      }
      const destinationPath = join(output, 'updater', target, name);
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, 0o644);
    }

    const provenanceDestination = join(output, 'provenance', target);
    copyTree(provenanceSource, provenanceDestination);
    writeNormalizedPlatformChecksums(
      provenanceDestination,
      validatedProvenance.artifactRecords,
      validatedProvenance.metadataNames,
      validatedProvenance.metadataChecksums,
    );
    const recordDestination = join(output, 'platform-records', `${target}.json`);
    mkdirSync(dirname(recordDestination), { recursive: true });
    copyFileSync(path, recordDestination);
  }

  if (
    targets.size !== EXPECTED_TARGETS.size
    || [...EXPECTED_TARGETS].some((target) => !targets.has(target))
  ) {
    fail('review bundle does not contain every required native target');
  }

  copyFileSync(notice, join(output, 'REVIEW-NOTICE.md'));
  const components = JSON.parse(commonComponents);
  const bundle = {
    schemaVersion: 1,
    kind: 'idacc-review-bundle',
    reviewOnly: true,
    productionReady: false,
    signing: 'unsigned-and-unnotarized',
    updater: {
      enabled: true,
      channel: 'review',
      descriptorsIncluded: true,
    },
    candidate,
    generatedAt: commonGeneratedAt,
    source: {
      repository,
      commit,
      version: sourceVersion,
    },
    applicationVersion,
    runAttempt,
    targetRunAttempts,
    components,
    credentials: {
      signingNotarizationRelease: 'not-used',
      runtimeSourceCheckout: RUNTIME_SOURCE_CREDENTIAL_NOTE,
    },
    targets: [...targets].sort(),
    artifacts: allArtifacts.sort((left, right) => (
      left.target.localeCompare(right.target) || left.name.localeCompare(right.name)
    )),
  };
  writeFileSync(
    join(output, 'REVIEW-BUNDLE.json'),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );

  const bundleFiles = walkRegularFiles(output);
  const checksumLines = bundleFiles
    .filter((path) => basename(path) !== 'SHA256SUMS' || dirname(path) !== output)
    .map((path) => `${sha256File(path)}  ${portablePath(output, path)}`);
  if (checksumLines.length < 1) fail('assembled review bundle is empty');
  writeFileSync(join(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
}

function verifyPackage(options) {
  const root = resolve(options.get('--root') || process.cwd());
  const unpacked = resolve(required(options, '--unpacked'));
  const sourceVersion = required(options, '--source-version');
  const applicationVersion = required(options, '--application-version');
  validateApplicationVersion(sourceVersion, applicationVersion);
  if (!existsSync(unpacked) || !lstatSync(unpacked).isDirectory()) {
    fail(`unpacked review application is missing: ${unpacked}`);
  }
  const resources = unpacked.toLowerCase().endsWith('.app')
    ? join(unpacked, 'Contents', 'Resources')
    : join(unpacked, 'resources');
  if (!existsSync(resources) || !lstatSync(resources).isDirectory()) {
    fail(`unpacked review application resources are missing: ${resources}`);
  }
  const updateDescriptor = readdirSync(resources).find(
    (name) => name.toLowerCase() === 'app-update.yml',
  );
  if (!updateDescriptor) fail('review application is missing its compiled updater configuration');
  const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
  const { load } = requireFromDesktop('js-yaml');
  const updateConfiguration = load(readFileSync(join(resources, updateDescriptor), 'utf8'));
  if (
    updateConfiguration?.provider !== 'github'
    || updateConfiguration?.owner !== 'bobofbuilding'
    || updateConfiguration?.repo !== 'idacc'
  ) {
    fail('review application updater configuration is not pinned to public IDACC');
  }
  const asarPath = join(resources, 'app.asar');
  if (!existsSync(asarPath) || !lstatSync(asarPath).isFile()) {
    fail(`review application archive is missing: ${asarPath}`);
  }
  const { extractFile } = requireFromDesktop('@electron/asar');
  const packaged = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  const buildMode = JSON.parse(
    extractFile(asarPath, join('out', 'build-mode.json')).toString('utf8'),
  );
  const mainProcess = extractFile(
    asarPath,
    join('out', 'main', 'main.cjs'),
  ).toString('utf8');
  const startupPolicyMarker = mainProcessStartupPolicyMarker('review');
  const startupPolicyBanner = mainProcessStartupBanner('review');
  if (packaged.version !== applicationVersion) {
    fail('packaged review application does not use the expected prerelease identity');
  }
  if (packaged.main !== 'out/main/main.cjs') {
    fail('packaged review application does not launch the guarded main process');
  }
  if (
    buildMode.mode !== 'production'
    || buildMode.reviewOnly !== true
    || buildMode.updaterEnabled !== true
    || buildMode.updaterChannel !== 'review'
    || buildMode.mainProcessStartupPolicy?.mode !== 'review'
    || buildMode.mainProcessStartupPolicy?.marker !== startupPolicyMarker
    || buildMode.mainProcessStartupPolicy?.rejectsLinuxSandboxDisableSwitches
      !== true
    || buildMode.sourceVersion !== sourceVersion
    || buildMode.applicationVersion !== applicationVersion
  ) {
    fail('packaged review application provenance is not review-isolated');
  }
  if (
    !mainProcess.startsWith(startupPolicyBanner)
    || mainProcess.indexOf(startupPolicyMarker, startupPolicyBanner.length) >= 0
    ||
    !mainProcess.includes('idacc-review-updater-enabled:v1')
    || mainProcess.includes('idacc-production-updater-enabled:v1')
  ) {
    fail('packaged review application did not compile the isolated review updater');
  }
  process.stdout.write(`verified review package ${applicationVersion} on the isolated review channel\n`);
}

const [command, ...optionValues] = process.argv.slice(2);
const options = parseOptions(optionValues);
if (command === 'record') record(options);
else if (command === 'assemble') assemble(options);
else if (command === 'verify-package') verifyPackage(options);
else fail('usage: review-artifact-bundle.mjs <record|assemble|verify-package> [options]');
