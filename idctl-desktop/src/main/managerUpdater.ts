import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const UPDATE_PLIST = 'io.bittrees.idagents-manager-updater.plist';
const DEFAULT_SOURCE = 'https://github.com/bobofbuilding/id-agents.git';
const OUTPUT_LIMIT = 256 * 1024;
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;

export type ManagerUpdaterConfig = {
  nodePath: string;
  updaterPath: string;
  target: string;
  managerUrl: string;
  source: string;
  branch: string;
  state: string;
  lock: string;
};

type UpdaterResult = {
  status?: string;
  version?: string;
  commit?: string;
  targetCommit?: string;
  currentCommit?: string;
  activeQueries?: number;
  reason?: string;
};

export type ManagerUpdateStatus = {
  configured: boolean;
  busy?: boolean;
  installedVersion?: string;
  latestVersion?: string;
  status?: string;
  available?: boolean;
  pendingActivation?: boolean;
  activeQueries?: number;
  checkout?: string;
  source?: string;
  lastChecked?: number;
  detail?: string;
  error?: string;
};

let activeUpdate: Promise<ManagerUpdateStatus> | null = null;
let cachedCheck: ManagerUpdateStatus | null = null;

function valueAfter(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function parseManagerUpdaterArguments(args: unknown, home = homedir()): ManagerUpdaterConfig {
  if (!Array.isArray(args) || args.length < 2 || args.some((value) => typeof value !== 'string')) {
    throw new Error('Manager updater service has invalid ProgramArguments');
  }
  const values = args as string[];
  const updaterPath = resolve(values[1]);
  const target = resolve(valueAfter(values, '--target', resolve(updaterPath, '../..')));
  return {
    nodePath: resolve(values[0]),
    updaterPath,
    target,
    managerUrl: valueAfter(values, '--manager-url', 'http://127.0.0.1:4100').replace(/\/+$/, ''),
    source: valueAfter(values, '--source', DEFAULT_SOURCE),
    branch: valueAfter(values, '--branch', 'main'),
    state: resolve(valueAfter(values, '--state', join(home, '.id-agents', 'manager-update.json'))),
    lock: resolve(valueAfter(values, '--lock', join(home, '.id-agents', 'manager-update.lock'))),
  };
}

export function parseManagerUpdaterResult(output: string): UpdaterResult | null {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && typeof value.status === 'string') return value as UpdaterResult;
    } catch {
      // Build and git output may precede the updater's final JSON record.
    }
  }
  return null;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function discoverConfig(): ManagerUpdaterConfig {
  const home = process.env.HOME || homedir();
  const plist = join(home, 'Library', 'LaunchAgents', UPDATE_PLIST);
  if (existsSync(plist) && process.platform === 'darwin') {
    const output = execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseManagerUpdaterArguments(JSON.parse(output), home);
  }

  const target = resolve(home, 'Projects', 'idacc-stack', 'id-agents');
  const updaterPath = join(target, 'scripts', 'manager-auto-update.mjs');
  if (!existsSync(updaterPath)) {
    throw new Error('Managed ID Agents updater is not configured. Run the IDACC stack installer first.');
  }
  return parseManagerUpdaterArguments([
    '/usr/bin/env', updaterPath,
    '--target', target,
    '--manager-url', 'http://127.0.0.1:4100',
    '--source', DEFAULT_SOURCE,
    '--branch', 'main',
    '--state', join(home, '.id-agents', 'manager-update.json'),
    '--lock', join(home, '.id-agents', 'manager-update.lock'),
  ], home);
}

function validateConfig(config: ManagerUpdaterConfig): void {
  if (!existsSync(config.nodePath) && config.nodePath !== '/usr/bin/env') {
    throw new Error(`Manager updater Node runtime is missing: ${config.nodePath}`);
  }
  if (!existsSync(join(config.target, '.git')) || !existsSync(join(config.target, 'package.json'))) {
    throw new Error(`Managed ID Agents checkout is missing or incomplete: ${config.target}`);
  }
  if (!existsSync(config.updaterPath) || resolve(config.updaterPath) !== join(config.target, 'scripts', 'manager-auto-update.mjs')) {
    throw new Error('Manager updater does not belong to the configured managed checkout');
  }
}

