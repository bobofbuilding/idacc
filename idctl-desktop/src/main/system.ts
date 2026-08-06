/**
 * Host system info for the machine the control center is commanding. In the
 * common setup the manager runs on the SAME machine as this app (manager at
 * 127.0.0.1:4100), so local detection reflects where Ollama actually runs and
 * where models download. Used to warn when a model is too large for RAM/disk.
 *
 * Also exposes a "run in Terminal" helper so a stack's install/uninstall command
 * runs visibly in the user's own shell (never silently) — they see it and can
 * abort. We never execute anything without the user clicking through.
 */

import { totalmem, cpus, platform as osPlatform, arch as osArch, homedir } from 'node:os';
import { closeSync, existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, join } from 'node:path';
import { terminalAutomationSupported } from '../shared/subscriptionPortability.ts';
import {
  appendPrivateAppTextFile,
  ensurePrivateAppDirectory,
  openPrivateAppAppendFile,
} from './appStatePrivacy.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';
import {
  managedPosixProcessGroupIsAlive,
  managedProcessTreeTerminationFailed,
  terminateManagedProcessTree,
  waitForExactChildSpawn,
} from './managedProcessTree.ts';

const execFileP = promisify(execFile);
const GB = 1024 ** 3;
const LOCAL_STACK_INSTALL_CACHE_MS = 5 * 60_000;

const BACKGROUND_STACKS: Record<string, { name: string; command: string; port?: number }> = {
  'mlx-lm-server': {
    name: 'MLX (mlx_lm.server)',
    command: 'python3 -m mlx_lm server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8081',
    port: 8081,
  },
};

type BackgroundProcessRow = {
  child: ChildProcess;
  cleanupError?: string;
  command: string;
  forceWaitMs?: number;
  graceMs?: number;
  startedAt: number;
  rootExitLogged?: boolean;
  rootExitedAt?: number;
  logPath: string;
  monitor?: ReturnType<typeof setInterval>;
  name: string;
  platform: NodeJS.Platform;
  processGroupId: number;
  port?: number;
};

const backgroundProcs = new Map<string, BackgroundProcessRow>();
const backgroundOperations = new Map<string, Promise<unknown>>();
let backgroundStackAdmissionClosed = false;
let backgroundStackShutdown: Promise<void> | null = null;
const localStackInstallStatusCache = new Map<string, { at: number; rows: Record<string, LocalStackInstallStatus> }>();

/** GUI apps inherit a minimal PATH; include common package-manager locations. */
function cliEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH ? process.env.PATH.split(delimiter) : [])];
  return externalChildEnvironment(process.env, {
    PATH: Array.from(new Set(dirs)).join(delimiter),
  });
}

export interface HardwareInfo {
  platform: string;
  arch: string;
  /** macOS + arm64 → unified memory; the RAM figure bounds GPU use too. */
  appleSilicon: boolean;
  cpu: string;
  cpuCores: number;
  /** GPU / chipset model (macOS only); undefined elsewhere. */
  gpu?: string;
  /** GPU core count (macOS only). */
  gpuCores?: number;
  totalRamGB: number;
  /** Free / total space on the volume holding the home dir; null if unavailable. */
  freeDiskGB: number | null;
  totalDiskGB: number | null;
}

export interface LocalStackInstallStatus {
  id: string;
  installed: boolean;
  /** Evidence source that matches the uninstall command IDACC can review. */
  source?: string;
  detail?: string;
  /** Host port mapped to the stack's primary API port, when detected from the package/container. */
  port?: number;
  checkedAt: number;
}

export interface DockerStatus {
  installed: boolean;
  serverRunning: boolean;
  version?: string;
  serverVersion?: string;
  error?: string;
}

export interface BackgroundStackStatus {
  id: string;
  name: string;
  running: boolean;
  pid?: number;
  command?: string;
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  port?: number;
  logPath?: string;
  detail?: string;
}

