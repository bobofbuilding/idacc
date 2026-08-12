import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';
import { ensurePrivateAppDirectory, writePrivateAppTextFileAtomic } from './appStatePrivacy.ts';

export type StorageOperationKind = 'import-historical-memories' | 'retire-legacy-storage';
type StorageOperationState = 'pending-confirmation' | 'confirmed' | 'cancelled' | 'completed' | 'failed';

export interface StorageOperationLease {
  id: string;
  profileRoot: string;
  kind: StorageOperationKind;
  state: StorageOperationState;
  createdAt: string;
  intent: Record<string, unknown>;
  confirmedAt?: string;
  cancelledAt?: string;
  completedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

function root(paths: AppProfilePaths): string {
  return join(paths.root, 'recovery', 'storage-operations');
}

function activePath(paths: AppProfilePaths): string {
  return join(root(paths), 'active.json');
}

function receiptPath(paths: AppProfilePaths, lease: StorageOperationLease): string {
  return join(root(paths), `${lease.createdAt.replaceAll(/[:.]/g, '')}-${lease.id}.json`);
}

function readLease(path: string): StorageOperationLease {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StorageOperationLease;
  if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.kind || !parsed.state) {
    throw new Error('Storage operation lease is malformed; no destructive recovery action will run.');
  }
  return parsed;
}

function writeActive(paths: AppProfilePaths, lease: StorageOperationLease): void {
  writeFileSync(activePath(paths), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
}

function assertActive(paths: AppProfilePaths, id: string): StorageOperationLease {
  if (!existsSync(activePath(paths))) throw new Error('Storage operation lease is no longer active. Review the recovery receipt before trying again.');
  const lease = readLease(activePath(paths));
  if (lease.id !== id || lease.profileRoot !== paths.root) {
    throw new Error('Storage operation lease does not match this profile. No recovery action was run.');
  }
  return lease;
}

/**
 * Establish a machine-wide, profile-scoped destructive-operation lease. The
 * exclusive create makes the lock effective across renderer reloads and a
 * second local IDACC build using the same profile.
 */
export function beginStorageOperation(
  paths: AppProfilePaths,
  kind: StorageOperationKind,
  intent: Record<string, unknown>,
): StorageOperationLease {
  ensurePrivateAppDirectory(root(paths));
  const active = activePath(paths);
  if (existsSync(active)) {
    const lease = readLease(active);
    throw new Error(`Storage recovery is already controlled by ${lease.kind} (${lease.state}, operation ${lease.id}). Review that operation before starting another.`);
  }
  const lease: StorageOperationLease = {
    id: randomUUID(),
    profileRoot: paths.root,
    kind,
    state: 'pending-confirmation',
    createdAt: new Date().toISOString(),
    intent,
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(active, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const other = readLease(active);
      throw new Error(`Storage recovery is already controlled by ${other.kind} (${other.state}, operation ${other.id}). Review that operation before starting another.`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return lease;
}

function finalize(paths: AppProfilePaths, id: string, patch: Partial<StorageOperationLease>): StorageOperationLease {
  const current = assertActive(paths, id);
  const lease = { ...current, ...patch } as StorageOperationLease;
  writeActive(paths, lease);
  writePrivateAppTextFileAtomic(receiptPath(paths, lease), `${JSON.stringify(lease, null, 2)}\n`);
  rmSync(activePath(paths), { force: true });
  return lease;
}

export function confirmStorageOperation(paths: AppProfilePaths, id: string): StorageOperationLease {
  const lease = assertActive(paths, id);
  if (lease.state !== 'pending-confirmation') throw new Error(`Storage operation ${id} is ${lease.state}; it cannot be confirmed.`);
  const confirmed = { ...lease, state: 'confirmed' as const, confirmedAt: new Date().toISOString() };
  writeActive(paths, confirmed);
  return confirmed;
}

export function cancelStorageOperation(paths: AppProfilePaths, id: string): StorageOperationLease {
  const lease = assertActive(paths, id);
  return finalize(paths, id, { state: 'cancelled', cancelledAt: new Date().toISOString() });
}

export function completeStorageOperation(paths: AppProfilePaths, id: string, result: Record<string, unknown>): StorageOperationLease {
  const lease = assertActive(paths, id);
  if (lease.state !== 'confirmed') throw new Error(`Storage operation ${id} was not confirmed.`);
  return finalize(paths, id, { state: 'completed', completedAt: new Date().toISOString(), result });
}

export function failStorageOperation(paths: AppProfilePaths, id: string, error: unknown): StorageOperationLease {
  const lease = assertActive(paths, id);
  return finalize(paths, id, {
    state: 'failed',
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
}
