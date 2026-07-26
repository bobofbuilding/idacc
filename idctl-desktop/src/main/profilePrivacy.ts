import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { CONTEXT_BUDGET_RETENTION } from './contextBudgetRetention.ts';
import { copyFilePrivateSync } from './privateFileCopy.ts';

const WINDOWS_PROFILE_ACL_OK = 'IDACC_WINDOWS_PROFILE_ACL_OK';
const WINDOWS_PROFILE_ACL_FAILED = 'IDACC_WINDOWS_PROFILE_ACL_FAILED';
const WINDOWS_PROFILE_ACL_PARSE_LINE = 'IDACC_WINDOWS_PROFILE_ACL_PARSE_LINE';
const WINDOWS_PROFILE_NEWER = 'IDACC_WINDOWS_PROFILE_NEWER';
const WINDOWS_PROFILE_TOO_LARGE = 'IDACC_WINDOWS_PROFILE_TOO_LARGE';
const WINDOWS_PROFILE_ACL_TIMEOUT_MS = 2 * 60_000;
const WINDOWS_PROFILE_STREAMING_TIMEOUT_MS = 5 * 60_000;
const WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE = 100_000;
const WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASES = [
  'validate-root',
  'validate-volume',
  'configure-output',
  'compile-native',
  'configure-policy',
  'single-object-type',
  'single-ancestors',
  'single-parent-acl',
  'single-create',
  'single-object',
  'single-lock',
  'single-check',
  'single-apply',
  'single-verify',
  'single-identity',
  'ancestor-reparse',
  'ancestor-type',
  'parent-inspect',
  'parent-owner-untrusted',
  'parent-delete-child',
  'parent-delete-object',
  'parent-change-permissions',
  'parent-take-ownership',
  'parent-create-child',
  'parent-chain-incomplete',
  'profile-ancestors',
  'profile-compatibility',
  'profile-parent-acl',
  'profile-attestation-check',
  'profile-create',
  'profile-boundary',
  'profile-stream',
  'profile-enumerate',
  'profile-apply',
  'profile-reenumerate',
  'profile-verify',
  'profile-attestation-write',
  'profile-attestation-verify',
  'helper-path',
  'helper-launch',
  'helper-timeout',
  'helper-terminated',
  'helper-parse',
  'helper-host-error',
  'helper-no-marker',
  'helper-invalid-output',
] as const;
const WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASE_SET = new Set<string>(
  WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASES,
);

export type WindowsProfileAclDiagnosticPhase =
  typeof WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASES[number];

type WindowsProfileAclMode =
  | 'normal'
  | 'cache-boundary'
  | 'streaming-upgrade'
  | 'single-file'
  | 'single-directory';

export interface WindowsProfileAclRunResult {
  status: number | null;
  stdout?: string;
  stderrPresent?: boolean;
  error?: unknown;
  signal?: NodeJS.Signals | null;
  diagnosticPhase?: WindowsProfileAclDiagnosticPhase;
  diagnosticLine?: number;
}

export type WindowsProfileAclRunner = (
  root: string,
  maximumSchemaVersion?: number,
  mode?: WindowsProfileAclMode,
) => WindowsProfileAclRunResult;

export interface SecureWindowsProfileRootOptions {
  platform?: NodeJS.Platform;
  runner?: WindowsProfileAclRunner;
  maximumSchemaVersion?: number;
  allowLargeProfileUpgrade?: boolean;
}

export interface SecureWindowsPrivatePathOptions {
  platform?: NodeJS.Platform;
  runner?: WindowsProfileAclRunner;
}

function profilePrivacyError(
  subject = 'profile',
  diagnosticPhase?: WindowsProfileAclDiagnosticPhase,
  diagnosticLine?: number,
): NodeJS.ErrnoException {
  const error = new Error(
    `IDACC could not establish and verify private Windows access for this ${subject}.`,
  ) as NodeJS.ErrnoException;
  error.code = 'EPERM';
  if (diagnosticPhase) {
    Object.defineProperty(error, 'diagnosticPhase', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: diagnosticPhase,
    });
  }
  if (
    diagnosticPhase === 'helper-parse'
    && Number.isInteger(diagnosticLine)
    && Number(diagnosticLine) >= 1
    && Number(diagnosticLine) <= WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE
  ) {
    Object.defineProperty(error, 'diagnosticLine', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: diagnosticLine,
    });
  }
  return error;
}

/**
 * Return only the helper's closed, non-sensitive failure phase. Raw helper
 * output, paths, ACLs, SIDs, and operating-system exception text never cross
 * this boundary.
 */
export function windowsProfilePrivacyDiagnosticPhase(
  error: unknown,
): WindowsProfileAclDiagnosticPhase | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { diagnosticPhase?: unknown }).diagnosticPhase;
  return typeof value === 'string'
    && WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASE_SET.has(value)
    ? value as WindowsProfileAclDiagnosticPhase
    : undefined;
}

/**
 * Return only a bounded source line for a trusted helper parse failure. This
 * never contains the helper source, a filesystem path, ACL data, or exception
 * text, and the property remains non-enumerable on the public error object.
 */
export function windowsProfilePrivacyDiagnosticLine(
  error: unknown,
): number | undefined {
  if (
    windowsProfilePrivacyDiagnosticPhase(error) !== 'helper-parse'
    || !error
    || typeof error !== 'object'
  ) {
    return undefined;
  }
  const value = (error as { diagnosticLine?: unknown }).diagnosticLine;
  return Number.isInteger(value)
    && Number(value) >= 1
    && Number(value) <= WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE
    ? Number(value)
    : undefined;
}

function windowsProfileAclResultDiagnosticPhase(
  result: WindowsProfileAclRunResult,
): WindowsProfileAclDiagnosticPhase | undefined {
  if (
    typeof result.diagnosticPhase === 'string'
    && WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASE_SET.has(result.diagnosticPhase)
  ) {
    return result.diagnosticPhase;
  }
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = new RegExp(`^${WINDOWS_PROFILE_ACL_FAILED}:([a-z-]+)$`).exec(
      line.trim(),
    );
    if (
      match
      && WINDOWS_PROFILE_ACL_DIAGNOSTIC_PHASE_SET.has(match[1])
    ) {
      return match[1] as WindowsProfileAclDiagnosticPhase;
    }
  }
  return undefined;
}

function windowsProfileAclResultDiagnosticLine(
  result: WindowsProfileAclRunResult,
): number | undefined {
  if (
    Number.isInteger(result.diagnosticLine)
    && Number(result.diagnosticLine) >= 1
    && Number(result.diagnosticLine) <= WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE
  ) {
    return Number(result.diagnosticLine);
  }
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = new RegExp(`^${WINDOWS_PROFILE_ACL_PARSE_LINE}:(\\d+)$`).exec(
      line.trim(),
    );
    if (!match) continue;
    const value = Number(match[1]);
    if (
      Number.isInteger(value)
      && value >= 1
      && value <= WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE
    ) {
      return value;
    }
  }
  return undefined;
}

function windowsProfileAclFailureDiagnosticPhase(
  result: WindowsProfileAclRunResult,
  verified: boolean,
): WindowsProfileAclDiagnosticPhase | undefined {
  const emitted = windowsProfileAclResultDiagnosticPhase(result);
  if (emitted) return emitted;

  const errorCode = result.error && typeof result.error === 'object'
    ? String((result.error as NodeJS.ErrnoException).code || '').toUpperCase()
    : '';
  if (errorCode === 'ETIMEDOUT') return 'helper-timeout';
  if (result.error) return 'helper-launch';
  if (result.signal) return 'helper-terminated';
  if (result.stderrPresent) return 'helper-host-error';
  if (result.status === null) return 'helper-launch';
  if (result.status !== 0) {
    return 'helper-no-marker';
  }
  return verified ? undefined : 'helper-invalid-output';
}

