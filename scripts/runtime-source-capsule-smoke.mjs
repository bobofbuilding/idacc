#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeRuntimeSourceCapsule,
  runtimeSourceCapsuleTreeSha256,
  verifyRuntimeSourceCapsule,
} from './lib/runtime-source-capsule.mjs';
import {
  sha256,
  validateRuntimeLock,
} from './lib/runtime-provenance.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseLock = JSON.parse(readFileSync(join(root, 'release', 'runtime-lock.json'), 'utf8'));
const baseComponent = baseLock.components.brain;
const baseCapsule = resolve(root, baseComponent.distributionSource.path);
const baseManifest = resolve(root, baseComponent.distributionSource.manifest);
const scratch = mkdtempSync(join(tmpdir(), 'idacc-runtime-capsule-'));

function gitBlobSha1(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function fixture(name) {
  const directory = join(scratch, name);
  const capsule = join(directory, 'brain');
  const manifestPath = join(directory, 'brain.capsule.json');
  mkdirSync(directory, { recursive: true });
  cpSync(baseCapsule, capsule, { recursive: true, preserveTimestamps: true });
  cpSync(baseManifest, manifestPath);
  return {
    directory,
    capsule,
    manifestPath,
    component: clone(baseComponent),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  };
}

function persist(fx, {
  updateManifestHash = true,
  updateTreeHash = false,
} = {}) {
  const bytes = Buffer.from(`${JSON.stringify(fx.manifest, null, 2)}\n`, 'utf8');
  writeFileSync(fx.manifestPath, bytes);
  if (updateManifestHash) {
    fx.component.distributionSource.manifestSha256 = sha256(bytes);
  }
  if (updateTreeHash) {
    const treeSha256 = runtimeSourceCapsuleTreeSha256(fx.manifest.files);
    fx.manifest.treeSha256 = treeSha256;
    fx.component.distributionSource.treeSha256 = treeSha256;
    const rewritten = Buffer.from(`${JSON.stringify(fx.manifest, null, 2)}\n`, 'utf8');
    writeFileSync(fx.manifestPath, rewritten);
    if (updateManifestHash) {
      fx.component.distributionSource.manifestSha256 = sha256(rewritten);
    }
  }
}

function syncFile(fx, path) {
  const bytes = readFileSync(join(fx.capsule, ...path.split('/')));
  const record = fx.manifest.files.find((candidate) => candidate.path === path);
  assert.ok(record, `fixture record must exist for ${path}`);
  record.size = bytes.length;
  record.sha256 = sha256(bytes);
  record.gitBlobSha1 = gitBlobSha1(bytes);
  persist(fx, { updateTreeHash: true });
}

function verify(fx) {
  return verifyRuntimeSourceCapsule({
    root: fx.capsule,
    manifestPath: fx.manifestPath,
    component: fx.component,
    componentName: 'brain',
  });
}

function assertRejected(fx, pattern, message) {
  const result = verify(fx);
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `${message}\nExpected ${pattern}, received:\n${result.errors.join('\n')}`,
  );
}

