import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';
import { allocatedProfileBytes } from './storageGovernor.ts';

export type WorkspaceDataClass = 'temporary' | 'build-cache' | 'dependency' | 'browser-runtime' | 'output' | 'upload';
const RETENTION_MS: Record<WorkspaceDataClass, number> = {
  temporary: 72 * 60 * 60 * 1000,
  'build-cache': 7 * 24 * 60 * 60 * 1000,
  dependency: 7 * 24 * 60 * 60 * 1000,
  'browser-runtime': 7 * 24 * 60 * 60 * 1000,
  output: 14 * 24 * 60 * 60 * 1000,
  upload: 14 * 24 * 60 * 60 * 1000,
};
const NAMES: Record<WorkspaceDataClass, Set<string>> = {
  temporary: new Set(['tmp', '.tmp']),
  'build-cache': new Set(['.next', '.vite', '.turbo', '.webpack', 'dist', 'build']),
  dependency: new Set(['node_modules', '.pnpm-store', '.yarn']),
  'browser-runtime': new Set(['ms-playwright', 'playwright', 'browser-cache']),
  output: new Set(['output']),
  upload: new Set(['uploads']),
};

export interface WorkspaceRetentionCandidate { path: string; dataClass: WorkspaceDataClass; bytes: number; modifiedAt: string; reviewAfter: string; eligible: boolean; }

function scan(path: string, now: number, result: WorkspaceRetentionCandidate[]): void {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) return;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const childEntry = lstatSync(child);
    if (childEntry.isSymbolicLink()) continue;
    const dataClass = (Object.keys(NAMES) as WorkspaceDataClass[]).find((kind) => NAMES[kind].has(name));
    if (dataClass) {
      const reviewAfter = childEntry.mtimeMs + RETENTION_MS[dataClass];
      result.push({ path: child, dataClass, bytes: allocatedProfileBytes(child), modifiedAt: new Date(childEntry.mtimeMs).toISOString(), reviewAfter: new Date(reviewAfter).toISOString(), eligible: now >= reviewAfter });
      continue;
    }
    if (childEntry.isDirectory()) scan(child, now, result);
  }
}

/** Inventory-only: no active workspace is deleted automatically. */
export function workspaceRetentionStatus(paths: AppProfilePaths, now = Date.now()): { policy: Record<WorkspaceDataClass, number>; candidates: WorkspaceRetentionCandidate[]; eligibleBytes: number } {
  const candidates: WorkspaceRetentionCandidate[] = [];
  scan(paths.workspace, now, candidates);
  return { policy: RETENTION_MS, candidates, eligibleBytes: candidates.filter((candidate) => candidate.eligible).reduce((sum, candidate) => sum + candidate.bytes, 0) };
}
