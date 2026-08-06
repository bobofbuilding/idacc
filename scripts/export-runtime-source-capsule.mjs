#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAIN_RUNTIME_ROOTS,
  BRAIN_STATIC_ASSETS,
  runtimeModuleGraphPaths,
} from './lib/runtime-module-graph.mjs';
import {
  RUNTIME_SOURCE_UPSTREAM_MAPPING,
  runtimeSourceCapsuleTreeSha256,
  verifyRuntimeSourceCapsule,
} from './lib/runtime-source-capsule.mjs';
import {
  inspectComponentSource,
  readJson,
  sha256,
  validateRuntimeLock,
} from './lib/runtime-provenance.mjs';
import {
  assertConsumerPayload,
  inspectConsumerTextEntry,
} from './lib/consumer-payload-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function fail(message) {
  throw new Error(message);
}

function option(name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function ensureSafeOutputPath(path, label) {
  const resolved = resolve(path);
  if (
    resolved === repoRoot
    || resolved === dirname(repoRoot)
    || resolved === resolve('/')
  ) {
    fail(`${label} is too broad: ${resolved}`);
  }
  return resolved;
}

function runGit(source, gitArgs, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', gitArgs, {
    cwd: source,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr || result.stdout || '').trim();
    fail(
      `git ${gitArgs.join(' ')} failed in ${source}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return result.stdout;
}

function parseGitTree(source, tree) {
  const output = runGit(source, ['ls-tree', '-r', '-z', tree, '--'], {
    encoding: null,
  });
  const entries = new Map();
  let offset = 0;
  while (offset < output.length) {
    const nul = output.indexOf(0, offset);
    if (nul < 0) fail('git ls-tree returned a truncated record');
    const record = output.subarray(offset, nul);
    offset = nul + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) fail('git ls-tree returned a record without a path');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) fail('git ls-tree returned invalid metadata');
    const [mode, type, objectId] = metadata;
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) {
      // None of the audited runtime paths use a non-UTF-8 Git filename. Refuse
      // to guess if that invariant changes.
      continue;
    }
    entries.set(path, { mode, type, objectId });
  }
  return entries;
}

function gitBlobSha1(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function installGeneratedPair({
  stagedCapsule,
  stagedManifest,
  target,
  manifestPath,
}) {
  const targetBackup = `${target}.previous-${process.pid}`;
  const manifestBackup = `${manifestPath}.previous-${process.pid}`;
  if (existsSync(targetBackup) || existsSync(manifestBackup)) {
    fail('a previous capsule export backup already exists');
  }
  let targetBackedUp = false;
  let manifestBackedUp = false;
  let targetInstalled = false;
  let manifestInstalled = false;
  try {
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`capsule output is not a regular directory: ${target}`);
      }
      renameSync(target, targetBackup);
      targetBackedUp = true;
    }
    if (existsSync(manifestPath)) {
      const stat = lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(`capsule manifest output is not a regular file: ${manifestPath}`);
      }
      renameSync(manifestPath, manifestBackup);
      manifestBackedUp = true;
    }
    renameSync(stagedCapsule, target);
    targetInstalled = true;
    renameSync(stagedManifest, manifestPath);
    manifestInstalled = true;
    if (targetBackedUp) rmSync(targetBackup, { recursive: true, force: true });
    if (manifestBackedUp) rmSync(manifestBackup, { force: true });
  } catch (error) {
    if (manifestInstalled && existsSync(manifestPath)) {
      rmSync(manifestPath, { force: true });
    }
    if (targetInstalled && existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    if (manifestBackedUp && existsSync(manifestBackup)) {
      renameSync(manifestBackup, manifestPath);
    }
    if (targetBackedUp && existsSync(targetBackup)) {
      renameSync(targetBackup, target);
    }
    throw error;
  }
}

const componentName = option('--component', 'brain');
if (componentName !== 'brain') {
  fail('the runtime source capsule exporter currently supports only Brain');
}
const lockPath = resolve(
  option('--lock', join(repoRoot, 'release', 'runtime-lock.json')),
);
const source = resolve(
  option('--source', join(repoRoot, '.runtime-sources', 'brain')),
);
const target = ensureSafeOutputPath(
  option(
    '--target',
    join(repoRoot, 'release', 'runtime-sources', 'brain'),
  ),
  'capsule output',
);
const manifestPath = ensureSafeOutputPath(
  option(
    '--manifest',
    join(repoRoot, 'release', 'runtime-sources', 'brain.capsule.json'),
  ),
  'capsule manifest output',
);
const manifestFromTarget = relative(target, manifestPath);
if (
  manifestPath === target
  || (
    manifestFromTarget
    && manifestFromTarget !== '..'
    && !manifestFromTarget.startsWith(`..${sep}`)
    && !isAbsolute(manifestFromTarget)
  )
) {
  fail('capsule manifest output must be outside the capsule directory');
}

const lock = readJson(lockPath, 'runtime lock');
const lockErrors = validateRuntimeLock(lock);
if (lockErrors.length) {
  fail(`runtime lock is invalid:\n- ${lockErrors.join('\n- ')}`);
}
const component = lock.components[componentName];
const inspection = inspectComponentSource(componentName, component, source);
if (inspection.errors.length) {
  fail(
    `runtime source is not the exact clean locked component:\n- ${
      inspection.errors.join('\n- ')
    }`,
  );
}

const graphRoots = [...new Set([
  ...BRAIN_RUNTIME_ROOTS,
  component.entrypoint,
])];
const modulePaths = runtimeModuleGraphPaths(source, graphRoots);
for (const root of graphRoots) {
  if (!modulePaths.includes(root)) {
    fail(`required Brain runtime root is missing: ${root}`);
  }
}
const selectedPaths = [...new Set([
  ...modulePaths,
  'package.json',
  'package-lock.json',
  'LICENSE',
  ...BRAIN_STATIC_ASSETS,
])].sort(lexicalCompare);
for (const path of selectedPaths) {
  const absolute = join(source, ...path.split('/'));
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    fail(`required Brain capsule path is missing or not a regular file: ${path}`);
  }
}

const gitEntries = parseGitTree(source, component.tree);
mkdirSync(dirname(target), { recursive: true });
mkdirSync(dirname(manifestPath), { recursive: true });
const scratch = mkdtempSync(join(dirname(target), '.brain-capsule-export-'));
const stagedPayload = join(scratch, 'consumer-payload');
const stagedCapsule = join(stagedPayload, 'brain');
const stagedManifest = join(scratch, 'brain.capsule.json');

try {
  mkdirSync(stagedCapsule, { recursive: true });
  const files = [];
  for (const path of selectedPaths) {
    const gitEntry = gitEntries.get(path);
    if (!gitEntry || gitEntry.type !== 'blob') {
      fail(`locked Git tree has no blob for Brain capsule path ${path}`);
    }
    if (!['100644', '100755'].includes(gitEntry.mode)) {
      fail(`Brain capsule path ${path} has unsupported Git mode ${gitEntry.mode}`);
    }
    const bytes = runGit(source, ['cat-file', 'blob', gitEntry.objectId], {
      encoding: null,
    });
    if (gitBlobSha1(bytes) !== gitEntry.objectId) {
      fail(`Git returned inconsistent blob bytes for ${path}`);
    }
    const policyErrors = inspectConsumerTextEntry(
      `brain/${path}`,
      bytes,
      { runtimePolicy: true },
    );
    if (policyErrors.length) {
      fail(
        `Brain capsule path ${path} violates consumer policy:\n- ${
          policyErrors.join('\n- ')
        }`,
      );
    }
    const output = join(stagedCapsule, ...path.split('/'));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes, {
      mode: gitEntry.mode === '100755' ? 0o755 : 0o644,
    });
    if (process.platform !== 'win32') {
      chmodSync(output, gitEntry.mode === '100755' ? 0o755 : 0o644);
    }
    files.push({
      path,
      mode: gitEntry.mode,
      size: bytes.length,
      sha256: sha256(bytes),
      gitBlobSha1: gitEntry.objectId,
    });
  }

  // This full-tree pass covers forbidden path classes in addition to the
  // per-file content checks above.
  assertConsumerPayload(stagedPayload, 'Brain runtime source capsule');

  const treeSha256 = runtimeSourceCapsuleTreeSha256(files);
  const manifest = {
    schemaVersion: 1,
    component: componentName,
    repository: component.repository,
    commit: component.commit,
    tree: component.tree,
    version: component.version,
    packageLockSha256: component.packageLockSha256,
    entrypoint: component.entrypoint,
    serviceId: component.serviceId,
    upstreamMapping: RUNTIME_SOURCE_UPSTREAM_MAPPING,
    files,
    treeSha256,
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(stagedManifest, manifestBytes, { mode: 0o644 });
  const manifestSha256 = sha256(manifestBytes);
  const distributionSource = {
    mode: 'vendored-capsule',
    path: portableRelative(repoRoot, target),
    manifest: portableRelative(repoRoot, manifestPath),
    manifestSha256,
    treeSha256,
  };
  const verification = verifyRuntimeSourceCapsule({
    root: stagedCapsule,
    manifestPath: stagedManifest,
    component: {
      ...component,
      distributionSource,
    },
    componentName,
  });
  if (verification.errors.length) {
    fail(
      `generated Brain capsule failed self-verification:\n- ${
        verification.errors.join('\n- ')
      }`,
    );
  }

  installGeneratedPair({
    stagedCapsule,
    stagedManifest,
    target,
    manifestPath,
  });
  process.stdout.write(
    `${JSON.stringify({
      component: componentName,
      files: files.length,
      bytes: files.reduce((total, record) => total + record.size, 0),
      upstreamMapping: RUNTIME_SOURCE_UPSTREAM_MAPPING,
      distributionSource,
    }, null, 2)}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
