import {
  evaluateControlCenterCapabilities,
  type ControlCenterCapabilities,
} from '../../../idctl/src/api/controlCenterContract.ts';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface JsonResponse {
  status: number;
  body: Record<string, any>;
}

export interface UnifiedRuntimeContractSelftestResult {
  managerCapabilities: boolean;
  mcpCompareAndSet: boolean;
  controlStateCompareAndSet: boolean;
  controlEventIdempotency: boolean;
  brainLearnedControlEvent: boolean;
  brainLearnedSecondaryTeamEvent: boolean;
  brainListenerCursorAdvanced: boolean;
  brainMultiTeamCursors: boolean;
  brainTimelineReplaySafe: boolean;
  localAgentSpawn: boolean;
  localAgentPrivateLog: boolean;
  localAgentStop: boolean;
}

export interface ManagedLocalWorkerExpectation {
  id: string;
  name: string;
  port: number;
  pid: number;
}

export type InvalidManagerAdminProbe = 'anonymous' | 'wrong-bearer';

const INTENTIONALLY_INVALID_ADMIN_BEARER =
  'Bearer idacc-selftest-invalid-not-a-32-byte-base64url-token';

function isJsonRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function secretSafeResponseShape(response: JsonResponse): {
  httpStatus: number;
  bodyIsObject: boolean;
  bodyFieldCount: number;
} {
  const bodyIsObject = isJsonRecord(response.body);
  return {
    httpStatus: response.status,
    bodyIsObject,
    bodyFieldCount: bodyIsObject ? Object.keys(response.body).length : 0,
  };
}

