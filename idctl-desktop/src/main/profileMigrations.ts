import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const PROFILE_SCHEMA_VERSION = 5;

export interface ProfileMigrationPaths {
  root: string;
  config: string;
  brain: string;
  manager: string;
  workspace: string;
  logs: string;
  cache: string;
}

export interface AppliedProfileMigration {
  version: number;
  id: string;
  appliedAt: string;
}

export interface ProfileMetadata {
  schemaVersion: number;
  profile: string;
  createdAt: string;
  updatedAt: string;
  migratedFrom: string | null;
  appliedMigrations: AppliedProfileMigration[];
  failedMigration?: {
    version: number;
    id: string;
    failedAt: string;
    error: string;
  };
}

interface ProfileMigration {
  version: number;
  id: string;
  apply: (paths: ProfileMigrationPaths, context: ProfileMigrationContext) => void;
}

interface ProfileMigrationContext {
  importLegacy: boolean;
  legacyConfigDir: string;
  legacyDesktopSignerVault?: string;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertProfilePath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`profile path escapes its root: ${path}`);
  }
}

function ensurePrivateDirectory(path: string): void {
  const current = lstatIfPresent(path);
  if (current?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${path}`);
  if (current && !current.isDirectory()) throw new Error(`profile state path is not a directory: ${path}`);
  if (!current) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateFileMode(mode: number): number {
  return mode & 0o100 ? 0o700 : 0o600;
}

function validatePrivateTree(path: string): void {
  const entry = lstatIfPresent(path);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${path}`);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) validatePrivateTree(join(path, child));
    return;
  }
  if (!entry.isFile()) throw new Error(`refusing unsupported file type in profile state: ${path}`);
}

function tightenPrivateTree(path: string): void {
  const entry = lstatIfPresent(path);
  if (!entry) return;
  if (entry.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) tightenPrivateTree(join(path, child));
    return;
  }
  chmodSync(path, privateFileMode(entry.mode));
}

function validateAndTightenPrivateTree(path: string): void {
  validatePrivateTree(path);
  tightenPrivateTree(path);
}

function atomicWriteJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const existing = lstatIfPresent(path);
  if (existing?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${path}`);
  if (existing && !existing.isFile()) throw new Error(`profile state path is not a regular file: ${path}`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function copyEntry(source: string, destination: string, merge: boolean): void {
  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry) return;
  if (sourceEntry.isSymbolicLink()) throw new Error(`refusing symbolic link in legacy profile data: ${source}`);
  const destinationEntry = lstatIfPresent(destination);
  if (destinationEntry?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${destination}`);
  if (destinationEntry && !merge) return;

  if (sourceEntry.isDirectory()) {
    if (destinationEntry && !destinationEntry.isDirectory()) {
      throw new Error(`cannot merge a legacy directory into profile file: ${destination}`);
    }
    if (!destinationEntry) {
      ensurePrivateDirectory(dirname(destination));
      mkdirSync(destination, { mode: 0o700 });
    }
    chmodSync(destination, 0o700);
    for (const child of readdirSync(source)) {
      copyEntry(join(source, child), join(destination, child), true);
    }
    return;
  }
  if (!sourceEntry.isFile()) throw new Error(`refusing unsupported legacy profile entry: ${source}`);
  if (destinationEntry) {
    if (!destinationEntry.isFile()) throw new Error(`cannot merge a legacy file into profile directory: ${destination}`);
    return;
  }
  ensurePrivateDirectory(dirname(destination));
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, privateFileMode(sourceEntry.mode));
}

function copyIfAbsent(source: string, destination: string): void {
  copyEntry(source, destination, false);
}

