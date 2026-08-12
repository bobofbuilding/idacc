import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';
import { allocatedProfileBytes } from './storageGovernor.ts';

export const MIGRATION_COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000;

export interface MigrationFinalizationCandidate {
  label: string;
  path: string;
  bytes: number;
  eligibleAt: string;
  state: 'cooling-off' | 'ready-for-reviewed-retirement';
}

function candidate(paths: AppProfilePaths, label: string, path: string, now: number): MigrationFinalizationCandidate | null {
  if (!existsSync(path)) return null;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return null;
  const eligibleAt = entry.mtimeMs + MIGRATION_COOLING_OFF_MS;
  return { label, path, bytes: allocatedProfileBytes(path), eligibleAt: new Date(eligibleAt).toISOString(), state: now >= eligibleAt ? 'ready-for-reviewed-retirement' : 'cooling-off' };
}

/**
 * Migration sources remain rollback-safe during cooling-off. The existing
 * main-process recovery confirmation is the only retirement route; this module
 * merely surfaces verified candidates instead of silently deleting them.
 */
export function migrationFinalizationStatus(paths: AppProfilePaths, now = Date.now()): { coolingOffDays: number; candidates: MigrationFinalizationCandidate[]; readyCount: number; readyBytes: number } {
  const backups = join(paths.root, 'backups');
  const raw = [
    candidate(paths, 'Legacy Brain migration snapshots', join(backups, 'legacy-brain'), now),
    candidate(paths, 'Concluded migration archives', join(paths.root, 'migration-archives'), now),
    candidate(paths, 'Pre-v0.1.701 rollback snapshot', join(backups, 'pre-v0.1.701'), now),
    candidate(paths, 'Legacy Manager rollback snapshot', join(backups, 'legacy-manager'), now),
    candidate(paths, 'Pre-import Brain rollback copy', join(paths.brain, '.pre-legacy-brain-import'), now),
    candidate(paths, 'Pre-import Manager rollback copy', join(paths.manager, '.pre-legacy-manager-import'), now),
  ].filter((value): value is MigrationFinalizationCandidate => Boolean(value));
  const ready = raw.filter((value) => value.state === 'ready-for-reviewed-retirement');
  return { coolingOffDays: MIGRATION_COOLING_OFF_MS / 86_400_000, candidates: raw, readyCount: ready.length, readyBytes: ready.reduce((sum, value) => sum + value.bytes, 0) };
}
