import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  defaultBrainAutomationSettings,
  normalizeBrainAutomationSettings,
  type BrainAutomationSettings,
} from '../../../idctl/src/settings/schema.ts';
import { loadSettings } from '../../../idctl/src/settings/store.ts';
import {
  evaluateControlCenterCapabilities,
  type ControlCenterCapabilities,
  type ControlCenterCompatibility,
} from '../../../idctl/src/api/controlCenterContract.ts';
import type { AppProfilePaths } from './appProfile.ts';
import { brainPlansDir } from './brainplans.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';
import {
  prepareManagerRuntimeProfile,
  type ManagerRuntimeProfile,
} from './runtimeProfile.ts';
import {
  createManagedProcessLaunchCoordinator,
  managedProcessTreeTerminationFailed,
  retainedManagedProcessTreeLaunchFailure,
  spawnManagedProcessTree,
  terminateManagedProcessTree,
} from './managedProcessTree.ts';
import { subscriptionRuntimeEnvironment } from './subscriptions.ts';
import { evaluateRuntimeApplicationVersionContract } from './runtimeApplicationVersion.ts';
import {
  manifestDigestMatches,
  parseRuntimeManifest,
  recentCrashes,
  restartDelayMs,
  readBrainListenerStatusFile,
  rotateServiceLog,
  shouldOpenCrashFuse,
  validateServiceHealth,
  canonicalLoopbackServiceUrl,
  verifyRuntimePayload,
  type HealthValidation,
  type RuntimeManifest,
  type UnifiedServiceName,
} from './unifiedStackPolicy.ts';

declare const __IDACC_RUNTIME_MANIFEST_SHA256__: string;
declare const __IDACC_REVIEW_BUILD__: boolean;
declare const __IDACC_SOURCE_PACKAGE_VERSION__: string;
declare const __IDACC_PACKAGED_APPLICATION_VERSION__: string;
const COMPILED_RUNTIME_MANIFEST_SHA256 = typeof __IDACC_RUNTIME_MANIFEST_SHA256__ === 'string'
  ? __IDACC_RUNTIME_MANIFEST_SHA256__
  : '';
const COMPILED_REVIEW_BUILD = typeof __IDACC_REVIEW_BUILD__ !== 'undefined'
  && __IDACC_REVIEW_BUILD__ === true;
const COMPILED_SOURCE_PACKAGE_VERSION =
  typeof __IDACC_SOURCE_PACKAGE_VERSION__ === 'string'
    ? __IDACC_SOURCE_PACKAGE_VERSION__
    : '';
const COMPILED_PACKAGED_APPLICATION_VERSION =
  typeof __IDACC_PACKAGED_APPLICATION_VERSION__ === 'string'
    ? __IDACC_PACKAGED_APPLICATION_VERSION__
    : '';

type ServiceName = UnifiedServiceName;
type ServicePhase = 'missing' | 'starting' | 'running' | 'unhealthy' | 'backoff' | 'fused' | 'stopping' | 'stopped';
type CompanionName = 'brain-listener' | 'brain-cycle' | 'brain-connector' | 'brain-backup';
type CompanionPhase = 'disabled' | 'waiting' | 'starting' | 'running' | 'unhealthy' | 'backoff' | 'fused' | 'stopping' | 'stopped';

export interface ServiceState {
  name: ServiceName;
  url: string;
  bundled: boolean;
  running: boolean;
  healthy: boolean;
  identity: HealthValidation['identity'];
  identityVerified: boolean;
  phase: ServicePhase;
  pid?: number;
  supervisorPid?: number;
  version?: string;
  serviceId?: string;
  expectedVersion?: string;
  reportedVersion?: string;
  protocolVersion?: string;
  restartCount: number;
  consecutiveHealthFailures: number;
  nextRestartAt?: string;
  fuseUntil?: string;
  lastStartedAt?: string;
  lastHealthAt?: string;
  lastExit?: string;
  error?: string;
}

export interface CompanionState {
  name: CompanionName;
  enabled: boolean;
  running: boolean;
  healthy?: boolean;
  phase: CompanionPhase;
  pid?: number;
  supervisorPid?: number;
  restartCount: number;
  nextStartAt?: string;
  fuseUntil?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessfulPollAt?: string;
  lastExit?: string;
  error?: string;
}

export interface BrainCatalogState {
  healthy: boolean;
  profileOwned: boolean;
  skillCount: number;
  error?: string;
}

export interface ManagerCompatibilityState extends ControlCenterCompatibility {
  checkedAt?: string;
  error?: string;
}

interface ServiceSpec {
  name: ServiceName;
  entry: string;
  cwd: string;
  url: string;
  port: number;
  serviceId?: string;
  expectedVersion?: string;
  bundled: boolean;
  env: Record<string, string>;
}

interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

interface ManagedService {
  spec: ServiceSpec;
  phase: ServicePhase;
  instanceNonce: string;
  reservation?: PortReservation;
  child?: ChildProcess;
  actualPid?: number;
  hostPid?: number;
  processGroupId?: number;
  log?: WriteStream;
  watchdog?: ReturnType<typeof setInterval>;
  initialProbeTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  probeInFlight: boolean;
  healthFailures: number;
  restartAttempts: number;
  crashTimes: number[];
  fuseUntil?: number;
  nextRestartAt?: number;
  lastStartedAt?: number;
  lastHealthAt?: number;
  lastHealth?: HealthValidation;
  lastExit?: string;
  error?: string;
  logError?: string;
  processTreeCleanupError?: string;
  terminationReason?: string;
  manualRestart: boolean;
  readyNotificationKey?: string;
}

interface ManagedCompanion {
  name: CompanionName;
  entry: string;
  cwd: string;
  enabled: boolean;
  continuous: boolean;
  phase: CompanionPhase;
  instanceNonce?: string;
  statusPath?: string;
  statusHealthy?: boolean;
  healthError?: string;
  lastSuccessfulPollAt?: string;
  child?: ChildProcess;
  actualPid?: number;
  hostPid?: number;
  processGroupId?: number;
  log?: WriteStream;
  watchdog?: ReturnType<typeof setInterval>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restartAttempts: number;
  crashTimes: number[];
  fuseUntil?: number;
  nextStartAt?: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastExit?: string;
  error?: string;
  processTreeCleanupError?: string;
  terminationReason?: string;
}

interface BrainCycleStateFile {
  schemaVersion: 1;
  cadenceMs: number;
  nextRunAt: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastExitCode?: number;
  lastRunId?: string;
}

const SERVICE_NAMES: readonly ServiceName[] = ['brain', 'manager'];
const MCP_CONNECTION_ENV_PREFIX = 'IDACC_MCP_CONNECTION_';
let managerMcpConnectionEnvironment: Record<string, string> = {};
const HEALTH_TIMEOUT_MS = 1_500;
const MAX_HEALTH_BODY_BYTES = 64 * 1024;
const HEALTH_INTERVAL_MS = 5_000;
const INITIAL_HEALTH_DELAY_MS = 500;
// A recovered consumer profile can contain dozens of locally managed agents.
// Manager restores the primary lead first and workers with bounded concurrency.
// Keep the watchdog active, but do not mistake that verified recovery pass for
// a hung Manager and repeatedly erase its progress by restarting it.
const STARTUP_GRACE_MS = 2 * 60_000;
const HEALTH_FAILURE_LIMIT = 3;
const STABLE_RUNTIME_MS = 2 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;
const FUSE_COOLDOWN_MS = 5 * 60_000;
const COMPANION_WATCHDOG_MS = 5_000;
const CYCLE_INITIAL_DELAY_MS = 5 * 60_000;
const BRAIN_CYCLE_STATE_FILE = 'brain-cycle-state.json';
const SERVICE_STOP_GRACE_MS = 20_000;
const COMPANION_STOP_GRACE_MS = 10_000;

const services = new Map<ServiceName, ManagedService>();
const companions = new Map<CompanionName, ManagedCompanion>();
export interface UnifiedStackServiceReadyEvent {
  name: UnifiedServiceName;
  url: string;
  pid: number;
  startedAt: number;
}
type UnifiedStackServiceReadyListener = (
  event: UnifiedStackServiceReadyEvent,
) => void | Promise<void>;
const serviceReadyListeners = new Set<UnifiedStackServiceReadyListener>();
const managedLaunches = createManagedProcessLaunchCoordinator();
let profile: AppProfilePaths | null = null;
let stopping = false;
let processTreeShutdownError: string | null = null;
let startupPromise: Promise<UnifiedStackStatus> | null = null;
let shutdownPromise: Promise<void> | null = null;
let shutdownInProgress = false;
let companionStartPromise: Promise<void> | null = null;
let stackBrainToken: string | null = null;
let stackAdminToken: string | null = null;
let stackManagerServiceToken: string | null = null;

/**
 * Supply encrypted-Settings MCP connections to the managed Manager as
 * process-local environment values. Agent rows store only stable references;
 * values are never written to the Manager database or service logs.
 */
export function configureUnifiedStackMcpConnections(environment: Record<string, string>): void {
  const next = Object.fromEntries(Object.entries(environment).filter(([key, value]) => (
    key.startsWith(MCP_CONNECTION_ENV_PREFIX)
    && /^[A-Z0-9_]+$/.test(key)
    && typeof value === 'string'
    && value.length <= 128 * 1024
  )));
  managerMcpConnectionEnvironment = next;
  const manager = services.get('manager');
  if (!manager) return;
  for (const key of Object.keys(manager.spec.env)) {
    if (key.startsWith(MCP_CONNECTION_ENV_PREFIX)) delete manager.spec.env[key];
  }
  Object.assign(manager.spec.env, next);
}
let brainAutomationSettings: BrainAutomationSettings = defaultBrainAutomationSettings();
let brainCatalogState: BrainCatalogState = {
  healthy: false,
  profileOwned: false,
  skillCount: 0,
  error: 'Brain skill catalog has not been checked',
};
let brainCatalogLastCheckedAt = 0;
let managerCompatibilityState: ManagerCompatibilityState = {
  ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
  error: 'Manager compatibility has not been checked',
};
let managerCompatibilityLastCheckedAt = 0;

