import { spawnSync } from 'node:child_process';

const MAC_PRIVACY_TIMEOUT_MS = 2 * 60_000;
const MAC_ACL_MODE = /^[bcdlps-][rwxStTs-]{9}\+/m;
const MAC_ACL_ENTRY = /^\s*\d+:\s/m;

export function macAclListingHasExtendedAcl(output: string): boolean {
  return MAC_ACL_MODE.test(output) || MAC_ACL_ENTRY.test(output);
}

export function assertSafeMacProfileAncestorAcl(path: string): void {
  if (process.platform !== 'darwin') return;
  const output = runPrivacyCommand('/bin/ls', ['-ldeb', path]);
  const dangerousRights = new Set([
    'add_file',
    'add_subdirectory',
    'delete',
    'delete_child',
    'write',
    'writeattr',
    'writeextattr',
    'writesecurity',
    'chown',
  ]);
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+:\s+.*\s+allow\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const rights = match[1]
      .split(',')
      .map((right) => right.trim().toLowerCase());
    if (rights.some((right) => dangerousRights.has(right))) {
      throw new Error('IDACC profile parent has a replaceable macOS ACL.');
    }
  }
}

function runPrivacyCommand(
  executable: string,
  args: string[],
  maxBuffer = 1024 * 1024,
): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxBuffer,
    timeout: MAC_PRIVACY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error('IDACC could not establish private macOS file access.');
  }
  return String(result.stdout || '');
}

/**
 * POSIX mode bits do not remove macOS extended ACL entries. Clear them with
 * the OS utility and verify the resulting descriptors before profile state is
 * used. Recursive calls are made only for app-owned subtrees; workspace
 * descendants remain user-managed.
 */
export function removeAndVerifyMacAcl(path: string, recursive = false): void {
  if (process.platform !== 'darwin') return;
  runPrivacyCommand('/bin/chmod', [recursive ? '-RN' : '-N', path]);
  const output = recursive
    ? runPrivacyCommand(
      '/usr/bin/find',
      [path, '-xdev', '-exec', '/bin/ls', '-ldeb', '{}', '+'],
      32 * 1024 * 1024,
    )
    : runPrivacyCommand('/bin/ls', ['-ldeb', path]);
  if (macAclListingHasExtendedAcl(output)) {
    throw new Error('IDACC could not verify removal of a macOS extended ACL.');
  }
}
