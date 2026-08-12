import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppProfilePaths } from './appProfile.ts';
import {
  ensurePrivateAppDirectory,
  readPrivateAppTextFile,
  writePrivateAppTextFileAtomic,
} from './appStatePrivacy.ts';
import { assertStorageReservation } from './storageGovernor.ts';

const LEGACY_SNAPSHOT_RE = /^brain-\d{8}\.db$/;
const CURRENT_BACKUP_RE = /^brain-\d{8}\.db$/;
const TEMPORARY_BACKUP_RE = /^\.brain-(\d+)-[a-f0-9]+\.db$/;
const RECOVERY_SCHEMA_VERSION = 1;
const CURRENT_BACKUPS_TO_KEEP = 3;

type SqlRow = Record<string, unknown>;

export interface HistoricalMemoryPayload {
  payloadSha256: string;
  sourceSnapshots: string[];
  agentId: string;
  memKey: string | null;
  content: string;
  tags: string;
  visibility: string;
  originalStatus: string;
  durableMetadata: string;
  sourceIds: string;
  confidence: number | null;
  project: string;
  taskId: string;
  sessionId: string;
  userId: string;
  turnId: string;
  originalExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  memoryTier: string | null;
}

interface HistoricalMemoryArchive {
  schemaVersion: number;
  operation: 'legacy-memory-history-preservation';
  profileRoot: string;
  preparedAt: string;
  completedAt?: string;
  payloadCount: number;
  payloads: HistoricalMemoryPayload[];
  importedRows?: Array<{ id: number; payloadSha256: string }>;
  verification?: {
    quickCheck: 'ok';
    verifiedRows: number;
    currentMemoryCount: number;
  };
}

export interface StorageRecoveryStatus {
  profileRoot: string;
  currentMemoryCount: number;
  historicalPayloadsFound: number;
  historicalPayloadsImported: number;
  recoveryComplete: boolean;
  legacySnapshotCount: number;
  legacyBrainBytes: number;
  cleanupBytes: number;
  cleanupTargets: Array<{ label: string; path: string; bytes: number }>;
  currentBackupsKept: number;
  currentBackupsRetired: number;
  archivePath: string;
  cleanupReceiptPath: string;
}

export interface StorageRecoveryImportResult extends StorageRecoveryStatus {
  importedNow: number;
  verifiedRows: number;
}

