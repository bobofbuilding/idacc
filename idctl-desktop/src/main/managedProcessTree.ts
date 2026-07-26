import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import type { Readable } from 'node:stream';

declare const __IDACC_WINDOWS_JOB_HOST_AVAILABLE__: boolean;
declare const __IDACC_WINDOWS_JOB_HOST_SHA256__: string;
declare const __IDACC_WINDOWS_JOB_HOST_EXPECTED_PUBLISHER__: string;
declare const __IDACC_MANAGED_SERVICE_BOOTSTRAP_SHA256__: string;
declare const __IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__: boolean;

const WINDOWS_JOB_HOST_BUILD_DEFINED =
  typeof __IDACC_WINDOWS_JOB_HOST_AVAILABLE__ !== 'undefined';
const WINDOWS_JOB_HOST_AVAILABLE = WINDOWS_JOB_HOST_BUILD_DEFINED
  ? __IDACC_WINDOWS_JOB_HOST_AVAILABLE__
  : false;
const WINDOWS_JOB_HOST_SHA256 = WINDOWS_JOB_HOST_BUILD_DEFINED
  && typeof __IDACC_WINDOWS_JOB_HOST_SHA256__ === 'string'
  ? __IDACC_WINDOWS_JOB_HOST_SHA256__
  : '';
const WINDOWS_JOB_HOST_EXPECTED_PUBLISHER = WINDOWS_JOB_HOST_BUILD_DEFINED
  && typeof __IDACC_WINDOWS_JOB_HOST_EXPECTED_PUBLISHER__ === 'string'
  ? __IDACC_WINDOWS_JOB_HOST_EXPECTED_PUBLISHER__
  : '';
const MANAGED_SERVICE_BOOTSTRAP_SHA256 =
  typeof __IDACC_MANAGED_SERVICE_BOOTSTRAP_SHA256__ === 'string'
    ? __IDACC_MANAGED_SERVICE_BOOTSTRAP_SHA256__
    : '';

export interface ManagedProcessTreeTerminationResult {
  accepted: boolean;
  treeKillAttempted: boolean;
  treeKillSucceeded: boolean;
  fallbackDirectKill: boolean;
  exited: boolean;
  error?: string;
}

export function managedProcessTreeTerminationFailed(
  result: ManagedProcessTreeTerminationResult,
  treeKillRequired: boolean,
): boolean {
  return !result.exited || (treeKillRequired && !result.treeKillSucceeded);
}

interface ManagedProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  currentPid?: number;
  graceMs?: number;
  forceWaitMs?: number;
  detachedProcessGroup?: boolean;
  ownedProcessGroupId?: number;
  killProcess?: (pid: number, signal: NodeJS.Signals | number) => boolean;
}

const DEFAULT_GRACE_MS = 4_000;
const DEFAULT_FORCE_WAIT_MS = 1_000;
const MAX_TERMINATION_WAIT_MS = 30_000;
const WINDOWS_JOB_HANDSHAKE_TIMEOUT_MS = 15_000;
const WINDOWS_JOB_HANDSHAKE_MAX_BYTES = 64 * 1024;
const WINDOWS_SIGNATURE_TIMEOUT_MS = 10_000;
const WINDOWS_PROTOCOL_PREFIX = 'IDACC_JOB_HOST';
const WINDOWS_JOB_HOST_NO_CHILD_EXIT_CODE = 127;
const WINDOWS_JOB_HOST_DRAINED_AFTER_FAILURE_EXIT_CODE = 128;

export interface ManagedProcessTreeLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  parentPid?: number;
  graceMs?: number;
  jobHostPath?: string;
  bootstrapPath?: string;
  windowsExpectedPublisher?: string;
  windowsJobHostSha256?: string;
  managedServiceBootstrapSha256?: string;
  windowsAbortAfterReadyForTest?: boolean;
  windowsForceLaunchCleanupTimeoutForTest?: boolean;
}

export interface ManagedProcessTreeLaunch {
  child: ChildProcess;
  actualPid: number;
  hostPid: number;
  processGroupId?: number;
}

