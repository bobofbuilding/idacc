import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import { secureWindowsProfileRoot } from './profilePrivacy.ts';
import { copyFilePrivateSync } from './privateFileCopy.ts';
import { CONTEXT_BUDGET_RETENTION } from './contextBudgetRetention.ts';
import {
  assertSafeMacProfileAncestorAcl,
  removeAndVerifyMacAcl,
} from './macFilePrivacy.ts';
import {
  assertPrivateDirectoryMode,
  assertPrivateFileMode,
  isTrustedPrivatePathOwner,
} from './posixFilePrivacy.ts';

export const PROFILE_SCHEMA_VERSION = 7;
const PROFILE_MARKER_COMPATIBILITY_LIMIT_BYTES = 1024 * 1024;

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
  legacyManagerDir?: string;
  legacyBrainDatabases?: string[];
  legacyDesktopSignerVault?: string;
}

const MANAGER_DATABASE_NAME = 'id-agents.db';
const MANAGER_USER_DATA_TABLES = [
  'agents',
  'tasks',
  'queries',
  'news_items',
  'subscriptions',
  'wallets',
] as const;
const BRAIN_CONTENT_TABLES = [
  'facts',
  'entities',
  'text_units',
  'agent_memories',
  'memory_events',
  'timeline',
  'skill_nodes',
  'learning_tasks',
] as const;

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function profileCompatibilityError(): Error {
  return new Error(
    'Cannot safely open IDACC profile metadata before compatibility verification.',
  );
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * profile.json is the only object read before privacy conversion. This bounded,
 * link-safe compatibility preflight prevents an older build from changing a
 * newer profile. Windows repeats the check with native reparse/link inspection
 * inside the ACL helper immediately before any security descriptor mutation.
 */
function assertCompatibleProfileBeforeMutation(root: string): void {
  const rootEntry = lstatIfPresent(root);
  if (!rootEntry) return;
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw profileCompatibilityError();
  }

  const marker = join(root, 'profile.json');
  const markerEntry = lstatIfPresent(marker);
  if (!markerEntry) return;
  if (
    markerEntry.isSymbolicLink()
    || !markerEntry.isFile()
    || markerEntry.nlink !== 1
    || markerEntry.size > PROFILE_MARKER_COMPATIBILITY_LIMIT_BYTES
  ) {
    throw profileCompatibilityError();
  }

  let descriptor: number;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(marker, constants.O_RDONLY | noFollow);
  } catch {
    throw profileCompatibilityError();
  }

  let parsed: unknown;
  try {
    const opened = fstatSync(descriptor);
    if (!sameFileSnapshot(markerEntry, opened) || opened.nlink !== 1) {
      throw profileCompatibilityError();
    }
    const bytes = Buffer.alloc(PROFILE_MARKER_COMPATIBILITY_LIMIT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    const afterRead = fstatSync(descriptor);
    if (
      length > PROFILE_MARKER_COMPATIBILITY_LIMIT_BYTES
      || length !== afterRead.size
      || !sameFileSnapshot(opened, afterRead)
      || afterRead.nlink !== 1
    ) {
      throw profileCompatibilityError();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    parsed = JSON.parse(text);
  } catch {
    throw profileCompatibilityError();
  } finally {
    closeSync(descriptor);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw profileCompatibilityError();
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (
    typeof schemaVersion !== 'number'
    || !Number.isInteger(schemaVersion)
    || schemaVersion < 0
  ) {
    throw profileCompatibilityError();
  }
  if (schemaVersion > PROFILE_SCHEMA_VERSION) {
    throw new Error('This IDACC profile was created by a newer application version.');
  }
}

function assertProfilePath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`profile path escapes its root: ${path}`);
  }
}

