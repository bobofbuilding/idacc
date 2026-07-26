import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

const WINDOWS_PROFILE_ACL_OK = 'IDACC_WINDOWS_PROFILE_ACL_OK';
const WINDOWS_PROFILE_NEWER = 'IDACC_WINDOWS_PROFILE_NEWER';
const WINDOWS_PROFILE_ACL_TIMEOUT_MS = 2 * 60_000;

export interface WindowsProfileAclRunResult {
  status: number | null;
  stdout?: string;
  error?: unknown;
  signal?: NodeJS.Signals | null;
}

export type WindowsProfileAclRunner = (
  root: string,
  maximumSchemaVersion?: number,
) => WindowsProfileAclRunResult;

export interface SecureWindowsProfileRootOptions {
  platform?: NodeJS.Platform;
  runner?: WindowsProfileAclRunner;
  maximumSchemaVersion?: number;
}

function profilePrivacyError(): NodeJS.ErrnoException {
  const error = new Error(
    'IDACC could not establish and verify private Windows access for this profile.',
  ) as NodeJS.ErrnoException;
  error.code = 'EPERM';
  return error;
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
export const WINDOWS_PROFILE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
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
  Add-Type -TypeDefinition $nativeSource -Language CSharp

  $reparseFlag = [System.IO.FileAttributes]::ReparsePoint
  $directoryFlag = [System.IO.FileAttributes]::Directory
  $workspaceRoot = [System.IO.Path]::Combine($root, 'workspace')
  $profileMarkerPath = [System.IO.Path]::Combine($root, 'profile.json')
  $attestationPath = [System.IO.Path]::Combine(
    $root,
    '.idacc-windows-acl-v2.json'
  )
  $maximumProfileObjects = 4096
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
        throw 'profile root is not a directory'
      }
      $parent = [System.IO.Directory]::GetParent($probe)
      if ($null -eq $parent) {
        throw 'profile parent is unavailable'
      }
      $probe = $parent.FullName
    }
    while ($true) {
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
        throw 'profile ancestor is unavailable'
      }
      $probe = $parent.FullName
    }
  }

  function Assert-SafeParentAclChain([string]$profileRoot) {
    $replaceRights = (
      [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $deleteRight = [int][System.Security.AccessControl.FileSystemRights]::Delete
    $createDirectoryRight = (
      [int][System.Security.AccessControl.FileSystemRights]::CreateDirectories
    )
    $profileRootWasMissing = -not [System.IO.Directory]::Exists($profileRoot)
    $sections = (
      [System.Security.AccessControl.AccessControlSections]::Access -bor
      [System.Security.AccessControl.AccessControlSections]::Owner
    )
    $profileParent = [System.IO.Directory]::GetParent($profileRoot)
    if ($null -eq $profileParent) {
      throw 'profile parent is unavailable'
    }
    $parent = $profileParent
    while ($null -ne $parent -and -not [System.IO.Directory]::Exists($parent.FullName)) {
      if ([System.IO.File]::Exists($parent.FullName)) {
        throw 'profile parent is not a directory'
      }
      $parent = $parent.Parent
    }
    # This is the parent on which CreateDirectory will create the first missing
    # segment. InheritOnly ACEs elsewhere in the chain do not necessarily reach
    # this path because an intervening directory can protect its DACL.
    $creationBoundary = $parent
    while ($null -ne $parent) {
      Assert-NotReparse $parent.FullName
      $security = [System.IO.Directory]::GetAccessControl($parent.FullName, $sections)
      $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($trustedAncestorSids -notcontains $owner.Value) {
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
        $dangerous = (
          (($rights -band $replaceRights) -ne 0) -or
          (
            -not $isVolumeRoot -and
            (($rights -band $deleteRight) -ne 0)
          ) -or
          (
            $profileRootWasMissing -and
            $isCreationBoundary -and
            (($rights -band $createDirectoryRight) -ne 0)
          )
        )
        if (-not $dangerous) {
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
          throw 'profile ACL traversal exceeded its bounded object limit'
        }
        # Existing user repositories are deliberately opaque. Secure only the
        # workspace root; its inheritable ACEs protect future direct children,
        # while SetFileSecurityW below does not rewrite existing descendants.
        # Existing descendant ACLs remain user-managed and continue to govern
        # direct access to known child paths.
        if (Test-SamePath $current $workspaceRoot) {
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
              throw 'profile ACL traversal exceeded its bounded object limit'
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
        [int]$attestation.version -eq 2 -and
        [string]$attestation.userSid -eq $userSid.Value -and
        [string]$attestation.workspacePolicy -eq 'root-only'
      )
    } catch {
      return $false
    }
  }

  function Write-AclAttestation {
    $attestation = [ordered]@{
      version = 2
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

  Assert-SafeAncestors $root
  Assert-CompatibleProfileMarker
  Assert-SafeParentAclChain $root
  if ([System.IO.File]::Exists($root)) {
    throw 'profile root is not a directory'
  }
  if (Test-AclAttestation) {
    [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_OK}:0')
    exit 0
  }
  [void][System.IO.Directory]::CreateDirectory($root)
  Assert-SafeAncestors $root
  Assert-SafeParentAclChain $root

  $objects = @()
  $verifiedObjects = @()
  $verifiedCount = 0
  try {
    $objects = @(Get-ProfileObjects $root)
    foreach ($item in $objects) {
      if (-not (Test-PrivateAcl $item)) {
        Set-PrivateAcl $item
      }
    }

    # Re-enumeration catches replacements or new reparse points introduced while
    # the original tree was being hardened. Both object generations stay locked
    # until exact ACL and stable 128-bit identity verification completes.
    Assert-SafeAncestors $root
    Assert-SafeParentAclChain $root
    $verifiedObjects = @(Get-ProfileObjects $root)
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
    Write-AclAttestation
    if (-not (Test-AclAttestation)) {
      throw 'profile ACL attestation verification failed'
    }
  } elseif ([System.IO.Directory]::Exists($profileMarkerPath)) {
    throw 'profile marker is not a regular file'
  }

  [Console]::Out.WriteLine('${WINDOWS_PROFILE_ACL_OK}:{0}', $verifiedCount)
  exit 0
} catch {
  [Console]::Out.WriteLine('IDACC_WINDOWS_PROFILE_ACL_FAILED')
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
): WindowsProfileAclRunResult {
  let executable: string;
  try {
    executable = windowsPowerShellPath();
  } catch (error) {
    return { status: null, error };
  }
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot || process.env.WINDIR,
    WINDIR: process.env.WINDIR || process.env.SystemRoot,
    IDACC_PROFILE_ACL_ROOT: root,
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
    '-Command',
    '-',
  ], {
    encoding: 'utf8',
    env: environment,
    // The helper is intentionally delivered over the child's private stdin.
    // Its UTF-16 Base64 representation exceeds Windows' 32,767-character
    // CreateProcess command-line limit and must never be placed in argv.
    input: WINDOWS_PROFILE_ACL_SCRIPT,
    maxBuffer: 1024 * 1024,
    timeout: WINDOWS_PROFILE_ACL_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || '').replaceAll('\u0000', ''),
    error: result.error,
    signal: result.signal,
  };
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
  const normalized = normalizeWindowsProfileRoot(root);
  const runner = options.runner || defaultWindowsProfileAclRunner;
  let result: WindowsProfileAclRunResult;
  try {
    result = runner(normalized, options.maximumSchemaVersion);
  } catch {
    throw profilePrivacyError();
  }
  if (
    result.status === 42
    && String(result.stdout || '').split(/\r?\n/).some((line) => (
      line.trim() === WINDOWS_PROFILE_NEWER
    ))
  ) {
    throw new Error('This IDACC profile was created by a newer application version.');
  }
  if (
    result.status !== 0
    || result.error
    || result.signal
    || !String(result.stdout || '').split(/\r?\n/).some((line) => (
      new RegExp(`^${WINDOWS_PROFILE_ACL_OK}:\\d+$`).test(line.trim())
    ))
  ) {
    throw profilePrivacyError();
  }
  return normalized;
}