function installedStatus(config: ManagerUpdaterConfig): ManagerUpdateStatus {
  validateConfig(config);
  const packageJson = readJson(join(config.target, 'package.json'));
  const state = readJson(config.state);
  const status = typeof state.status === 'string' ? state.status : 'unknown';
  return {
    configured: true,
    busy: !!activeUpdate,
    installedVersion: typeof packageJson.version === 'string' ? packageJson.version : undefined,
    latestVersion: typeof state.version === 'string' ? state.version : undefined,
    status,
    pendingActivation: status === 'restart-pending',
    activeQueries: Number.isFinite(Number(state.activeQueries)) ? Number(state.activeQueries) : undefined,
    checkout: config.target,
    source: config.source,
    detail: typeof state.reason === 'string' ? state.reason : undefined,
  };
}

export function getManagerUpdateStatus(): ManagerUpdateStatus {
  try {
    const current = installedStatus(discoverConfig());
    if (!cachedCheck) return current;
    const checkedAvailability = cachedCheck.available === true;
    return {
      ...current,
      ...cachedCheck,
      busy: !!activeUpdate,
      installedVersion: current.installedVersion,
      checkout: current.checkout,
      source: current.source,
      status: checkedAvailability ? cachedCheck.status : current.status,
      available: checkedAvailability,
      pendingActivation: current.pendingActivation,
      activeQueries: current.pendingActivation ? current.activeQueries : undefined,
      detail: current.pendingActivation ? current.detail : cachedCheck.detail,
    };
  } catch (error) {
    return {
      configured: false,
      busy: !!activeUpdate,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function updaterArgs(config: ManagerUpdaterConfig, dryRun: boolean): string[] {
  const args = [
    config.updaterPath,
    '--target', config.target,
    '--manager-url', config.managerUrl,
    '--source', config.source,
    '--branch', config.branch,
    '--state', config.state,
    '--lock', config.lock,
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

function statusFromResult(config: ManagerUpdaterConfig, result: UpdaterResult, checkedAt: number): ManagerUpdateStatus {
  const current = installedStatus(config);
  const status = result.status || current.status;
  const pendingActivation = status === 'restart-pending' || status === 'deferred';
  return {
    ...current,
    busy: false,
    latestVersion: result.version || current.latestVersion || current.installedVersion,
    status,
    available: status === 'available' || status === 'build-required',
    pendingActivation,
    activeQueries: result.activeQueries,
    lastChecked: checkedAt,
    detail: result.reason,
  };
}

function runUpdater(config: ManagerUpdaterConfig, dryRun: boolean): Promise<ManagerUpdateStatus> {
  validateConfig(config);
  const checkedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(config.nodePath, updaterArgs(config, dryRun), {
      cwd: config.target,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectPromise(new Error(`Manager update ${dryRun ? 'check' : 'apply'} timed out`));
    }, dryRun ? CHECK_TIMEOUT_MS : APPLY_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-8).join('\n');
        rejectPromise(new Error(detail || `Manager updater exited with status ${code}`));
        return;
      }
      const result = parseManagerUpdaterResult(stdout);
      if (!result) {
        if (/already running/i.test(stdout)) {
          resolvePromise({ ...installedStatus(config), busy: true, detail: 'Manager update is already running.' });
          return;
        }
        rejectPromise(new Error('Manager updater returned no status record'));
        return;
      }
      resolvePromise(statusFromResult(config, result, checkedAt));
    });
  });
}

async function runSingleFlight(dryRun: boolean): Promise<ManagerUpdateStatus> {
  if (activeUpdate) return { ...getManagerUpdateStatus(), busy: true, detail: 'Manager update is already running.' };
  const config = discoverConfig();
  const operation = runUpdater(config, dryRun)
    .then((status) => {
      cachedCheck = status;
      return status;
    })
    .finally(() => { activeUpdate = null; });
  activeUpdate = operation;
  return operation;
}

export function checkManagerUpdate(): Promise<ManagerUpdateStatus> {
  return runSingleFlight(true);
}

export function applyManagerUpdate(): Promise<ManagerUpdateStatus> {
  return runSingleFlight(false);
}
