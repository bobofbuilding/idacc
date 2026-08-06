/**
 * Test an MCP server before attaching it — launch it, do the MCP initialize
 * handshake, and list its tools. Makes the "does this server actually work?"
 * question deterministic instead of finding out only after an agent rebuild.
 *
 * Runs in the Electron main process on the same machine as the manager, so
 * npx/uvx resolve the same way the agent's spawn would. stdio is fully
 * supported (the common case); http does a best-effort initialize POST.
 */

import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { McpServerSpec } from '../../../idctl/src/api/client.ts';
import {
  executableCandidatePaths,
  executableRequiresShell,
} from '../shared/subscriptionPortability.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';
import {
  managedProcessTreeTerminationFailed,
  retainedManagedProcessTreeLaunchFailure,
  spawnManagedProcessTree,
  terminateManagedProcessTree,
  type ManagedProcessTreeLaunch,
  type ManagedProcessTreeTerminationResult,
} from './managedProcessTree.ts';

declare const __IDACC_MCP_PROBE_RUNNER_SHA256__: string;

const COMPILED_MCP_PROBE_RUNNER_SHA256 =
  typeof __IDACC_MCP_PROBE_RUNNER_SHA256__ === 'string'
    ? __IDACC_MCP_PROBE_RUNNER_SHA256__
    : '';
const MCP_PROBE_RESULT_PREFIX = 'IDACC_MCP_PROBE_RESULT\t';
const MCP_PROBE_RESULT_MAX_BYTES = 128 * 1024;
const MCP_PROBE_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const DEFAULT_MCP_PROBE_TIMEOUT_MS = 45_000;
const DEFAULT_MCP_PROBE_GRACE_MS = 1_000;
const DEFAULT_MCP_PROBE_FORCE_WAIT_MS = 1_000;

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

export interface McpStdioLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  pathDelimiter?: string;
}

export interface McpStdioLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export interface McpProbeRuntimeConfig {
  runnerPath: string;
  runnerSha256?: string;
  jobHostPath?: string;
  bootstrapPath?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  graceMs?: number;
  forceWaitMs?: number;
  /** Test-only seam for holding the post-spawn, pre-registration boundary. */
  afterManagedLaunchForTest?: (
    launch: ManagedProcessTreeLaunch,
  ) => Promise<void>;
}

interface ActiveMcpProbe {
  child: ChildProcess;
  cleanup?: Promise<ManagedProcessTreeTerminationResult>;
  cleanupFailed: boolean;
  forceWaitMs: number;
  graceMs: number;
  platform: NodeJS.Platform;
  processGroupId?: number;
}

interface McpProbeLaunchAdmission {
  completion: Promise<void>;
  settle(): void;
}

let mcpProbeRuntime: McpProbeRuntimeConfig | null = null;
const activeMcpProbes = new Set<ActiveMcpProbe>();
const pendingMcpProbeLaunches = new Set<Promise<void>>();
let mcpProbeAdmissionClosed = false;
let mcpProbeShutdown: Promise<void> | null = null;

export function configureMcpProbeRuntime(
  config: McpProbeRuntimeConfig,
): void {
  mcpProbeRuntime = { ...config };
}

/**
 * Re-open launch admission after a recoverable startup retry. It is never
 * legal to reopen over a process tree, an in-flight launch, or a shutdown
 * cleanup that has not reached a terminal result.
 */
export function openMcpProbeAdmission(): void {
  if (
    mcpProbeShutdown
    || pendingMcpProbeLaunches.size > 0
    || activeMcpProbes.size > 0
  ) {
    throw new Error(
      'MCP probe admission cannot reopen while process cleanup is unresolved',
    );
  }
  mcpProbeAdmissionClosed = false;
}

function admitMcpProbeLaunch(): McpProbeLaunchAdmission | null {
  if (mcpProbeAdmissionClosed) return null;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let settled = false;
  const admission: McpProbeLaunchAdmission = {
    completion,
    settle: () => {
      if (settled) return;
      settled = true;
      pendingMcpProbeLaunches.delete(completion);
      resolveCompletion();
    },
  };
  pendingMcpProbeLaunches.add(completion);
  return admission;
}

async function drainMcpProbeLaunches(): Promise<void> {
  while (pendingMcpProbeLaunches.size > 0) {
    await Promise.allSettled([...pendingMcpProbeLaunches]);
  }
}

