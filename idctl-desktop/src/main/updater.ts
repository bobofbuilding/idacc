/**
 * Unified application updater.
 *
 * Manager and Brain are immutable resources inside the IDACC application, so
 * there is exactly one update authority. electron-updater verifies the
 * electron-builder SHA-512 metadata and, on macOS, the replacement application
 * signature before installing. No custom shell, quarantine removal, inferred
 * asset name, or delete-before-copy path remains.
 */
import { app, BrowserWindow, Notification } from 'electron';
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings } from '../../../idctl/src/settings/store.ts';
import { DEFAULT_UPDATE_REPO, type UpdateSettings } from '../../../idctl/src/settings/schema.ts';
import { evaluateUpdateTarget, type UpdateTargetReadiness } from '../shared/updateTarget.ts';

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  staged: boolean;
  checking: boolean;
  downloading?: boolean;
  downloadPercent?: number;
  notes?: string;
  error?: string;
  lastChecked?: number;
  verification: 'electron-builder-sha512-and-platform-signature-where-supported';
}

let status: UpdateStatus = {
  current: app.getVersion(),
  available: false,
  staged: false,
  checking: false,
  verification: 'electron-builder-sha512-and-platform-signature-where-supported',
};
let timer: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
let mainWindow: BrowserWindow | null = null;
let focusWindow: BrowserWindow | null = null;
let focusHandler: (() => void) | null = null;
let eventsBound = false;
let lastFocusCheck = 0;
let lastNotifiedVersion: string | null = null;
let stagedInstallPrepared = false;
let activeUpdateCheck: Promise<UpdateStatus> | null = null;
let activeUpdateDownload: Promise<UpdateStatus> | null = null;

/** Numeric semver compare: prerelease labels are treated as lower than release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { numbers: number[]; prerelease: string } => {
    const clean = value.trim().replace(/^v/, '');
    const [core, prerelease = ''] = clean.split('-', 2);
    return {
      numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      prerelease,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const delta = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

/**
 * Update artifacts must be stable, valid three-part semantic versions newer
 * than the running application. electron-updater also rejects prereleases,
 * but this check keeps the manual-download path fail-closed if a provider ever
 * returns unexpected metadata.
 */
export function isAllowedUpdateVersion(candidate: string, current: string): boolean {
  if (!/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(candidate.trim())) return false;
  return compareVersions(candidate, current) > 0;
}

export function parseUpdateRepository(value: string | undefined): { owner: string; repo: string } {
  const clean = String(value || '').trim();
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(clean);
  if (!match || match[2].startsWith('.') || match[2].endsWith('.')) {
    throw new Error('Update repository must be an exact GitHub owner/name pair.');
  }
  return { owner: match[1], repo: match[2] };
}

function settings(): UpdateSettings {
  return loadSettings().update ?? {
    autoUpgrade: false,
    updateRepo: undefined,
    checkIntervalHours: 4,
  };
}

function updateTargetReadiness(): UpdateTargetReadiness {
  const bundle = process.platform === 'darwin'
    ? resolve(process.execPath, '..', '..', '..')
    : app.getAppPath();
  return evaluateUpdateTarget({
    isPackaged: app.isPackaged,
    platform: process.platform,
    bundlePath: bundle,
    appImagePath: process.platform === 'linux' ? process.env.APPIMAGE : undefined,
    appAsarExists: existsSync(
      process.platform === 'darwin'
        ? resolve(bundle, 'Contents', 'Resources', 'app.asar')
        : app.getAppPath(),
    ),
  });
}

function updateUnavailable(readiness: UpdateTargetReadiness): UpdateStatus {
  status = {
    ...status,
    current: app.getVersion(),
    available: false,
    staged: false,
    checking: false,
    downloading: false,
    error: readiness.reason ? `Self-update unavailable: ${readiness.reason}.` : 'Self-update unavailable.',
  };
  return status;
}

function notes(info: UpdateInfo): string | undefined {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes;
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes
      .map((entry) => typeof entry === 'string' ? entry : entry.note)
      .filter(Boolean)
      .join('\n\n') || undefined;
  }
  return undefined;
}

function emit(): void {
  mainWindow?.webContents.send('update:status', { ...status });
}

function notifyStaged(version: string, detail?: string): void {
  if (lastNotifiedVersion === version || process.env.IDCTL_SHOT) return;
  lastNotifiedVersion = version;
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: 'Verified IDACC update ready',
      body: `v${version} is verified and ready. Restart IDACC to install it.`,
      subtitle: detail?.split('\n')[0].slice(0, 120),
    });
    notification.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
  } catch {
    // Native notifications are best-effort.
  }
}

