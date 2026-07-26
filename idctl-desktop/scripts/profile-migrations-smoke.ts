import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import {
  normalizeAppProfileName,
  selectAppProfile,
} from '../src/main/appProfileSelection.ts';
import {
  migrateAppProfile,
  PROFILE_SCHEMA_VERSION,
  type ProfileMigrationPaths,
} from '../src/main/profileMigrations.ts';
import {
  normalizeWindowsProfileRoot,
  secureWindowsPrivatePath,
  secureWindowsProfileRoot,
  windowsProfilePrivacyDiagnosticPhase,
  WINDOWS_PROFILE_ACL_SCRIPT,
} from '../src/main/profilePrivacy.ts';
import {
  assertPrivateFileMode,
  isTrustedPrivatePathOwner,
} from '../src/main/posixFilePrivacy.ts';
import { macAclListingHasExtendedAcl } from '../src/main/macFilePrivacy.ts';
import { copyFilePrivateSync } from '../src/main/privateFileCopy.ts';

function paths(root: string): ProfileMigrationPaths {
  return {
    root,
    config: join(root, 'config', 'config.json'),
    brain: join(root, 'brain'),
    manager: join(root, 'manager'),
    workspace: join(root, 'workspace'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
  };
}

assert.equal(isTrustedPrivatePathOwner(0, 1001), true);
assert.equal(isTrustedPrivatePathOwner(1001, 1001), true);
assert.equal(isTrustedPrivatePathOwner(1002, 1001), false);
assert.equal(isTrustedPrivatePathOwner(1002, undefined), false);

function windowsPowerShellForTest(script: string, profileRoot: string): string {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '');
  assert.ok(systemRoot, 'Windows ACL smoke requires SystemRoot or WINDIR');
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
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
    env: {
      SystemRoot: process.env.SystemRoot || process.env.WINDIR,
      WINDIR: process.env.WINDIR || process.env.SystemRoot,
      IDACC_TEST_PROFILE_ROOT: profileRoot,
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    },
    input: script,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, 'Windows ACL test helper must complete successfully');
  assert.equal(result.error, undefined);
  return String(result.stdout || '').replaceAll('\u0000', '');
}

const WINDOWS_ADD_PERMISSIVE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$child = [System.IO.Path]::Combine($root, 'nested', 'secret.txt')
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')

$rootSecurity = [System.IO.Directory]::GetAccessControl($root)
$rootRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  (
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  ),
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$rootSecurity.AddAccessRule($rootRule)
[System.IO.Directory]::SetAccessControl($root, $rootSecurity)

$childSecurity = [System.IO.File]::GetAccessControl($child)
$childRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$childSecurity.AddAccessRule($childRule)
[System.IO.File]::SetAccessControl($child, $childSecurity)

foreach ($item in @(
  [pscustomobject]@{ Path = $root; IsDirectory = $true },
  [pscustomobject]@{ Path = $child; IsDirectory = $false }
)) {
  if ($item.IsDirectory) {
    $security = [System.IO.Directory]::GetAccessControl($item.Path)
  } else {
    $security = [System.IO.File]::GetAccessControl($item.Path)
  }
  $rules = @($security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if (@($rules | Where-Object {
    $_.IdentityReference.Value -eq $everyone.Value
  }).Count -lt 1) {
    throw 'failed to construct permissive ACL fixture'
  }
}
[Console]::Out.WriteLine('IDACC_TEST_PERMISSIVE_OK')
`;

const WINDOWS_ASSERT_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($userSid.Value, 'S-1-5-18')
$objects = @(
  [pscustomobject]@{ Path = $root; IsDirectory = $true },
  [pscustomobject]@{ Path = [System.IO.Path]::Combine($root, 'nested'); IsDirectory = $true },
  [pscustomobject]@{ Path = [System.IO.Path]::Combine($root, 'nested', 'secret.txt'); IsDirectory = $false }
)
foreach ($item in $objects) {
  if ($item.IsDirectory) {
    $security = [System.IO.Directory]::GetAccessControl($item.Path)
  } else {
    $security = [System.IO.File]::GetAccessControl($item.Path)
  }
  if (-not $security.AreAccessRulesProtected) {
    throw 'ACL inheritance remains enabled'
  }
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $userSid.Value) {
    throw 'unexpected owner'
  }
  $rules = @($security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne 2) {
    throw 'unexpected rule count'
  }
  foreach ($rule in $rules) {
    if (
      $rule.IsInherited -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $allowed -notcontains $rule.IdentityReference.Value -or
      [int]$rule.FileSystemRights -ne
        [int][System.Security.AccessControl.FileSystemRights]::FullControl
    ) {
      throw 'unexpected ACL rule'
    }
  }
}
[Console]::Out.WriteLine('IDACC_TEST_PRIVATE_OK')
`;

const WINDOWS_ADD_INHERIT_ONLY_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$security = [System.IO.Directory]::GetAccessControl($root)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit,
  [System.Security.AccessControl.PropagationFlags]::InheritOnly,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($root, $security)
$stored = @(
  ([System.IO.Directory]::GetAccessControl($root)).GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ) | Where-Object {
    $_.IdentityReference.Value -eq $everyone.Value -and
    (
      $_.PropagationFlags -band
      [System.Security.AccessControl.PropagationFlags]::InheritOnly
    ) -ne 0 -and
    (
      $_.InheritanceFlags -band
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
    ) -ne 0
  }
)
if ($stored.Count -lt 1) {
  throw 'failed to construct InheritOnly ACL fixture'
}
[Console]::Out.WriteLine('IDACC_TEST_INHERIT_ONLY_OK')
`;

const WINDOWS_ADD_CREATE_CHILD_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$security = [System.IO.Directory]::GetAccessControl($root)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::CreateDirectories,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($root, $security)
$stored = @(
  ([System.IO.Directory]::GetAccessControl($root)).GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ) | Where-Object {
    $_.IdentityReference.Value -eq $everyone.Value -and
    (
      [int]$_.FileSystemRights -band
      [int][System.Security.AccessControl.FileSystemRights]::CreateDirectories
    ) -ne 0
  }
)
if ($stored.Count -lt 1) {
  throw 'failed to construct create-child ACL fixture'
}
[Console]::Out.WriteLine('IDACC_TEST_CREATE_CHILD_OK')
`;

const WINDOWS_READ_ROOT_AND_LINK_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$linked = [System.IO.Path]::Combine($root, 'linked.txt')
$sections = (
  [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group
)
$snapshot = [ordered]@{
  root = (
    [System.IO.Directory]::GetAccessControl($root, $sections)
  ).GetSecurityDescriptorSddlForm($sections)
  linked = (
    [System.IO.File]::GetAccessControl($linked, $sections)
  ).GetSecurityDescriptorSddlForm($sections)
}
[Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Compress))
`;

const WINDOWS_READ_NEWER_TREE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$sections = (
  [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group
)
$snapshot = [ordered]@{
  root = (
    [System.IO.Directory]::GetAccessControl($root, $sections)
  ).GetSecurityDescriptorSddlForm($sections)
  marker = (
    [System.IO.File]::GetAccessControl(
      [System.IO.Path]::Combine($root, 'profile.json'),
      $sections
    )
  ).GetSecurityDescriptorSddlForm($sections)
  sentinel = (
    [System.IO.File]::GetAccessControl(
      [System.IO.Path]::Combine($root, 'future-state', 'sentinel.txt'),
      $sections
    )
  ).GetSecurityDescriptorSddlForm($sections)
}
[Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Compress))
`;

const WINDOWS_READ_SECRET_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'nested', 'secret.txt')
$sections = (
  [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group
)
$snapshot = [ordered]@{
  root = (
    [System.IO.Directory]::GetAccessControl($root, $sections)
  ).GetSecurityDescriptorSddlForm($sections)
  secret = (
    [System.IO.File]::GetAccessControl($file, $sections)
  ).GetSecurityDescriptorSddlForm($sections)
}
[Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Compress))
`;

const WINDOWS_ADD_WORKSPACE_FILE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'workspace', 'repo', 'preserve.txt')
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$security = [System.IO.File]::GetAccessControl($file)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($file, $security)
[Console]::Out.WriteLine(
  $security.GetSecurityDescriptorSddlForm(
    (
      [System.Security.AccessControl.AccessControlSections]::Access -bor
      [System.Security.AccessControl.AccessControlSections]::Owner -bor
      [System.Security.AccessControl.AccessControlSections]::Group
    )
  )
)
`;

