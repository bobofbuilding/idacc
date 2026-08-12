import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppProfilePaths } from '../src/main/appProfile.ts';
import { migrationFinalizationStatus } from '../src/main/migrationFinalization.ts';
import { workspaceRetentionStatus } from '../src/main/workspaceRetention.ts';
import { MIGRATION_COOLING_OFF_MS } from '../src/main/migrationFinalization.ts';

const root = mkdtempSync(join(tmpdir(), 'idacc-storage-lifecycle-'));
const paths: AppProfilePaths = { root, config: join(root, 'config', 'config.json'), brain: join(root, 'brain'), manager: join(root, 'manager'), workspace: join(root, 'workspace'), logs: join(root, 'logs'), cache: join(root, 'cache') };
try {
  for (const folder of [paths.brain, paths.manager, paths.workspace, join(root, 'migration-archives'), join(root, 'backups', 'legacy-brain')]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const legacy = join(root, 'migration-archives', 'receipt');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'rollback.json'), 'verified');
  for (const folder of [legacy, join(root, 'migration-archives')]) utimesSync(folder, new Date(now - MIGRATION_COOLING_OFF_MS - 1), new Date(now - MIGRATION_COOLING_OFF_MS - 1));
  const migrations = migrationFinalizationStatus(paths, now);
  assert.equal(migrations.readyCount, 1, 'verified migration archives become reviewable after cooling-off, never silently deleted');

  const tmp = join(paths.workspace, 'agent', 'tmp');
  const output = join(paths.workspace, 'agent', 'output');
  const modules = join(paths.workspace, 'agent', 'node_modules');
  for (const folder of [tmp, output, modules]) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'fixture'), 'x'); }
  const old = new Date(now - 15 * 24 * 60 * 60 * 1000);
  for (const folder of [tmp, output, modules]) utimesSync(folder, old, old);
  const workspace = workspaceRetentionStatus(paths, now);
  assert.deepEqual(workspace.candidates.map((candidate) => candidate.dataClass).sort(), ['dependency', 'output', 'temporary']);
  assert.equal(workspace.candidates.every((candidate) => candidate.eligible), true);
  assert.ok(workspace.eligibleBytes > 0);
  console.log('storage lifecycle smoke: ok');
} finally { rmSync(root, { recursive: true, force: true }); }