export interface StorageRecoveryCleanupResult extends StorageRecoveryStatus {
  removedBytes: number;
  removedTargets: Array<{ label: string; path: string; bytes: number }>;
  backupPath: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function nullableInteger(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeJsonArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function assertOrdinaryDirectory(path: string): string {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Storage recovery refused unsafe directory: ${basename(path)}`);
  }
  return realpathSync.native(path);
}

function assertContained(root: string, target: string): void {
  const canonicalRoot = assertOrdinaryDirectory(root);
  const canonicalTarget = realpathSync.native(target);
  const rel = relative(canonicalRoot, canonicalTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(canonicalRoot, rel) !== canonicalTarget) {
    throw new Error('Storage recovery target is outside the active profile.');
  }
}

function assertOrdinaryFile(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`Storage recovery refused unsafe file: ${basename(path)}`);
  }
}

function allocatedBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`Storage recovery refused symbolic link: ${basename(path)}`);
  if (entry.isFile()) return Math.max(entry.blocks * 512, entry.size);
  if (!entry.isDirectory()) return 0;
  let total = Math.max(entry.blocks * 512, 0);
  for (const name of readdirSync(path)) total += allocatedBytes(join(path, name));
  return total;
}

function databasePath(paths: AppProfilePaths): string {
  return join(paths.brain, 'brain.db');
}

function legacyBrainRoot(paths: AppProfilePaths): string {
  return join(paths.root, 'backups', 'legacy-brain');
}

function currentBackupRoot(paths: AppProfilePaths): string {
  return join(paths.root, 'backups', 'brain');
}

function recoveryRoot(paths: AppProfilePaths): string {
  return join(paths.root, 'recovery');
}

function archivePath(paths: AppProfilePaths): string {
  return join(recoveryRoot(paths), 'legacy-memory-payloads-v1.json');
}

function cleanupReceiptPath(paths: AppProfilePaths): string {
  return join(recoveryRoot(paths), 'legacy-storage-retirement-v1.json');
}

function listLegacySnapshots(paths: AppProfilePaths): string[] {
  const root = legacyBrainRoot(paths);
  if (!existsSync(root)) return [];
  assertContained(paths.root, root);
  return readdirSync(root)
    .filter((name) => LEGACY_SNAPSHOT_RE.test(name))
    .sort()
    .map((name) => {
      const path = join(root, name);
      assertOrdinaryFile(path);
      return path;
    });
}

function databaseRows(path: string, sql: string): SqlRow[] {
  assertOrdinaryFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as SqlRow[];
  } finally {
    db.close();
  }
}

function currentMemoryContentHashes(paths: AppProfilePaths): Set<string> {
  return new Set(databaseRows(databasePath(paths), 'SELECT content FROM agent_memories')
    .map((row) => sha256(stringValue(row.content))));
}

function historicalPayloads(paths: AppProfilePaths): HistoricalMemoryPayload[] {
  const currentHashes = currentMemoryContentHashes(paths);
  const payloads = new Map<string, HistoricalMemoryPayload>();
  for (const snapshot of listLegacySnapshots(paths)) {
    for (const row of databaseRows(snapshot, 'SELECT * FROM agent_memories')) {
      const content = stringValue(row.content);
      const payloadSha256 = sha256(content);
      if (currentHashes.has(payloadSha256)) continue;
      const existing = payloads.get(payloadSha256);
      if (existing) {
        if (!existing.sourceSnapshots.includes(basename(snapshot))) {
          existing.sourceSnapshots.push(basename(snapshot));
        }
        continue;
      }
      payloads.set(payloadSha256, {
        payloadSha256,
        sourceSnapshots: [basename(snapshot)],
        agentId: stringValue(row.agent_id),
        memKey: row.mem_key == null ? null : stringValue(row.mem_key),
        content,
        tags: stringValue(row.tags, '[]'),
        visibility: stringValue(row.visibility, 'private'),
        originalStatus: stringValue(row.status, 'active'),
        durableMetadata: stringValue(row.durable_metadata, '{}'),
        sourceIds: stringValue(row.source_ids, '[]'),
        confidence: nullableNumber(row.confidence),
        project: stringValue(row.project),
        taskId: stringValue(row.task_id),
        sessionId: stringValue(row.session_id),
        userId: stringValue(row.user_id),
        turnId: stringValue(row.turn_id),
        originalExpiresAt: nullableInteger(row.expires_at),
        createdAt: integer(row.created_at),
        updatedAt: integer(row.updated_at),
        memoryTier: row.memory_tier == null ? null : stringValue(row.memory_tier),
      });
    }
  }
  return [...payloads.values()].sort((left, right) => (
    left.createdAt - right.createdAt || left.payloadSha256.localeCompare(right.payloadSha256)
  ));
}

function currentMemoryCount(paths: AppProfilePaths): number {
  const rows = databaseRows(databasePath(paths), 'SELECT COUNT(*) AS count FROM agent_memories');
  return integer(rows[0]?.count);
}

function readArchive(paths: AppProfilePaths): HistoricalMemoryArchive | null {
  const path = archivePath(paths);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readPrivateAppTextFile(path, 4 * 1024 * 1024)) as HistoricalMemoryArchive;
  if (
    parsed.schemaVersion !== RECOVERY_SCHEMA_VERSION
    || parsed.operation !== 'legacy-memory-history-preservation'
    || parsed.profileRoot !== paths.root
    || !Array.isArray(parsed.payloads)
    || parsed.payloadCount !== parsed.payloads.length
  ) {
    throw new Error('Historical-memory recovery archive is invalid.');
  }
  return parsed;
}

function verifyArchiveRows(paths: AppProfilePaths, archive: HistoricalMemoryArchive): number {
  const imported = archive.importedRows ?? [];
  if (imported.length !== archive.payloadCount) return 0;
  const db = new DatabaseSync(databasePath(paths), { readOnly: true });
  try {
    const find = db.prepare('SELECT content,status,durable_metadata FROM agent_memories WHERE id=?');
    let verified = 0;
    for (const row of imported) {
      const found = find.get(row.id) as SqlRow | undefined;
      if (!found || found.status !== 'retired' || sha256(stringValue(found.content)) !== row.payloadSha256) continue;
      const metadata = safeJsonObject(stringValue(found.durable_metadata, '{}'));
      const recovery = metadata.idaccHistoricalRecovery;
      if (
        !recovery
        || typeof recovery !== 'object'
        || (recovery as Record<string, unknown>).payloadSha256 !== row.payloadSha256
      ) continue;
      verified += 1;
    }
    return verified;
  } finally {
    db.close();
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function currentBackupRetirement(paths: AppProfilePaths): { keep: string[]; retire: string[]; stale: string[] } {
  const root = currentBackupRoot(paths);
  if (!existsSync(root)) return { keep: [], retire: [], stale: [] };
  assertContained(paths.root, root);
  const daily = readdirSync(root)
    .filter((name) => CURRENT_BACKUP_RE.test(name))
    .map((name) => join(root, name))
    .filter((path) => {
      assertOrdinaryFile(path);
      return true;
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const stale = readdirSync(root).flatMap((name) => {
    const match = TEMPORARY_BACKUP_RE.exec(name);
    if (!match || processAlive(Number(match[1]))) return [];
    const path = join(root, name);
    assertOrdinaryFile(path);
    return [path];
  });
  return {
    keep: daily.slice(0, CURRENT_BACKUPS_TO_KEEP),
    retire: daily.slice(CURRENT_BACKUPS_TO_KEEP),
    stale,
  };
}

function cleanupTargets(paths: AppProfilePaths): Array<{ label: string; path: string; bytes: number }> {
  const backups = join(paths.root, 'backups');
  const candidates = [
    { label: 'Retired legacy Brain snapshots', path: legacyBrainRoot(paths) },
    { label: 'Concluded migration archives', path: join(paths.root, 'migration-archives') },
    { label: 'Pre-v0.1.701 rollback snapshot', path: join(backups, 'pre-v0.1.701') },
    { label: 'Retired legacy Manager backup', path: join(backups, 'legacy-manager') },
    { label: 'Pre-import Brain rollback copy', path: join(paths.brain, '.pre-legacy-brain-import') },
    { label: 'Pre-import Manager rollback copy', path: join(paths.manager, '.pre-legacy-manager-import') },
  ];
  const backupRetirement = currentBackupRetirement(paths);
  candidates.push(
    ...backupRetirement.retire.map((path) => ({ label: 'Old current Brain daily backup', path })),
    ...backupRetirement.stale.map((path) => ({ label: 'Abandoned temporary Brain backup', path })),
  );
  return candidates.flatMap((target) => {
    if (!existsSync(target.path)) return [];
    assertContained(paths.root, target.path);
    return [{ ...target, bytes: allocatedBytes(target.path) }];
  });
}

function assertCurrentDatabasesHealthy(paths: AppProfilePaths): void {
  for (const path of [databasePath(paths), join(paths.manager, 'id-agents.db')]) {
    assertOrdinaryFile(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const result = db.prepare('PRAGMA quick_check').get() as SqlRow;
      if (result.quick_check !== 'ok') throw new Error(`Database verification failed for ${basename(path)}.`);
    } finally {
      db.close();
    }
  }
}

function currentBackupPath(paths: AppProfilePaths): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return join(currentBackupRoot(paths), `brain-${stamp}.db`);
}

function createVerifiedCurrentBackup(paths: AppProfilePaths): string {
  const root = currentBackupRoot(paths);
  ensurePrivateAppDirectory(root);
  assertStorageReservation(paths, statSync(databasePath(paths)).size, 'Verified Brain backup');
  const destination = currentBackupPath(paths);
  const temporary = join(root, `.brain-recovery-${process.pid}-${randomBytes(8).toString('hex')}.db`);
  const source = new DatabaseSync(databasePath(paths), { readOnly: true });
  try {
    const quoted = `'${temporary.replaceAll("'", "''")}'`;
    source.exec(`VACUUM INTO ${quoted}`);
  } finally {
    source.close();
  }
  assertOrdinaryFile(temporary);
  const verification = new DatabaseSync(temporary, { readOnly: true });
  try {
    const result = verification.prepare('PRAGMA quick_check').get() as SqlRow;
    if (result.quick_check !== 'ok') throw new Error('Post-recovery Brain backup failed verification.');
  } finally {
    verification.close();
  }
  const previous = existsSync(destination) ? `${destination}.prior-${process.pid}` : null;
  try {
    if (previous) renameSync(destination, previous);
    renameSync(temporary, destination);
    if (previous) rmSync(previous, { force: true });
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    if (previous && existsSync(previous) && !existsSync(destination)) renameSync(previous, destination);
    throw error;
  }
  return destination;
}

export function storageRecoveryStatus(paths: AppProfilePaths): StorageRecoveryStatus {
  assertOrdinaryDirectory(paths.root);
  const archive = readArchive(paths);
  const verifiedRows = archive ? verifyArchiveRows(paths, archive) : 0;
  const payloads = archive?.payloads ?? historicalPayloads(paths);
  const targets = cleanupTargets(paths);
  const backups = currentBackupRetirement(paths);
  return {
    profileRoot: paths.root,
    currentMemoryCount: currentMemoryCount(paths),
    historicalPayloadsFound: payloads.length,
    historicalPayloadsImported: verifiedRows,
    recoveryComplete: Boolean(archive?.completedAt) && verifiedRows === payloads.length && payloads.length > 0,
    legacySnapshotCount: listLegacySnapshots(paths).length,
    legacyBrainBytes: allocatedBytes(legacyBrainRoot(paths)),
    cleanupBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    cleanupTargets: targets,
    currentBackupsKept: backups.keep.length,
    currentBackupsRetired: backups.retire.length,
    archivePath: archivePath(paths),
    cleanupReceiptPath: cleanupReceiptPath(paths),
  };
}

function inferredTier(payload: HistoricalMemoryPayload, replacement: SqlRow | undefined): string {
  if (payload.memoryTier) return payload.memoryTier;
  if (typeof replacement?.memory_tier === 'string' && replacement.memory_tier) return replacement.memory_tier;
  if (payload.originalExpiresAt != null) return 'short_term';
  if (/^(runtime-cooldown|completion):/.test(payload.memKey ?? '')) return 'medium_term';
  return 'long_term';
}

export function importHistoricalMemoryPayloads(
  paths: AppProfilePaths,
  confirmation: { userConfirmed?: boolean; expectedPayloads?: number },
): StorageRecoveryImportResult {
  if (!confirmation.userConfirmed) throw new Error('Historical-memory import requires explicit confirmation.');
  assertCurrentDatabasesHealthy(paths);
  let archive = readArchive(paths);
  if (!archive) {
    const payloads = historicalPayloads(paths);
    if (confirmation.expectedPayloads !== payloads.length) {
      throw new Error(`Historical-memory count changed: expected ${confirmation.expectedPayloads}, found ${payloads.length}. Review again before importing.`);
    }
    archive = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      operation: 'legacy-memory-history-preservation',
      profileRoot: paths.root,
      preparedAt: new Date().toISOString(),
      payloadCount: payloads.length,
      payloads,
    };
    ensurePrivateAppDirectory(recoveryRoot(paths));
    writePrivateAppTextFileAtomic(archivePath(paths), `${JSON.stringify(archive, null, 2)}\n`);
  } else if (confirmation.expectedPayloads !== archive.payloadCount) {
    throw new Error(`Prepared historical-memory archive contains ${archive.payloadCount} payloads, not ${confirmation.expectedPayloads}.`);
  }

