#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const { load } = requireFromDesktop('js-yaml');
const script = join(root, 'scripts', 'merge-update-metadata.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'idacc-update-metadata-'));
const armDigest = Buffer.alloc(64, 0x61).toString('base64');
const intelDigest = Buffer.alloc(64, 0x62).toString('base64');

function metadata(arch, digest) {
  return [
    'version: 1.2.3',
    'files:',
    `  - url: IDACC-1.2.3-${arch}.zip`,
    `    sha512: ${digest}`,
    '    size: 42',
    `  - url: IDACC-1.2.3-${arch}.dmg`,
    `    sha512: ${digest}`,
    '    size: 43',
    `path: IDACC-1.2.3-${arch}.zip`,
    `sha512: ${digest}`,
    `releaseDate: '2026-07-25T00:00:0${arch === 'arm64' ? 1 : 2}.000Z'`,
    '',
  ].join('\n');
}

try {
  const arm = join(scratch, 'arm.yml');
  const intel = join(scratch, 'intel.yml');
  const output = join(scratch, 'latest-mac.yml');
  writeFileSync(arm, metadata('arm64', armDigest));
  writeFileSync(intel, metadata('x64', intelDigest));
  execFileSync(process.execPath, [
    script,
    '--input', arm,
    '--input', intel,
    '--output', output,
    '--require-mac-arches',
  ]);
  const merged = load(readFileSync(output, 'utf8'));
  assert.equal(merged.version, '1.2.3');
  assert.equal(merged.files.length, 4);
  assert.match(merged.path, /x64\.zip$/);
  assert.equal(merged.sha512, intelDigest);

  const mismatch = join(scratch, 'mismatch.yml');
  writeFileSync(mismatch, metadata('x64', intelDigest).replace('version: 1.2.3', 'version: 1.2.4'));
  const failed = spawnSync(process.execPath, [
    script,
    '--input', arm,
    '--input', mismatch,
    '--output', output,
  ], { encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /version does not match/);

  const unsafe = join(scratch, 'unsafe.yml');
  writeFileSync(unsafe, metadata('x64', intelDigest).replace(
    /IDACC-1\.2\.3-x64\.zip/g,
    'https://example.invalid/IDACC-1.2.3-x64.zip',
  ));
  const unsafeResult = spawnSync(process.execPath, [
    script,
    '--input', arm,
    '--input', unsafe,
    '--output', output,
  ], { encoding: 'utf8' });
  assert.notEqual(unsafeResult.status, 0);
  assert.match(unsafeResult.stderr, /unsafe artifact URL/);

  const duplicateArch = join(scratch, 'duplicate-arch.yml');
  writeFileSync(
    duplicateArch,
    metadata('arm64', intelDigest).replaceAll('IDACC-', 'IDACC-alternate-'),
  );
  const duplicateResult = spawnSync(process.execPath, [
    script,
    '--input', arm,
    '--input', duplicateArch,
    '--output', output,
    '--require-mac-arches',
  ], { encoding: 'utf8' });
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /duplicate macOS arm64 update feed/);
  console.log('update metadata merge smoke: ok');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
