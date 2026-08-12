import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';

const GiB = 1024 ** 3;
export const BRAIN_BACKUP_KEEP_COUNT = 3;
export const BRAIN_BACKUP_MAX_BYTES = 12 * GiB;
export const STORAGE_WARN_FREE_BYTES = 15 * GiB;
export const STORAGE_PAUSE_FREE_BYTES = 10 * GiB;
export const STORAGE_BLOCK_FREE_BYTES = 5 * GiB;
export const STORAGE_BACKUP_RESERVE_BYTES = 1 * GiB;

export interface StorageGovernorStatus {
  profileBytes: number;
  freeBytes: number | null;
  mode: 'healthy' | 'warn' | 'paused' | 'blocked';
  categories: Record<'brain' | 'manager' | 'backups' | 'migrationArchives' | 'workspace' | 'logs' | 'cache' | 'recovery', number>;
  policy: {
    brainBackupKeepCount: number;
    brainBackupMaxBytes: number;
    warnFreeBytes: number;
    pauseFreeBytes: number;
    blockFreeBytes: number;
  };
}

/** Size an app-owned tree without following links into arbitrary user content. */
export function allocatedProfileBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return 0;
  if (entry.isFile()) return Math.max(entry.size, entry.blocks * 512);
  if (!entry.isDirectory()) return 0;
  let total = Math.max(0, entry.blocks * 512);
  for (const name of readdirSync(path)) total += allocatedProfileBytes(join(path, name));
  return total;
}

function freeBytes(path: string): number | null {
  try {
    const fs = statfsSync(path);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

export function storageGovernorStatus(paths: AppProfilePaths): StorageGovernorStatus {
  const categories = {
    brain: allocatedProfileBytes(paths.brain),
    manager: allocatedProfileBytes(paths.manager),
    backups: allocatedProfileBytes(join(paths.root, 'backups')),
    migrationArchives: allocatedProfileBytes(join(paths.root, 'migration-archives')),
    workspace: allocatedProfileBytes(paths.workspace),
    logs: allocatedProfileBytes(paths.logs),
    cache: allocatedProfileBytes(paths.cache),
    recovery: allocatedProfileBytes(join(paths.root, 'recovery')),
  };
  const free = freeBytes(paths.root);
  const mode = free == null
    ? 'warn'
    : free < STORAGE_BLOCK_FREE_BYTES
      ? 'blocked'
      : free < STORAGE_PAUSE_FREE_BYTES
        ? 'paused'
        : free < STORAGE_WARN_FREE_BYTES
          ? 'warn'
          : 'healthy';
  return {
    profileBytes: Object.values(categories).reduce((sum, bytes) => sum + bytes, 0),
    freeBytes: free,
    mode,
    categories,
    policy: {
      brainBackupKeepCount: BRAIN_BACKUP_KEEP_COUNT,
      brainBackupMaxBytes: BRAIN_BACKUP_MAX_BYTES,
      warnFreeBytes: STORAGE_WARN_FREE_BYTES,
      pauseFreeBytes: STORAGE_PAUSE_FREE_BYTES,
      blockFreeBytes: STORAGE_BLOCK_FREE_BYTES,
    },
  };
}

/** Reject large copies before SQLite starts writing a temporary full snapshot. */
export function assertStorageReservation(paths: AppProfilePaths, requiredBytes: number, operation: string): StorageGovernorStatus {
  const status = storageGovernorStatus(paths);
  const required = Math.max(0, Number(requiredBytes) || 0) + STORAGE_BACKUP_RESERVE_BYTES;
  if (status.freeBytes == null) throw new Error(`IDACC could not determine free disk space; ${operation} was not started.`);
  if (status.freeBytes < STORAGE_BLOCK_FREE_BYTES || status.freeBytes < required) {
    throw new Error(`${operation} needs ${required} bytes of free space, but only ${status.freeBytes} bytes are available. Free space through IDACC storage recovery first.`);
  }
  return status;
}
