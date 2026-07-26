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
import { spawn, type ChildProcess } from 'node:child_process';
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
import { subscriptionRuntimeEnvironment } from './subscriptions.ts';
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
const COMPILED_RUNTIME_MANIFEST_SHA256 = typeof __IDACC_RUNTIME_MANIFEST_SHA256__ === 'string'
  ? __IDACC_RUNTIME_MANIFEST_SHA256__
  : '';

type ServiceName = UnifiedServiceName;
type ServicePhase = 'missing' | 'starting' | 'running' | 'unhealthy' | 'backoff' | 'fused' | 'stopping' | 'stopped';
type CompanionName = 'brain-listener' | 'brain-cycle';
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
  log?: WriteStream;
  watchdog?: ReturnType<typeof setInterval>;
  initialProbeTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
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
  terminationReason?: string;
  manualRestart: boolean;
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
  log?: WriteStream;
  watchdog?: ReturnType<typeof setInterval>;
  restartTimer?: ReturnType<typeof setTimeout>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  restartAttempts: number;
  crashTimes: number[];
  fuseUntil?: number;
  nextStartAt?: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastExit?: string;
  error?: string;
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
const HEALTH_TIMEOUT_MS = 1_500;
const MAX_HEALTH_BODY_BYTES = 64 * 1024;
const HEALTH_INTERVAL_MS = 5_000;
const INITIAL_HEALTH_DELAY_MS = 500;
const STARTUP_GRACE_MS = 12_000;
const HEALTH_FAILURE_LIMIT = 3;
const STABLE_RUNTIME_MS = 2 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 5;
const FUSE_COOLDOWN_MS = 5 * 60_000;
const COMPANION_WATCHDOG_MS = 5_000;
const CYCLE_INITIAL_DELAY_MS = 5 * 60_000;
const BRAIN_CYCLE_STATE_FILE = 'brain-cycle-state.json';

const services = new Map<ServiceName, ManagedService>();
const companions = new Map<CompanionName, ManagedCompanion>();
let profile: AppProfilePaths | null = null;
let stopping = false;
let startupPromise: Promise<UnifiedStackStatus> | null = null;
let companionStartPromise: Promise<void> | null = null;
let stackBrainToken: string | null = null;
let stackAdminToken: string | null = null;
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

function runtimeRoot(): string {
  const testRoot = process.env.IDACC_RUNTIME_ROOT?.trim();
  if (testRoot && !app.isPackaged) return resolve(testRoot);
  return app.isPackaged
    ? join(process.resourcesPath, 'idacc-runtime')
    : join(app.getAppPath(), 'resources', 'idacc-runtime');
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
    if (app.isPackaged && manifest.application.dirty) {
      return { error: 'runtime manifest was staged from a dirty application checkout' };
    }
    if (app.isPackaged && manifest.application.version !== app.getVersion()) {
      return {
        error: `runtime manifest targets application ${manifest.application.version}, not ${app.getVersion()}`,
      };
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
            AGENT_MANAGER_PORT: String(port),
            BRAIN_MCP_COMMAND: resolve(process.execPath),
            BRAIN_MCP_ARGS_JSON: JSON.stringify([resolve(root, 'brain', 'brain-mcp.mjs')]),
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

function clearServiceTimers(service: ManagedService): void {
  if (service.watchdog) clearInterval(service.watchdog);
  if (service.initialProbeTimer) clearTimeout(service.initialProbeTimer);
  if (service.restartTimer) clearTimeout(service.restartTimer);
  if (service.forceKillTimer) clearTimeout(service.forceKillTimer);
  service.watchdog = undefined;
  service.initialProbeTimer = undefined;
  service.restartTimer = undefined;
  service.forceKillTimer = undefined;
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
  if (companion.forceKillTimer) clearTimeout(companion.forceKillTimer);
  companion.watchdog = undefined;
  companion.restartTimer = undefined;
  companion.forceKillTimer = undefined;
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
      ...(name === 'brain-listener' && companion.statusPath && companion.instanceNonce ? {
        BRAIN_LISTENER_STATUS_FILE: companion.statusPath,
        BRAIN_LISTENER_INSTANCE_NONCE: companion.instanceNonce,
      } : {}),
    } : {}),
  };
  // The Manager bearer never crosses into Brain, agents, or app-owned Brain
  // companions. Companions need only the narrower Brain service credential.
  delete env.IDACC_ADMIN_TOKEN;
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
  const child = companion.child;
  const pid = child?.pid;
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

