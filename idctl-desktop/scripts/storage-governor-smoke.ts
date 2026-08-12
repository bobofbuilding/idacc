import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppProfilePaths } from '../src/main/appProfile.ts';
import { allocatedProfileBytes, storageGovernorStatus } from '../src/main/storageGovernor.ts';

const root = mkdtempSync(join(tmpdir(), 'idacc-storage-governor-'));
const paths: AppProfilePaths = {
  root,
  config: join(root, 'config', 'config.json'),
  brain: join(root, 'brain'),
  manager: join(root, 'manager'),
  workspace: join(root, 'workspace'),
  logs: join(root, 'logs'),
  cache: join(root, 'cache'),
};
try {
  for (const path of [paths.brain, paths.manager, paths.workspace, paths.logs, paths.cache, join(root, 'backups'), join(root, 'migration-archives')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.brain, 'brain.db'), 'brain');
  writeFileSync(join(paths.workspace, 'deliverable.txt'), 'workspace');
  writeFileSync(join(root, 'backups', 'brain-20260812.db'), 'backup');
  const status = storageGovernorStatus(paths);
  assert.ok(status.profileBytes >= allocatedProfileBytes(paths.brain));
  assert.ok(status.categories.workspace > 0);
  assert.equal(status.policy.brainBackupKeepCount, 3);
  assert.equal(status.policy.brainBackupMaxBytes, 12 * 1024 ** 3);
  assert.ok(['healthy', 'warn', 'paused', 'blocked'].includes(status.mode));
  console.log('storage governor smoke: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
