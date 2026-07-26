import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAppProfileName,
  selectAppProfile,
} from '../src/main/appProfileSelection.ts';
import {
  migrateAppProfile,
  PROFILE_SCHEMA_VERSION,
  type ProfileMigrationPaths,
} from '../src/main/profileMigrations.ts';

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

const temp = mkdtempSync(join(tmpdir(), 'idacc-profile-migrations-'));
try {
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
  assert.equal(statSync(join(profile.root, 'config', 'goals')).mode & 0o777, 0o700);
  assert.equal(statSync(join(profile.root, 'config', 'goals', 'goal.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(profile.root, 'config', 'goals', 'nested', 'helper.sh')).mode & 0o777, 0o700);
  assert.equal(existsSync(join(profile.root, 'config', 'safe-roles-state.json')), false);
  assert.equal(existsSync(join(legacy, 'safe-roles-state.json')), true);
  assert.equal(readFileSync(join(profile.cache, 'context-budget', 'cb_old.json'), 'utf8'), '{"id":"cb_old"}\n');
  assert.equal(readFileSync(join(legacy, 'context-budget', 'cb_old.json'), 'utf8'), '{"id":"cb_old"}\n');
  assert.equal(readFileSync(join(profile.root, 'computeruse', 'agent-tokens.json'), 'utf8'), '{"token":"agent"}\n');
  assert.equal(readFileSync(join(legacy, 'computeruse', 'agent-tokens.json'), 'utf8'), '{"token":"agent"}\n');
  assert.equal(statSync(join(profile.root, 'computeruse', 'agent-tokens.json')).mode & 0o777, 0o600);
  assert.equal(statSync(profile.config).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(profile.root, 'config', 'agent-signers.json'), 'utf8'), readFileSync(legacyDesktopSigner, 'utf8'));
  assert.equal(statSync(join(profile.root, 'config', 'agent-signers.json')).mode & 0o777, 0o600);

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
  }

  process.stdout.write('profile migrations smoke: ok\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