export interface ManagedProcessLaunchCoordinator {
  activeCount(): number;
  run(owner: object, launch: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
}

/**
 * Serialize launches per managed owner and retain every admitted launch until
 * it settles. Shutdown closes launch admission in the supervisor first, then
 * drains this coordinator before enumerating process trees, so a child cannot
 * materialize just after the shutdown snapshot.
 */
export function createManagedProcessLaunchCoordinator(): ManagedProcessLaunchCoordinator {
  const byOwner = new WeakMap<object, Promise<void>>();
  const active = new Set<Promise<void>>();

  return {
    activeCount: () => active.size,
    run: (owner, launch) => {
      const existing = byOwner.get(owner);
      if (existing) return existing;

      // Defer user work by one microtask so both registries own the launch
      // before it can cross its first asynchronous process boundary.
      const admitted = Promise.resolve().then(launch);
      byOwner.set(owner, admitted);
      active.add(admitted);
      const clear = (): void => {
        if (byOwner.get(owner) === admitted) byOwner.delete(owner);
        active.delete(admitted);
      };
      void admitted.then(clear, clear);
      return admitted;
    },
    drain: async () => {
      // Work already admitted can enqueue another owner while settling. Keep
      // taking snapshots until no tracked launch remains.
      while (active.size > 0) {
        const batch = [...active];
        await Promise.allSettled(batch);
        for (const launch of batch) active.delete(launch);
      }
    },
  };
}

export interface RetainedManagedProcessTreeLaunchFailure {
  child: ChildProcess;
  actualPid?: number;
  hostPid: number;
  cleanupError: string;
}

const retainedLaunchFailures = new WeakMap<
  Error,
  RetainedManagedProcessTreeLaunchFailure
>();

export class ManagedProcessTreeLaunchError extends Error {
  declare readonly cleanedActualPid?: number;

  constructor(
    message: string,
    options: {
      retained?: RetainedManagedProcessTreeLaunchFailure;
      cleanedActualPid?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ManagedProcessTreeLaunchError';
    // The retained ChildProcess necessarily contains Node's private spawn
    // metadata. Keep that exact retry handle outside the Error object entirely
    // so logs/telemetry/serialization cannot disclose paths or environment.
    if (options.retained) retainedLaunchFailures.set(this, options.retained);
    Object.defineProperty(this, 'cleanedActualPid', {
      configurable: false,
      enumerable: false,
      value: options.cleanedActualPid,
      writable: false,
    });
  }
}

export function retainedManagedProcessTreeLaunchFailure(
  error: unknown,
): RetainedManagedProcessTreeLaunchFailure | undefined {
  return error instanceof ManagedProcessTreeLaunchError
    ? retainedLaunchFailures.get(error)
    : undefined;
}

interface WindowsManagedJob {
  nonce: string;
  actualPid?: number;
  hostPid: number;
  graceMs: number;
  cleanupOnly: boolean;
}

const windowsManagedJobs = new WeakMap<ChildProcess, WindowsManagedJob>();

function boundedWait(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TERMINATION_WAIT_MS, Math.max(1, Math.floor(Number(value))));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childIsAlive(child: ChildProcess): boolean {
  return Boolean(
    Number.isSafeInteger(child.pid)
    && Number(child.pid) > 0
    && child.exitCode === null
    && child.signalCode === null,
  );
}

/**
 * The Windows handshake must pause the shared runtime stream while it removes
 * its private protocol listener and puts raced application bytes back. A
 * Readable that was explicitly paused does not resume merely because its next
 * owner later adds a `data` listener, so hand flowing mode to that first owner
 * on the following microtask. `pipe()` remains safe because it resumes the
 * source itself; readable-mode consumers remain paused and retain backpressure.
 */
export function armPausedStreamForConsumer(stream: Readable | null): void {
  if (!stream) return;
  let armed = true;
  const cleanup = (): void => {
    if (!armed) return;
    armed = false;
    stream.removeListener('newListener', onNewListener);
    stream.removeListener('close', onClose);
  };
  const onClose = (): void => cleanup();
  const onNewListener = (eventName: string | symbol): void => {
    if (eventName !== 'data') return;
    cleanup();
    queueMicrotask(() => {
      if (
        !stream.destroyed
        && !stream.readableEnded
        && stream.listenerCount('data') > 0
        && stream.readableFlowing === false
      ) {
        stream.resume();
      }
    });
  };
  stream.on('newListener', onNewListener);
  stream.once('close', onClose);
}

function windowsJobHostReportedEmpty(child: ChildProcess): boolean {
  const exitCode = child.exitCode;
  return (
    child.signalCode === null
    && Number.isInteger(exitCode)
    && (
      (Number(exitCode) >= 0 && Number(exitCode) <= 124)
      || Number(exitCode) === WINDOWS_JOB_HOST_DRAINED_AFTER_FAILURE_EXIT_CODE
    )
  );
}

function windowsLaunchCleanupProved(
  child: ChildProcess,
  actualPid: number | undefined,
): boolean {
  if (windowsJobHostReportedEmpty(child)) return true;
  // Exit 127 is emitted only when the integrity-verified Job Host proves that
  // CreateProcess never produced a managed child. It is deliberately accepted
  // only before a READY identity has been observed; exit 126 remains an
  // unconfirmed host/protocol failure and must retain its cleanup obligation.
  return (
    actualPid === undefined
    && child.signalCode === null
    && child.exitCode === WINDOWS_JOB_HOST_NO_CHILD_EXIT_CODE
  );
}

function ownedChildPid(
  child: ChildProcess,
  ownsChild: () => boolean,
  currentPid: number,
  allowExitedRoot = false,
): number | null {
  let owned = false;
  try { owned = ownsChild(); } catch { owned = false; }
  const pid = Number(child.pid);
  if (
    !owned
    || (!allowExitedRoot && !childIsAlive(child))
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || pid === currentPid
  ) return null;
  return pid;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!childIsAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      resolve(!childIsAlive(child));
    };
    child.once('exit', finish);
    child.once('error', finish);
    timeout = setTimeout(finish, timeoutMs);
  });
}

