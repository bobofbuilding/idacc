#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const installer = join(root, 'scripts', 'install-id-agents-manager.mjs');
const fixture = mkdtempSync(join(tmpdir(), 'id-agents-installer-smoke-'));
const source = join(fixture, 'source');
const project = join(fixture, 'project');
const target = join(project, 'id-agents');

function git(args, cwd = source) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function install(extraArgs = [], expectedStatus = 0) {
  const result = spawnSync(process.execPath, [
    installer,
    '--project-dir', project,
    '--source', source,
    ...extraArgs,
  ], { encoding: 'utf8' });
  if (result.status !== expectedStatus) {
    throw new Error([
      `installer exited ${result.status}; expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

try {
  execFileSync('git', ['init', '--initial-branch=main', source]);
  git(['config', 'user.email', 'installer-smoke@example.invalid']);
  git(['config', 'user.name', 'Installer Smoke']);
  writeFileSync(join(source, 'version.txt'), 'one\n');
  git(['add', 'version.txt']);
  git(['commit', '-m', 'initial']);

  install();
  if (readFileSync(join(target, 'version.txt'), 'utf8') !== 'one\n') {
    throw new Error('fresh clone did not preserve fixture content');
  }

  writeFileSync(join(source, 'version.txt'), 'two\n');
  git(['add', 'version.txt']);
  git(['commit', '-m', 'update']);
  install();
  if (readFileSync(join(target, 'version.txt'), 'utf8') !== 'two\n') {
    throw new Error('fast-forward update did not reach the latest fixture commit');
  }

  writeFileSync(join(target, 'dirty.txt'), 'local change\n');
  const dirtyResult = install([], 1);
  if (!dirtyResult.includes('Refusing to update dirty manager checkout')) {
    throw new Error('dirty-worktree guard did not report the expected refusal');
  }

  console.log('id-agents manager installer smoke: ok');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
