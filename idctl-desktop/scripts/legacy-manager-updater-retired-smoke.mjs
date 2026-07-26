import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
const settings = readFileSync(join(root, 'src', 'renderer', 'views', 'Settings.tsx'), 'utf8');
const teams = readFileSync(join(root, 'src', 'renderer', 'views', 'Teams.tsx'), 'utf8');
const syncDomains = readFileSync(join(root, 'src', 'shared', 'syncDomains.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const resources = JSON.stringify(pkg.build?.extraResources ?? []);
const terminalApp = readFileSync(join(root, '..', 'idctl', 'src', 'app', 'App.tsx'), 'utf8');
const terminalCli = readFileSync(join(root, '..', 'idctl', 'src', 'cli.tsx'), 'utf8');
const terminalUpgrade = readFileSync(join(root, '..', 'idctl', 'src', 'headless', 'upgrade-cmd.ts'), 'utf8');
const terminalReadme = readFileSync(join(root, '..', 'idctl', 'README.md'), 'utf8');
const terminalLauncher = readFileSync(join(root, '..', 'idctl', 'idctl.command'), 'utf8');
const retiredStandalonePaths = [
  join(root, '..', 'scripts', 'install-id-agents-manager.mjs'),
  join(root, '..', 'scripts', 'install-id-agents-manager-smoke.mjs'),
  join(root, '..', 'idctl', 'build', 'build.mjs'),
  join(root, '..', 'idctl', 'build', 'install.sh'),
  join(root, '..', 'idctl', 'build', 'make-app.sh'),
  join(root, '..', 'idctl', 'build', 'e2e-update-test.sh'),
  join(root, '..', 'idctl', 'src', 'update'),
];

assert.doesNotMatch(main, /from ['"]\.\/managerUpdater/);
assert.doesNotMatch(main, /\b(?:applyManagerUpdate|bootstrapManagerInstall|checkManagerUpdate|getManagerUpdateStatus)\s*\(/);
assert.doesNotMatch(main, /managerUpdate:/);
assert.doesNotMatch(settings, /managerUpdate:|Check manager|Update & sync manager/);
assert.doesNotMatch(teams, /managerUpdate:|Install & connect manager/);
assert.doesNotMatch(syncDomains, /managerUpdate:/);
assert.match(settings, /IDACC, Agent manager, and Brain ship and update together/);
assert.doesNotMatch(resources, /install-idacc-stack|install-id-agents-manager/);
assert.equal(existsSync(join(root, 'src', 'main', 'managerUpdater.ts')), false);
assert.equal(existsSync(join(root, 'scripts', 'manager-updater-smoke.mjs')), false);
assert.equal(pkg.scripts['test:manager-updater'], undefined);
assert.equal(pkg.scripts['test:manager-installer'], undefined);
assert.doesNotMatch(terminalApp, /\buseUpdate\s*\(/);
assert.doesNotMatch(terminalCli, /\bapplyPendingAndReExec\s*\(/);
assert.doesNotMatch(terminalUpgrade, /\b(?:checkForUpdate|downloadAndVerify|stageUpdate)\s*\(/);
assert.match(terminalUpgrade, /Standalone idctl self-update has been retired/);
assert.match(terminalReadme, /separately distributed consumer application/);
assert.match(terminalReadme, /private random\s+loopback port/);
assert.doesNotMatch(terminalReadme, /latest\/download\/install\.sh|idchain-world|skillmesh|Bob brand/i);
assert.match(terminalLauncher, /unified IDACC desktop application \(including Manager and Brain\)/);
assert.doesNotMatch(terminalLauncher, /latest\/download\/install\.sh/);
for (const path of retiredStandalonePaths) {
  assert.equal(existsSync(path), false, `retired standalone distribution path still exists: ${path}`);
}
for (const script of ['build:bin', 'build:app', 'build:sums']) {
  assert.equal(JSON.parse(readFileSync(join(root, '..', 'idctl', 'package.json'), 'utf8')).scripts[script], undefined);
}

process.stdout.write('legacy manager updater retired smoke: ok\n');