  const db = new DatabaseSync(databasePath(paths));
  const importedRows: Array<{ id: number; payloadSha256: string }> = [];
  let importedNow = 0;
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const existingRecovery = db.prepare(`
      SELECT id,content,status,durable_metadata
      FROM agent_memories
      WHERE durable_metadata LIKE ?
      ORDER BY id DESC
    `);
    const replacement = db.prepare(`
      SELECT id,memory_tier FROM agent_memories
      WHERE agent_id=? AND mem_key IS ? AND status='active'
      ORDER BY updated_at DESC,id DESC LIMIT 1
    `);
    const insert = db.prepare(`
      INSERT INTO agent_memories (
        agent_id,mem_key,content,tags,visibility,status,durable_metadata,source_ids,
        confidence,project,task_id,session_id,user_id,turn_id,superseded_by,
        expires_at,last_volunteered_at,last_used_at,ignored_count,volunteered_count,
        used_count,harmful_count,created_at,updated_at,memory_tier
      ) VALUES (
        $agentId,$memKey,$content,$tags,$visibility,'retired',$durableMetadata,$sourceIds,
        $confidence,$project,$taskId,$sessionId,$userId,$turnId,$supersededBy,
        NULL,NULL,NULL,0,0,0,0,$createdAt,$updatedAt,$memoryTier
      )
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const payload of archive.payloads) {
        const candidates = existingRecovery.all(`%${payload.payloadSha256}%`) as SqlRow[];
        const found = candidates.find((row) => (
          row.status === 'retired'
          && sha256(stringValue(row.content)) === payload.payloadSha256
          && (safeJsonObject(stringValue(row.durable_metadata)).idaccHistoricalRecovery as Record<string, unknown> | undefined)?.payloadSha256 === payload.payloadSha256
        ));
        if (found) {
          importedRows.push({ id: integer(found.id), payloadSha256: payload.payloadSha256 });
          continue;
        }
        const current = replacement.get(payload.agentId, payload.memKey) as SqlRow | undefined;
        const tags = [...new Set([
          ...safeJsonArray(payload.tags).map(String),
          'historical',
          'legacy-recovery',
          'retired-version',
        ])];
        const sourceIds = [...new Set([
          ...safeJsonArray(payload.sourceIds).map(String),
          `legacy-memory-payload:sha256:${payload.payloadSha256}`,
        ])];
        const metadata = {
          ...safeJsonObject(payload.durableMetadata),
          idaccHistoricalRecovery: {
            schemaVersion: RECOVERY_SCHEMA_VERSION,
            payloadSha256: payload.payloadSha256,
            sourceSnapshots: payload.sourceSnapshots,
            originalMemKey: payload.memKey,
            originalStatus: payload.originalStatus,
            originalExpiresAt: payload.originalExpiresAt,
            recoveredAt: new Date().toISOString(),
          },
        };
        const historicalKey = `${payload.memKey || 'unkeyed'}#historical-${payload.payloadSha256.slice(0, 12)}`;
        const result = insert.run({
          $agentId: payload.agentId,
          $memKey: historicalKey,
          $content: payload.content,
          $tags: JSON.stringify(tags),
          $visibility: payload.visibility,
          $durableMetadata: JSON.stringify(metadata),
          $sourceIds: JSON.stringify(sourceIds),
          $confidence: payload.confidence,
          $project: payload.project,
          $taskId: payload.taskId,
          $sessionId: payload.sessionId,
          $userId: payload.userId,
          $turnId: payload.turnId,
          $supersededBy: nullableInteger(current?.id),
          $createdAt: payload.createdAt,
          $updatedAt: payload.updatedAt,
          $memoryTier: inferredTier(payload, current),
        });
        importedRows.push({ id: Number(result.lastInsertRowid), payloadSha256: payload.payloadSha256 });
        importedNow += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const quick = db.prepare('PRAGMA quick_check').get() as SqlRow;
    if (quick.quick_check !== 'ok') throw new Error('Live Brain failed verification after historical-memory import.');
    archive = {
      ...archive,
      completedAt: new Date().toISOString(),
      importedRows,
      verification: {
        quickCheck: 'ok',
        verifiedRows: importedRows.length,
        currentMemoryCount: integer((db.prepare('SELECT COUNT(*) AS count FROM agent_memories').get() as SqlRow).count),
      },
    };
    writePrivateAppTextFileAtomic(archivePath(paths), `${JSON.stringify(archive, null, 2)}\n`);
  } finally {
    db.close();
  }
  const status = storageRecoveryStatus(paths);
  if (!status.recoveryComplete || status.historicalPayloadsImported !== archive.payloadCount) {
    throw new Error('Historical-memory verification did not confirm every recovered payload. Legacy backups were retained.');
  }
  return { ...status, importedNow, verifiedRows: status.historicalPayloadsImported };
}