function validateAbsoluteWindowsFile(path: string): string {
  const normalized = win32.normalize(String(path || ''));
  if (
    !normalized
    || normalized.includes('\0')
    || !win32.isAbsolute(normalized)
    || !/^[a-z]:\\/i.test(normalized)
    || normalized.startsWith('\\\\')
    || normalized.slice(2).includes(':')
  ) {
    throw new Error('managed Windows process path is invalid');
  }
  return normalized;
}

function exactWindowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const root = validateAbsoluteWindowsFile(String(env.SystemRoot || env.WINDIR || ''));
  return win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

async function verifyAuthenticodePublisher(
  jobHostPath: string,
  expectedPublisher: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const powershell = exactWindowsPowerShellPath(env);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:IDACC_JOB_HOST_PATH',
    "if ($signature.Status -ne 'Valid') { exit 1 }",
    'if ($null -eq $signature.SignerCertificate) { exit 1 }',
    'if ($signature.SignerCertificate.Subject -cne $env:IDACC_JOB_HOST_PUBLISHER) { exit 1 }',
    "[Console]::Out.Write('IDACC_JOB_HOST_SIGNATURE_OK')",
  ].join('; ');
  await new Promise<void>((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const verifier = spawn(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      cwd: win32.dirname(powershell),
      env: {
        SystemRoot: env.SystemRoot || env.WINDIR,
        WINDIR: env.WINDIR || env.SystemRoot,
        IDACC_JOB_HOST_PATH: jobHostPath,
        IDACC_JOB_HOST_PUBLISHER: expectedPublisher,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        try { verifier.kill('SIGKILL'); } catch { /* verifier already stopped */ }
        reject(error);
      }
      else resolve();
    };
    verifier.stdout?.on('data', (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + value.length > 128) {
        finish(new Error('Windows Job Host signature verification failed'));
        return;
      }
      stdout = Buffer.concat([stdout, value]);
    });
    verifier.stderr?.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 128) {
        finish(new Error('Windows Job Host signature verification failed'));
      }
    });
    verifier.once('error', () => finish(new Error('Windows Job Host signature verification failed')));
    verifier.once('exit', (code, signal) => {
      if (
        code !== 0
        || signal
        || stderrBytes > 0
        || stdout.toString('utf8').trim() !== 'IDACC_JOB_HOST_SIGNATURE_OK'
      ) {
        finish(new Error('Windows Job Host signature verification failed'));
        return;
      }
      finish();
    });
    timeout = setTimeout(() => {
      try { verifier.kill('SIGKILL'); } catch { /* verifier already stopped */ }
      finish(new Error('Windows Job Host signature verification timed out'));
    }, WINDOWS_SIGNATURE_TIMEOUT_MS);
    timeout.unref?.();
  });
}