export interface BackgroundStackLaunchOptions {
  /** Test seam; production always uses the current host platform and arch. */
  platform?: NodeJS.Platform;
  arch?: string;
  shellPath?: string;
  graceMs?: number;
  forceWaitMs?: number;
}

// The system_profiler probe is slowish (~1s) but its result is static — cache it
// so only the first Settings open pays for it; disk free is re-read every call.
let _gpuCache: { gpu?: string; gpuCores?: number } | null = null;
async function detectGpu(): Promise<{ gpu?: string; gpuCores?: number }> {
  if (_gpuCache) return _gpuCache;
  let out: { gpu?: string; gpuCores?: number } = {};
  if (osPlatform() === 'darwin') {
    try {
      const { stdout } = await execFileP('system_profiler', ['SPDisplaysDataType'], {
        env: externalChildEnvironment(),
        timeout: 6000,
      });
      const gpu = stdout.match(/Chipset Model:\s*(.+)/)?.[1]?.trim();
      const cores = stdout.match(/Total Number of Cores:\s*(\d+)/)?.[1];
      out = { gpu, gpuCores: cores ? Number(cores) : undefined };
    } catch {
      /* system_profiler unavailable / timed out */
    }
  }
  _gpuCache = out;
  return out;
}

export async function getHardware(): Promise<HardwareInfo> {
  let freeDiskGB: number | null = null;
  let totalDiskGB: number | null = null;
  try {
    const s = await statfs(homedir());
    freeDiskGB = +(((s.bavail as number) * (s.bsize as number)) / GB).toFixed(1);
    totalDiskGB = Math.round(((s.blocks as number) * (s.bsize as number)) / GB);
  } catch {
    /* statfs unavailable on this platform/runtime */
  }
  const { gpu, gpuCores } = await detectGpu();
  return {
    platform: osPlatform(),
    arch: osArch(),
    appleSilicon: osPlatform() === 'darwin' && osArch() === 'arm64',
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCores: cpus().length,
    gpu,
    gpuCores,
    totalRamGB: +(totalmem() / GB).toFixed(1),
    freeDiskGB,
    totalDiskGB,
  };
}

async function commandOk(bin: string, args: string[], timeout = 2500): Promise<boolean> {
  try {
    await execFileP(bin, args, { env: cliEnv(), timeout });
    return true;
  } catch {
    return false;
  }
}

async function brewFormulaInstalled(name: string): Promise<boolean> {
  return commandOk('brew', ['list', '--formula', name]);
}

async function brewCaskInstalled(name: string): Promise<boolean> {
  return commandOk('brew', ['list', '--cask', name]);
}

async function pipPackageInstalled(name: string): Promise<boolean> {
  return commandOk('python3', ['-m', 'pip', 'show', name]) ||
    commandOk('pip3', ['show', name]) ||
    commandOk('pip', ['show', name]);
}

type DockerContainerInspect = {
  State?: { Status?: string };
  HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> };
};