function admissionClosedResult(): McpTestResult {
  return {
    ok: false,
    error: 'MCP probe launch was blocked because application shutdown has closed admission',
  };
}

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(Number(value))));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateProbeRunner(config: McpProbeRuntimeConfig): string {
  const runnerPath = String(config.runnerPath || '');
  if (
    !runnerPath
    || runnerPath.includes('\0')
    || !isAbsolute(runnerPath)
    || !existsSync(runnerPath)
  ) {
    throw new Error('MCP probe runner is unavailable');
  }
  const stat = lstatSync(runnerPath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1_024
    || stat.size > 1024 * 1024
  ) {
    throw new Error('MCP probe runner is invalid');
  }
  const expectedSha256 = config.runnerSha256
    ?? COMPILED_MCP_PROBE_RUNNER_SHA256;
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('MCP probe runner integrity metadata is unavailable');
  }
  const actualSha256 = createHash('sha256')
    .update(readFileSync(runnerPath))
    .digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('MCP probe runner integrity verification failed');
  }
  return runnerPath;
}

function mcpCliDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  pathDelimiter: string,
): string[] {
  const platformDirs = platform === 'win32'
    ? [
        env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
        env.ProgramFiles ? join(env.ProgramFiles, 'nodejs') : undefined,
        env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'nodejs') : undefined,
        env.NVM_HOME,
        env.NVM_SYMLINK,
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return Array.from(new Set([
    ...platformDirs,
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    env.PNPM_HOME,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : join(home, '.volta', 'bin'),
    ...(env.PATH ? env.PATH.split(pathDelimiter) : []),
  ].filter((value): value is string => Boolean(value))));
}

function resolveMcpExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  directories: string[],
): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }
  for (const directory of directories) {
    const found = executableCandidatePaths(directory, command, {
      platform,
      pathExt: env.PATHEXT,
    }).find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return command;
}

/** Resolve stdio MCP commands using the host PATH/PATHEXT before spawning. */
export function resolveMcpStdioLaunch(
  command: string,
  specEnv: Record<string, string> = {},
  options: McpStdioLaunchOptions = {},
): McpStdioLaunch {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const env = externalChildEnvironment(options.env ?? process.env, specEnv);
  const directories = mcpCliDirectories(env, platform, home, pathDelimiter);
  env.PATH = directories.join(pathDelimiter);
  const executable = resolveMcpExecutable(command, env, platform, directories);
  return {
    command: executable,
    env,
    shell: executableRequiresShell(executable, platform),
  };
}

function parseProbeResult(line: string): McpTestResult | null {
  if (!line.startsWith(MCP_PROBE_RESULT_PREFIX)) return null;
  try {
    const encoded = line.slice(MCP_PROBE_RESULT_PREFIX.length);
    if (!encoded || encoded.length > MCP_PROBE_RESULT_MAX_BYTES) return null;
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      ok?: unknown;
      tools?: unknown;
      serverInfo?: unknown;
      error?: unknown;
    };
    if (typeof value.ok !== 'boolean') return null;
    const tools = Array.isArray(value.tools)
      ? value.tools
          .filter((tool): tool is string => typeof tool === 'string')
          .slice(0, 4_096)
      : undefined;
    const info = value.serverInfo && typeof value.serverInfo === 'object'
      ? value.serverInfo as { name?: unknown; version?: unknown }
      : undefined;
    return {
      ok: value.ok,
      ...(tools ? { tools } : {}),
      ...(info
        ? {
            serverInfo: {
              ...(typeof info.name === 'string' ? { name: info.name } : {}),
              ...(typeof info.version === 'string' ? { version: info.version } : {}),
            },
          }
        : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    };
  } catch {
    return null;
  }
}

function awaitProbeResult(
  child: ChildProcess,
  timeoutMs: number,
): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (result: McpTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdout?.resume();
      child.stderr?.resume();
      resolve(result);
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MCP_PROBE_RESULT_MAX_BYTES) {
        finish({ ok: false, error: 'MCP probe runner output exceeded its size limit' });
        return;
      }
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        const result = parseProbeResult(line);
        if (result) {
          finish(result);
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (Buffer.byteLength(stderr) >= MCP_PROBE_DIAGNOSTIC_MAX_BYTES) return;
      stderr += chunk.toString().slice(
        0,
        MCP_PROBE_DIAGNOSTIC_MAX_BYTES - Buffer.byteLength(stderr),
      );
    };
    const onError = (error: Error): void => {
      finish({ ok: false, error: `MCP probe runner failed: ${error.message}` });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      const diagnostic = stderr.trim().slice(0, 200);
      finish({
        ok: false,
        error: `MCP probe runner exited before reporting a result (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})${diagnostic ? `: ${diagnostic}` : ''}`,
      });
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    timeout = setTimeout(() => {
      finish({
        ok: false,
        error: 'MCP probe runner did not report a result before its deadline',
      });
    }, timeoutMs + 1_000);
    if (child.exitCode !== null || child.signalCode !== null) {
      setImmediate(() => {
        if (!settled) onClose(child.exitCode, child.signalCode);
      });
    }
  });
}

