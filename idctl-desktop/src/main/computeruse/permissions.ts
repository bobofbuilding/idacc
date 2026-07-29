/**
 * macOS TCC permission detection + deep-links for Computer Use.
 *
 * - Screen Recording (needed to capture the screen) — detected via
 *   systemPreferences.getMediaAccessStatus('screen'). macOS has no programmatic
 *   "request" for screen capture; the prompt appears the first time we capture,
 *   and the grant only takes effect after the app is relaunched — so we detect +
 *   deep-link + offer a relaunch rather than silently failing.
 * - Accessibility (needed in Phase 1 to inject mouse/keyboard) — detected via
 *   systemPreferences.isTrustedAccessibilityClient(false) (false = don't prompt).
 * - Input Monitoring + Automation are not exposed by Electron, so we use a
 *   best-effort read of the user's TCC database and report "unknown" if macOS
 *   blocks inspection.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, shell, systemPreferences } from 'electron';
import { externalChildEnvironment } from '../externalChildEnvironment.ts';

const execFileP = promisify(execFile);

export type CuPermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface CuAutomationPermission {
  status: CuPermissionState;
  targets: string[];
}

export interface CuPermissions {
  screenRecording: CuPermissionState;
  /** Accessibility is only required for input (Phase 1); reported now so the UI can show both. */
  accessibility: boolean;
  /** Best-effort TCC state for Input Monitoring; "unknown" means macOS blocked inspection. */
  inputMonitoring: CuPermissionState;
  /** Best-effort TCC state for Apple Events / Automation grants. */
  automation: CuAutomationPermission;
  tcc: { readable: boolean; error?: string };
  platform: string;
}

interface TccRow {
  service: string;
  client: string;
  auth_value: number | string | null;
  indirect_object_identifier?: string | null;
}

const TCC_SERVICES = {
  inputMonitoring: 'kTCCServiceListenEvent',
  automation: 'kTCCServiceAppleEvents',
} as const;

const APP_CLIENTS = [
  'world.idchain.idagents-control',
  'world.idchain.idagents-control.helper',
  'com.electron.idagents-control-center',
  'ID Agents Control Center',
  'idagents-control-center',
];

function emptyPermissions(platform = process.platform): CuPermissions {
  return {
    screenRecording: 'unknown',
    accessibility: false,
    inputMonitoring: 'unknown',
    automation: { status: 'unknown', targets: [] },
    tcc: { readable: false },
    platform,
  };
}

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function appClients(): string[] {
  const clients = new Set(APP_CLIENTS);
  try { clients.add(app.getName()); } catch { /* */ }
  try { clients.add(app.getPath('exe')); } catch { /* */ }
  try { clients.add(process.execPath); } catch { /* */ }
  for (const p of [...clients]) {
    const marker = '.app/Contents/MacOS/';
    const idx = p.indexOf(marker);
    if (idx >= 0) clients.add(p.slice(0, idx + '.app'.length));
  }
  return [...clients].filter(Boolean);
}

function appClientPredicates(): string {
  const exact = appClients().map((c) => `client = ${sqlString(c)}`);
  const fuzzy = [
    'ID Agents Control Center',
    'idagents-control',
    'world.idchain.idagents-control',
  ].map((c) => `client like ${sqlString(`%${c}%`)}`);
  return [...exact, ...fuzzy].join(' OR ');
}

function tccDatabases(): { path: string; userScoped: boolean }[] {
  return [
    { path: join(homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'), userScoped: true },
    { path: '/Library/Application Support/com.apple.TCC/TCC.db', userScoped: false },
  ];
}

async function readTccRows(): Promise<{ rows: TccRow[]; readable: boolean; error?: string }> {
  const services = Object.values(TCC_SERVICES).map(sqlString).join(',');
  const clientPredicates = appClientPredicates();
  const sql = [
    'select service, client, auth_value, indirect_object_identifier',
    'from access',
    `where service in (${services})`,
    clientPredicates ? `and (${clientPredicates})` : '',
  ].filter(Boolean).join(' ');
  const rows: TccRow[] = [];
  const errors: string[] = [];
  let anyReadable = false;
  let userDbSeen = false;
  let userDbReadable = false;

  for (const db of tccDatabases()) {
    if (!existsSync(db.path)) continue;
    if (db.userScoped) userDbSeen = true;
    try {
      const { stdout } = await execFileP('/usr/bin/sqlite3', ['-json', db.path, sql], {
        env: externalChildEnvironment(),
        timeout: 1500,
      });
      anyReadable = true;
      if (db.userScoped) userDbReadable = true;
      const parsed = stdout.trim() ? JSON.parse(stdout) as TccRow[] : [];
      rows.push(...parsed);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const readable = userDbSeen ? userDbReadable : anyReadable;
  return { rows, readable, error: errors[0] };
}

function stateFromRows(rows: TccRow[], readable: boolean): CuPermissionState {
  if (!rows.length) return readable ? 'not-determined' : 'unknown';
  const values = rows.map((r) => Number(r.auth_value));
  if (values.some((v) => v >= 2)) return 'granted';
  if (values.some((v) => v === 0)) return 'denied';
  if (values.some((v) => v === 1)) return 'restricted';
  return 'unknown';
}

async function tccPermissions(): Promise<Pick<CuPermissions, 'inputMonitoring' | 'automation' | 'tcc'>> {
  const { rows, readable, error } = await readTccRows();
  const inputRows = rows.filter((r) => r.service === TCC_SERVICES.inputMonitoring);
  const automationRows = rows.filter((r) => r.service === TCC_SERVICES.automation);
  const targets = automationRows
    .filter((r) => Number(r.auth_value) >= 2 && r.indirect_object_identifier)
    .map((r) => String(r.indirect_object_identifier));
  return {
    inputMonitoring: stateFromRows(inputRows, readable),
    automation: { status: stateFromRows(automationRows, readable), targets: [...new Set(targets)] },
    tcc: { readable, ...(error ? { error } : {}) },
  };
}

export async function getPermissions(): Promise<CuPermissions> {
  if (process.platform !== 'darwin') {
    return emptyPermissions(process.platform);
  }
  let screenRecording: CuPermissions['screenRecording'] = 'unknown';
  try {
    screenRecording = systemPreferences.getMediaAccessStatus('screen') as CuPermissions['screenRecording'];
  } catch { /* older electron / non-mac */ }
  let accessibility = false;
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch { /* */ }
  const tcc = await tccPermissions();
  return { screenRecording, accessibility, ...tcc, platform: 'darwin' };
}

/** Is Accessibility (synthetic input) granted to this app? (false = don't prompt.) */
export function accessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return false;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
}

export type CuPermissionPane = 'screen' | 'accessibility' | 'input-monitoring' | 'automation';

/** Open the exact System Settings pane for a permission. */
export async function openPermissionSettings(which: CuPermissionPane): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Computer Use permission settings are available only on macOS.');
  }
  const panes: Record<CuPermissionPane, string> = {
    screen: 'Privacy_ScreenCapture',
    accessibility: 'Privacy_Accessibility',
    'input-monitoring': 'Privacy_ListenEvent',
    automation: 'Privacy_Automation',
  };
  const url = `x-apple.systempreferences:com.apple.preference.security?${panes[which]}`;
  await shell.openExternal(url);
}
