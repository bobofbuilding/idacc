import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import {
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  assertSafeMacProfileAncestorAcl,
  removeAndVerifyMacAcl,
} from './macFilePrivacy.ts';
import {
  assertPrivateDirectoryMode,
  assertPrivateFileMode,
  isTrustedPrivatePathOwner,
} from './posixFilePrivacy.ts';
import { secureWindowsPrivatePath } from './profilePrivacy.ts';

const DEFAULT_PRIVATE_READ_LIMIT = 1024 * 1024;
const verifiedPrivateAncestors = new Map<string, { dev: number; ino: number }>();
const verifiedPrivateDirectories = new Map<string, { dev: number; ino: number }>();
const verifiedPrivateFiles = new Map<string, { dev: number; ino: number }>();

function unsafeStateError(kind: 'directory' | 'file'): Error {
  return new Error(`IDACC application-state ${kind} is unsafe.`);
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function cachedIdentityMatches(
  cache: Map<string, { dev: number; ino: number }>,
  path: string,
  current: Stats,
): boolean {
  const cached = cache.get(resolve(path));
  return Boolean(cached && cached.dev === current.dev && cached.ino === current.ino);
}

function rememberIdentity(
  cache: Map<string, { dev: number; ino: number }>,
  path: string,
  current: Stats,
): void {
  cache.set(resolve(path), { dev: current.dev, ino: current.ino });
}

/**
 * Inspect each lexical path component instead of merely lstat'ing the resolved
 * final object. This prevents an intermediate symlink/junction from moving an
 * apparently ordinary state path into an outside tree before chmod or ACL
 * hardening runs.
 */
function assertSafePrivateDirectoryChain(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  if (segments.length === 0) throw unsafeStateError('directory');
  let cursor = root;

  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) cursor = join(cursor, segments[index]);
    let entry: Stats;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const isTarget = index === segments.length - 1;
    if (entry.isSymbolicLink()) {
      const trustedSystemLink = (
        process.platform !== 'win32'
        && !isTarget
        && entry.uid === 0
        && dirname(cursor) === root
      );
      if (trustedSystemLink) {
        const canonical = resolve(
          realpathSync.native(cursor),
          ...segments.slice(index + 1),
        );
        assertSafePrivateDirectoryChain(canonical);
        return;
      }
      throw unsafeStateError('directory');
    }
    if (!entry.isDirectory()) {
      throw unsafeStateError('directory');
    }

    if (isTarget) continue;
    if (process.platform !== 'win32') {
      if (!isTrustedPrivatePathOwner(entry.uid)) {
        throw unsafeStateError('directory');
      }
      const writableByAnotherPrincipal = (entry.mode & 0o022) !== 0;
      const sticky = (entry.mode & 0o1000) !== 0;
      if (writableByAnotherPrincipal) {
        if (!sticky) throw unsafeStateError('directory');
        const next = join(cursor, segments[index + 1]);
        const child = lstatIfPresent(next);
        const uid = process.getuid?.();
        if (
          !child
          || child.isSymbolicLink()
          || !child.isDirectory()
          || !isTrustedPrivatePathOwner(child.uid, uid)
        ) {
          throw unsafeStateError('directory');
        }
      }
      if (!cachedIdentityMatches(verifiedPrivateAncestors, cursor, entry)) {
        assertSafeMacProfileAncestorAcl(cursor);
        rememberIdentity(verifiedPrivateAncestors, cursor, entry);
      }
    }
  }
}

function assertVerifiedFileDescriptor(
  fd: number,
  path: string,
  expected: Stats,
): void {
  const descriptor = fstatSync(fd);
  const current = lstatSync(path);
  if (
    !descriptor.isFile()
    || descriptor.nlink !== 1
    || current.isSymbolicLink()
    || !current.isFile()
    || current.nlink !== 1
    || !sameIdentity(descriptor, expected)
    || !sameIdentity(current, expected)
  ) {
    throw unsafeStateError('file');
  }
}

/**
 * Tighten and verify an existing app-owned directory. The Windows path uses
 * the same native identity-lock and exact user+SYSTEM DACL contract as profile
 * privacy, but only for this object so Chromium's userData tree is not walked.
 */
export function hardenPrivateAppDirectory(path: string): boolean {
  assertSafePrivateDirectoryChain(path);
  const before = lstatIfPresent(path);
  if (!before) return false;
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw unsafeStateError('directory');
  }
  if (cachedIdentityMatches(verifiedPrivateDirectories, path, before)) {
    assertPrivateDirectoryMode(path, before);
    return true;
  }
  if (process.platform === 'win32') {
    secureWindowsPrivatePath(path, 'directory');
  } else {
    removeAndVerifyMacAcl(path);
    chmodSync(path, 0o700);
  }
  assertPrivateDirectoryMode(path, before);
  rememberIdentity(verifiedPrivateDirectories, path, lstatSync(path));
  return true;
}

