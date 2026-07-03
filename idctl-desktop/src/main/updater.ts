/**
 * Self-update for the desktop app — "notify while running, upgrade when requested".
 *
 * Flow:
 *   1. On launch + every checkIntervalHours, fetch an update manifest
 *      ({ version, zipUrl, notes }) from updateManifestUrl, or the latest
 *      GitHub release from updateRepo.
 *   2. If the manifest version > the running version, download/stage the zip
 *      into userData/staged-update/ and notify the renderer (banner).
 *   3. When the user clicks "Restart & update", a detached helper waits for
 *      this process to exit, swaps the new .app over the installed bundle, and
 *      relaunches it. Background checks never restart the app by themselves.
 *
 * Bundle replacement can't happen in-process (the running .app is locked), so
 * the swap runs in a small shell helper spawned detached right before quit.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings } from '../../../idctl/src/settings/store.ts';
import type { UpdateSettings } from '../../../idctl/src/settings/schema.ts';

export interface UpdateManifest {
  version: string;
  zipUrl: string;
  notes?: string;
}

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;   // a newer version exists upstream
  staged: boolean;      // the newer build is downloaded and ready to apply
  checking: boolean;
  notes?: string;
  error?: string;
  lastChecked?: number;
}

let status: UpdateStatus = { current: app.getVersion(), available: false, staged: false, checking: false };
let timer: ReturnType<typeof setInterval> | null = null;
let mainWindow: BrowserWindow | null = null;
type PruneReport = { removed: number; errors: string[] };

function stagedDir(): string {
  return join(app.getPath('userData'), 'staged-update');
}
function stagedMetaPath(): string {
  return join(stagedDir(), 'staged.json');
}

/** Path to the installed `.app` bundle, derived from the running executable. */
function appBundlePath(): string {
  // process.execPath = <App>.app/Contents/MacOS/<bin>
  return resolve(process.execPath, '..', '..', '..');
}

/** Numeric semver compare: 1 if a>b, -1 if a<b, 0 if equal. Ignores pre-release. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function settings(): UpdateSettings | undefined {
  return loadSettings().update;
}

function emit(): void {
  mainWindow?.webContents.send('update:status', status);
}

let lastNotifiedVersion: string | null = null;
/**
 * Fire a native OS notification the first time a given version is freshly staged,
 * so a background-detected update surfaces system-wide — even when the app is
 * unfocused, minimized, or the user is on a page other than Settings. Once per
 * version per session; clicking it brings the window forward.
 */
function notifyStaged(version: string, notes?: string): void {
  if (lastNotifiedVersion === version) return;
  lastNotifiedVersion = version;
  if (process.env.IDCTL_SHOT) return; // headless screenshot runs
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Update ready',
      body: `v${version} downloaded — restart the app to apply.`,
      subtitle: notes ? notes.split('\n')[0].slice(0, 120) : undefined,
      silent: false,
    });
    n.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    n.show();
  } catch {
    /* notifications are best-effort */
  }
}