async function cleanupMcpProbeOnce(
  probe: ActiveMcpProbe,
): Promise<ManagedProcessTreeTerminationResult> {
  let result: ManagedProcessTreeTerminationResult;
  try {
    result = await terminateManagedProcessTree(
      probe.child,
      () => activeMcpProbes.has(probe),
      {
        platform: probe.platform,
        detachedProcessGroup: probe.platform !== 'win32',
        ownedProcessGroupId: probe.processGroupId,
        graceMs: probe.graceMs,
        forceWaitMs: probe.forceWaitMs,
      },
    );
  } catch (error) {
    result = {
      accepted: true,
      treeKillAttempted: true,
      treeKillSucceeded: false,
      fallbackDirectKill: false,
      exited: false,
      error: errorMessage(error),
    };
  }
  if (!managedProcessTreeTerminationFailed(result, true)) {
    activeMcpProbes.delete(probe);
  } else {
    probe.cleanupFailed = true;
  }
  return result;
}

function cleanupMcpProbe(
  probe: ActiveMcpProbe,
): Promise<ManagedProcessTreeTerminationResult> {
  if (probe.cleanup) return probe.cleanup;
  const cleanup = cleanupMcpProbeOnce(probe);
  probe.cleanup = cleanup;
  const clear = (): void => {
    if (probe.cleanup === cleanup) probe.cleanup = undefined;
  };
  void cleanup.then(clear, clear);
  return cleanup;
}

function cleanupFailureResult(
  result: ManagedProcessTreeTerminationResult,
  context = '',
): McpTestResult {
  return {
    ok: false,
    error: `MCP probe cleanup failed${context ? ` (${context})` : ''}: ${
      result.error ?? 'the managed process tree did not confirm shutdown'
    }`,
  };
}

async function retryFailedMcpProbeCleanup(): Promise<McpTestResult | null> {
  const retained = [...activeMcpProbes].filter((probe) => probe.cleanupFailed);
  if (retained.length === 0) return null;
  const results = await Promise.all(
    retained.map((probe) => cleanupMcpProbe(probe)),
  );
  const failed = results.find((result) => (
    managedProcessTreeTerminationFailed(result, true)
  ));
  return failed
    ? cleanupFailureResult(
        failed,
        'prior cleanup remains unconfirmed; the new probe was blocked',
      )
    : null;
}

/**
 * Drain every probe tree that still belongs to the application. Failed rows
 * remain registered so a guarded shutdown retry can attempt cleanup again.
 */
async function stopActiveMcpProbesOnce(): Promise<void> {
  // Every successful or retained launch publishes its ownership row before its
  // admission token settles. Draining first therefore makes the following
  // snapshot complete even across a slow Windows Job Host handshake.
  await drainMcpProbeLaunches();
  const probes = [...activeMcpProbes];
  if (probes.length === 0) return;
  const results = await Promise.all(probes.map((probe) => cleanupMcpProbe(probe)));
  const failed = results.filter((result) => (
    managedProcessTreeTerminationFailed(result, true)
  ));
  if (failed.length > 0) {
    throw new Error(
      `MCP probe cleanup failed for ${failed.length} managed process tree(s): ${
        failed[0]?.error ?? 'shutdown was not confirmed'
      }`,
    );
  }
}

export function stopActiveMcpProbes(): Promise<void> {
  // Closing admission is synchronous: a caller does not need to await this
  // function before every later testStdio call begins failing closed.
  mcpProbeAdmissionClosed = true;
  if (mcpProbeShutdown) return mcpProbeShutdown;
  const shutdown = stopActiveMcpProbesOnce();
  mcpProbeShutdown = shutdown;
  const clear = (): void => {
    if (mcpProbeShutdown === shutdown) mcpProbeShutdown = null;
  };
  void shutdown.then(clear, clear);
  return shutdown;
}

