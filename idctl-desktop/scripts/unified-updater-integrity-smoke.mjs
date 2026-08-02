import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const updater = readFileSync(join(root, 'src', 'main', 'updater.ts'), 'utf8');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
const settings = readFileSync(join(root, '..', 'idctl', 'src', 'settings', 'schema.ts'), 'utf8');
const settingsView = readFileSync(join(root, 'src', 'renderer', 'views', 'Settings.tsx'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

assert.match(updater, /from 'electron-updater'/);
assert.match(updater, /autoUpdater\.allowDowngrade = false/);
assert.match(updater, /autoUpdater\.allowPrerelease = REVIEW_BUILD/);
assert.match(updater, /autoUpdater\.channel = REVIEW_BUILD \? 'review' : 'latest'/);
assert.match(updater, /autoUpdater\.quitAndInstall/);
assert.match(updater, /activeUpdateDownload/);
assert.match(updater, /export function beginUpdateCheck\(\)/);
assert.match(updater, /export function downloadUpdate\(\)/);
assert.match(updater, /export function beginUpdateDownload\(\)/);
assert.match(updater, /await Promise\.allSettled\(pending\)/);
assert.match(updater, /parseUpdateRepository\(DEFAULT_UPDATE_REPO\)/);
assert.match(updater, /probeLatestStableVersion/);
assert.match(updater, /method: 'HEAD'/);
assert.match(updater, /redirect: 'manual'/);
assert.doesNotMatch(updater, /parseUpdateRepository\(current\.updateRepo\)/);
assert.doesNotMatch(updater, /xattr|com\.apple\.quarantine|rm -rf|apply-update\.sh|arm64\.zip/);
assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
assert.match(settings, /autoUpgrade: false/);
assert.match(settings, /updateRepo: DEFAULT_UPDATE_REPO/);
assert.match(settings, /updateManifestUrl: undefined/);
assert.match(main, /case 'update:download':/);
assert.match(main, /case 'update:check':\s*return beginUpdateCheck\(\)/);
assert.doesNotMatch(main, /case 'update:check':\s*return checkForUpdate\(\)/);
assert.match(main, /return beginUpdateDownload\(\)/);
assert.doesNotMatch(main, /case 'update:download':\s*return downloadUpdate\(\)/);
assert.match(
  main,
  /await checkForUpdate\(\);\s*[\s\S]*?await drainUpdater\(\);\s*[\s\S]*?const st = getStatus\(\);/,
  'the update self-test must observe the terminal staged state after detached downloads drain',
);
assert.equal(pkg.scripts['test:unified-updater-download'], 'node scripts/unified-updater-download-smoke.mjs');
assert.match(settingsView, /async function applyVerifiedUpdate\(\)/);
assert.match(settingsView, /async function downloadVerifiedUpdate\(\)/);
assert.match(settingsView, /call<SettingsUpdateStatus>\('update:download'\)/);
assert.match(
  settingsView,
  /if \(next === null \|\| !\('checking' in next\) \|\| !next\.checking\) setUpdStatus\(next\)/,
  'a stale check acknowledgement must not overwrite a newer pushed terminal status',
);
assert.match(
  settingsView,
  /if \(!next\.downloading\) setUpdStatus\(next\)/,
  'a stale download acknowledgement must not overwrite newer progress or completion',
);
assert.match(
  settingsView,
  /if \(next && !next\.checking\) setUpdStatus\(next\)/,
  'a stale Settings-mount check acknowledgement must not overwrite its pushed completion',
);
assert.match(settingsView, /Download update/);
assert.match(settingsView, /await call<SettingsUpdateStatus>\('update:status'\)/);
assert.match(settingsView, /freshStatus\.latest !== stagedVersion/);
assert.match(settingsView, /window\.confirm\(/);
assert.match(settingsView, /await call<\{ applying\?: boolean \}>\('update:applyNow'\)/);
assert.match(settingsView, /Restart & update/);
assert.match(settingsView, /ahead of \$\{status\.channel \?\? 'production'\} channel/);
assert.match(settingsView, /Automatic checks remain active and will resume downloads/);
assert.match(settingsView, /const SETTINGS_STACK_REFRESH_MS = 5_000/);
assert.match(
  settingsView,
  /setInterval\(\(\) => void refreshStack\(\), SETTINGS_STACK_REFRESH_MS\)/,
  'Settings must replace transient startup health errors without requiring an updater-button click',
);

process.stdout.write('unified updater integrity smoke: ok\n');