async function readManifest(url: string): Promise<UpdateManifest> {
  if (url.startsWith('file://') || url.startsWith('/')) {
    const path = url.replace(/^file:\/\//, '');
    return JSON.parse(readFileSync(path, 'utf8')) as UpdateManifest;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return (await res.json()) as UpdateManifest;
}

/** Fetch the manifest from updateManifestUrl, or the latest GitHub release. */
async function fetchLatest(s: UpdateSettings): Promise<UpdateManifest | null> {
  if (s.updateManifestUrl) return readManifest(s.updateManifestUrl);
  if (s.updateRepo) {
    // PRIMARY: resolve the latest release via the github.com redirect
    // (github.com/<repo>/releases/latest → /releases/tag/<tag>). This avoids the
    // api.github.com 60-requests/hour UNAUTHENTICATED rate limit that surfaces as
    // intermittent "github 403" errors when the app polls often.
    try {
      const r = await fetch(`https://github.com/${s.updateRepo}/releases/latest`, { headers: { 'User-Agent': 'idctl-updater' } });
      const m = r.url.match(/\/releases\/tag\/(v?[^/?#]+)/);
      if (m) {
        const tag = m[1];
        const version = tag.replace(/^v/, '');
        // Asset name convention for this app's releases.
        const zipUrl = `https://github.com/${s.updateRepo}/releases/download/${tag}/ID-Agents-Control-Center-${version}-arm64.zip`;
        return { version, zipUrl };
      }
      // Redirect landed on /releases (no tag) → no published release yet.
      if (/\/releases\/?($|[?#])/.test(r.url)) return null;
    } catch { /* network hiccup on the redirect — fall back to the API below */ }
    // FALLBACK: the rate-limited API. 404 = no releases; 403 = rate-limited right now —
    // both are "nothing to do this cycle", NOT a hard error (so no scary red banner).
    const res = await fetch(`https://api.github.com/repos/${s.updateRepo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'idctl-updater' },
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`github ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
    const asset = (rel.assets ?? []).find((a) => /\.zip$/i.test(a.name));
    if (!rel.tag_name || !asset) return null;
    return { version: rel.tag_name.replace(/^v/, ''), zipUrl: asset.browser_download_url, notes: rel.body };
  }
  return null;
}

/** Copy/download the update zip into the staging dir. */
async function stage(manifest: UpdateManifest): Promise<string> {
  mkdirSync(stagedDir(), { recursive: true });
  const dest = join(stagedDir(), `update-${manifest.version}.zip`);
  if (manifest.zipUrl.startsWith('file://') || manifest.zipUrl.startsWith('/')) {
    copyFileSync(manifest.zipUrl.replace(/^file:\/\//, ''), dest);
  } else {
    const res = await fetch(manifest.zipUrl);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
  }
  writeFileSync(stagedMetaPath(), JSON.stringify({ version: manifest.version, zip: dest, notes: manifest.notes ?? '' }));
  requirePruned(pruneStaged(dest));
  return dest;
}

/** Remove spent download zips from the staging dir, keeping only `keep` when a
 *  pending staged update still exists. Without this, every staged version's
 *  ~100MB zip can pile up forever. */
function pruneStaged(keep?: string): PruneReport {
  const report: PruneReport = { removed: 0, errors: [] };
  const dir = stagedDir();
  if (!existsSync(dir)) return report;
  const keepPath = keep ? resolve(keep) : '';
  try {
    for (const f of readdirSync(dir)) {
      if (!/\.zip$/i.test(f)) continue;
      const full = join(dir, f);
      if (keepPath && resolve(full) === keepPath) continue;
      try {
        rmSync(full, { force: true });
        if (existsSync(full)) report.errors.push(`${f}: still exists after remove`);
        else report.removed += 1;
      } catch (err) {
        report.errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }
  return report;
}

function pruneError(report: PruneReport): string | undefined {
  if (!report.errors.length) return undefined;
  return `staged zip prune failed: ${report.errors.slice(0, 3).join('; ')}`;
}

function markPruneError(report: PruneReport): void {
  const error = pruneError(report);
  if (error) status = { ...status, error };
}

function requirePruned(report: PruneReport): void {
  const error = pruneError(report);
  if (error) throw new Error(error);
}

function readStaged(): { version: string; zip: string; notes: string } | null {
  try {
    if (!existsSync(stagedMetaPath())) return null;
    const m = JSON.parse(readFileSync(stagedMetaPath(), 'utf8'));
    if (m?.zip && existsSync(m.zip) && compareVersions(m.version, status.current) > 0) return m;
  } catch {
    /* ignore */
  }
  return null;
}

/** Keep a valid pending update zip and remove everything else, including stale
 * staged metadata for versions older than or equal to the running app. */
function cleanupStagedState(): { version: string; zip: string; notes: string } | null {
  const staged = readStaged();
  if (staged) {
    markPruneError(pruneStaged(staged.zip));
    return staged;
  }
  try { rmSync(stagedMetaPath(), { force: true }); } catch { /* ignore */ }
  markPruneError(pruneStaged());
  return null;
}

export function getStatus(): UpdateStatus {
  const staged = cleanupStagedState();
  status = {
    ...status,
    current: app.getVersion(),
    staged: !!staged,
    available: status.available || !!staged,
    latest: staged?.version ?? status.latest,
    notes: staged?.notes ?? status.notes,
  };
  return status;
}

/** Check upstream for a newer version; stage it when found. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const s = settings();
  status = { ...status, checking: true, error: undefined };
  emit();
  try {
    const stagedBeforeCheck = cleanupStagedState();
    if (!s || (!s.updateManifestUrl && !s.updateRepo)) {
      status = { ...status, checking: false, available: !!stagedBeforeCheck, staged: !!stagedBeforeCheck, latest: stagedBeforeCheck?.version ?? status.latest, notes: stagedBeforeCheck?.notes ?? status.notes, lastChecked: Date.now() };
      return status;
    }
    const latest = await fetchLatest(s);
    const lastChecked = Date.now();
    if (latest && compareVersions(latest.version, status.current) > 0) {
      if (s.autoUpgrade === false) {
        const staged = cleanupStagedState();
        status = {
          ...status,
          checking: false,
          available: true,
          staged: !!staged,
          latest: latest.version,
          notes: staged?.notes ?? latest.notes,
          lastChecked,
        };
      } else {
        // Newer version — download and stage it so the explicit Restart & update
        // button can apply it. Do not restart from a background check.
        const already = readStaged();
        const freshlyStaged = !already || already.version !== latest.version;
        if (freshlyStaged) await stage(latest);
        status = { ...status, checking: false, available: true, staged: true, latest: latest.version, notes: latest.notes, lastChecked };
        // Ping the OS the first time we download a given version — so it surfaces
        // even when the user isn't on the Settings page. Skip on cold-start of an
        // already-staged build (the sidebar chip handles that quietly).
        if (freshlyStaged) notifyStaged(latest.version, latest.notes);
      }
    } else {
      const staged = cleanupStagedState();
      status = { ...status, checking: false, available: !!staged, staged: !!staged, latest: staged?.version ?? latest?.version, notes: staged?.notes ?? status.notes, lastChecked };
    }
  } catch (err) {
    status = { ...status, checking: false, error: err instanceof Error ? err.message : String(err), lastChecked: Date.now() };
  }
  emit();
  return status;
}

/**
 * Apply the staged update on restart: spawn a detached helper that waits for
 * this process to exit, swaps the new bundle over the installed one, and
 * relaunches it. Then quit. Returns false if nothing is staged.
 */
export function applyStagedAndRelaunch(): boolean {
  const staged = readStaged();
  if (!staged) return false;
  const bundle = appBundlePath();
  const helper = join(stagedDir(), 'apply-update.sh');
  const reopen = process.env.IDCTL_UPDATE_NOOPEN ? 'echo "[apply] reopen skipped"' : '/usr/bin/open "$BUNDLE" || /usr/bin/open -n "$BUNDLE"';
  // No `set -e`: the swap is guarded individually, but the relaunch must ALWAYS
  // run (the previous version could quit, swap, then never reopen). Output goes
  // to staged-update/apply-update.log for diagnosis.
  const script = `#!/bin/bash
LOG="$(dirname "$0")/apply-update.log"
exec >>"$LOG" 2>&1
echo "[apply] $(date) pid=$1 bundle=$2"
APP_PID="$1"; BUNDLE="$2"; ZIP="$3"
# wait for the running app to fully exit (the bundle is locked while running)
for i in $(seq 1 240); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.25; done
sleep 0.5
TMP="$(mktemp -d)"
APPLIED=0
if /usr/bin/ditto -x -k "$ZIP" "$TMP"; then
  NEW="$(/usr/bin/find "$TMP" -maxdepth 2 -name '*.app' | head -1)"
  if [ -n "$NEW" ]; then
    /bin/rm -rf "$BUNDLE"
    /usr/bin/ditto "$NEW" "$BUNDLE" && APPLIED=1 && echo "[apply] bundle swapped"
  else
    echo "[apply] ERROR: no .app inside the update zip"
  fi
else
  echo "[apply] ERROR: failed to extract $ZIP"
fi
/bin/rm -rf "$TMP"
STAGED_DIR="$(dirname "$0")"
ZIP_PRUNE_STATUS=0
# A freshly-downloaded, unsigned .app carries com.apple.quarantine, which makes
# 'open' silently refuse to relaunch it — strip it before reopening.
/usr/bin/xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true
if [ "$APPLIED" = "1" ]; then
  echo "[apply] bundle applied; pruning staged zips"
else
  echo "[apply] bundle was not applied; pruning staged zips because staged metadata was cleared"
fi
for OLDZIP in "$STAGED_DIR"/*.zip; do
  [ -e "$OLDZIP" ] || continue
  /bin/rm -f "$OLDZIP" || ZIP_PRUNE_STATUS=1
done
if [ "$ZIP_PRUNE_STATUS" = "0" ]; then
  echo "[apply] staged zip prune complete"
else
  echo "[apply] ERROR: one or more staged zips could not be pruned"
fi
${reopen}
echo "[apply] relaunch issued"
`;
  writeFileSync(helper, script, { mode: 0o755 });
  const child = spawn('/bin/bash', [helper, String(process.pid), bundle, staged.zip], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Clear staged marker so we don't loop; the zip is consumed by the helper.
  try { rmSync(stagedMetaPath(), { force: true }); } catch { /* ignore */ }
  setTimeout(() => app.quit(), 150);
  return true;
}

/** Start periodic checks and wire the window for push notifications. */
export function startUpdater(win: BrowserWindow): void {
  mainWindow = win;
  // If a newer build was already downloaded in a prior session, surface the
  // "Restart & update" chip immediately on launch — don't wait for (or depend
  // on) the next online re-check, which could fail offline and hide it.
  const staged = cleanupStagedState();
  status = { ...status, current: app.getVersion(), staged: !!staged, available: !!staged, latest: staged?.version ?? status.latest, notes: staged?.notes ?? status.notes };
  // Headless screenshot runs: skip background checks.
  if (process.env.IDCTL_SHOT) return;
  if (staged) emit();
  const hours = settings()?.checkIntervalHours ?? 4;
  // Initial check shortly after launch (let the window settle).
  setTimeout(() => void checkForUpdate(), 2500);
  timer = setInterval(() => void checkForUpdate(), Math.max(1, hours) * 3600_000);
  // Re-check whenever the user focuses the window (debounced) — so a release cut
  // while the app is open surfaces in seconds instead of waiting for the timer.
  win.on('focus', () => {
    if (Date.now() - lastFocusCheck < 60_000) return; // debounce: at most once/min
    lastFocusCheck = Date.now();
    void checkForUpdate();
  });
}
let lastFocusCheck = 0;

export function stopUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