async function verifyWindowsJobHost(
  path: string,
  options: ManagedProcessTreeLaunchOptions,
): Promise<void> {
  const normalized = validateAbsoluteWindowsFile(path);
  const expectedPublisher = options.windowsExpectedPublisher
    ?? WINDOWS_JOB_HOST_EXPECTED_PUBLISHER;
  const expectedSha256 = options.windowsJobHostSha256
    ?? WINDOWS_JOB_HOST_SHA256;
  if (!existsSync(normalized)) throw new Error('Windows Job Host is not present');
  const stat = lstatSync(normalized);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4_096 || stat.size > 8 * 1024 * 1024) {
    throw new Error('Windows Job Host is invalid');
  }
  if (expectedPublisher) {
    if (
      expectedPublisher.length < 3
      || expectedPublisher.length > 1_024
      || /[\0\r\n]/.test(expectedPublisher)
    ) {
      throw new Error('Windows Job Host publisher metadata is invalid');
    }
    await verifyAuthenticodePublisher(normalized, expectedPublisher, options.env);
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Windows Job Host integrity metadata is unavailable');
  }
  const actual = createHash('sha256').update(readFileSync(normalized)).digest('hex');
  if (actual !== expectedSha256) throw new Error('Windows Job Host integrity verification failed');
}

function encodeProtocolString(value: string): string {
  if (value.includes('\0')) throw new Error('managed process argument is invalid');
  return Buffer.from(value, 'utf8').toString('base64');
}

function windowsJobConfiguration(
  executable: string,
  args: readonly string[],
  options: ManagedProcessTreeLaunchOptions,
  nonce: string,
): string {
  const parentPid = options.parentPid ?? process.pid;
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('managed process parent PID is invalid');
  }
  const graceMs = boundedWait(options.graceMs, DEFAULT_GRACE_MS);
  const fields = [
    'IDACC_JOB_CONFIG',
    '1',
    nonce,
    String(parentPid),
    String(graceMs),
    encodeProtocolString(validateAbsoluteWindowsFile(executable)),
    encodeProtocolString(validateAbsoluteWindowsFile(options.cwd)),
    String(args.length),
    ...args.map((argument) => encodeProtocolString(argument)),
  ];
  const line = fields.join('\t');
  if (line.length > 256 * 1024) throw new Error('managed process configuration is too large');
  return `${line}\n`;
}

function parseHandshakeLine(
  line: string,
  phase: 'READY' | 'STARTED',
  nonce: string,
  expectedHostPid: number,
  expectedActualPid?: number,
): number {
  const fields = line.split('\t');
  if (
    fields.length !== 6
    || fields[0] !== WINDOWS_PROTOCOL_PREFIX
    || fields[1] !== phase
    || fields[2] !== '1'
    || fields[3] !== nonce
  ) {
    throw new Error(`Windows Job Host ${phase.toLowerCase()} handshake was invalid`);
  }
  const hostPid = Number(fields[4]);
  const actualPid = Number(fields[5]);
  if (
    !Number.isSafeInteger(hostPid)
    || hostPid !== expectedHostPid
    || !Number.isSafeInteger(actualPid)
    || actualPid <= 0
    || actualPid === hostPid
    || (expectedActualPid !== undefined && actualPid !== expectedActualPid)
  ) {
    throw new Error(`Windows Job Host ${phase.toLowerCase()} identity was invalid`);
  }
  return actualPid;
}

