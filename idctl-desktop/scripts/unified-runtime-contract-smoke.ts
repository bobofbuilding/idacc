import assert from 'node:assert/strict';
import {
  listenerCursorAdvancedFromRelay,
  managedWorkerAnonymousHealthFailureSummary,
  managedWorkerAnonymousHealthIsMinimal,
  managedWorkerAttestationSummary,
  managedWorkerLifecycleAttestationMatches,
  managedWorkerStopResponseIsExplicit,
  managedWorkerStoppedDetailMatches,
  managedWorkerStoppedDetailSummary,
  managerAuthorizationFailureSummary,
  managerEndpointRejectsInvalidAdmin,
  requestManagerEndpointWithInvalidAdmin,
  requestManagedWorkerAnonymousHealth,
} from '../src/main/unifiedRuntimeContractSelftest.ts';

assert.equal(listenerCursorAdvancedFromRelay({
  status: 200,
  body: { body: { memory: { content: '42' } } },
}, 42), true);
assert.equal(listenerCursorAdvancedFromRelay({
  status: 200,
  body: { body: { memory: { content: '41' } } },
}, 42), false);
assert.equal(listenerCursorAdvancedFromRelay({
  status: 200,
  body: { body: { memory: { content: 'not-a-cursor' } } },
}, 42), false);

assert.equal(listenerCursorAdvancedFromRelay({
  status: 502,
  body: { error: 'brain_request_failed', brain_status: 404 },
}, 42), false);

assert.throws(
  () => listenerCursorAdvancedFromRelay({
    status: 502,
    body: { error: 'brain_request_failed', brain_status: 401 },
  }, 42),
  /cursor relay failed/,
);
assert.throws(
  () => listenerCursorAdvancedFromRelay({
    status: 502,
    body: { error: 'brain_request_failed', brain_status: '404' },
  }, 42),
  /cursor relay failed/,
);
assert.throws(
  () => listenerCursorAdvancedFromRelay({
    status: 502,
    body: { error: 'brain_unavailable' },
  }, 42),
  /cursor relay failed/,
);