function bindUpdaterEvents(): void {
  if (eventsBound) return;
  eventsBound = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => {
    status = { ...status, checking: true, error: undefined };
    emit();
  });
  autoUpdater.on('update-available', (info) => {
    const available = isAllowedUpdateVersion(info.version, app.getVersion());
    status = {
      ...status,
      checking: false,
      latest: info.version,
      available,
      staged: false,
      downloading: false,
      downloadPercent: undefined,
      notes: notes(info),
      lastChecked: Date.now(),
      error: undefined,
    };
    emit();
  });
  autoUpdater.on('update-not-available', (info) => {
    status = {
      ...status,
      checking: false,
      latest: info.version,
      available: false,
      staged: false,
      downloading: false,
      downloadPercent: undefined,
      lastChecked: Date.now(),
      error: undefined,
    };
    emit();
  });
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const percent = Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : (status.downloadPercent ?? 0);
    status = {
      ...status,
      checking: false,
      downloading: true,
      downloadPercent: percent,
      error: undefined,
    };
    emit();
  });
  autoUpdater.on('update-downloaded', (info) => {
    const matchesCheckedRelease = Boolean(
      status.available
      && status.latest === info.version
      && isAllowedUpdateVersion(info.version, app.getVersion()),
    );
    if (!matchesCheckedRelease) {
      status = {
        ...status,
        checking: false,
        downloading: false,
        downloadPercent: undefined,
        staged: false,
        error: 'The downloaded update did not match the stable release that was checked.',
        lastChecked: Date.now(),
      };
      emit();
      return;
    }
    status = {
      ...status,
      checking: false,
      downloading: false,
      downloadPercent: 100,
      latest: info.version,
      available: true,
      staged: true,
      notes: notes(info),
      lastChecked: Date.now(),
      error: undefined,
    };
    notifyStaged(info.version, notes(info));
    emit();
  });
  autoUpdater.on('error', (error) => {
    status = {
      ...status,
      checking: false,
      downloading: false,
      error: error.message || String(error),
      lastChecked: Date.now(),
    };
    emit();
  });
}

function configureUpdater(): UpdateSettings {
  const current = settings();
  // Do not let profile data redirect executable update authority. The release
  // repository is compiled into the app and settings normalization discards
  // legacy/custom feeds.
  const repository = parseUpdateRepository(DEFAULT_UPDATE_REPO);
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: repository.owner,
    repo: repository.repo,
    private: false,
  });
  return current;
}

export function getStatus(): UpdateStatus {
  const readiness = updateTargetReadiness();
  if (!readiness.ok) return updateUnavailable(readiness);
  return { ...status, current: app.getVersion() };
}

/** Check signed release metadata and optionally download its exact platform asset. */
async function checkForUpdateInternal(): Promise<UpdateStatus> {
  const readiness = updateTargetReadiness();
  if (!readiness.ok) {
    updateUnavailable(readiness);
    emit();
    return { ...status };
  }
  // Once a verified artifact is staged, keep its displayed version and install
  // approval bound together until restart instead of replacing the metadata
  // underneath it with a later check.
  if (status.staged || status.checking || status.downloading) return { ...status };
  bindUpdaterEvents();
  status = { ...status, checking: true, error: undefined };
  emit();
  try {
    const current = configureUpdater();
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const available = Boolean(info && isAllowedUpdateVersion(info.version, app.getVersion()));
    status = {
      ...status,
      checking: false,
      latest: info?.version,
      available,
      staged: false,
      downloading: false,
      downloadPercent: undefined,
      notes: info ? notes(info) : status.notes,
      lastChecked: Date.now(),
      error: undefined,
    };
    emit();
    if (available && current.autoUpgrade && !status.staged) {
      observeDetachedUpdateOperation(startUpdateDownload(true));
    }
  } catch (error) {
    status = {
      ...status,
      checking: false,
      downloading: false,
      error: error instanceof Error ? error.message : String(error),
      lastChecked: Date.now(),
    };
    emit();
  }
  return { ...status };
}

export function checkForUpdate(): Promise<UpdateStatus> {
  if (activeUpdateCheck) return activeUpdateCheck;
  const check = checkForUpdateInternal();
  activeUpdateCheck = check;
  void check.then(
    () => { if (activeUpdateCheck === check) activeUpdateCheck = null; },
    () => { if (activeUpdateCheck === check) activeUpdateCheck = null; },
  );
  return check;
}

function observeDetachedUpdateOperation(operation: Promise<UpdateStatus>): void {
  void operation.catch((error) => {
    status = {
      ...status,
      checking: false,
      downloading: false,
      error: error instanceof Error ? error.message : String(error),
    };
    emit();
  });
}

/**
 * Start the network metadata check without retaining the renderer IPC request.
 * The updater status event carries completion and any automatic-download
 * continuation; shutdown continues to own both operations through
 * `drainUpdater()`.
 */
export function beginUpdateCheck(): UpdateStatus {
  observeDetachedUpdateOperation(checkForUpdate());
  return getStatus();
}