export function ensurePrivateAppDirectory(path: string): string {
  assertSafePrivateDirectoryChain(path);
  if (process.platform === 'win32') {
    const before = lstatIfPresent(path);
    if (before && (before.isSymbolicLink() || !before.isDirectory())) {
      throw unsafeStateError('directory');
    }
    if (before) {
      hardenPrivateAppDirectory(path);
      return path;
    }
    secureWindowsPrivatePath(path, 'directory');
    const secured = lstatSync(path);
    assertPrivateDirectoryMode(path, before || undefined);
    rememberIdentity(verifiedPrivateDirectories, path, secured);
    return path;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!hardenPrivateAppDirectory(path)) {
    throw unsafeStateError('directory');
  }
  return path;
}

/**
 * Tighten and verify an existing app-owned file before it is read or written.
 * A dangling symlink is present according to lstat and is therefore rejected;
 * callers must use lstat rather than a target-following existence check.
 */
export function hardenPrivateAppFile(path: string): Stats | null {
  assertSafePrivateDirectoryChain(dirname(path));
  const before = lstatIfPresent(path);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafeStateError('file');
  }
  if (cachedIdentityMatches(verifiedPrivateFiles, path, before)) {
    assertPrivateFileMode(path, 0o600, before);
    return before;
  }
  if (process.platform === 'win32') {
    secureWindowsPrivatePath(path, 'file');
  } else {
    removeAndVerifyMacAcl(path);
    chmodSync(path, 0o600);
  }
  assertPrivateFileMode(path, 0o600, before);
  const secured = lstatSync(path);
  rememberIdentity(verifiedPrivateFiles, path, secured);
  return secured;
}

function createEmptyPrivateAppFile(path: string): Stats {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | noFollowFlag(),
      0o600,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
  try {
    const secured = hardenPrivateAppFile(path);
    if (!secured) throw unsafeStateError('file');
    return secured;
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      // The original hardening error is the actionable failure.
    }
    throw error;
  }
}

function preparePrivateAppFile(path: string): Stats {
  ensurePrivateAppDirectory(dirname(path));
  return hardenPrivateAppFile(path) ?? createEmptyPrivateAppFile(path);
}

function openVerifiedPrivateAppFile(
  path: string,
  flags: number,
  expected: Stats,
): number {
  const fd = openSync(path, flags | noFollowFlag(), 0o600);
  try {
    assertVerifiedFileDescriptor(fd, path, expected);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error('IDACC application-state write did not complete.');
    offset += written;
  }
}

export function readPrivateAppTextFile(
  path: string,
  maximumBytes = DEFAULT_PRIVATE_READ_LIMIT,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('IDACC application-state read limit is invalid.');
  }
  ensurePrivateAppDirectory(dirname(path));
  const secured = hardenPrivateAppFile(path);
  if (!secured) {
    // Preserve the ordinary ENOENT contract expected by best-effort readers.
    return readFileSync(path, 'utf8');
  }
  if (secured.size > maximumBytes) {
    throw new Error('IDACC application-state file exceeds its safe read limit.');
  }
  const fd = openVerifiedPrivateAppFile(path, constants.O_RDONLY, secured);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Write state through a newly-created, already-private temporary file and
 * atomically replace the destination. Existing state is hardened before the
 * replacement so old contents are not left under permissive permissions.
 */
export function writePrivateAppTextFileAtomic(
  path: string,
  data: string,
): void {
  ensurePrivateAppDirectory(dirname(path));
  hardenPrivateAppFile(path);
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let fd: number | null = null;
  let renamed = false;
  try {
    const secured = createEmptyPrivateAppFile(temporary);
    fd = openVerifiedPrivateAppFile(
      temporary,
      constants.O_WRONLY,
      secured,
    );
    writeAll(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    renamed = true;
    const replaced = lstatSync(path);
    if (!sameIdentity(replaced, secured)) throw unsafeStateError('file');
    verifiedPrivateFiles.delete(resolve(temporary));
    rememberIdentity(verifiedPrivateFiles, path, replaced);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Continue with private temporary-file cleanup.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary path may not have been created.
      }
    }
  }
}

/**
 * Update a noncritical, self-healing state file in place. Unlike the atomic
 * writer this reuses one verified identity, avoiding a native ACL subprocess
 * for every debounced window move on Windows and macOS. A partial write only
 * makes the best-effort state unreadable, which its caller already treats as
 * "use defaults"; security and descriptor identity remain fail-closed.
 */
export function writePrivateAppTextFileInPlace(
  path: string,
  data: string,
): void {
  const secured = preparePrivateAppFile(path);
  const fd = openVerifiedPrivateAppFile(
    path,
    constants.O_WRONLY,
    secured,
  );
  try {
    ftruncateSync(fd, 0);
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendPrivateAppTextFile(path: string, data: string): void {
  const secured = preparePrivateAppFile(path);
  const fd = openVerifiedPrivateAppFile(
    path,
    constants.O_WRONLY | constants.O_APPEND,
    secured,
  );
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Return one verified append descriptor for a child process. Passing the same
 * descriptor for stdout and stderr keeps the exact file identity open for the
 * whole child lifetime; path replacement cannot redirect those later writes.
 */
export function openPrivateAppAppendFile(path: string): number {
  const secured = preparePrivateAppFile(path);
  return openVerifiedPrivateAppFile(
    path,
    constants.O_WRONLY | constants.O_APPEND,
    secured,
  );
}
