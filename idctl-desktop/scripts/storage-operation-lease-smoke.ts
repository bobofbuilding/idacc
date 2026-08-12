import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppProfilePaths } from '../src/main/appProfile.ts';
import {
  beginStorageOperation,
  cancelStorageOperation,
  completeStorageOperation,
  confirmStorageOperation,
} from '../src/main/storageOperationLease.ts';

const root = mkdtempSync(join(tmpdir(), 'idacc-storage-operation-'));
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
  const first = beginStorageOperation(paths, 'import-historical-memories', { expectedPayloads: 80 });
  assert.throws(
    () => beginStorageOperation(paths, 'retire-legacy-storage', { cleanupBytes: 1 }),
    /already controlled/,
    'a second task/process must not obtain a concurrent destructive-operation lease',
  );
  const cancelled = cancelStorageOperation(paths, first.id);
  assert.equal(cancelled.state, 'cancelled');

  const stale = beginStorageOperation(paths, 'import-historical-memories', { expectedPayloads: 1 });
  const active = join(root, 'recovery', 'storage-operations', 'active.json');
  const payload = JSON.parse(readFileSync(active, 'utf8')) as { expiresAt: string };
  payload.expiresAt = new Date(Date.now() - 1).toISOString();
  writeFileSync(active, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  assert.throws(() => confirmStorageOperation(paths, stale.id), /expired and was cancelled/);

  const second = beginStorageOperation(paths, 'retire-legacy-storage', { cleanupBytes: 123, targets: [{ path: '/profile/backups', bytes: 123 }] });
  assert.equal(confirmStorageOperation(paths, second.id).state, 'confirmed');
  assert.equal(completeStorageOperation(paths, second.id, { removedBytes: 123 }).state, 'completed');

  const receipts = readdirSync(join(root, 'recovery', 'storage-operations'))
    .filter((name) => name.endsWith('.json') && name !== 'active.json')
    .map((name) => JSON.parse(readFileSync(join(root, 'recovery', 'storage-operations', name), 'utf8')) as { state: string });
  assert.deepEqual(receipts.map((receipt) => receipt.state).sort(), ['cancelled', 'cancelled', 'completed']);
  console.log('storage operation lease smoke: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
