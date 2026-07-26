#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableArchiveEntry } from './lib/consumer-payload-policy.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts', 'check-release-payload.mjs');
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const { createPackage } = requireFromDesktop('@electron/asar');

function write(path, body = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function run(path) {
  return spawnSync(process.execPath, [guard, path], {
    cwd: root,
    encoding: 'utf8',
  });
}

function writeRuntime(runtimeRoot) {
  const managerEntrypoint = 'dist/agent-manager-db.js';
  const brainEntrypoint = 'brain.mjs';
  write(join(runtimeRoot, 'manager', managerEntrypoint), 'export const manager = true;\n');
  write(join(runtimeRoot, 'brain', brainEntrypoint), 'export const brain = true;\n');
  write(
    join(runtimeRoot, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      application: { dirty: false },
      trees: { runtime: 'a'.repeat(64) },
      files: [{ path: `manager/${managerEntrypoint}`, sha256: 'b'.repeat(64), size: 29 }],
      components: {
        manager: {
          commit: 'c'.repeat(40),
          packageLockSha256: 'd'.repeat(64),
          entrypoint: managerEntrypoint,
        },
        brain: {
          commit: 'e'.repeat(40),
          packageLockSha256: 'f'.repeat(64),
          entrypoint: brainEntrypoint,
        },
      },
    }, null, 2)}\n`,
  );
}

const NOTICES_FIXTURE = [
  '# Third-Party Notices',
  '',
  '| Package | Version | License | Used by |',
  '| --- | --- | --- | --- |',
  '| fixture | 1.0.0 | MIT | desktop |',
  '',
  '## Included license and notice texts',
  '',
  '----- BEGIN LICENSE -----',
  'MIT License',
  '----- END LICENSE -----',
  '',
].join('\n');

async function writePackagedApp(parent, name, mainSource) {
  const appRoot = join(parent, name);
  const resources = join(appRoot, 'resources');
  const source = join(parent, `${name}-asar-source`);
  write(join(resources, 'IDACC-LICENSE.txt'), 'MIT License\n');
  write(join(resources, 'THIRD_PARTY_NOTICES.md'), NOTICES_FIXTURE);
  writeRuntime(join(resources, 'idacc-runtime'));
  write(join(source, 'package.json'), '{"name":"idacc","version":"0.0.0","main":"out/main/main.cjs"}\n');
  write(join(source, 'out', 'main', 'main.cjs'), mainSource);
  write(join(source, 'out', 'preload', 'preload.cjs'), 'globalThis.IDACC = true;\n');
  write(join(source, 'out', 'renderer', 'renderer.js'), 'document.title = "IDACC";\n');
  await createPackage(source, join(resources, 'app.asar'));
  return appRoot;
}

const dir = mkdtempSync(join(tmpdir(), 'idacc-release-payload-'));
try {
  assert.equal(
    portableArchiveEntry('\\out\\main\\main.cjs'),
    'out/main/main.cjs',
    'Windows ASAR entry names must be normalized before first-party policy matching',
  );
  const allowed = join(dir, 'allowed');
  write(
    join(allowed, 'manager', 'configs', 'default.yaml'),
    'version: 1\nteam: default\n# A child may inherit PATH/HOME/etc. from its process environment.\n',
  );
  write(
    join(allowed, 'manifest.json'),
    '{"files":[{"path":"manager/dist/lib/skillmesh-provider.js"}]}\n',
  );
  write(join(allowed, 'brain', 'brain.mjs'), 'console.log("framework");\n');
  write(join(allowed, 'brain', 'routes', 'graph-app.mjs'), 'export {};\n');
  assert.equal(run(allowed).status, 0, 'consumer runtime framework files should be allowed');

  const missing = run(join(dir, 'does-not-exist'));
  assert.notEqual(missing.status, 0, 'a nonexistent release payload must fail closed');
  assert.match(`${missing.stdout}\n${missing.stderr}`, /does not exist/i);

  const unknownShape = join(dir, 'unknown-shape');
  write(join(unknownShape, 'README.md'), 'not a packaged application\n');
  const unknownShapeResult = run(unknownShape);
  assert.notEqual(unknownShapeResult.status, 0, 'an arbitrary directory must not count as a release payload');
  assert.match(`${unknownShapeResult.stdout}\n${unknownShapeResult.stderr}`, /unrecognized release payload shape/i);

  const forbidden = join(dir, 'forbidden');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'brain.db'), 'local db');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'output', 'local-report.md'), 'local output');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'uploads', 'material.pdf'), 'upload');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'plans', '01-personal.md'), 'local living plan');
  write(join(forbidden, 'workspace', 'projects', 'brain', 'plans', 'archive', '99-local.md'), 'archived local plan');
  write(join(forbidden, 'workspace', 'projects', 'brain', '.quota-watch-cursor.json'), '{}');
  const failed = run(forbidden);
  assert.notEqual(failed.status, 0, 'Brain local state should fail release payload guard');
  assert.match(`${failed.stdout}\n${failed.stderr}`, /Brain (database|workspace state)/);

  const neutralRuntime = join(dir, 'neutral-runtime');
  write(join(neutralRuntime, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: default\n');
  write(join(neutralRuntime, 'brain', 'config.mjs'), 'export const stateRoot = process.env.IDACC_PROFILE_ROOT;\n');
  assert.equal(run(neutralRuntime).status, 0, 'consumer-neutral first-party runtime content should pass');

  const orgPolicy = join(dir, 'org-policy');
  write(join(orgPolicy, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: skillmesh\n');
  write(join(orgPolicy, 'brain', 'config.mjs'), 'export const enabled = false;\n');
  const orgResult = run(orgPolicy);
  assert.notEqual(orgResult.status, 0, 'organization-specific default configuration should fail');
  assert.match(`${orgResult.stdout}\n${orgResult.stderr}`, /organization-specific/i);

  const personalPath = join(dir, 'personal-path');
  write(join(personalPath, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: default\n');
  write(join(personalPath, 'brain', 'config.mjs'), 'export const source = "/Users/alice/private-project";\n');
  const personalResult = run(personalPath);
  assert.notEqual(personalResult.status, 0, 'personal absolute paths should fail');
  assert.match(`${personalResult.stdout}\n${personalResult.stderr}`, /personal absolute path/i);

  const embeddedSecret = join(dir, 'embedded-secret');
  write(join(embeddedSecret, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: default\n');
  write(
    join(embeddedSecret, 'brain', 'config.mjs'),
    `export const PRIVATE_KEY = "0x${'ab'.repeat(32)}";\n`,
  );
  const secretResult = run(embeddedSecret);
  assert.notEqual(secretResult.status, 0, 'embedded private-key sources should fail');
  assert.match(`${secretResult.stdout}\n${secretResult.stderr}`, /embedded (?:raw )?private key|embedded secret/i);

  const activeOrgDefault = join(dir, 'active-org-default');
  write(join(activeOrgDefault, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: default\n');
  write(
    join(activeOrgDefault, 'brain', 'routes.mjs'),
    'export const provider = "https://skillmesh.bittrees.org";\n',
  );
  const activeOrgResult = run(activeOrgDefault);
  assert.notEqual(activeOrgResult.status, 0, 'hard-coded organization endpoints should fail');
  assert.match(`${activeOrgResult.stdout}\n${activeOrgResult.stderr}`, /hard-coded organization service URL/i);

  const unsafeCoreSkills = join(dir, 'unsafe-core-skills');
  write(join(unsafeCoreSkills, 'manager', 'configs', 'default.yaml'), 'version: 1\nteam: default\n');
  write(join(unsafeCoreSkills, 'brain', 'config.mjs'), 'export const enabled = true;\n');
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'brain', 'SKILL.md'),
    '# Brain\nRun curl against http://127.0.0.1:4200/health.\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'idagents-admin-control', 'SKILL.md'),
    '# Admin\nRun kill -9 before POST /remote from $HOME/id-agents.\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'idagents-admin-control', 'remote-command.sh'),
    '#!/bin/sh\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'task-discipline', 'SKILL.md'),
    '# Tasks\nUse the idchain configuration.\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'xmtp', 'SKILL.md'),
    '# XMTP\nSend to agent-15.xid.eth.\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'wallet', 'SKILL.md'),
    '# Wallet\nRead the vault under ~/.ows before signing.\n',
  );
  write(
    join(unsafeCoreSkills, 'manager', 'skills', 'idagents-team-builder', 'SKILL.md'),
    '# Team builder\nSet dangerouslySkipPermissions: true.\n',
  );
  const unsafeCoreSkillsResult = run(unsafeCoreSkills);
  assert.notEqual(unsafeCoreSkillsResult.status, 0, 'developer-only core skill instructions should fail');
  assert.match(
    `${unsafeCoreSkillsResult.stdout}\n${unsafeCoreSkillsResult.stderr}`,
    /fixed development service address|raw Brain HTTP instruction|developer admin helper executable|organization-specific skill example|non-core privileged consumer skill/i,
  );

  const unsafeDefaultTeam = join(dir, 'unsafe-default-team');
  write(
    join(unsafeDefaultTeam, 'manager', 'configs', 'default.yaml'),
    'version: 1\nteam: default\ndefaults:\n  runtime: codex\n  model: gpt-example\n  skills:\n    - wallet\n',
  );
  write(join(unsafeDefaultTeam, 'brain', 'config.mjs'), 'export const enabled = true;\n');
  const unsafeDefaultTeamResult = run(unsafeDefaultTeam);
  assert.notEqual(unsafeDefaultTeamResult.status, 0, 'provider and privileged fresh-profile defaults should fail');
  assert.match(
    `${unsafeDefaultTeamResult.stdout}\n${unsafeDefaultTeamResult.stderr}`,
    /provider or privileged feature pinned in default team/i,
  );

  const neutralApp = await writePackagedApp(
    dir,
    'neutral-app',
    'const product = { name: "IDACC", localState: false };\n',
  );
  assert.equal(run(neutralApp).status, 0, 'a complete consumer-neutral packaged application should pass');

  const asarSecretApp = await writePackagedApp(
    dir,
    'asar-secret-app',
    `const PRIVATE_KEY = "0x${'ab'.repeat(32)}";\n`,
  );
  const asarSecretResult = run(asarSecretApp);
  assert.notEqual(asarSecretResult.status, 0, 'secret material embedded inside app.asar must fail');
  assert.match(`${asarSecretResult.stdout}\n${asarSecretResult.stderr}`, /Application bundle policy: embedded/i);

  const asarOrgApp = await writePackagedApp(
    dir,
    'asar-org-app',
    'const endpoint = "https://api.skillmesh.example/operator";\n',
  );
  const asarOrgResult = run(asarOrgApp);
  assert.notEqual(asarOrgResult.status, 0, 'organization policy embedded inside app.asar must fail');
  assert.match(`${asarOrgResult.stdout}\n${asarOrgResult.stderr}`, /hard-coded organization service URL/i);

  const asarPersonalPathApp = await writePackagedApp(
    dir,
    'asar-personal-path-app',
    'const sourceRoot = "/Users/alice/private-idacc";\n',
  );
  const asarPersonalPathResult = run(asarPersonalPathApp);
  assert.notEqual(asarPersonalPathResult.status, 0, 'personal paths embedded inside app.asar must fail');
  assert.match(`${asarPersonalPathResult.stdout}\n${asarPersonalPathResult.stderr}`, /personal absolute path/i);

  const asarConstructedPersonalPathApp = await writePackagedApp(
    dir,
    'asar-constructed-personal-path-app',
    'const sourceRoot = join(home, "bob", "Library", "Assistants", "idagents", ".agents", "skills");\n',
  );
  const asarConstructedPersonalPathResult = run(asarConstructedPersonalPathApp);
  assert.notEqual(
    asarConstructedPersonalPathResult.status,
    0,
    'developer checkout paths constructed at runtime inside app.asar must fail',
  );
  assert.match(
    `${asarConstructedPersonalPathResult.stdout}\n${asarConstructedPersonalPathResult.stderr}`,
    /personal absolute path/i,
  );

  const asarGoalApp = await writePackagedApp(
    dir,
    'asar-goal-app',
    'const profile = {"goals":[{"id":"goal_private","objective":"Move my private finances","createdAt":"2026-01-01"}]};\n',
  );
  const asarGoalResult = run(asarGoalApp);
  assert.notEqual(asarGoalResult.status, 0, 'profile-owned goals embedded inside app.asar must fail');
  assert.match(`${asarGoalResult.stdout}\n${asarGoalResult.stderr}`, /embedded profile-owned goal dataset/i);

  const missingAsarApp = join(dir, 'missing-asar-app');
  write(join(missingAsarApp, 'resources', 'IDACC-LICENSE.txt'), 'MIT License\n');
  write(join(missingAsarApp, 'resources', 'THIRD_PARTY_NOTICES.md'), NOTICES_FIXTURE);
  writeRuntime(join(missingAsarApp, 'resources', 'idacc-runtime'));
  const missingAsarResult = run(missingAsarApp);
  assert.notEqual(missingAsarResult.status, 0, 'a packaged app without app.asar must fail');
  assert.match(`${missingAsarResult.stdout}\n${missingAsarResult.stderr}`, /Missing packaged application archive/i);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
