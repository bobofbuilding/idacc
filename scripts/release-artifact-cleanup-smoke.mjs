#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'idacc-release-cleanup-'));
const desktop = path.join(root, 'idctl-desktop');
const release = path.join(desktop, 'release');
const cleaner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cleanup-release-artifacts.mjs');

function run(...args) {
  return spawnSync(process.execPath, [cleaner, ...args], { encoding: 'utf8' });
}

try {
  await mkdir(path.join(release, 'mac-arm64', 'ID Agents Control Center.app'), { recursive: true });
  await writeFile(path.join(desktop, 'package.json'), JSON.stringify({ name: 'idagents-control-center' }));
  await writeFile(path.join(desktop, 'keep.txt'), 'durable');
  await writeFile(path.join(release, 'artifact.bin'), Buffer.alloc(4096));

  const preview = run(desktop);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Would remove/);
  assert.equal((await readFile(path.join(release, 'artifact.bin'))).length, 4096);

  const applied = run('--apply', desktop);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Cleaned local release artifacts/);
  await assert.rejects(readFile(path.join(release, 'artifact.bin')));
  assert.equal(await readFile(path.join(desktop, 'keep.txt'), 'utf8'), 'durable');

  const invalid = path.join(root, 'not-the-desktop');
  await mkdir(path.join(invalid, 'release'), { recursive: true });
  await writeFile(path.join(invalid, 'package.json'), JSON.stringify({ name: 'idagents-control-center' }));
  const refused = run('--apply', invalid);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing cleanup outside/);
  console.log('release artifact cleanup smoke: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
