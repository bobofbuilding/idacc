#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts', 'check-release-payload.mjs');

function write(path, body = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function run(path) {
  return spawnSync(process.execPath, [guard, path], {
    cwd: root,
    encoding: 'utf8',
  });
}

const dir = mkdtempSync(join(tmpdir(), 'idacc-release-payload-'));
try {
  const allowed = join(dir, 'allowed');
  write(join(allowed, 'workspace', 'projects', 'brain', 'brain.mjs'), 'console.log("framework");\n');
  write(join(allowed, 'workspace', 'projects', 'brain', 'routes', 'graph-app.mjs'), 'export {};\n');
  assert.equal(run(allowed).status, 0, 'Brain framework files should be allowed');

  const forbidden = join(dir, 'forbidden');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'brain.db'), 'local db');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'output', 'local-report.md'), 'local output');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'uploads', 'material.pdf'), 'upload');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'plans', 'archive', '99-local.md'), 'archived local plan');
  write(join(forbidden, 'workspace', 'projects', 'brain', '.quota-watch-cursor.json'), '{}');
  const failed = run(forbidden);
  assert.notEqual(failed.status, 0, 'Brain local state should fail release payload guard');
  assert.match(`${failed.stdout}\n${failed.stderr}`, /Brain (database|workspace state)/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