function assertSafePosixProfileAncestors(root: string): void {
  if (process.platform === 'win32') return;
  const absolute = resolve(root);
  const filesystemRoot = parse(absolute).root;
  if (absolute === filesystemRoot) {
    throw new Error('profile root cannot be the filesystem root');
  }
  const components = relative(filesystemRoot, absolute)
    .split(sep)
    .filter(Boolean);
  const existingDirectories = [filesystemRoot];
  let cursor = filesystemRoot;
  let childIsMissing = false;
  for (
    let componentIndex = 0;
    componentIndex < components.length;
    componentIndex += 1
  ) {
    const component = components[componentIndex];
    cursor = join(cursor, component);
    try {
      const entry = lstatSync(cursor);
      const isTarget = componentIndex === components.length - 1;
      const trustedSystemLink = (
        entry.isSymbolicLink()
        && !isTarget
        && entry.uid === 0
        && dirname(cursor) === filesystemRoot
      );
      if ((!trustedSystemLink && entry.isSymbolicLink()) || (
        !trustedSystemLink && !entry.isDirectory()
      )) {
        throw new Error('profile ancestor is not a regular directory');
      }
      existingDirectories.push(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      childIsMissing = true;
      break;
    }
  }

  // Root-owned aliases such as macOS /var -> /private/var are immutable to
  // unprivileged users, but their actual target ancestry still needs the same
  // replaceability and ACL checks. Resolve only after every lexical component
  // has rejected user-owned links.
  const canonicalExisting = realpathSync.native(existingDirectories.at(-1)!);
  const canonicalFilesystemRoot = parse(canonicalExisting).root;
  const canonicalDirectories = [canonicalFilesystemRoot];
  let canonicalCursor = canonicalFilesystemRoot;
  for (const component of relative(
    canonicalFilesystemRoot,
    canonicalExisting,
  ).split(sep).filter(Boolean)) {
    canonicalCursor = join(canonicalCursor, component);
    const entry = lstatSync(canonicalCursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('profile ancestor is not a regular directory');
    }
    canonicalDirectories.push(canonicalCursor);
  }

  // If the complete root exists it is verified and hardened as profile state,
  // not as an ancestor. Otherwise the deepest existing directory is the
  // creation boundary and sticky world-writable parents are insufficient.
  const ancestors = childIsMissing
    ? canonicalDirectories
    : canonicalDirectories.slice(0, -1);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    const entry = lstatSync(ancestor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('profile ancestor is not a regular directory');
    }
    if (!isTrustedPrivatePathOwner(entry.uid)) {
      throw new Error('profile ancestor owner is not trusted');
    }
    const writableByAnotherPrincipal = (entry.mode & 0o022) !== 0;
    const sticky = (entry.mode & 0o1000) !== 0;
    const isCreationBoundary = childIsMissing && index === ancestors.length - 1;
    if (writableByAnotherPrincipal && (!sticky || isCreationBoundary)) {
      throw new Error('profile parent can be replaced by another local user');
    }
    if (writableByAnotherPrincipal && sticky) {
      const traversedChild = canonicalDirectories[index + 1];
      const childEntry = traversedChild
        ? lstatSync(traversedChild)
        : null;
      if (
        !childEntry
        || childEntry.isSymbolicLink()
        || !childEntry.isDirectory()
        || !isTrustedPrivatePathOwner(childEntry.uid)
      ) {
        throw new Error('profile parent can be replaced by another local user');
      }
    }
    assertSafeMacProfileAncestorAcl(ancestor);
  }
}