function handleCompanionTermination(
  companion: ManagedCompanion,
  child: ChildProcess,
  code: number | null,
  fallbackReason: string,
): void {
  if (companion.child !== child) return;
  companion.child = undefined;
  if (companion.watchdog) clearInterval(companion.watchdog);
  if (companion.forceKillTimer) clearTimeout(companion.forceKillTimer);
  companion.watchdog = undefined;
  companion.forceKillTimer = undefined;
  closeCompanionLog(companion, child);

  const now = Date.now();
  const reason = companion.terminationReason || fallbackReason;
  companion.terminationReason = undefined;
  companion.lastExit = `${new Date(now).toISOString()} — ${reason}`;
  companion.error = code === 0 ? undefined : reason;
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
      lastCompletedAt: code === 0 ? now : state.lastCompletedAt,
      lastExitCode: code ?? undefined,
    };
    try { writeCycleState(state); } catch (error) {
      companion.error = `could not persist Brain cycle state: ${errorMessage(error)}`;
    }
    companion.lastCompletedAt = state.lastCompletedAt;
    if (stopping || !companion.enabled) {
      companion.phase = companion.enabled ? 'stopped' : 'disabled';
      return;
    }
    scheduleCycle(companion, state);
    return;
  }

  if (stopping) {
    companion.phase = 'stopped';
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

async function launchCompanion(companion: ManagedCompanion): Promise<void> {
  if (
    stopping
    || !companion.enabled
    || isCompanionAlive(companion)
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
  try {
    child = spawn(process.execPath, [companion.entry], {
      cwd: companion.cwd,
      env: companionEnvironment(companion),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    closeCompanionLog(companion);
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
  companion.phase = companion.continuous ? 'starting' : 'running';
  if (companion.continuous) companion.lastStartedAt = Date.now();
  companion.error = undefined;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let terminalHandled = false;
  const terminal = (code: number | null, reason: string) => {
    if (terminalHandled) return;
    terminalHandled = true;
    handleCompanionTermination(companion, child, code, reason);
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

function terminateUnhealthyService(service: ManagedService, reason: string): void {
  const child = service.child;
  if (!child || !isChildAlive(service)) return;
  service.terminationReason = reason;
  service.phase = 'unhealthy';
  service.error = reason;
  try { child.kill('SIGTERM'); } catch { /* force timer below is the fallback */ }
  service.forceKillTimer = setTimeout(() => {
    if (service.child === child && isChildAlive(service)) {
      try { child.kill('SIGKILL'); } catch { /* process is already gone */ }
    }
  }, 4_000);
  service.forceKillTimer.unref?.();
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
      terminateUnhealthyService(
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

function handleServiceTermination(
  service: ManagedService,
  child: ChildProcess,
  fallbackReason: string,
): void {
  if (service.child !== child) return;
  service.child = undefined;
  if (service.watchdog) clearInterval(service.watchdog);
  if (service.initialProbeTimer) clearTimeout(service.initialProbeTimer);
  if (service.forceKillTimer) clearTimeout(service.forceKillTimer);
  service.watchdog = undefined;
  service.initialProbeTimer = undefined;
  service.forceKillTimer = undefined;
  closeServiceLog(service, child);

  const now = Date.now();
  const reason = service.terminationReason || fallbackReason;
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

async function launchService(service: ManagedService): Promise<void> {
  if (stopping || isChildAlive(service)) return;
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
  // The Manager bearer is a control-plane credential. Never let caller state
  // or generic environment inheritance expose it to Brain (or its agents).
  delete childEnv.IDACC_ADMIN_TOKEN;
  if (service.spec.name === 'manager' && stackAdminToken) {
    childEnv.IDACC_ADMIN_TOKEN = stackAdminToken;
  }
  if (service.spec.name === 'brain') {
    childEnv.BRAIN_EMBED_PHASE = '0';
    childEnv.BRAIN_SYNC_ONCHAIN = 'false';
    delete childEnv.BRAIN_SYNC_ONCHAIN_SCRIPT;
    delete childEnv.BRAIN_SQLITE_VEC_EXTENSION;
  }

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [service.spec.entry], {
      cwd: service.spec.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    closeServiceLog(service);
    service.error = `could not spawn service: ${errorMessage(error)}`;
    service.restartAttempts += 1;
    service.crashTimes = recentCrashes([...service.crashTimes, Date.now()], Date.now(), CRASH_WINDOW_MS);
    scheduleLaunch(service, restartDelayMs(service.restartAttempts), false);
    return;
  }

  service.child = child;
  service.phase = 'starting';
  service.lastStartedAt = Date.now();
  service.lastHealth = failedHealth('service is starting');
  service.lastHealthAt = undefined;
  service.healthFailures = 0;
  service.error = undefined;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let terminalHandled = false;
  const terminal = (reason: string) => {
    if (terminalHandled) return;
    terminalHandled = true;
    handleServiceTermination(service, child, reason);
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

async function startUnifiedStackInternal(paths: AppProfilePaths): Promise<UnifiedStackStatus> {
  if (services.size && !stopping) return unifiedStackStatus();
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

/** Check serialized main-process output without revealing either runtime bearer. */
export function unifiedStackPayloadContainsCredential(serialized: string): boolean {
  const payload = String(serialized);
  return [stackBrainToken, stackAdminToken].some(
    (credential) => Boolean(credential && credential.length >= 8 && payload.includes(credential)),
  );
}

/**
 * Positive control for stack self-tests: prove the leak detector recognizes
 * both live credentials while keeping their values inside this module.
 */
export function unifiedStackCredentialGuardSelftest(): boolean {
  const credentials = [stackBrainToken, stackAdminToken]
    .filter((credential): credential is string => Boolean(credential && credential.length >= 8));
  return credentials.length === 2
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

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(force);
      clearTimeout(giveUp);
      resolve();
    };
    child.once('exit', finish);
    child.once('error', finish);
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* process is already gone */ }
    }, 4_000);
    const giveUp = setTimeout(finish, 5_000);
    force.unref?.();
    giveUp.unref?.();
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

export async function stopUnifiedStack(): Promise<void> {
  stopping = true;
  const active: ChildProcess[] = [];
  for (const companion of companions.values()) {
    clearCompanionTimers(companion);
    companion.phase = 'stopping';
    companion.terminationReason = 'application shutdown';
    if (companion.child && isCompanionAlive(companion)) active.push(companion.child);
  }
  for (const service of services.values()) {
    clearServiceTimers(service);
    service.phase = 'stopping';
    service.terminationReason = 'application shutdown';
    if (service.reservation) {
      const reservation = service.reservation;
      service.reservation = undefined;
      await reservation.release();
    }
    if (service.child && isChildAlive(service)) active.push(service.child);
  }
  await Promise.all(active.map(waitForChildExit));
  for (const companion of companions.values()) {
    if (companion.child) closeCompanionLog(companion, companion.child);
    companion.child = undefined;
    companion.phase = companion.enabled ? 'stopped' : 'disabled';
  }
  for (const service of services.values()) {
    if (service.child) closeServiceLog(service, service.child);
    service.child = undefined;
    service.phase = 'stopped';
  }
  stackBrainToken = null;
  stackAdminToken = null;
  companionStartPromise = null;
  managerCompatibilityState = {
    ...evaluateControlCenterCapabilities(null, { exactSurface: true }),
    error: 'Manager compatibility has not been checked',
  };
  managerCompatibilityLastCheckedAt = 0;
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
  if (isChildAlive(service) && service.child) {
    service.manualRestart = true;
    service.terminationReason = 'manual restart';
    terminateUnhealthyService(service, 'manual restart');
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
  const running = isChildAlive(service);
  return {
    name: service.spec.name,
    url: service.spec.url,
    bundled: service.spec.bundled,
    running,
    healthy: running && health.healthy,
    identity: health.identity,
    identityVerified: health.identityVerified,
    phase: service.phase,
    pid: running ? service.child?.pid : undefined,
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
  const running = isCompanionAlive(companion);
  return {
    name: companion.name,
    enabled: companion.enabled,
    running,
    ...(companion.name === 'brain-listener' ? {
      healthy: running && companion.statusHealthy === true,
    } : {}),
    phase: companion.phase,
    pid: running ? companion.child?.pid : undefined,
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