function clearStackCredentials(): void {
  stackBrainToken = null;
  stackAdminToken = null;
  stackManagerServiceToken = null;
}

function serviceReadyEvent(service: ManagedService): UnifiedStackServiceReadyEvent | null {
  if (
    !isChildAlive(service)
    || service.lastHealth?.healthy !== true
    || !service.actualPid
    || !service.lastStartedAt
  ) {
    return null;
  }
  return {
    name: service.spec.name,
    url: service.spec.url,
    pid: service.actualPid,
    startedAt: service.lastStartedAt,
  };
}

function notifyServiceReady(service: ManagedService): void {
  const event = serviceReadyEvent(service);
  if (!event) return;
  const key = `${event.pid}:${event.startedAt}`;
  if (service.readyNotificationKey === key) return;
  service.readyNotificationKey = key;
  for (const listener of serviceReadyListeners) {
    try {
      void Promise.resolve(listener(event)).catch(() => {
        console.warn(`[unified-stack] ${event.name} ready listener failed`);
      });
    } catch {
      console.warn(`[unified-stack] ${event.name} ready listener failed`);
    }
  }
}

/**
 * Observe verified service generations, including supervised restarts. Each
 * subscriber receives at most one callback per service process and receives a
 * safe replay if it subscribes after the current generation became healthy.
 */
export function subscribeUnifiedStackServiceReady(
  listener: UnifiedStackServiceReadyListener,
): () => void {
  const seen = new Set<string>();
  let active = true;
  const invoke: UnifiedStackServiceReadyListener = (event) => {
    if (!active) return;
    const key = `${event.name}:${event.pid}:${event.startedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    return listener(event);
  };
  serviceReadyListeners.add(invoke);
  queueMicrotask(() => {
    if (!active) return;
    for (const service of services.values()) {
      const event = serviceReadyEvent(service);
      if (event) {
        try {
          void Promise.resolve(invoke(event)).catch(() => {
            console.warn(`[unified-stack] ${event.name} ready listener failed`);
          });
        } catch {
          console.warn(`[unified-stack] ${event.name} ready listener failed`);
        }
      }
    }
  });
  return () => {
    active = false;
    serviceReadyListeners.delete(invoke);
  };
}

function runtimeRoot(): string {
  const testRoot = process.env.IDACC_RUNTIME_ROOT?.trim();
  if (testRoot && !app.isPackaged) return resolve(testRoot);
  return app.isPackaged
    ? join(process.resourcesPath, 'idacc-runtime')
    : join(app.getAppPath(), 'resources', 'idacc-runtime');
}

function windowsJobHostPath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'native', 'idacc-job-host.exe')
    : join(app.getAppPath(), 'out', 'native', 'idacc-job-host.exe');
}

function managedServiceBootstrapPath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return app.isPackaged
    ? join(
        process.resourcesPath,
        'app.asar.unpacked',
        'out',
        'main',
        'managed-service-bootstrap.cjs',
      )
    : join(app.getAppPath(), 'out', 'main', 'managed-service-bootstrap.cjs');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedHealth(error: string): HealthValidation {
  return {
    healthy: false,
    identity: 'rejected',
    identityVerified: false,
    error,
  };
}

function serviceEntry(
  root: string,
  name: ServiceName,
  manifest?: RuntimeManifest,
): { entry: string; cwd: string } {
  const componentRoot = join(root, name);
  const declaredEntrypoint = manifest?.components[name].entrypoint;
  if (name === 'manager') {
    return {
      entry: join(componentRoot, declaredEntrypoint || 'dist/start-agent-manager.js'),
      cwd: componentRoot,
    };
  }
  return {
    entry: join(componentRoot, declaredEntrypoint || 'brain.mjs'),
    cwd: componentRoot,
  };
}

function readRuntimeManifest(root: string): { manifest?: RuntimeManifest; error?: string } {
  const path = join(root, 'manifest.json');
  try {
    if (!existsSync(path)) return { error: 'runtime manifest is not present in this build' };
    const raw = readFileSync(path);
    if (app.isPackaged && !manifestDigestMatches(raw, COMPILED_RUNTIME_MANIFEST_SHA256)) {
      return { error: 'runtime manifest does not match the manifest pinned into this application build' };
    }
    const manifest = parseRuntimeManifest(JSON.parse(raw.toString('utf8')));
    if (app.isPackaged && manifest.application.dirty && !COMPILED_REVIEW_BUILD) {
      return { error: 'runtime manifest was staged from a dirty application checkout' };
    }
    if (app.isPackaged) {
      const versionContract = evaluateRuntimeApplicationVersionContract({
        applicationVersion: app.getVersion(),
        compiledApplicationVersion: COMPILED_PACKAGED_APPLICATION_VERSION,
        compiledSourceVersion: COMPILED_SOURCE_PACKAGE_VERSION,
        manifestVersion: manifest.application.version,
        reviewBuild: COMPILED_REVIEW_BUILD,
      });
      if (!versionContract.ok) return { error: versionContract.error };
    }
    const payloadErrors = verifyRuntimePayload(root, manifest);
    if (payloadErrors.length) {
      return { error: `runtime payload verification failed: ${payloadErrors.join('; ')}` };
    }
    return { manifest };
  } catch (error) {
    return { error: `runtime manifest is invalid: ${errorMessage(error)}` };
  }
}

function reservePort(port = 0): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    const fail = (error: Error) => {
      server.removeAllListeners();
      try { server.close(); } catch { /* not listening */ }
      reject(error);
    };
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', fail);
      const address = server.address();
      if (!address || typeof address === 'string') {
        fail(new Error('could not reserve a loopback service port'));
        return;
      }
      server.unref();
      let released = false;
      resolve({
        port: address.port,
        release: () => new Promise<void>((releaseResolve) => {
          if (released || !server.listening) {
            released = true;
            releaseResolve();
            return;
          }
          released = true;
          server.close(() => releaseResolve());
        }),
      });
    });
  });
}

async function reserveRandomPort(): Promise<PortReservation> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await reservePort();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not reserve a loopback service port: ${errorMessage(lastError)}`);
}

function urlOverridesAllowed(): boolean {
  return process.env.IDACC_STACK_RANDOM_PORTS !== '1' && (
    process.env.IDACC_ALLOW_STACK_URL_OVERRIDE === '1'
    || Boolean(process.env.IDACC_STACK_SELFTEST)
  );
}

async function createManagedService(
  name: ServiceName,
  root: string,
  manifestResult: { manifest?: RuntimeManifest; error?: string },
  managerRuntimeProfile?: ManagerRuntimeProfile,
): Promise<ManagedService> {
  const entry = serviceEntry(root, name, manifestResult.manifest);
  const overrideVariable = name === 'manager' ? 'MANAGER_URL' : 'BRAIN_URL';
  let url = 'http://127.0.0.1:0';
  let port = 0;
  let reservation: PortReservation | undefined;
  let endpointError: string | undefined;
  try {
    if (urlOverridesAllowed() && process.env[overrideVariable]) {
      const requested = canonicalLoopbackServiceUrl(process.env[overrideVariable] as string);
      reservation = await reservePort(requested.port);
      url = requested.url;
      port = requested.port;
    } else {
      reservation = await reserveRandomPort();
      port = reservation.port;
      url = `http://127.0.0.1:${port}`;
    }
  } catch (error) {
    endpointError = `service endpoint is unavailable: ${errorMessage(error)}`;
  }

  const component = manifestResult.manifest?.components[name];
  const expectedVersion = component?.version;
  const entryPresent = existsSync(entry.entry);
  const bundled = entryPresent && Boolean(expectedVersion) && !manifestResult.error;
  const error = endpointError
    || manifestResult.error
    || (!entryPresent ? 'runtime is not present in this build' : undefined);
  return {
    spec: {
      name,
      ...entry,
      url,
      port,
      serviceId: component?.serviceId,
      expectedVersion,
      bundled,
      env: name === 'manager'
        ? {
            ...managerMcpConnectionEnvironment,
            AGENT_MANAGER_PORT: String(port),
            BRAIN_MCP_COMMAND: resolve(process.execPath),
            BRAIN_MCP_ARGS_JSON: JSON.stringify([resolve(root, 'brain', 'brain-mcp.mjs')]),
            // The unified consumer contract always ships Brain integration.
            // Ambient developer/launcher flags must not silently disable the
            // default attachment or context/control paths for another user.
            ID_AUTO_ATTACH_BRAIN_MCP: '1',
            BRAIN_CONTEXT_DISABLED: 'false',
            ...(managerRuntimeProfile ? {
              ID_LIBRARY_ROOT: managerRuntimeProfile.libraryRoot,
              ID_PLUGINS_ROOT: managerRuntimeProfile.pluginsRoot,
              IDACC_AGENT_LOG_DIR: managerRuntimeProfile.agentLogDir,
            } : {}),
          }
        : {
            BRAIN_PORT: String(port),
            // Organization-specific startup sync executables are intentionally
            // outside the consumer runtime. A host environment cannot activate
            // that missing or privileged path inside managed IDACC.
            BRAIN_SYNC_ONCHAIN: 'false',
            ...(managerRuntimeProfile ? {
              IDACC_SKILLS_DIR: managerRuntimeProfile.skillsRoot,
            } : {}),
          },
    },
    phase: bundled && !endpointError ? 'stopped' : 'missing',
    instanceNonce: randomBytes(24).toString('hex'),
    reservation,
    probeInFlight: false,
    healthFailures: 0,
    restartAttempts: 0,
    crashTimes: [],
    error,
    manualRestart: false,
  };
}

function isChildAlive(service: ManagedService): boolean {
  const child = service.child;
  return Boolean(
    child
    && typeof child.pid === 'number'
    && child.pid > 0
    && child.exitCode === null
    && child.signalCode === null,
  );
}