async function launchWindowsManagedProcessTree(
  executable: string,
  args: readonly string[],
  options: ManagedProcessTreeLaunchOptions,
): Promise<ManagedProcessTreeLaunch> {
  if (!WINDOWS_JOB_HOST_BUILD_DEFINED || !WINDOWS_JOB_HOST_AVAILABLE) {
    throw new Error('this Windows build does not contain its managed Job Host');
  }
  const jobHostPath = validateAbsoluteWindowsFile(options.jobHostPath || '');
  const bootstrapPath = validateAbsoluteWindowsFile(options.bootstrapPath || '');
  if (!existsSync(bootstrapPath)) {
    throw new Error('managed service bootstrap is not present');
  }
  const bootstrapStat = lstatSync(bootstrapPath);
  if (
    !bootstrapStat.isFile()
    || bootstrapStat.isSymbolicLink()
    || bootstrapStat.size < 256
    || bootstrapStat.size > 256 * 1024
  ) {
    throw new Error('managed service bootstrap is invalid');
  }
  const expectedBootstrapSha256 = options.managedServiceBootstrapSha256
    ?? MANAGED_SERVICE_BOOTSTRAP_SHA256;
  if (!/^[0-9a-f]{64}$/.test(expectedBootstrapSha256)) {
    throw new Error('managed service bootstrap integrity metadata is unavailable');
  }
  const actualBootstrapSha256 = createHash('sha256')
    .update(readFileSync(bootstrapPath))
    .digest('hex');
  if (actualBootstrapSha256 !== expectedBootstrapSha256) {
    throw new Error('managed service bootstrap integrity verification failed');
  }
  await verifyWindowsJobHost(jobHostPath, options);
  const nonce = randomBytes(32).toString('hex');
  const childArguments = [bootstrapPath, ...args];
  const configuration = windowsJobConfiguration(
    executable,
    childArguments,
    options,
    nonce,
  );
  const host = spawn(jobHostPath, [], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  host.on('error', () => {});
  // This pipe intentionally remains open for the Job Host's full lifetime.
  // Consume late EPIPE/error events; shutdown still fails closed through the
  // host exit code and bounded termination deadline.
  host.stdin?.on('error', () => {});
  const hostPid = Number(host.pid);
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || hostPid === process.pid) {
    try { host.kill('SIGKILL'); } catch { /* failed host never became owned */ }
    throw new Error('Windows Job Host did not publish a valid process identity');
  }
  return new Promise<ManagedProcessTreeLaunch>((resolve, reject) => {
    let settled = false;
    let phase: 'READY' | 'STARTED' = 'READY';
    let actualPid: number | undefined;
    let buffered = Buffer.alloc(0);
    let bufferedStderr = Buffer.alloc(0);
    let timeout: ReturnType<typeof setTimeout>;
    const stdout = host.stdout;
    if (!stdout || !host.stdin) {
      try { host.kill('SIGKILL'); } catch { /* host is already unavailable */ }
      reject(new Error('Windows Job Host control pipes are unavailable'));
      return;
    }
    const cleanupLaunchListeners = () => {
      clearTimeout(timeout);
      stdout.removeListener('data', onData);
      host.stderr?.removeListener('data', onStderr);
      host.removeListener('error', onError);
      host.removeListener('exit', onExit);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanupLaunchListeners();
      // A READY frame proves CreateProcess already returned and the suspended
      // runtime was atomically assigned to the Job. Do not reject until the
      // retained host either reports a queried-empty Job or is handed back to
      // the unified supervisor as an unconfirmed cleanup obligation.
      stdout.resume();
      host.stderr?.resume();
      const state: WindowsManagedJob = {
        nonce,
        actualPid,
        hostPid,
        graceMs: boundedWait(options.graceMs, DEFAULT_GRACE_MS),
        cleanupOnly: true,
      };
      windowsManagedJobs.set(host, state);
      try {
        if (host.stdin?.writable) {
          host.stdin.write(`STOP\t${nonce}\n`, 'utf8');
        }
      } catch {
        // The host exit status remains the only accepted drain proof.
      }
      const cleanupWaitMs = Math.min(
        45_000,
        state.graceMs + (2 * 5_000) + DEFAULT_FORCE_WAIT_MS,
      );
      const rejectRetained = () => {
        const cleanupError =
          'Windows Job Host launch cleanup was not confirmed as an empty Job';
        reject(new ManagedProcessTreeLaunchError(
          `${message}; ${cleanupError}`,
          {
            retained: {
              child: host,
              actualPid,
              hostPid,
              cleanupError,
            },
          },
        ));
      };
      if (
        __IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__
        && options.windowsForceLaunchCleanupTimeoutForTest
      ) {
        rejectRetained();
        return;
      }
      void waitForChildExit(host, cleanupWaitMs).then((exited) => {
        if (exited && windowsLaunchCleanupProved(host, actualPid)) {
          windowsManagedJobs.delete(host);
          reject(new ManagedProcessTreeLaunchError(message, {
            cleanedActualPid: actualPid,
          }));
          return;
        }
        rejectRetained();
      });
    };
    const succeed = () => {
      if (settled || actualPid === undefined) return;
      settled = true;
      stdout.pause();
      host.stderr?.pause();
      cleanupLaunchListeners();
      if (buffered.length) stdout.unshift(buffered);
      if (bufferedStderr.length) host.stderr?.unshift(bufferedStderr);
      armPausedStreamForConsumer(stdout);
      armPausedStreamForConsumer(host.stderr);
      const state: WindowsManagedJob = {
        nonce,
        actualPid,
        hostPid,
        graceMs: boundedWait(options.graceMs, DEFAULT_GRACE_MS),
        cleanupOnly: false,
      };
      windowsManagedJobs.set(host, state);
      resolve({
        child: host,
        actualPid,
        hostPid,
      });
    };
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffered.length + value.length > WINDOWS_JOB_HANDSHAKE_MAX_BYTES) {
        fail('Windows Job Host handshake exceeded its size limit');
        return;
      }
      buffered = Buffer.concat([buffered, value]);
      while (!settled) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const rawLine = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffered = buffered.subarray(newline + 1);
        try {
          if (phase === 'READY') {
            actualPid = parseHandshakeLine(rawLine, 'READY', nonce, hostPid);
            phase = 'STARTED';
            if (
              __IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__
              && options.windowsAbortAfterReadyForTest
            ) {
              fail('Windows Job Host launch aborted after READY for containment testing');
              return;
            }
            host.stdin?.write(`ACK\t${nonce}\n`, 'utf8', (error) => {
              if (error) fail('Windows Job Host acknowledgement failed');
            });
          } else {
            parseHandshakeLine(rawLine, 'STARTED', nonce, hostPid, actualPid);
            succeed();
          }
        } catch (error) {
          fail(errorMessage(error));
        }
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bufferedStderr.length + value.length > 4 * 1024) {
        fail('Windows Job Host diagnostic output exceeded its size limit');
        return;
      }
      // The runtime shares this pipe with the Job Host and can run immediately
      // after STARTED. Preserve any bytes that race ahead of the stdout
      // handshake so the supervisor receives each diagnostic exactly once.
      bufferedStderr = Buffer.concat([bufferedStderr, value]);
    };
    const onError = () => fail('Windows Job Host failed to start');
    const onExit = () => fail('Windows Job Host exited before the managed process started');
    stdout.on('data', onData);
    host.stderr?.on('data', onStderr);
    host.once('error', onError);
    host.once('exit', onExit);
    timeout = setTimeout(() => {
      fail(`Windows Job Host handshake exceeded ${WINDOWS_JOB_HANDSHAKE_TIMEOUT_MS}ms`);
    }, WINDOWS_JOB_HANDSHAKE_TIMEOUT_MS);
    timeout.unref?.();
    host.stdin.write(configuration, 'utf8', (error) => {
      if (error) fail('Windows Job Host configuration failed');
    });
  });
}