try {
  assert.deepEqual(validateRuntimeLock(baseLock), []);
  const baseline = fixture('baseline');
  const baselineResult = verify(baseline);
  assert.deepEqual(baselineResult.errors, []);
  assert.equal(baselineResult.files.length, 74);
  assert.equal(
    baselineResult.manifestSha256,
    baseComponent.distributionSource.manifestSha256,
  );
  assert.equal(
    baselineResult.treeSha256,
    baseComponent.distributionSource.treeSha256,
  );

  const materialized = join(scratch, 'materialized');
  const materializedResult = materializeRuntimeSourceCapsule({
    root: baseline.capsule,
    manifestPath: baseline.manifestPath,
    component: baseline.component,
    componentName: 'brain',
    target: materialized,
  });
  assert.equal(materializedResult.files.length, 74);
  assert.ok(existsSync(join(materialized, 'brain.mjs')));
  assert.throws(
    () => materializeRuntimeSourceCapsule({
      root: baseline.capsule,
      manifestPath: baseline.manifestPath,
      component: baseline.component,
      componentName: 'brain',
      target: materialized,
    }),
    /target already exists/,
  );
  assert.throws(
    () => materializeRuntimeSourceCapsule({
      root: baseline.capsule,
      manifestPath: baseline.manifestPath,
      component: baseline.component,
      componentName: 'brain',
      target: join(baseline.capsule, 'nested-target'),
    }),
    /target must be outside/,
  );

  const rawManifestTamper = fixture('raw-manifest-tamper');
  writeFileSync(
    rawManifestTamper.manifestPath,
    `${readFileSync(rawManifestTamper.manifestPath, 'utf8')} `,
  );
  assertRejected(rawManifestTamper, /manifest SHA-256 .* does not match locked/, 'raw manifest bytes must be pinned');

  const payloadTamper = fixture('payload-tamper');
  writeFileSync(join(payloadTamper.capsule, 'brain.mjs'), 'export const tampered = true;\n');
  assertRejected(payloadTamper, /brain\.mjs (?:size|sha256|gitBlobSha1)/, 'payload tampering must be rejected');

  const extraFile = fixture('extra-file');
  writeFileSync(join(extraFile.capsule, 'extra.mjs'), 'export {};\n');
  assertRejected(extraFile, /unmanifested file: extra\.mjs/, 'extra files must be rejected');

  const missingFile = fixture('missing-file');
  rmSync(join(missingFile.capsule, 'brain.mjs'));
  assertRejected(missingFile, /missing manifested file brain\.mjs/, 'missing files must be rejected');

  const directoryInstead = fixture('directory-instead');
  rmSync(join(directoryInstead.capsule, 'brain.mjs'));
  mkdirSync(join(directoryInstead.capsule, 'brain.mjs'));
  assertRejected(directoryInstead, /missing manifested file brain\.mjs/, 'directories cannot replace files');

  if (process.platform !== 'win32') {
    const symlinkFile = fixture('symlink-file');
    rmSync(join(symlinkFile.capsule, 'brain.mjs'));
    symlinkSync('config.mjs', join(symlinkFile.capsule, 'brain.mjs'));
    assertRejected(symlinkFile, /symbolic link: brain\.mjs/, 'symlinks cannot replace capsule files');

    const ancestorReal = fixture('ancestor-real');
    const ancestorLink = join(scratch, 'ancestor-link');
    symlinkSync(ancestorReal.directory, ancestorLink);
    const linkedResult = verifyRuntimeSourceCapsule({
      root: join(ancestorLink, 'brain'),
      manifestPath: join(ancestorLink, 'brain.capsule.json'),
      component: ancestorReal.component,
      componentName: 'brain',
    });
    assert.ok(
      linkedResult.errors.some((error) => /traverses a symbolic link/.test(error)),
      'symlink ancestors must be rejected',
    );
  }

  const duplicate = fixture('duplicate-record');
  duplicate.manifest.files.push(clone(duplicate.manifest.files[0]));
  persist(duplicate, { updateTreeHash: true });
  assertRejected(duplicate, /duplicate path/, 'duplicate manifest paths must be rejected');

  const caseCollision = fixture('case-collision');
  const caseRecord = clone(
    caseCollision.manifest.files.find((record) => record.path === 'brain.mjs'),
  );
  caseRecord.path = 'BRAIN.mjs';
  caseCollision.manifest.files.push(caseRecord);
  caseCollision.manifest.files.sort((left, right) => left.path < right.path ? -1 : 1);
  persist(caseCollision, { updateTreeHash: true });
  assertRejected(caseCollision, /case-folded NFC path collision/, 'case-folded collisions must be rejected');

  const decomposed = fixture('decomposed-path');
  decomposed.manifest.files[0].path = `caf\u0065\u0301.mjs`;
  persist(decomposed, { updateTreeHash: true });
  assertRejected(decomposed, /path is unsafe/, 'non-NFC paths must be rejected');

  for (const [index, unsafePath] of [
    '../escape.mjs',
    '/absolute.mjs',
    'C:/drive.mjs',
    'nested\\backslash.mjs',
    'CON',
    'trailing-dot.',
    'trailing-space ',
  ].entries()) {
    const unsafe = fixture(`unsafe-${index}`);
    unsafe.manifest.files[0].path = unsafePath;
    persist(unsafe, { updateTreeHash: true });
    assertRejected(unsafe, /path is unsafe/, `unsafe path must be rejected: ${unsafePath}`);
  }

  const invalidMode = fixture('invalid-mode');
  invalidMode.manifest.files[0].mode = '100600';
  persist(invalidMode, { updateTreeHash: true });
  assertRejected(invalidMode, /unsupported mode/, 'unsupported Git modes must be rejected');

  const wrongTree = fixture('wrong-tree');
  wrongTree.component.distributionSource.treeSha256 = '0'.repeat(64);
  assertRejected(wrongTree, /tree SHA-256 .* does not match locked/, 'locked capsule tree hash must be enforced');

  const wrongIdentity = fixture('wrong-identity');
  wrongIdentity.manifest.serviceId = 'different-brain';
  persist(wrongIdentity);
  assertRejected(wrongIdentity, /serviceId .* does not match/, 'component service identity must be enforced');

  const invalidPackage = fixture('invalid-package');
  writeFileSync(join(invalidPackage.capsule, 'package.json'), '{invalid\n');
  syncFile(invalidPackage, 'package.json');
  assertRejected(invalidPackage, /package\.json is invalid/, 'invalid package metadata must be rejected');

  const personalContent = fixture('personal-content');
  writeFileSync(
    join(personalContent.capsule, 'brain.mjs'),
    'export const privatePath = "/Users/private-user/brain-state";\n',
  );
  syncFile(personalContent, 'brain.mjs');
  assertRejected(
    personalContent,
    /personal filesystem path|consumer payload/i,
    'consumer-neutrality policy must run during verification',
  );

  const managerCapsuleLock = clone(baseLock);
  managerCapsuleLock.components.manager.distributionSource = clone(
    managerCapsuleLock.components.brain.distributionSource,
  );
  assert.ok(
    validateRuntimeLock(managerCapsuleLock)
      .some((error) => /only Brain capsules are supported/.test(error)),
  );
  const nestedManifestLock = clone(baseLock);
  nestedManifestLock.components.brain.distributionSource.manifest =
    'release/runtime-sources/brain/manifest.json';
  assert.ok(
    validateRuntimeLock(nestedManifestLock)
      .some((error) => /manifest must be outside/.test(error)),
  );

  console.log('Runtime source capsule smoke test passed.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
