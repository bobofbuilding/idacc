import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';
import { readPrivateAppTextFile, ensurePrivateAppDirectory, writePrivateAppTextFileAtomic } from './appStatePrivacy.ts';

const GiB = 1024 ** 3;
export const BRAIN_BACKUP_KEEP_COUNT = 3;
export const BRAIN_BACKUP_MAX_BYTES = 12 * GiB;
export const STORAGE_WARN_FREE_BYTES = 15 * GiB;
export const STORAGE_PAUSE_FREE_BYTES = 10 * GiB;
export const STORAGE_BLOCK_FREE_BYTES = 5 * GiB;
export const STORAGE_BACKUP_RESERVE_BYTES = 1 * GiB;
export const STORAGE_TOTAL_PROFILE_BUDGET_BYTES = 64 * GiB;
export const STORAGE_WORKSPACE_BUDGET_BYTES = 40 * GiB;
export const STORAGE_BACKUPS_BUDGET_BYTES = 12 * GiB;
export const STORAGE_HISTORY_RETENTION_DAYS = 30;

type CategoryName = 'brain' | 'manager' | 'backups' | 'migrationArchives' | 'workspace' | 'workspaceOutput' | 'workspaceTmp' | 'workspaceUploads' | 'workspaceDependencies' | 'workspaceBrowser' | 'logs' | 'cache' | 'recovery';
export type StorageBudgetState = 'within-budget' | 'over-budget';

export interface StorageHistoryPoint { at: string; profileBytes: number; freeBytes: number | null; }

export interface StorageGovernorStatus {
  profileBytes: number;
  freeBytes: number | null;
  mode: 'healthy' | 'warn' | 'paused' | 'blocked';
  categories: Record<CategoryName, number>;
  budgets: { totalProfileBytes: number; workspaceBytes: number; backupsBytes: number; state: StorageBudgetState; exceeded: string[] };
  growth: { samples: number; sevenDayBytes: number | null; bytesPerDay: number | null; estimatedDaysToBlock: number | null };
  policy: {
    brainBackupKeepCount: number;
    brainBackupMaxBytes: number;
    warnFreeBytes: number;
    pauseFreeBytes: number;
    blockFreeBytes: number;
  };
}

function statePath(paths: AppProfilePaths): string { return join(paths.root, 'recovery', 'storage-governor-v1.json'); }

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

function allocatedNamedChildren(path: string, names: Set<string>): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const entry = lstatSync(child);
    if (entry.isSymbolicLink()) continue;
    if (names.has(name)) total += allocatedProfileBytes(child);
    if (entry.isDirectory()) total += allocatedNamedChildren(child, names);
  }
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
    workspaceOutput: allocatedNamedChildren(paths.workspace, new Set(['output'])),
    workspaceTmp: allocatedNamedChildren(paths.workspace, new Set(['tmp', '.tmp'])),
    workspaceUploads: allocatedNamedChildren(paths.workspace, new Set(['uploads'])),
    workspaceDependencies: allocatedNamedChildren(paths.workspace, new Set(['node_modules', '.pnpm-store', '.yarn'])),
    workspaceBrowser: allocatedNamedChildren(paths.workspace, new Set(['.cache', 'ms-playwright', 'playwright', 'browser-cache'])),
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
  const profileBytes = categories.brain + categories.manager + categories.backups + categories.migrationArchives + categories.workspace + categories.logs + categories.cache + categories.recovery;
  const exceeded: string[] = [];
  if (profileBytes > STORAGE_TOTAL_PROFILE_BUDGET_BYTES) exceeded.push('total profile');
  if (categories.workspace > STORAGE_WORKSPACE_BUDGET_BYTES) exceeded.push('workspace');
  if (categories.backups > STORAGE_BACKUPS_BUDGET_BYTES) exceeded.push('backups');
  const history = readStorageHistory(paths);
  const oldestSevenDay = [...history].reverse().find((point) => Date.now() - Date.parse(point.at) >= 7 * 24 * 60 * 60 * 1000);
  const sevenDayBytes = oldestSevenDay ? profileBytes - oldestSevenDay.profileBytes : null;
  const bytesPerDay = oldestSevenDay ? sevenDayBytes! / Math.max(1, (Date.now() - Date.parse(oldestSevenDay.at)) / 86_400_000) : null;
  const estimatedDaysToBlock = bytesPerDay && bytesPerDay > 0 && free != null
    ? Math.max(0, (free - STORAGE_BLOCK_FREE_BYTES) / bytesPerDay)
    : null;
  return {
    profileBytes,
    freeBytes: free,
    mode,
    categories,
    budgets: {
      totalProfileBytes: STORAGE_TOTAL_PROFILE_BUDGET_BYTES,
      workspaceBytes: STORAGE_WORKSPACE_BUDGET_BYTES,
      backupsBytes: STORAGE_BACKUPS_BUDGET_BYTES,
      state: exceeded.length ? 'over-budget' : 'within-budget',
      exceeded,
    },
    growth: { samples: history.length, sevenDayBytes, bytesPerDay, estimatedDaysToBlock },
    policy: {
      brainBackupKeepCount: BRAIN_BACKUP_KEEP_COUNT,
      brainBackupMaxBytes: BRAIN_BACKUP_MAX_BYTES,
      warnFreeBytes: STORAGE_WARN_FREE_BYTES,
      pauseFreeBytes: STORAGE_PAUSE_FREE_BYTES,
      blockFreeBytes: STORAGE_BLOCK_FREE_BYTES,
    },
  };
}

function readStorageHistory(paths: AppProfilePaths): StorageHistoryPoint[] {
  try {
    const raw = readPrivateAppTextFile(statePath(paths));
    const parsed = JSON.parse(raw) as { samples?: unknown };
    return Array.isArray(parsed.samples)
      ? parsed.samples.filter((point): point is StorageHistoryPoint => Boolean(point && typeof point === 'object' && typeof (point as StorageHistoryPoint).at === 'string' && Number.isFinite((point as StorageHistoryPoint).profileBytes)))
      : [];
  } catch { return []; }
}

/** At most one immutable sample per day. Read operations never write history. */
export function recordStorageGovernorSample(paths: AppProfilePaths, at = new Date()): StorageGovernorStatus {
  const status = storageGovernorStatus(paths);
  const previous = readStorageHistory(paths);
  const today = at.toISOString().slice(0, 10);
  const samples = previous.filter((point) => Date.parse(point.at) >= at.getTime() - STORAGE_HISTORY_RETENTION_DAYS * 86_400_000 && point.at.slice(0, 10) !== today);
  samples.push({ at: at.toISOString(), profileBytes: status.profileBytes, freeBytes: status.freeBytes });
  ensurePrivateAppDirectory(join(paths.root, 'recovery'));
  writePrivateAppTextFileAtomic(statePath(paths), `${JSON.stringify({ schemaVersion: 1, samples }, null, 2)}\n`);
  return storageGovernorStatus(paths);
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