const WINDOWS_READ_WORKSPACE_FILE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'workspace', 'repo', 'preserve.txt')
$sections = (
  [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner -bor
  [System.Security.AccessControl.AccessControlSections]::Group
)
$security = [System.IO.File]::GetAccessControl($file, $sections)
[Console]::Out.WriteLine($security.GetSecurityDescriptorSddlForm($sections))
`;

const WINDOWS_ADD_LEGACY_CONFIG_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'config.json')
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$security = [System.IO.File]::GetAccessControl($file)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($file, $security)
$stored = @(
  ([System.IO.File]::GetAccessControl($file)).GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ) | Where-Object {
    $_.IdentityReference.Value -eq $everyone.Value
  }
)
if ($stored.Count -lt 1) {
  throw 'failed to construct permissive legacy config fixture'
}
[Console]::Out.WriteLine('IDACC_TEST_LEGACY_CONFIG_PERMISSIVE_OK')
`;

const WINDOWS_ADD_PROFILE_CONFIG_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'config', 'config.json')
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$security = [System.IO.File]::GetAccessControl($file)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($file, $security)
$stored = @(
  ([System.IO.File]::GetAccessControl($file)).GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ) | Where-Object {
    $_.IdentityReference.Value -eq $everyone.Value
  }
)
if ($stored.Count -lt 1) {
  throw 'failed to construct permissive profile config fixture'
}
[Console]::Out.WriteLine('IDACC_TEST_PROFILE_CONFIG_PERMISSIVE_OK')
`;

const WINDOWS_ASSERT_PRIVATE_PROFILE_CONFIG_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$file = [System.IO.Path]::Combine($root, 'config', 'config.json')
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.IO.File]::GetAccessControl($file)
if (
  $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne
  $userSid.Value
) {
  throw 'migrated config has an unexpected owner'
}
$rules = @($security.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne 2) {
  throw 'migrated config has an unexpected rule count'
}
foreach ($sid in @($userSid, $systemSid)) {
  $matching = @($rules | Where-Object {
    $_.IdentityReference.Value -eq $sid.Value
  })
  if (
    $matching.Count -ne 1 -or
    $matching[0].AccessControlType -ne
      [System.Security.AccessControl.AccessControlType]::Allow -or
    [int]$matching[0].FileSystemRights -ne
      [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
    $matching[0].InheritanceFlags -ne
      [System.Security.AccessControl.InheritanceFlags]::None -or
    $matching[0].PropagationFlags -ne
      [System.Security.AccessControl.PropagationFlags]::None
  ) {
    throw 'migrated config ACL is not effectively private'
  }
}
[Console]::Out.WriteLine('IDACC_TEST_MIGRATED_CONFIG_PRIVATE_OK')
`;

