import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { removeAndVerifyMacAcl } from './macFilePrivacy.ts';
import { assertPrivateFileMode } from './posixFilePrivacy.ts';

export interface PrivateFileCopyOptions {
  mode?: number;
  overwrite?: boolean;
}

function sameSourceFile(left: Stats, right: Stats): boolean {
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
 * Copy file contents without asking the OS to clone the source security
 * descriptor. The private destination is created inside its already-secured
 * parent, so Windows inherits that parent's DACL instead of preserving a
 * permissive ACL from a legacy or user-selected source.
 */
export function copyFilePrivateSync(
  source: string,
  destination: string,
  options: PrivateFileCopyOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  const overwrite = options.overwrite === true;
  const sourceEntry = lstatSync(source);
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
    throw new Error('private file copy source must be a regular file');
  }
  try {
    const destinationEntry = lstatSync(destination);
    if (
      destinationEntry.isSymbolicLink()
      || !destinationEntry.isFile()
      || !overwrite
    ) {
      throw new Error('private file copy destination already exists or is unsafe');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    sourceDescriptor = openSync(source, constants.O_RDONLY | noFollow);
    const openedSource = fstatSync(sourceDescriptor);
    if (!sameSourceFile(sourceEntry, openedSource)) {
      throw new Error('private file copy source changed before it was opened');
    }

    destinationDescriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sourceOffset = 0;
    for (;;) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.length,
        sourceOffset,
      );
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        const countWritten = writeSync(
          destinationDescriptor,
          buffer,
          written,
          count - written,
        );
        if (countWritten <= 0) {
          throw new Error('private file copy destination stopped accepting data');
        }
        written += countWritten;
      }
      sourceOffset += count;
    }
    fsyncSync(destinationDescriptor);
    const afterCopy = fstatSync(sourceDescriptor);
    if (!sameSourceFile(openedSource, afterCopy) || sourceOffset !== afterCopy.size) {
      throw new Error('private file copy source changed while it was read');
    }
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      try { closeSync(destinationDescriptor); } catch { /* best effort */ }
      destinationDescriptor = undefined;
    }
    if (sourceDescriptor !== undefined) {
      try { closeSync(sourceDescriptor); } catch { /* best effort */ }
      sourceDescriptor = undefined;
    }
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) {
      try { closeSync(destinationDescriptor); } catch { /* best effort */ }
    }
    if (sourceDescriptor !== undefined) {
      try { closeSync(sourceDescriptor); } catch { /* best effort */ }
    }
  }

  let published = false;
  try {
    chmodSync(temporary, mode);
    removeAndVerifyMacAcl(temporary);
    chmodSync(temporary, mode);
    assertPrivateFileMode(temporary, mode);
    if (overwrite) {
      renameSync(temporary, destination);
      published = true;
    } else {
      // Publishing through an atomic same-filesystem hard link gives this
      // no-overwrite path real O_EXCL semantics. A check-then-rename sequence
      // could otherwise overwrite a destination created between those calls.
      linkSync(temporary, destination);
      published = true;
      unlinkSync(temporary);
    }
    removeAndVerifyMacAcl(destination);
    chmodSync(destination, mode);
    assertPrivateFileMode(destination, mode);
  } catch (error) {
    if (published) {
      try { rmSync(destination, { force: true }); } catch { /* best effort */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