function processTreeTerminationOptions(processGroupId: number | undefined): {
  detachedProcessGroup?: boolean;
  ownedProcessGroupId?: number;
} {
  return processGroupId === undefined
    ? {}
    : {
        detachedProcessGroup: true,
        ownedProcessGroupId: processGroupId,
      };
}

function clearServiceTimers(service: ManagedService): void {
  if (service.watchdog) clearInterval(service.watchdog);
  if (service.initialProbeTimer) clearTimeout(service.initialProbeTimer);
  if (service.restartTimer) clearTimeout(service.restartTimer);
  service.watchdog = undefined;
  service.initialProbeTimer = undefined;
  service.restartTimer = undefined;
  service.nextRestartAt = undefined;
}

function closeServiceLog(service: ManagedService, child?: ChildProcess): void {
  if (child) {
    child.stdout?.unpipe(service.log);
    child.stderr?.unpipe(service.log);
  }
  const log = service.log;
  service.log = undefined;
  if (log && !log.destroyed) log.end();
}

function isCompanionAlive(companion: ManagedCompanion): boolean {
  const child = companion.child;
  return Boolean(
    child
    && typeof child.pid === 'number'
    && child.pid > 0
    && child.exitCode === null
    && child.signalCode === null,
  );
}

function clearCompanionTimers(companion: ManagedCompanion): void {
  if (companion.watchdog) clearInterval(companion.watchdog);
  if (companion.restartTimer) clearTimeout(companion.restartTimer);
  companion.watchdog = undefined;
  companion.restartTimer = undefined;
  companion.nextStartAt = undefined;
}

function closeCompanionLog(companion: ManagedCompanion, child?: ChildProcess): void {
  if (child) {
    child.stdout?.unpipe(companion.log);
    child.stderr?.unpipe(companion.log);
  }
  const log = companion.log;
  companion.log = undefined;
  if (log && !log.destroyed) log.end();
}

function rotateCompanionLog(companion: ManagedCompanion): void {
  if (!profile) return;
  try {
    rotateServiceLog(join(profile.logs, `${companion.name}.log`));
  } catch (error) {
    companion.error = `log retention failed: ${errorMessage(error)}`;
  }
}

function atomicPrivateJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to replace symbolic-link state file: ${path}`);
  }
  const leaf = path.split(/[\\/]/).pop() || 'state.json';
  const temporary = join(parent, `.${leaf}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best effort outside POSIX */ }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
  }
}

function cycleStatePath(): string {
  if (!profile) throw new Error('application profile is not initialized');
  return join(profile.brain, BRAIN_CYCLE_STATE_FILE);
}

function cycleCadenceMs(): number {
  const testCadence = process.env.IDACC_BRAIN_CYCLE_CADENCE_MS?.trim();
  if (process.env.IDACC_STACK_SELFTEST && testCadence) {
    const parsed = Number(testCadence);
    if (Number.isFinite(parsed) && parsed >= 50) return Math.floor(parsed);
  }
  return Math.round(brainAutomationSettings.cycleCadenceHours * 60 * 60 * 1000);
}

function cycleInitialDelayMs(): number {
  const testDelay = process.env.IDACC_BRAIN_CYCLE_INITIAL_DELAY_MS?.trim();
  if (process.env.IDACC_STACK_SELFTEST && testDelay) {
    const parsed = Number(testDelay);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return CYCLE_INITIAL_DELAY_MS;
}

function readCycleState(now = Date.now()): BrainCycleStateFile {
  const cadenceMs = cycleCadenceMs();
  const fallback: BrainCycleStateFile = {
    schemaVersion: 1,
    cadenceMs,
    nextRunAt: now + cycleInitialDelayMs(),
  };
  const path = cycleStatePath();
  if (!existsSync(path)) return fallback;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('cycle state is a symbolic link');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BrainCycleStateFile>;
    if (
      parsed.schemaVersion !== 1
      || !Number.isFinite(parsed.nextRunAt)
      || Number(parsed.nextRunAt) <= 0
    ) return fallback;
    return {
      schemaVersion: 1,
      cadenceMs,
      nextRunAt: Number(parsed.nextRunAt),
      lastStartedAt: Number.isFinite(parsed.lastStartedAt) ? Number(parsed.lastStartedAt) : undefined,
      lastCompletedAt: Number.isFinite(parsed.lastCompletedAt) ? Number(parsed.lastCompletedAt) : undefined,
      lastExitCode: Number.isInteger(parsed.lastExitCode) ? Number(parsed.lastExitCode) : undefined,
      lastRunId: typeof parsed.lastRunId === 'string' ? parsed.lastRunId.slice(0, 120) : undefined,
    };
  } catch {
    // Corrupt scheduler state is not trusted. Delay a fresh run instead of
    // potentially duplicating a cycle that completed before an interrupted write.
    return fallback;
  }
}

function writeCycleState(state: BrainCycleStateFile): void {
  atomicPrivateJson(cycleStatePath(), state);
}

function coreServicesReady(): boolean {
  return SERVICE_NAMES.every((name) => {
    const service = services.get(name);
    return Boolean(
      service
      && isChildAlive(service)
      && service.lastHealth?.healthy
      && service.lastHealth.identity !== 'rejected',
    );
  });
}

function companionEnvironment(companion: ManagedCompanion): NodeJS.ProcessEnv {
  const { name } = companion;
  const brain = services.get('brain');
  const manager = services.get('manager');
  const settings = loadSettings(profile?.config);
  const registeredRepoPaths = [...new Set((settings.projects ?? [])
    .map((project) => String(project.path ?? '').trim())
    .filter(Boolean)
    .map((path) => resolve(path))
    .filter((path) => {
      try { return existsSync(path) && statSync(path).isDirectory(); }
      catch { return false; }
    }))].slice(0, 12);
  const plansDir = brainPlansDir(settings.projectsRoot);
  const env: NodeJS.ProcessEnv = {
    ...externalChildEnvironment(),
    ELECTRON_RUN_AS_NODE: '1',
    IDACC_MANAGED_SERVICE: '1',
    IDACC_SERVICE_NAME: name,
    IDACC_PARENT_PID: String(process.pid),
    BRAIN_URL: brain?.spec.url ?? '',
    BRAIN_MCP_BASE_URL: brain?.spec.url ?? '',
    MANAGER_URL: manager?.spec.url ?? '',
    BRAIN_TOKEN: stackBrainToken ?? '',
    ID_TEAM: settings.defaultTeam || 'default',
    BRAIN_PLANS_DIR: plansDir,
    // Repository ingestion is allowed only for local folders that the consumer
    // explicitly registered as projects. Never digest the signed app/runtime.
    BRAIN_CYCLE_REPO_DIGEST: registeredRepoPaths.length ? '1' : '0',
    BRAIN_CYCLE_REPO_PATHS: '',
    BRAIN_CYCLE_REPO_PATHS_JSON: JSON.stringify(registeredRepoPaths),
    BRAIN_CYCLE_DIGEST_WORKSPACE_REPOS: '0',
    BRAIN_EMBED_PHASE: '0',
    BRAIN_SYNC_ONCHAIN: 'false',
    ...(profile ? {
      BRAIN_STATE_DIR: profile.brain,
      BRAIN_DB_PATH: join(profile.brain, 'brain.db'),
      BRAIN_LISTENER_CURSOR_FILE: join(profile.brain, 'brain-listener-cursor.json'),
      BRAIN_CONNECTORS_REGISTRY: join(dirname(profile.config), 'brain-connectors.json'),
      BRAIN_CONNECTOR_STATE_DIR: join(profile.brain, 'connectors'),
      IDACC_BRAIN_BACKUP_DIR: join(profile.root, 'backups', 'brain'),
      IDACC_BRAIN_BACKUP_KEEP_DAYS: '14',
      ...(name === 'brain-listener' && companion.statusPath && companion.instanceNonce ? {
        BRAIN_LISTENER_STATUS_FILE: companion.statusPath,
        BRAIN_LISTENER_INSTANCE_NONCE: companion.instanceNonce,
      } : {}),
    } : {}),
  };
  // App-owned control-plane credentials never come from ambient state.
  delete env.IDACC_ADMIN_TOKEN;
  delete env.IDACC_MANAGER_SERVICE_TOKEN;
  // Only the listener is a trusted Manager read client. The cycle and any
  // future generic companions must not inherit the base Manager service token.
  if (name === 'brain-listener' && stackManagerServiceToken) {
    env.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken;
  }
  delete env.BRAIN_SYNC_ONCHAIN_SCRIPT;
  delete env.BRAIN_CYCLE_REPO_PROJECT;
  delete env.BRAIN_SQLITE_VEC_EXTENSION;
  if (name !== 'brain-listener') {
    delete env.BRAIN_LISTENER_STATUS_FILE;
    delete env.BRAIN_LISTENER_INSTANCE_NONCE;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('BRAIN_CONSOLIDATION_')) delete env[key];
  }
  // Model-backed consolidation and native extension loading are not consumer
  // defaults and cannot be activated by a caller's shell environment.
  env.BRAIN_CONSOLIDATION_TAKES = '0';
  return env;
}

function refreshBrainListenerStatus(companion: ManagedCompanion): void {
  if (companion.name !== 'brain-listener') return;
  if (stopping || companion.phase === 'stopping') {
    companion.statusHealthy = false;
    companion.healthError = 'listener is stopping';
    return;
  }
  const pid = companion.actualPid;
  if (
    !isCompanionAlive(companion)
    || !Number.isInteger(pid)
    || Number(pid) <= 0
    || !companion.instanceNonce
    || !companion.statusPath
  ) {
    companion.statusHealthy = false;
    companion.healthError = 'listener process has not published a successful-poll status';
    return;
  }
  const options = {
    instanceNonce: companion.instanceNonce,
    pid: Number(pid),
  };
  let status = readBrainListenerStatusFile(companion.statusPath, options);
  if (status.error === 'listener status file changed while it was being checked') {
    status = readBrainListenerStatusFile(companion.statusPath, options);
  }
  companion.statusHealthy = status.healthy;
  if (status.lastSuccessfulPollAt) {
    companion.lastSuccessfulPollAt = status.lastSuccessfulPollAt;
  }
  companion.healthError = status.error;
  if (status.healthy) {
    companion.phase = 'running';
  } else if (companion.phase === 'running' || companion.phase === 'unhealthy') {
    companion.phase = 'unhealthy';
  } else {
    companion.phase = 'starting';
  }
}

