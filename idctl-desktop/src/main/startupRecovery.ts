import { createHash, randomBytes } from 'node:crypto';

export type StartupFailureCode =
  | 'profile-newer'
  | 'profile-unavailable'
  | 'runtime-unavailable'
  | 'startup-unavailable';

export interface StartupFailureReport {
  code: StartupFailureCode;
  title: string;
  detail: string;
  diagnosticId: string;
  systemCode?: string;
}

export type StartupRecoveryDecision = 'retry' | 'quit';

const SAFE_SYSTEM_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

function errorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name || 'Error';
    if (typeof error === 'string') return error;
    return JSON.stringify(error) || String(error);
  } catch {
    return 'Unknown startup error';
  }
}

function safeSystemCode(error: unknown): string | undefined {
  try {
    const value = error && typeof error === 'object'
      ? String((error as { code?: unknown }).code || '').toUpperCase()
      : '';
    return SAFE_SYSTEM_CODES.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function classifyStartupFailure(message: string): StartupFailureCode {
  if (/newer application version|newer app(?:lication)? version/i.test(message)) {
    return 'profile-newer';
  }
  if (
    /profile|migration|IDACC_PROFILE|IDACC_DATA_DIR|config(?:uration)?(?: file)?|permission|EACCES|EPERM|read-only/i.test(message)
  ) {
    return 'profile-unavailable';
  }
  if (/unified|runtime|manager|brain|service|spawn|bundle|manifest|port/i.test(message)) {
    return 'runtime-unavailable';
  }
  return 'startup-unavailable';
}

function copyFor(code: StartupFailureCode): Pick<StartupFailureReport, 'title' | 'detail'> {
  switch (code) {
    case 'profile-newer':
      return {
        title: 'This profile needs a newer IDACC',
        detail: 'The selected profile was last opened by a newer application version. Install the latest update or select another profile. IDACC did not change or reset your files.',
      };
    case 'profile-unavailable':
      return {
        title: 'IDACC could not safely open this profile',
        detail: 'Your files remain in place. You can retry after repairing access, locate the profile folder, select another folder, or start a separate fresh profile.',
      };
    case 'runtime-unavailable':
      return {
        title: 'IDACC could not start its local services',
        detail: 'The bundled Manager and Brain were stopped safely. Your profile remains in place, and you can retry, inspect it, select another profile, or start a separate fresh profile.',
      };
    default:
      return {
        title: 'IDACC could not finish starting',
        detail: 'Any partially started local services were stopped safely, and your profile was not reset. Retry or choose one of the recovery options below.',
      };
  }
}

/**
 * Convert an arbitrary startup exception into a report that is safe for both
 * the native recovery UI and internal logs. Raw messages and stacks can contain
 * profile paths, bearer tokens, or provider credentials, so only a one-way
 * fingerprint and an allowlisted operating-system code cross this boundary.
 */
export function startupFailureReport(error: unknown): StartupFailureReport {
  const message = errorText(error);
  const code = classifyStartupFailure(message);
  const systemCode = safeSystemCode(error);
  const diagnosticId = createHash('sha256')
    .update(`${code}\0${systemCode || ''}\0${message}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return {
    code,
    ...copyFor(code),
    diagnosticId,
    ...(systemCode ? { systemCode } : {}),
  };
}

export function freshRecoveryProfileName(
  now = new Date(),
  suffix = randomBytes(4).toString('hex'),
): string {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace('.', '-')
    .replace('Z', '');
  const safeSuffix = /^[a-f0-9]{8}$/i.test(suffix)
    ? suffix.toLowerCase()
    : createHash('sha256').update(suffix).digest('hex').slice(0, 8);
  return `recovery-${stamp}-${safeSuffix}`;
}

/**
 * Keep the startup retry state machine independently testable. The caller's
 * failure handler must stop partial services before asking the user what to do.
 */
export async function runStartupRecoveryLoop(
  start: () => Promise<void>,
  onFailure: (report: StartupFailureReport) => Promise<StartupRecoveryDecision>,
): Promise<boolean> {
  for (;;) {
    try {
      await start();
      return true;
    } catch (error) {
      const decision = await onFailure(startupFailureReport(error));
      if (decision === 'quit') return false;
    }
  }
}