async function testStdio(
  spec: McpServerSpec,
): Promise<McpTestResult> {
  if (!spec.command) return { ok: false, error: 'stdio server needs a command' };
  if (mcpProbeAdmissionClosed) return admissionClosedResult();
  const config = mcpProbeRuntime;
  if (!config) {
    return { ok: false, error: 'MCP probe runtime is not configured' };
  }
  let runnerPath: string;
  try {
    runnerPath = validateProbeRunner(config);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const platform = config.platform ?? process.platform;
  const timeoutMs = boundedMilliseconds(
    config.timeoutMs,
    DEFAULT_MCP_PROBE_TIMEOUT_MS,
    120_000,
  );
  const graceMs = boundedMilliseconds(
    config.graceMs,
    DEFAULT_MCP_PROBE_GRACE_MS,
    30_000,
  );
  const forceWaitMs = boundedMilliseconds(
    config.forceWaitMs,
    DEFAULT_MCP_PROBE_FORCE_WAIT_MS,
    30_000,
  );
  let launch: McpStdioLaunch;
  try {
    launch = resolveMcpStdioLaunch(spec.command, spec.env, { platform });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const env: NodeJS.ProcessEnv = {
    ...launch.env,
    ELECTRON_RUN_AS_NODE: '1',
    IDACC_MANAGED_SERVICE: '1',
    IDACC_MCP_PROBE_RUNNER: '1',
    IDACC_MCP_PROBE_TIMEOUT_MS: String(timeoutMs),
  };
  const admission = admitMcpProbeLaunch();
  if (!admission) return admissionClosedResult();

  try {
    const priorCleanupFailure = await retryFailedMcpProbeCleanup();
    if (priorCleanupFailure) return priorCleanupFailure;
    if (mcpProbeAdmissionClosed) return admissionClosedResult();

    let managed;
    try {
      managed = await spawnManagedProcessTree(
        process.execPath,
        [runnerPath, launch.command, ...(spec.args ?? [])],
        {
          cwd: homedir(),
          env,
          platform,
          graceMs,
          jobHostPath: config.jobHostPath,
          bootstrapPath: config.bootstrapPath,
        },
      );
    } catch (error) {
      const retained = retainedManagedProcessTreeLaunchFailure(error);
      if (retained) {
        const probe: ActiveMcpProbe = {
          child: retained.child,
          cleanupFailed: true,
          forceWaitMs,
          graceMs,
          platform,
        };
        activeMcpProbes.add(probe);
        const cleanupPromise = cleanupMcpProbe(probe);
        admission.settle();
        const cleanup = await cleanupPromise;
        if (managedProcessTreeTerminationFailed(cleanup, true)) {
          return cleanupFailureResult(cleanup);
        }
      }
      return { ok: false, error: `MCP probe could not start: ${errorMessage(error)}` };
    }

    let postLaunchError: string | undefined;
    if (config.afterManagedLaunchForTest) {
      try {
        await config.afterManagedLaunchForTest(managed);
      } catch (error) {
        postLaunchError = errorMessage(error);
      }
    }
    const probe: ActiveMcpProbe = {
      child: managed.child,
      cleanupFailed: false,
      forceWaitMs,
      graceMs,
      platform,
      processGroupId: managed.processGroupId,
    };
    activeMcpProbes.add(probe);

    if (postLaunchError || mcpProbeAdmissionClosed) {
      const cleanupPromise = cleanupMcpProbe(probe);
      admission.settle();
      const cleanup = await cleanupPromise;
      if (managedProcessTreeTerminationFailed(cleanup, true)) {
        return cleanupFailureResult(cleanup);
      }
      return postLaunchError
        ? {
            ok: false,
            error: `MCP probe launch coordination failed: ${postLaunchError}`,
          }
        : admissionClosedResult();
    }

    admission.settle();
    const result = await awaitProbeResult(managed.child, timeoutMs);
    const cleanup = await cleanupMcpProbe(probe);
    if (managedProcessTreeTerminationFailed(cleanup, true)) {
      return cleanupFailureResult(cleanup);
    }
    return result;
  } finally {
    admission.settle();
  }
}

async function testHttp(spec: McpServerSpec): Promise<McpTestResult> {
  if (!spec.url) return { ok: false, error: 'http server needs a url' };
  try {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(spec.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idctl', version: '1' } } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `${res.status} — reachable, auth rejected (check headers)` };
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    return { ok: true, tools: [], error: 'reachable (full tool list requires a streaming client)' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testMcpServer(spec: McpServerSpec): Promise<McpTestResult> {
  const transport = spec.transport ?? 'stdio';
  if (transport === 'stdio') return testStdio(spec);
  if (transport === 'http') return testHttp(spec);
  return { ok: false, error: 'Test supports stdio (and basic http); sse is verified at runtime.' };
}
