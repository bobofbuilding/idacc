import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';

export type UnifiedServiceName = 'manager' | 'brain';

export interface RuntimeComponentManifest {
  repository: string;
  commit: string;
  tree: string;
  version: string;
  packageLockSha256: string;
  entrypoint: string;
  serviceId: string;
}

export interface RuntimeFileRecord {
  path: string;
  type: 'file' | 'symlink';
  size: number;
  sha256: string;
  target?: string;
}

export interface RuntimeManifest {
  schemaVersion: 2;
  generatedAt: string;
  application: {
    name: string;
    version: string;
    commit: string;
    tree: string;
    dirty: boolean;
  };
  components: Record<UnifiedServiceName, RuntimeComponentManifest>;
  trees: {
    manager: string;
    brain: string;
    runtime: string;
  };
  files: RuntimeFileRecord[];
}

export interface HealthValidation {
  healthy: boolean;
  identity: 'attested' | 'legacy-compatible' | 'rejected';
  identityVerified: boolean;
  reportedVersion?: string;
  protocolVersion?: string;
  error?: string;
}

export interface BrainListenerStatusValidation {
  healthy: boolean;
  lastSuccessfulPollAt?: string;
  teamCount?: number;
  primaryTeam?: {
    id: string;
    name: string;
    active: boolean;
  };
  error?: string;
}

export interface LogRetentionPolicy {
  maxBytes: number;
  keepFiles: number;
  maxAgeMs: number;
}

export const DEFAULT_SERVICE_LOG_POLICY: Readonly<LogRetentionPolicy> = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  keepFiles: 5,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
});

const SERVICE_ALIASES: Record<UnifiedServiceName, ReadonlySet<string>> = {
  manager: new Set(['manager', 'idacc-manager', 'id-agents-manager']),
  brain: new Set(['brain', 'idacc-brain', 'id-agents-brain']),
};

export const BRAIN_LISTENER_STATUS_MAX_BYTES = 512 * 1024;
export const BRAIN_LISTENER_STATUS_FRESHNESS_MS = 30_000;
const BRAIN_LISTENER_STATUS_FUTURE_SKEW_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function listenerStatusError(
  error: string,
  lastSuccessfulPollAt?: string,
): BrainListenerStatusValidation {
  return {
    healthy: false,
    ...(lastSuccessfulPollAt ? { lastSuccessfulPollAt } : {}),
    error,
  };
}

/**
 * Validate the process-bound status written after a successful listener poll.
 * The instance nonce prevents a status file from an earlier listener process
 * from making a newly spawned process look ready.
 */
