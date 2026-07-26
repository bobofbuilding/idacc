import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const updater = readFileSync(join(root, 'src', 'main', 'updater.ts'), 'utf8');
const settings = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'schema.ts'), 'utf8');
const settingsView = readFileSync(join(root, 'src', 'renderer', 'views', 'Settings.tsx'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

assert.match(updater, /from 'electron-updater'/);
assert.match(updater, /autoUpdater\.allowDowngrade = false/);
assert.match(updater, /autoUpdater\.quitAndInstall/);
assert.match(updater, /parseUpdateRepository\(DEFAULT_UPDATE_REPO\)/);
assert.doesNotMatch(updater, /parseUpdateRepository\(current\.updateRepo\)/);
assert.doesNotMatch(updater, /xattr|com\.apple\.quarantine|rm -rf|apply-update\.sh|arm64\.zip/);
assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
assert.match(settings, /autoUpgrade: false/);
assert.match(settings, /updateRepo: DEFAULT_UPDATE_REPO/);
assert.match(settings, /updateManifestUrl: undefined/);
assert.match(settingsView, /async function applyVerifiedUpdate\(\)/);
assert.match(settingsView, /await call<SettingsUpdateStatus>\('update:status'\)/);
assert.match(settingsView, /freshStatus\.latest !== stagedVersion/);
assert.match(settingsView, /window\.confirm\(/);
assert.match(settingsView, /await call<\{ applying\?: boolean \}>\('update:applyNow'\)/);
assert.match(settingsView, /Restart & update/);

process.stdout.write('unified updater integrity smoke: ok\n');
