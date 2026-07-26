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
    throw new Error(
      `runtime contract request ${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: `
      + JSON.stringify(body).slice(0, 800),
    );
  }
  return { status: response.status, body };
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
  const localHealthResponse = await fetch(`http://127.0.0.1:${localAgentPort}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json' },
  });
  const localHealth = await localHealthResponse.json() as Record<string, unknown>;
  if (
    !localHealthResponse.ok
    || localHealth.status !== 'ok'
    || localHealth.agent !== localAgentName
    || localHealth.agentId !== localAgentId
    || Number(localHealth.pid) !== localAgentPid
  ) {
    throw new Error(`packaged local worker health identity did not match: ${JSON.stringify(localHealth)}`);
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
  const localAgentStop = localStop.body.ok === true
    && localStop.body.result?.action === 'stopped'
    && Array.isArray(localStop.body.result?.pids)
    && localStop.body.result.pids.includes(localAgentPid);
  if (!localAgentStop) {
    throw new Error(`packaged Manager did not stop its real local worker: ${JSON.stringify(localStop.body)}`);
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
  const detached = await requestJson(managerUrl, adminToken, `/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'POST',
    expected: [200],
    body: { servers: [], expectedServers: [fixtureServer] },
  });
  const mcpCompareAndSet = attached.body.needsRebuild === true
    && conflict.body.error === 'mcp_servers_changed'
    && JSON.stringify(conflict.body.currentServers) === JSON.stringify([fixtureServer])
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