/**
 * The Windows implementation accepts only ordinary drive-letter paths. UNC,
 * device, extended-length, and drive-root paths are rejected before invoking
 * the operating-system ACL helper.
 */
export function normalizeWindowsProfileRoot(root: string): string {
  if (typeof root !== 'string' || root.includes('\u0000')) throw profilePrivacyError();
  const normalized = win32.normalize(root.trim());
  if (!win32.isAbsolute(normalized)) throw profilePrivacyError();
  if (normalized.startsWith('\\\\') || normalized.startsWith('//')) {
    throw profilePrivacyError();
  }
  const parsed = win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) throw profilePrivacyError();
  if (win32.relative(parsed.root, normalized) === '') throw profilePrivacyError();
  // Alternate data streams are never valid profile roots.
  if (normalized.slice(parsed.root.length).includes(':')) throw profilePrivacyError();
  return normalized;
}

const WINDOWS_CACHE_QUARANTINE_PREFIX = '.idacc-cache-quarantine-';

function copyRetainedContextBudgetCache(
  sourceCache: string,
  destinationCache: string,
): void {
  const source = win32.join(sourceCache, 'context-budget');
  let sourceEntry;
  try {
    sourceEntry = lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) return;

  const destination = win32.join(destinationCache, 'context-budget');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const statsSource = win32.join(source, 'stats.json');
  try {
    const entry = lstatSync(statsSource);
    if (!entry.isSymbolicLink() && entry.isFile()) {
      copyFilePrivateSync(statsSource, win32.join(destination, 'stats.json'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const cutoff = Date.now()
    - CONTEXT_BUDGET_RETENTION.auditDays * 24 * 60 * 60 * 1_000;
  const records = readdirSync(source)
    .filter((name) => /^cb_.*\.json$/.test(name))
    .map((name) => {
      const path = win32.join(source, name);
      try {
        const entry = lstatSync(path);
        if (entry.isSymbolicLink() || !entry.isFile()) return null;
        return { name, path, mtime: entry.mtimeMs, bytes: entry.size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is {
      name: string;
      path: string;
      mtime: number;
      bytes: number;
    } => Boolean(entry))
    .sort((left, right) => right.mtime - left.mtime);

  let kept = 0;
  let bytes = 0;
  for (const record of records) {
    const withinBounds = record.mtime >= cutoff
      && kept < CONTEXT_BUDGET_RETENTION.maxAuditRecords
      && bytes + record.bytes <= CONTEXT_BUDGET_RETENTION.maxAuditBytes;
    if (!withinBounds) continue;
    copyFilePrivateSync(record.path, win32.join(destination, record.name));
    kept += 1;
    bytes += record.bytes;
  }
}

interface WindowsCacheUpgrade {
  cache: string;
  quarantine: string;
}

function hasWindowsCacheQuarantine(root: string): boolean {
  try {
    return readdirSync(root).some((name) => (
      name.startsWith(WINDOWS_CACHE_QUARANTINE_PREFIX)
    ));
  } catch {
    return false;
  }
}

function prepareOversizedWindowsCache(root: string): WindowsCacheUpgrade | null {
  const cache = win32.join(root, 'cache');
  const staleQuarantines = readdirSync(root)
    .filter((name) => name.startsWith(WINDOWS_CACHE_QUARANTINE_PREFIX));
  if (staleQuarantines.length > 1) throw profilePrivacyError();
  if (staleQuarantines.length === 1) {
    const stale = win32.join(root, staleQuarantines[0]);
    const staleEntry = lstatSync(stale);
    if (staleEntry.isSymbolicLink() || !staleEntry.isDirectory()) {
      throw profilePrivacyError();
    }
    if (existsSync(cache)) rmSync(cache, { recursive: true, force: true });
    renameSync(stale, cache);
  }

  if (!existsSync(cache)) return null;
  const cacheEntry = lstatSync(cache);
  if (cacheEntry.isSymbolicLink() || !cacheEntry.isDirectory()) {
    throw profilePrivacyError();
  }
  const quarantine = win32.join(
    root,
    `${WINDOWS_CACHE_QUARANTINE_PREFIX}${randomBytes(16).toString('hex')}`,
  );
  renameSync(cache, quarantine);
  mkdirSync(cache, { recursive: false, mode: 0o700 });
  try {
    copyRetainedContextBudgetCache(quarantine, cache);
  } catch (error) {
    try {
      rmSync(cache, { recursive: true, force: true });
      renameSync(quarantine, cache);
    } catch {
      // The private, randomly named quarantine remains the rollback source and
      // is restored before the next conversion attempt.
    }
    throw error;
  }
  return { cache, quarantine };
}

function rollbackOversizedWindowsCache(
  root: string,
  upgrade: WindowsCacheUpgrade,
): void {
  try { rmSync(win32.join(root, '.idacc-windows-acl-v3.json'), { force: true }); } catch { /* best effort */ }
  try { rmSync(upgrade.cache, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!existsSync(upgrade.cache) && existsSync(upgrade.quarantine)) {
    renameSync(upgrade.quarantine, upgrade.cache);
  }
}

/*
 * Windows PowerShell 5.1 is part of supported Windows desktop installations.
 * This script uses only .NET access-control APIs, receives the profile path via
 * a child-only environment value, and emits no path or exception details.
 *
 * The sequence is deliberately:
 *   1. prove local NTFS storage and safe ancestors;
 *   2. enumerate private state without following links or hard links;
 *   3. replace non-exact app-state DACLs, while treating existing user
 *      repository contents below workspace as an explicit opaque boundary;
 *   4. re-enumerate, verify, and write a versioned exact-root attestation.
 *
 * A protected DACL with only the interactive user and Local System prevents a
 * permissive parent folder from being inherited into profile files. Existing
 * child ACLs are replaced rather than trusted.
 */
export const WINDOWS_PROFILE_ACL_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $source = [Console]::In.ReadToEnd()
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput(
    $source,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if (@($parseErrors).Count -ne 0) {
    $firstLine = [int]$parseErrors[0].Extent.StartLineNumber
    if ($firstLine -lt 1 -or $firstLine -gt ${WINDOWS_PROFILE_ACL_MAX_DIAGNOSTIC_LINE}) {
      $firstLine = 1
    }
    [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_FAILED}:helper-parse')
    [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_PARSE_LINE}:{0}', $firstLine)
    exit 1
  }
  $scriptBlock = [ScriptBlock]::Create($source)
  $global:LASTEXITCODE = $null
  & $scriptBlock
  $invocationSucceeded = $?
  $invocationExitCode = $global:LASTEXITCODE
  if ($null -ne $invocationExitCode) {
    exit [int]$invocationExitCode
  }
  if ($invocationSucceeded) {
    exit 0
  }
  exit 1
} catch {
  [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_FAILED}:helper-host-error')
  exit 1
}
`;

export const WINDOWS_PROFILE_ACL_SCRIPT = String.raw`
$script:diagnosticPhase = 'configure-output'
try {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

  $script:diagnosticPhase = 'validate-root'
  $rootInput = [string]$env:IDACC_PROFILE_ACL_ROOT
  if ([string]::IsNullOrWhiteSpace($rootInput)) {
    throw 'missing profile root'
  }
  if ($rootInput.StartsWith('\\')) {
    throw 'network and device paths are not supported'
  }

  $root = [System.IO.Path]::GetFullPath($rootInput)
  $volumeRoot = [System.IO.Path]::GetPathRoot($root)
  if ([string]::IsNullOrWhiteSpace($volumeRoot) -or $volumeRoot.StartsWith('\\')) {
    throw 'unverifiable volume'
  }
  if ($root.Substring($volumeRoot.Length).Contains(':')) {
    throw 'alternate data streams are not supported'
  }

  $script:diagnosticPhase = 'validate-volume'
  $drive = [System.IO.DriveInfo]::new($volumeRoot)
  if (-not $drive.IsReady) {
    throw 'volume is unavailable'
  }
  if ($drive.DriveType -eq [System.IO.DriveType]::Network) {
    throw 'network volumes are not supported'
  }
  $driveFormat = [string]$drive.DriveFormat
  if ($driveFormat -ne 'NTFS') {
    throw 'volume does not enforce Windows ACLs'
  }

  $nativeSource = @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class IdaccProfileFileProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public FILETIME CreationTime;
    public FILETIME LastAccessTime;
    public FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
  }

  [DllImport(
    "kernel32.dll",
    CharSet = CharSet.Unicode,
    SetLastError = true,
    ExactSpelling = true
  )]
  private static extern SafeFileHandle CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle file,
    out BY_HANDLE_FILE_INFORMATION information
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle file,
    int fileInformationClass,
    out FILE_ID_INFO information,
    uint bufferSize
  );

  [DllImport(
    "advapi32.dll",
    CharSet = CharSet.Unicode,
    SetLastError = true,
    ExactSpelling = true
  )]
  private static extern bool SetFileSecurityW(
    string fileName,
    uint securityInformation,
    [In] byte[] securityDescriptor
  );

  [DllImport("advapi32.dll")]
  private static extern uint GetSecurityInfo(
    SafeFileHandle handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor
  );

  [DllImport(
    "advapi32.dll",
    CharSet = CharSet.Unicode,
    SetLastError = true,
    ExactSpelling = true
  )]
  private static extern bool
    ConvertSecurityDescriptorToStringSecurityDescriptorW(
      IntPtr securityDescriptor,
      uint requestedRevision,
      uint securityInformation,
      out IntPtr stringSecurityDescriptor,
      out uint stringSecurityDescriptorLength
    );

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  private static SafeFileHandle OpenProbe(
    string path,
    bool isDirectory,
    uint shareMode
  ) {
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint READ_CONTROL = 0x00020000;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if (isDirectory) {
      flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    SafeFileHandle file = CreateFileW(
      path,
      FILE_READ_ATTRIBUTES | READ_CONTROL,
      shareMode,
      IntPtr.Zero,
      OPEN_EXISTING,
      flags,
      IntPtr.Zero
    );
    if (file.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      file.Dispose();
      throw new Win32Exception(error);
    }
    return file;
  }

  private static BY_HANDLE_FILE_INFORMATION ReadInformation(
    SafeFileHandle file
  ) {
    BY_HANDLE_FILE_INFORMATION information;
    if (!GetFileInformationByHandle(file, out information)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return information;
  }

  private static string ReadIdentity(SafeFileHandle file) {
    const int FileIdInfo = 18;
    FILE_ID_INFO information;
    uint size = (uint)Marshal.SizeOf(typeof(FILE_ID_INFO));
    if (!GetFileInformationByHandleEx(
      file,
      FileIdInfo,
      out information,
      size
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return String.Format(
      CultureInfo.InvariantCulture,
      "{0:X16}:{1:X16}{2:X16}",
      information.VolumeSerialNumber,
      information.FileIdHigh,
      information.FileIdLow
    );
  }

  private static void AssertOrdinaryObject(
    BY_HANDLE_FILE_INFORMATION information,
    bool isDirectory
  ) {
    const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw new InvalidOperationException("reparse object");
    }
    bool actualDirectory =
      (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (actualDirectory != isDirectory) {
      throw new InvalidOperationException("object type changed");
    }
    if (!isDirectory && information.NumberOfLinks != 1) {
      throw new InvalidOperationException("hard-linked file");
    }
  }

  public sealed class LockedProfileObject : IDisposable {
    internal SafeFileHandle Handle { get; private set; }
    public string Identity { get; private set; }
    public bool IsDirectory { get; private set; }

    internal LockedProfileObject(
      SafeFileHandle handle,
      string identity,
      bool isDirectory
    ) {
      Handle = handle;
      Identity = identity;
      IsDirectory = isDirectory;
    }

    public void Dispose() {
      if (Handle != null) {
        Handle.Dispose();
        Handle = null;
      }
    }
  }

  private static void AssertLockedObject(LockedProfileObject locked) {
    if (
      locked == null ||
      locked.Handle == null ||
      locked.Handle.IsInvalid ||
      locked.Handle.IsClosed
    ) {
      throw new InvalidOperationException("profile object lock is unavailable");
    }
    BY_HANDLE_FILE_INFORMATION information = ReadInformation(locked.Handle);
    AssertOrdinaryObject(information, locked.IsDirectory);
    if (!String.Equals(
      ReadIdentity(locked.Handle),
      locked.Identity,
      StringComparison.Ordinal
    )) {
      throw new InvalidOperationException("profile object identity changed");
    }
  }

  public static LockedProfileObject OpenLockedObject(
    string path,
    bool isDirectory
  ) {
    const uint FILE_SHARE_READ = 0x00000001;
    SafeFileHandle file = OpenProbe(path, isDirectory, FILE_SHARE_READ);
    try {
      BY_HANDLE_FILE_INFORMATION information = ReadInformation(file);
      AssertOrdinaryObject(information, isDirectory);
      return new LockedProfileObject(
        file,
        ReadIdentity(file),
        isDirectory
      );
    } catch {
      file.Dispose();
      throw;
    }
  }

  public static string GetObjectIdentity(string path, bool isDirectory) {
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    using (SafeFileHandle file = OpenProbe(
      path,
      isDirectory,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    )) {
      BY_HANDLE_FILE_INFORMATION information = ReadInformation(file);
      AssertOrdinaryObject(information, isDirectory);
      return ReadIdentity(file);
    }
  }

  public static void AssertLockedPath(
    LockedProfileObject locked,
    string path
  ) {
    const uint FILE_SHARE_READ = 0x00000001;
    AssertLockedObject(locked);
    using (SafeFileHandle probe = OpenProbe(
      path,
      locked.IsDirectory,
      FILE_SHARE_READ
    )) {
      BY_HANDLE_FILE_INFORMATION information = ReadInformation(probe);
      AssertOrdinaryObject(information, locked.IsDirectory);
      if (!String.Equals(
        ReadIdentity(probe),
        locked.Identity,
        StringComparison.Ordinal
      )) {
        throw new InvalidOperationException("profile object identity changed");
      }
    }
    AssertLockedObject(locked);
  }

  public static string ReadLockedSecurityDescriptor(
    LockedProfileObject locked
  ) {
    const int SE_FILE_OBJECT = 1;
    const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const uint SDDL_REVISION_1 = 1;
    IntPtr owner;
    IntPtr group;
    IntPtr dacl;
    IntPtr sacl;
    IntPtr descriptor;
    AssertLockedObject(locked);
    uint result = GetSecurityInfo(
      locked.Handle,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner,
      out group,
      out dacl,
      out sacl,
      out descriptor
    );
    if (result != 0) {
      throw new Win32Exception((int)result);
    }
    IntPtr text = IntPtr.Zero;
    try {
      uint textLength;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
        descriptor,
        SDDL_REVISION_1,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        out text,
        out textLength
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      string value = Marshal.PtrToStringUni(text);
      if (String.IsNullOrWhiteSpace(value)) {
        throw new InvalidOperationException(
          "profile security descriptor is unavailable"
        );
      }
      AssertLockedObject(locked);
      return value;
    } finally {
      if (text != IntPtr.Zero) {
        LocalFree(text);
      }
      if (descriptor != IntPtr.Zero) {
        LocalFree(descriptor);
      }
    }
  }

  public static void SetSecurityWithoutPropagation(
    LockedProfileObject locked,
    string path,
    byte[] securityDescriptor
  ) {
    const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    // File-share locks govern data/namespace writers and deleters, not a
    // security-only WRITE_DAC handle. The PowerShell layer therefore retains
    // every lease through a second enumeration and exact post-verification;
    // fresh profiles establish the root descriptor before creating any state.
    AssertLockedPath(locked, path);
    if (!SetFileSecurityW(
      path,
      OWNER_SECURITY_INFORMATION |
        DACL_SECURITY_INFORMATION |
        PROTECTED_DACL_SECURITY_INFORMATION,
      securityDescriptor
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    AssertLockedPath(locked, path);
  }
}
'@
  $script:diagnosticPhase = 'compile-native'
  Add-Type -TypeDefinition $nativeSource -Language CSharp

  $script:diagnosticPhase = 'configure-policy'
  $reparseFlag = [System.IO.FileAttributes]::ReparsePoint
  $directoryFlag = [System.IO.FileAttributes]::Directory
  $workspaceRoot = [System.IO.Path]::Combine($root, 'workspace')
  $cacheRoot = [System.IO.Path]::Combine($root, 'cache')
  $profileMarkerPath = [System.IO.Path]::Combine($root, 'profile.json')
  $attestationPath = [System.IO.Path]::Combine(
    $root,
    '.idacc-windows-acl-v3.json'
  )
  $aclMode = [string]$env:IDACC_PROFILE_ACL_MODE
  if ([string]::IsNullOrWhiteSpace($aclMode)) {
    $aclMode = 'normal'
  }
  if (
    $aclMode -ne 'normal' -and
    $aclMode -ne 'cache-boundary' -and
    $aclMode -ne 'streaming-upgrade' -and
    $aclMode -ne 'single-file' -and
    $aclMode -ne 'single-directory'
  ) {
    throw 'invalid profile ACL mode'
  }
  $maximumProfileObjects = 4096
  $maximumStreamingProfileObjects = 100000
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $trustedInstallerSid = [System.Security.Principal.SecurityIdentifier]::new(
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  )
  $creatorOwnerSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-3-0')
  $ownerRightsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-3-4')
  if ($null -eq $userSid) {
    throw 'current user SID is unavailable'
  }
  $trustedAncestorSids = @(
    $userSid.Value,
    $systemSid.Value,
    $administratorsSid.Value,
    $trustedInstallerSid.Value,
    $creatorOwnerSid.Value,
    $ownerRightsSid.Value
  )

  function Assert-NotReparse([string]$path) {
    $attributes = [System.IO.File]::GetAttributes($path)
    if (($attributes -band $reparseFlag) -ne 0) {
      throw 'reparse points are not allowed'
    }
  }

  function Assert-SingleLink([string]$path) {
    [void][IdaccProfileFileProbe]::GetObjectIdentity($path, $false)
  }

  function Test-SamePath([string]$left, [string]$right) {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath($left).TrimEnd('\'),
      [System.IO.Path]::GetFullPath($right).TrimEnd('\'),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }

  function Assert-SafeAncestors([string]$path) {
    $probe = $path
    while (-not [System.IO.Directory]::Exists($probe)) {
      if ([System.IO.File]::Exists($probe)) {
        $script:diagnosticPhase = 'ancestor-type'
        throw 'profile root is not a directory'
      }
      $parent = [System.IO.Directory]::GetParent($probe)
      if ($null -eq $parent) {
        $script:diagnosticPhase = 'parent-chain-incomplete'
        throw 'profile parent is unavailable'
      }
      $probe = $parent.FullName
    }
    while ($true) {
      $script:diagnosticPhase = 'ancestor-reparse'
      Assert-NotReparse $probe
      if ([string]::Equals(
        [System.IO.Path]::GetFullPath($probe).TrimEnd('\'),
        [System.IO.Path]::GetFullPath($volumeRoot).TrimEnd('\'),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        break
      }
      $parent = [System.IO.Directory]::GetParent($probe)
      if ($null -eq $parent) {
        $script:diagnosticPhase = 'parent-chain-incomplete'
        throw 'profile ancestor is unavailable'
      }
      $probe = $parent.FullName
    }
  }

  function Assert-SafeParentAclChain([string]$profileRoot) {
    $deleteChildRight = (
      [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    )
    $deleteRight = [int][System.Security.AccessControl.FileSystemRights]::Delete
    $changePermissionsRight = (
      [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions
    )
    $takeOwnershipRight = (
      [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $createDirectoryRight = (
      [int][System.Security.AccessControl.FileSystemRights]::CreateDirectories
    )
    $profileRootWasMissing = (
      -not [System.IO.Directory]::Exists($profileRoot) -and
      -not [System.IO.File]::Exists($profileRoot)
    )
    $sections = (
      [System.Security.AccessControl.AccessControlSections]::Access -bor
      [System.Security.AccessControl.AccessControlSections]::Owner
    )
    $profileParent = [System.IO.Directory]::GetParent($profileRoot)
    if ($null -eq $profileParent) {
      $script:diagnosticPhase = 'parent-chain-incomplete'
      throw 'profile parent is unavailable'
    }
    $parent = $profileParent
    while ($null -ne $parent -and -not [System.IO.Directory]::Exists($parent.FullName)) {
      if ([System.IO.File]::Exists($parent.FullName)) {
        $script:diagnosticPhase = 'ancestor-type'
        throw 'profile parent is not a directory'
      }
      $parent = $parent.Parent
    }
    if ($null -eq $parent) {
      $script:diagnosticPhase = 'parent-chain-incomplete'
      throw 'profile parent chain is incomplete'
    }
    # This is the parent on which CreateDirectory will create the first missing
    # segment. InheritOnly ACEs elsewhere in the chain do not necessarily reach
    # this path because an intervening directory can protect its DACL.
    $creationBoundary = $parent
    while ($null -ne $parent) {
      $script:diagnosticPhase = 'ancestor-reparse'
      Assert-NotReparse $parent.FullName
      $script:diagnosticPhase = 'parent-inspect'
      $security = [System.IO.Directory]::GetAccessControl($parent.FullName, $sections)
      $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($trustedAncestorSids -notcontains $owner.Value) {
        $script:diagnosticPhase = 'parent-owner-untrusted'
        throw 'profile parent owner is not trusted'
      }
      $rules = @($security.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
      ))
      $isCreationBoundary = Test-SamePath $creationBoundary.FullName $parent.FullName
      $isVolumeRoot = Test-SamePath $parent.FullName $volumeRoot
      foreach ($rule in $rules) {
        if (
          $rule.AccessControlType -ne
          [System.Security.AccessControl.AccessControlType]::Allow
        ) {
          continue
        }
        if ($trustedAncestorSids -contains $rule.IdentityReference.Value) {
          continue
        }
        $rights = [int]$rule.FileSystemRights
        # When any segment is missing, an untrusted principal that can create a
        # child at the boundary can win the path race and retain an open handle
        # even after the new tree is hardened.
        $dangerousPhase = $null
        if (($rights -band $deleteChildRight) -ne 0) {
          $dangerousPhase = 'parent-delete-child'
        } elseif (
          -not $isVolumeRoot -and
          (($rights -band $deleteRight) -ne 0)
        ) {
          $dangerousPhase = 'parent-delete-object'
        } elseif (($rights -band $changePermissionsRight) -ne 0) {
          $dangerousPhase = 'parent-change-permissions'
        } elseif (($rights -band $takeOwnershipRight) -ne 0) {
          $dangerousPhase = 'parent-take-ownership'
        } elseif (
          $profileRootWasMissing -and
          $isCreationBoundary -and
          (($rights -band $createDirectoryRight) -ne 0)
        ) {
          $dangerousPhase = 'parent-create-child'
        }
        if ($null -eq $dangerousPhase) {
          continue
        }
        $inheritOnly = (
          (
            $rule.PropagationFlags -band
            [System.Security.AccessControl.PropagationFlags]::InheritOnly
          ) -ne 0
        )
        $appliesToChildDirectory = (
          (
            $rule.InheritanceFlags -band
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
          ) -ne 0
        )
        # An InheritOnly ContainerInherit ACE matters at the nearest existing
        # creation boundary. If it propagates farther, it appears again on the
        # next actual parent; treating every higher ancestor as effective would
        # reject normal Windows roots even when C:\Users breaks inheritance.
        if (
          -not $inheritOnly -or
          ($isCreationBoundary -and $appliesToChildDirectory)
        ) {
          $script:diagnosticPhase = $dangerousPhase
          throw 'profile parent can be replaced by another principal'
        }
      }
      if ([string]::Equals(
        [System.IO.Path]::GetFullPath($parent.FullName).TrimEnd('\'),
        [System.IO.Path]::GetFullPath($volumeRoot).TrimEnd('\'),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        break
      }
      $parent = $parent.Parent
    }
    if ($null -eq $parent) {
      $script:diagnosticPhase = 'parent-chain-incomplete'
      throw 'profile parent chain is incomplete'
    }
  }

  function Get-ProfileObjects([string]$profileRoot) {
    $objects = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($profileRoot)
    try {
      while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        Assert-NotReparse $current
        $locked = [IdaccProfileFileProbe]::OpenLockedObject($current, $true)
        $objects.Add([pscustomobject]@{
          Path = $current
          IsDirectory = $true
          Identity = $locked.Identity
          Lock = $locked
        })
        if ($objects.Count -gt $maximumProfileObjects) {
          [Console]::Out.WriteLine('${WINDOWS_PROFILE_TOO_LARGE}')
          exit 43
        }
        # Existing user repositories are deliberately opaque. Secure only the
        # workspace root; its inheritable ACEs protect future direct children,
        # while SetFileSecurityW below does not rewrite existing descendants.
        # Existing descendant ACLs remain user-managed and continue to govern
        # direct access to known child paths.
        if (
          (Test-SamePath $current $workspaceRoot) -or
          (Test-IsCacheQuarantine $current)
        ) {
          continue
        }
        foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
          $attributes = [System.IO.File]::GetAttributes($child)
          if (($attributes -band $reparseFlag) -ne 0) {
            throw 'reparse points are not allowed'
          }
          if (($attributes -band $directoryFlag) -ne 0) {
            $pending.Push($child)
          } else {
            $locked = [IdaccProfileFileProbe]::OpenLockedObject($child, $false)
            $objects.Add([pscustomobject]@{
              Path = $child
              IsDirectory = $false
              Identity = $locked.Identity
              Lock = $locked
            })
            if ($objects.Count -gt $maximumProfileObjects) {
              [Console]::Out.WriteLine('${WINDOWS_PROFILE_TOO_LARGE}')
              exit 43
            }
          }
        }
      }
      return $objects
    } catch {
      foreach ($item in $objects) {
        if ($null -ne $item.Lock) {
          $item.Lock.Dispose()
        }
      }
      throw
    }
  }

  function Close-ProfileObjects([object[]]$objects) {
    foreach ($item in @($objects)) {
      if ($null -ne $item -and $null -ne $item.Lock) {
        try {
          $item.Lock.Dispose()
        } catch {
          # The descriptor operation has already completed or failed closed.
        }
      }
    }
  }

  function New-PrivateDirectorySecurity([bool]$inheritToChildren) {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($userSid)
    $security.SetAccessRuleProtection($true, $false)
    if ($inheritToChildren) {
      $inheritance = (
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      )
    } else {
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @($userSid, $systemSid)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      [void]$security.AddAccessRule($rule)
    }
    return $security
  }

  function New-PrivateFileSecurity {
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetOwner($userSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $systemSid)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      [void]$security.AddAccessRule($rule)
    }
    return $security
  }

  function Set-PrivateAcl([object]$item) {
    Assert-NotReparse $item.Path
    $locked = $item.Lock
    $ownsLock = $false
    if ($null -eq $locked) {
      $locked = [IdaccProfileFileProbe]::OpenLockedObject(
        $item.Path,
        [bool]$item.IsDirectory
      )
      $ownsLock = $true
    }
    try {
      if (
        -not [string]::IsNullOrWhiteSpace([string]$item.Identity) -and
        [string]$item.Identity -ne $locked.Identity
      ) {
        throw 'profile object identity changed'
      }
      if ($item.IsDirectory) {
        $security = New-PrivateDirectorySecurity $true
      } else {
        $security = New-PrivateFileSecurity
      }
      # SetFileSecurity applies the exact descriptor only to this path. Unlike
      # SetNamedSecurityInfo (used by Directory.SetAccessControl), it does not
      # automatically propagate ACL changes into existing child objects.
      [IdaccProfileFileProbe]::SetSecurityWithoutPropagation(
        $locked,
        $item.Path,
        $security.GetSecurityDescriptorBinaryForm()
      )
    } finally {
      if ($ownsLock) {
        $locked.Dispose()
      }
    }
  }

  function Test-PrivateAcl([object]$item) {
    $locked = $item.Lock
    $ownsLock = $false
    try {
      Assert-NotReparse $item.Path
      if ($null -eq $locked) {
        $locked = [IdaccProfileFileProbe]::OpenLockedObject(
          $item.Path,
          [bool]$item.IsDirectory
        )
        $ownsLock = $true
      }
      if (
        -not [string]::IsNullOrWhiteSpace([string]$item.Identity) -and
        [string]$item.Identity -ne $locked.Identity
      ) {
        return $false
      }
      [IdaccProfileFileProbe]::AssertLockedPath($locked, $item.Path)
      $sections = (
        [System.Security.AccessControl.AccessControlSections]::Access -bor
        [System.Security.AccessControl.AccessControlSections]::Owner
      )
      $sddl = [IdaccProfileFileProbe]::ReadLockedSecurityDescriptor($locked)
      if ($item.IsDirectory) {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $expectedInheritance = (
          [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
          [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        )
      } else {
        $security = [System.Security.AccessControl.FileSecurity]::new()
        $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None
      }
      $security.SetSecurityDescriptorSddlForm($sddl, $sections)

      if (-not $security.AreAccessRulesProtected) {
        return $false
      }
      $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($owner.Value -ne $userSid.Value) {
        return $false
      }

      $rules = @($security.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
      ))
      if ($rules.Count -ne 2) {
        return $false
      }
      foreach ($allowedSid in @($userSid, $systemSid)) {
        $matches = @($rules | Where-Object {
          $_.IdentityReference.Value -eq $allowedSid.Value
        })
        if ($matches.Count -ne 1) {
          return $false
        }
        $rule = $matches[0]
        if (
          $rule.IsInherited -or
          $rule.AccessControlType -ne
            [System.Security.AccessControl.AccessControlType]::Allow -or
          [int]$rule.FileSystemRights -ne
            [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
          $rule.InheritanceFlags -ne $expectedInheritance -or
          $rule.PropagationFlags -ne
            [System.Security.AccessControl.PropagationFlags]::None
        ) {
          return $false
        }
      }
      [IdaccProfileFileProbe]::AssertLockedPath($locked, $item.Path)
      return $true
    } catch {
      return $false
    } finally {
      if ($ownsLock -and $null -ne $locked) {
        $locked.Dispose()
      }
    }
  }

  function Assert-PrivateAcl([object]$item) {
    if (-not (Test-PrivateAcl $item)) {
      throw 'profile object ACL verification failed'
    }
  }

  function Assert-CompatibleProfileMarker {
    $maximumSchemaText = [string]$env:IDACC_PROFILE_MAX_SCHEMA_VERSION
    if ([string]::IsNullOrWhiteSpace($maximumSchemaText)) {
      return
    }
    $maximumSchemaVersion = 0
    if (
      -not [int]::TryParse(
        $maximumSchemaText,
        [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$maximumSchemaVersion
      ) -or
      $maximumSchemaVersion -lt 0
    ) {
      throw 'invalid maximum profile schema version'
    }
    if (-not [System.IO.Directory]::Exists($root)) {
      return
    }
    Assert-NotReparse $root
    if ([System.IO.Directory]::Exists($profileMarkerPath)) {
      throw 'profile marker is not a regular file'
    }
    if (-not [System.IO.File]::Exists($profileMarkerPath)) {
      return
    }
    Assert-NotReparse $profileMarkerPath
    $markerLock = [IdaccProfileFileProbe]::OpenLockedObject(
      $profileMarkerPath,
      $false
    )
    try {
      $markerInfo = [System.IO.FileInfo]::new($profileMarkerPath)
      if ($markerInfo.Length -gt 1048576) {
        throw 'profile marker exceeds the compatibility limit'
      }
      $rawMarker = [System.IO.File]::ReadAllText(
        $profileMarkerPath,
        [System.Text.UTF8Encoding]::new($false, $true)
      )
      [IdaccProfileFileProbe]::AssertLockedPath(
        $markerLock,
        $profileMarkerPath
      )
    } finally {
      $markerLock.Dispose()
    }
    $marker = $rawMarker | ConvertFrom-Json
    if ($null -eq $marker -or $marker -isnot [psobject]) {
      throw 'profile marker is invalid'
    }
    $schemaValue = $marker.schemaVersion
    $numericSchema = (
      $schemaValue -is [byte] -or
      $schemaValue -is [sbyte] -or
      $schemaValue -is [short] -or
      $schemaValue -is [ushort] -or
      $schemaValue -is [int] -or
      $schemaValue -is [uint] -or
      $schemaValue -is [long] -or
      $schemaValue -is [ulong] -or
      $schemaValue -is [decimal] -or
      $schemaValue -is [single] -or
      $schemaValue -is [double]
    )
    if (-not $numericSchema) {
      throw 'profile marker schema version is invalid'
    }
    $schemaNumber = [double]$schemaValue
    if (
      [double]::IsNaN($schemaNumber) -or
      [double]::IsInfinity($schemaNumber) -or
      $schemaNumber -lt 0 -or
      [Math]::Truncate($schemaNumber) -ne $schemaNumber
    ) {
      throw 'profile marker schema version is invalid'
    }
    if ($schemaNumber -gt $maximumSchemaVersion) {
      [Console]::Out.WriteLine('${WINDOWS_PROFILE_NEWER}')
      exit 42
    }
  }

  function Test-AclAttestation {
    if (-not [System.IO.Directory]::Exists($root)) {
      return $false
    }
    if ([System.IO.Directory]::Exists($profileMarkerPath)) {
      throw 'profile marker is not a regular file'
    }
    if (-not [System.IO.File]::Exists($profileMarkerPath)) {
      return $false
    }
    Assert-NotReparse $profileMarkerPath
    Assert-SingleLink $profileMarkerPath
    if ([System.IO.Directory]::Exists($attestationPath)) {
      throw 'profile ACL attestation is not a regular file'
    }
    if (-not [System.IO.File]::Exists($attestationPath)) {
      return $false
    }
    Assert-NotReparse $attestationPath
    Assert-SingleLink $attestationPath
    if (-not (Test-PrivateAcl ([pscustomobject]@{
      Path = $root
      IsDirectory = $true
    }))) {
      return $false
    }
    if (-not (Test-PrivateAcl ([pscustomobject]@{
      Path = $attestationPath
      IsDirectory = $false
    }))) {
      return $false
    }
    if (-not (Test-PrivateAcl ([pscustomobject]@{
      Path = $profileMarkerPath
      IsDirectory = $false
    }))) {
      return $false
    }
    if ([System.IO.Directory]::Exists($workspaceRoot)) {
      Assert-NotReparse $workspaceRoot
      if (-not (Test-PrivateAcl ([pscustomobject]@{
        Path = $workspaceRoot
        IsDirectory = $true
      }))) {
        return $false
      }
    } elseif ([System.IO.File]::Exists($workspaceRoot)) {
      throw 'workspace root is not a directory'
    }
    try {
      $attestation = (
        [System.IO.File]::ReadAllText($attestationPath) | ConvertFrom-Json
      )
      return (
        [int]$attestation.version -eq 3 -and
        [string]$attestation.userSid -eq $userSid.Value -and
        [string]$attestation.workspacePolicy -eq 'root-only'
      )
    } catch {
      return $false
    }
  }

  function Write-AclAttestation {
    $attestation = [ordered]@{
      version = 3
      userSid = $userSid.Value
      workspacePolicy = 'root-only'
    }
    $json = $attestation | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText(
      $attestationPath,
      $json + [Environment]::NewLine,
      [System.Text.UTF8Encoding]::new($false)
    )
    $item = [pscustomobject]@{ Path = $attestationPath; IsDirectory = $false }
    Set-PrivateAcl $item
    Assert-SingleLink $attestationPath
    Assert-PrivateAcl $item
  }

  function Test-IsCacheQuarantine([string]$path) {
    $parent = [System.IO.Path]::GetDirectoryName(
      [System.IO.Path]::GetFullPath($path)
    )
    $name = [System.IO.Path]::GetFileName($path)
    return (
      (Test-SamePath $parent $root) -and
      $name.StartsWith(
        '${WINDOWS_CACHE_QUARANTINE_PREFIX}',
        [System.StringComparison]::OrdinalIgnoreCase
      )
    )
  }

  function Secure-CacheBoundary {
    $count = 0
    foreach ($path in @($root, $cacheRoot)) {
      if (-not [System.IO.Directory]::Exists($path)) {
        if ([System.IO.File]::Exists($path)) {
          throw 'cache privacy boundary is not a directory'
        }
        continue
      }
      Assert-NotReparse $path
      $item = [pscustomobject]@{ Path = $path; IsDirectory = $true }
      if (-not (Test-PrivateAcl $item)) {
        Set-PrivateAcl $item
      }
      Assert-PrivateAcl $item
      $count += 1
    }
    foreach ($path in [System.IO.Directory]::EnumerateFileSystemEntries($root)) {
      if (-not (Test-IsCacheQuarantine $path)) {
        continue
      }
      if (-not [System.IO.Directory]::Exists($path)) {
        throw 'cache quarantine boundary is not a directory'
      }
      Assert-NotReparse $path
      $item = [pscustomobject]@{ Path = $path; IsDirectory = $true }
      if (-not (Test-PrivateAcl $item)) {
        Set-PrivateAcl $item
      }
      Assert-PrivateAcl $item
      $count += 1
    }
    return $count
  }

  function Convert-ProfileObjectsStreaming([string]$profileRoot) {
    # OpenLockedObject requests share-read only. Windows sharing is symmetric:
    # any pre-existing write/delete-capable handle makes the conversion fail,
    # and securing each parent before enumerating its children prevents new
    # dangerous handles after that parent lock closes.
    $count = 0
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($profileRoot)
    while ($pending.Count -gt 0) {
      $current = $pending.Pop()
      Assert-NotReparse $current
      $directory = [pscustomobject]@{
        Path = $current
        IsDirectory = $true
      }
      if (-not (Test-PrivateAcl $directory)) {
        Set-PrivateAcl $directory
      }
      Assert-PrivateAcl $directory
      $count += 1
      if ($count -gt $maximumStreamingProfileObjects) {
        throw 'streaming profile ACL conversion exceeded its object limit'
      }
      if (
        (Test-SamePath $current $workspaceRoot) -or
        (Test-IsCacheQuarantine $current)
      ) {
        continue
      }
      foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
        $attributes = [System.IO.File]::GetAttributes($child)
        if (($attributes -band $reparseFlag) -ne 0) {
          throw 'reparse points are not allowed'
        }
        if (($attributes -band $directoryFlag) -ne 0) {
          $pending.Push($child)
          continue
        }
        $file = [pscustomobject]@{ Path = $child; IsDirectory = $false }
        if (-not (Test-PrivateAcl $file)) {
          Set-PrivateAcl $file
        }
        Assert-PrivateAcl $file
        $count += 1
        if ($count -gt $maximumStreamingProfileObjects) {
          throw 'streaming profile ACL conversion exceeded its object limit'
        }
      }
    }
    return $count
  }

  if ($aclMode -eq 'single-file' -or $aclMode -eq 'single-directory') {
    $script:diagnosticPhase = 'single-object-type'
    $singleIsDirectory = $aclMode -eq 'single-directory'
    if ($singleIsDirectory) {
      if ([System.IO.File]::Exists($root)) {
        throw 'private directory is not a directory'
      }
      $script:diagnosticPhase = 'single-ancestors'
      Assert-SafeAncestors $root
      $script:diagnosticPhase = 'single-parent-acl'
      Assert-SafeParentAclChain $root
      if (-not [System.IO.Directory]::Exists($root)) {
        $script:diagnosticPhase = 'single-create'
        [void][System.IO.Directory]::CreateDirectory($root)
        $script:diagnosticPhase = 'single-ancestors'
        Assert-SafeAncestors $root
        $script:diagnosticPhase = 'single-parent-acl'
        Assert-SafeParentAclChain $root
      }
    } else {
      if (-not [System.IO.File]::Exists($root)) {
        throw 'private file is unavailable'
      }
      $singleParent = [System.IO.Directory]::GetParent($root)
      if ($null -eq $singleParent) {
        throw 'private file parent is unavailable'
      }
      $script:diagnosticPhase = 'single-ancestors'
      Assert-SafeAncestors $singleParent.FullName
      $script:diagnosticPhase = 'single-parent-acl'
      Assert-SafeParentAclChain $root
    }
    $script:diagnosticPhase = 'single-object'
    Assert-NotReparse $root
    $script:diagnosticPhase = 'single-lock'
    $singleLock = [IdaccProfileFileProbe]::OpenLockedObject(
      $root,
      $singleIsDirectory
    )
    try {
      $singleItem = [pscustomobject]@{
        Path = $root
        IsDirectory = $singleIsDirectory
        Identity = $singleLock.Identity
        Lock = $singleLock
      }
      $script:diagnosticPhase = 'single-check'
      if (-not (Test-PrivateAcl $singleItem)) {
        $script:diagnosticPhase = 'single-apply'
        Set-PrivateAcl $singleItem
      }
      $script:diagnosticPhase = 'single-verify'
      Assert-PrivateAcl $singleItem
      $script:diagnosticPhase = 'single-identity'
      [IdaccProfileFileProbe]::AssertLockedPath($singleLock, $root)
    } finally {
      $singleLock.Dispose()
    }
    [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_OK}:1')
    exit 0
  }

  $script:diagnosticPhase = 'profile-ancestors'
  Assert-SafeAncestors $root
  $script:diagnosticPhase = 'profile-compatibility'
  Assert-CompatibleProfileMarker
  $script:diagnosticPhase = 'profile-parent-acl'
  Assert-SafeParentAclChain $root
  if ([System.IO.File]::Exists($root)) {
    throw 'profile root is not a directory'
  }
  $script:diagnosticPhase = 'profile-attestation-check'
  if ($aclMode -eq 'normal' -and (Test-AclAttestation)) {
    [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_OK}:0')
    exit 0
  }
  $script:diagnosticPhase = 'profile-create'
  [void][System.IO.Directory]::CreateDirectory($root)
  $script:diagnosticPhase = 'profile-ancestors'
  Assert-SafeAncestors $root
  $script:diagnosticPhase = 'profile-parent-acl'
  Assert-SafeParentAclChain $root

  if ($aclMode -eq 'cache-boundary') {
    $script:diagnosticPhase = 'profile-boundary'
    $boundaryCount = Secure-CacheBoundary
    [Console]::Out.WriteLine(
      '${WINDOWS_PROFILE_ACL_OK}:{0}',
      $boundaryCount
    )
    exit 0
  }

  if ($aclMode -eq 'streaming-upgrade') {
    $script:diagnosticPhase = 'profile-stream'
    $firstStreamingCount = Convert-ProfileObjectsStreaming $root
    $secondStreamingCount = Convert-ProfileObjectsStreaming $root
    if ($firstStreamingCount -ne $secondStreamingCount) {
      throw 'profile tree changed during streaming ACL conversion'
    }
    if ([System.IO.File]::Exists($profileMarkerPath)) {
      $script:diagnosticPhase = 'profile-attestation-write'
      Write-AclAttestation
      $script:diagnosticPhase = 'profile-attestation-verify'
      if (-not (Test-AclAttestation)) {
        throw 'profile ACL attestation verification failed'
      }
    } elseif ([System.IO.Directory]::Exists($profileMarkerPath)) {
      throw 'profile marker is not a regular file'
    }
    [Console]::Out.WriteLine(
      '${WINDOWS_PROFILE_ACL_OK}:{0}',
      $secondStreamingCount
    )
    exit 0
  }

  $objects = @()
  $verifiedObjects = @()
  $verifiedCount = 0
  try {
    $script:diagnosticPhase = 'profile-enumerate'
    $objects = @(Get-ProfileObjects $root)
    foreach ($item in $objects) {
      if (-not (Test-PrivateAcl $item)) {
        $script:diagnosticPhase = 'profile-apply'
        Set-PrivateAcl $item
      }
    }

    # Re-enumeration catches replacements or new reparse points introduced while
    # the original tree was being hardened. Both object generations stay locked
    # until exact ACL and stable 128-bit identity verification completes.
    $script:diagnosticPhase = 'profile-ancestors'
    Assert-SafeAncestors $root
    $script:diagnosticPhase = 'profile-parent-acl'
    Assert-SafeParentAclChain $root
    $script:diagnosticPhase = 'profile-reenumerate'
    $verifiedObjects = @(Get-ProfileObjects $root)
    $script:diagnosticPhase = 'profile-verify'
    foreach ($item in $verifiedObjects) {
      Assert-PrivateAcl $item
    }
    $verifiedCount = $verifiedObjects.Count
  } finally {
    Close-ProfileObjects $verifiedObjects
    Close-ProfileObjects $objects
  }

  # A newly created root is intentionally left truly empty so an interrupted
  # bootstrap remains a valid explicit data-directory selection. Once profile
  # metadata exists, the next launch records the versioned steady-state proof.
  if ([System.IO.File]::Exists($profileMarkerPath)) {
    $script:diagnosticPhase = 'profile-attestation-write'
    Write-AclAttestation
    $script:diagnosticPhase = 'profile-attestation-verify'
    if (-not (Test-AclAttestation)) {
      throw 'profile ACL attestation verification failed'
    }
  } elseif ([System.IO.Directory]::Exists($profileMarkerPath)) {
    throw 'profile marker is not a regular file'
  }

  [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_OK}:{0}', $verifiedCount)
  exit 0
} catch {
  [Console]::Out.WriteLine(
    '${WINDOWS_PROFILE_ACL_FAILED}:{0}',
    $script:diagnosticPhase
  )
  exit 1
}
`;

function windowsPowerShellPath(): string {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim();
  if (!systemRoot || !win32.isAbsolute(systemRoot) || systemRoot.startsWith('\\\\')) {
    throw profilePrivacyError();
  }
  return win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function defaultWindowsProfileAclRunner(
  root: string,
  maximumSchemaVersion?: number,
  mode: WindowsProfileAclMode = 'normal',
): WindowsProfileAclRunResult {
  let executable: string;
  try {
    executable = windowsPowerShellPath();
  } catch {
    return { status: null, diagnosticPhase: 'helper-path' };
  }
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot || process.env.WINDIR,
    WINDIR: process.env.WINDIR || process.env.SystemRoot,
    IDACC_PROFILE_ACL_ROOT: root,
    IDACC_PROFILE_ACL_MODE: mode,
    ...(Number.isInteger(maximumSchemaVersion) && Number(maximumSchemaVersion) >= 0
      ? { IDACC_PROFILE_MAX_SCHEMA_VERSION: String(maximumSchemaVersion) }
      : {}),
  };
  for (const key of ['ComSpec', 'PSModulePath', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-InputFormat',
    'Text',
    '-OutputFormat',
    'Text',
    '-Command',
    WINDOWS_PROFILE_ACL_BOOTSTRAP,
  ], {
    encoding: 'utf8',
    env: environment,
    // The helper is intentionally delivered over the child's private stdin.
    // Its UTF-16 Base64 representation exceeds Windows' 32,767-character
    // CreateProcess command-line limit and must never be placed in argv.
    input: WINDOWS_PROFILE_ACL_SCRIPT,
    maxBuffer: 1024 * 1024,
    timeout: mode === 'streaming-upgrade'
      ? WINDOWS_PROFILE_STREAMING_TIMEOUT_MS
      : WINDOWS_PROFILE_ACL_TIMEOUT_MS,
    windowsHide: true,
  });
  const stderr = String(result.stderr || '').replaceAll('\u0000', '');
  return {
    status: result.status,
    stdout: String(result.stdout || '').replaceAll('\u0000', ''),
    stderrPresent: Boolean(stderr.trim()),
    error: result.error,
    signal: result.signal,
  };
}

/**
 * Establish and verify an exact protected DACL for one app-owned object.
 *
 * This is the bounded counterpart to the recursive profile hardener. It is
 * used for global application state that lives beside Chromium-managed data,
 * where recursively walking the entire Electron userData tree for every state
 * update would be both unnecessary and unbounded. Directories receive
 * inheritable full-control ACEs for only the current user and Local System;
 * files receive the same two exact, non-inheriting ACEs. The native helper
 * keeps a share-read-only identity lock across replacement and verification.
 */
export function secureWindowsPrivatePath(
  path: string,
  kind: 'file' | 'directory',
  options: SecureWindowsPrivatePathOptions = {},
): string {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return path;
  const normalized = normalizeWindowsProfileRoot(path);
  const runner = options.runner || defaultWindowsProfileAclRunner;
  let result: WindowsProfileAclRunResult;
  try {
    result = runner(
      normalized,
      undefined,
      kind === 'directory' ? 'single-directory' : 'single-file',
    );
  } catch {
    throw profilePrivacyError('application-state path', 'helper-launch');
  }
  const verified = String(result.stdout || '').split(/\r?\n/).some((line) => (
    line.trim() === `${WINDOWS_PROFILE_ACL_OK}:1`
  ));
  const diagnosticPhase = windowsProfileAclFailureDiagnosticPhase(
    result,
    verified,
  );
  if (
    result.status !== 0
    || result.error
    || result.signal
    || diagnosticPhase
    || !verified
  ) {
    throw profilePrivacyError(
      'application-state path',
      diagnosticPhase,
      windowsProfileAclResultDiagnosticLine(result),
    );
  }
  return normalized;
}

/**
 * On Windows, POSIX mode bits do not distinguish owner/group/other. This
 * function is therefore the confidentiality boundary for app-owned profile
 * state and must run before that state is read or written. Existing user
 * repository descendants below workspace retain their own ACLs by design;
 * the workspace root is secured with inheritance for content created later.
 * Other platforms are unchanged.
 */
export function secureWindowsProfileRoot(
  root: string,
  options: SecureWindowsProfileRootOptions = {},
): string {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return root;
  if (
    options.maximumSchemaVersion !== undefined
    && (
      !Number.isInteger(options.maximumSchemaVersion)
      || options.maximumSchemaVersion < 0
    )
  ) {
    throw profilePrivacyError();
  }
  if (
    options.allowLargeProfileUpgrade !== undefined
    && typeof options.allowLargeProfileUpgrade !== 'boolean'
  ) {
    throw profilePrivacyError();
  }
  const normalized = normalizeWindowsProfileRoot(root);
  const runner = options.runner || defaultWindowsProfileAclRunner;
  const runMode = (mode: WindowsProfileAclMode): WindowsProfileAclRunResult => {
    try {
      return runner(normalized, options.maximumSchemaVersion, mode);
    } catch {
      throw profilePrivacyError('profile', 'helper-launch');
    }
  };
  const hasLine = (result: WindowsProfileAclRunResult, expected: string): boolean => (
    String(result.stdout || '').split(/\r?\n/).some((line) => (
      line.trim() === expected
    ))
  );
  const assertNotNewer = (result: WindowsProfileAclRunResult): void => {
    if (result.status === 42 && hasLine(result, WINDOWS_PROFILE_NEWER)) {
      throw new Error('This IDACC profile was created by a newer application version.');
    }
  };
  const isTooLarge = (result: WindowsProfileAclRunResult): boolean => (
    result.status === 43 && hasLine(result, WINDOWS_PROFILE_TOO_LARGE)
  );
  const assertSuccess = (result: WindowsProfileAclRunResult): void => {
    assertNotNewer(result);
    const verified = String(result.stdout || '').split(/\r?\n/).some((line) => (
      new RegExp(`^${WINDOWS_PROFILE_ACL_OK}:\\d+$`).test(line.trim())
    ));
    const diagnosticPhase = windowsProfileAclFailureDiagnosticPhase(
      result,
      verified,
    );
    if (
      result.status !== 0
      || result.error
      || result.signal
      || diagnosticPhase
      || !verified
    ) {
      throw profilePrivacyError(
        'profile',
        diagnosticPhase,
        windowsProfileAclResultDiagnosticLine(result),
      );
    }
  };

  let cacheUpgrade: WindowsCacheUpgrade | null = null;
  const canRunNativeUpgrade = (
    !options.runner
    && platform === process.platform
    && options.allowLargeProfileUpgrade !== false
  );
  let result: WindowsProfileAclRunResult;
  if (canRunNativeUpgrade && hasWindowsCacheQuarantine(normalized)) {
    const boundaryResult = runMode('cache-boundary');
    assertSuccess(boundaryResult);
    try {
      cacheUpgrade = prepareOversizedWindowsCache(normalized);
    } catch {
      throw profilePrivacyError();
    }
    result = runMode('normal');
  } else {
    result = runMode('normal');
  }
  assertNotNewer(result);
  if (isTooLarge(result)) {
    if (!canRunNativeUpgrade) {
      throw profilePrivacyError();
    }
    if (!cacheUpgrade) {
      const boundaryResult = runMode('cache-boundary');
      assertSuccess(boundaryResult);
      try {
        cacheUpgrade = prepareOversizedWindowsCache(normalized);
      } catch {
        throw profilePrivacyError();
      }
      result = runMode('normal');
      assertNotNewer(result);
    }
    if (isTooLarge(result)) {
      result = runMode('streaming-upgrade');
    }
  }
  try {
    assertSuccess(result);
    if (cacheUpgrade) {
      rmSync(cacheUpgrade.quarantine, { recursive: true, force: true });
    }
  } catch (error) {
    if (cacheUpgrade) {
      try {
        rollbackOversizedWindowsCache(normalized, cacheUpgrade);
      } catch {
        throw profilePrivacyError();
      }
    }
    if (
      error instanceof Error
      && /created by a newer application version/i.test(error.message)
    ) {
      throw error;
    }
    throw profilePrivacyError(
      'profile',
      windowsProfilePrivacyDiagnosticPhase(error),
      windowsProfilePrivacyDiagnosticLine(error),
    );
  }
  return normalized;
}