function scheduleContinuousCompanion(
  companion: ManagedCompanion,
  delayMs: number,
  fused: boolean,
): void {
  if (stopping || !companion.enabled) return;
  if (companion.restartTimer) clearTimeout(companion.restartTimer);
  companion.phase = fused ? 'fused' : 'backoff';
  companion.nextStartAt = Date.now() + delayMs;
  companion.restartTimer = setTimeout(() => {
    companion.restartTimer = undefined;
    companion.nextStartAt = undefined;
    if (stopping || !coreServicesReady()) {
      companion.phase = 'waiting';
      return;
    }
    if (companion.fuseUntil && Date.now() < companion.fuseUntil) {
      scheduleContinuousCompanion(companion, companion.fuseUntil - Date.now(), true);
      return;
    }
    if (companion.fuseUntil) {
      companion.fuseUntil = undefined;
      companion.crashTimes = [];
      companion.restartAttempts = 0;
    }
    void launchCompanion(companion);
  }, Math.max(1, delayMs));
  companion.restartTimer.unref?.();
}

function scheduleCycle(companion: ManagedCompanion, requestedState?: BrainCycleStateFile): void {
  if (stopping || !companion.enabled || !profile) return;
  if (companion.restartTimer) clearTimeout(companion.restartTimer);
  const state = requestedState ?? readCycleState();
  if (!existsSync(cycleStatePath())) writeCycleState(state);
  const delayMs = Math.max(1, state.nextRunAt - Date.now());
  companion.phase = 'waiting';
  companion.nextStartAt = Date.now() + delayMs;
  companion.lastStartedAt = state.lastStartedAt;
  companion.lastCompletedAt = state.lastCompletedAt;
  companion.restartTimer = setTimeout(() => {
    companion.restartTimer = undefined;
    companion.nextStartAt = undefined;
    if (stopping || !companion.enabled) return;
    if (!coreServicesReady()) {
      scheduleCycle(companion, { ...readCycleState(), nextRunAt: Date.now() + 5_000 });
      return;
    }
    void launchCompanion(companion);
  }, delayMs);
  companion.restartTimer.unref?.();
}

async function handleCompanionTermination(
  companion: ManagedCompanion,
  child: ChildProcess,
  code: number | null,
  fallbackReason: string,
): Promise<void> {
  if (companion.child !== child) return;
  if (companion.watchdog) clearInterval(companion.watchdog);
  companion.watchdog = undefined;
  const processGroupId = companion.processGroupId;
  const requestedWindowsTreeKill = process.platform === 'win32';
  let processTreeError: string | undefined;
  if (processGroupId !== undefined || requestedWindowsTreeKill) {
    const result = await terminateManagedProcessTree(
      child,
      () => companion.child === child
        && (processGroupId === undefined || companion.processGroupId === processGroupId),
      processTreeTerminationOptions(processGroupId),
    );
    if (managedProcessTreeTerminationFailed(result, true)) {
      processTreeError = result.error || (processGroupId === undefined
        ? 'managed Windows process tree did not exit'
        : `managed process group ${processGroupId} did not exit`);
    }
  }
  if (companion.child !== child) return;
  companion.processTreeCleanupError = processTreeError;
  if (!processTreeError) {
    companion.child = undefined;
    companion.actualPid = undefined;
    companion.hostPid = undefined;
    companion.processGroupId = undefined;
  }
  closeCompanionLog(companion, child);

  const now = Date.now();
  const baseReason = companion.terminationReason || fallbackReason;
  const reason = processTreeError
    ? `${baseReason}; process-tree cleanup failed: ${processTreeError}`
    : baseReason;
  companion.terminationReason = undefined;
  companion.lastExit = `${new Date(now).toISOString()} — ${reason}`;
  companion.error = code === 0 && !processTreeError ? undefined : reason;
  if (companion.name === 'brain-listener') {
    companion.statusHealthy = false;
    companion.healthError = 'listener process is not running';
  }

  if (!companion.continuous) {
    let state = readCycleState(now);
    state = {
      ...state,
      cadenceMs: cycleCadenceMs(),
      nextRunAt: now + cycleCadenceMs(),
      lastStartedAt: companion.lastStartedAt,
      lastCompletedAt: code === 0 && !processTreeError ? now : state.lastCompletedAt,
      lastExitCode: processTreeError ? 1 : code ?? undefined,
    };
    try { writeCycleState(state); } catch (error) {
      companion.error = `could not persist Brain cycle state: ${errorMessage(error)}`;
    }
    companion.lastCompletedAt = state.lastCompletedAt;
    if (stopping || !companion.enabled) {
      companion.phase = companion.enabled ? 'stopped' : 'disabled';
      return;
    }
    if (processTreeError) {
      companion.phase = 'unhealthy';
      return;
    }
    scheduleCycle(companion, state);
    return;
  }

  if (stopping) {
    companion.phase = 'stopped';
    return;
  }
  if (processTreeError) {
    companion.phase = 'unhealthy';
    return;
  }
  if (companion.name === 'brain-connector' && code === 0) {
    // An empty connector registry is a valid state and the bundled runner has
    // no feed timers to keep it alive. Treat its clean no-op exit as a periodic
    // rescan, not as a crash, so newly registered connectors are discovered
    // without opening the restart fuse.
    companion.restartAttempts = 0;
    companion.crashTimes = [];
    companion.fuseUntil = undefined;
    companion.lastCompletedAt = now;
    companion.phase = 'waiting';
    scheduleContinuousCompanion(companion, 60_000, false);
    return;
  }
  companion.restartAttempts += 1;
  companion.crashTimes = recentCrashes([...companion.crashTimes, now], now, CRASH_WINDOW_MS);
  if (shouldOpenCrashFuse(companion.crashTimes, now, { limit: CRASH_LIMIT, windowMs: CRASH_WINDOW_MS })) {
    companion.fuseUntil = now + FUSE_COOLDOWN_MS;
    companion.error = `${reason}; restart fuse opened after ${companion.crashTimes.length} failures`;
    scheduleContinuousCompanion(companion, FUSE_COOLDOWN_MS, true);
    return;
  }
  scheduleContinuousCompanion(companion, restartDelayMs(companion.restartAttempts), false);
}

async function launchCompanionOnce(companion: ManagedCompanion): Promise<void> {
  if (
    stopping
    || !companion.enabled
    || isCompanionAlive(companion)
    || companion.child !== undefined
    || companion.processTreeCleanupError !== undefined
    || !profile
    || !coreServicesReady()
  ) return;
  if (companion.restartTimer) clearTimeout(companion.restartTimer);
  companion.restartTimer = undefined;
  companion.nextStartAt = undefined;
  if (!existsSync(companion.entry)) {
    companion.phase = 'disabled';
    companion.enabled = false;
    companion.error = 'companion entrypoint is not present in the verified runtime';
    return;
  }

  if (!companion.continuous) {
    const now = Date.now();
    const state = readCycleState(now);
    const runId = `${now}-${randomBytes(8).toString('hex')}`;
    // Reserve the cadence window before spawn. If the app or machine exits
    // mid-cycle, the next launch will not run the same window a second time.
    writeCycleState({
      ...state,
      cadenceMs: cycleCadenceMs(),
      nextRunAt: now + cycleCadenceMs(),
      lastStartedAt: now,
      lastRunId: runId,
    });
    companion.lastStartedAt = now;
  } else if (companion.name === 'brain-listener') {
    companion.instanceNonce = randomBytes(24).toString('hex');
    companion.statusHealthy = false;
    companion.healthError = 'listener status file is not present';
    companion.lastSuccessfulPollAt = undefined;
  }

  rotateCompanionLog(companion);
  let log: WriteStream;
  try {
    log = createWriteStream(join(profile.logs, `${companion.name}.log`), {
      flags: 'a',
      mode: 0o600,
    });
  } catch (error) {
    companion.error = `could not open companion log: ${errorMessage(error)}`;
    if (companion.continuous) {
      companion.restartAttempts += 1;
      scheduleContinuousCompanion(companion, restartDelayMs(companion.restartAttempts), false);
    } else {
      scheduleCycle(companion, { ...readCycleState(), nextRunAt: Date.now() + cycleCadenceMs() });
    }
    return;
  }
  companion.log = log;
  log.on('error', (error) => {
    companion.error = `companion log failed: ${errorMessage(error)}`;
  });

  let child: ChildProcess;
  let actualPid: number;
  let hostPid: number;
  let processGroupId: number | undefined;
  try {
    const launched = await spawnManagedProcessTree(process.execPath, [companion.entry], {
      cwd: companion.cwd,
      env: companionEnvironment(companion),
      graceMs: COMPANION_STOP_GRACE_MS,
      jobHostPath: windowsJobHostPath(),
      bootstrapPath: managedServiceBootstrapPath(),
    });
    child = launched.child;
    actualPid = launched.actualPid;
    hostPid = launched.hostPid;
    processGroupId = launched.processGroupId;
  } catch (error) {
    closeCompanionLog(companion);
    const retained = retainedManagedProcessTreeLaunchFailure(error);
    if (retained) {
      companion.child = retained.child;
      companion.actualPid = retained.actualPid;
      companion.hostPid = retained.hostPid;
      companion.processGroupId = undefined;
      companion.processTreeCleanupError = retained.cleanupError;
      companion.phase = 'unhealthy';
      companion.error =
        `could not spawn companion: ${errorMessage(error)}; replacement is blocked`;
      return;
    }
    companion.error = `could not spawn companion: ${errorMessage(error)}`;
    if (companion.continuous) {
      companion.restartAttempts += 1;
      scheduleContinuousCompanion(companion, restartDelayMs(companion.restartAttempts), false);
    } else {
      scheduleCycle(companion, { ...readCycleState(), nextRunAt: Date.now() + cycleCadenceMs() });
    }
    return;
  }

  companion.child = child;
  companion.actualPid = actualPid;
  companion.hostPid = hostPid;
  companion.processGroupId = processGroupId;
  companion.processTreeCleanupError = undefined;
  companion.phase = companion.continuous ? 'starting' : 'running';
  if (companion.continuous) companion.lastStartedAt = Date.now();
  companion.error = undefined;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let terminalHandled = false;
  const terminal = (code: number | null, reason: string) => {
    if (terminalHandled) return;
    terminalHandled = true;
    void handleCompanionTermination(companion, child, code, reason);
  };
  child.once('error', (error) => terminal(null, `spawn error: ${errorMessage(error)}`));
  child.once('exit', (code, signal) => terminal(
    code,
    signal ? `exited from signal ${signal}` : `exited with code ${code ?? 'unknown'}`,
  ));
  companion.watchdog = setInterval(() => {
    rotateCompanionLog(companion);
    refreshBrainListenerStatus(companion);
    if (!isCompanionAlive(companion) && companion.child === child) {
      terminal(child.exitCode, 'liveness watchdog observed a stopped companion');
    }
  }, COMPANION_WATCHDOG_MS);
  companion.watchdog.unref?.();
}