const healthRequests: Array<{ input: string; init?: RequestInit }> = [];
const anonymousHealth = await requestManagedWorkerAnonymousHealth(
  'http://127.0.0.1:45123',
  async (input, init) => {
    healthRequests.push({ input: String(input), init });
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
);
assert.deepEqual(anonymousHealth, {
  status: 200,
  body: { status: 'ok' },
});
assert.equal(healthRequests.length, 1);
assert.equal(healthRequests[0].input, 'http://127.0.0.1:45123/health');
assert.deepEqual(healthRequests[0].init?.headers, { accept: 'application/json' });
assert.equal(
  Object.keys(healthRequests[0].init?.headers as Record<string, string>)
    .some((key) => key.toLowerCase() === 'authorization' || key.toLowerCase().startsWith('x-id-')),
  false,
  'anonymous worker liveness probe must not send Manager or worker credentials',
);

assert.equal(managedWorkerAnonymousHealthIsMinimal(anonymousHealth), true);
assert.equal(managedWorkerAnonymousHealthIsMinimal({
  status: 200,
  body: {
    status: 'ok',
    agent: 'private-agent',
    agentId: 'agent_private',
    pid: 123,
  },
}), false, 'anonymous worker health must reject identity disclosure');
assert.equal(managedWorkerAnonymousHealthIsMinimal({
  status: 503,
  body: { status: 'ok' },
}), false);
assert.equal(managedWorkerAnonymousHealthIsMinimal({
  status: 200,
  body: { status: 'starting' },
}), false);
assert.equal(managedWorkerAnonymousHealthIsMinimal({
  status: 200,
  body: null as unknown as Record<string, unknown>,
}), false);

const secretMarker = 'secret-marker-must-never-appear';
const anonymousHealthFailureSummary = managedWorkerAnonymousHealthFailureSummary({
  status: 200,
  body: {
    status: 'ok',
    identity: secretMarker,
    [secretMarker]: 'also-private',
  },
});
assert.deepEqual(anonymousHealthFailureSummary, {
  httpStatus: 200,
  bodyIsObject: true,
  bodyFieldCount: 3,
  reportsOk: true,
});
assert.equal(
  JSON.stringify(anonymousHealthFailureSummary).includes(secretMarker),
  false,
  'anonymous health diagnostics must not include response keys or values',
);

const managerAuthorizationRequests: Array<{
  input: string;
  init?: RequestInit;
}> = [];
const managerAuthorizationFetch = async (input: string | URL | Request, init?: RequestInit) => {
  managerAuthorizationRequests.push({ input: String(input), init });
  return new Response(JSON.stringify({ error: 'authentication_required' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
};
for (const path of [
  '/agents/agent_release_selftest',
  '/agents/status?include_news=none',
]) {
  for (const probe of ['anonymous', 'wrong-bearer'] as const) {
    const denied = await requestManagerEndpointWithInvalidAdmin(
      'http://127.0.0.1:39100',
      path,
      probe,
      managerAuthorizationFetch,
    );
    assert.equal(
      managerEndpointRejectsInvalidAdmin(denied),
      true,
      `${path} must reject ${probe} Manager access`,
    );
  }
}
assert.equal(managerAuthorizationRequests.length, 4);
assert.deepEqual(
  managerAuthorizationRequests.map((request) => request.input),
  [
    'http://127.0.0.1:39100/agents/agent_release_selftest',
    'http://127.0.0.1:39100/agents/agent_release_selftest',
    'http://127.0.0.1:39100/agents/status?include_news=none',
    'http://127.0.0.1:39100/agents/status?include_news=none',
  ],
);
for (const request of [managerAuthorizationRequests[0], managerAuthorizationRequests[2]]) {
  assert.deepEqual(
    request.init?.headers,
    { accept: 'application/json' },
    'anonymous Manager probes must carry no principal headers',
  );
}
for (const request of [managerAuthorizationRequests[1], managerAuthorizationRequests[3]]) {
  const headers = request.init?.headers as Record<string, string>;
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['x-id-admin'], '1');
  assert.equal(headers['x-id-team'], 'default');
  assert.match(headers.authorization, /^Bearer idacc-selftest-invalid-/);
  assert.equal(
    JSON.stringify(headers).includes('consumer-real-admin-token-never-sent'),
    false,
    'wrong-bearer probes must never derive from the real admin credential',
  );
  assert.equal(
    Object.keys(headers).some((key) => (
      key.toLowerCase() === 'x-id-agent'
      || key.toLowerCase() === 'x-id-service'
    )),
    false,
    'invalid admin probes must not impersonate a worker or service',
  );
}
assert.equal(managerEndpointRejectsInvalidAdmin({
  status: 200,
  body: { error: 'authentication_required' },
}), false);
assert.equal(managerEndpointRejectsInvalidAdmin({
  status: 401,
  body: {
    error: 'authentication_required',
    detail: 'identity leaked',
  },
}), false);
const managerAuthorizationSummary = managerAuthorizationFailureSummary({
  status: 403,
  body: {
    error: secretMarker,
    [secretMarker]: 'private',
  },
});
assert.deepEqual(managerAuthorizationSummary, {
  httpStatus: 403,
  bodyIsObject: true,
  bodyFieldCount: 2,
  reportsAuthenticationRequired: false,
});
assert.equal(
  JSON.stringify(managerAuthorizationSummary).includes(secretMarker),
  false,
  'Manager authorization diagnostics must not include response keys or values',
);

const expectedWorker = {
  id: 'agent_release_selftest',
  name: 'idacc-local-selftest',
  port: 45123,
  pid: 8123,
};
const workerDetail = {
  id: expectedWorker.id,
  name: expectedWorker.name,
  alias: expectedWorker.name,
  status: 'running',
  deploymentShape: 'local-process',
  port: expectedWorker.port,
  pid: expectedWorker.pid,
  processOwner: 'manager-child',
  processParentPid: 8000,
  metadata: { processGeneration: 'generation-current' },
};
const workerStatus = {
  ...workerDetail,
  isResponding: true,
};

type AttestationFixture = {
  detailBefore: Record<string, any>;
  status: Record<string, any>;
  detailAfter: Record<string, any>;
};

function newAttestationFixture(): AttestationFixture {
  return {
    detailBefore: structuredClone(workerDetail),
    status: structuredClone(workerStatus),
    detailAfter: structuredClone(workerDetail),
  };
}

function attestationMatches(
  fixture: AttestationFixture,
  httpStatus: {
    detailBefore?: number;
    status?: number;
    detailAfter?: number;
  } = {},
): boolean {
  return managedWorkerLifecycleAttestationMatches(
    {
      status: httpStatus.detailBefore ?? 200,
      body: fixture.detailBefore,
    },
    {
      status: httpStatus.status ?? 200,
      body: { agents: [fixture.status] },
    },
    {
      status: httpStatus.detailAfter ?? 200,
      body: fixture.detailAfter,
    },
    expectedWorker,
  );
}

assert.equal(managedWorkerLifecycleAttestationMatches(
  { status: 200, body: workerDetail },
  { status: 200, body: { agents: [workerStatus] } },
  { status: 200, body: structuredClone(workerDetail) },
  expectedWorker,
), true);

const durableIdentityMutations: Array<{
  label: string;
  mutate: (candidate: Record<string, any>) => void;
}> = [
  {
    label: 'id',
    mutate: (candidate) => { candidate.id = 'agent_other'; },
  },
  {
    label: 'name',
    mutate: (candidate) => { candidate.name = 'other-name'; },
  },
  {
    label: 'alias',
    mutate: (candidate) => { candidate.alias = 'other-alias'; },
  },
  {
    label: 'running status',
    mutate: (candidate) => { candidate.status = 'offline'; },
  },
  {
    label: 'local deployment shape',
    mutate: (candidate) => { candidate.deploymentShape = 'remote-endpoint'; },
  },
  {
    label: 'port',
    mutate: (candidate) => { candidate.port = expectedWorker.port + 1; },
  },
  {
    label: 'PID',
    mutate: (candidate) => { candidate.pid = expectedWorker.pid + 1; },
  },
  {
    label: 'Manager child owner',
    mutate: (candidate) => { candidate.processOwner = 'adopted'; },
  },
  {
    label: 'positive parent PID',
    mutate: (candidate) => { candidate.processParentPid = 0; },
  },
  {
    label: 'integer parent PID',
    mutate: (candidate) => { candidate.processParentPid = 8000.5; },
  },
  {
    label: 'process generation availability',
    mutate: (candidate) => { candidate.metadata = {}; },
  },
  {
    label: 'non-empty process generation',
    mutate: (candidate) => { candidate.metadata.processGeneration = '   '; },
  },
  {
    label: 'same process generation',
    mutate: (candidate) => { candidate.metadata.processGeneration = 'generation-replaced'; },
  },
];

for (const surface of ['detailBefore', 'status', 'detailAfter'] as const) {
  for (const { label, mutate } of durableIdentityMutations) {
    const fixture = newAttestationFixture();
    mutate(fixture[surface]);
    assert.equal(
      attestationMatches(fixture),
      false,
      `${surface} must reject a mismatched ${label}`,
    );
  }
}

for (const statusCodeLocation of ['detailBefore', 'status', 'detailAfter'] as const) {
  assert.equal(
    attestationMatches(newAttestationFixture(), { [statusCodeLocation]: 503 }),
    false,
    `${statusCodeLocation} must require HTTP 200`,
  );
}

{
  const fixture = newAttestationFixture();
  fixture.status.isResponding = false;
  assert.equal(
    attestationMatches(fixture),
    false,
    'Manager status must prove the generation-authenticated worker responded',
  );
}
{
  const fixture = newAttestationFixture();
  delete fixture.status.isResponding;
  assert.equal(
    attestationMatches(fixture),
    false,
    'Manager status must explicitly report a responding worker',
  );
}
assert.equal(managedWorkerLifecycleAttestationMatches(
  { status: 200, body: structuredClone(workerDetail) },
  { status: 200, body: { agents: [] } },
  { status: 200, body: structuredClone(workerDetail) },
  expectedWorker,
), false, 'Manager status must include the exact worker');
assert.equal(managedWorkerLifecycleAttestationMatches(
  { status: 200, body: structuredClone(workerDetail) },
  { status: 200, body: { agents: [structuredClone(workerStatus), structuredClone(workerStatus)] } },
  { status: 200, body: structuredClone(workerDetail) },
  expectedWorker,
), false, 'Manager status must contain one unambiguous worker row');
assert.equal(managedWorkerLifecycleAttestationMatches(
  { status: 200, body: null as unknown as Record<string, unknown> },
  { status: 200, body: { agents: [structuredClone(workerStatus)] } },
  { status: 200, body: structuredClone(workerDetail) },
  expectedWorker,
), false, 'malformed detail bodies must fail closed');
assert.equal(managedWorkerLifecycleAttestationMatches(
  { status: 200, body: structuredClone(workerDetail) },
  { status: 200, body: null as unknown as Record<string, unknown> },
  { status: 200, body: structuredClone(workerDetail) },
  expectedWorker,
), false, 'malformed status bodies must fail closed');

const secretBearingDetail = {
  ...structuredClone(workerDetail),
  name: secretMarker,
  metadata: {
    processGeneration: secretMarker,
    privateToken: secretMarker,
  },
};
const attestationSummary = managedWorkerAttestationSummary(
  { status: 200, body: secretBearingDetail },
  {
    status: 200,
    body: {
      agents: [{
        ...structuredClone(workerStatus),
        metadata: {
          processGeneration: secretMarker,
          privateToken: secretMarker,
        },
      }],
    },
  },
  { status: 200, body: secretBearingDetail },
  expectedWorker,
);
assert.equal(
  JSON.stringify(attestationSummary).includes(secretMarker),
  false,
  'lifecycle attestation diagnostics must expose only comparisons and presence',
);

const stoppedWorkerDetail: Record<string, any> = {
  ...structuredClone(workerDetail),
  status: 'stopped',
  pid: null,
  processOwner: null,
  processParentPid: null,
  metadata: { source: 'idacc-release-selftest' },
};
const killedStopResponse = {
  status: 200,
  body: {
    ok: true,
    result: {
      action: 'stopped',
      name: expectedWorker.name,
      killed: true,
      pids: [expectedWorker.pid],
      queriesCancelled: 0,
    },
  },
};
const alreadyExitedStopResponse = {
  status: 200,
  body: {
    ok: true,
    result: {
      action: 'stopped',
      name: expectedWorker.name,
      killed: false,
      pids: [],
      queriesCancelled: 0,
    },
  },
};
assert.equal(
  managedWorkerStopResponseIsExplicit(killedStopResponse, expectedWorker),
  true,
  'an explicit kill of the attested worker PID must be accepted',
);
assert.equal(
  managedWorkerStopResponseIsExplicit(alreadyExitedStopResponse, expectedWorker),
  true,
  'an idempotent stop may report that the attested worker already exited',
);
for (const invalid of [
  { ...structuredClone(killedStopResponse), status: 500 },
  {
    status: 200,
    body: {
      ok: true,
      result: {
        action: 'stopped',
        name: expectedWorker.name,
        killed: true,
        pids: [expectedWorker.pid + 1],
        queriesCancelled: 0,
      },
    },
  },
  {
    status: 200,
    body: {
      ok: true,
      result: {
        action: 'stopped',
        name: expectedWorker.name,
        killed: false,
        pids: [expectedWorker.pid],
        queriesCancelled: 0,
      },
    },
  },
  {
    status: 200,
    body: {
      ok: true,
      result: {
        action: 'stopped',
        name: expectedWorker.name,
        killed: true,
        pids: [expectedWorker.pid, expectedWorker.pid + 1],
        queriesCancelled: 0,
      },
    },
  },
]) {
  assert.equal(
    managedWorkerStopResponseIsExplicit(invalid, expectedWorker),
    false,
    'ambiguous or inconsistent stop responses must fail closed',
  );
}
assert.equal(managedWorkerStoppedDetailMatches({
  status: 200,
  body: stoppedWorkerDetail,
}, expectedWorker), true);
for (const mutate of [
  (detail: Record<string, any>) => { detail.status = 'running'; },
  (detail: Record<string, any>) => { detail.pid = expectedWorker.pid; },
  (detail: Record<string, any>) => { detail.processOwner = 'manager-child'; },
  (detail: Record<string, any>) => { detail.processParentPid = 8000; },
  (detail: Record<string, any>) => { detail.metadata.processGeneration = 'still-owned'; },
  (detail: Record<string, any>) => { detail.metadata.managerOwnedLaunchIntent = true; },
  (detail: Record<string, any>) => { detail.metadata.managerRestartRequested = true; },
]) {
  const candidate = structuredClone(stoppedWorkerDetail);
  mutate(candidate);
  assert.equal(
    managedWorkerStoppedDetailMatches({ status: 200, body: candidate }, expectedWorker),
    false,
    'stopped worker state must clear every live-process and restart marker',
  );
}
const secretBearingStoppedDetail = {
  ...structuredClone(stoppedWorkerDetail),
  metadata: {
    privateToken: secretMarker,
    processGeneration: secretMarker,
  },
};
assert.equal(
  JSON.stringify(managedWorkerStoppedDetailSummary(
    { status: 200, body: secretBearingStoppedDetail },
    expectedWorker,
  )).includes(secretMarker),
  false,
  'stopped-state diagnostics must expose only comparisons and presence',
);

process.stdout.write('unified runtime contract smoke: ok\n');