export function retireVerifiedLegacyStorage(
  paths: AppProfilePaths,
  confirmation: { userConfirmed?: boolean; expectedImported?: number },
): StorageRecoveryCleanupResult {
  if (!confirmation.userConfirmed) throw new Error('Legacy-storage retirement requires explicit confirmation.');
  const before = storageRecoveryStatus(paths);
  if (
    !before.recoveryComplete
    || before.historicalPayloadsImported !== confirmation.expectedImported
    || before.historicalPayloadsImported !== before.historicalPayloadsFound
  ) {
    throw new Error('Legacy storage cannot be retired until every historical payload is verified in the live Brain.');
  }
  assertCurrentDatabasesHealthy(paths);

  // Abandoned temporary backups are safe to remove first and provide enough
  // headroom to create a fresh, verified post-recovery snapshot.
  const initialTargets = cleanupTargets(paths);
  const stale = initialTargets.filter((target) => target.label === 'Abandoned temporary Brain backup');
  for (const target of stale) rmSync(target.path, { force: true });
  const backupPath = createVerifiedCurrentBackup(paths);
  assertCurrentDatabasesHealthy(paths);

  const targets = cleanupTargets(paths).filter((target) => target.path !== backupPath);
  const removedTargets: Array<{ label: string; path: string; bytes: number }> = [...stale];
  for (const target of targets) {
    assertContained(paths.root, target.path);
    const entry = lstatSync(target.path);
    if (entry.isSymbolicLink()) throw new Error(`Refused unsafe cleanup target: ${target.label}`);
    rmSync(target.path, { recursive: entry.isDirectory(), force: true });
    if (existsSync(target.path)) throw new Error(`IDACC could not verify deletion of ${target.label}.`);
    removedTargets.push(target);
  }
  const removedBytes = removedTargets.reduce((sum, target) => sum + target.bytes, 0);
  const receipt = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    operation: 'verified-legacy-storage-retirement',
    profileRoot: paths.root,
    completedAt: new Date().toISOString(),
    historicalPayloadsVerified: before.historicalPayloadsImported,
    postRecoveryBackup: backupPath,
    removedBytes,
    removedTargets,
  };
  ensurePrivateAppDirectory(recoveryRoot(paths));
  writePrivateAppTextFileAtomic(cleanupReceiptPath(paths), `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    ...storageRecoveryStatus(paths),
    removedBytes,
    removedTargets,
    backupPath,
  };
}
