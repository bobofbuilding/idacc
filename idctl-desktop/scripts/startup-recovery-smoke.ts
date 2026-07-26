import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  freshRecoveryProfileName,
  runStartupRecoveryLoop,
  startupFailureReport,
} from '../src/main/startupRecovery.ts';

async function main(): Promise<void> {
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
    assert.equal(lstatSync(join(scratch, 'active-profile.json')).mode & 0o777, 0o600);
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