function launchCompanion(companion: ManagedCompanion): Promise<void> {
  return managedLaunches.run(companion, () => launchCompanionOnce(companion));
}

async function probeBrainSkillCatalog(): Promise<void> {
  const brain = services.get('brain');
  if (!brain || !isChildAlive(brain) || !brain.lastHealth?.healthy) return;
  if (brainCatalogState.healthy && Date.now() - brainCatalogLastCheckedAt < 60_000) return;
  brainCatalogLastCheckedAt = Date.now();
  try {
    const response = await fetch(`${brain.spec.url}/skills/index?limit=200`, {
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 2),
      headers: {
        accept: 'application/json',
        ...(stackBrainToken ? { authorization: `Bearer ${stackBrainToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`skill catalog returned HTTP ${response.status}`);
    const payload = await readBoundedJson(response) as {
      data?: { nodes?: Array<{ name?: string; skillId?: string }>; summary?: { idaccCatalogSkills?: number } };
      meta?: { source?: { authority?: string; idaccLibraryRows?: number } };
    };
    const nodes = Array.isArray(payload?.data?.nodes) ? payload.data.nodes : [];
    const source = payload?.meta?.source;
    const skillCount = Number(
      source?.idaccLibraryRows
      ?? payload?.data?.summary?.idaccCatalogSkills
      ?? nodes.length,
    );
    const hasBrainCore = nodes.some((node) => (
      String(node?.skillId || '').toLowerCase() === 'brain'
      || String(node?.name || '').toLowerCase() === 'brain'
    ));
    const profileOwned = source?.authority === 'idacc-library';
    if (!profileOwned || !Number.isFinite(skillCount) || skillCount < 1 || !hasBrainCore) {
      throw new Error('Brain did not index the profile-owned core skill catalog');
    }
    brainCatalogState = {
      healthy: true,
      profileOwned: true,
      skillCount,
    };
  } catch (error) {
    brainCatalogState = {
      healthy: false,
      profileOwned: false,
      skillCount: 0,
      error: errorMessage(error),
    };
  }
}

async function startBrainCompanionsIfReady(): Promise<void> {
  if (companionStartPromise) return companionStartPromise;
  companionStartPromise = (async () => {
    if (stopping || !profile || !coreServicesReady()) return;
    const managerCompatibility = await probeManagerCompatibility();
    if (!managerCompatibility.ready) return;
    await probeBrainSkillCatalog();
    const listener = companions.get('brain-listener');
    if (listener && listener.enabled && !isCompanionAlive(listener) && !listener.restartTimer) {
      await launchCompanion(listener);
    }
    const connector = companions.get('brain-connector');
    if (connector && connector.enabled && !isCompanionAlive(connector) && !connector.restartTimer) {
      await launchCompanion(connector);
    }
    const backup = companions.get('brain-backup');
    if (backup && backup.enabled && !isCompanionAlive(backup) && !backup.restartTimer) {
      await launchCompanion(backup);
    }
    const cycle = companions.get('brain-cycle');
    if (cycle) {
      cycle.enabled = brainAutomationSettings.cycleEnabled && existsSync(cycle.entry);
      if (!cycle.enabled) {
        clearCompanionTimers(cycle);
        cycle.phase = 'disabled';
      } else if (!isCompanionAlive(cycle) && !cycle.restartTimer) {
        scheduleCycle(cycle);
      }
    }
  })().finally(() => {
    companionStartPromise = null;
  });
  return companionStartPromise;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('health response did not contain a body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_HEALTH_BODY_BYTES) {
      await reader.cancel();
      throw new Error('health response exceeded the size limit');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
}

async function probeHealth(service: ManagedService): Promise<HealthValidation> {
  if (!isChildAlive(service)) return failedHealth('managed process is not running');
  try {
    const response = await fetch(`${service.spec.url}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-idacc-instance-nonce': service.instanceNonce,
      },
    });
    if (!response.ok) return failedHealth(`health endpoint returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) return failedHealth('health endpoint did not return JSON');
    const payload = await readBoundedJson(response);
    return validateServiceHealth(service.spec.name, payload, {
      expectedVersion: service.spec.expectedVersion,
      expectedServiceId: service.spec.serviceId,
      instanceNonce: service.instanceNonce,
      ownedProcess: isChildAlive(service),
      requireAttestation: app.isPackaged || process.env.IDACC_REQUIRE_RUNTIME_ATTESTATION === '1',
    });
  } catch (error) {
    return failedHealth(`health probe failed: ${errorMessage(error)}`);
  }
}

async function probeManagerCompatibility(force = false): Promise<ManagerCompatibilityState> {
  const manager = services.get('manager');
  if (!manager || !isChildAlive(manager) || !manager.lastHealth?.healthy) {
    managerCompatibilityState = {
      ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
      error: 'Bundled Manager is not healthy enough to verify its capability contract',
    };
    managerCompatibilityLastCheckedAt = 0;
    return managerCompatibilityState;
  }
  if (
    !force
    && managerCompatibilityLastCheckedAt
    && Date.now() - managerCompatibilityLastCheckedAt < 60_000
  ) {
    return managerCompatibilityState;
  }
  managerCompatibilityLastCheckedAt = Date.now();
  try {
    const response = await fetch(`${manager.spec.url}/capabilities`, {
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 2),
      headers: {
        accept: 'application/json',
        'x-id-admin': '1',
        ...(stackAdminToken ? { authorization: `Bearer ${stackAdminToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`capabilities endpoint returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) throw new Error('capabilities endpoint did not return JSON');
    const capabilities = await readBoundedJson(response) as ControlCenterCapabilities;
    const compatibility = evaluateControlCenterCapabilities(capabilities, { exactSurface: true });
    managerCompatibilityState = {
      ...compatibility,
      checkedAt: new Date().toISOString(),
      ...(compatibility.ready
        ? {}
        : { error: `Bundled Manager contract does not match this IDACC build: ${compatibility.issues.join(', ')}` }),
    };
  } catch (error) {
    managerCompatibilityState = {
      ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
      checkedAt: new Date().toISOString(),
      error: `Manager compatibility check failed: ${errorMessage(error)}`,
    };
  }
  return managerCompatibilityState;
}

function rotateActiveLog(service: ManagedService): void {
  if (!profile) return;
  try {
    rotateServiceLog(join(profile.logs, `${service.spec.name}.log`));
    service.logError = undefined;
  } catch (error) {
    service.logError = `log retention failed: ${errorMessage(error)}`;
  }
}

async function terminateUnhealthyService(service: ManagedService, reason: string): Promise<void> {
  const child = service.child;
  if (!child || !isChildAlive(service)) return;
  service.terminationReason = reason;
  service.phase = 'unhealthy';
  service.error = reason;
  const processGroupId = service.processGroupId;
  const result = await terminateManagedProcessTree(
    child,
    () => service.child === child && service.processGroupId === processGroupId,
    processTreeTerminationOptions(processGroupId),
  );
  const treeKillRequired = process.platform === 'win32' || processGroupId !== undefined;
  if (managedProcessTreeTerminationFailed(result, treeKillRequired) && service.child === child) {
    service.error = `${reason}; process-tree termination failed${result.error ? `: ${result.error}` : ''}`;
  }
}

async function watchdogTick(service: ManagedService, child: ChildProcess): Promise<void> {
  if (stopping || service.child !== child || !isChildAlive(service) || service.probeInFlight) return;
  service.probeInFlight = true;
  try {
    rotateActiveLog(service);
    const health = await probeHealth(service);
    if (service.child !== child || stopping) return;
    const now = Date.now();
    service.lastHealth = health;
    service.lastHealthAt = now;
    if (health.healthy) {
      service.healthFailures = 0;
      service.phase = 'running';
      service.error = service.logError;
      notifyServiceReady(service);
      if (service.lastStartedAt && now - service.lastStartedAt >= STABLE_RUNTIME_MS) {
        service.restartAttempts = 0;
        service.crashTimes = [];
      }
      void startBrainCompanionsIfReady();
      return;
    }
    service.error = health.error;
    if (service.lastStartedAt && now - service.lastStartedAt < STARTUP_GRACE_MS) {
      service.phase = 'starting';
      return;
    }
    service.healthFailures += 1;
    service.phase = 'unhealthy';
    if (service.healthFailures >= HEALTH_FAILURE_LIMIT) {
      await terminateUnhealthyService(
        service,
        `health watchdog restarted ${service.spec.name} after ${service.healthFailures} consecutive failures`,
      );
    }
  } finally {
    service.probeInFlight = false;
  }
}

function scheduleLaunch(service: ManagedService, delayMs: number, fused: boolean): void {
  if (stopping) return;
  if (service.restartTimer) clearTimeout(service.restartTimer);
  service.phase = fused ? 'fused' : 'backoff';
  service.nextRestartAt = Date.now() + delayMs;
  service.restartTimer = setTimeout(() => {
    service.restartTimer = undefined;
    service.nextRestartAt = undefined;
    if (stopping) return;
    if (service.fuseUntil && Date.now() < service.fuseUntil) {
      scheduleLaunch(service, service.fuseUntil - Date.now(), true);
      return;
    }
    if (service.fuseUntil) {
      service.fuseUntil = undefined;
      service.crashTimes = [];
      service.restartAttempts = 0;
    }
    void launchService(service);
  }, Math.max(1, delayMs));
  service.restartTimer.unref?.();
}

async function handleServiceTermination(
  service: ManagedService,
  child: ChildProcess,
  fallbackReason: string,
): Promise<void> {
  if (service.child !== child) return;
  if (service.watchdog) clearInterval(service.watchdog);
  if (service.initialProbeTimer) clearTimeout(service.initialProbeTimer);
  service.watchdog = undefined;
  service.initialProbeTimer = undefined;
  const processGroupId = service.processGroupId;
  const requestedWindowsTreeKill = process.platform === 'win32';
  let processTreeError: string | undefined;
  if (processGroupId !== undefined || requestedWindowsTreeKill) {
    const result = await terminateManagedProcessTree(
      child,
      () => service.child === child
        && (processGroupId === undefined || service.processGroupId === processGroupId),
      processTreeTerminationOptions(processGroupId),
    );
    if (managedProcessTreeTerminationFailed(result, true)) {
      processTreeError = result.error || (processGroupId === undefined
        ? 'managed Windows process tree did not exit'
        : `managed process group ${processGroupId} did not exit`);
    }
  }
  if (service.child !== child) return;
  service.processTreeCleanupError = processTreeError;
  if (!processTreeError) {
    service.child = undefined;
    service.actualPid = undefined;
    service.hostPid = undefined;
    service.processGroupId = undefined;
  }
  closeServiceLog(service, child);

  const now = Date.now();
  const baseReason = service.terminationReason || fallbackReason;
  const reason = processTreeError
    ? `${baseReason}; process-tree cleanup failed: ${processTreeError}`
    : baseReason;
  const manualRestart = service.manualRestart;
  service.terminationReason = undefined;
  service.manualRestart = false;
  service.lastExit = `${new Date(now).toISOString()} — ${reason}`;
  service.lastHealth = failedHealth('managed process is not running');
  service.lastHealthAt = now;
  service.healthFailures = 0;
  service.error = reason;

  if (stopping) {
    service.phase = 'stopped';
    return;
  }
  if (processTreeError) {
    service.phase = 'unhealthy';
    return;
  }
  if (manualRestart) {
    service.restartAttempts = 0;
    service.crashTimes = [];
    service.fuseUntil = undefined;
    scheduleLaunch(service, 1, false);
    return;
  }

  const stable = Boolean(service.lastStartedAt && now - service.lastStartedAt >= STABLE_RUNTIME_MS);
  if (stable) {
    service.restartAttempts = 0;
    service.crashTimes = [];
  }
  service.restartAttempts += 1;
  service.crashTimes = recentCrashes([...service.crashTimes, now], now, CRASH_WINDOW_MS);
  if (shouldOpenCrashFuse(service.crashTimes, now, { limit: CRASH_LIMIT, windowMs: CRASH_WINDOW_MS })) {
    service.fuseUntil = now + FUSE_COOLDOWN_MS;
    service.error = `${reason}; restart fuse opened after ${service.crashTimes.length} failures`;
    scheduleLaunch(service, FUSE_COOLDOWN_MS, true);
    return;
  }
  scheduleLaunch(service, restartDelayMs(service.restartAttempts), false);
}

async function launchServiceOnce(service: ManagedService): Promise<void> {
  if (
    stopping
    || isChildAlive(service)
    || service.child !== undefined
    || service.processTreeCleanupError !== undefined
  ) return;
  if (service.restartTimer) clearTimeout(service.restartTimer);
  service.restartTimer = undefined;
  service.nextRestartAt = undefined;
  if (service.reservation) {
    const reservation = service.reservation;
    service.reservation = undefined;
    await reservation.release();
  }
  if (!service.spec.bundled || !profile || service.spec.port < 1) {
    service.phase = 'missing';
    service.error ||= 'runtime cannot be started from this build';
    return;
  }
  if (service.spec.name === 'manager' && !stackManagerServiceToken) {
    service.phase = 'unhealthy';
    service.error = 'managed Manager service credential is unavailable';
    return;
  }

  const logPath = join(profile.logs, `${service.spec.name}.log`);
  rotateActiveLog(service);
  let log: WriteStream;
  try {
    log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  } catch (error) {
    service.phase = 'backoff';
    service.error = `could not open service log: ${errorMessage(error)}`;
    service.restartAttempts += 1;
    scheduleLaunch(service, restartDelayMs(service.restartAttempts), false);
    return;
  }
  service.log = log;
  log.on('error', (error) => {
    service.logError = `service log failed: ${errorMessage(error)}`;
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...(service.spec.name === 'manager'
      ? subscriptionRuntimeEnvironment()
      : externalChildEnvironment()),
    ...service.spec.env,
    ELECTRON_RUN_AS_NODE: '1',
    IDACC_MANAGED_SERVICE: '1',
    IDACC_SERVICE_NAME: service.spec.name,
    IDACC_SERVICE_ID: service.spec.serviceId ?? '',
    IDACC_RUNTIME_VERSION: service.spec.expectedVersion ?? '',
    IDACC_INSTANCE_NONCE: service.instanceNonce,
    IDACC_PARENT_PID: String(process.pid),
    BRAIN_TOKEN: stackBrainToken ?? '',
  };
  if (profile) {
    childEnv.IDACC_DATA_DIR = profile.root;
    if (service.spec.name === 'manager') {
      // The consumer stack is always profile-local SQLite. A DATABASE_URL
      // inherited from a terminal, launcher, or developer shell must not move
      // Manager state into an unrelated PostgreSQL database.
      delete childEnv.DATABASE_URL;
      childEnv.SQLITE_PATH = join(profile.manager, 'id-agents.db');
      childEnv.AGENT_MANAGER_WORKDIR = profile.workspace;
      childEnv.ID_WORKSPACE_DIR = profile.workspace;
    } else {
      childEnv.BRAIN_STATE_DIR = profile.brain;
      childEnv.BRAIN_DB_PATH = join(profile.brain, 'brain.db');
    }
  }
  // Never reuse caller credentials. The app creates distinct per-run Manager
  // control and service-read credentials inside this module.
  delete childEnv.IDACC_ADMIN_TOKEN;
  delete childEnv.IDACC_MANAGER_SERVICE_TOKEN;
  if (service.spec.name === 'manager' && stackAdminToken) {
    childEnv.IDACC_ADMIN_TOKEN = stackAdminToken;
  }
  if (
    (service.spec.name === 'manager' || service.spec.name === 'brain')
    && stackManagerServiceToken
  ) {
    childEnv.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken;
  }
  if (service.spec.name === 'brain') {
    childEnv.BRAIN_EMBED_PHASE = '0';
    childEnv.BRAIN_SYNC_ONCHAIN = 'false';
    delete childEnv.BRAIN_SYNC_ONCHAIN_SCRIPT;
    delete childEnv.BRAIN_SQLITE_VEC_EXTENSION;
  }

  let child: ChildProcess;
  let actualPid: number;
  let hostPid: number;
  let processGroupId: number | undefined;
  try {
    const launched = await spawnManagedProcessTree(process.execPath, [service.spec.entry], {
      cwd: service.spec.cwd,
      env: childEnv,
      graceMs: SERVICE_STOP_GRACE_MS,
      jobHostPath: windowsJobHostPath(),
      bootstrapPath: managedServiceBootstrapPath(),
    });
    child = launched.child;
    actualPid = launched.actualPid;
    hostPid = launched.hostPid;
    processGroupId = launched.processGroupId;
  } catch (error) {
    closeServiceLog(service);
    const retained = retainedManagedProcessTreeLaunchFailure(error);
    if (retained) {
      service.child = retained.child;
      service.actualPid = retained.actualPid;
      service.hostPid = retained.hostPid;
      service.processGroupId = undefined;
      service.processTreeCleanupError = retained.cleanupError;
      service.phase = 'unhealthy';
      service.error =
        `could not spawn service: ${errorMessage(error)}; replacement is blocked`;
      return;
    }
    service.error = `could not spawn service: ${errorMessage(error)}`;
    service.restartAttempts += 1;
    service.crashTimes = recentCrashes([...service.crashTimes, Date.now()], Date.now(), CRASH_WINDOW_MS);
    scheduleLaunch(service, restartDelayMs(service.restartAttempts), false);
    return;
  }

  service.child = child;
  service.actualPid = actualPid;
  service.hostPid = hostPid;
  service.processGroupId = processGroupId;
  service.processTreeCleanupError = undefined;
  service.phase = 'starting';
  service.lastStartedAt = Date.now();
  service.lastHealth = failedHealth('service is starting');
  service.lastHealthAt = undefined;
  service.healthFailures = 0;
  service.error = undefined;
  service.readyNotificationKey = undefined;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let terminalHandled = false;
  const terminal = (reason: string) => {
    if (terminalHandled) return;
    terminalHandled = true;
    void handleServiceTermination(service, child, reason);
  };
  child.once('error', (error) => terminal(`spawn error: ${errorMessage(error)}`));
  child.once('exit', (code, signal) => terminal(
    signal ? `exited from signal ${signal}` : `exited with code ${code ?? 'unknown'}`,
  ));

  service.watchdog = setInterval(() => { void watchdogTick(service, child); }, HEALTH_INTERVAL_MS);
  service.watchdog.unref?.();
  service.initialProbeTimer = setTimeout(() => {
    service.initialProbeTimer = undefined;
    void watchdogTick(service, child);
  }, INITIAL_HEALTH_DELAY_MS);
  service.initialProbeTimer.unref?.();
}

function launchService(service: ManagedService): Promise<void> {
  return managedLaunches.run(service, () => launchServiceOnce(service));
}

async function startUnifiedStackInternal(paths: AppProfilePaths): Promise<UnifiedStackStatus> {
  if (shutdownInProgress) {
    throw new Error('cannot start the unified stack while shutdown is still in progress');
  }
  if (services.size && !stopping) return unifiedStackStatus();
  if (processTreeShutdownError) {
    throw new Error(
      `cannot start the unified stack while prior process-tree shutdown is unconfirmed: ${processTreeShutdownError}`,
    );
  }
  shutdownPromise = null;
  services.clear();
  companions.clear();
  profile = paths;
  stopping = false;
  brainAutomationSettings = normalizeBrainAutomationSettings(
    loadSettings(paths.config).brainAutomation,
  );
  brainCatalogState = {
    healthy: false,
    profileOwned: false,
    skillCount: 0,
    error: 'Brain skill catalog has not been checked',
  };
  brainCatalogLastCheckedAt = 0;
  managerCompatibilityState = {
    ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
    error: 'Manager compatibility has not been checked',
  };
  managerCompatibilityLastCheckedAt = 0;
  stackBrainToken = randomBytes(32).toString('base64url');
  stackAdminToken = randomBytes(32).toString('base64url');
  stackManagerServiceToken = randomBytes(32).toString('base64url');
  if (new Set([
    stackBrainToken,
    stackAdminToken,
    stackManagerServiceToken,
  ]).size !== 3) {
    clearStackCredentials();
    throw new Error('generated runtime credentials were not distinct');
  }
  const root = runtimeRoot();
  let manifestResult = readRuntimeManifest(root);
  let managerRuntimeProfile: ManagerRuntimeProfile | undefined;
  if (manifestResult.manifest && !manifestResult.error) {
    try {
      managerRuntimeProfile = prepareManagerRuntimeProfile(join(root, 'manager'), paths);
    } catch (error) {
      manifestResult = {
        error: `could not prepare the writable Manager profile: ${errorMessage(error)}`,
      };
    }
  }
  const prepared = await Promise.all(
    SERVICE_NAMES.map((name) => createManagedService(name, root, manifestResult, managerRuntimeProfile)),
  );
  for (const service of prepared) services.set(service.spec.name, service);
  const brainRoot = join(root, 'brain');
  const listenerEntry = join(brainRoot, 'brain-listener.mjs');
  const cycleEntry = join(brainRoot, 'brain-cycle.mjs');
  const connectorEntry = join(brainRoot, 'brain-connector-runner.mjs');
  const backupEntry = join(brainRoot, 'idacc-profile-backup.mjs');
  companions.set('brain-listener', {
    name: 'brain-listener',
    entry: listenerEntry,
    cwd: brainRoot,
    enabled: existsSync(listenerEntry) && !manifestResult.error,
    continuous: true,
    phase: existsSync(listenerEntry) && !manifestResult.error ? 'waiting' : 'disabled',
    statusPath: join(paths.brain, 'brain-listener-status.json'),
    statusHealthy: false,
    healthError: 'listener has not started',
    restartAttempts: 0,
    crashTimes: [],
    error: existsSync(listenerEntry) ? manifestResult.error : 'listener is not present in this build',
  });
  companions.set('brain-cycle', {
    name: 'brain-cycle',
    entry: cycleEntry,
    cwd: brainRoot,
    enabled: brainAutomationSettings.cycleEnabled && existsSync(cycleEntry) && !manifestResult.error,
    continuous: false,
    phase: brainAutomationSettings.cycleEnabled && existsSync(cycleEntry) && !manifestResult.error
      ? 'waiting'
      : 'disabled',
    restartAttempts: 0,
    crashTimes: [],
    error: existsSync(cycleEntry) ? manifestResult.error : 'cycle is not present in this build',
  });
  companions.set('brain-connector', {
    name: 'brain-connector',
    entry: connectorEntry,
    cwd: brainRoot,
    enabled: existsSync(connectorEntry) && !manifestResult.error,
    continuous: true,
    phase: existsSync(connectorEntry) && !manifestResult.error ? 'waiting' : 'disabled',
    restartAttempts: 0,
    crashTimes: [],
    error: existsSync(connectorEntry) ? manifestResult.error : 'connector is not present in this build',
  });
  companions.set('brain-backup', {
    name: 'brain-backup',
    entry: backupEntry,
    cwd: brainRoot,
    enabled: existsSync(backupEntry) && !manifestResult.error,
    continuous: true,
    phase: existsSync(backupEntry) && !manifestResult.error ? 'waiting' : 'disabled',
    restartAttempts: 0,
    crashTimes: [],
    error: existsSync(backupEntry) ? manifestResult.error : 'profile backup is not present in this build',
  });

  const manager = services.get('manager');
  const brain = services.get('brain');
  if (manager?.spec.port) process.env.MANAGER_URL = manager.spec.url;
  if (brain?.spec.port) {
    process.env.BRAIN_URL = brain.spec.url;
    process.env.IDACC_BRAIN_URL = brain.spec.url;
  }

  for (const name of SERVICE_NAMES) {
    const service = services.get(name);
    if (service) await launchService(service);
  }
  return unifiedStackStatus();
}

export function startUnifiedStack(paths: AppProfilePaths): Promise<UnifiedStackStatus> {
  if (startupPromise) return startupPromise;
  startupPromise = startUnifiedStackInternal(paths).finally(() => {
    startupPromise = null;
  });
  return startupPromise;
}

/** Main-process-only credential for the app-owned Manager transport. */
export function unifiedStackAdminToken(): string {
  if (!stackAdminToken) throw new Error('unified Manager admin credential is not available');
  return stackAdminToken;
}

export type UnifiedBrainRequestAccess = {
  origin: string;
  authorizationHeader: string;
};

/** Main-process-only Brain origin and bearer header; never expose through IPC. */
export function unifiedStackBrainRequestAccess(): UnifiedBrainRequestAccess {
  const brain = services.get('brain');
  if (!brain || !stackBrainToken) {
    throw new Error('unified Brain request credential is not available');
  }
  const endpoint = canonicalLoopbackServiceUrl(brain.spec.url);
  return {
    origin: endpoint.url,
    authorizationHeader: `Bearer ${stackBrainToken}`,
  };
}

export type UnifiedManagerServiceRequestAccess = {
  origin: string;
  authorizationHeader: string;
  serviceHeader: 'brain';
};

/** Main-process-only Brain service access to Manager's exact read allowlist. */
export function unifiedStackManagerServiceRequestAccess(): UnifiedManagerServiceRequestAccess {
  const manager = services.get('manager');
  if (!manager || !stackManagerServiceToken) {
    throw new Error('unified Manager service credential is not available');
  }
  const endpoint = canonicalLoopbackServiceUrl(manager.spec.url);
  return {
    origin: endpoint.url,
    authorizationHeader: `Bearer ${stackManagerServiceToken}`,
    serviceHeader: 'brain',
  };
}

/** Check serialized main-process output without revealing any runtime bearer. */
export function unifiedStackPayloadContainsCredential(serialized: string): boolean {
  const payload = String(serialized);
  return [stackBrainToken, stackAdminToken, stackManagerServiceToken].some(
    (credential) => Boolean(credential && credential.length >= 8 && payload.includes(credential)),
  );
}

/**
 * Positive control for stack self-tests: prove the leak detector recognizes
 * all live credentials while keeping their values inside this module.
 */
export function unifiedStackCredentialGuardSelftest(): boolean {
  const credentials = [stackBrainToken, stackAdminToken, stackManagerServiceToken]
    .filter((credential): credential is string => Boolean(credential && credential.length >= 8));
  return credentials.length === 3
    && new Set(credentials).size === 3
    && credentials.every((credential) => unifiedStackPayloadContainsCredential(`sentinel:${credential}`));
}

export async function configureUnifiedBrainAutomation(
  input: Partial<BrainAutomationSettings>,
): Promise<UnifiedStackStatus> {
  brainAutomationSettings = normalizeBrainAutomationSettings({
    ...brainAutomationSettings,
    ...input,
  });
  const cycle = companions.get('brain-cycle');
  if (cycle) {
    cycle.enabled = brainAutomationSettings.cycleEnabled && existsSync(cycle.entry);
    if (cycle.restartTimer) clearTimeout(cycle.restartTimer);
    cycle.restartTimer = undefined;
    cycle.nextStartAt = undefined;
    if (!cycle.enabled) {
      cycle.phase = isCompanionAlive(cycle) ? 'running' : 'disabled';
    } else if (!isCompanionAlive(cycle) && profile) {
      const state = {
        ...readCycleState(),
        cadenceMs: cycleCadenceMs(),
        nextRunAt: Date.now() + cycleInitialDelayMs(),
      };
      writeCycleState(state);
      scheduleCycle(cycle, state);
    }
  }
  return unifiedStackStatus();
}

async function stopUnifiedStackOnce(): Promise<void> {
  stopping = true;
  // A launch may already be waiting on the Windows Job Host handshake (or a
  // POSIX spawn microtask). Drain it before taking the owned-child snapshot.
  // Per-owner single flight also prevents two overlapping launches from
  // replacing the one retained child handle.
  await managedLaunches.drain();
  const retainedTerminationFailures: Array<{ label: string; error: string }> = [];
  const active: Array<{
    child: ChildProcess;
    ownsChild: () => boolean;
    label: string;
    processGroupId?: number;
    treeKillRequired: boolean;
  }> = [];
  for (const companion of companions.values()) {
    clearCompanionTimers(companion);
    companion.phase = 'stopping';
    companion.terminationReason = 'application shutdown';
    if (
      companion.processTreeCleanupError
      && (
        !companion.child
        || (
          process.platform !== 'win32'
          && !isCompanionAlive(companion)
          && companion.processGroupId === undefined
        )
      )
    ) {
      retainedTerminationFailures.push({
        label: companion.name,
        error: companion.processTreeCleanupError,
      });
    }
    if (
      companion.child
      && (
        isCompanionAlive(companion)
        || companion.processGroupId !== undefined
        || process.platform === 'win32'
      )
    ) {
      const child = companion.child;
      const processGroupId = companion.processGroupId;
      active.push({
        child,
        ownsChild: () => companion.child === child && companion.processGroupId === processGroupId,
        label: companion.name,
        processGroupId,
        treeKillRequired: process.platform === 'win32' || processGroupId !== undefined,
      });
    }
  }
  for (const service of services.values()) {
    clearServiceTimers(service);
    service.phase = 'stopping';
    service.terminationReason = 'application shutdown';
    if (
      service.processTreeCleanupError
      && (
        !service.child
        || (
          process.platform !== 'win32'
          && !isChildAlive(service)
          && service.processGroupId === undefined
        )
      )
    ) {
      retainedTerminationFailures.push({
        label: service.spec.name,
        error: service.processTreeCleanupError,
      });
    }
    if (service.reservation) {
      const reservation = service.reservation;
      service.reservation = undefined;
      await reservation.release();
    }
    if (
      service.child
      && (
        isChildAlive(service)
        || service.processGroupId !== undefined
        || process.platform === 'win32'
      )
    ) {
      const child = service.child;
      const processGroupId = service.processGroupId;
      active.push({
        child,
        ownsChild: () => service.child === child && service.processGroupId === processGroupId,
        label: service.spec.name,
        processGroupId,
        treeKillRequired: process.platform === 'win32' || processGroupId !== undefined,
      });
    }
  }
  const terminationResults = await Promise.all(active.map(async (entry) => ({
    label: entry.label,
    treeKillRequired: entry.treeKillRequired,
    result: await terminateManagedProcessTree(
      entry.child,
      entry.ownsChild,
      processTreeTerminationOptions(entry.processGroupId),
    ),
  })));
  const terminationFailures = terminationResults.filter(
    ({ result, treeKillRequired }) => managedProcessTreeTerminationFailed(result, treeKillRequired),
  );
  const terminationFailureByLabel = new Map<string, string>([
    ...terminationFailures.map(({ label, result }) => [
      label,
      result.error || 'managed process-tree termination could not be confirmed',
    ] as const),
    ...retainedTerminationFailures.map(({ label, error }) => [label, error] as const),
  ]);
  for (const companion of companions.values()) {
    if (companion.child) closeCompanionLog(companion, companion.child);
    const terminationError = terminationFailureByLabel.get(companion.name);
    companion.processTreeCleanupError = terminationError;
    if (!terminationError) {
      companion.child = undefined;
      companion.actualPid = undefined;
      companion.hostPid = undefined;
      companion.processGroupId = undefined;
    }
    companion.phase = companion.enabled ? 'stopped' : 'disabled';
  }
  for (const service of services.values()) {
    if (service.child) closeServiceLog(service, service.child);
    const terminationError = terminationFailureByLabel.get(service.spec.name);
    service.processTreeCleanupError = terminationError;
    if (!terminationError) {
      service.child = undefined;
      service.actualPid = undefined;
      service.hostPid = undefined;
      service.processGroupId = undefined;
    }
    service.phase = 'stopped';
  }
  clearStackCredentials();
  companionStartPromise = null;
  managerCompatibilityState = {
    ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
    error: 'Manager compatibility has not been checked',
  };
  managerCompatibilityLastCheckedAt = 0;
  if (terminationFailures.length || retainedTerminationFailures.length) {
    processTreeShutdownError = [
        ...terminationFailures.map(({ label, result }) => ({
          label,
          error: result.error,
        })),
        ...retainedTerminationFailures,
      ]
        .map(({ label, error }) => `${label}${error ? ` (${error})` : ''}`)
        .join(', ');
    throw new Error(`managed process-tree shutdown failed for ${processTreeShutdownError}`);
  }
  processTreeShutdownError = null;
}

export function stopUnifiedStack(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownInProgress = true;
  const attempt = stopUnifiedStackOnce();
  shutdownPromise = attempt;
  void attempt.then(
    () => {
      shutdownInProgress = false;
    },
    () => {
      shutdownInProgress = false;
      if (shutdownPromise === attempt) shutdownPromise = null;
    },
  );
  return attempt;
}

export async function restartUnifiedStackService(name: ServiceName): Promise<UnifiedStackStatus> {
  const service = services.get(name);
  if (!service) throw new Error(`unified service ${name} is not initialized`);
  if (!service.spec.bundled) throw new Error(service.error || `unified service ${name} is unavailable`);
  if (service.restartTimer) clearTimeout(service.restartTimer);
  service.restartTimer = undefined;
  service.nextRestartAt = undefined;
  service.fuseUntil = undefined;
  service.restartAttempts = 0;
  service.crashTimes = [];
  if (service.processTreeCleanupError) {
    throw new Error(
      `cannot restart ${name} while its prior process tree is unconfirmed: ${service.processTreeCleanupError}`,
    );
  }
  if (isChildAlive(service) && service.child) {
    service.manualRestart = true;
    service.terminationReason = 'manual restart';
    await terminateUnhealthyService(service, 'manual restart');
  } else {
    await launchService(service);
  }
  return unifiedStackStatus();
}

export interface UnifiedStackStatus {
  managed: boolean;
  profileRoot?: string;
  services: ServiceState[];
  companions: CompanionState[];
  brainCatalog: BrainCatalogState;
  managerCompatibility: ManagerCompatibilityState;
  brainAutomation: BrainAutomationSettings;
  ready: boolean;
}

function publicServiceState(service: ManagedService): ServiceState {
  const health = service.lastHealth ?? failedHealth('health has not been checked');
  const running = isChildAlive(service) && service.processTreeCleanupError === undefined;
  return {
    name: service.spec.name,
    url: service.spec.url,
    bundled: service.spec.bundled,
    running,
    healthy: running && health.healthy,
    identity: health.identity,
    identityVerified: health.identityVerified,
    phase: service.phase,
    pid: running ? service.actualPid : undefined,
    supervisorPid: running && service.hostPid !== service.actualPid
      ? service.hostPid
      : undefined,
    version: service.spec.expectedVersion,
    serviceId: service.spec.serviceId,
    expectedVersion: service.spec.expectedVersion,
    reportedVersion: health.reportedVersion,
    protocolVersion: health.protocolVersion,
    restartCount: service.restartAttempts,
    consecutiveHealthFailures: service.healthFailures,
    nextRestartAt: service.nextRestartAt ? new Date(service.nextRestartAt).toISOString() : undefined,
    fuseUntil: service.fuseUntil ? new Date(service.fuseUntil).toISOString() : undefined,
    lastStartedAt: service.lastStartedAt ? new Date(service.lastStartedAt).toISOString() : undefined,
    lastHealthAt: service.lastHealthAt ? new Date(service.lastHealthAt).toISOString() : undefined,
    lastExit: service.lastExit,
    error: service.error || service.logError || health.error,
  };
}

function publicCompanionState(companion: ManagedCompanion): CompanionState {
  const running =
    isCompanionAlive(companion) && companion.processTreeCleanupError === undefined;
  return {
    name: companion.name,
    enabled: companion.enabled,
    running,
    ...(companion.name === 'brain-listener' ? {
      healthy: running && companion.statusHealthy === true,
    } : {}),
    phase: companion.phase,
    pid: running ? companion.actualPid : undefined,
    supervisorPid: running && companion.hostPid !== companion.actualPid
      ? companion.hostPid
      : undefined,
    restartCount: companion.restartAttempts,
    nextStartAt: companion.nextStartAt ? new Date(companion.nextStartAt).toISOString() : undefined,
    fuseUntil: companion.fuseUntil ? new Date(companion.fuseUntil).toISOString() : undefined,
    lastStartedAt: companion.lastStartedAt ? new Date(companion.lastStartedAt).toISOString() : undefined,
    lastCompletedAt: companion.lastCompletedAt ? new Date(companion.lastCompletedAt).toISOString() : undefined,
    lastSuccessfulPollAt: companion.lastSuccessfulPollAt,
    lastExit: companion.lastExit,
    error: running
      ? companion.healthError || companion.error
      : companion.error || companion.healthError,
  };
}

export async function unifiedStackStatus(): Promise<UnifiedStackStatus> {
  const active = [...services.values()];
  await Promise.all(active.map(async (service) => {
    if (!isChildAlive(service) || service.probeInFlight) return;
    service.probeInFlight = true;
    try {
      const health = await probeHealth(service);
      service.lastHealth = health;
      service.lastHealthAt = Date.now();
      if (health.healthy) {
        service.phase = 'running';
        service.error = service.logError;
        notifyServiceReady(service);
      } else if (service.phase === 'running') {
        service.phase = 'unhealthy';
        service.error = health.error;
      }
    } finally {
      service.probeInFlight = false;
    }
  }));
  const managerCompatibility = await probeManagerCompatibility();
  await startBrainCompanionsIfReady();
  const managedListener = companions.get('brain-listener');
  if (managedListener) refreshBrainListenerStatus(managedListener);
  const publicServices = active.map(publicServiceState);
  const publicCompanions = [...companions.values()].map(publicCompanionState);
  const listener = publicCompanions.find((companion) => companion.name === 'brain-listener');
  return {
    managed: Boolean(profile),
    profileRoot: profile?.root,
    services: publicServices,
    companions: publicCompanions,
    brainCatalog: { ...brainCatalogState },
    managerCompatibility: { ...managerCompatibility },
    brainAutomation: { ...brainAutomationSettings },
    ready: publicServices.length === SERVICE_NAMES.length
      && publicServices.every((service) => (
        service.bundled
        && service.running
        && service.healthy
        && service.identity !== 'rejected'
      ))
      && managerCompatibility.ready
      && brainCatalogState.healthy
      && Boolean(
        listener?.enabled
        && listener.running
        && listener.healthy
        && listener.phase === 'running',
      ),
  };
}