async function downloadUpdateInternal(allowActiveCheck: boolean): Promise<UpdateStatus> {
  const readiness = updateTargetReadiness();
  if (!readiness.ok) {
    updateUnavailable(readiness);
    emit();
    return { ...status };
  }
  bindUpdaterEvents();
  if (!allowActiveCheck && (activeUpdateCheck || status.checking)) {
    return {
      ...status,
      error: 'An update check is still in progress. Wait for it to finish before downloading.',
    };
  }
  if (status.staged) return { ...status };

  try {
    // Reapply the compiled feed immediately before every download. Profile
    // settings can enable automatic download, but cannot redirect executable
    // update authority.
    configureUpdater();
    if (
      !status.available
      || !status.latest
      || !isAllowedUpdateVersion(status.latest, app.getVersion())
    ) {
      status = {
        ...status,
        checking: false,
        downloading: false,
        downloadPercent: undefined,
        staged: false,
        error: 'No newer stable IDACC update is available to download.',
      };
      emit();
      return { ...status };
    }

    status = {
      ...status,
      checking: false,
      downloading: true,
      downloadPercent: 0,
      staged: false,
      error: undefined,
    };
    emit();
    await autoUpdater.downloadUpdate();
    if (!status.staged && !status.error) {
      status = {
        ...status,
        downloading: false,
        downloadPercent: undefined,
        error: 'The update download finished without verified staging confirmation.',
      };
      emit();
    }
  } catch (error) {
    status = {
      ...status,
      checking: false,
      downloading: false,
      downloadPercent: undefined,
      staged: false,
      error: error instanceof Error ? error.message : String(error),
    };
    emit();
  }
  return { ...status };
}

function startUpdateDownload(allowActiveCheck: boolean): Promise<UpdateStatus> {
  if (activeUpdateDownload) return activeUpdateDownload;
  const download = downloadUpdateInternal(allowActiveCheck);
  activeUpdateDownload = download;
  void download.then(
    () => { if (activeUpdateDownload === download) activeUpdateDownload = null; },
    () => { if (activeUpdateDownload === download) activeUpdateDownload = null; },
  );
  return download;
}

/** Download and verify the stable release discovered by the latest check. */
export function downloadUpdate(): Promise<UpdateStatus> {
  return startUpdateDownload(false);
}

/**
 * Start a manual download without keeping the renderer IPC request open for
 * the artifact transfer. Progress and completion travel over `update:status`,
 * while `drainUpdater()` retains ownership of the exact background promise.
 */
export function beginUpdateDownload(): UpdateStatus {
  if (activeUpdateCheck || status.checking) {
    return {
      ...status,
      current: app.getVersion(),
      error: 'An update check is still in progress. Wait for it to finish before downloading.',
    };
  }
  const download = downloadUpdate();
  observeDetachedUpdateOperation(download);
  return getStatus();
}

export async function drainUpdater(): Promise<void> {
  // A metadata check can start an automatic download before it settles. Loop
  // until both single-flight operations are gone so terminal shutdown never
  // abandons an updater write in progress.
  while (activeUpdateCheck || activeUpdateDownload) {
    const pending = [...new Set(
      [activeUpdateCheck, activeUpdateDownload].filter(
        (operation): operation is Promise<UpdateStatus> => operation !== null,
      ),
    )];
    await Promise.allSettled(pending);
  }
}

/**
 * Install only an update that electron-updater has fully downloaded and
 * verified. The updater owns the platform-specific atomic replacement and
 * rollback behavior.
 */
export function prepareStagedUpdateInstall(): boolean {
  const readiness = updateTargetReadiness();
  if (!readiness.ok) {
    updateUnavailable(readiness);
    emit();
    return false;
  }
  if (!status.staged) return false;
  stagedInstallPrepared = true;
  return true;
}

/**
 * Hand the already-verified update to electron-updater. The application
 * shutdown coordinator is the only caller and invokes this after local
 * services and background work have stopped.
 */
export function installPreparedUpdateAndQuit(): void {
  if (!stagedInstallPrepared || !status.staged) {
    throw new Error('No verified update is prepared for installation.');
  }
  stagedInstallPrepared = false;
  autoUpdater.quitAndInstall(false, true);
}

export function startUpdater(win: BrowserWindow): void {
  stopUpdater();
  mainWindow = win;
  const readiness = updateTargetReadiness();
  if (!readiness.ok) {
    updateUnavailable(readiness);
    return;
  }
  bindUpdaterEvents();
  if (process.env.IDCTL_SHOT || /^(1|true|yes|on)$/i.test(String(process.env.DISABLE_AUTO_UPDATE || ''))) return;
  const hours = settings().checkIntervalHours || 4;
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null;
    void checkForUpdate();
  }, 2_500);
  initialCheckTimer.unref?.();
  timer = setInterval(() => void checkForUpdate(), Math.max(1, hours) * 3_600_000);
  timer.unref?.();
  focusWindow = win;
  focusHandler = () => {
    if (Date.now() - lastFocusCheck < 60_000) return;
    lastFocusCheck = Date.now();
    void checkForUpdate();
  };
  win.on('focus', focusHandler);
}

export function stopUpdater(): void {
  if (initialCheckTimer) clearTimeout(initialCheckTimer);
  initialCheckTimer = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (focusWindow && focusHandler) {
    focusWindow.removeListener('focus', focusHandler);
  }
  focusWindow = null;
  focusHandler = null;
  mainWindow = null;
}