async function requestJson(
  managerUrl: string,
  adminToken: string,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: Record<string, unknown>;
    expected: number[];
    timeoutMs?: number;
    team?: string;
    secretSafeError?: boolean;
  },
): Promise<JsonResponse> {
  const response = await fetch(new URL(path, managerUrl), {
    method: options.method ?? 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-id-admin': '1',
      'x-id-team': options.team ?? 'default',
      authorization: `Bearer ${adminToken}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    throw new Error(`runtime contract response exceeded 512 KiB for ${path}`);
  }
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, any> : {};
  } catch {
    throw new Error(`runtime contract response was not JSON for ${path}`);
  }
  if (!options.expected.includes(response.status)) {
    const diagnostic = options.secretSafeError
      ? JSON.stringify(secretSafeResponseShape({ status: response.status, body }))
      : JSON.stringify(body).slice(0, 800);
    throw new Error(
      `runtime contract request ${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: `
      + diagnostic,
    );
  }
  return { status: response.status, body };
}

/**
 * Probe only the managed worker's deliberately public liveness surface. This
 * helper has no credential parameter so the Manager's static admin bearer can
 * never be sent to a worker accidentally.
 */
export async function requestManagedWorkerAnonymousHealth(
  workerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonResponse> {
  const response = await fetchImpl(new URL('/health', workerUrl), {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json' },
  });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024) {
    throw new Error('packaged local worker anonymous health exceeded 16 KiB');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('application/json')) {
    throw new Error('packaged local worker anonymous health was not JSON');
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('packaged local worker anonymous health was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('packaged local worker anonymous health was not a JSON object');
  }
  const body = parsed as Record<string, any>;
  return { status: response.status, body };
}

export function managedWorkerAnonymousHealthIsMinimal(
  response: JsonResponse,
): boolean {
  if (
    !response.body
    || typeof response.body !== 'object'
    || Array.isArray(response.body)
  ) {
    return false;
  }
  const keys = Object.keys(response.body);
  return response.status === 200
    && keys.length === 1
    && keys[0] === 'status'
    && response.body.status === 'ok';
}

export function managedWorkerAnonymousHealthFailureSummary(
  response: JsonResponse,
): Record<string, unknown> {
  return {
    ...secretSafeResponseShape(response),
    reportsOk: isJsonRecord(response.body) && response.body.status === 'ok',
  };
}

/**
 * Exercise the managed Manager boundary without ever accepting the real admin
 * credential. The fixed wrong bearer cannot equal IDACC's 32-byte base64url
 * supervisor credential and is safe to expose in a test fixture.
 */
export async function requestManagerEndpointWithInvalidAdmin(
  managerUrl: string,
  path: string,
  probe: InvalidManagerAdminProbe,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonResponse> {
  const response = await fetchImpl(new URL(path, managerUrl), {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: {
      accept: 'application/json',
      ...(probe === 'wrong-bearer'
        ? {
            authorization: INTENTIONALLY_INVALID_ADMIN_BEARER,
            'x-id-admin': '1',
            'x-id-team': 'default',
          }
        : {}),
    },
  });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024) {
    throw new Error('packaged Manager authorization response exceeded 16 KiB');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('application/json')) {
    throw new Error('packaged Manager authorization response was not JSON');
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('packaged Manager authorization response was not valid JSON');
  }
  if (!isJsonRecord(parsed)) {
    throw new Error('packaged Manager authorization response was not a JSON object');
  }
  return { status: response.status, body: parsed };
}

export function managerEndpointRejectsInvalidAdmin(
  response: JsonResponse,
): boolean {
  return response.status === 401
    && isJsonRecord(response.body)
    && Object.keys(response.body).length === 1
    && response.body.error === 'authentication_required';
}

export function managerAuthorizationFailureSummary(
  response: JsonResponse,
): Record<string, unknown> {
  return {
    ...secretSafeResponseShape(response),
    reportsAuthenticationRequired: (
      isJsonRecord(response.body)
      && response.body.error === 'authentication_required'
    ),
  };
}

async function requireManagerEndpointAuthorization(
  managerUrl: string,
  path: string,
  label: string,
): Promise<void> {
  for (const probe of ['anonymous', 'wrong-bearer'] as const) {
    const response = await requestManagerEndpointWithInvalidAdmin(
      managerUrl,
      path,
      probe,
    );
    if (!managerEndpointRejectsInvalidAdmin(response)) {
      throw new Error(
        `packaged Manager ${label} did not reject ${probe} access: `
        + JSON.stringify(managerAuthorizationFailureSummary(response)),
      );
    }
  }
}

/**
 * Manager performs its status probe with the target worker's current
 * generation-bound credential. Pair that proof with the admin-authenticated
 * durable row before and after the probe so a concurrent replacement cannot
 * pair one generation's persisted identity with another generation's liveness.
 */
export function managedWorkerLifecycleAttestationMatches(
  detailBeforeResponse: JsonResponse,
  statusResponse: JsonResponse,
  detailAfterResponse: JsonResponse,
  expected: ManagedLocalWorkerExpectation,
): boolean {
  if (
    detailBeforeResponse.status !== 200
    || statusResponse.status !== 200
    || detailAfterResponse.status !== 200
  ) {
    return false;
  }
  const detailBefore = detailBeforeResponse.body;
  const detailAfter = detailAfterResponse.body;
  const statusRows = isJsonRecord(statusResponse.body)
    && Array.isArray(statusResponse.body.agents)
    ? statusResponse.body.agents as Array<Record<string, any>>
    : [];
  const matchingStatusRows = statusRows.filter((candidate) => (
    isJsonRecord(candidate) && candidate.id === expected.id
  ));
  if (matchingStatusRows.length !== 1) return false;
  const status = matchingStatusRows[0];

  const matchesDurableIdentity = (candidate: Record<string, any>): boolean => (
    isJsonRecord(candidate)
    && candidate.id === expected.id
    && candidate.name === expected.name
    && candidate.alias === expected.name
    && candidate.status === 'running'
    && candidate.deploymentShape === 'local-process'
    && candidate.port === expected.port
    && candidate.pid === expected.pid
    && candidate.processOwner === 'manager-child'
    && Number.isInteger(candidate.processParentPid)
    && candidate.processParentPid > 0
    && typeof candidate.metadata?.processGeneration === 'string'
    && candidate.metadata.processGeneration.trim().length > 0
  );
  return matchesDurableIdentity(detailBefore)
    && matchesDurableIdentity(status)
    && matchesDurableIdentity(detailAfter)
    && detailBefore.metadata.processGeneration === status.metadata.processGeneration
    && status.metadata.processGeneration === detailAfter.metadata.processGeneration
    && status.isResponding === true;
}

export function managedWorkerAttestationSummary(
  detailBeforeResponse: JsonResponse,
  statusResponse: JsonResponse,
  detailAfterResponse: JsonResponse,
  expected: ManagedLocalWorkerExpectation,
): Record<string, unknown> {
  const statusRows = isJsonRecord(statusResponse.body)
    && Array.isArray(statusResponse.body.agents)
    ? statusResponse.body.agents as Array<Record<string, any>>
    : [];
  const summarize = (candidate: Record<string, any> | undefined) => isJsonRecord(candidate)
    ? {
        present: true,
        idMatches: candidate.id === expected.id,
        nameMatches: candidate.name === expected.name,
        aliasMatches: candidate.alias === expected.name,
        running: candidate.status === 'running',
        localProcess: candidate.deploymentShape === 'local-process',
        portMatches: candidate.port === expected.port,
        pidMatches: candidate.pid === expected.pid,
        managerChild: candidate.processOwner === 'manager-child',
        processParentPidPresent: (
          Number.isInteger(candidate.processParentPid)
          && candidate.processParentPid > 0
        ),
        processGenerationPresent: (
          typeof candidate.metadata?.processGeneration === 'string'
          && candidate.metadata.processGeneration.trim().length > 0
        ),
        ...(candidate.isResponding !== undefined
          ? { isResponding: candidate.isResponding === true }
          : {}),
      }
    : { present: false };
  const matchingStatuses = statusRows.filter((candidate) => (
    isJsonRecord(candidate) && candidate.id === expected.id
  ));
  const detailBeforeGeneration = isJsonRecord(detailBeforeResponse.body)
    ? detailBeforeResponse.body.metadata?.processGeneration
    : undefined;
  const statusGeneration = matchingStatuses.length === 1
    ? matchingStatuses[0].metadata?.processGeneration
    : undefined;
  const detailAfterGeneration = isJsonRecord(detailAfterResponse.body)
    ? detailAfterResponse.body.metadata?.processGeneration
    : undefined;
  return {
    detailBeforeHttpStatus: detailBeforeResponse.status,
    statusHttpStatus: statusResponse.status,
    detailAfterHttpStatus: detailAfterResponse.status,
    matchingStatusRows: matchingStatuses.length,
    detailBefore: summarize(detailBeforeResponse.body),
    status: summarize(matchingStatuses.length === 1 ? matchingStatuses[0] : undefined),
    detailAfter: summarize(detailAfterResponse.body),
    sameGeneration: (
      typeof detailBeforeGeneration === 'string'
      && detailBeforeGeneration.trim().length > 0
      && detailBeforeGeneration === statusGeneration
      && statusGeneration === detailAfterGeneration
    ),
  };
}

export function managedWorkerStopResponseIsExplicit(
  response: JsonResponse,
  expected: ManagedLocalWorkerExpectation,
): boolean {
  if (response.status !== 200 || response.body.ok !== true) return false;
  const result = response.body.result;
  if (
    !isJsonRecord(result)
    || result.action !== 'stopped'
    || result.name !== expected.name
    || typeof result.killed !== 'boolean'
    || !Array.isArray(result.pids)
    || !Number.isInteger(result.queriesCancelled)
    || result.queriesCancelled < 0
  ) {
    return false;
  }
  const pids = result.pids;
  if (
    pids.some((pid: unknown) => !Number.isInteger(pid) || Number(pid) <= 0)
    || new Set(pids).size !== pids.length
  ) {
    return false;
  }
  return result.killed === true
    ? pids.length === 1 && pids[0] === expected.pid
    : pids.length === 0;
}

const STOPPED_WORKER_FORBIDDEN_METADATA = [
  'pid',
  'processOwner',
  'processParentPid',
  'processInspectedAt',
  'processGeneration',
  'processRuntime',
  'processRuntimeLane',
  'managerOwnedLaunchIntent',
  'managerRestartRequested',
];

export function managedWorkerStoppedDetailMatches(
  response: JsonResponse,
  expected: ManagedLocalWorkerExpectation,
): boolean {
  if (response.status !== 200 || !isJsonRecord(response.body)) return false;
  const detail = response.body;
  const metadata = isJsonRecord(detail.metadata) ? detail.metadata : null;
  if (!metadata) return false;
  return detail.id === expected.id
    && detail.name === expected.name
    && detail.alias === expected.name
    && detail.status === 'stopped'
    && detail.deploymentShape === 'local-process'
    && detail.port === expected.port
    && detail.pid === null
    && detail.processOwner === null
    && detail.processParentPid === null
    && STOPPED_WORKER_FORBIDDEN_METADATA.every(
      (key) => !Object.hasOwn(metadata, key),
    );
}

export function managedWorkerStoppedDetailSummary(
  response: JsonResponse,
  expected: ManagedLocalWorkerExpectation,
): Record<string, unknown> {
  const detail = isJsonRecord(response.body) ? response.body : {};
  const metadata = isJsonRecord(detail.metadata) ? detail.metadata : {};
  return {
    httpStatus: response.status,
    idMatches: detail.id === expected.id,
    nameMatches: detail.name === expected.name,
    aliasMatches: detail.alias === expected.name,
    stopped: detail.status === 'stopped',
    localProcess: detail.deploymentShape === 'local-process',
    portMatches: detail.port === expected.port,
    pidCleared: detail.pid === null,
    processOwnerCleared: detail.processOwner === null,
    processParentPidCleared: detail.processParentPid === null,
    processMetadataCleared: STOPPED_WORKER_FORBIDDEN_METADATA.every(
      (key) => !Object.hasOwn(metadata, key),
    ),
  };
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function managedWorkerEndpointResponds(workerUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', workerUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(750),
      headers: { accept: 'application/json' },
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function loopbackPortIsBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const timeout = setTimeout(() => finish(false), 1_000);
    timeout.unref();

    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (server.listening) {
        server.close(() => resolve(available));
        return;
      }
      try { server.close(); } catch { /* not listening */ }
      resolve(available);
    };

    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      finish(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listenerCursorAdvancedFromRelay(
  response: JsonResponse,
  requiredSeq: number,
): boolean {
  if (response.status === 502) {
    if (
      response.body.error === 'brain_request_failed'
      && response.body.brain_status === 404
    ) {
      // The compatibility mirror does not exist until the first listener batch
      // has been durably acknowledged. Keep polling during that bounded race.
      return false;
    }
    throw new Error(
      'Brain listener cursor relay failed: '
      + JSON.stringify(response.body).slice(0, 800),
    );
  }
  const cursor = Number(response.body.body?.memory?.content);
  return Number.isSafeInteger(cursor) && cursor >= requiredSeq;
}

function readListenerCursorRegistry(dataDir: string): Record<string, any> | null {
  if (!dataDir) return null;
  const path = join(dataDir, 'brain', 'brain-listener-cursor.json');
  const maxBytes = 512 * 1024;
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return null;
    }
    throw new Error('packaged Brain listener cursor could not be inspected safely');
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size < 1
    || before.size > maxBytes
    || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
  ) {
    throw new Error('packaged Brain listener cursor is not a private bounded regular file');
  }

  let descriptor: number | undefined;
  let raw = '';
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > maxBytes
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
      || (
        before.dev !== 0
        && before.ino !== 0
        && (opened.dev !== before.dev || opened.ino !== before.ino)
      )
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('cursor changed while it was being checked');
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (
      offset > maxBytes
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)
    ) {
      throw new Error('cursor changed while it was being read');
    }
    raw = buffer.subarray(0, offset).toString('utf8');
  } catch {
    throw new Error('packaged Brain listener cursor could not be read safely');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }

  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    throw new Error('packaged Brain listener cursor is not valid JSON');
  }
}

/**
 * Exercise the behavior—not only the health endpoints—of the exact Manager and
 * Brain bundled into a production app. The temporary profile used by the caller
 * is discarded after the process exits.
 */
export async function runUnifiedRuntimeContractSelftest(
  managerUrl: string,
  adminToken: string,
): Promise<UnifiedRuntimeContractSelftestResult> {
  const marker = `${process.pid}-${Date.now().toString(36)}`;
  const capabilitiesResponse = await requestJson(managerUrl, adminToken, '/capabilities', {
    expected: [200],
  });
  const compatibility = evaluateControlCenterCapabilities(
    capabilitiesResponse.body as ControlCenterCapabilities,
    { exactSurface: true },
  );
  if (!compatibility.ready) {
    throw new Error(`bundled Manager capabilities do not match IDACC: ${compatibility.issues.join(', ')}`);
  }

  // Create a real second team before the longer lifecycle checks. This gives
  // the listener's bounded inventory refresh time to discover it before the
  // team-scoped event proof below.
  const secondaryTeamName = `idacc-selftest-${process.pid}-secondary`;
  const secondaryTeam = await requestJson(managerUrl, adminToken, '/teams', {
    method: 'POST',
    expected: [200],
    body: { name: secondaryTeamName },
  });
  const secondaryTeamId = String(secondaryTeam.body.id || '');
  if (!secondaryTeamId || secondaryTeam.body.name !== secondaryTeamName) {
    throw new Error(`bundled Manager did not create a stable secondary team: ${JSON.stringify(secondaryTeam.body)}`);
  }

  // Spawn one real local worker through the exact packaged Manager. Ollama is
  // used only as a no-credential harness selection; no model request is made.
  // This proves that the signed Electron executable can run the bundled worker
  // without a separately installed system Node, and that lifecycle operations
  // work on the current platform.
  const localAgentName = `idacc-local-selftest-${process.pid}`;
  const localSpawn = await requestJson(managerUrl, adminToken, '/agents/spawn', {
    method: 'POST',
    expected: [201],
    timeoutMs: 20_000,
    body: {
      name: localAgentName,
      runtime: 'ollama',
      local: true,
      start: true,
      metadata: { source: 'idacc-release-selftest' },
    },
  });
  const localAgentId = String(localSpawn.body.id || '');
  const localAgentPort = Number(localSpawn.body.port);
  const localAgentPid = Number(localSpawn.body.pid);
  const localAgentSpawn = localSpawn.body.status === 'running'
    && localAgentId.startsWith('agent_')
    && Number.isInteger(localAgentPort)
    && localAgentPort > 0
    && Number.isInteger(localAgentPid)
    && localAgentPid > 0;
  if (!localAgentSpawn) {
    throw new Error(`packaged Manager did not start a real local worker: ${JSON.stringify(localSpawn.body)}`);
  }
  const localHealthResponse = await requestManagedWorkerAnonymousHealth(
    `http://127.0.0.1:${localAgentPort}`,
  );
  if (!managedWorkerAnonymousHealthIsMinimal(localHealthResponse)) {
    throw new Error(
      'packaged local worker anonymous health was not minimal: '
      + JSON.stringify(managedWorkerAnonymousHealthFailureSummary(localHealthResponse)),
    );
  }
  const localAgentDetailPath = `/agents/${encodeURIComponent(localAgentId)}`;
  const localAgentStatusPath = '/agents/status?include_news=none';
  await requireManagerEndpointAuthorization(
    managerUrl,
    localAgentDetailPath,
    'worker detail endpoint',
  );
  await requireManagerEndpointAuthorization(
    managerUrl,
    localAgentStatusPath,
    'worker status endpoint',
  );
  const localAgentDetailBefore = await requestJson(
    managerUrl,
    adminToken,
    localAgentDetailPath,
    { expected: [200], secretSafeError: true },
  );
  const localAgentStatuses = await requestJson(managerUrl, adminToken, localAgentStatusPath, {
    expected: [200],
    secretSafeError: true,
  });
  const localAgentDetailAfter = await requestJson(
    managerUrl,
    adminToken,
    localAgentDetailPath,
    { expected: [200], secretSafeError: true },
  );
  const expectedManagedWorker = {
    id: localAgentId,
    name: localAgentName,
    port: localAgentPort,
    pid: localAgentPid,
  };
  if (!managedWorkerLifecycleAttestationMatches(
    localAgentDetailBefore,
    localAgentStatuses,
    localAgentDetailAfter,
    expectedManagedWorker,
  )) {
    throw new Error(
      'packaged local worker Manager attestation did not match: '
      + JSON.stringify(managedWorkerAttestationSummary(
        localAgentDetailBefore,
        localAgentStatuses,
        localAgentDetailAfter,
        expectedManagedWorker,
      )),
    );
  }
  const dataDir = process.env.IDACC_DATA_DIR?.trim() || '';
  const localLogPath = join(dataDir, 'logs', 'agents', `agent-${localAgentId.toLowerCase()}.log`);
  const localAgentPrivateLog = Boolean(dataDir)
    && existsSync(localLogPath)
    && (process.platform === 'win32' || (statSync(localLogPath).mode & 0o777) === 0o600);
  if (!localAgentPrivateLog) throw new Error('packaged local worker did not use a profile-private log');
  const localStop = await requestJson(managerUrl, adminToken, '/remote', {
    method: 'POST',
    expected: [200],
    body: { command: `/agent ${localAgentName} stop` },
  });
  const explicitStopAccepted = managedWorkerStopResponseIsExplicit(
    localStop,
    expectedManagedWorker,
  );
  let stoppedDetail: JsonResponse = { status: 0, body: {} };
  let originalProcessAlive = true;
  let workerEndpointResponding = true;
  let workerPortReleased = false;
  const stopDeadline = Date.now() + 8_000;
  do {
    stoppedDetail = await requestJson(
      managerUrl,
      adminToken,
      localAgentDetailPath,
      { expected: [200], secretSafeError: true },
    );
    originalProcessAlive = localProcessIsAlive(localAgentPid);
    workerEndpointResponding = await managedWorkerEndpointResponds(
      `http://127.0.0.1:${localAgentPort}`,
    );
    workerPortReleased = await loopbackPortIsBindable(localAgentPort);
    if (
      managedWorkerStoppedDetailMatches(stoppedDetail, expectedManagedWorker)
      && !originalProcessAlive
      && !workerEndpointResponding
      && workerPortReleased
    ) {
      break;
    }
    await delay(150);
  } while (Date.now() < stopDeadline);
  const localAgentStop = explicitStopAccepted
    && managedWorkerStoppedDetailMatches(stoppedDetail, expectedManagedWorker)
    && !originalProcessAlive
    && !workerEndpointResponding
    && workerPortReleased;
  if (!localAgentStop) {
    throw new Error(
      'packaged Manager did not converge its real local worker to a stopped state: '
      + JSON.stringify({
        explicitStopAccepted,
        reportedKilled: localStop.body.result?.killed === true,
        reportedExpectedPid: (
          Array.isArray(localStop.body.result?.pids)
          && localStop.body.result.pids.includes(localAgentPid)
        ),
        originalProcessAlive,
        workerEndpointResponding,
        workerPortReleased,
        stoppedDetail: managedWorkerStoppedDetailSummary(
          stoppedDetail,
          expectedManagedWorker,
        ),
      }),
    );
  }

  const agentId = `idacc_contract_${process.pid}`;
  const agentName = `idacc-contract-${process.pid}`;
  await requestJson(managerUrl, adminToken, '/agents/register', {
    method: 'POST',
    expected: [201],
    body: {
      id: agentId,
      name: agentName,
      endpoint: 'http://127.0.0.1:9',
      type: 'virtual',
      metadata: { source: 'idacc-release-selftest' },
    },
  });
  const fixtureServer = {
    name: 'idacc-contract-fixture',
    transport: 'stdio',
    command: 'idacc-selftest-not-executed',
    args: ['profile path with spaces'],
  };
  const attached = await requestJson(managerUrl, adminToken, `/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'POST',
    expected: [200],
    body: { servers: [fixtureServer], expectedServers: [] },
  });
  const conflict = await requestJson(managerUrl, adminToken, `/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'POST',
    expected: [409],
    body: { servers: [], expectedServers: [] },
  });
  const attachedSnapshot = Array.isArray(attached.body.mcpServers)
    ? attached.body.mcpServers
    : [];
  const detached = await requestJson(managerUrl, adminToken, `/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'POST',
    expected: [200],
    body: { servers: [], expectedServers: attachedSnapshot },
  });
  const mcpCompareAndSet = attached.body.needsRebuild === true
    && conflict.body.error === 'mcp_servers_changed'
    && JSON.stringify(conflict.body.currentServers) === JSON.stringify(attachedSnapshot)
    && attachedSnapshot.length === 1
    && typeof attachedSnapshot[0]?.connectionEnv === 'string'
    && !Object.hasOwn(attachedSnapshot[0] ?? {}, 'args')
    && Array.isArray(detached.body.mcpServers)
    && detached.body.mcpServers.length === 0;
  if (!mcpCompareAndSet) throw new Error('bundled Manager MCP compare-and-set behavior failed');

  const stateKey = `idacc-selftest-${marker}`;
  const created = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    method: 'POST',
    expected: [200],
    body: { value: { marker, state: 'created' }, expected_version: 0 },
  });
  const staleWrite = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    method: 'POST',
    expected: [409],
    body: { value: { marker, state: 'stale' }, expected_version: 0 },
  });
  const readBack = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    expected: [200],
  });
  const staleDelete = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    method: 'DELETE',
    expected: [409],
    body: { expected_version: 2 },
  });
  const afterStaleDelete = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    expected: [200],
  });
  const removed = await requestJson(managerUrl, adminToken, `/control/state/global/${encodeURIComponent(stateKey)}`, {
    method: 'DELETE',
    expected: [200],
    body: { expected_version: 1 },
  });
  const controlStateCompareAndSet = created.body.item?.version === 1
    && staleWrite.body.error === 'control_state_version_conflict'
    && readBack.body.item?.value?.state === 'created'
    && staleDelete.body.error === 'control_state_version_conflict'
    && afterStaleDelete.body.item?.value?.state === 'created'
    && removed.body.deleted === true;
  if (!controlStateCompareAndSet) throw new Error('bundled Manager control-state compare-and-set behavior failed');

  const idempotencyKey = `idacc:selftest:${marker}`;
  const controlEvent = {
    topic: 'control:action',
    subject: { kind: 'control-action', id: `release-selftest-${marker}` },
    actor: 'idacc-release-selftest',
    data: {
      subject: `IDACC release self-test ${marker}`,
      action: 'release.contract-selftest',
      data: { marker, outcome: 'verified' },
    },
    idempotency_key: idempotencyKey,
  };
  const accepted = await requestJson(managerUrl, adminToken, '/control-event', {
    method: 'POST',
    expected: [202],
    body: controlEvent,
  });
  const duplicate = await requestJson(managerUrl, adminToken, '/control-event', {
    method: 'POST',
    expected: [200],
    body: controlEvent,
  });
  const controlEventIdempotency = accepted.body.duplicate === false
    && Number.isInteger(accepted.body.seq)
    && duplicate.body.duplicate === true
    && duplicate.body.seq === accepted.body.seq;
  if (!controlEventIdempotency) throw new Error('bundled Manager control-event idempotency failed');

  const secondaryControlEvent = {
    topic: 'control:action',
    subject: { kind: 'control-action', id: `release-selftest-secondary-${marker}` },
    actor: 'idacc-release-selftest',
    data: {
      subject: `IDACC secondary-team release self-test ${marker}`,
      action: 'release.contract-selftest.secondary',
      data: { marker, outcome: 'verified', team_id: secondaryTeamId },
    },
    idempotency_key: `${idempotencyKey}:secondary`,
  };
  const secondaryAccepted = await requestJson(managerUrl, adminToken, '/control-event', {
    method: 'POST',
    expected: [202],
    team: secondaryTeamName,
    body: secondaryControlEvent,
  });
  const secondaryDuplicate = await requestJson(managerUrl, adminToken, '/control-event', {
    method: 'POST',
    expected: [200],
    team: secondaryTeamName,
    body: secondaryControlEvent,
  });
  if (
    secondaryAccepted.body.duplicate !== false
    || !Number.isInteger(secondaryAccepted.body.seq)
    || secondaryDuplicate.body.duplicate !== true
    || secondaryDuplicate.body.seq !== secondaryAccepted.body.seq
  ) {
    throw new Error('bundled Manager secondary-team event idempotency failed');
  }

  let brainLearnedControlEvent = false;
  let brainLearnedSecondaryTeamEvent = false;
  let brainListenerCursorAdvanced = false;
  let brainMultiTeamCursors = false;
  const learningDeadline = Date.now() + 25_000;
  while (
    !(
      brainLearnedControlEvent
      && brainLearnedSecondaryTeamEvent
      && brainListenerCursorAdvanced
      && brainMultiTeamCursors
    )
    && Date.now() < learningDeadline
  ) {
    const relayed = await requestJson(managerUrl, adminToken, '/control/brain', {
      method: 'POST',
      expected: [200],
      body: {
        method: 'GET',
        path: '/timeline?type=control%3Aaction&limit=50',
      },
    });
    const events = Array.isArray(relayed.body.body?.events) ? relayed.body.body.events : [];
    const matches = events.filter((event: Record<string, any>) => (
      Number(event?.data?.event_seq) === accepted.body.seq
      && event?.data?.action === 'release.contract-selftest'
      && event?.data?.team === 'default'
    ));
    brainLearnedControlEvent = matches.length === 1;
    const secondaryMatches = events.filter((event: Record<string, any>) => (
      Number(event?.data?.event_seq) === secondaryAccepted.body.seq
      && event?.data?.action === 'release.contract-selftest.secondary'
      && event?.data?.team === secondaryTeamName
      && event?.data?.teamId === secondaryTeamId
    ));
    brainLearnedSecondaryTeamEvent = secondaryMatches.length === 1;
    const cursor = await requestJson(managerUrl, adminToken, '/control/brain', {
      method: 'POST',
      expected: [200, 502],
      body: {
        method: 'GET',
        path: '/memory/brain-listener/event-cursor',
      },
    });
    brainListenerCursorAdvanced = listenerCursorAdvancedFromRelay(
      cursor,
      Number(accepted.body.seq),
    );
    const cursorRegistry = readListenerCursorRegistry(dataDir);
    const cursorTeams = Array.isArray(cursorRegistry?.teams) ? cursorRegistry.teams : [];
    const primaryCursor = cursorTeams.find((entry: Record<string, any>) => (
      entry?.id === cursorRegistry?.primaryTeam?.id
      && entry?.name === 'default'
      && Number(entry?.seq) >= Number(accepted.body.seq)
    ));
    const secondaryCursor = cursorTeams.find((entry: Record<string, any>) => (
      entry?.id === secondaryTeamId
      && entry?.name === secondaryTeamName
      && Number(entry?.seq) >= Number(secondaryAccepted.body.seq)
    ));
    brainMultiTeamCursors = cursorRegistry?.schemaVersion === 2
      && Boolean(primaryCursor)
      && Boolean(secondaryCursor)
      && primaryCursor.id !== secondaryCursor.id;
    if (
      !(
        brainLearnedControlEvent
        && brainLearnedSecondaryTeamEvent
        && brainListenerCursorAdvanced
        && brainMultiTeamCursors
      )
    ) {
      await delay(300);
    }
  }
  if (!brainLearnedControlEvent) {
    throw new Error('Brain listener did not learn the Manager control event exactly once');
  }
  if (!brainListenerCursorAdvanced) {
    throw new Error('Brain listener did not persist its durable Manager event cursor');
  }
  if (!brainLearnedSecondaryTeamEvent) {
    throw new Error('Brain listener did not learn the secondary-team Manager event exactly once');
  }
  if (!brainMultiTeamCursors) {
    throw new Error('Brain listener did not persist independent primary and secondary team cursors');
  }

  // Give the listener another poll round, then prove its append-only timeline
  // remains exactly-once after the durable checkpoint has settled.
  await delay(1_200);
  const replayProbe = await requestJson(managerUrl, adminToken, '/control/brain', {
    method: 'POST',
    expected: [200],
    body: {
      method: 'GET',
      path: '/timeline?type=control%3Aaction&limit=50',
    },
  });
  const replayEvents = Array.isArray(replayProbe.body.body?.events)
    ? replayProbe.body.body.events
    : [];
  const brainTimelineReplaySafe = replayEvents.filter((event: Record<string, any>) => (
    (
      Number(event?.data?.event_seq) === accepted.body.seq
      && event?.data?.action === 'release.contract-selftest'
      && event?.data?.team === 'default'
    )
    || (
      Number(event?.data?.event_seq) === secondaryAccepted.body.seq
      && event?.data?.action === 'release.contract-selftest.secondary'
      && event?.data?.teamId === secondaryTeamId
    )
  )).length === 2;
  if (!brainTimelineReplaySafe) {
    throw new Error('Brain listener replayed or lost a Manager event after checkpointing');
  }

  return {
    managerCapabilities: true,
    mcpCompareAndSet,
    controlStateCompareAndSet,
    controlEventIdempotency,
    brainLearnedControlEvent,
    brainLearnedSecondaryTeamEvent,
    brainListenerCursorAdvanced,
    brainMultiTeamCursors,
    brainTimelineReplaySafe,
    localAgentSpawn,
    localAgentPrivateLog,
    localAgentStop,
  };
}
