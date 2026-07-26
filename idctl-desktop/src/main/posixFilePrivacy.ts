import { lstatSync } from 'node:fs';
import type { Stats } from 'node:fs';

/**
 * Mode bits alone are not a durable ancestor boundary: a different directory
 * owner can later chmod their 0555/0755 directory and replace a child path.
 * Only operating-system-owned or current-user-owned ancestors are trusted.
 *
 * The current UID is injectable for deterministic tests without privileged
 * local accounts.
 */
export function isTrustedPrivatePathOwner(
  ownerUid: number,
  currentUid: number | undefined = process.getuid?.(),
): boolean {
  return Number.isSafeInteger(ownerUid)
    && ownerUid >= 0
    && (
      ownerUid === 0
      || (
        Number.isSafeInteger(currentUid)
        && Number(currentUid) >= 0
        && ownerUid === currentUid
      )
    );
}

function sameIdentity(current: Stats, before?: Stats): boolean {
  return !before || (
    current.dev === before.dev
    && current.ino === before.ino
  );
}

function ownedByCurrentUser(current: Stats): boolean {
  const uid = process.getuid?.();
  return process.platform === 'win32'
    || uid === undefined
    || current.uid === uid;
}

export function assertPrivateDirectoryMode(
  path: string,
  before?: Stats,
): void {
  const secured = lstatSync(path);
  if (
    secured.isSymbolicLink()
    || !secured.isDirectory()
    || !sameIdentity(secured, before)
    || !ownedByCurrentUser(secured)
    || (
      process.platform !== 'win32'
      && (secured.mode & 0o777) !== 0o700
    )
  ) {
    throw new Error(`profile directory privacy could not be verified: ${path}`);
  }
}

export function assertPrivateFileMode(
  path: string,
  mode = 0o600,
  before?: Stats,
): void {
  const secured = lstatSync(path);
  if (
    secured.isSymbolicLink()
    || !secured.isFile()
    || secured.nlink !== 1
    || !sameIdentity(secured, before)
    || !ownedByCurrentUser(secured)
    || (
      process.platform !== 'win32'
      && (secured.mode & 0o777) !== mode
    )
  ) {
    throw new Error(`profile file privacy could not be verified: ${path}`);
  }
}
