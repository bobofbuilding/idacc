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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const GB = 1024 ** 3;

const BACKGROUND_STACKS: Record<string, { name: string; command: string; port?: number }> = {
  'mlx-lm-server': {
    name: 'MLX (mlx_lm.server)',
    command: 'python3 -m mlx_lm server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8081',
    port: 8081,
  },
};

const backgroundProcs = new Map<string, { child: ChildProcess; command: string; startedAt: number; logPath: string; name: string; port?: number }>();

/** GUI apps inherit a minimal PATH; include common package-manager locations. */
function cliEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH ? process.env.PATH.split(':') : [])];
  return { ...process.env, PATH: Array.from(new Set(dirs)).join(':') };
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

// The system_profiler probe is slowish (~1s) but its result is static — cache it
// so only the first Settings open pays for it; disk free is re-read every call.
let _gpuCache: { gpu?: string; gpuCores?: number } | null = null;
async function detectGpu(): Promise<{ gpu?: string; gpuCores?: number }> {
  if (_gpuCache) return _gpuCache;
  let out: { gpu?: string; gpuCores?: number } = {};
  if (osPlatform() === 'darwin') {
    try {
      const { stdout } = await execFileP('system_profiler', ['SPDisplaysDataType'], { timeout: 6000 });
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
export async function localStackInstallStatus(ids: string[]): Promise<Record<string, LocalStackInstallStatus>> {
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
  return out;
}

/**
 * Open the user's Terminal and run a command there. Visible + abortable in their
 * own shell — we never run installers silently. macOS only (osascript); returns
 * the command either way so the UI can fall back to clipboard if Terminal
 * automation is blocked.
 */
export async function runInTerminal(command: string): Promise<{ ok: boolean; ran: boolean; command: string; error?: string }> {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, ran: false, command: cmd, error: 'empty command' };
  try {
    const osa = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await execFileP('osascript', ['-e', osa], { timeout: 8000 });
    return { ok: true, ran: true, command: cmd };
  } catch (e) {
    return { ok: false, ran: false, command: cmd, error: e instanceof Error ? e.message : String(e) };
  }
}

function stackLogDir(userDataPath?: string): string {
  const dir = join(userDataPath || join(homedir(), '.config', 'idctl'), 'local-stack-logs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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
  return {
    id,
    name: row.name,
    running: !row.child.killed && row.child.exitCode == null,
    pid: row.child.pid,
    command: row.command,
    startedAt: row.startedAt,
    exitCode: row.child.exitCode,
    signal: row.child.signalCode,
    port: row.port,
    logPath: row.logPath,
    detail,
  };
}

export function backgroundStackStatus(ids: string[] = Object.keys(BACKGROUND_STACKS)): Record<string, BackgroundStackStatus> {
  const out: Record<string, BackgroundStackStatus> = {};
  for (const id of ids.map(String)) out[id] = statusFromProcess(id);
  return out;
}

export async function startBackgroundStack(idValue: unknown, commandValue?: unknown, userDataPath?: string): Promise<BackgroundStackStatus> {
  const id = String(idValue || '').trim();
  const known = BACKGROUND_STACKS[id];
  const command = String(commandValue || known?.command || '').trim();
  if (!id || !known) throw new Error(`unsupported background stack "${id || '(empty)'}"`);
  if (!command) throw new Error(`no background start command registered for ${known.name}`);

  const existing = backgroundProcs.get(id);
  if (existing && !existing.child.killed && existing.child.exitCode == null) return statusFromProcess(id, 'already running');

  const logPath = join(stackLogDir(userDataPath), `${id}.log`);
  appendFileSync(logPath, `\n\n[${new Date().toISOString()}] starting ${known.name}\n$ ${command}\n`, { mode: 0o600 });
  const outFd = openSync(logPath, 'a', 0o600);
  const errFd = openSync(logPath, 'a', 0o600);
  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: homedir(),
    env: cliEnv(),
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  const row = { child, command, startedAt: Date.now(), logPath, name: known.name, port: known.port };
  backgroundProcs.set(id, row);
  child.on('exit', (code, signal) => {
    appendFileSync(logPath, `\n[${new Date().toISOString()}] exited code=${code ?? ''} signal=${signal ?? ''}\n`, { mode: 0o600 });
    const current = backgroundProcs.get(id);
    if (current?.child === child) backgroundProcs.delete(id);
  });
  child.unref();
  return statusFromProcess(id, 'started in background');
}

export async function stopBackgroundStack(idValue: unknown): Promise<BackgroundStackStatus> {
  const id = String(idValue || '').trim();
  const row = backgroundProcs.get(id);
  if (!row) return statusFromProcess(id, 'not running under IDACC');
  row.child.kill('SIGTERM');
  backgroundProcs.delete(id);
  return {
    id,
    name: row.name,
    running: false,
    pid: row.child.pid,
    command: row.command,
    startedAt: row.startedAt,
    port: row.port,
    logPath: row.logPath,
    detail: 'stop requested',
  };
}
