import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_SELFTEST_RESULT_BYTES = 1024 * 1024;

function missingPath(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT',
  );
}

/**
 * Publish a self-test result without exposing a partially written file.
 *
 * The caller must provide an absolute file directly inside the private profile
 * root. The root is created and permissioned by initializeAppProfile(); this
 * helper deliberately will not create or follow a caller-selected directory.
 */
export function writeStackSelftestResultFile(
  requestedPath: string,
  profileRoot: string,
  result: unknown,
): string {
  if (!requestedPath || requestedPath.includes('\0') || !isAbsolute(requestedPath)) {
    throw new Error('IDACC_STACK_SELFTEST_RESULT_FILE must be an absolute file path');
  }

  const root = resolve(realpathSync.native(profileRoot));
  const requestedTarget = resolve(requestedPath);
  let requestedParent: string;
  try {
    requestedParent = resolve(realpathSync.native(dirname(requestedTarget)));
  } catch {
    throw new Error('IDACC_STACK_SELFTEST_RESULT_FILE must be directly inside the active self-test profile');
  }
  if (requestedParent !== root) {
    throw new Error('IDACC_STACK_SELFTEST_RESULT_FILE must be directly inside the active self-test profile');
  }
  // Use the already-canonical private root for every filesystem operation. A
  // caller may spell the same directory through an operating-system alias
  // (for example /var versus /private/var on macOS); never keep using that
  // independently replaceable alias after proving where it resolves.
  const target = join(root, basename(requestedTarget));

  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('the active self-test profile must be a real directory');
  }
  if (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) {
    throw new Error('the active self-test profile must not be accessible to other users');
  }

  try {
    lstatSync(target);
    throw new Error('IDACC_STACK_SELFTEST_RESULT_FILE already exists');
  } catch (error) {
    if (!missingPath(error)) throw error;
  }

  const json = JSON.stringify(result);
  if (typeof json !== 'string') {
    throw new Error('the stack self-test result must be JSON-serializable');
  }
  const serialized = `${json}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SELFTEST_RESULT_BYTES) {
    throw new Error('the stack self-test result exceeds the 1 MiB safety limit');
  }

  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serialized, { encoding: 'utf8' });
    try { fchmodSync(descriptor, 0o600); } catch {
      if (process.platform !== 'win32') throw new Error('could not secure the stack self-test result');
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // A hard-link publication is atomic and refuses to replace an existing
    // result, including if another same-user process races the final check.
    linkSync(temporary, target);
    unlinkSync(temporary);
    return requestedTarget;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    try { unlinkSync(temporary); } catch { /* publication may not have created it */ }
    throw error;
  }
}
