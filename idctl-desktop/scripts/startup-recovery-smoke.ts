import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  readAppProfilePreference,
  readAppProfilePreferenceForSelection,
  validateExplicitProfileDataDir,
  validateRecoveryProfileFolder,
  writeAppProfilePreference,
} from '../src/main/appProfilePreference.ts';
import {
  appendPrivateAppTextFile,
  ensurePrivateAppDirectory,
  openPrivateAppAppendFile,
  readPrivateAppTextFile,
  writePrivateAppTextFileAtomic,
} from '../src/main/appStatePrivacy.ts';
import {
  secureWindowsPrivatePath,
  WINDOWS_PROFILE_ACL_BOOTSTRAP,
} from '../src/main/profilePrivacy.ts';
import { isTrustedPrivatePathOwner } from '../src/main/posixFilePrivacy.ts';
import {
  freshRecoveryProfileName,
  runStartupRecoveryLoop,
  startupFailureReport,
} from '../src/main/startupRecovery.ts';

const WINDOWS_ADD_PERMISSIVE_APP_STATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$path = [string]$env:IDACC_APP_STATE_TEST_PATH
$kind = [string]$env:IDACC_APP_STATE_TEST_KIND
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
if ($kind -eq 'directory') {
  $acl = [System.IO.Directory]::GetAccessControl($path)
  $inheritance = (
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  )
} else {
  $acl = [System.IO.File]::GetAccessControl($path)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
if ($kind -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($path, $acl)
} else {
  [System.IO.File]::SetAccessControl($path, $acl)
}
`;

const WINDOWS_ASSERT_EXACT_APP_STATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$path = [string]$env:IDACC_APP_STATE_TEST_PATH
$kind = [string]$env:IDACC_APP_STATE_TEST_KIND
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($kind -eq 'directory') {
  $acl = [System.IO.Directory]::GetAccessControl($path)
  $expectedInheritance = (
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  )
} else {
  $acl = [System.IO.File]::GetAccessControl($path)
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
if (-not $acl.AreAccessRulesProtected) {
  throw 'application-state ACL inheritance remains enabled'
}
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $userSid.Value) {
  throw 'application-state ACL owner is incorrect'
}
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne 2) {
  throw 'application-state ACL has an unexpected rule count'
}
foreach ($sid in @($userSid, $systemSid)) {
  $matches = @($rules | Where-Object {
    $_.IdentityReference.Value -eq $sid.Value
  })
  if ($matches.Count -ne 1) {
    throw 'application-state ACL is missing a required rule'
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
    throw 'application-state ACL rule is not exact-private'
  }
}
`;

function runWindowsAppStateAclFixture(
  script: string,
  path: string,
  kind: 'file' | 'directory',
): void {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '');
  assert.ok(systemRoot, 'Windows app-state ACL smoke requires SystemRoot or WINDIR');
  const result = spawnSync(
    join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-OutputFormat',
      'Text',
      '-Command',
      WINDOWS_PROFILE_ACL_BOOTSTRAP,
    ],
    {
      input: script,
      encoding: 'utf8',
      env: {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR,
        WINDIR: process.env.WINDIR || process.env.SystemRoot,
        IDACC_APP_STATE_TEST_PATH: path,
        IDACC_APP_STATE_TEST_KIND: kind,
        ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
        ...(process.env.PSModulePath ? { PSModulePath: process.env.PSModulePath } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    'Windows app-state ACL fixture failed',
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
}

async function main(): Promise<void> {
assert.equal(isTrustedPrivatePathOwner(0, 1001), true);
assert.equal(isTrustedPrivatePathOwner(1001, 1001), true);
assert.equal(isTrustedPrivatePathOwner(1002, 1001), false);
const secret = `github_pat_${'x'.repeat(32)}`;
const localPath = `/Users/private-person/idacc/profile-${Date.now()}`;
const profileFailure = Object.assign(
  new Error(`IDACC profile migration failed at ${localPath}?token=${secret}`),
  { code: 'EACCES' },
);
const report = startupFailureReport(profileFailure);
assert.equal(report.code, 'profile-unavailable');
assert.equal(report.systemCode, 'EACCES');
assert.match(report.diagnosticId, /^[A-F0-9]{12}$/);
assert.doesNotMatch(JSON.stringify(report), /private-person/);
assert.doesNotMatch(JSON.stringify(report), /github_pat_/);
assert.doesNotMatch(JSON.stringify(report), /migration failed/i);
assert.match(report.detail, /files remain in place/i);

const newer = startupFailureReport(new Error('This IDACC profile was created by a newer application version.'));
assert.equal(newer.code, 'profile-newer');
assert.match(newer.detail, /did not change or reset/i);

const runtime = startupFailureReport(new Error(`Manager spawn failed with token=${secret}`));
assert.equal(runtime.code, 'runtime-unavailable');
assert.doesNotMatch(JSON.stringify(runtime), /github_pat_/);
assert.match(runtime.detail, /Manager and Brain were stopped safely/i);

const fixedFreshAt = new Date('2026-07-26T01:02:03.456Z');
const firstFreshName = freshRecoveryProfileName(fixedFreshAt, 'A1B2C3D4');
const secondFreshName = freshRecoveryProfileName(fixedFreshAt, '01020304');
assert.equal(firstFreshName, 'recovery-20260726-010203-456-a1b2c3d4');
assert.equal(secondFreshName, 'recovery-20260726-010203-456-01020304');
assert.notEqual(firstFreshName, secondFreshName);
assert.match(firstFreshName, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

let starts = 0;
const failures: string[] = [];
const recovered = await runStartupRecoveryLoop(
  async () => {
    starts += 1;
    if (starts === 1) throw profileFailure;
  },
  async (failure) => {
    failures.push(failure.diagnosticId);
    return 'retry';
  },
);
assert.equal(recovered, true);
assert.equal(starts, 2);
assert.deepEqual(failures, [report.diagnosticId]);

const quit = await runStartupRecoveryLoop(
  async () => { throw new Error('bundled runtime unavailable'); },
  async () => 'quit',
);
assert.equal(quit, false);

const scratch = mkdtempSync(join(tmpdir(), 'idacc-startup-recovery-'));
try {
  assert.equal(readAppProfilePreference(scratch), null);

  assert.deepEqual(
    writeAppProfilePreference(scratch, { profile: 'recovery-20260726-010203' }),
    { profile: 'recovery-20260726-010203' },
  );
  assert.deepEqual(
    readAppProfilePreference(scratch),
    { profile: 'recovery-20260726-010203' },
  );
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(scratch).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(scratch, 'active-profile.json')).mode & 0o777, 0o600);
  }

  const windowsSingleObjectModes: string[] = [];
  secureWindowsPrivatePath('C:\\IDACC\\state.json', 'file', {
    platform: 'win32',
    runner: (_root, _maximumSchemaVersion, mode) => {
      windowsSingleObjectModes.push(String(mode));
      return { status: 0, stdout: 'IDACC_WINDOWS_PROFILE_ACL_OK:1\n' };
    },
  });
  secureWindowsPrivatePath('C:\\IDACC\\state', 'directory', {
    platform: 'win32',
    runner: (_root, _maximumSchemaVersion, mode) => {
      windowsSingleObjectModes.push(String(mode));
      return { status: 0, stdout: 'IDACC_WINDOWS_PROFILE_ACL_OK:1\n' };
    },
  });
  assert.deepEqual(
    windowsSingleObjectModes,
    ['single-file', 'single-directory'],
    'bounded app-state hardening must select the exact single-object ACL modes',
  );
  assert.throws(
    () => secureWindowsPrivatePath('C:\\IDACC\\state.json', 'file', {
      platform: 'win32',
      runner: () => ({ status: 0, stdout: 'unverified\n' }),
    }),
    /application-state path/i,
  );

  const privateStateRoot = join(scratch, 'private-app-state');
  ensurePrivateAppDirectory(privateStateRoot);
  const privateStateFile = join(privateStateRoot, 'state.json');
  writeFileSync(privateStateFile, '{"before":true}', { mode: 0o666 });
  if (process.platform !== 'win32') chmodSync(privateStateFile, 0o666);
  assert.equal(readPrivateAppTextFile(privateStateFile), '{"before":true}');
  if (process.platform !== 'win32') {
    assert.equal(
      lstatSync(privateStateFile).mode & 0o777,
      0o600,
      'an existing permissive state file must be hardened before it is read',
    );
  }
  appendPrivateAppTextFile(privateStateFile, '\n{"after":true}');
  assert.match(readFileSync(privateStateFile, 'utf8'), /"after":true/);
  writePrivateAppTextFileAtomic(privateStateFile, '{"atomic":true}');
  assert.equal(readFileSync(privateStateFile, 'utf8'), '{"atomic":true}');
  const filesystemRoot = parse(resolve(scratch)).root;
  const filesystemRootBefore = lstatSync(filesystemRoot);
  assert.throws(
    () => ensurePrivateAppDirectory(filesystemRoot),
    /unsafe/i,
    'an application-state directory may never be a filesystem root',
  );
  const filesystemRootAfter = lstatSync(filesystemRoot);
  assert.equal(filesystemRootAfter.dev, filesystemRootBefore.dev);
  assert.equal(filesystemRootAfter.ino, filesystemRootBefore.ino);
  if (process.platform !== 'win32') {
    assert.equal(
      filesystemRootAfter.mode & 0o777,
      filesystemRootBefore.mode & 0o777,
      'root rejection must precede every chmod',
    );
  }

  const descriptorLog = join(privateStateRoot, 'descriptor.log');
  appendPrivateAppTextFile(descriptorLog, 'before\n');
  const descriptorFd = openPrivateAppAppendFile(descriptorLog);
  const retainedDescriptorLog = join(privateStateRoot, 'descriptor-retained.log');
  const descriptorOutside = join(scratch, 'descriptor-outside.log');
  renameSync(descriptorLog, retainedDescriptorLog);
  if (process.platform !== 'win32') {
    symlinkSync(descriptorOutside, descriptorLog);
  }
  writeSync(descriptorFd, 'child-output\n');
  closeSync(descriptorFd);
  assert.match(
    readFileSync(retainedDescriptorLog, 'utf8'),
    /child-output/,
    'a child descriptor must remain attached to the verified file identity',
  );
  assert.equal(
    existsSync(descriptorOutside),
    false,
    'path replacement must not redirect writes made through the verified child descriptor',
  );
  if (process.platform !== 'win32') {
    assert.throws(
      () => appendPrivateAppTextFile(descriptorLog, 'exit\n'),
      /unsafe/i,
      'a later process-exit append must revalidate and reject the replaced path',
    );
    assert.equal(existsSync(descriptorOutside), false);
    rmSync(descriptorLog);

    const danglingTarget = join(scratch, 'outside-dangling-log');
    const danglingLog = join(privateStateRoot, 'dangling.log');
    symlinkSync(danglingTarget, danglingLog);
    assert.equal(
      existsSync(danglingLog),
      false,
      'the security regression requires an existsSync-invisible dangling symlink',
    );
    assert.throws(
      () => appendPrivateAppTextFile(danglingLog, 'must-not-escape\n'),
      /unsafe/i,
    );
    assert.equal(
      existsSync(danglingTarget),
      false,
      'a dangling log symlink must not create or write its outside target',
    );

    const ancestorOutside = join(scratch, 'ancestor-outside');
    const ancestorOutsideExisting = join(ancestorOutside, 'existing');
    const linkedAncestor = join(privateStateRoot, 'linked-ancestor');
    mkdirSync(ancestorOutsideExisting, { recursive: true, mode: 0o755 });
    chmodSync(ancestorOutsideExisting, 0o755);
    symlinkSync(ancestorOutside, linkedAncestor);
    assert.throws(
      () => ensurePrivateAppDirectory(join(linkedAncestor, 'existing')),
      /unsafe/i,
      'a final ordinary directory reached through a linked ancestor must fail closed',
    );
    assert.equal(
      lstatSync(ancestorOutsideExisting).mode & 0o777,
      0o755,
      'ancestor rejection must happen before chmod mutates the outside directory',
    );
    const ancestorOutsideMissing = join(ancestorOutside, 'must-not-create');
    assert.throws(
      () => ensurePrivateAppDirectory(join(linkedAncestor, 'must-not-create')),
      /unsafe/i,
    );
    assert.equal(
      existsSync(ancestorOutsideMissing),
      false,
      'recursive directory creation must not follow a linked ancestor',
    );
  }

  if (process.platform === 'win32') {
    const windowsAclRoot = join(scratch, 'windows-app-state-acl');
    mkdirSync(windowsAclRoot);
    const windowsAclFile = join(windowsAclRoot, 'state.json');
    writeFileSync(windowsAclFile, '{"private":true}');
    runWindowsAppStateAclFixture(
      WINDOWS_ADD_PERMISSIVE_APP_STATE_ACL,
      windowsAclRoot,
      'directory',
    );
    runWindowsAppStateAclFixture(
      WINDOWS_ADD_PERMISSIVE_APP_STATE_ACL,
      windowsAclFile,
      'file',
    );
    secureWindowsPrivatePath(windowsAclRoot, 'directory');
    secureWindowsPrivatePath(windowsAclFile, 'file');
    runWindowsAppStateAclFixture(
      WINDOWS_ASSERT_EXACT_APP_STATE_ACL,
      windowsAclRoot,
      'directory',
    );
    runWindowsAppStateAclFixture(
      WINDOWS_ASSERT_EXACT_APP_STATE_ACL,
      windowsAclFile,
      'file',
    );
  }

  const selected = join(scratch, 'Selected Profile');
  assert.deepEqual(
    writeAppProfilePreference(scratch, { dataDir: selected }),
    { dataDir: selected },
  );
  assert.deepEqual(readAppProfilePreference(scratch), { dataDir: selected });

  writeFileSync(join(scratch, 'active-profile.json'), '{not-json', 'utf8');
  let corruptPreferenceError: unknown;
  try {
    readAppProfilePreference(scratch);
  } catch (error) {
    corruptPreferenceError = error;
  }
  assert.ok(corruptPreferenceError instanceof Error);
  assert.match(corruptPreferenceError.message, /could not be read safely/i);
  assert.equal(
    readAppProfilePreferenceForSelection(scratch, {
      dataDir: join(scratch, 'override-profile'),
    }),
    null,
    'an explicit data-directory override must bypass a corrupt saved pointer',
  );
  assert.equal(
    readAppProfilePreferenceForSelection(scratch, { profile: 'fresh-profile' }),
    null,
    'an explicit named-profile override must bypass a corrupt saved pointer',
  );
  assert.throws(
    () => readAppProfilePreferenceForSelection(scratch, {}),
    /could not be read safely/i,
    'without an override the corrupt pointer must remain a visible startup failure',
  );
  const corruptPreferenceReport = startupFailureReport(corruptPreferenceError);
  assert.equal(corruptPreferenceReport.code, 'profile-unavailable');
  assert.doesNotMatch(JSON.stringify(corruptPreferenceReport), /active-profile|not-json/i);
  assert.throws(
    () => writeAppProfilePreference(scratch, { profile: '../outside' }),
    /invalid/i,
  );
  rmSync(join(scratch, 'active-profile.json'));
  const hardlinkedPreferenceSource = join(scratch, 'hardlinked-preference.json');
  writeFileSync(hardlinkedPreferenceSource, JSON.stringify({
    version: 1,
    profile: 'default',
  }));
  linkSync(
    hardlinkedPreferenceSource,
    join(scratch, 'active-profile.json'),
  );
  assert.throws(
    () => readAppProfilePreference(scratch),
    /could not be read safely/i,
  );
  assert.throws(
    () => writeAppProfilePreference(scratch, { profile: 'default' }),
    /unsafe/i,
  );
  rmSync(join(scratch, 'active-profile.json'));

  if (process.platform !== 'win32') {
    symlinkSync(join(scratch, 'outside-profile.json'), join(scratch, 'active-profile.json'));
    assert.throws(
      () => readAppProfilePreference(scratch),
      /could not be read safely/i,
    );
    assert.throws(
      () => writeAppProfilePreference(scratch, { profile: 'default' }),
      /unsafe/i,
    );
  }

  const userDataRoot = join(scratch, 'user-data');
  mkdirSync(userDataRoot);
  const missingEnvironmentProfile = join(scratch, 'missing-environment-profile');
  assert.equal(
    validateExplicitProfileDataDir(
      missingEnvironmentProfile,
      userDataRoot,
      { allowMissing: true },
    ),
    join(realpathSync.native(scratch), 'missing-environment-profile'),
    'IDACC_DATA_DIR may name a missing dedicated profile path',
  );
  assert.equal(
    existsSync(missingEnvironmentProfile),
    false,
    'validating a missing environment profile must not create it',
  );
  assert.throws(
    () => validateExplicitProfileDataDir(
      missingEnvironmentProfile,
      userDataRoot,
      { allowMissing: false },
    ),
    /unavailable/i,
    'a persisted data-directory pointer must resolve to an existing directory',
  );
  const emptyProfile = join(scratch, 'empty-profile');
  mkdirSync(emptyProfile);
  assert.equal(
    validateRecoveryProfileFolder(emptyProfile, userDataRoot),
    realpathSync.native(emptyProfile),
  );

  const existingProfile = join(scratch, 'existing-profile');
  mkdirSync(existingProfile);
  writeFileSync(join(existingProfile, 'profile.json'), JSON.stringify({
    schemaVersion: 5,
    profile: 'existing',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    migratedFrom: null,
    appliedMigrations: [],
  }));
  writeFileSync(join(existingProfile, 'existing-user-data.txt'), 'untouched');
  assert.equal(
    validateRecoveryProfileFolder(existingProfile, userDataRoot),
    realpathSync.native(existingProfile),
  );

  const hardlinkedProfile = join(scratch, 'hardlinked-profile');
  const hardlinkedMarker = join(scratch, 'hardlinked-profile-marker.json');
  mkdirSync(hardlinkedProfile);
  writeFileSync(hardlinkedMarker, JSON.stringify({
    schemaVersion: 5,
    profile: 'hardlinked',
    appliedMigrations: [],
  }));
  linkSync(hardlinkedMarker, join(hardlinkedProfile, 'profile.json'));
  assert.throws(
    () => validateRecoveryProfileFolder(hardlinkedProfile, userDataRoot),
    /empty folder or an existing IDACC profile/i,
  );

  const unrelatedFolder = join(scratch, 'unrelated-folder');
  mkdirSync(unrelatedFolder);
  writeFileSync(join(unrelatedFolder, 'personal.txt'), 'keep me');
  assert.throws(
    () => validateRecoveryProfileFolder(unrelatedFolder, userDataRoot),
    /empty folder or an existing IDACC profile/i,
  );
  assert.equal(readFileSync(join(unrelatedFolder, 'personal.txt'), 'utf8'), 'keep me');

  const fakeProfile = join(scratch, 'fake-profile');
  mkdirSync(fakeProfile);
  writeFileSync(join(fakeProfile, 'profile.json'), '{"schemaVersion":"not-idacc"}');
  assert.throws(
    () => validateRecoveryProfileFolder(fakeProfile, userDataRoot),
    /empty folder or an existing IDACC profile/i,
  );

  assert.throws(
    () => validateRecoveryProfileFolder(userDataRoot, userDataRoot),
    /dedicated folder/i,
  );
  assert.throws(
    () => validateExplicitProfileDataDir(
      join(userDataRoot, 'profiles'),
      userDataRoot,
      { allowMissing: true },
    ),
    /dedicated folder/i,
    'the broad profiles container is not itself a profile',
  );
  assert.throws(
    () => validateRecoveryProfileFolder(scratch, userDataRoot),
    /dedicated folder/i,
  );
  assert.throws(
    () => validateRecoveryProfileFolder(parse(resolve(scratch)).root, userDataRoot),
    /filesystem root/i,
  );

  const appParent = join(scratch, 'app-parent');
  mkdirSync(appParent);
  assert.throws(
    () => validateRecoveryProfileFolder(
      appParent,
      userDataRoot,
      [join(appParent, 'IDACC.app', 'Contents', 'Resources')],
    ),
    /dedicated folder/i,
  );
  const simulatedHome = join(scratch, 'simulated-home');
  const simulatedApp = join(scratch, 'simulated-app', 'IDACC.exe');
  mkdirSync(simulatedHome);
  mkdirSync(simulatedApp, { recursive: true });
  for (const broadRoot of [simulatedHome, simulatedApp]) {
    assert.throws(
      () => validateExplicitProfileDataDir(
        broadRoot,
        userDataRoot,
        {
          allowMissing: true,
          protectedRoots: [simulatedHome, simulatedApp],
        },
      ),
      /dedicated folder/i,
      'home and application roots must never be repurposed as profile state',
    );
  }
  const dedicatedHomeChild = join(simulatedHome, 'IDACC Profiles', 'personal');
  assert.equal(
    validateExplicitProfileDataDir(
      dedicatedHomeChild,
      userDataRoot,
      {
        allowMissing: true,
        protectedRoots: [simulatedHome],
        protectedTrees: [simulatedApp],
      },
    ),
    join(realpathSync.native(simulatedHome), 'IDACC Profiles', 'personal'),
    'dedicated descendants of the home root remain supported',
  );
  assert.throws(
    () => validateExplicitProfileDataDir(
      join(simulatedApp, 'resources', 'profile-data'),
      userDataRoot,
      {
        allowMissing: true,
        protectedRoots: [simulatedHome],
        protectedTrees: [simulatedApp],
      },
    ),
    /outside the installed application/i,
    'application descendants must never be selected as data directories',
  );

  if (process.platform !== 'win32') {
    const linkedUserDataTarget = join(scratch, 'linked-user-data-target');
    const linkedUserDataRoot = join(scratch, 'linked-user-data-root');
    mkdirSync(linkedUserDataTarget, { mode: 0o755 });
    symlinkSync(linkedUserDataTarget, linkedUserDataRoot);
    const linkedTargetMode = lstatSync(linkedUserDataTarget).mode & 0o777;
    assert.throws(
      () => writeAppProfilePreference(linkedUserDataRoot, {
        profile: 'must-not-follow',
      }),
      /could not be read safely/i,
    );
    assert.equal(
      lstatSync(linkedUserDataTarget).mode & 0o777,
      linkedTargetMode,
      'preference hardening must reject a linked root before chmod follows it',
    );

    const realProfile = join(scratch, 'real-profile');
    const linkedProfile = join(scratch, 'linked-profile');
    mkdirSync(realProfile);
    symlinkSync(realProfile, linkedProfile);
    assert.throws(
      () => validateRecoveryProfileFolder(linkedProfile, userDataRoot),
      /regular directory/i,
    );
  }

  const mainSource = readFileSync(join(process.cwd(), 'src/main/main.ts'), 'utf8');
  assert.match(mainSource, /runStartupRecoveryLoop\(/);
  assert.match(mainSource, /await cleanupFailedConsumerStartup\(\)/);
  assert.match(mainSource, /\.catch\(\(error\) => handleUnrecoverableStartupFailure\(error\)\)/);
  assert.match(mainSource, /Open Profile Folder/);
  assert.match(mainSource, /Choose Another Profile/);
  assert.match(mainSource, /Start Fresh Profile/);
  assert.match(mainSource, /async function restartWithRecoveryProfile\(/);
  assert.match(mainSource, /writeAppProfilePreference\(app\.getPath\('userData'\), preference\);[\s\S]*app\.relaunch\(\);/);
  assert.match(mainSource, /function privateUserDataDirectory\(\): string/);
  assert.match(mainSource, /return ensurePrivateAppDirectory\(app\.getPath\('userData'\)\)/);
  assert.match(mainSource, /appendPrivateAppTextFile\(path,[\s\S]*rendererSafeMode/);
  assert.match(
    mainSource,
    /function writeRendererCrashState[\s\S]*writePrivateAppTextFileAtomic\(/,
    'crash state must use private atomic replacement',
  );
  assert.match(
    mainSource,
    /function saveWinState[\s\S]*writePrivateAppTextFileInPlace\(/,
    'debounced window state must reuse a verified private identity',
  );
  assert.doesNotMatch(mainSource, /rememberRecoveryProfile/);
  assert.match(mainSource, /if \(startupRecoveryActive \|\| BrowserWindow\.getAllWindows\(\)\.length > 0\) return/);
  assert.match(mainSource, /validateRecoveryProfileFolder\(/);
  assert.match(mainSource, /async function createWindow\(\): Promise<void>/);
  assert.match(mainSource, /const initialRendererLoad = loadRendererApp\(win\)/);
  assert.match(mainSource, /await initialRendererLoad/);
  assert.match(mainSource, /await createWindow\(\)/);
  const recoveryRootSource = mainSource.slice(
    mainSource.indexOf('function recoveryProfileRoot()'),
    mainSource.indexOf('function recoveryFolderToOpen()'),
  );
  assert.match(recoveryRootSource, /catch \{[\s\S]*return userDataRoot;/);
  const consumerStartupSource = mainSource.slice(
    mainSource.indexOf('.then(() => runStartupRecoveryLoop'),
    mainSource.indexOf('}, handleConsumerStartupFailure))'),
  );
  assert.ok(
    consumerStartupSource.indexOf('await startBroker(')
      < consumerStartupSource.lastIndexOf('startUpdaterSafely('),
    'the updater must start only after the broker and other failure-prone startup work',
  );
  assert.match(consumerStartupSource, /startupRecoveryActive = false;/);
  assert.doesNotMatch(mainSource, /rmSync\(|removeAppProfile|deleteAppProfile/);

  const appStatePrivacySource = readFileSync(
    join(process.cwd(), 'src/main/appStatePrivacy.ts'),
    'utf8',
  );
  assert.match(appStatePrivacySource, /const before = lstatIfPresent\(path\)/);
  assert.match(appStatePrivacySource, /before\.isSymbolicLink\(\)/);
  assert.match(appStatePrivacySource, /secureWindowsPrivatePath\(path, 'directory'\)/);
  assert.match(appStatePrivacySource, /secureWindowsPrivatePath\(path, 'file'\)/);
  assert.match(appStatePrivacySource, /constants\.O_NOFOLLOW/);
  assert.match(appStatePrivacySource, /assertVerifiedFileDescriptor\(/);
  assert.match(appStatePrivacySource, /constants\.O_EXCL/);
  assert.match(appStatePrivacySource, /isTrustedPrivatePathOwner\(entry\.uid\)/);
  assert.match(
    appStatePrivacySource,
    /writableByAnotherPrincipal[\s\S]*isTrustedPrivatePathOwner\(child\.uid, uid\)/,
    'sticky app-state parents must authenticate the traversed child owner',
  );
  assert.doesNotMatch(
    appStatePrivacySource,
    /openVerifiedPrivateAppFile\([\s\S]{0,180}constants\.O_TRUNC/,
    'a path must be identity-verified before any truncation',
  );
  assert.match(
    appStatePrivacySource,
    /openVerifiedPrivateAppFile\([\s\S]{0,220}ftruncateSync\(fd, 0\)/,
  );
  assert.doesNotMatch(
    appStatePrivacySource,
    /existsSync/,
    'app-state security decisions must use lstat so dangling symlinks are visible',
  );

  const systemSource = readFileSync(join(process.cwd(), 'src/main/system.ts'), 'utf8');
  assert.doesNotMatch(
    systemSource,
    /existsSync\(logPath\)/,
    'local-stack logs must not mistake dangling symlinks for missing files',
  );
  assert.match(systemSource, /appendPrivateAppTextFile\(\s*logPath,/);
  assert.match(systemSource, /const logFd = openPrivateAppAppendFile\(logPath\)/);
  assert.match(systemSource, /stdio: \['ignore', logFd, logFd\]/);
  const exitCallbackSource = systemSource.slice(
    systemSource.indexOf("child.on('exit'"),
    systemSource.indexOf('child.unref()'),
  );
  assert.match(
    exitCallbackSource,
    /appendPrivateAppTextFile\(/,
    'the background exit callback must revalidate before its later append',
  );

  const appProfileSource = readFileSync(
    join(process.cwd(), 'src/main/appProfile.ts'),
    'utf8',
  );
  assert.match(
    appProfileSource,
    /readAppProfilePreferenceForSelection\(userDataRoot, environment\)/,
    'environment recovery overrides must bypass a corrupt saved pointer',
  );
  assert.match(
    appProfileSource,
    /validateExplicitProfileDataDir\(requestedDataDir, userDataRoot,/,
    'every explicit startup data directory must pass the central validator',
  );
  assert.match(appProfileSource, /allowMissing: Boolean\(environment\.dataDir\)/);
  assert.match(appProfileSource, /protectedTrees: \[/);
  assert.ok(
    appProfileSource.indexOf('validateExplicitProfileDataDir(')
      < appProfileSource.indexOf('migrateAppProfile(paths,'),
    'explicit profile validation must precede migration and Windows ACL mutation',
  );

  const updaterSource = readFileSync(join(process.cwd(), 'src/main/updater.ts'), 'utf8');
  assert.match(updaterSource, /initialCheckTimer/);
  assert.match(updaterSource, /clearTimeout\(initialCheckTimer\)/);
  assert.match(updaterSource, /removeListener\('focus', focusHandler\)/);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('startup recovery smoke: ok\n');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