export async function spawnManagedProcessTree(
  executable: string,
  args: readonly string[],
  options: ManagedProcessTreeLaunchOptions,
): Promise<ManagedProcessTreeLaunch> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return launchWindowsManagedProcessTree(executable, args, options);
  }
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  };
  const child = spawn(executable, [...args], spawnOptions);
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    try { child.kill('SIGKILL'); } catch { /* invalid child is not retained */ }
    throw new Error('managed process did not publish a valid process identity');
  }
  return {
    child,
    actualPid: pid,
    hostPid: pid,
    processGroupId: pid,
  };
}

export function managedProcessActualPid(child: ChildProcess): number | undefined {
  const windowsJob = windowsManagedJobs.get(child);
  if (windowsJob) return windowsJob.actualPid;
  return (
    Number.isSafeInteger(child.pid) && Number(child.pid) > 0
      ? Number(child.pid)
      : undefined
  );
}

export function managedProcessHostPid(child: ChildProcess): number | undefined {
  const windowsJob = windowsManagedJobs.get(child);
  if (windowsJob) return windowsJob.hostPid;
  return (
    Number.isSafeInteger(child.pid) && Number(child.pid) > 0
      ? Number(child.pid)
      : undefined
  );
}

function unixProcessGroupExists(
  processGroupId: number,
  killProcess: (pid: number, signal: NodeJS.Signals | number) => boolean,
): boolean {
  try {
    return killProcess(-processGroupId, 0) !== false;
  } catch (error) {
    // EPERM means the group still exists even though the caller cannot signal
    // it. Only ESRCH proves that the retained group identity is vacant.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

async function waitForUnixProcessTreeExit(
  child: ChildProcess,
  processGroupId: number | null,
  timeoutMs: number,
  killProcess: (pid: number, signal: NodeJS.Signals | number) => boolean,
): Promise<{ rootExited: boolean; groupExited: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rootExited = !childIsAlive(child);
    const groupExited = processGroupId === null
      || !unixProcessGroupExists(processGroupId, killProcess);
    if (rootExited && groupExited) return { rootExited, groupExited };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { rootExited, groupExited };
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}

function signalOwnedUnixProcess(
  child: ChildProcess,
  processGroupId: number | null,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals | number) => boolean,
): { groupSignalled: boolean; directSignalled: boolean } {
  if (processGroupId !== null) {
    try {
      if (killProcess(-processGroupId, signal) !== false) {
        return { groupSignalled: true, directSignalled: false };
      }
    } catch {
      // The exact ChildProcess handle remains the safe fallback.
    }
  }
  if (!childIsAlive(child)) {
    return { groupSignalled: false, directSignalled: false };
  }
  try {
    return {
      groupSignalled: false,
      directSignalled: child.kill(signal),
    };
  } catch {
    return { groupSignalled: false, directSignalled: false };
  }
}

/**
 * Terminate one still-owned managed child.
 *
 * Windows sends a private stop command to the already-owned Job Host. The host
 * closes the runtime's private control pipe, waits its configured grace period,
 * terminates any remainder, and does not exit until the Job is empty. The only
 * forced fallback kills the exact retained host handle; no PID lookup, shell,
 * image-name match, wildcard, port lookup, or PATH search is permitted. Unix
 * targets the retained app-owned detached process group even after its root
 * process has exited. A detached root's PID is also its POSIX group ID.
 */
const activeTerminations = new WeakMap<
  ChildProcess,
  Promise<ManagedProcessTreeTerminationResult>
>();

async function terminateManagedProcessTreeOnce(
  child: ChildProcess,
  ownsChild: () => boolean,
  options: ManagedProcessTreeTerminationOptions = {},
): Promise<ManagedProcessTreeTerminationResult> {
  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const childPid = Number(child.pid);
  const detachedProcessGroup = platform !== 'win32'
    && options.detachedProcessGroup === true;
  const requestedProcessGroupId = options.ownedProcessGroupId ?? childPid;
  const processGroupId = detachedProcessGroup
    && Number.isSafeInteger(requestedProcessGroupId)
    && requestedProcessGroupId > 0
    && requestedProcessGroupId === childPid
    ? requestedProcessGroupId
    : null;
  const forceWaitMs = boundedWait(options.forceWaitMs, DEFAULT_FORCE_WAIT_MS);

  if (platform === 'win32') {
    let owned = false;
    try { owned = ownsChild(); } catch { owned = false; }
    const job = windowsManagedJobs.get(child);
    const validActualIdentity = job?.cleanupOnly === true
      ? (
          job.actualPid === undefined
          || (
            Number.isSafeInteger(job.actualPid)
            && Number(job.actualPid) > 0
            && job.actualPid !== childPid
          )
        )
      : (
          Number.isSafeInteger(job?.actualPid)
          && Number(job?.actualPid) > 0
          && job?.actualPid !== childPid
        );
    const validHostIdentity =
      Number.isSafeInteger(childPid)
      && childPid > 0
      && childPid !== currentPid
      && job?.hostPid === childPid
      && validActualIdentity;
    if (!owned || !job || !validHostIdentity) {
      return {
        accepted: false,
        treeKillAttempted: false,
        treeKillSucceeded: false,
        fallbackDirectKill: false,
        exited: !childIsAlive(child),
        error: 'managed Windows process is not backed by its retained Job Host',
      };
    }
    if (!childIsAlive(child)) {
      const treeKillSucceeded = windowsJobHostReportedEmpty(child);
      return {
        accepted: true,
        treeKillAttempted: true,
        treeKillSucceeded,
        fallbackDirectKill: false,
        exited: true,
        ...(!treeKillSucceeded
          ? { error: 'Windows Job Host exited without confirming an empty Job' }
          : {}),
      };
    }

    let controlSent = false;
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`STOP\t${job.nonce}\n`, 'utf8');
        controlSent = true;
      }
    } catch {
      controlSent = false;
    }
    const gracefulWaitMs = Math.min(
      45_000,
      job.graceMs + (2 * 5_000) + forceWaitMs,
    );
    const gracefullyExited = await waitForChildExit(child, gracefulWaitMs);
    if (gracefullyExited) {
      const treeKillSucceeded = windowsJobHostReportedEmpty(child);
      return {
        accepted: true,
        treeKillAttempted: true,
        treeKillSucceeded,
        fallbackDirectKill: false,
        exited: true,
        ...(!treeKillSucceeded
          ? { error: 'Windows Job Host exited without confirming an empty Job' }
          : {}),
      };
    }

    let fallbackDirectKill = false;
    if (ownedChildPid(child, ownsChild, currentPid) === childPid) {
      try {
        fallbackDirectKill = child.kill('SIGKILL');
      } catch {
        fallbackDirectKill = false;
      }
    }
    const exited = await waitForChildExit(child, forceWaitMs);
    return {
      accepted: true,
      treeKillAttempted: true,
      // An abruptly killed host still closes the Job handle, but it cannot
      // report the stronger "queried empty" proof required by app shutdown.
      treeKillSucceeded: false,
      fallbackDirectKill,
      exited,
      error: controlSent
        ? 'Windows Job Host did not confirm an empty Job before its deadline'
        : 'Windows Job Host private stop control was unavailable',
    };
  }

  const pid = ownedChildPid(
    child,
    ownsChild,
    currentPid,
    processGroupId !== null,
  );
  if (pid === null) {
    return {
      accepted: false,
      treeKillAttempted: false,
      treeKillSucceeded: false,
      fallbackDirectKill: false,
      exited: !childIsAlive(child),
    };
  }

  const killProcess = options.killProcess
    ?? ((targetPid, signal) => process.kill(targetPid, signal));
  const graceful = signalOwnedUnixProcess(
    child,
    processGroupId,
    'SIGTERM',
    killProcess,
  );
  if (graceful.groupSignalled || graceful.directSignalled) {
    const gracefulExit = await waitForUnixProcessTreeExit(
      child,
      processGroupId,
      boundedWait(options.graceMs, DEFAULT_GRACE_MS),
      killProcess,
    );
    if (gracefulExit.rootExited && gracefulExit.groupExited) {
      return {
        accepted: true,
        treeKillAttempted: processGroupId !== null,
        treeKillSucceeded: processGroupId !== null,
        fallbackDirectKill: graceful.directSignalled,
        exited: true,
      };
    }
  } else {
    const alreadyExited = await waitForUnixProcessTreeExit(
      child,
      processGroupId,
      1,
      killProcess,
    );
    if (alreadyExited.rootExited && alreadyExited.groupExited) {
      return {
        accepted: true,
        treeKillAttempted: processGroupId !== null,
        treeKillSucceeded: processGroupId !== null,
        fallbackDirectKill: false,
        exited: true,
      };
    }
  }

  let forced = { groupSignalled: false, directSignalled: false };
  const stillOwnsRootOrGroup = ownedChildPid(
    child,
    ownsChild,
    currentPid,
    processGroupId !== null,
  );
  if (stillOwnsRootOrGroup === pid) {
    forced = signalOwnedUnixProcess(
      child,
      processGroupId,
      'SIGKILL',
      killProcess,
    );
  }
  const forcedExit = await waitForUnixProcessTreeExit(
    child,
    processGroupId,
    forceWaitMs,
    killProcess,
  );
  const exited = forcedExit.rootExited;
  const treeKillSucceeded = processGroupId !== null && forcedExit.groupExited;
  return {
    accepted: true,
    treeKillAttempted: processGroupId !== null,
    treeKillSucceeded,
    fallbackDirectKill: graceful.directSignalled || forced.directSignalled,
    exited,
    ...(!exited || (processGroupId !== null && !treeKillSucceeded)
      ? {
          error: !exited
            ? `managed process ${pid} did not exit`
            : `managed process group ${processGroupId} did not exit`,
        }
      : {}),
  };
}

export function terminateManagedProcessTree(
  child: ChildProcess,
  ownsChild: () => boolean,
  options: ManagedProcessTreeTerminationOptions = {},
): Promise<ManagedProcessTreeTerminationResult> {
  const active = activeTerminations.get(child);
  if (active) return active;
  const termination = terminateManagedProcessTreeOnce(child, ownsChild, options);
  activeTerminations.set(child, termination);
  const clear = () => {
    if (activeTerminations.get(child) === termination) {
      activeTerminations.delete(child);
    }
  };
  void termination.then(clear, clear);
  return termination;
}