export function validateBrainListenerStatus(
  value: unknown,
  options: {
    instanceNonce: string;
    pid: number;
    now?: number;
    freshnessMs?: number;
  },
): BrainListenerStatusValidation {
  const source = record(value);
  if (!source || source.schemaVersion !== 1) {
    return listenerStatusError('listener status did not match schema version 1');
  }
  if (
    typeof source.instanceNonce !== 'string'
    || !source.instanceNonce
    || source.instanceNonce !== options.instanceNonce
    || !Number.isInteger(source.pid)
    || Number(source.pid) <= 0
    || Number(source.pid) !== options.pid
  ) {
    return listenerStatusError('listener status did not match the managed process');
  }

  const primaryTeam = record(source.primaryTeam);
  const primaryTeamId = primaryTeam && nonEmptyString(primaryTeam.id);
  const primaryTeamName = primaryTeam && nonEmptyString(primaryTeam.name);
  const primaryTeamActive = primaryTeam?.active;
  const teamCount = source.teamCount;
  if (
    !primaryTeamId
    || primaryTeamId.length > 256
    || !primaryTeamName
    || primaryTeamName.length > 256
    || typeof primaryTeamActive !== 'boolean'
    || typeof teamCount !== 'number'
    || !Number.isSafeInteger(teamCount)
    || teamCount < 1
    || teamCount > 512
    || !Array.isArray(source.cursors)
    || source.cursors.length !== teamCount
  ) {
    return listenerStatusError('listener status contained an invalid team summary');
  }

  const seenTeamIds = new Set<string>();
  let includesPrimaryTeam = false;
  for (const rawCursor of source.cursors) {
    const cursor = record(rawCursor);
    const id = cursor && nonEmptyString(cursor.id);
    const name = cursor && nonEmptyString(cursor.name);
    const seq = cursor?.seq;
    if (
      !id
      || id.length > 256
      || !name
      || name.length > 256
      || typeof seq !== 'number'
      || !Number.isSafeInteger(seq)
      || seq < 0
      || seenTeamIds.has(id)
    ) {
      return listenerStatusError('listener status contained an invalid cursor summary');
    }
    seenTeamIds.add(id);
    if (id === primaryTeamId) includesPrimaryTeam = true;
  }
  if (includesPrimaryTeam !== primaryTeamActive) {
    return listenerStatusError('listener status primary-team activity disagreed with its cursors');
  }

  const lastSuccessfulPollAt = typeof source.lastSuccessfulPollAt === 'string'
    ? source.lastSuccessfulPollAt
    : '';
  const pollTimestamp = Date.parse(lastSuccessfulPollAt);
  if (
    !lastSuccessfulPollAt
    || !Number.isFinite(pollTimestamp)
    || new Date(pollTimestamp).toISOString() !== lastSuccessfulPollAt
  ) {
    return listenerStatusError('listener status did not contain a valid successful-poll timestamp');
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const freshnessMs = Math.max(1_000, Math.floor(
    options.freshnessMs ?? BRAIN_LISTENER_STATUS_FRESHNESS_MS,
  ));
  if (pollTimestamp > now + BRAIN_LISTENER_STATUS_FUTURE_SKEW_MS) {
    return listenerStatusError(
      'listener successful-poll timestamp is in the future',
      lastSuccessfulPollAt,
    );
  }
  if (now - pollTimestamp > freshnessMs) {
    return listenerStatusError(
      'listener has not completed a successful poll recently',
      lastSuccessfulPollAt,
    );
  }
  return {
    healthy: true,
    lastSuccessfulPollAt,
    teamCount,
    primaryTeam: {
      id: primaryTeamId,
      name: primaryTeamName,
      active: primaryTeamActive,
    },
  };
}

/**
 * Read a listener status file without following symbolic links or accepting an
 * oversized/permissive file. All failures are represented as not-ready state.
 */
export function readBrainListenerStatusFile(
  path: string,
  options: {
    instanceNonce: string;
    pid: number;
    now?: number;
    freshnessMs?: number;
    maxBytes?: number;
  },
): BrainListenerStatusValidation {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    return listenerStatusError('listener status file is not present');
  }
  const requestedMaxBytes = Number.isFinite(options.maxBytes)
    ? Number(options.maxBytes)
    : BRAIN_LISTENER_STATUS_MAX_BYTES;
  const maxBytes = Math.min(
    BRAIN_LISTENER_STATUS_MAX_BYTES,
    Math.max(
      1_024,
      Math.floor(requestedMaxBytes),
    ),
  );
  if (before.isSymbolicLink()) {
    return listenerStatusError('listener status file cannot be a symbolic link');
  }
  if (!before.isFile()) {
    return listenerStatusError('listener status path is not a regular file');
  }
  if (before.size < 1 || before.size > maxBytes) {
    return listenerStatusError('listener status file exceeded its size limit');
  }
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
    return listenerStatusError('listener status file is not private');
  }

  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > maxBytes
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
      || (
        before.dev !== 0
        && before.ino !== 0
        && (opened.dev !== before.dev || opened.ino !== before.ino)
      )
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) {
      return listenerStatusError('listener status file changed while it was being checked');
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (offset > maxBytes) {
      return listenerStatusError('listener status file exceeded its size limit');
    }
    if (
      after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)
    ) {
      return listenerStatusError('listener status file changed while it was being read');
    }
    const raw = buffer.subarray(0, offset).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return listenerStatusError('listener status file did not contain valid JSON');
    }
    return validateBrainListenerStatus(parsed, options);
  } catch {
    return listenerStatusError('listener status file could not be read safely');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function safeManifestPath(value: unknown): string | undefined {
  const path = nonEmptyString(value);
  if (
    !path
    || path === 'manifest.json'
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) return undefined;
  return path;
}

function safeSymlinkTarget(value: unknown, linkPath: string): string | undefined {
  const target = typeof value === 'string' && value ? value : undefined;
  if (
    !target
    || posix.isAbsolute(target)
    || target.includes('\\')
    || target.includes('\0')
    || /^[A-Za-z]:/.test(target)
  ) return undefined;
  const destination = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (
    !destination
    || destination === '..'
    || destination.startsWith('../')
    || posix.isAbsolute(destination)
  ) return undefined;
  return target;
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  const source = record(value);
  if (!source || source.schemaVersion !== 2) {
    throw new Error('runtime manifest schemaVersion must be 2');
  }
  const components = record(source.components);
  if (!components) throw new Error('runtime manifest must contain components');
  const parsedComponents = {} as Record<UnifiedServiceName, RuntimeComponentManifest>;
  for (const name of ['manager', 'brain'] as const) {
    const component = record(components[name]);
    if (!component) throw new Error(`runtime manifest must contain components.${name}`);
    const repository = nonEmptyString(component.repository);
    const commit = nonEmptyString(component.commit);
    const tree = nonEmptyString(component.tree);
    const version = nonEmptyString(component.version);
    const packageLockSha256 = nonEmptyString(component.packageLockSha256);
    const entrypoint = nonEmptyString(component.entrypoint);
    const serviceId = nonEmptyString(component.serviceId);
    if (
      !repository
      || !commit
      || !HEX_40.test(commit)
      || !tree
      || !HEX_40.test(tree)
      || !version
      || !packageLockSha256
      || !HEX_64.test(packageLockSha256)
      || !entrypoint
      || entrypoint.startsWith('/')
      || entrypoint.split(/[\\/]+/).includes('..')
      || !serviceId
      || !/^[a-z][a-z0-9-]{2,63}$/.test(serviceId)
    ) {
      throw new Error(`runtime manifest components.${name} is invalid`);
    }
    parsedComponents[name] = {
      repository,
      commit,
      tree,
      version,
      packageLockSha256,
      entrypoint,
      serviceId,
    };
  }
  const generatedAt = nonEmptyString(source.generatedAt);
  if (!generatedAt) throw new Error('runtime manifest must include generatedAt');
  const application = record(source.application);
  const appName = application && nonEmptyString(application.name);
  const appVersion = application && nonEmptyString(application.version);
  const appCommit = application && nonEmptyString(application.commit);
  const appTree = application && nonEmptyString(application.tree);
  if (
    !application
    || !appName
    || !appVersion
    || !appCommit
    || !HEX_40.test(appCommit)
    || !appTree
    || !HEX_40.test(appTree)
    || typeof application.dirty !== 'boolean'
  ) {
    throw new Error('runtime manifest application provenance is invalid');
  }
  const trees = record(source.trees);
  const managerTree = trees && nonEmptyString(trees.manager);
  const brainTree = trees && nonEmptyString(trees.brain);
  const runtimeTree = trees && nonEmptyString(trees.runtime);
  if (
    !trees
    || !managerTree
    || !HEX_64.test(managerTree)
    || !brainTree
    || !HEX_64.test(brainTree)
    || !runtimeTree
    || !HEX_64.test(runtimeTree)
  ) {
    throw new Error('runtime manifest tree hashes are invalid');
  }
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 100_000) {
    throw new Error('runtime manifest files must be a bounded non-empty array');
  }
  const seen = new Set<string>();
  const files = source.files.map((raw, index): RuntimeFileRecord => {
    const file = record(raw);
    const path = file && safeManifestPath(file.path);
    const type = file?.type;
    const size = Number(file?.size);
    const digest = file && nonEmptyString(file.sha256);
    const target = type === 'symlink' && path
      ? safeSymlinkTarget(file?.target, path)
      : undefined;
    if (
      !file
      || !path
      || (type !== 'file' && type !== 'symlink')
      || !Number.isSafeInteger(size)
      || size < 0
      || !digest
      || !HEX_64.test(digest)
      || (type === 'symlink' && !target)
      || (type === 'file' && file.target !== undefined)
    ) {
      throw new Error(`runtime manifest files[${index}] is invalid`);
    }
    if (seen.has(path)) throw new Error(`runtime manifest contains duplicate file ${path}`);
    seen.add(path);
    return {
      path,
      type,
      size,
      sha256: digest,
      ...(target ? { target } : {}),
    };
  });
  return {
    schemaVersion: 2,
    generatedAt,
    application: {
      name: appName,
      version: appVersion,
      commit: appCommit,
      tree: appTree,
      dirty: application.dirty,
    },
    components: parsedComponents,
    trees: {
      manager: managerTree,
      brain: brainTree,
      runtime: runtimeTree,
    },
    files,
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runtimeManifestSha256(raw: string | Buffer): string {
  return sha256(raw);
}

export function manifestDigestMatches(raw: string | Buffer, expected: string): boolean {
  if (!HEX_64.test(expected)) return false;
  const actual = Buffer.from(runtimeManifestSha256(raw), 'hex');
  const pinned = Buffer.from(expected, 'hex');
  return actual.length === pinned.length && timingSafeEqual(actual, pinned);
}

function canonicalRuntimeRecord(record: RuntimeFileRecord, path = record.path): string {
  return JSON.stringify({
    path,
    type: record.type,
    size: record.size,
    sha256: record.sha256,
    ...(record.type === 'symlink' ? { target: record.target } : {}),
  });
}

function manifestTreeHash(records: readonly RuntimeFileRecord[], prefix = ''): string {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const selected = records
    .filter((record) => !normalizedPrefix || record.path.startsWith(normalizedPrefix))
    .map((record) => canonicalRuntimeRecord(
      record,
      normalizedPrefix ? record.path.slice(normalizedPrefix.length) : record.path,
    ))
    .join('\n');
  return sha256(selected ? `${selected}\n` : '');
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function walkRuntime(root: string, current: string, paths: string[], errors: string[]): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    errors.push(`could not read runtime directory ${portablePath(root, current) || '.'}: ${
      error instanceof Error ? error.message : String(error)
    }`);
    return;
  }
  for (const entry of entries) {
    const path = join(current, entry.name);
    const rel = portablePath(root, path);
    if (rel === 'manifest.json') continue;
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      errors.push(`could not inspect runtime file ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (stat.isDirectory()) {
      walkRuntime(root, path, paths, errors);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      errors.push(`runtime contains unsupported filesystem entry ${rel}`);
      continue;
    }
    paths.push(rel);
  }
}

/**
 * Recompute the complete staged payload before either child is executed.
 * The manifest itself is pinned into the bundled main process at build time;
 * this second layer detects changed, missing, or injected runtime files.
 */
export function verifyRuntimePayload(root: string, manifest: RuntimeManifest): string[] {
  const errors: string[] = [];
  const expectedByPath = new Map(manifest.files.map((record) => [record.path, record]));
  const actualPaths: string[] = [];
  walkRuntime(root, root, actualPaths, errors);
  const actualSet = new Set(actualPaths);

  for (const record of manifest.files) {
    const path = resolve(root, ...record.path.split('/'));
    const rel = portablePath(root, path);
    if (rel !== record.path || rel.startsWith('../')) {
      errors.push(`runtime manifest path escapes its root: ${record.path}`);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      errors.push(`runtime file is missing: ${record.path}`);
      continue;
    }
    if (record.type === 'file') {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`runtime file type changed: ${record.path}`);
        continue;
      }
      if (stat.size !== record.size) {
        errors.push(`runtime file size changed: ${record.path}`);
        continue;
      }
      if (sha256(readFileSync(path)) !== record.sha256) {
        errors.push(`runtime file digest changed: ${record.path}`);
      }
      continue;
    }
    if (!stat.isSymbolicLink()) {
      errors.push(`runtime symlink type changed: ${record.path}`);
      continue;
    }
    const target = readlinkSync(path);
    if (!safeSymlinkTarget(target, record.path)) {
      errors.push(`runtime symlink escapes its root: ${record.path}`);
      continue;
    }
    if (target !== record.target || Buffer.byteLength(target) !== record.size) {
      errors.push(`runtime symlink target changed: ${record.path}`);
      continue;
    }
    if (sha256(`symlink\0${target}`) !== record.sha256) {
      errors.push(`runtime symlink digest changed: ${record.path}`);
    }
  }
  for (const path of actualPaths) {
    if (!expectedByPath.has(path)) errors.push(`runtime contains an unmanifested file: ${path}`);
  }
  for (const path of expectedByPath.keys()) {
    if (!actualSet.has(path)) errors.push(`runtime file is missing: ${path}`);
  }
  if (manifestTreeHash(manifest.files) !== manifest.trees.runtime) {
    errors.push('runtime manifest aggregate tree hash is inconsistent');
  }
  if (manifestTreeHash(manifest.files, 'manager') !== manifest.trees.manager) {
    errors.push('manager manifest tree hash is inconsistent');
  }
  if (manifestTreeHash(manifest.files, 'brain') !== manifest.trees.brain) {
    errors.push('Brain manifest tree hash is inconsistent');
  }
  return [...new Set(errors)].slice(0, 50);
}

export function validateServiceHealth(
  name: UnifiedServiceName,
  payload: unknown,
  options: {
    expectedVersion?: string;
    expectedServiceId?: string;
    instanceNonce: string;
    ownedProcess: boolean;
    requireAttestation?: boolean;
  },
): HealthValidation {
  const source = record(payload);
  if (!source) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      error: 'health response was not a JSON object',
    };
  }

  const shapeMatches = name === 'manager'
    ? source.status === 'ok'
    : source.ok === true;
  if (!shapeMatches) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      error: `health response did not match the ${name} protocol`,
    };
  }

  const declaredService = firstString(source, ['service', 'serviceName', 'service_name']);
  const reportedVersion = firstString(source, ['runtimeVersion', 'runtime_version', 'version']);
  const reportedNonce = firstString(source, ['instanceNonce', 'instance_nonce']);
  const protocolVersion = firstString(source, ['protocolVersion', 'protocol_version']);

  const normalizedService = declaredService?.toLowerCase();
  const expectedServiceId = options.expectedServiceId?.toLowerCase();
  if (
    normalizedService
    && normalizedService !== expectedServiceId
    && !SERVICE_ALIASES[name].has(normalizedService)
  ) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      reportedVersion,
      protocolVersion,
      error: `health response identified a different service (${declaredService})`,
    };
  }
  if (reportedVersion && options.expectedVersion && reportedVersion !== options.expectedVersion) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      reportedVersion,
      protocolVersion,
      error: `health response version ${reportedVersion} does not match bundled version ${options.expectedVersion}`,
    };
  }
  if (reportedNonce && reportedNonce !== options.instanceNonce) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      reportedVersion,
      protocolVersion,
      error: 'health response did not match the managed process nonce',
    };
  }

  const attested = Boolean(
    declaredService
    && normalizedService === expectedServiceId
    && reportedVersion
    && reportedNonce
    && options.expectedVersion
    && reportedVersion === options.expectedVersion
    && reportedNonce === options.instanceNonce,
  );
  if (attested) {
    return {
      healthy: true,
      identity: 'attested',
      identityVerified: true,
      reportedVersion,
      protocolVersion,
    };
  }
  if (options.requireAttestation) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      reportedVersion,
      protocolVersion,
      error: 'managed service health response is missing its exact service, version, or instance nonce attestation',
    };
  }
  if (!options.ownedProcess) {
    return {
      healthy: false,
      identity: 'rejected',
      identityVerified: false,
      reportedVersion,
      protocolVersion,
      error: 'health response was not attested by a managed process',
    };
  }
  return {
    healthy: true,
    identity: 'legacy-compatible',
    identityVerified: false,
    reportedVersion,
    protocolVersion,
  };
}

export function restartDelayMs(
  attempt: number,
  randomValue = Math.random(),
  options: { baseMs?: number; capMs?: number } = {},
): number {
  const baseMs = Math.max(1, options.baseMs ?? 1_000);
  const capMs = Math.max(baseMs, options.capMs ?? 30_000);
  const exponent = Math.max(0, Math.min(20, Math.floor(attempt) - 1));
  const raw = Math.min(capMs, baseMs * (2 ** exponent));
  const boundedRandom = Math.max(0, Math.min(1, randomValue));
  const jitter = 0.75 + (boundedRandom * 0.5);
  return Math.max(1, Math.round(raw * jitter));
}

export function recentCrashes(
  crashes: readonly number[],
  now: number,
  windowMs = 60_000,
): number[] {
  const lowerBound = now - Math.max(1, windowMs);
  return crashes.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= lowerBound && timestamp <= now);
}

export function shouldOpenCrashFuse(
  crashes: readonly number[],
  now: number,
  options: { limit?: number; windowMs?: number } = {},
): boolean {
  const limit = Math.max(1, Math.floor(options.limit ?? 5));
  return recentCrashes(crashes, now, options.windowMs ?? 60_000).length >= limit;
}

export function canonicalLoopbackServiceUrl(value: string): { url: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('service URL is invalid');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(host)
    || parsed.username
    || parsed.password
    || !parsed.port
    || (parsed.pathname && parsed.pathname !== '/')
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('service URL must be an uncredentialed loopback HTTP origin with an explicit port');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('service URL port is invalid');
  }
  return { url: `http://127.0.0.1:${port}`, port };
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Retention is best-effort. The supervisor will retry on the next pass.
  }
}

function pruneLogArchives(
  logPath: string,
  policy: LogRetentionPolicy,
  now: number,
): number {
  const folder = dirname(logPath);
  const file = basename(logPath);
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(folder);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${file}.`)) continue;
    const suffix = entry.slice(file.length + 1);
    const archiveNumber = Number(suffix);
    const path = join(folder, entry);
    let expired = !Number.isInteger(archiveNumber)
      || archiveNumber < 1
      || archiveNumber > policy.keepFiles;
    if (!expired) {
      try {
        expired = now - statSync(path).mtimeMs > policy.maxAgeMs;
      } catch {
        expired = true;
      }
    }
    if (expired) {
      removeIfPresent(path);
      removed += 1;
    }
  }
  return removed;
}

export function rotateServiceLog(
  logPath: string,
  policy: LogRetentionPolicy = DEFAULT_SERVICE_LOG_POLICY,
  now = Date.now(),
): { rotated: boolean; removed: number } {
  const normalized: LogRetentionPolicy = {
    maxBytes: Math.max(1, Math.floor(policy.maxBytes)),
    keepFiles: Math.max(1, Math.floor(policy.keepFiles)),
    maxAgeMs: Math.max(1, Math.floor(policy.maxAgeMs)),
  };
  let removed = pruneLogArchives(logPath, normalized, now);
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return { rotated: false, removed };
  }
  if (size < normalized.maxBytes) return { rotated: false, removed };

  for (let index = normalized.keepFiles; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    if (!existsSync(source)) continue;
    if (index === normalized.keepFiles) {
      removeIfPresent(source);
      removed += 1;
      continue;
    }
    const target = `${logPath}.${index + 1}`;
    removeIfPresent(target);
    renameSync(source, target);
    try { chmodSync(target, 0o600); } catch { /* best-effort hardening */ }
  }

  const firstArchive = `${logPath}.1`;
  removeIfPresent(firstArchive);
  copyFileSync(logPath, firstArchive);
  try { chmodSync(firstArchive, 0o600); } catch { /* best-effort hardening */ }
  truncateSync(logPath, 0);
  try { chmodSync(logPath, 0o600); } catch { /* best-effort hardening */ }
  return { rotated: true, removed };
}