const WINDOWS_ASSERT_PRIVATE_DIRECTORY_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.IO.Directory]::GetAccessControl($root)
if (-not $security.AreAccessRulesProtected) {
  throw 'ACL inheritance remains enabled'
}
if (
  $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne
  $userSid.Value
) {
  throw 'unexpected owner'
}
$expectedInheritance = (
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
)
$rules = @($security.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne 2) {
  throw 'unexpected rule count'
}
foreach ($sid in @($userSid, $systemSid)) {
  $matching = @($rules | Where-Object {
    $_.IdentityReference.Value -eq $sid.Value
  })
  if (
    $matching.Count -ne 1 -or
    $matching[0].IsInherited -or
    $matching[0].AccessControlType -ne
      [System.Security.AccessControl.AccessControlType]::Allow -or
    [int]$matching[0].FileSystemRights -ne
      [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
    $matching[0].InheritanceFlags -ne $expectedInheritance -or
    $matching[0].PropagationFlags -ne
      [System.Security.AccessControl.PropagationFlags]::None
  ) {
    throw 'unexpected ACL rule'
  }
}
[Console]::Out.WriteLine('IDACC_TEST_PRIVATE_DIRECTORY_OK')
`;

const WINDOWS_CREATE_AND_ASSERT_PRIVATE_WORKSPACE_CHILD = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [System.IO.Path]::GetFullPath([string]$env:IDACC_TEST_PROFILE_ROOT)
$workspace = [System.IO.Path]::Combine($root, 'workspace')
$directory = [System.IO.Path]::Combine($workspace, 'created-after-hardening')
$file = [System.IO.Path]::Combine($directory, 'private-state.txt')
[void][System.IO.Directory]::CreateDirectory($directory)
[System.IO.File]::WriteAllText($file, 'private')
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
foreach ($item in @($directory, $file)) {
  if ([System.IO.Directory]::Exists($item)) {
    $security = [System.IO.Directory]::GetAccessControl($item)
  } else {
    $security = [System.IO.File]::GetAccessControl($item)
  }
  if (
    $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne
      $userSid.Value
  ) {
    throw 'new workspace content has an unexpected owner'
  }
  $rules = @($security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne 2) {
    throw 'new workspace content has an unexpected rule count'
  }
  foreach ($rule in $rules) {
    if (
      -not $rule.IsInherited -or
      $rule.AccessControlType -ne
        [System.Security.AccessControl.AccessControlType]::Allow -or
      [int]$rule.FileSystemRights -ne
        [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
      (
        $rule.IdentityReference.Value -ne $userSid.Value -and
        $rule.IdentityReference.Value -ne $systemSid.Value
      )
    ) {
      throw 'new workspace content did not inherit the private boundary'
    }
  }
}
[Console]::Out.WriteLine('IDACC_TEST_PRIVATE_WORKSPACE_CHILD_OK')
`;

const windowsAppDataInput = String(process.env.APPDATA || '').trim();
let windowsAppData = '';
if (process.platform === 'win32') {
  assert.ok(
    windowsAppDataInput,
    'Windows profile migrations require the per-user APPDATA base used by Electron',
  );
  // Reject UNC, device, drive-root, relative, and alternate-stream paths before
  // mkdtemp can mutate an unsupported application-data location.
  windowsAppData = normalizeWindowsProfileRoot(windowsAppDataInput);
  const appDataEntry = lstatSync(windowsAppData);
  assert.equal(
    appDataEntry.isSymbolicLink(),
    false,
    'the Windows APPDATA base must not be a reparse-point alias',
  );
  assert.equal(
    appDataEntry.isDirectory(),
    true,
    'the Windows APPDATA base must be an existing directory',
  );
}
const temp = mkdtempSync(join(
  process.platform === 'win32' ? windowsAppData : tmpdir(),
  'idacc-profile-migrations-',
));
try {
  if (process.platform === 'win32') {
    // Use the per-user application-data base that backs Electron userData.
    // Windows TEMP may intentionally allow another principal to replace/delete
    // children, in which case production correctly refuses to secure even an
    // existing scratch root. Establish and verify the same exact app-owned
    // boundary the desktop applies before creating profiles beneath it.
    try {
      secureWindowsPrivatePath(temp, 'directory');
    } catch (error) {
      assert.fail(
        `the Windows migration fixture boundary failed at phase: ${
          windowsProfilePrivacyDiagnosticPhase(error) || 'unavailable'
        }`,
      );
    }
    assert.match(
      windowsPowerShellForTest(WINDOWS_ASSERT_PRIVATE_DIRECTORY_ACL, temp),
      /IDACC_TEST_PRIVATE_DIRECTORY_OK/,
      'the Windows migration fixture root must be an exact private app-owned boundary',
    );
  }

  // The pure contract is exercised on every host. Windows paths are validated
  // before the privileged OS runner, while non-Windows behavior is a no-op.
  let fakeRunnerCalls = 0;
  let fakeMaximumSchemaVersion: number | undefined;
  let fakeAclMode: string | undefined;
  const fakeRunner = (
    root: string,
    maximumSchemaVersion?: number,
    mode?: string,
  ) => {
    fakeRunnerCalls += 1;
    fakeMaximumSchemaVersion = maximumSchemaVersion;
    fakeAclMode = mode;
    assert.equal(root, 'C:\\Profiles\\Consumer');
    return { status: 0, stdout: 'IDACC_WINDOWS_PROFILE_ACL_OK:3\n' };
  };
  assert.equal(
    secureWindowsProfileRoot('/private/profile', {
      platform: 'darwin',
      runner: () => {
        throw new Error('non-Windows must not invoke the Windows ACL runner');
      },
    }),
    '/private/profile',
  );
  assert.equal(
    normalizeWindowsProfileRoot('C:/Profiles/Consumer'),
    'C:\\Profiles\\Consumer',
  );
  assert.equal(
    secureWindowsProfileRoot('C:/Profiles/Consumer', {
      platform: 'win32',
      runner: fakeRunner,
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
    }),
    'C:\\Profiles\\Consumer',
  );
  assert.equal(fakeRunnerCalls, 1);
  assert.equal(fakeMaximumSchemaVersion, PROFILE_SCHEMA_VERSION);
  assert.equal(fakeAclMode, 'normal');
  for (const unsafeWindowsRoot of [
    'relative\\profile',
    'C:\\',
    '\\\\server\\share\\profile',
    '\\\\?\\C:\\profile',
    '\\\\.\\C:\\profile',
    'C:\\profile\\data:stream',
  ]) {
    assert.throws(
      () => secureWindowsProfileRoot(unsafeWindowsRoot, {
        platform: 'win32',
        runner: fakeRunner,
      }),
      /could not establish and verify private Windows access/i,
    );
  }
  assert.equal(fakeRunnerCalls, 1, 'unsafe paths must be rejected before the OS runner');
  assert.throws(
    () => secureWindowsProfileRoot('C:\\Profiles\\Consumer', {
      platform: 'win32',
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
      runner: () => ({
        status: 42,
        stdout: 'IDACC_WINDOWS_PROFILE_NEWER\n',
      }),
    }),
    /created by a newer application version/i,
  );
  for (const failedResult of [
    { status: 1, stdout: 'IDACC_WINDOWS_PROFILE_ACL_FAILED\n' },
    { status: 0, stdout: '' },
    { status: null, stdout: '', error: new Error('missing helper') },
    { status: null, stdout: '', signal: 'SIGTERM' as NodeJS.Signals },
  ]) {
    assert.throws(
      () => secureWindowsProfileRoot('C:\\Profiles\\Consumer', {
        platform: 'win32',
        runner: () => failedResult,
      }),
      /could not establish and verify private Windows access/i,
    );
  }
  let allowlistedDiagnosticError: unknown;
  try {
    secureWindowsPrivatePath('C:\\Profiles\\Consumer', 'directory', {
      platform: 'win32',
      runner: () => ({
        status: 1,
        stdout: [
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:parent-delete-child',
          'untrusted detail C:\\Users\\Consumer\\private-profile',
        ].join('\n'),
      }),
    });
  } catch (error) {
    allowlistedDiagnosticError = error;
  }
  assert.ok(allowlistedDiagnosticError instanceof Error);
  assert.equal(
    allowlistedDiagnosticError.message,
    'IDACC could not establish and verify private Windows access for this application-state path.',
  );
  assert.equal(
    (allowlistedDiagnosticError as NodeJS.ErrnoException).code,
    'EPERM',
    'bounded diagnostics must not change the public operating-system code',
  );
  assert.equal(
    windowsProfilePrivacyDiagnosticPhase(allowlistedDiagnosticError),
    'parent-delete-child',
    'only the closed helper phase may cross the privacy boundary',
  );
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(
      allowlistedDiagnosticError,
      'diagnosticPhase',
    ),
    false,
    'the bounded helper phase must not enter serialized error records',
  );
  assert.doesNotMatch(
    JSON.stringify(allowlistedDiagnosticError),
    /Consumer|private-profile|parent-delete-child/,
    'raw helper output and even the bounded phase must not leak through serialization',
  );

  let untrustedDiagnosticError: unknown;
  try {
    secureWindowsPrivatePath('C:\\Profiles\\Consumer', 'directory', {
      platform: 'win32',
      runner: () => ({
        status: 1,
        stdout: [
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:C:\\Users\\Consumer\\secret',
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:not-an-allowlisted-phase',
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:parent-owner-untrusted:C:\\secret',
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:PARENT-DELETE-OBJECT',
        ].join('\n'),
      }),
    });
  } catch (error) {
    untrustedDiagnosticError = error;
  }
  assert.ok(untrustedDiagnosticError instanceof Error);
  assert.equal(
    windowsProfilePrivacyDiagnosticPhase(untrustedDiagnosticError),
    undefined,
    'arbitrary helper output must never become a diagnostic phase',
  );
  assert.doesNotMatch(
    `${untrustedDiagnosticError.message}\n${JSON.stringify(untrustedDiagnosticError)}`,
    /Consumer|secret|not-an-allowlisted-phase|PARENT-DELETE-OBJECT/,
    'untrusted helper output must not cross the generic public error boundary',
  );
  assert.equal(
    windowsProfilePrivacyDiagnosticPhase({
      diagnosticPhase: 'parent-delete-object:C:\\secret',
    }),
    undefined,
    'a phase property with appended detail must not pass the closed allowlist',
  );
  assert.throws(
    () => secureWindowsPrivatePath('C:\\Profiles\\Consumer', 'directory', {
      platform: 'win32',
      runner: () => ({
        status: 0,
        stdout: [
          'IDACC_WINDOWS_PROFILE_ACL_OK:1',
          'IDACC_WINDOWS_PROFILE_ACL_FAILED:single-verify',
        ].join('\n'),
      }),
    }),
    /could not establish and verify private Windows access/i,
    'a failure phase must prevent success even beside a forged success marker',
  );
  const privacySource = readFileSync(
    join(process.cwd(), 'src', 'main', 'profilePrivacy.ts'),
    'utf8',
  );
  assert.ok(
    Buffer.from(WINDOWS_PROFILE_ACL_SCRIPT, 'utf16le').toString('base64').length > 32_767,
    'the native helper fixture must remain large enough to catch argv transport regressions',
  );
  assert.doesNotMatch(privacySource, /-EncodedCommand/);
  assert.match(privacySource, /'-Command',\s*'-'/);
  assert.match(privacySource, /input:\s*WINDOWS_PROFILE_ACL_SCRIPT/);
  assert.match(privacySource, /DriveType\]::Network/);
  assert.match(privacySource, /\$driveFormat -ne 'NTFS'/);
  assert.doesNotMatch(privacySource, /\$driveFormat -ne 'ReFS'/);
  assert.match(privacySource, /FileAttributes\]::ReparsePoint/);
  assert.match(privacySource, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(privacySource, /SecurityIdentifier\]::new\('S-1-5-18'\)/);
  assert.match(privacySource, /SecurityIdentifier\]::new\('S-1-3-0'\)/);
  assert.match(privacySource, /FileSystemRights\]::DeleteSubdirectoriesAndFiles/);
  assert.match(privacySource, /FileSystemRights\]::CreateDirectories/);
  assert.match(privacySource, /-not \$isVolumeRoot -and/);
  assert.match(
    privacySource,
    /\$profileRootWasMissing -and\s+\$isCreationBoundary -and/,
  );
  assert.match(
    privacySource,
    /\$isCreationBoundary -and \$appliesToChildDirectory/,
  );
  assert.match(privacySource, /profile parent can be replaced by another principal/);
  assert.match(privacySource, /\$rules\.Count -ne 2/);
  assert.match(privacySource, /Get-ProfileObjects \$root/);
  assert.match(privacySource, /GetObjectIdentity\(string path, bool isDirectory\)/);
  assert.match(privacySource, /SetSecurityWithoutPropagation/);
  assert.match(privacySource, /profile object identity changed/);
  assert.match(privacySource, /GetFileInformationByHandleEx/);
  assert.match(privacySource, /FileIdLow/);
  assert.match(privacySource, /FileIdHigh/);
  assert.match(privacySource, /OpenLockedObject/);
  assert.match(privacySource, /AssertLockedPath\(locked, path\)/);
  assert.match(privacySource, /ReadLockedSecurityDescriptor/);
  assert.match(privacySource, /GetSecurityInfo/);
  assert.match(privacySource, /Close-ProfileObjects \$verifiedObjects/);
  assert.match(privacySource, /\$maximumProfileObjects = 4096/);
  assert.equal(
    [
      ...privacySource.matchAll(
        /\(Test-SamePath \$current \$workspaceRoot\) -or\s*\(Test-IsCacheQuarantine \$current\)/g,
      ),
    ].length,
    2,
    'both transactional and streaming traversals must preserve opaque boundaries',
  );
  assert.match(privacySource, /New-PrivateDirectorySecurity \$true/);
  assert.doesNotMatch(privacySource, /New-PrivateDirectorySecurity \$false/);
  assert.match(privacySource, /\.idacc-windows-acl-v3\.json/);
  assert.match(
    privacySource,
    /if \(\$aclMode -eq 'normal' -and \(Test-AclAttestation\)\) \{/,
  );
  assert.match(privacySource, /Assert-CompatibleProfileMarker/);
  assert.match(privacySource, /IDACC_WINDOWS_PROFILE_NEWER/);
  assert.match(privacySource, /WINDOWS_PROFILE_ACL_TIMEOUT_MS = 2 \* 60_000/);
  assert.match(privacySource, /WINDOWS_PROFILE_STREAMING_TIMEOUT_MS = 5 \* 60_000/);
  assert.match(privacySource, /IDACC_WINDOWS_PROFILE_TOO_LARGE/);
  assert.match(privacySource, /cache-boundary/);
  assert.match(privacySource, /streaming-upgrade/);
  assert.match(privacySource, /maximumStreamingProfileObjects = 100000/);
  const migrationSource = readFileSync(
    join(process.cwd(), 'src', 'main', 'profileMigrations.ts'),
    'utf8',
  );
  assert.match(
    migrationSource,
    /assertCompatibleProfileBeforeMutation\(paths\.root\);[\s\S]*secureWindowsProfileRoot\(paths\.root, \{[\s\S]*maximumSchemaVersion: PROFILE_SCHEMA_VERSION,[\s\S]*const marker = join\(paths\.root, 'profile\.json'\);/,
    'only the bounded compatibility marker preflight may precede Windows ACL enforcement',
  );
  assert.match(migrationSource, /copyFilePrivateSync\(source, destination,/);
  const privateCopySource = readFileSync(
    join(process.cwd(), 'src', 'main', 'privateFileCopy.ts'),
    'utf8',
  );
  assert.match(privateCopySource, /O_CREAT \| constants\.O_EXCL/);
  assert.match(privateCopySource, /linkSync\(temporary, destination\)/);
  assert.match(privateCopySource, /writeSync\(/);
  assert.doesNotMatch(privateCopySource, /copyFileSync/);
  const posixPrivacySource = readFileSync(
    join(process.cwd(), 'src', 'main', 'posixFilePrivacy.ts'),
    'utf8',
  );
  assert.match(posixPrivacySource, /current\.uid === uid/);
  assert.match(migrationSource, /assertSafePosixProfileAncestors\(paths\.root\)/);
  assert.match(migrationSource, /isTrustedPrivatePathOwner\(entry\.uid\)/);
  assert.match(
    migrationSource,
    /writableByAnotherPrincipal && sticky[\s\S]*isTrustedPrivatePathOwner\(childEntry\.uid\)/,
    'sticky shared parents must authenticate the traversed child owner',
  );
  for (const profileCopyConsumer of [
    'brainplans.ts',
    'materialstore.ts',
    'unifiedStackPolicy.ts',
    join('computeruse', 'broker.ts'),
  ]) {
    const source = readFileSync(
      join(process.cwd(), 'src', 'main', profileCopyConsumer),
      'utf8',
    );
    assert.match(source, /copyFilePrivateSync\(/);
    assert.doesNotMatch(
      source,
      /copyFileSync/,
      `${profileCopyConsumer} must not preserve an external Windows DACL`,
    );
  }

  const userData = join(temp, 'user-data');
  assert.equal(normalizeAppProfileName(), 'default');
  assert.equal(normalizeAppProfileName('   '), 'default');
  assert.deepEqual(selectAppProfile(userData), {
    root: join(userData, 'profiles', 'default'),
    profileName: 'default',
    explicitDataDir: false,
  });
  assert.deepEqual(selectAppProfile(userData, { profile: 'work-2026_07.v1' }), {
    root: join(userData, 'profiles', 'work-2026_07.v1'),
    profileName: 'work-2026_07.v1',
    explicitDataDir: false,
  });
  for (const unsafe of [
    '../escape',
    'a/b',
    'a\\b',
    '.',
    '..',
    '/tmp/x',
    'C:\\x',
    'bad\u0000name',
    'bad\nname',
    'a'.repeat(65),
  ]) {
    assert.throws(
      () => selectAppProfile(userData, { profile: unsafe }),
      /IDACC_PROFILE must be a 1-64 character name/,
    );
  }
  const customRoot = join(temp, 'custom-profile-root');
  assert.deepEqual(selectAppProfile(userData, {
    dataDir: ` ${customRoot} `,
    profile: 'portable',
  }), {
    root: customRoot,
    profileName: 'portable',
    explicitDataDir: true,
  });
  if (process.platform !== 'win32') {
    const chmodNoOpProbe = join(temp, 'chmod-no-op-probe');
    writeFileSync(chmodNoOpProbe, 'private\n', { mode: 0o644 });
    assert.throws(
      () => assertPrivateFileMode(chmodNoOpProbe),
      /privacy could not be verified/i,
      'a filesystem that leaves permissive mode bits must fail closed',
    );
    chmodSync(chmodNoOpProbe, 0o600);
    assert.doesNotThrow(() => assertPrivateFileMode(chmodNoOpProbe));

    const privateCopySourcePath = join(temp, 'private-copy-source');
    const privateCopyDestination = join(temp, 'private-copy-destination');
    const privateCopyExistingDestination = join(
      temp,
      'private-copy-existing-destination',
    );
    writeFileSync(privateCopySourcePath, 'new private contents\n', { mode: 0o644 });
    writeFileSync(privateCopyExistingDestination, 'preserve me\n', { mode: 0o600 });
    assert.throws(
      () => copyFilePrivateSync(
        privateCopySourcePath,
        privateCopyExistingDestination,
      ),
      /already exists or is unsafe/i,
    );
    assert.equal(
      readFileSync(privateCopyExistingDestination, 'utf8'),
      'preserve me\n',
    );
    copyFilePrivateSync(privateCopySourcePath, privateCopyDestination);
    assert.equal(
      readFileSync(privateCopyDestination, 'utf8'),
      'new private contents\n',
    );
    assertPrivateFileMode(privateCopyDestination);

    const outsideAncestorTarget = join(temp, 'outside-ancestor-target');
    const outsideExistingProfile = join(outsideAncestorTarget, 'profile');
    const linkedAncestor = join(temp, 'linked-profile-ancestor');
    mkdirSync(outsideExistingProfile, { recursive: true, mode: 0o755 });
    chmodSync(outsideExistingProfile, 0o755);
    symlinkSync(outsideAncestorTarget, linkedAncestor, 'dir');
    const outsideModeBefore = statSync(outsideExistingProfile).mode & 0o777;
    assert.throws(
      () => migrateAppProfile(paths(join(linkedAncestor, 'profile')), {
        profileName: 'linked-ancestor',
        legacyConfigDir: join(temp, 'missing-linked-ancestor-legacy'),
        allowLegacyImport: false,
      }),
      /ancestor is not a regular directory/i,
    );
    assert.equal(
      statSync(outsideExistingProfile).mode & 0o777,
      outsideModeBefore,
      'an ancestor symlink must be rejected before changing its outside target',
    );
    assert.equal(existsSync(join(outsideExistingProfile, 'profile.json')), false);

    for (const [name, mode] of [
      ['replaceable-parent', 0o777],
      ['replaceable-sticky-parent', 0o1777],
    ] as const) {
      const parent = join(temp, name);
      const target = paths(join(parent, 'new-profile'));
      mkdirSync(parent, { mode });
      chmodSync(parent, mode);
      assert.throws(
        () => migrateAppProfile(target, {
          profileName: 'unsafe-parent',
          legacyConfigDir: join(temp, 'missing-unsafe-parent-legacy'),
          allowLegacyImport: false,
        }),
        /parent can be replaced/i,
      );
      assert.equal(
        existsSync(target.root),
        false,
        'an unsafe parent must be rejected before profile creation',
      );
    }

    if (process.platform === 'darwin') {
      const aclParent = join(temp, 'replaceable-acl-parent');
      const aclTarget = paths(join(aclParent, 'new-profile'));
      mkdirSync(aclParent, { mode: 0o700 });
      assert.equal(
        spawnSync('/bin/chmod', [
          '+a',
          'everyone allow add_file,delete_child',
          aclParent,
        ]).status,
        0,
      );
      assert.throws(
        () => migrateAppProfile(aclTarget, {
          profileName: 'unsafe-acl-parent',
          legacyConfigDir: join(temp, 'missing-unsafe-acl-parent-legacy'),
          allowLegacyImport: false,
        }),
        /replaceable macOS ACL/i,
      );
      assert.equal(existsSync(aclTarget.root), false);
    }
  }

  const legacy = join(temp, 'legacy');
  const legacyDesktopSigner = join(temp, 'old-user-data', 'keys', 'agent-signers.json');
  const profile = paths(join(temp, 'profile'));
  mkdirSync(join(legacy, 'goals', 'nested'), { recursive: true });
  mkdirSync(join(legacy, 'context-budget'), { recursive: true });
  mkdirSync(join(legacy, 'computeruse'), { recursive: true });
  mkdirSync(join(legacyDesktopSigner, '..'), { recursive: true });
  writeFileSync(join(legacy, 'config.json'), '{"version":1,"defaultTeam":"default"}\n', { mode: 0o644 });
  writeFileSync(join(legacy, 'goals', 'goal.json'), '{"id":"legacy"}\n');
  writeFileSync(join(legacy, 'goals', 'nested', 'helper.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(join(legacy, 'goals', 'nested'), 0o755);
  writeFileSync(join(legacy, 'safe-roles-state.json'), '{"schemaVersion":1,"accounts":{},"operations":{}}\n');
  writeFileSync(join(legacy, 'context-budget', 'cb_old.json'), '{"id":"cb_old"}\n');
  writeFileSync(join(legacy, 'computeruse', 'agent-tokens.json'), '{"token":"agent"}\n', { mode: 0o644 });
  writeFileSync(legacyDesktopSigner, '{"schemaVersion":1,"signers":{"lead":{"encryptedPrivateKey":"ciphertext"}}}\n', { mode: 0o644 });

  const first = migrateAppProfile(profile, {
    profileName: 'default',
    legacyConfigDir: legacy,
    legacyDesktopSignerVault: legacyDesktopSigner,
  });
  assert.equal(first.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.deepEqual(first.appliedMigrations.map((entry) => entry.version), [1, 2, 3, 4, 5]);
  assert.equal(readFileSync(profile.config, 'utf8'), '{"version":1,"defaultTeam":"default"}\n');
  assert.equal(readFileSync(join(profile.root, 'config', 'goals', 'goal.json'), 'utf8'), '{"id":"legacy"}\n');
  if (process.platform !== 'win32') {
    // Windows privacy is enforced by the profile root ACL; POSIX mode bits
    // are not a meaningful ownership boundary there.
    assert.equal(statSync(join(profile.root, 'config', 'goals')).mode & 0o777, 0o700);
    assert.equal(statSync(join(profile.root, 'config', 'goals', 'goal.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(profile.root, 'config', 'goals', 'nested', 'helper.sh')).mode & 0o777, 0o700);
  }
  assert.equal(existsSync(join(profile.root, 'config', 'safe-roles-state.json')), false);
  assert.equal(existsSync(join(legacy, 'safe-roles-state.json')), true);
  assert.equal(readFileSync(join(profile.cache, 'context-budget', 'cb_old.json'), 'utf8'), '{"id":"cb_old"}\n');
  assert.equal(readFileSync(join(legacy, 'context-budget', 'cb_old.json'), 'utf8'), '{"id":"cb_old"}\n');
  assert.equal(readFileSync(join(profile.root, 'computeruse', 'agent-tokens.json'), 'utf8'), '{"token":"agent"}\n');
  assert.equal(readFileSync(join(legacy, 'computeruse', 'agent-tokens.json'), 'utf8'), '{"token":"agent"}\n');
  assert.equal(readFileSync(join(profile.root, 'config', 'agent-signers.json'), 'utf8'), readFileSync(legacyDesktopSigner, 'utf8'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(profile.root, 'computeruse', 'agent-tokens.json')).mode & 0o777, 0o600);
    assert.equal(statSync(profile.config).mode & 0o777, 0o600);
    assert.equal(statSync(join(profile.root, 'config', 'agent-signers.json')).mode & 0o777, 0o600);
  }

  // Reruns are resumable/idempotent and local profile data wins over legacy.
  writeFileSync(profile.config, '{"version":1,"defaultTeam":"custom"}\n', { mode: 0o600 });
  writeFileSync(join(legacy, 'config.json'), '{"version":1,"defaultTeam":"changed-legacy"}\n');
  writeFileSync(legacyDesktopSigner, '{"schemaVersion":1,"signers":{"changed":{}}}\n');
  const second = migrateAppProfile(profile, {
    profileName: 'default',
    legacyConfigDir: legacy,
    legacyDesktopSignerVault: legacyDesktopSigner,
  });
  assert.equal(second.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.equal(second.appliedMigrations.length, 5);
  assert.match(readFileSync(profile.config, 'utf8'), /custom/);
  assert.doesNotMatch(readFileSync(join(profile.root, 'config', 'agent-signers.json'), 'utf8'), /changed/);

  // Named and explicitly isolated profiles never inherit another profile's
  // goals, config, or former app-global signer vault.
  for (const [name, allowLegacyImport] of [['named', undefined], ['isolated-default', false]] as const) {
    const isolated = paths(join(temp, name));
    const isolatedResult = migrateAppProfile(isolated, {
      profileName: name === 'named' ? 'work' : 'default',
      legacyConfigDir: legacy,
      legacyDesktopSignerVault: legacyDesktopSigner,
      ...(allowLegacyImport === false ? { allowLegacyImport } : {}),
    });
    assert.equal(isolatedResult.migratedFrom, null);
    assert.equal(existsSync(isolated.config), false);
    assert.equal(existsSync(join(isolated.root, 'config', 'goals')), false);
    assert.equal(existsSync(join(isolated.root, 'config', 'agent-signers.json')), false);
  }

  // A version-1 profile resumes at v2, including the old config cache location.
  const resumed = paths(join(temp, 'resumed'));
  mkdirSync(join(resumed.root, 'config', 'context-budget'), { recursive: true });
  writeFileSync(join(resumed.root, 'config', 'context-budget', 'cb_resume.json'), '{"id":"resume"}\n');
  writeFileSync(join(resumed.root, 'profile.json'), JSON.stringify({
    schemaVersion: 1,
    profile: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    migratedFrom: null,
    appliedMigrations: [{ version: 1, id: 'import-legacy-idctl-profile', appliedAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const resumedResult = migrateAppProfile(resumed, {
    profileName: 'default',
    legacyConfigDir: join(temp, 'missing'),
    legacyDesktopSignerVault: legacyDesktopSigner,
  });
  assert.equal(resumedResult.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.equal(existsSync(join(resumed.cache, 'context-budget', 'cb_resume.json')), true);
  assert.equal(existsSync(join(resumed.root, 'config', 'context-budget', 'cb_resume.json')), true);
  assert.equal(existsSync(join(resumed.root, 'config', 'agent-signers.json')), true);

  // First-run cache import must stay below both the product retention contract
  // and the Windows transactional ACL verification bound. The full legacy
  // cache remains untouched as a rollback source.
  const largeLegacy = join(temp, 'large-legacy');
  const largeLegacyContext = join(largeLegacy, 'context-budget');
  const boundedCacheProfile = paths(join(temp, 'bounded-cache-profile'));
  mkdirSync(largeLegacyContext, { recursive: true });
  for (let index = 0; index < 4_105; index += 1) {
    writeFileSync(
      join(largeLegacyContext, `cb_${String(index).padStart(5, '0')}.json`),
      '{}\n',
    );
  }
  migrateAppProfile(boundedCacheProfile, {
    profileName: 'default',
    legacyConfigDir: largeLegacy,
  });
  assert.equal(
    readdirSync(join(boundedCacheProfile.cache, 'context-budget'))
      .filter((name) => /^cb_.*\.json$/.test(name))
      .length,
    2_000,
  );
  assert.equal(readdirSync(largeLegacyContext).length, 4_105);
  const boundedCacheSecondLaunch = migrateAppProfile(boundedCacheProfile, {
    profileName: 'default',
    legacyConfigDir: largeLegacy,
  });
  assert.equal(boundedCacheSecondLaunch.schemaVersion, PROFILE_SCHEMA_VERSION);
  if (process.platform === 'win32') {
    assert.equal(
      existsSync(join(boundedCacheProfile.root, '.idacc-windows-acl-v3.json')),
      true,
      'a second Windows launch must verify and attest a retained large cache',
    );
    rmSync(join(boundedCacheProfile.root, '.idacc-windows-acl-v3.json'));
    writeFileSync(join(boundedCacheProfile.root, 'profile.json'), JSON.stringify({
      schemaVersion: 2,
      profile: 'default',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migratedFrom: largeLegacy,
      appliedMigrations: [
        {
          version: 1,
          id: 'import-legacy-idctl-profile',
          appliedAt: '2026-07-25T00:00:00.000Z',
        },
        {
          version: 2,
          id: 'relocate-context-budget-to-cache',
          appliedAt: '2026-07-25T00:00:00.000Z',
        },
      ],
    }) + '\n');
    for (let index = 4_105; index < 6_210; index += 1) {
      writeFileSync(
        join(
          boundedCacheProfile.cache,
          'context-budget',
          `cb_${String(index).padStart(5, '0')}.json`,
        ),
        '{}\n',
      );
    }
    const upgradedLargeExisting = migrateAppProfile(boundedCacheProfile, {
      profileName: 'default',
      legacyConfigDir: largeLegacy,
    });
    assert.equal(upgradedLargeExisting.schemaVersion, PROFILE_SCHEMA_VERSION);
    assert.equal(
      readdirSync(join(boundedCacheProfile.cache, 'context-budget'))
        .filter((name) => /^cb_.*\.json$/.test(name))
        .length,
      2_000,
      'an oversized un-attested cache must be retained within policy',
    );
    assert.equal(
      readdirSync(boundedCacheProfile.root)
        .some((name) => name.startsWith('.idacc-cache-quarantine-')),
      false,
      'successful cache conversion must remove its private quarantine',
    );
    assert.equal(
      existsSync(join(boundedCacheProfile.root, '.idacc-windows-acl-v3.json')),
      true,
      'the converted existing profile must be attested before use',
    );
  }

  // A future-version profile is compatibility-inspected without changing even
  // its root mode, timestamps, entries, or existing data.
  const newerProfile = paths(join(temp, 'newer-profile'));
  const newerSentinel = join(newerProfile.root, 'future-state', 'sentinel.txt');
  mkdirSync(join(newerProfile.root, 'future-state'), {
    recursive: true,
    mode: 0o755,
  });
  writeFileSync(join(newerProfile.root, 'profile.json'), JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION + 1,
    profile: 'future',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    migratedFrom: null,
    appliedMigrations: [],
  }) + '\n', { mode: 0o644 });
  writeFileSync(newerSentinel, 'future data\n', { mode: 0o644 });
  const newerBefore = {
    entries: readdirSync(newerProfile.root).sort(),
    rootMode: statSync(newerProfile.root).mode,
    rootMtime: statSync(newerProfile.root).mtimeMs,
    markerMode: statSync(join(newerProfile.root, 'profile.json')).mode,
    markerMtime: statSync(join(newerProfile.root, 'profile.json')).mtimeMs,
    sentinelMode: statSync(newerSentinel).mode,
    sentinelMtime: statSync(newerSentinel).mtimeMs,
  };
  assert.throws(
    () => migrateAppProfile(newerProfile, {
      profileName: 'future',
      legacyConfigDir: legacy,
    }),
    /created by a newer application version/i,
  );
  assert.deepEqual(readdirSync(newerProfile.root).sort(), newerBefore.entries);
  assert.equal(statSync(newerProfile.root).mode, newerBefore.rootMode);
  assert.equal(statSync(newerProfile.root).mtimeMs, newerBefore.rootMtime);
  assert.equal(
    statSync(join(newerProfile.root, 'profile.json')).mode,
    newerBefore.markerMode,
  );
  assert.equal(
    statSync(join(newerProfile.root, 'profile.json')).mtimeMs,
    newerBefore.markerMtime,
  );
  assert.equal(statSync(newerSentinel).mode, newerBefore.sentinelMode);
  assert.equal(statSync(newerSentinel).mtimeMs, newerBefore.sentinelMtime);
  assert.equal(readFileSync(newerSentinel, 'utf8'), 'future data\n');

  const hardlinkedMarkerProfile = paths(join(temp, 'hardlinked-marker-profile'));
  const hardlinkedMarkerOutside = join(temp, 'hardlinked-marker-outside.json');
  mkdirSync(hardlinkedMarkerProfile.root);
  writeFileSync(hardlinkedMarkerOutside, JSON.stringify({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profile: 'hardlinked-marker',
    appliedMigrations: [],
  }));
  linkSync(
    hardlinkedMarkerOutside,
    join(hardlinkedMarkerProfile.root, 'profile.json'),
  );
  assert.throws(
    () => migrateAppProfile(hardlinkedMarkerProfile, {
      profileName: 'hardlinked-marker',
      legacyConfigDir: legacy,
    }),
    /Cannot safely open IDACC profile metadata/i,
  );
  assert.deepEqual(
    readdirSync(hardlinkedMarkerProfile.root),
    ['profile.json'],
    'a hard-linked marker must fail before profile directories are created',
  );

  // Corrupt metadata is never overwritten with a fresh profile.
  const corrupt = paths(join(temp, 'corrupt'));
  mkdirSync(corrupt.root, { recursive: true });
  writeFileSync(join(corrupt.root, 'profile.json'), '{not-json');
  assert.throws(
    () => migrateAppProfile(corrupt, { profileName: 'default', legacyConfigDir: legacy }),
    /Cannot safely open IDACC profile metadata/,
  );
  assert.equal(readFileSync(join(corrupt.root, 'profile.json'), 'utf8'), '{not-json');

  if (process.platform !== 'win32') {
    if (process.platform === 'darwin') {
      const macAclProfile = paths(join(temp, 'mac-acl-profile'));
      const macAclSecret = join(macAclProfile.root, 'config', 'secret.json');
      const macWorkspaceFile = join(
        macAclProfile.workspace,
        'repo',
        'user-managed.txt',
      );
      mkdirSync(dirname(macAclSecret), { recursive: true });
      mkdirSync(dirname(macWorkspaceFile), { recursive: true });
      writeFileSync(macAclSecret, '{"secret":true}\n', { mode: 0o600 });
      writeFileSync(macWorkspaceFile, 'workspace\n', { mode: 0o600 });
      writeFileSync(join(macAclProfile.root, 'profile.json'), JSON.stringify({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile: 'mac-acl',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
        migratedFrom: null,
        appliedMigrations: [],
      }) + '\n');
      assert.equal(
        spawnSync('/usr/bin/xattr', [
          '-w',
          'com.idacc.acl-regression',
          'present',
          macAclSecret,
        ]).status,
        0,
      );
      for (const path of [
        macAclProfile.root,
        macAclSecret,
        macWorkspaceFile,
      ]) {
        assert.equal(
          spawnSync('/bin/chmod', ['+a', 'everyone allow read', path]).status,
          0,
          `macOS ACL fixture could not be created for ${path}`,
        );
      }
      const aclListing = (path: string): string => {
        const result = spawnSync('/bin/ls', ['-ldeb', path], {
          encoding: 'utf8',
        });
        assert.equal(result.status, 0);
        return String(result.stdout || '');
      };
      assert.match(aclListing(macAclSecret), /^\S+@/);
      assert.equal(
        macAclListingHasExtendedAcl(aclListing(macAclSecret)),
        true,
        'ACL entry lines must still be detected when an xattr changes + to @',
      );
      migrateAppProfile(macAclProfile, {
        profileName: 'mac-acl',
        legacyConfigDir: join(temp, 'missing-mac-legacy'),
        allowLegacyImport: false,
      });
      assert.equal(macAclListingHasExtendedAcl(aclListing(macAclProfile.root)), false);
      assert.equal(macAclListingHasExtendedAcl(aclListing(macAclSecret)), false);
      assert.equal(
        macAclListingHasExtendedAcl(aclListing(macWorkspaceFile)),
        true,
        'workspace descendant ACLs remain user-managed',
      );
    }

    const hardlinkedStateProfile = paths(join(temp, 'hardlinked-state-profile'));
    const hardlinkedStateOutside = join(temp, 'hardlinked-state-outside.json');
    mkdirSync(join(hardlinkedStateProfile.root, 'config'), { recursive: true });
    writeFileSync(hardlinkedStateOutside, '{"outside":true}\n', { mode: 0o644 });
    linkSync(
      hardlinkedStateOutside,
      join(hardlinkedStateProfile.root, 'config', 'shared.json'),
    );
    writeFileSync(join(hardlinkedStateProfile.root, 'profile.json'), JSON.stringify({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: 'hardlinked-state',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migratedFrom: null,
      appliedMigrations: [],
    }) + '\n');
    const outsideModeBefore = statSync(hardlinkedStateOutside).mode & 0o777;
    assert.throws(
      () => migrateAppProfile(hardlinkedStateProfile, {
        profileName: 'hardlinked-state',
        legacyConfigDir: join(temp, 'missing-hardlinked-state'),
        allowLegacyImport: false,
      }),
      /unsupported file type/i,
    );
    assert.equal(
      statSync(hardlinkedStateOutside).mode & 0o777,
      outsideModeBefore,
      'a nested profile hard link must be rejected before chmod reaches its outside inode',
    );

    const outside = join(temp, 'outside.json');
    writeFileSync(outside, '{"outside":true}\n');

    const linkedLegacy = join(temp, 'linked-legacy');
    mkdirSync(linkedLegacy);
    symlinkSync(outside, join(linkedLegacy, 'config.json'));
    const linkedSourceProfile = paths(join(temp, 'linked-source-profile'));
    assert.throws(
      () => migrateAppProfile(linkedSourceProfile, {
        profileName: 'default',
        legacyConfigDir: linkedLegacy,
      }),
      /refusing symbolic link in legacy profile data/,
    );
    assert.equal(existsSync(linkedSourceProfile.config), false);

    const linkedDestinationProfile = paths(join(temp, 'linked-destination-profile'));
    mkdirSync(linkedDestinationProfile.root);
    symlinkSync(join(temp, 'outside-dir'), join(linkedDestinationProfile.root, 'config'));
    mkdirSync(join(temp, 'outside-dir'));
    assert.throws(
      () => migrateAppProfile(linkedDestinationProfile, {
        profileName: 'default',
        legacyConfigDir: join(temp, 'missing'),
      }),
      /refusing symbolic link in profile state/,
    );
    assert.equal(existsSync(join(temp, 'outside-dir', 'config.json')), false);
  } else {
    const newerAclBefore = windowsPowerShellForTest(
      WINDOWS_READ_NEWER_TREE_ACL,
      newerProfile.root,
    ).trim();
    assert.throws(
      () => secureWindowsProfileRoot(newerProfile.root, {
        maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
      }),
      /created by a newer application version/i,
    );
    assert.equal(
      windowsPowerShellForTest(
        WINDOWS_READ_NEWER_TREE_ACL,
        newerProfile.root,
      ).trim(),
      newerAclBefore,
      'native Windows compatibility rejection must not change any tree ACL',
    );

    // A valid steady-state attestation must not make a later migration copy a
    // permissive source DACL. Profile copies create new private files from
    // content instead of asking Windows CopyFile to preserve source security.
    const permissiveLegacy = join(temp, 'permissive-legacy');
    const copiedAclProfile = paths(join(temp, 'copied-acl-profile'));
    mkdirSync(permissiveLegacy);
    writeFileSync(
      join(permissiveLegacy, 'config.json'),
      '{"version":1,"defaultTeam":"default"}\n',
    );
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ADD_LEGACY_CONFIG_ACL,
        permissiveLegacy,
      ),
      /IDACC_TEST_LEGACY_CONFIG_PERMISSIVE_OK/,
    );
    mkdirSync(copiedAclProfile.root);
    writeFileSync(join(copiedAclProfile.root, 'profile.json'), JSON.stringify({
      schemaVersion: 0,
      profile: 'default',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migratedFrom: null,
      appliedMigrations: [],
    }) + '\n');
    secureWindowsProfileRoot(copiedAclProfile.root, {
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
    });
    assert.equal(
      existsSync(join(copiedAclProfile.root, '.idacc-windows-acl-v3.json')),
      true,
      'the fixture must begin with a valid bounded attestation',
    );
    migrateAppProfile(copiedAclProfile, {
      profileName: 'default',
      legacyConfigDir: permissiveLegacy,
    });
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ASSERT_PRIVATE_PROFILE_CONFIG_ACL,
        copiedAclProfile.root,
      ),
      /IDACC_TEST_MIGRATED_CONFIG_PRIVATE_OK/,
      'migration must not copy a permissive legacy DACL into the profile',
    );
    assert.equal(
      existsSync(join(copiedAclProfile.root, '.idacc-windows-acl-v3.json')),
      true,
      'safe inherited copies must preserve the valid bounded attestation',
    );

    // Invalidate the v2 policy proof issued by the first hardening wave. That
    // proof predates private content-copy semantics, so a v3 launch must scan
    // and repair every existing app-owned child before accepting steady state.
    const oldProofProfile = paths(join(temp, 'old-v2-proof-profile'));
    mkdirSync(join(oldProofProfile.root, 'config'), { recursive: true });
    writeFileSync(join(oldProofProfile.root, 'profile.json'), JSON.stringify({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: 'default',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migratedFrom: null,
      appliedMigrations: [],
    }) + '\n');
    writeFileSync(
      oldProofProfile.config,
      '{"version":1,"defaultTeam":"default"}\n',
    );
    secureWindowsProfileRoot(oldProofProfile.root, {
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
    });
    const currentProof = join(
      oldProofProfile.root,
      '.idacc-windows-acl-v3.json',
    );
    const oldProof = join(
      oldProofProfile.root,
      '.idacc-windows-acl-v2.json',
    );
    renameSync(currentProof, oldProof);
    writeFileSync(oldProof, JSON.stringify({
      version: 2,
      userSid: 'fixture-value-is-ignored-by-v3',
      workspacePolicy: 'root-only',
    }) + '\n');
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ADD_PROFILE_CONFIG_ACL,
        oldProofProfile.root,
      ),
      /IDACC_TEST_PROFILE_CONFIG_PERMISSIVE_OK/,
    );
    secureWindowsProfileRoot(oldProofProfile.root, {
      maximumSchemaVersion: PROFILE_SCHEMA_VERSION,
    });
    assert.equal(existsSync(currentProof), true);
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ASSERT_PRIVATE_PROFILE_CONFIG_ACL,
        oldProofProfile.root,
      ),
      /IDACC_TEST_MIGRATED_CONFIG_PRIVATE_OK/,
      'a v2 proof must not bypass v3 recursive child hardening',
    );

    // This branch runs in the real Windows CI job. Begin with an explicit
    // Everyone grant on both the profile root and a child file, then prove the
    // production helper recursively replaces and verifies both DACLs.
    const windowsAclProfile = join(temp, 'windows-acl-profile');
    const windowsAclChildDirectory = join(windowsAclProfile, 'nested');
    mkdirSync(windowsAclChildDirectory, { recursive: true });
    writeFileSync(join(windowsAclChildDirectory, 'secret.txt'), 'private\n');
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_PERMISSIVE_ACL, windowsAclProfile),
      /IDACC_TEST_PERMISSIVE_OK/,
    );
    secureWindowsProfileRoot(windowsAclProfile);
    assert.match(
      windowsPowerShellForTest(WINDOWS_ASSERT_PRIVATE_ACL, windowsAclProfile),
      /IDACC_TEST_PRIVATE_OK/,
    );

    // Retained no-follow handles make conversion transactional with respect to
    // path identity: a pre-opened writer conflicts during the complete scan, so
    // no object ACL is changed before the helper fails closed.
    const lockedWriterProfile = join(temp, 'locked-writer-profile');
    const lockedWriterDirectory = join(lockedWriterProfile, 'nested');
    const lockedWriterFile = join(lockedWriterDirectory, 'secret.txt');
    mkdirSync(lockedWriterDirectory, { recursive: true });
    writeFileSync(lockedWriterFile, 'held open\n');
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_PERMISSIVE_ACL, lockedWriterProfile),
      /IDACC_TEST_PERMISSIVE_OK/,
    );
    const lockedWriterAclBefore = windowsPowerShellForTest(
      WINDOWS_READ_SECRET_ACL,
      lockedWriterProfile,
    ).trim();
    const competingWriter = openSync(lockedWriterFile, 'r+');
    try {
      assert.throws(
        () => secureWindowsProfileRoot(lockedWriterProfile),
        /could not establish and verify private Windows access/i,
      );
    } finally {
      closeSync(competingWriter);
    }
    assert.equal(
      windowsPowerShellForTest(
        WINDOWS_READ_SECRET_ACL,
        lockedWriterProfile,
      ).trim(),
      lockedWriterAclBefore,
      'a competing writer must cause failure before every ACL mutation',
    );
    secureWindowsProfileRoot(lockedWriterProfile);
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ASSERT_PRIVATE_ACL,
        lockedWriterProfile,
      ),
      /IDACC_TEST_PRIVATE_OK/,
    );

    // The retained-handle budget is a fail-before-mutation production bound,
    // not only a timeout. Exceeding it leaves the original tree untouched.
    const overLimitProfile = join(temp, 'over-limit-profile');
    const overLimitNested = join(overLimitProfile, 'nested');
    const overLimitBulk = join(overLimitProfile, 'bulk');
    mkdirSync(overLimitNested, { recursive: true });
    mkdirSync(overLimitBulk);
    writeFileSync(join(overLimitNested, 'secret.txt'), 'private\n');
    writeFileSync(join(overLimitProfile, 'profile.json'), JSON.stringify({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: 'large-non-cache',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      migratedFrom: null,
      appliedMigrations: [],
    }) + '\n');
    for (let index = 0; index < 4093; index += 1) {
      writeFileSync(join(overLimitBulk, `${index}.txt`), 'x');
    }
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_PERMISSIVE_ACL, overLimitProfile),
      /IDACC_TEST_PERMISSIVE_OK/,
    );
    const overLimitAclBefore = windowsPowerShellForTest(
      WINDOWS_READ_SECRET_ACL,
      overLimitProfile,
    ).trim();
    assert.throws(
      () => secureWindowsProfileRoot(overLimitProfile, {
        allowLargeProfileUpgrade: false,
      }),
      /could not establish and verify private Windows access/i,
    );
    assert.equal(
      windowsPowerShellForTest(
        WINDOWS_READ_SECRET_ACL,
        overLimitProfile,
      ).trim(),
      overLimitAclBefore,
      'the object bound must fail before every ACL mutation',
    );
    secureWindowsProfileRoot(overLimitProfile);
    assert.match(
      windowsPowerShellForTest(WINDOWS_ASSERT_PRIVATE_ACL, overLimitProfile),
      /IDACC_TEST_PRIVATE_OK/,
      'the production large-profile upgrade must harden non-cache state',
    );
    const largeProfileAttestation = join(
      overLimitProfile,
      '.idacc-windows-acl-v3.json',
    );
    const largeProfileAttestationMtime = statSync(
      largeProfileAttestation,
    ).mtimeMs;
    secureWindowsProfileRoot(overLimitProfile);
    assert.equal(
      statSync(largeProfileAttestation).mtimeMs,
      largeProfileAttestationMtime,
      'the second large-profile launch must use its verified attestation',
    );

    // Hardening the profile itself is insufficient if an untrusted principal
    // can replace it through a permissive parent directory.
    const replaceableParent = join(temp, 'replaceable-parent');
    const replaceableProfile = join(replaceableParent, 'nested');
    mkdirSync(replaceableProfile, { recursive: true });
    writeFileSync(join(replaceableProfile, 'secret.txt'), 'private\n');
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_PERMISSIVE_ACL, replaceableParent),
      /IDACC_TEST_PERMISSIVE_OK/,
    );
    assert.throws(
      () => secureWindowsProfileRoot(replaceableProfile),
      /could not establish and verify private Windows access/i,
    );

    // Directory junctions are reparse points and must fail before ACL mutation.
    const junctionTarget = join(temp, 'junction-target');
    const junctionProfile = join(temp, 'junction-profile');
    mkdirSync(junctionTarget);
    mkdirSync(junctionProfile);
    symlinkSync(junctionTarget, join(junctionProfile, 'linked'), 'junction');
    assert.throws(
      () => secureWindowsProfileRoot(junctionProfile),
      /could not establish and verify private Windows access/i,
    );

    // InheritOnly does not mean harmless: a ContainerInherit rule on any
    // ancestor grants its dangerous rights to a directory on the path.
    const inheritOnlyParent = join(temp, 'inherit-only-parent');
    const inheritOnlyProfile = join(inheritOnlyParent, 'profiles', 'default');
    mkdirSync(inheritOnlyParent);
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_INHERIT_ONLY_ACL, inheritOnlyParent),
      /IDACC_TEST_INHERIT_ONLY_OK/,
    );
    assert.throws(
      () => secureWindowsProfileRoot(inheritOnlyProfile),
      /could not establish and verify private Windows access/i,
    );
    assert.equal(
      existsSync(inheritOnlyProfile),
      false,
      'unsafe inherited rights must be rejected before creating the profile',
    );

    // A create-only grant is sufficient to win a missing-path race and retain
    // an open handle after the profile ACL is replaced.
    const createChildParent = join(temp, 'create-child-parent');
    const createChildProfile = join(createChildParent, 'profiles', 'default');
    mkdirSync(createChildParent);
    assert.match(
      windowsPowerShellForTest(WINDOWS_ADD_CREATE_CHILD_ACL, createChildParent),
      /IDACC_TEST_CREATE_CHILD_OK/,
    );
    assert.throws(
      () => secureWindowsProfileRoot(createChildProfile),
      /could not establish and verify private Windows access/i,
    );
    assert.equal(
      existsSync(createChildProfile),
      false,
      'untrusted child-creation rights must be rejected before path creation',
    );

    // A hard-linked file aliases one security descriptor outside the profile.
    // Detection must happen for the entire tree before even the root ACL moves.
    const hardlinkProfile = join(temp, 'hardlink-profile');
    const hardlinkOutside = join(temp, 'hardlink-outside.txt');
    mkdirSync(hardlinkProfile);
    writeFileSync(hardlinkOutside, 'shared inode\n');
    linkSync(hardlinkOutside, join(hardlinkProfile, 'linked.txt'));
    const hardlinkAclBefore = windowsPowerShellForTest(
      WINDOWS_READ_ROOT_AND_LINK_ACL,
      hardlinkProfile,
    ).trim();
    assert.throws(
      () => secureWindowsProfileRoot(hardlinkProfile),
      /could not establish and verify private Windows access/i,
    );
    assert.equal(
      windowsPowerShellForTest(
        WINDOWS_READ_ROOT_AND_LINK_ACL,
        hardlinkProfile,
      ).trim(),
      hardlinkAclBefore,
      'hard-link rejection must precede every ACL mutation',
    );

    // Existing repository contents are outside recursive app-state hardening.
    // A deliberate junction and a nonstandard file ACL must survive unchanged.
    // The workspace root itself is private and protects future direct children,
    // but existing descendant ACLs remain user-managed and may permit direct
    // access to a principal that already knows their path.
    const opaqueWorkspaceProfile = join(temp, 'opaque-workspace-profile');
    const opaqueWorkspace = join(opaqueWorkspaceProfile, 'workspace');
    const opaqueRepository = join(opaqueWorkspace, 'repo');
    const opaqueJunctionTarget = join(temp, 'opaque-junction-target');
    mkdirSync(opaqueRepository, { recursive: true });
    mkdirSync(opaqueJunctionTarget);
    writeFileSync(join(opaqueWorkspaceProfile, 'profile.json'), JSON.stringify({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: 'opaque-workspace',
      appliedMigrations: [],
    }));
    writeFileSync(join(opaqueRepository, 'preserve.txt'), 'preserve me\n');
    symlinkSync(
      opaqueJunctionTarget,
      join(opaqueRepository, 'deliberate-junction'),
      'junction',
    );
    const workspaceFileAclBefore = windowsPowerShellForTest(
      WINDOWS_ADD_WORKSPACE_FILE_ACL,
      opaqueWorkspaceProfile,
    ).trim();
    secureWindowsProfileRoot(opaqueWorkspaceProfile);
    assert.equal(
      windowsPowerShellForTest(
        WINDOWS_READ_WORKSPACE_FILE_ACL,
        opaqueWorkspaceProfile,
      ).trim(),
      workspaceFileAclBefore,
      'workspace descendant ACLs must remain untouched',
    );
    assert.equal(
      lstatSync(join(opaqueRepository, 'deliberate-junction')).isSymbolicLink(),
      true,
      'workspace junctions must remain present and uninspected',
    );
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ASSERT_PRIVATE_DIRECTORY_ACL,
        opaqueWorkspace,
      ),
      /IDACC_TEST_PRIVATE_DIRECTORY_OK/,
    );
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_CREATE_AND_ASSERT_PRIVATE_WORKSPACE_CHILD,
        opaqueWorkspaceProfile,
      ),
      /IDACC_TEST_PRIVATE_WORKSPACE_CHILD_OK/,
      'new workspace content must inherit the private user-and-System boundary',
    );
    const opaqueAttestation = join(
      opaqueWorkspaceProfile,
      '.idacc-windows-acl-v3.json',
    );
    const attestationMtime = statSync(opaqueAttestation).mtimeMs;
    secureWindowsProfileRoot(opaqueWorkspaceProfile);
    assert.equal(
      statSync(opaqueAttestation).mtimeMs,
      attestationMtime,
      'an exact attested profile must use the bounded steady-state path',
    );

    // The consumer default starts below a profiles parent that does not yet
    // exist. The privacy boundary must safely create the complete path.
    const freshDefaultProfile = join(
      temp,
      'fresh-windows-user-data',
      'profiles',
      'default',
    );
    assert.equal(existsSync(join(temp, 'fresh-windows-user-data')), false);
    secureWindowsProfileRoot(freshDefaultProfile);
    assert.equal(existsSync(freshDefaultProfile), true);
    assert.equal(
      existsSync(join(freshDefaultProfile, '.idacc-windows-acl-v3.json')),
      false,
      'an interrupted bootstrap must leave an otherwise empty selectable root',
    );
    assert.match(
      windowsPowerShellForTest(
        WINDOWS_ASSERT_PRIVATE_DIRECTORY_ACL,
        freshDefaultProfile,
      ),
      /IDACC_TEST_PRIVATE_DIRECTORY_OK/,
    );
    migrateAppProfile(paths(freshDefaultProfile), {
      profileName: 'default',
      legacyConfigDir: join(temp, 'fresh-missing-legacy'),
      allowLegacyImport: false,
    });
    secureWindowsProfileRoot(freshDefaultProfile);
    assert.equal(
      existsSync(join(freshDefaultProfile, '.idacc-windows-acl-v3.json')),
      true,
      'the completed migrated profile must gain its steady-state attestation',
    );
  }

  process.stdout.write('profile migrations smoke: ok\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
