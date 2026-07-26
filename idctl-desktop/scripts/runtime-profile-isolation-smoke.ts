import assert from 'node:assert/strict';
import {
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
import { prepareManagerRuntimeProfile } from '../src/main/runtimeProfile.ts';

const scratch = mkdtempSync(join(tmpdir(), 'idacc-runtime-profile-'));
try {
  const runtime = join(scratch, 'runtime', 'manager');
  const profileRoot = join(scratch, 'profile');
  for (const directory of [
    join(runtime, 'configs', 'agents'),
    join(runtime, 'skills', 'starter'),
    join(runtime, 'plugins', 'claude-code', 'starter'),
  ]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(runtime, 'configs', 'agents', 'seed.md'), 'seed-agent\n');
  writeFileSync(join(runtime, 'skills', 'starter', 'SKILL.md'), 'seed-skill\n');
  writeFileSync(join(runtime, 'plugins', 'claude-code', 'starter', 'plugin.json'), '{}\n');

  const paths = {
    root: profileRoot,
    config: join(profileRoot, 'config', 'config.json'),
    brain: join(profileRoot, 'brain'),
    manager: join(profileRoot, 'manager'),
    workspace: join(profileRoot, 'workspace'),
    logs: join(profileRoot, 'logs'),
    cache: join(profileRoot, 'cache'),
  };
  const prepared = prepareManagerRuntimeProfile(runtime, paths);
  const installedSeed = join(prepared.libraryRoot, 'agents', 'seed.md');
  const installedSkill = join(paths.manager, 'library', 'skills', 'starter', 'SKILL.md');
  const statePath = join(paths.manager, '.idacc-seed-state.json');
  assert.equal(readFileSync(installedSeed, 'utf8'), 'seed-agent\n');
  assert.equal(readFileSync(join(paths.manager, 'library', 'skills', 'starter', 'SKILL.md'), 'utf8'), 'seed-skill\n');
  assert.equal(readFileSync(join(prepared.pluginsRoot, 'starter', 'plugin.json'), 'utf8'), '{}\n');
  assert.equal(prepared.agentLogDir, join(paths.logs, 'agents'));
  assert.equal(statSync(prepared.agentLogDir).isDirectory(), true);
  assert.equal(statSync(prepared.agentLogDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(paths.manager, 'library')).mode & 0o777, 0o700);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);

  // Unmodified managed seeds advance with a new application release.
  writeFileSync(join(runtime, 'configs', 'agents', 'seed.md'), 'seed-agent-v2\n');
  prepareManagerRuntimeProfile(runtime, paths);
  assert.equal(readFileSync(installedSeed, 'utf8'), 'seed-agent-v2\n');

  // User edits are preserved across later bundled revisions.
  writeFileSync(installedSeed, 'user-customized\n');
  writeFileSync(join(runtime, 'configs', 'agents', 'seed.md'), 'seed-agent-v3\n');
  writeFileSync(join(runtime, 'configs', 'agents', 'new.md'), 'new-release-seed\n');
  prepareManagerRuntimeProfile(runtime, paths);
  assert.equal(readFileSync(installedSeed, 'utf8'), 'user-customized\n');
  assert.equal(readFileSync(join(prepared.libraryRoot, 'agents', 'new.md'), 'utf8'), 'new-release-seed\n');

  // Deleting a previously installed seed is an explicit profile choice, not a
  // request to resurrect it on every launch.
  rmSync(installedSkill);
  writeFileSync(join(runtime, 'skills', 'starter', 'SKILL.md'), 'seed-skill-v2\n');
  prepareManagerRuntimeProfile(runtime, paths);
  assert.equal(existsSync(installedSkill), false);

  // A corrupt ledger fails safely: existing files become user-owned while
  // brand-new release files still appear.
  writeFileSync(statePath, '{not json\n');
  writeFileSync(join(runtime, 'configs', 'agents', 'seed.md'), 'seed-agent-v4\n');
  writeFileSync(join(runtime, 'configs', 'agents', 'after-corruption.md'), 'new-after-corruption\n');
  prepareManagerRuntimeProfile(runtime, paths);
  assert.equal(readFileSync(installedSeed, 'utf8'), 'user-customized\n');
  assert.equal(
    readFileSync(join(prepared.libraryRoot, 'agents', 'after-corruption.md'), 'utf8'),
    'new-after-corruption\n',
  );
  assert.equal(readFileSync(join(runtime, 'configs', 'agents', 'seed.md'), 'utf8'), 'seed-agent-v4\n');

  if (process.platform !== 'win32') {
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    mkdirSync(join(runtime, 'configs', 'linked'));
    writeFileSync(join(runtime, 'configs', 'linked', 'seed.md'), 'must-not-escape\n');
    symlinkSync(outside, join(prepared.libraryRoot, 'linked'));
    assert.throws(
      () => prepareManagerRuntimeProfile(runtime, paths),
      /symbolic link in the writable runtime profile/,
    );
    assert.equal(existsSync(join(outside, 'seed.md')), false);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('runtime profile isolation smoke: ok');