async function dockerContainerInspect(name: string): Promise<DockerContainerInspect | null> {
  try {
    const { stdout } = await execFileP('docker', ['container', 'inspect', name], { env: cliEnv(), timeout: 3000, maxBuffer: 1024 * 1024 });
    const rows = JSON.parse(stdout) as DockerContainerInspect[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function dockerContainerState(row: DockerContainerInspect | null): string | null {
  return row?.State?.Status ?? null;
}

function dockerHostPort(row: DockerContainerInspect | null, containerPort: number): number | undefined {
  const bindings = row?.HostConfig?.PortBindings?.[`${containerPort}/tcp`] ?? [];
  const hit = bindings.find((binding) => binding.HostPort);
  const port = Number(hit?.HostPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export async function dockerStatus(): Promise<DockerStatus> {
  let version: string | undefined;
  try {
    const { stdout } = await execFileP('docker', ['--version'], { env: cliEnv(), timeout: 2500 });
    version = stdout.trim();
  } catch (e) {
    return {
      installed: false,
      serverRunning: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  try {
    const { stdout } = await execFileP('docker', ['info', '--format', '{{.ServerVersion}}'], { env: cliEnv(), timeout: 4000 });
    return {
      installed: true,
      serverRunning: true,
      version,
      serverVersion: stdout.trim() || undefined,
    };
  } catch (e) {
    return {
      installed: true,
      serverRunning: false,
      version,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Read-only install evidence for Local LLM stack actions. This intentionally
 * checks the same package/container family as the uninstall command; a configured
 * backend or open port is not enough proof that IDACC can uninstall the package.
 */
function localStackInstallCacheKey(ids: string[]): string {
  return [...new Set(ids.map(String).filter(Boolean))].sort().join('\u0001');
}

export async function localStackInstallStatus(ids: string[], options: { force?: boolean } = {}): Promise<Record<string, LocalStackInstallStatus>> {
  const cacheKey = localStackInstallCacheKey(ids);
  if (!options.force && cacheKey) {
    const cached = localStackInstallStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LOCAL_STACK_INSTALL_CACHE_MS) return cached.rows;
  }
  const checkedAt = Date.now();
  const out: Record<string, LocalStackInstallStatus> = {};
  for (const id of ids.map(String)) {
    let installed = false;
    let source: string | undefined;
    if (id === 'ollama') {
      const formula = await brewFormulaInstalled('ollama');
      const cask = await brewCaskInstalled('ollama');
      const cli = await commandOk('ollama', ['--version']);
      const app = osPlatform() === 'darwin' && (existsSync('/Applications/Ollama.app') || existsSync(`${homedir()}/Applications/Ollama.app`));
      installed = formula || cask || cli || app;
      source = formula ? 'homebrew formula' : cask ? 'homebrew cask' : cli ? 'ollama CLI' : app ? 'Ollama.app' : undefined;
      out[id] = {
        id,
        installed,
        source,
        detail: installed
          ? formula || cask
            ? `Detected ${source}; uninstall action matches this install path.`
            : `Detected ${source}; IDACC will not offer package uninstall for this external install path.`
          : 'No matching package/container install evidence found.',
        checkedAt,
      };
      continue;
    } else if (id === 'lm-studio') {
      installed = await brewCaskInstalled('lm-studio');
      source = installed ? 'homebrew cask' : undefined;
    } else if (id === 'jan') {
      installed = await brewCaskInstalled('jan');
      source = installed ? 'homebrew cask' : undefined;
    } else if (id === 'gpt4all') {
      installed = await brewCaskInstalled('gpt4all');
      source = installed ? 'homebrew cask' : undefined;
    } else if (id === 'llama-cpp') {
      installed = await brewFormulaInstalled('llama.cpp');
      source = installed ? 'homebrew formula' : undefined;
    } else if (id === 'mlx-lm-server') {
      installed = await pipPackageInstalled('mlx-lm');
      source = installed ? 'pip package' : undefined;
    } else if (id === 'vllm') {
      installed = await pipPackageInstalled('vllm');
      source = installed ? 'pip package' : undefined;
    } else if (id === 'localai') {
      const inspect = await dockerContainerInspect('local-ai');
      const state = dockerContainerState(inspect);
      const port = dockerHostPort(inspect, 8080);
      installed = !!state;
      source = installed ? `docker container${state ? ` (${state})` : ''}` : undefined;
      out[id] = {
        id,
        installed,
        source,
        port,
        detail: installed
          ? `Detected ${source}${port ? ` on host port ${port}` : ''}; uninstall action matches this install path.`
          : 'No matching package/container install evidence found.',
        checkedAt,
      };
      continue;
    }
    out[id] = {
      id,
      installed,
      source,
      detail: installed ? `Detected ${source}; uninstall action matches this install path.` : 'No matching package/container install evidence found.',
      checkedAt,
    };
  }
  if (cacheKey) localStackInstallStatusCache.set(cacheKey, { at: Date.now(), rows: out });
  return out;
}

/**
 * Open the user's Terminal and run a command there. Visible + abortable in their
 * own shell — we never run installers silently. Automatic launch is currently
 * macOS-only; other platforms fail closed and return the untouched command so
 * the UI can use its existing clipboard/manual-terminal fallback.
 */
export async function runInTerminal(command: string): Promise<{ ok: boolean; ran: boolean; command: string; error?: string }> {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, ran: false, command: cmd, error: 'empty command' };
  if (!terminalAutomationSupported(process.platform)) {
    return {
      ok: false,
      ran: false,
      command: cmd,
      error: `Automatic terminal launch is not supported on ${process.platform}; the command was not executed.`,
    };
  }
  try {
    const osa = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await execFileP('osascript', ['-e', osa], {
      env: externalChildEnvironment(),
      timeout: 8000,
    });
    return { ok: true, ran: true, command: cmd };
  } catch (e) {
    return { ok: false, ran: false, command: cmd, error: e instanceof Error ? e.message : String(e) };
  }
}

function stackLogDir(profileLogsPath?: string): string {
  const dir = join(
    profileLogsPath || join(homedir(), '.config', 'idctl', 'logs'),
    'local-stack-logs',
  );
  return ensurePrivateAppDirectory(dir);
}

function backgroundRowIsAlive(row: BackgroundProcessRow): boolean {
  if (row.platform === 'win32') {
    return !row.child.killed
      && row.child.exitCode === null
      && row.child.signalCode === null;
  }
  return managedPosixProcessGroupIsAlive(row.child, row.processGroupId);
}

function clearBackgroundRow(id: string, row: BackgroundProcessRow): void {
  if (backgroundProcs.get(id) !== row) return;
  if (row.monitor) clearInterval(row.monitor);
  backgroundProcs.delete(id);
}

function monitorExitedBackgroundRoot(
  id: string,
  row: BackgroundProcessRow,
): void {
  if (row.monitor || backgroundProcs.get(id) !== row) return;
  row.monitor = setInterval(() => {
    if (backgroundProcs.get(id) !== row || !backgroundRowIsAlive(row)) {
      clearBackgroundRow(id, row);
    }
  }, 250);
  row.monitor.unref?.();
}

function recordBackgroundRootExit(row: BackgroundProcessRow): void {
  row.rootExitedAt ??= Date.now();
  if (row.rootExitLogged) return;
  row.rootExitLogged = true;
  try {
    appendPrivateAppTextFile(
      row.logPath,
      `\n[${new Date().toISOString()}] exited code=${row.child.exitCode ?? ''} signal=${row.child.signalCode ?? ''}\n`,
    );
  } catch (error) {
    console.warn('[local-stack] could not append the private process-exit log:', error);
  }
}

function runBackgroundOperation<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = backgroundOperations.get(id) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  backgroundOperations.set(id, next);
  const clear = (): void => {
    if (backgroundOperations.get(id) === next) backgroundOperations.delete(id);
  };
  void next.then(clear, clear);
  return next;
}

async function drainBackgroundOperations(): Promise<void> {
  while (backgroundOperations.size > 0) {
    await Promise.allSettled([...backgroundOperations.values()]);
  }
}

/**
 * Re-open local-stack launch admission after a recoverable startup retry. It is
 * never safe to reopen over a retained process tree or unresolved operation.
 */
export function openBackgroundStackAdmission(): void {
  if (
    backgroundStackShutdown
    || backgroundOperations.size > 0
    || backgroundProcs.size > 0
  ) {
    throw new Error(
      'background-stack admission cannot reopen while process cleanup is unresolved',
    );
  }
  backgroundStackAdmissionClosed = false;
}

function statusFromProcess(id: string, detail?: string): BackgroundStackStatus {
  const row = backgroundProcs.get(id);
  const known = BACKGROUND_STACKS[id];
  if (!row) {
    return {
      id,
      name: known?.name ?? id,
      running: false,
      port: known?.port,
      detail,
    };
  }
  const running = backgroundRowIsAlive(row);
  if (!running) {
    clearBackgroundRow(id, row);
  }
  const rootExited = row.rootExitedAt !== undefined
    || row.child.exitCode !== null
    || row.child.signalCode !== null;
  if (rootExited) recordBackgroundRootExit(row);
  if (running && rootExited) monitorExitedBackgroundRoot(id, row);
  const lifecycleDetail = running && rootExited
    ? 'the launcher exited; its retained background process tree is still running'
    : undefined;
  return {
    id,
    name: row.name,
    running,
    pid: row.child.pid,
    command: row.command,
    startedAt: row.startedAt,
    exitedAt: row.rootExitedAt,
    exitCode: row.child.exitCode,
    signal: row.child.signalCode,
    port: row.port,
    logPath: row.logPath,
    detail: detail ?? row.cleanupError ?? lifecycleDetail,
  };
}

export function backgroundStackStatus(ids: string[] = Object.keys(BACKGROUND_STACKS)): Record<string, BackgroundStackStatus> {
  const out: Record<string, BackgroundStackStatus> = {};
  for (const id of ids.map(String)) out[id] = statusFromProcess(id);
  return out;
}

export async function startBackgroundStack(
  idValue: unknown,
  commandValue?: unknown,
  profileLogsPath?: string,
  launchOptions: BackgroundStackLaunchOptions = {},
): Promise<BackgroundStackStatus> {
  const id = String(idValue || '').trim();
  if (backgroundStackAdmissionClosed) {
    throw new Error('background-stack launch is unavailable while the application is shutting down');
  }
  return runBackgroundOperation(id, () => startBackgroundStackOnce(
    id,
    commandValue,
    profileLogsPath,
    launchOptions,
  ));
}

async function startBackgroundStackOnce(
  id: string,
  commandValue?: unknown,
  profileLogsPath?: string,
  launchOptions: BackgroundStackLaunchOptions = {},
): Promise<BackgroundStackStatus> {
  const known = BACKGROUND_STACKS[id];
  const command = String(commandValue || known?.command || '').trim();
  if (!id || !known) throw new Error(`unsupported background stack "${id || '(empty)'}"`);
  if (!command) throw new Error(`no background start command registered for ${known.name}`);
  const platform = launchOptions.platform ?? process.platform;
  const architecture = launchOptions.arch ?? osArch();
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error(`${known.name} background launch requires Apple Silicon macOS`);
  }

  const existing = backgroundProcs.get(id);
  if (existing) {
    if (backgroundRowIsAlive(existing)) {
      return statusFromProcess(id, 'already running');
    }
    clearBackgroundRow(id, existing);
  }

  const logPath = join(stackLogDir(profileLogsPath), `${id}.log`);
  appendPrivateAppTextFile(
    logPath,
    `\n\n[${new Date().toISOString()}] starting ${known.name}\n$ ${command}\n`,
  );
  const logFd = openPrivateAppAppendFile(logPath);
  let child: ChildProcess;
  try {
    child = spawn(launchOptions.shellPath ?? '/bin/zsh', ['-lc', command], {
      cwd: homedir(),
      env: cliEnv(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  const processGroupId = await waitForExactChildSpawn(
    child,
    `${known.name} background process`,
  );
  const row: BackgroundProcessRow = {
    child,
    command,
    startedAt: Date.now(),
    logPath,
    name: known.name,
    platform,
    processGroupId,
    port: known.port,
    graceMs: launchOptions.graceMs,
    forceWaitMs: launchOptions.forceWaitMs,
  };
  backgroundProcs.set(id, row);
  child.on('exit', () => {
    recordBackgroundRootExit(row);
    const current = backgroundProcs.get(id);
    if (current !== row) return;
    if (backgroundRowIsAlive(row)) {
      monitorExitedBackgroundRoot(id, row);
    } else {
      clearBackgroundRow(id, row);
    }
  });
  child.unref();
  return statusFromProcess(id, 'started in background');
}

export async function stopBackgroundStack(idValue: unknown): Promise<BackgroundStackStatus> {
  const id = String(idValue || '').trim();
  return runBackgroundOperation(id, () => stopBackgroundStackOnce(id));
}

async function stopBackgroundStackOnce(id: string): Promise<BackgroundStackStatus> {
  const row = backgroundProcs.get(id);
  if (!row) return statusFromProcess(id, 'not running under IDACC');
  if (!backgroundRowIsAlive(row)) {
    clearBackgroundRow(id, row);
    return {
      id,
      name: row.name,
      running: false,
      pid: row.child.pid,
      command: row.command,
      startedAt: row.startedAt,
      exitedAt: row.rootExitedAt,
      exitCode: row.child.exitCode,
      signal: row.child.signalCode,
      port: row.port,
      logPath: row.logPath,
      detail: 'already stopped',
    };
  }
  row.cleanupError = undefined;
  const result = await terminateManagedProcessTree(
    row.child,
    () => backgroundProcs.get(id) === row,
    {
      platform: row.platform,
      detachedProcessGroup: true,
      ownedProcessGroupId: row.processGroupId,
      graceMs: row.graceMs,
      forceWaitMs: row.forceWaitMs,
    },
  );
  if (managedProcessTreeTerminationFailed(result, true)) {
    row.cleanupError = result.error
      ?? 'the background process tree could not be stopped safely';
    return statusFromProcess(
      id,
      row.cleanupError,
    );
  }
  clearBackgroundRow(id, row);
  return {
    id,
    name: row.name,
    running: false,
    pid: row.child.pid,
    command: row.command,
    startedAt: row.startedAt,
    exitedAt: row.rootExitedAt,
    exitCode: row.child.exitCode,
    signal: row.child.signalCode,
    port: row.port,
    logPath: row.logPath,
    detail: 'stopped',
  };
}

async function stopAllBackgroundStacksOnce(): Promise<void> {
  // A launch publishes its ownership row before its serialized operation
  // settles. Draining first therefore makes this snapshot complete even when a
  // native child-spawn handshake was still in flight when shutdown began.
  await drainBackgroundOperations();
  const ids = [...backgroundProcs.keys()];
  if (ids.length === 0) return;

  const settled = await Promise.allSettled(ids.map((id) => stopBackgroundStack(id)));
  const errors: unknown[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'rejected') {
      errors.push(result.reason);
      continue;
    }
    if (result.value.running) {
      errors.push(new Error(
        `${result.value.name} cleanup failed: ${
          result.value.detail || 'the managed process tree is still running'
        }`,
      ));
    }
  }

  // Status evaluation removes rows whose roots and retained descendants have
  // already exited. Failed live rows intentionally remain registered so a
  // guarded shutdown retry can attempt the exact same owned boundary again.
  for (const id of [...backgroundProcs.keys()]) statusFromProcess(id);
  if (backgroundProcs.size > 0 && errors.length === 0) {
    errors.push(new Error(
      `background-stack cleanup remains unconfirmed for ${backgroundProcs.size} managed process tree(s)`,
    ));
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `background-stack cleanup failed for ${errors.length} managed process tree(s)`,
    );
  }
}

/**
 * Close launch admission synchronously, drain any previously admitted
 * start/stop operations, then terminate every process tree still owned by
 * IDACC. Concurrent quit/relaunch/update requests share one cleanup flight.
 */
export function stopAllBackgroundStacks(): Promise<void> {
  backgroundStackAdmissionClosed = true;
  if (backgroundStackShutdown) return backgroundStackShutdown;
  const shutdown = stopAllBackgroundStacksOnce();
  backgroundStackShutdown = shutdown;
  const clear = (): void => {
    if (backgroundStackShutdown === shutdown) backgroundStackShutdown = null;
  };
  void shutdown.then(clear, clear);
  return shutdown;
}