function copyRegularFileIfAbsent(source: string, destination: string): void {
  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry) return;
  if (sourceEntry.isSymbolicLink()) throw new Error(`refusing symbolic link in legacy profile data: ${source}`);
  if (!sourceEntry.isFile()) throw new Error(`legacy profile entry must be a regular file: ${source}`);
  const destinationEntry = lstatIfPresent(destination);
  if (destinationEntry?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${destination}`);
  if (destinationEntry) {
    if (!destinationEntry.isFile()) throw new Error(`profile state path must be a regular file: ${destination}`);
    return;
  }
  ensurePrivateDirectory(dirname(destination));
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, privateFileMode(sourceEntry.mode));
}

function mergeMissing(source: string, destination: string): void {
  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry) return;
  if (sourceEntry.isSymbolicLink()) throw new Error(`refusing symbolic link in legacy profile data: ${source}`);
  if (!sourceEntry.isDirectory()) throw new Error(`legacy profile entry must be a directory: ${source}`);
  copyEntry(source, destination, true);
}

function tightenKnownPermissions(paths: ProfileMigrationPaths): void {
  for (const directory of [
    dirname(paths.config),
    paths.brain,
    paths.manager,
    paths.logs,
    paths.cache,
    join(paths.root, 'computeruse'),
    join(paths.root, 'onboarding'),
  ]) {
    validateAndTightenPrivateTree(directory);
  }
  for (const file of [
    join(paths.root, 'profile.json'),
  ]) {
    validateAndTightenPrivateTree(file);
  }
  ensurePrivateDirectory(paths.root);
  // A workspace may contain user repositories with deliberate symlinks and
  // public/executable modes. Protect its root without rewriting its contents.
  ensurePrivateDirectory(paths.workspace);
}

const MIGRATIONS: ProfileMigration[] = [
  {
    version: 1,
    id: 'import-legacy-idctl-profile',
    apply(paths, context) {
      if (!context.importLegacy) return;
      const legacy = context.legacyConfigDir;
      copyRegularFileIfAbsent(join(legacy, 'config.json'), paths.config);
      for (const name of ['goals', 'plans', 'chats', 'dreams', 'loops', 'learn', 'questions', 'work']) {
        copyIfAbsent(join(legacy, name), join(dirname(paths.config), name));
      }
      // Live Safe/Zodiac state is intentionally not imported automatically:
      // legacy files are not bound to a reviewed profile root identity. They
      // stay in place as an explicit, operator-reviewed import source.
      for (const name of ['keys-mock.json', 'agent-signers.json']) {
        copyRegularFileIfAbsent(join(legacy, name), join(dirname(paths.config), name));
      }
    },
  },
  {
    version: 2,
    id: 'relocate-context-budget-to-cache',
    apply(paths, context) {
      // Copy rather than delete. The former location is a rollback-safe backup
      // and is ignored by new builds after this migration.
      if (context.importLegacy) {
        mergeMissing(join(context.legacyConfigDir, 'context-budget'), join(paths.cache, 'context-budget'));
      }
      mergeMissing(join(dirname(paths.config), 'context-budget'), join(paths.cache, 'context-budget'));
    },
  },
  {
    version: 3,
    id: 'tighten-profile-permissions',
    apply(paths) {
      tightenKnownPermissions(paths);
    },
  },
  {
    version: 4,
    id: 'relocate-computer-use-state',
    apply(paths, context) {
      // Computer Use bearer tokens and audit history are profile data. Copy
      // legacy state forward and leave the source as a rollback-safe backup.
      if (context.importLegacy) {
        mergeMissing(join(context.legacyConfigDir, 'computeruse'), join(paths.root, 'computeruse'));
      }
      tightenKnownPermissions(paths);
    },
  },
  {
    version: 5,
    id: 'harden-profile-tree-and-import-desktop-signer',
    apply(paths, context) {
      // The former desktop signer vault was app-global. Import it once into the
      // default profile only; named/explicit profiles must start isolated.
      if (context.importLegacy && context.legacyDesktopSignerVault) {
        const signerParent = lstatIfPresent(dirname(context.legacyDesktopSignerVault));
        if (signerParent?.isSymbolicLink()) {
          throw new Error(`refusing symbolic link in legacy signer path: ${dirname(context.legacyDesktopSignerVault)}`);
        }
        if (signerParent && !signerParent.isDirectory()) {
          throw new Error(`legacy signer parent is not a directory: ${dirname(context.legacyDesktopSignerVault)}`);
        }
        copyRegularFileIfAbsent(
          context.legacyDesktopSignerVault,
          join(dirname(paths.config), 'agent-signers.json'),
        );
      }
      tightenKnownPermissions(paths);
    },
  },
];

function normalizeMetadata(raw: unknown, profileName: string, migratedFrom: string | null): ProfileMetadata {
  if (!raw || typeof raw !== 'object') throw new Error('profile metadata must be a JSON object');
  const input = raw as Partial<ProfileMetadata>;
  const schemaVersion = Number(input.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error('profile metadata has an invalid schemaVersion');
  }
  const createdAt = typeof input.createdAt === 'string' && input.createdAt
    ? input.createdAt
    : new Date().toISOString();
  const migrations = Array.isArray(input.appliedMigrations)
    ? input.appliedMigrations.filter((entry): entry is AppliedProfileMigration => Boolean(
      entry
      && Number.isInteger(entry.version)
      && entry.version > 0
      && typeof entry.id === 'string'
      && typeof entry.appliedAt === 'string',
    ))
    : [];
  return {
    schemaVersion,
    profile: typeof input.profile === 'string' && input.profile ? input.profile : profileName,
    createdAt,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : createdAt,
    migratedFrom: typeof input.migratedFrom === 'string' ? input.migratedFrom : migratedFrom,
    appliedMigrations: migrations,
    ...(input.failedMigration ? { failedMigration: input.failedMigration } : {}),
  };
}

/**
 * Apply every missing migration in order. Each successful step is committed to
 * profile.json atomically, so a crash resumes at the first incomplete step.
 * Migrations are copy-only/idempotent and retain legacy data for rollback.
 */
export function migrateAppProfile(
  paths: ProfileMigrationPaths,
  options: {
    profileName?: string;
    legacyConfigDir: string;
    legacyDesktopSignerVault?: string;
    allowLegacyImport?: boolean;
  },
): ProfileMetadata {
  const profileName = options.profileName?.trim() || 'default';
  const importLegacy = profileName === 'default' && options.allowLegacyImport !== false;
  const context: ProfileMigrationContext = {
    importLegacy,
    legacyConfigDir: options.legacyConfigDir,
    legacyDesktopSignerVault: options.legacyDesktopSignerVault,
  };
  const marker = join(paths.root, 'profile.json');
  ensurePrivateDirectory(paths.root);
  for (const path of [
    paths.config,
    dirname(paths.config),
    paths.brain,
    paths.manager,
    paths.workspace,
    paths.logs,
    paths.cache,
  ]) {
    assertProfilePath(paths.root, path);
  }
  for (const directory of [
    dirname(paths.config),
    paths.brain,
    paths.manager,
    paths.workspace,
    paths.logs,
    paths.cache,
  ]) {
    ensurePrivateDirectory(directory);
  }

  const legacyEntry = importLegacy ? lstatIfPresent(options.legacyConfigDir) : null;
  if (legacyEntry?.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link legacy profile root: ${options.legacyConfigDir}`);
  }
  if (legacyEntry && !legacyEntry.isDirectory()) {
    throw new Error(`legacy profile root is not a directory: ${options.legacyConfigDir}`);
  }
  const migratedFrom = legacyEntry ? options.legacyConfigDir : null;
  let metadata: ProfileMetadata;
  const markerEntry = lstatIfPresent(marker);
  if (markerEntry?.isSymbolicLink()) {
    throw new Error(`Cannot safely open IDACC profile metadata at ${marker}: symbolic links are not allowed`);
  }
  if (markerEntry && !markerEntry.isFile()) {
    throw new Error(`Cannot safely open IDACC profile metadata at ${marker}: metadata is not a regular file`);
  }
  if (markerEntry) {
    try {
      metadata = normalizeMetadata(JSON.parse(readFileSync(marker, 'utf8')), profileName, migratedFrom);
    } catch (error) {
      throw new Error(`Cannot safely open IDACC profile metadata at ${marker}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  } else {
    const now = new Date().toISOString();
    metadata = {
      schemaVersion: 0,
      profile: profileName,
      createdAt: now,
      updatedAt: now,
      migratedFrom,
      appliedMigrations: [],
    };
    atomicWriteJson(marker, metadata);
  }

  if (metadata.schemaVersion > PROFILE_SCHEMA_VERSION) {
    throw new Error('This IDACC profile was created by a newer application version.');
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= metadata.schemaVersion) continue;
    try {
      migration.apply(paths, context);
      const now = new Date().toISOString();
      metadata = {
        ...metadata,
        schemaVersion: migration.version,
        updatedAt: now,
        appliedMigrations: [
          ...metadata.appliedMigrations.filter((entry) => entry.version !== migration.version),
          { version: migration.version, id: migration.id, appliedAt: now },
        ],
      };
      delete metadata.failedMigration;
      atomicWriteJson(marker, metadata);
    } catch (error) {
      metadata.failedMigration = {
        version: migration.version,
        id: migration.id,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      metadata.updatedAt = metadata.failedMigration.failedAt;
      atomicWriteJson(marker, metadata);
      throw new Error(`IDACC profile migration ${migration.version} (${migration.id}) failed: ${metadata.failedMigration.error}`);
    }
  }

  tightenKnownPermissions(paths);
  return metadata;
}
