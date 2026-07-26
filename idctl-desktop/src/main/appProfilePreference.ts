import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { normalizeAppProfileName } from './appProfileSelection.ts';

export type AppProfilePreference =
  | { profile: string; dataDir?: never }
  | { dataDir: string; profile?: never };

export interface ExplicitProfileDataDirValidationOptions {
  allowMissing?: boolean;
  protectedRoots?: string[];
  protectedTrees?: string[];
}

const PREFERENCE_FILE = 'active-profile.json';
const PREFERENCE_LIMIT_BYTES = 64 * 1024;
const PROFILE_MARKER_LIMIT_BYTES = 1024 * 1024;

function preferencePath(userDataRoot: string): string {
  return join(userDataRoot, PREFERENCE_FILE);
}

function normalizedPreference(value: unknown): AppProfilePreference | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { profile?: unknown; dataDir?: unknown };
  if (typeof input.dataDir === 'string' && input.dataDir.trim()) {
    const dataDir = input.dataDir.trim();
    return isAbsolute(dataDir) ? { dataDir } : null;
  }
  if (typeof input.profile === 'string') {
    try {
      return { profile: normalizeAppProfileName(input.profile) };
    } catch {
      return null;
    }
  }
  return null;
}

function preferenceReadError(cause?: unknown): Error {
  const error = new Error('The saved IDACC profile selection could not be read safely.');
  const systemCode = cause && typeof cause === 'object'
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
  if (typeof systemCode === 'string') {
    (error as NodeJS.ErrnoException).code = systemCode;
  }
  return error;
}

/**
 * The active-profile pointer is an application preference, not profile data.
 * A missing pointer means the default profile. Every other pointer failure is
 * surfaced to the native startup recovery UI instead of silently opening a
 * different profile and making the user's data appear to have disappeared.
 */
export function readAppProfilePreference(userDataRoot: string): AppProfilePreference | null {
  const path = preferencePath(userDataRoot);
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw preferenceReadError(error);
  }
  if (
    !entry.isFile()
    || entry.isSymbolicLink()
    || entry.nlink !== 1
    || entry.size > PREFERENCE_LIMIT_BYTES
  ) {
    throw preferenceReadError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw preferenceReadError(error);
  }
  const preference = normalizedPreference(parsed);
  if (!preference) {
    throw preferenceReadError();
  }
  return preference;
}

/**
 * Environment overrides are authoritative for the current launch. In
 * particular, recovery writes the override before persisting the preference;
 * if persistence fails, retry must not be trapped by the same corrupt pointer.
 */
export function readAppProfilePreferenceForSelection(
  userDataRoot: string,
  overrides: { dataDir?: string; profile?: string },
): AppProfilePreference | null {
  if (overrides.dataDir?.trim() || overrides.profile?.trim()) return null;
  return readAppProfilePreference(userDataRoot);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let cursor = absolute;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(cursor), ...missingSegments);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrAncestor(candidate: string, protectedPath: string): boolean {
  const rel = relative(candidate, protectedPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function validProfileMarker(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.nlink !== 1
      || entry.size > PROFILE_MARKER_LIMIT_BYTES
    ) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion?: unknown;
      profile?: unknown;
      appliedMigrations?: unknown;
    };
    if (
      !parsed
      || typeof parsed !== 'object'
      || !Number.isInteger(parsed.schemaVersion)
      || Number(parsed.schemaVersion) < 0
      || typeof parsed.profile !== 'string'
      || !parsed.profile.trim()
      || !Array.isArray(parsed.appliedMigrations)
    ) {
      return false;
    }
    return parsed.appliedMigrations.every((migration) => {
      if (!migration || typeof migration !== 'object') return false;
      const row = migration as { version?: unknown; id?: unknown; appliedAt?: unknown };
      return Number.isInteger(row.version)
        && Number(row.version) > 0
        && typeof row.id === 'string'
        && Boolean(row.id)
        && typeof row.appliedAt === 'string'
        && Boolean(row.appliedAt);
    });
  } catch {
    return false;
  }
}

/**
 * Resolve a user-selected recovery folder without allowing an ordinary broad
 * directory to be repurposed as profile state. Profile migration tightens
 * permissions below its root, so only an empty directory or a directory with
 * an authentic-looking IDACC profile marker is safe to hand to it.
 */
export function validateExplicitProfileDataDir(
  selectedPath: string,
  userDataRoot: string,
  options: ExplicitProfileDataDirValidationOptions = {},
): string {
  if (!isAbsolute(selectedPath)) {
    throw new Error('Choose an absolute IDACC profile folder.');
  }

  let entry = null;
  try {
    entry = lstatSync(selectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('The selected profile folder is unavailable.');
    }
  }
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('The selected profile folder must be a regular directory.');
  }

  const selected = canonicalPath(selectedPath);
  if (relative(parse(selected).root, selected) === '') {
    throw new Error('A filesystem root cannot be used as an IDACC profile.');
  }
  const protectedPaths = [
    userDataRoot,
    join(userDataRoot, 'profiles'),
    ...(options.protectedRoots || []),
  ]
    .filter((path): path is string => Boolean(path && isAbsolute(path)))
    .map(canonicalPath);
  if (protectedPaths.some((path) => isSameOrAncestor(selected, path))) {
    throw new Error('Choose a dedicated folder rather than a broad application or user-data folder.');
  }
  const protectedTrees = (options.protectedTrees || [])
    .filter((path): path is string => Boolean(path && isAbsolute(path)))
    .map(canonicalPath);
  if (protectedTrees.some((path) => (
    isSameOrAncestor(selected, path) || isSameOrAncestor(path, selected)
  ))) {
    throw new Error('Choose a dedicated folder outside the installed application.');
  }

  if (!entry) {
    if (options.allowMissing) return selected;
    throw new Error('The selected profile folder is unavailable.');
  }

  let children: string[];
  try {
    children = readdirSync(selected);
  } catch {
    throw new Error('The selected profile folder could not be inspected safely.');
  }
  if (children.length === 0) return selected;
  if (!validProfileMarker(join(selected, 'profile.json'))) {
    throw new Error('Choose an empty folder or an existing IDACC profile folder.');
  }
  return selected;
}

export function validateRecoveryProfileFolder(
  selectedPath: string,
  userDataRoot: string,
  protectedRoots: string[] = [],
  protectedTrees: string[] = [],
): string {
  return validateExplicitProfileDataDir(selectedPath, userDataRoot, {
    allowMissing: false,
    protectedRoots,
    protectedTrees,
  });
}

export function writeAppProfilePreference(
  userDataRoot: string,
  preference: AppProfilePreference,
): AppProfilePreference {
  const normalized = normalizedPreference(preference);
  if (!normalized) throw new Error('The selected IDACC profile preference is invalid.');
  mkdirSync(userDataRoot, { recursive: true, mode: 0o700 });
  const path = preferencePath(userDataRoot);
  try {
    const existing = lstatSync(path);
    if (
      existing.isSymbolicLink()
      || !existing.isFile()
      || existing.nlink !== 1
    ) {
      throw new Error('The IDACC profile preference path is unsafe.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    version: 1,
    ...normalized,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return normalized;
}
