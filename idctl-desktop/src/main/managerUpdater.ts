import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const UPDATE_PLIST = 'io.bittrees.idagents-manager-updater.plist';
const DEFAULT_SOURCE = 'https://github.com/bobofbuilding/id-agents.git';
const OUTPUT_LIMIT = 256 * 1024;
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 20 * 60 * 1000;

export type ManagerUpdaterConfig = {
  nodePath: string;
  updaterPath: string;
  target: string;
  managerUrl: string;
  source: string;
  branch: string;
  state: string;
  lock: string;
  sqlitePath?: string;
  serviceConfigured: boolean;
};

type UpdaterResult = {
  status?: string;
  version?: string;
  commit?: string;
  targetCommit?: string;
  currentCommit?: string;
  activeQueries?: number;
  reason?: string;
  databasePath?: string;
  backupPath?: string;
  missingTeams?: { name: string; agentCount: number }[];
};

function parseSemver(value: string | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function effectiveManagerLatestVersion(
  installedVersion: string | undefined,
  publishedVersion: string | undefined,
): string | undefined {
  if (!installedVersion) return publishedVersion;
  if (!publishedVersion) return installedVersion;
  const installed = parseSemver(installedVersion);
  const published = parseSemver(publishedVersion);
  if (!installed || !published) return publishedVersion;
  for (let index = 0; index < installed.length; index += 1) {
    if (installed[index] > published[index]) return installedVersion;
    if (installed[index] < published[index]) return publishedVersion;
  }
  return publishedVersion;
}

export type ManagerUpdateStatus = {
  configured: boolean;
  bootstrapAvailable?: boolean;
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
  databasePath?: string;
  backupPath?: string;
  missingTeams?: { name: string; agentCount: number }[];
};

let activeUpdate: Promise<ManagerUpdateStatus> | null = null;
let cachedCheck: ManagerUpdateStatus | null = null;

function cliPath(home = homedir(), existingPath = process.env.PATH): string {
  let nvmBins: string[] = [];
  try {
    nvmBins = readdirSync(join(home, '.nvm', 'versions', 'node'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .map((entry) => join(home, '.nvm', 'versions', 'node', entry.name, 'bin'));
  } catch {
    // nvm is optional.
  }
  return Array.from(new Set([
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.mise', 'shims'),
    ...nvmBins,
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    ...(existingPath ? existingPath.split(':') : []),
  ])).join(':');
}

export function managerUpdaterEnvironment(
  home = process.env.HOME || homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    HOME: environment.HOME || home,
    PATH: cliPath(home, environment.PATH),
    npm_config_update_notifier: 'false',
  };
}

export function managerBootstrapScriptCandidates(
  resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
  cwd = process.cwd(),
): string[] {
  return Array.from(new Set([
    resourcesPath ? join(resourcesPath, 'scripts', 'install-idacc-stack.mjs') : '',
    resolve(cwd, 'scripts', 'install-idacc-stack.mjs'),
    resolve(cwd, '..', 'scripts', 'install-idacc-stack.mjs'),
  ].filter(Boolean)));
}

function bootstrapScript(): string {
  const path = managerBootstrapScriptCandidates().find((candidate) => existsSync(candidate));
  if (!path) throw new Error('The manager installer is not bundled with this IDACC build. Update IDACC and retry.');
  return path;
}

function managerBootstrapAvailable(): boolean {
  return process.platform === 'darwin' && managerBootstrapScriptCandidates().some((candidate) => existsSync(candidate));
}

function valueAfter(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function parseManagerUpdaterArguments(
  args: unknown,
  home = homedir(),
  environment: Record<string, unknown> = {},
  serviceConfigured = true,
): ManagerUpdaterConfig {
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
    sqlitePath: typeof environment.SQLITE_PATH === 'string' && environment.SQLITE_PATH.trim()
      ? resolve(environment.SQLITE_PATH)
      : resolve(join(home, '.id-agents', 'id-agents.db')),
    serviceConfigured,
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
    let environment: Record<string, unknown> = {};
    try {
      const environmentOutput = execFileSync('/usr/bin/plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', plist], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(environmentOutput);
      if (parsed && typeof parsed === 'object') environment = parsed;
    } catch {
      // Legacy updater plists did not declare an explicit state-store path.
    }
    return parseManagerUpdaterArguments(JSON.parse(output), home, environment, true);
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
  ], home, {}, false);
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
  const installedVersion = typeof packageJson.version === 'string' ? packageJson.version : undefined;
  const publishedVersion = typeof state.version === 'string' ? state.version : undefined;
  return {
    configured: config.serviceConfigured,
    bootstrapAvailable: !config.serviceConfigured ? managerBootstrapAvailable() : undefined,
    busy: !!activeUpdate,
    installedVersion,
    latestVersion: effectiveManagerLatestVersion(installedVersion, publishedVersion),
    status: config.serviceConfigured ? status : 'installation-required',
    pendingActivation: status === 'restart-pending',
    activeQueries: Number.isFinite(Number(state.activeQueries)) ? Number(state.activeQueries) : undefined,
    checkout: config.target,
    source: config.source,
    detail: typeof state.reason === 'string' ? state.reason : undefined,
    databasePath: typeof state.databasePath === 'string' ? state.databasePath : config.sqlitePath,
    backupPath: typeof state.backupPath === 'string' ? state.backupPath : undefined,
    missingTeams: Array.isArray(state.missingTeams)
      ? state.missingTeams.filter((team): team is { name: string; agentCount: number } => (
        !!team && typeof team === 'object' && typeof (team as { name?: unknown }).name === 'string'
      )).map((team) => ({ name: team.name, agentCount: Number(team.agentCount || 0) }))
      : undefined,
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
    const bootstrapAvailable = managerBootstrapAvailable();
    return {
      configured: false,
      bootstrapAvailable,
      busy: !!activeUpdate,
      detail: bootstrapAvailable ? 'Install the current compatible manager and its background updater.' : undefined,
      error: bootstrapAvailable ? undefined : error instanceof Error ? error.message : String(error),
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

export function managerUpdaterInvocation(config: ManagerUpdaterConfig, dryRun: boolean): { command: string; args: string[] } {
  const args = updaterArgs(config, dryRun);
  return config.nodePath === '/usr/bin/env'
    ? { command: config.nodePath, args: ['node', ...args] }
    : { command: config.nodePath, args };
}

function statusFromResult(config: ManagerUpdaterConfig, result: UpdaterResult, checkedAt: number): ManagerUpdateStatus {
  const current = installedStatus(config);
  const status = result.status || current.status;
  const pendingActivation = status === 'restart-pending' || status === 'deferred';
  const publishedVersion = result.version || current.latestVersion;
  return {
    ...current,
    busy: false,
    latestVersion: effectiveManagerLatestVersion(current.installedVersion, publishedVersion),
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
  if (!config.serviceConfigured) {
    return Promise.reject(new Error('The manager checkout exists, but its managed services are not installed. Install the current manager first.'));
  }
  const checkedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = managerUpdaterInvocation(config, dryRun);
    const child = spawn(invocation.command, invocation.args, {
      cwd: config.target,
      env: {
        ...managerUpdaterEnvironment(),
        ...(config.sqlitePath ? { SQLITE_PATH: config.sqlitePath } : {}),
      },
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
        const current = installedStatus(config);
        if (current.status === 'state-mismatch') {
          resolvePromise({ ...current, busy: false, error: detail || 'Manager state verification failed after update.' });
          return;
        }
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

function runBootstrap(): Promise<ManagerUpdateStatus> {
  const script = bootstrapScript();
  const home = process.env.HOME || homedir();
  const projectDir = join(home, 'Projects', 'idacc-stack');
  const checkedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      script,
      '--manager-only',
      '--project-dir', projectDir,
      '--manager-source', DEFAULT_SOURCE,
      '--branch', 'main',
      '--manager-port', '4100',
      '--no-open',
    ], {
      cwd: home,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: cliPath(home),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectPromise(new Error('Manager installation timed out'));
    }, BOOTSTRAP_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-10).join('\n');
        rejectPromise(new Error(detail || `Manager installer exited with status ${code}`));
        return;
      }
      const result = parseManagerUpdaterResult(stdout);
      if (!result || (result.status !== 'installed' && result.status !== 'current')) {
        rejectPromise(new Error('Manager installer returned no completion record'));
        return;
      }
      try {
        const current = installedStatus(discoverConfig());
        cachedCheck = {
          ...current,
          bootstrapAvailable: true,
          status: 'updated',
          latestVersion: result.version || current.installedVersion,
          available: false,
          lastChecked: checkedAt,
          detail: 'Compatible manager installed, started, and enrolled in background updates.',
        };
        resolvePromise(cachedCheck);
      } catch (error) {
        rejectPromise(error);
      }
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

export function bootstrapManagerInstall(): Promise<ManagerUpdateStatus> {
  if (activeUpdate) return Promise.resolve({ ...getManagerUpdateStatus(), busy: true, detail: 'Manager installation or update is already running.' });
  const operation = runBootstrap().finally(() => { activeUpdate = null; });
  activeUpdate = operation;
  return operation;
}