function ensurePrivateDirectory(path: string): void {
  const current = lstatIfPresent(path);
  if (current?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${path}`);
  if (current && !current.isDirectory()) throw new Error(`profile state path is not a directory: ${path}`);
  if (!current) mkdirSync(path, { recursive: true, mode: 0o700 });
  removeAndVerifyMacAcl(path);
  chmodSync(path, 0o700);
  assertPrivateDirectoryMode(path, current || undefined);
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
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error(`refusing unsupported file type in profile state: ${path}`);
  }
}

function tightenPrivateTree(path: string): void {
  const entry = lstatIfPresent(path);
  if (!entry) return;
  if (entry.isDirectory()) {
    chmodSync(path, 0o700);
    assertPrivateDirectoryMode(path, entry);
    for (const child of readdirSync(path)) tightenPrivateTree(join(path, child));
    return;
  }
  const mode = privateFileMode(entry.mode);
  chmodSync(path, mode);
  assertPrivateFileMode(path, mode, entry);
}

function validateAndTightenPrivateTree(path: string): void {
  validatePrivateTree(path);
  if (lstatIfPresent(path)) removeAndVerifyMacAcl(path, true);
  tightenPrivateTree(path);
}

function validateAndTightenPrivateTreeWithOpaqueDirectories(
  path: string,
  opaqueDirectoryNames: ReadonlySet<string>,
): void {
  const entry = lstatIfPresent(path);
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`profile state path is not a directory: ${path}`);
  }

  const children = readdirSync(path);
  // Validate every app-owned descendant before changing any mode or ACL. The
  // explicitly opaque roots are still required to be real private directories,
  // but their Manager-created runtime links are deliberately not traversed.
  for (const child of children) {
    const childPath = join(path, child);
    if (opaqueDirectoryNames.has(child)) {
      const childEntry = lstatSync(childPath);
      if (childEntry.isSymbolicLink() || !childEntry.isDirectory()) {
        throw new Error(`profile state path is not a directory: ${childPath}`);
      }
      continue;
    }
    validatePrivateTree(childPath);
  }

  removeAndVerifyMacAcl(path);
  chmodSync(path, 0o700);
  assertPrivateDirectoryMode(path, entry);
  for (const child of children) {
    const childPath = join(path, child);
    if (opaqueDirectoryNames.has(child)) {
      ensurePrivateDirectory(childPath);
    } else {
      validateAndTightenPrivateTree(childPath);
    }
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const existing = lstatIfPresent(path);
  if (existing?.isSymbolicLink()) throw new Error(`refusing symbolic link in profile state: ${path}`);
  if (existing && !existing.isFile()) throw new Error(`profile state path is not a regular file: ${path}`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  removeAndVerifyMacAcl(path);
  chmodSync(path, 0o600);
  assertPrivateFileMode(path);
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
    ensurePrivateDirectory(dirname(destination));
    ensurePrivateDirectory(destination);
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
  copyFilePrivateSync(source, destination, {
    mode: privateFileMode(sourceEntry.mode),
  });
}

/**
 * Publish a legacy directory only after its complete private copy is ready.
 *
 * The reserved sibling is never consumed by profile stores. A crash can leave
 * it incomplete, so the next schema-0 retry validates and removes only that
 * exact migration-owned tree, rebuilds it, and atomically renames it into
 * place. If the real destination already exists, it remains wholly
 * authoritative and receives no legacy children.
 */
function copyDirectoryIfAbsent(
  source: string,
  destination: string,
  migrationId: string,
): void {
  const sourceEntry = lstatIfPresent(source);
  if (sourceEntry?.isSymbolicLink()) {
    throw new Error(`refusing symbolic link in legacy profile data: ${source}`);
  }
  const destinationEntry = lstatIfPresent(destination);
  if (destinationEntry?.isSymbolicLink()) {
    throw new Error(`refusing symbolic link in profile state: ${destination}`);
  }
  const staging = join(
    dirname(destination),
    `.${basename(destination)}.${migrationId}.staging`,
  );
  const stagingEntry = lstatIfPresent(staging);
  if (stagingEntry?.isSymbolicLink()) {
    throw new Error(`refusing symbolic link in profile migration staging: ${staging}`);
  }
  if (stagingEntry && !stagingEntry.isDirectory()) {
    throw new Error(`profile migration staging is not a directory: ${staging}`);
  }

  if (destinationEntry) {
    if (stagingEntry) {
      validateAndTightenPrivateTree(staging);
      rmSync(staging, { recursive: true, force: false });
    }
    return;
  }
  if (!sourceEntry) {
    if (stagingEntry) {
      validateAndTightenPrivateTree(staging);
      rmSync(staging, { recursive: true, force: false });
    }
    return;
  }
  if (!sourceEntry.isDirectory()) {
    throw new Error(`legacy profile entry must be a directory: ${source}`);
  }

  ensurePrivateDirectory(dirname(destination));
  if (stagingEntry) {
    validateAndTightenPrivateTree(staging);
    rmSync(staging, { recursive: true, force: false });
  }
  ensurePrivateDirectory(staging);
  copyEntry(source, staging, true);
  validateAndTightenPrivateTree(staging);
  const racedDestination = lstatIfPresent(destination);
  if (racedDestination?.isSymbolicLink()) {
    throw new Error(`refusing symbolic link in profile state: ${destination}`);
  }
  if (racedDestination) {
    // Another profile owner won the publication race. Preserve it and remove
    // only this migration's reserved staging tree.
    rmSync(staging, { recursive: true, force: false });
    return;
  }
  renameSync(staging, destination);
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
  copyFilePrivateSync(source, destination, {
    mode: privateFileMode(sourceEntry.mode),
  });
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function openCheckedSqlite(path: string): DatabaseSync | null {
  const entry = lstatIfPresent(path);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`legacy database must be a private regular file: ${path}`);
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!quickCheck || !Object.values(quickCheck).includes('ok')) {
      throw new Error(`database integrity check failed: ${path}`);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function sqliteTableRows(path: string, tables: readonly string[]): number {
  const database = openCheckedSqlite(path);
  if (!database) return 0;
  try {
    let rows = 0;
    for (const table of tables) {
      const present = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      ).get(table);
      if (!present) continue;
      const count = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
        count?: number | bigint;
      } | undefined;
      rows += Number(count?.count || 0);
    }
    return rows;
  } finally {
    database.close();
  }
}

function sqliteUserDataRows(path: string): number {
  return sqliteTableRows(path, MANAGER_USER_DATA_TABLES);
}

function sqliteBrainContentRows(path: string): number {
  return sqliteTableRows(path, BRAIN_CONTENT_TABLES);
}

function isBootstrapOnlyBrainDatabase(path: string): boolean {
  const database = openCheckedSqlite(path);
  if (!database) return true;
  try {
    for (const table of ['facts', 'entities', 'memory_events', 'timeline', 'skill_nodes', 'learning_tasks']) {
      const present = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      ).get(table);
      if (!present) continue;
      const count = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
        count?: number | bigint;
      } | undefined;
      if (Number(count?.count || 0) > 0) return false;
    }

    const memoryTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_memories' LIMIT 1",
    ).get();
    if (memoryTable) {
      const unexpected = database.prepare(`
        SELECT COUNT(*) AS count
        FROM agent_memories
        WHERE COALESCE(agent_id, '') <> 'team-instructions'
          OR COALESCE(mem_key, '') <> 'org:hierarchy'
      `).get() as { count?: number | bigint } | undefined;
      if (Number(unexpected?.count || 0) > 0) return false;
      const total = database.prepare('SELECT COUNT(*) AS count FROM agent_memories').get() as {
        count?: number | bigint;
      } | undefined;
      if (Number(total?.count || 0) > 1) return false;
    }

    const textTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'text_units' LIMIT 1",
    ).get();
    if (textTable) {
      const unexpected = database.prepare(`
        SELECT COUNT(*) AS count
        FROM text_units
        WHERE COALESCE(source_kind, '') <> 'memory'
          OR COALESCE(title, '') <> 'team-instructions:org:hierarchy'
      `).get() as { count?: number | bigint } | undefined;
      if (Number(unexpected?.count || 0) > 0) return false;
      const total = database.prepare('SELECT COUNT(*) AS count FROM text_units').get() as {
        count?: number | bigint;
      } | undefined;
      if (Number(total?.count || 0) > 1) return false;
    }
    return true;
  } finally {
    database.close();
  }
}

function sqliteSnapshot(source: string, staging: string): void {
  const sourceDatabase = openCheckedSqlite(source);
  if (!sourceDatabase) throw new Error(`legacy database is unavailable: ${source}`);
  try {
    sourceDatabase.exec(`VACUUM INTO ${sqliteString(staging)}`);
  } finally {
    sourceDatabase.close();
  }
}

function retainSqliteDestination(destination: string, rollback: string): void {
  ensurePrivateDirectory(rollback);
  for (const suffix of ['', '-wal', '-shm']) {
    const current = `${destination}${suffix}`;
    const currentEntry = lstatIfPresent(current);
    if (!currentEntry) continue;
    if (currentEntry.isSymbolicLink() || !currentEntry.isFile() || currentEntry.nlink !== 1) {
      throw new Error(`profile database state is unsafe: ${current}`);
    }
    const retained = join(rollback, `${basename(destination)}${suffix}`);
    if (lstatIfPresent(retained)) {
      throw new Error(`database rollback state already exists: ${retained}`);
    }
    renameSync(current, retained);
  }
}

/**
 * Import the pre-unified Manager database only when the app-owned database has
 * no user data. SQLite performs the snapshot so an independently running
 * legacy Manager can keep writing while this copy is taken. The source and any
 * bootstrap-only destination are retained as rollback-safe copies.
 */
function importLegacyManagerDatabase(
  paths: ProfileMigrationPaths,
  context: ProfileMigrationContext,
): void {
  if (!context.importLegacy || !context.legacyManagerDir) return;
  const legacyDirectory = context.legacyManagerDir;
  const legacyDirectoryEntry = lstatIfPresent(legacyDirectory);
  if (!legacyDirectoryEntry) return;
  if (legacyDirectoryEntry.isSymbolicLink() || !legacyDirectoryEntry.isDirectory()) {
    throw new Error(`legacy manager root must be a regular directory: ${legacyDirectory}`);
  }

  const source = join(legacyDirectory, MANAGER_DATABASE_NAME);
  const sourceRows = sqliteUserDataRows(source);
  if (sourceRows === 0) return;

  const destination = join(paths.manager, MANAGER_DATABASE_NAME);
  const destinationRows = sqliteUserDataRows(destination);
  if (destinationRows > 0) return;

  ensurePrivateDirectory(paths.manager);
  const staging = join(paths.manager, `.${MANAGER_DATABASE_NAME}.legacy-import.staging`);
  const stagingEntry = lstatIfPresent(staging);
  if (stagingEntry) {
    if (stagingEntry.isSymbolicLink() || !stagingEntry.isFile() || stagingEntry.nlink !== 1) {
      throw new Error(`legacy manager migration staging is unsafe: ${staging}`);
    }
    rmSync(staging, { force: false });
  }

  sqliteSnapshot(source, staging);
  if (sqliteUserDataRows(staging) !== sourceRows) {
    throw new Error('legacy manager snapshot row count changed during migration');
  }
  chmodSync(staging, 0o600);
  assertPrivateFileMode(staging);

  const rollback = join(paths.manager, '.pre-legacy-manager-import');
  retainSqliteDestination(destination, rollback);

  renameSync(staging, destination);
  chmodSync(destination, 0o600);
  assertPrivateFileMode(destination);
  atomicWriteJson(join(paths.manager, 'legacy-manager-import.json'), {
    version: 1,
    source,
    importedRows: sourceRows,
    importedAt: new Date().toISOString(),
    rollback,
  });
}

function importLegacyBrainDatabase(
  paths: ProfileMigrationPaths,
  context: ProfileMigrationContext,
): void {
  if (!context.importLegacy || !context.legacyBrainDatabases?.length) return;
  const destination = join(paths.brain, 'brain.db');
  if (!isBootstrapOnlyBrainDatabase(destination)) return;

  const candidates = [...new Set(context.legacyBrainDatabases.map((path) => resolve(path)))]
    .filter((path) => path !== resolve(destination))
    .map((path) => ({ path, rows: sqliteBrainContentRows(path) }))
    .filter((entry) => entry.rows > 0)
    .sort((left, right) => right.rows - left.rows || left.path.localeCompare(right.path));
  const selected = candidates[0];
  if (!selected) return;

  ensurePrivateDirectory(paths.brain);
  const staging = join(paths.brain, '.brain.db.legacy-import.staging');
  const stagingEntry = lstatIfPresent(staging);
  if (stagingEntry) {
    if (stagingEntry.isSymbolicLink() || !stagingEntry.isFile() || stagingEntry.nlink !== 1) {
      throw new Error(`legacy Brain migration staging is unsafe: ${staging}`);
    }
    rmSync(staging, { force: false });
  }
  sqliteSnapshot(selected.path, staging);
  if (sqliteBrainContentRows(staging) !== selected.rows) {
    throw new Error('legacy Brain snapshot row count changed during migration');
  }
  chmodSync(staging, 0o600);
  assertPrivateFileMode(staging);

  const rollback = join(paths.brain, '.pre-legacy-brain-import');
  retainSqliteDestination(destination, rollback);
  renameSync(staging, destination);
  chmodSync(destination, 0o600);
  assertPrivateFileMode(destination);
  atomicWriteJson(join(paths.brain, 'legacy-brain-import.json'), {
    version: 1,
    source: selected.path,
    importedRows: selected.rows,
    importedAt: new Date().toISOString(),
    rollback,
  });
}

function mergeMissing(source: string, destination: string): void {
  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry) return;
  if (sourceEntry.isSymbolicLink()) throw new Error(`refusing symbolic link in legacy profile data: ${source}`);
  if (!sourceEntry.isDirectory()) throw new Error(`legacy profile entry must be a directory: ${source}`);
  copyEntry(source, destination, true);
}

function contextBudgetRecordEntries(
  directory: string,
): Array<{ name: string; path: string; mtime: number; bytes: number }> {
  return readdirSync(directory)
    .filter((name) => /^cb_.*\.json$/.test(name))
    .map((name) => {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`refusing unsupported context-budget cache entry: ${path}`);
      }
      return {
        name,
        path,
        mtime: entry.mtimeMs,
        bytes: entry.size,
      };
    })
    .sort((left, right) => right.mtime - left.mtime);
}

function mergeBoundedContextBudgetCache(
  source: string,
  destination: string,
  now = Date.now(),
): void {
  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry) return;
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) {
    throw new Error(`legacy context-budget cache must be a regular directory: ${source}`);
  }
  ensurePrivateDirectory(destination);
  copyRegularFileIfAbsent(join(source, 'stats.json'), join(destination, 'stats.json'));

  const cutoff = now
    - CONTEXT_BUDGET_RETENTION.auditDays * 24 * 60 * 60 * 1_000;
  let kept = 0;
  let bytes = 0;
  for (const entry of contextBudgetRecordEntries(source)) {
    const withinBounds = entry.mtime >= cutoff
      && kept < CONTEXT_BUDGET_RETENTION.maxAuditRecords
      && bytes + entry.bytes <= CONTEXT_BUDGET_RETENTION.maxAuditBytes;
    if (!withinBounds) continue;
    copyRegularFileIfAbsent(entry.path, join(destination, entry.name));
    kept += 1;
    bytes += entry.bytes;
  }
}

function pruneContextBudgetMigrationCache(
  directory: string,
  now = Date.now(),
): void {
  const entry = lstatIfPresent(directory);
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`profile context-budget cache must be a regular directory: ${directory}`);
  }
  const cutoff = now
    - CONTEXT_BUDGET_RETENTION.auditDays * 24 * 60 * 60 * 1_000;
  let kept = 0;
  let bytes = 0;
  for (const record of contextBudgetRecordEntries(directory)) {
    const withinBounds = record.mtime >= cutoff
      && kept < CONTEXT_BUDGET_RETENTION.maxAuditRecords
      && bytes + record.bytes <= CONTEXT_BUDGET_RETENTION.maxAuditBytes;
    if (withinBounds) {
      kept += 1;
      bytes += record.bytes;
    } else {
      rmSync(record.path, { force: true });
    }
  }
}

function tightenKnownPermissions(paths: ProfileMigrationPaths): void {
  for (const directory of [
    dirname(paths.config),
    paths.brain,
    paths.logs,
    paths.cache,
    join(paths.root, 'computeruse'),
    join(paths.root, 'onboarding'),
  ]) {
    validateAndTightenPrivateTree(directory);
  }
  // Codex overlays are Manager-owned runtime material. They intentionally
  // contain links to session directories and executable shims, so protect the
  // overlay boundary without following or rewriting its contents. Every other
  // Manager descendant (including its database) remains recursively strict.
  validateAndTightenPrivateTreeWithOpaqueDirectories(
    paths.manager,
    new Set(['codex-overlays']),
  );
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
        copyDirectoryIfAbsent(
          join(legacy, name),
          join(dirname(paths.config), name),
          'import-legacy-idctl-profile',
        );
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
      const destination = join(paths.cache, 'context-budget');
      const now = Date.now();
      if (context.importLegacy) {
        mergeBoundedContextBudgetCache(
          join(context.legacyConfigDir, 'context-budget'),
          destination,
          now,
        );
      }
      mergeBoundedContextBudgetCache(
        join(dirname(paths.config), 'context-budget'),
        destination,
        now,
      );
      pruneContextBudgetMigrationCache(destination, now);
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
  {
    version: 6,
    id: 'import-legacy-manager-database',
    apply(paths, context) {
      importLegacyManagerDatabase(paths, context);
      tightenKnownPermissions(paths);
    },
  },
  {
    version: 7,
    id: 'import-legacy-brain-database',
    apply(paths, context) {
      importLegacyBrainDatabase(paths, context);
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
    legacyManagerDir?: string;
    legacyBrainDatabases?: string[];
    legacyDesktopSignerVault?: string;
    allowLegacyImport?: boolean;
  },
): ProfileMetadata {
  assertCompatibleProfileBeforeMutation(paths.root);
  assertSafePosixProfileAncestors(paths.root);
  // Windows does not implement owner/group/other isolation through chmod.
  // After the bounded compatibility-only marker preflight above, establish and
  // verify the real recursive DACL before every other profile-state access.
  // This also runs on every initialization, not only creation.
  secureWindowsProfileRoot(paths.root, {
    maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
  });
  const profileName = options.profileName?.trim() || 'default';
  const importLegacy = profileName === 'default' && options.allowLegacyImport !== false;
  const context: ProfileMigrationContext = {
    importLegacy,
    legacyConfigDir: options.legacyConfigDir,
    legacyManagerDir: options.legacyManagerDir,
    legacyBrainDatabases: options.legacyBrainDatabases,
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
    // Establish the versioned Windows proof while the new profile is still
    // small. Later imports create fresh children beneath exact private,
    // inheritable parent DACLs and therefore cannot exceed the transactional
    // first-attestation traversal on the next launch.
    secureWindowsProfileRoot(paths.root, {
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
    });
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
