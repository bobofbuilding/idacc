import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'idacc-onboarding-integration-'));
const statePath = join(temporary, 'profile', 'onboarding', 'state.json');
const bundlePath = join(temporary, 'consumer-onboarding-under-test.mjs');
const capabilityBundlePath = join(temporary, 'starter-tool-capability-under-test.mjs');
const readCacheBundlePath = join(temporary, 'read-call-cache-under-test.mjs');
const refreshPolicyBundlePath = join(temporary, 'runtime-freshness-policy-under-test.mjs');
const starterNames = ['lead', 'coder', 'researcher'];
const requiredSkills = ['brain', 'catalog', 'identity', 'inter-agent', 'task-discipline'];
const selectedAssignment = { runtime: 'codex', model: 'gpt-test' };
const subscriptionRuntime = 'grok';
const subscriptionModel = 'grok-subscription-fixture';
const toolCapableLocalModel = 'qwen3-tools:fixture';
const nonToolLocalModel = 'smollm-general:fixture';
const malformedCapabilityModel = 'malformed-capability:fixture';
const oversizedCapabilityModel = 'oversized-capability:fixture';
const failedCapabilityModel = 'failed-capability:fixture';
const slowCapabilityModel = 'slow-capability:fixture';

const calls = [];
const onboardPayloads = [];
const assignmentWrites = [];
const rebuilds = [];
const installedSkills = [];
const instructionWrites = [];
const verificationBatches = [];
const probes = [];
const ollamaShowRequests = [];
const subscriptionRefreshCalls = [];
const runtimeRefreshPolicies = [];
let localToolEvidence = null;
let failLeadBrainInstallOnce = true;
let subscriptionAuthenticated = false;
let runtimeSubscriptionCache = null;
let displayedSubscriptionCache = null;
let runtimeFreshnessPolicyModule = null;
let heldRuntimeFreshness = null;
let hierarchy = {
  primary: null,
  coordinators: {},
  secondaries: [
    { agent: 'quality-validator', team: 'default', leadsTeams: ['quality'] },
  ],
};

const agents = new Map([
  ['lead', {
    id: 'existing-lead-id',
    name: 'lead',
    status: 'stopped',
    runtime: 'retired-runtime',
    model: 'retired-model',
    instructions: 'Keep this person-authored lead instruction.',
    skills: ['identity'],
    brainMcpReady: false,
  }],
]);

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    runtime: agent.runtime,
    model: agent.model,
    metadata: {
      runtime: agent.runtime,
      instructions: agent.instructions,
      skills: [...agent.skills],
    },
    brainTools: {
      skillInstalled: agent.brainMcpReady,
      mcpAttached: agent.brainMcpReady,
      activeToolAccess: agent.brainMcpReady,
    },
  };
}

function roster() {
  return [{
    team: 'default',
    agents: [...agents.values()].map(publicAgent),
  }];
}

function findAgent(name) {
  const agent = agents.get(String(name));
  if (!agent) throw new Error(`fixture agent not found: ${String(name)}`);
  return agent;
}

function fixtureSubscriptionStatus(cacheName, options = {}) {
  const cached = cacheName === 'runtime' ? runtimeSubscriptionCache : displayedSubscriptionCache;
  const next = options.force === true || cached === null
    ? {
        grok: {
          provider: 'grok',
          runtime: subscriptionRuntime,
          label: 'Grok subscription fixture',
          loggedIn: subscriptionAuthenticated,
          linked: subscriptionAuthenticated,
          installed: true,
          loginSupported: true,
          account: subscriptionAuthenticated ? 'post-login-fixture' : undefined,
        },
      }
    : cached;
  if (cacheName === 'runtime') runtimeSubscriptionCache = next;
  else displayedSubscriptionCache = next;
  subscriptionRefreshCalls.push({
    cacheName,
    force: options.force === true,
    loggedIn: next.grok.loggedIn,
  });
  return structuredClone(next);
}

async function managerCall(method, args) {
  calls.push({ method, args: structuredClone(args) });
  switch (method) {
    case 'agents:allTeams':
      return roster();
    case 'org:hierarchy':
      return structuredClone(hierarchy);
    case 'runtime:freshness':
      if (!runtimeFreshnessPolicyModule) throw new Error('runtime freshness policy fixture is not loaded');
      return runtimeFreshnessPolicyModule.handleRuntimeFreshnessRequest(args[0], async (policy) => {
        runtimeRefreshPolicies.push(structuredClone(policy));
        const managed = fixtureSubscriptionStatus('runtime', policy.subscriptions);
        const result = [
        {
          runtime: selectedAssignment.runtime,
          label: 'Codex fixture',
          models: [selectedAssignment.model],
          source: 'live-fixture',
          selectable: true,
          supportsMcp: true,
        },
        {
          runtime: 'cursor-cli',
          label: 'Cursor fixture',
          models: ['cursor-test'],
          source: 'live-fixture',
          selectable: true,
          supportsMcp: false,
        },
        {
          runtime: 'provider:fixture-ollama',
          label: 'Local Ollama fixture',
          models: [nonToolLocalModel, toolCapableLocalModel],
          source: 'live-fixture',
          selectable: true,
          supportsMcp: Boolean(localToolEvidence?.toolCapableModels.length),
          mcpModels: localToolEvidence?.toolCapableModels ?? [],
          mcpEvidence: 'ollama-show',
          mcpExcludedModels: [
            ...(localToolEvidence?.nonToolModels ?? []),
            ...(localToolEvidence?.unverifiedModels ?? []),
          ],
          mcpDetail: localToolEvidence?.detail,
        },
        {
          runtime: 'provider:generic-fixture',
          label: 'Generic provider fixture',
          models: ['generic-model'],
          source: 'live-fixture',
          selectable: true,
          supportsMcp: false,
          mcpModels: [],
          mcpDetail: 'Structural provider MCP wiring is not deterministic per-model tool evidence.',
        },
        ...(managed.grok.loggedIn ? [{
          runtime: subscriptionRuntime,
          label: 'Grok subscription fixture',
          models: [subscriptionModel],
          source: 'subscription-fixture',
          selectable: true,
          supportsMcp: true,
          mcpModels: [subscriptionModel],
          mcpEvidence: 'runtime',
        }] : []),
        ];
        const held = heldRuntimeFreshness;
        if (held) {
          heldRuntimeFreshness = null;
          held.started();
          await held.release;
        }
        return result;
      });
    case 'agent:getInstructions':
      return findAgent(args[0]).instructions;
    case 'runtime:verifyAssignments': {
      const rows = args[0];
      verificationBatches.push(structuredClone(rows));
      return {
        ok: true,
        rows: rows.map((row) => ({
          name: row.name,
          ok: row.runtime === selectedAssignment.runtime
            && row.model === selectedAssignment.model,
          detail: 'verified by controlled Manager fixture',
        })),
      };
    }
    case 'onboard:run': {
      const input = args[0];
      if (agents.has(input.name)) throw new Error(`duplicate starter creation: ${input.name}`);
      onboardPayloads.push(structuredClone(input));
      agents.set(input.name, {
        id: `created-${input.name}-id`,
        name: input.name,
        status: 'running',
        runtime: input.runtime,
        model: input.model,
        instructions: '',
        skills: [...input.skills],
        brainMcpReady: input.skills.includes('brain'),
      });
      return {
        ok: true,
        agentId: `created-${input.name}-id`,
        steps: [{ status: 'ok' }],
      };
    }
    case 'setAgentRuntime': {
      const [id, runtime] = args;
      const agent = [...agents.values()].find((candidate) => candidate.id === id);
      if (!agent) throw new Error(`fixture agent id not found: ${String(id)}`);
      assignmentWrites.push({ name: agent.name, field: 'runtime', value: runtime });
      agent.runtime = runtime;
      return { ok: true };
    }
    case 'setAgentModel': {
      const [id, model] = args;
      const agent = [...agents.values()].find((candidate) => candidate.id === id);
      if (!agent) throw new Error(`fixture agent id not found: ${String(id)}`);
      assignmentWrites.push({ name: agent.name, field: 'model', value: model });
      agent.model = model;
      return { ok: true };
    }
    case 'rebuildAgent': {
      const agent = findAgent(args[0]);
      rebuilds.push(agent.name);
      agent.status = 'running';
      agent.brainMcpReady = agent.skills.includes('brain');
      return { ok: true };
    }
    case 'installSkill': {
      const [skill, name] = args;
      if (name === 'lead' && skill === 'brain' && failLeadBrainInstallOnce) {
        failLeadBrainInstallOnce = false;
        throw new Error('intentional one-shot Brain skill installation failure');
      }
      const agent = findAgent(name);
      installedSkills.push({ name, skill });
      if (!agent.skills.includes(skill)) agent.skills.push(skill);
      return { ok: true };
    }
    case 'coordinator:set':
      hierarchy.coordinators[String(args[0])] = String(args[1]);
      return { ok: true };
    case 'coordinator:setPrimary':
      hierarchy.primary = { team: String(args[0]), agent: String(args[1]) };
      return { ok: true };
    case 'org:getSecondaryLeads':
      return structuredClone(hierarchy.secondaries);
    case 'org:setSecondaryLeads':
      hierarchy.secondaries = structuredClone(args[0]);
      return { ok: true };
    case 'agent:setInstructions': {
      const [name, instructions] = args;
      instructionWrites.push(String(name));
      findAgent(name).instructions = String(instructions);
      return { ok: true };
    }
    case 'org:sync':
      return { ok: true };
    case 'probeOne': {
      const agent = findAgent(args[0]);
      probes.push(agent.name);
      const healthy = agent.status === 'running'
        && agent.skills.includes('brain')
        && agent.brainMcpReady;
      return {
        probed: 1,
        passed: healthy ? 1 : 0,
        failed: healthy ? 0 : 1,
        results: [{ status: healthy ? 'ok' : 'failed', error: healthy ? undefined : 'fixture agent is not ready' }],
      };
    }
    default:
      throw new Error(`unexpected onboarding bridge call: ${method}`);
  }
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        rejectBody(new Error('fixture request exceeded its size limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        rejectBody(error);
      }
    });
    request.once('error', rejectBody);
  });
}

const manager = createServer((request, response) => {
  void (async () => {
    if (request.method === 'POST' && request.url === '/api/show') {
      try {
        const body = await readJsonBody(request);
        const model = String(body?.model ?? '');
        ollamaShowRequests.push(model);
        if (model === failedCapabilityModel) {
          response.writeHead(503).end('controlled failure');
          return;
        }
        if (model === slowCapabilityModel) {
          await new Promise((resolveSlow) => setTimeout(resolveSlow, 150));
          if (response.destroyed) return;
        }
        if (model === malformedCapabilityModel) {
          const payload = '{"capabilities":';
          response.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          });
          response.end(payload);
          return;
        }
        if (model === oversizedCapabilityModel) {
          const payload = JSON.stringify({
            model,
            capabilities: ['tools'],
            ignored: 'x'.repeat(4 * 1024),
          });
          response.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          });
          response.end(payload);
          return;
        }
        const capabilities = model === toolCapableLocalModel
          ? ['completion', 'tools']
          : ['completion'];
        const payload = JSON.stringify({ model, capabilities });
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        response.end(payload);
      } catch (error) {
        response.writeHead(400).end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/bridge') {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readJsonBody(request);
      const result = await managerCall(body.method, Array.isArray(body.args) ? body.args : []);
      const payload = JSON.stringify({ ok: true, result });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    } catch (error) {
      const payload = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      response.writeHead(500, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    }
  })();
});

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('controlled Manager fixture did not bind a TCP port'));
        return;
      }
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

const fixturePlugin = {
  name: 'consumer-onboarding-manager-fixture',
  setup(context) {
    const isOnboardingImporter = (path) => (
      path.replaceAll('\\', '/').endsWith('/src/main/consumerOnboarding.ts')
    );
    context.onResolve({ filter: /^\.\/bridge\.ts$/ }, (args) => (
      isOnboardingImporter(args.importer)
        ? { path: 'bridge', namespace: 'onboarding-fixture' }
        : null
    ));
    context.onResolve({ filter: /^\.\/subscriptions\.ts$/ }, (args) => (
      isOnboardingImporter(args.importer)
        ? { path: 'subscriptions', namespace: 'onboarding-fixture' }
        : null
    ));
    context.onResolve({ filter: /^\.\/unifiedStack\.ts$/ }, (args) => (
      isOnboardingImporter(args.importer)
        ? { path: 'unified-stack', namespace: 'onboarding-fixture' }
        : null
    ));
    context.onLoad({ filter: /^bridge$/, namespace: 'onboarding-fixture' }, () => ({
      loader: 'js',
      contents: `
        export async function call(method, args) {
          const fixture = globalThis.__IDACC_ONBOARDING_INTEGRATION_FIXTURE__;
          const response = await fetch(fixture.managerUrl + '/bridge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, args }),
          });
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(body.error || 'controlled Manager fixture failed');
          return body.result;
        }
      `,
    }));
    context.onLoad({ filter: /^subscriptions$/, namespace: 'onboarding-fixture' }, () => ({
      loader: 'js',
      contents: `
        export async function subsStatus(options = {}) {
          const fixture = globalThis.__IDACC_ONBOARDING_INTEGRATION_FIXTURE__;
          return fixture.subsStatus(options);
        }
      `,
    }));
    context.onLoad({ filter: /^unified-stack$/, namespace: 'onboarding-fixture' }, () => ({
      loader: 'js',
      contents: `
        export async function unifiedStackStatus() {
          return {
            ready: true,
            profileRoot: process.env.IDACC_DATA_DIR,
            services: [
              { name: 'manager', bundled: true, running: true, healthy: true },
              { name: 'brain', bundled: true, running: true, healthy: true },
            ],
            managerCompatibility: { ready: true, issues: [] },
          };
        }
      `,
    }));
  },
};

let managerUrl;
process.env.IDACC_ONBOARDING_STATE = statePath;
process.env.IDACC_DATA_DIR = join(temporary, 'profile');

try {
  managerUrl = await listen(manager);
  globalThis.__IDACC_ONBOARDING_INTEGRATION_FIXTURE__ = {
    managerUrl,
    subsStatus: async (options) => fixtureSubscriptionStatus('display', options),
  };
  await Promise.all([
    build({
      absWorkingDir: desktop,
      entryPoints: ['src/main/consumerOnboarding.ts'],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      plugins: [fixturePlugin],
      logLevel: 'silent',
    }),
    build({
      absWorkingDir: desktop,
      entryPoints: ['src/main/starterToolCapability.ts'],
      outfile: capabilityBundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    }),
    build({
      absWorkingDir: desktop,
      entryPoints: ['src/shared/readCallCache.ts'],
      outfile: readCacheBundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    }),
    build({
      absWorkingDir: desktop,
      entryPoints: ['src/main/runtimeFreshnessPolicy.ts'],
      outfile: refreshPolicyBundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    }),
  ]);

  runtimeFreshnessPolicyModule = await import(
    `${pathToFileURL(refreshPolicyBundlePath).href}?run=${Date.now()}`
  );
  const capability = await import(`${pathToFileURL(capabilityBundlePath).href}?run=${Date.now()}`);
  localToolEvidence = await capability.inspectOllamaStarterToolModels(
    managerUrl,
    [nonToolLocalModel, toolCapableLocalModel],
  );
  assert.deepEqual(localToolEvidence.toolCapableModels, [toolCapableLocalModel]);
  assert.deepEqual(localToolEvidence.nonToolModels, [nonToolLocalModel]);
  assert.deepEqual(localToolEvidence.unverifiedModels, []);
  assert.deepEqual(
    new Set(ollamaShowRequests),
    new Set([nonToolLocalModel, toolCapableLocalModel]),
    'the bounded readiness probe must use only Ollama /api/show and never invoke a model',
  );
  const failedEvidence = await capability.inspectOllamaStarterToolModels(
    managerUrl,
    [
      malformedCapabilityModel,
      oversizedCapabilityModel,
      failedCapabilityModel,
      slowCapabilityModel,
    ],
    {
      modelTimeoutMs: 50,
      totalTimeoutMs: 500,
      maxResponseBytes: 1024,
    },
  );
  assert.deepEqual(failedEvidence.toolCapableModels, []);
  assert.deepEqual(failedEvidence.nonToolModels, []);
  assert.deepEqual(
    new Set(failedEvidence.unverifiedModels),
    new Set([
      malformedCapabilityModel,
      oversizedCapabilityModel,
      failedCapabilityModel,
      slowCapabilityModel,
    ]),
    'malformed, oversized, failed, and timed-out /api/show responses must fail closed',
  );

  let unsafeFetches = 0;
  const unsafeEvidence = await capability.inspectOllamaStarterToolModels(
    'http://192.0.2.1:11434',
    ['unsafe-route-model'],
    {
      fetchImpl: async () => {
        unsafeFetches += 1;
        throw new Error('an unsafe provider URL must be rejected before fetch');
      },
    },
  );
  assert.equal(unsafeFetches, 0);
  assert.deepEqual(unsafeEvidence.unverifiedModels, ['unsafe-route-model']);
  assert.match(unsafeEvidence.detail, /provider URL is not allowed/);

  let boundedFetches = 0;
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  const boundedEvidence = await capability.inspectOllamaStarterToolModels(
    managerUrl,
    ['deduped-model', 'deduped-model', 'second-model', 'beyond-limit-model'],
    {
      maxModels: 2,
      concurrency: 1,
      fetchImpl: async () => {
        boundedFetches += 1;
        activeFetches += 1;
        maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
        await new Promise((resolveFetch) => setTimeout(resolveFetch, 5));
        activeFetches -= 1;
        return new Response(JSON.stringify({ capabilities: ['tools'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );
  assert.equal(boundedFetches, 2, 'duplicate models must be deduplicated and the probe count capped');
  assert.equal(maximumActiveFetches, 1, 'the configured bounded concurrency must be honored');
  assert.deepEqual(boundedEvidence.toolCapableModels, ['deduped-model', 'second-model']);
  assert.deepEqual(boundedEvidence.unverifiedModels, ['beyond-limit-model']);
  assert.equal(boundedEvidence.truncated, true);

  const readCacheModule = await import(`${pathToFileURL(readCacheBundlePath).href}?run=${Date.now()}`);
  const readCache = new readCacheModule.ReadCallCache();
  let freshnessGeneration = 0;
  const readFreshness = (args) => readCache.run(
    'runtime:freshness',
    args,
    async () => ({ generation: ++freshnessGeneration }),
  );
  assert.deepEqual(await readFreshness([]), { generation: 1 });
  assert.deepEqual(await readFreshness([]), { generation: 1 }, 'normal freshness reads retain the five-minute cache');
  assert.deepEqual(
    await readFreshness([{ force: true }]),
    { generation: 2 },
    'an explicit setup retry must bypass cached model/tool evidence',
  );
  assert.deepEqual(
    await readFreshness([]),
    { generation: 2 },
    'forced freshness must replace the canonical normal-read cache entry',
  );
  const racingReadCache = new readCacheModule.ReadCallCache();
  let finishOldNormal;
  const oldNormal = racingReadCache.run(
    'runtime:freshness',
    [],
    () => new Promise((resolve) => {
      finishOldNormal = () => resolve({ generation: 'old-normal' });
    }),
  );
  assert.deepEqual(
    await racingReadCache.run(
      'runtime:freshness',
      [{ force: true }],
      async () => ({ generation: 'forced-fresh' }),
    ),
    { generation: 'forced-fresh' },
  );
  finishOldNormal();
  assert.deepEqual(await oldNormal, { generation: 'old-normal' });
  assert.deepEqual(
    await racingReadCache.run(
      'runtime:freshness',
      [],
      async () => ({ generation: 'must-not-run' }),
    ),
    { generation: 'forced-fresh' },
    'an older normal completion must not overwrite the canonical forced result',
  );
  const bookkeepingReadCache = new readCacheModule.ReadCallCache();
  for (let index = 0; index < 250; index += 1) {
    await bookkeepingReadCache.run(
      'query:poll',
      [`completed-query-${index}`],
      async () => ({ index }),
    );
  }
  assert.equal(
    bookkeepingReadCache.latestRequest.size,
    0,
    'completed high-cardinality reads must release newest-request bookkeeping',
  );
  const subscriptionReadCache = new readCacheModule.ReadCallCache();
  let subscriptionCacheRuns = 0;
  const forcedSubscriptionRead = () => subscriptionReadCache.run(
    'subs:status',
    [{ force: true, maxAgeMs: 0 }],
    async () => ({ generation: ++subscriptionCacheRuns }),
  );
  assert.deepEqual(await forcedSubscriptionRead(), { generation: 1 });
  assert.deepEqual(
    await forcedSubscriptionRead(),
    { generation: 2 },
    'object-form subscription force must bypass the outer read cache',
  );
  assert.deepEqual(
    await subscriptionReadCache.run(
      'subs:status',
      [{ force: false, maxAgeMs: 300_000 }],
      async () => ({ generation: ++subscriptionCacheRuns }),
    ),
    { generation: 2 },
    'the newest forced subscription read must supersede the canonical normal cache entry',
  );
  assert.equal(subscriptionCacheRuns, 2);

  const onboarding = await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
  assert.equal(
    typeof onboarding.runStarterFleetOnboarding,
    'function',
    'the integration must invoke the real Electron onboarding orchestration wrapper',
  );
  let releaseOldOnboarding;
  let markOldOnboardingStarted;
  const oldOnboardingStarted = new Promise((resolve) => {
    markOldOnboardingStarted = resolve;
  });
  heldRuntimeFreshness = {
    started: markOldOnboardingStarted,
    release: new Promise((resolve) => {
      releaseOldOnboarding = resolve;
    }),
  };
  subscriptionAuthenticated = false;
  const oldOnboarding = onboarding.consumerOnboardingStatus({ force: true });
  await oldOnboardingStarted;
  subscriptionAuthenticated = true;
  const forcedFreshOnboarding = await onboarding.consumerOnboardingStatus({ force: true });
  assert.equal(
    forcedFreshOnboarding.assignments.some((row) => row.runtime === subscriptionRuntime),
    true,
  );
  releaseOldOnboarding();
  const completedOldOnboarding = await oldOnboarding;
  assert.equal(
    completedOldOnboarding.assignments.some((row) => row.runtime === subscriptionRuntime),
    false,
    'the held older request must retain its own original snapshot',
  );
  assert.equal(
    (await onboarding.consumerOnboardingStatus()).assignments.some(
      (row) => row.runtime === subscriptionRuntime,
    ),
    true,
    'an older onboarding completion must not replace the latest forced cache entry',
  );

  subscriptionAuthenticated = false;
  const beforeLogin = await onboarding.consumerOnboardingStatus({ force: true });
  assert.equal(
    beforeLogin.assignments.some((row) => row.runtime === subscriptionRuntime),
    false,
    'the logged-out evidence must prime both nested subscription caches',
  );
  const postLoginRefreshCheckpoint = subscriptionRefreshCalls.length;
  subscriptionAuthenticated = true;
  const initialStatus = await onboarding.consumerOnboardingStatus({ force: true });
  assert.equal(
    initialStatus.assignments.some((row) => (
      row.runtime === subscriptionRuntime
      && row.models.includes(subscriptionModel)
    )),
    true,
    'one forced post-login re-check must expose the newly authenticated assignment route',
  );
  assert.equal(
    initialStatus.subscriptions.some((row) => (
      row.runtime === subscriptionRuntime
      && row.loggedIn
      && row.account === 'post-login-fixture'
    )),
    true,
    'the same re-check must display the fresh linked-account evidence',
  );
  assert.deepEqual(
    new Set(
      subscriptionRefreshCalls
        .slice(postLoginRefreshCheckpoint)
        .filter((row) => row.force && row.loggedIn)
        .map((row) => row.cacheName),
    ),
    new Set(['runtime', 'display']),
    'post-login force must bypass both the nested assignment cache and the displayed subscription cache',
  );
  assert.deepEqual(
    runtimeRefreshPolicies.at(-1),
    {
      catalog: { refreshCli: true, refreshClaude: true },
      subscriptions: { force: true },
    },
    'the authoritative re-check must refresh CLI discovery and subscription authentication together',
  );
  const bridgeSource = readFileSync(join(desktop, 'src', 'main', 'bridge.ts'), 'utf8');
  assert.match(
    bridgeSource,
    /'runtime:freshness':\s*async\s*\(options\?:\s*\{\s*force\?:\s*boolean\s*\}\)\s*=>\s*\(\s*handleRuntimeFreshnessRequest\(options,\s*runtimeFreshness\)\s*\)/,
    'the production runtime:freshness method must pass its request options into the shared force policy',
  );
  assert.match(
    bridgeSource,
    /runtimeCatalogWithLiveCliModels\(policy\.catalog\)/,
    'production runtime freshness must consume the forced CLI catalog policy',
  );
  assert.match(
    bridgeSource,
    /subsStatus\(policy\.subscriptions\)/,
    'production runtime freshness must consume the forced nested subscription policy',
  );
  assert.ok(
    calls.some((row) => (
      row.method === 'runtime:freshness'
      && row.args?.[0]?.force === true
    )),
    'consumer onboarding force refresh must propagate through the bridge cache boundary',
  );
  assert.deepEqual(
    initialStatus.assignments.map((row) => row.runtime),
    [selectedAssignment.runtime, subscriptionRuntime, 'provider:fixture-ollama'],
    'starter setup must exclude selectable runtimes that cannot expose effective Brain MCP',
  );
  assert.deepEqual(
    initialStatus.assignments.find((row) => row.runtime === 'provider:fixture-ollama')?.models,
    [toolCapableLocalModel],
    'starter setup must retain only the Ollama model with authoritative tool capability',
  );
  assert.equal(
    initialStatus.assignments.find((row) => row.runtime === 'provider:fixture-ollama')?.requiresModel,
    true,
    'an Ollama starter assignment must name the exact model that was capability-checked',
  );
  assert.ok(
    initialStatus.assignments.every((row) => !row.models.includes(nonToolLocalModel)),
    'a selectable non-tool local model must remain outside the starter assignment list',
  );
  assert.ok(
    initialStatus.notices.some((notice) => /Cursor fixture.*not offered.*Brain tool-call capability/.test(notice)),
    'starter setup must explain why a connected non-MCP runtime is excluded',
  );
  assert.ok(
    initialStatus.notices.some((notice) => (
      /Local Ollama fixture.*smollm-general:fixture.*authoritative Brain tool-call capability/.test(notice)
    )),
    'starter setup must diagnose a local model that remains general-use only',
  );
  assert.ok(
    initialStatus.notices.some((notice) => (
      /Generic provider fixture.*not deterministic per-model tool evidence/.test(notice)
    )),
    'generic provider lanes must stay visible for general agents without being declared starter-ready',
  );
  assert.ok(
    initialStatus.issues.every((issue) => !/Cursor fixture|Generic provider fixture/.test(issue)),
    'general-use route notices must not be presented as setup failures',
  );
  await assert.rejects(
    onboarding.runStarterFleetOnboarding({ runtime: 'provider:fixture-ollama' }),
    /Choose an Ollama model whose tool capability was verified/,
    'an implicit Ollama default must not bypass per-model tool evidence',
  );
  await assert.rejects(
    onboarding.runStarterFleetOnboarding({
      runtime: 'provider:fixture-ollama',
      model: nonToolLocalModel,
    }),
    /selected model is not in the latest verified catalog/,
    'a selectable general-use local model must not be accepted through the starter API',
  );
  assert.equal(onboardPayloads.length, 0, 'rejected local assignments must not mutate the fleet');
  assert.equal(initialStatus.canDefer, true);
  const limited = await onboarding.deferConsumerOnboarding();
  assert.equal(limited.phase, 'limited');
  assert.equal(limited.limitedMode, true);
  assert.equal(limited.ready, false);
  const resumed = await onboarding.resumeConsumerOnboarding();
  assert.equal(resumed.phase, 'required');
  assert.equal(resumed.limitedMode, false);

  const failed = await onboarding.runStarterFleetOnboarding(selectedAssignment);
  assert.equal(failed.phase, 'in_progress');
  assert.equal(failed.ready, false);
  assert.match(failed.state.lastError, /one-shot Brain skill installation failure/);
  assert.deepEqual(
    onboardPayloads.map((row) => row.name),
    ['coder', 'researcher'],
    'the existing lead must be preserved and only missing validators may be created',
  );
  assert.ok(onboardPayloads.every((row) => (
    row.team === 'default'
    && row.runtime === selectedAssignment.runtime
    && row.model === selectedAssignment.model
    && row.probeAfter === true
    && requiredSkills.every((skill) => row.skills.includes(skill))
  )));
  assert.deepEqual(
    assignmentWrites,
    [
      { name: 'lead', field: 'runtime', value: selectedAssignment.runtime },
      { name: 'lead', field: 'model', value: selectedAssignment.model },
    ],
    'the stale preserved lead must receive the verified assignment exactly once',
  );
  assert.deepEqual(rebuilds, ['lead'], 'the stopped/stale lead must rebuild before the injected retry boundary');

  const completed = await onboarding.runStarterFleetOnboarding(selectedAssignment);
  assert.equal(completed.phase, 'ready');
  assert.equal(completed.ready, true);
  assert.equal(completed.currentReady, true);
  assert.ok(Object.values(completed.gates).every(Boolean));
  assert.equal(completed.state.mode, 'complete');
  assert.deepEqual(completed.state.selectedAssignment, selectedAssignment);
  assert.ok(completed.state.completedAt);
  assert.ok(completed.state.lastProbeAt);
  assert.ok(completed.state.lastVerifiedAt);
  assert.equal(completed.state.lastError, undefined);
  assert.deepEqual(
    completed.starterAgents.map((row) => row.name),
    starterNames,
  );
  assert.ok(completed.starterAgents.every((row) => (
    row.present
    && row.active
    && row.instructionsReady
    && row.skillsReady
    && row.brainMcpReady
  )));

  assert.equal(agents.get('lead').instructions, 'Keep this person-authored lead instruction.');
  assert.deepEqual(instructionWrites.sort(), ['coder', 'researcher']);
  assert.deepEqual(probes, starterNames);
  assert.deepEqual(
    new Set(installedSkills.filter((row) => row.name === 'lead').map((row) => row.skill)),
    new Set(['brain', 'catalog', 'inter-agent', 'task-discipline', 'team-coordinator']),
  );
  assert.deepEqual(
    rebuilds,
    ['lead', 'lead', 'coder', 'researcher'],
    'assignment repair, capability repair, and new instruction activation must rebuild the affected agents',
  );
  assert.deepEqual(hierarchy.primary, { team: 'default', agent: 'lead' });
  assert.equal(hierarchy.coordinators.default, 'lead');
  assert.ok(hierarchy.secondaries.some((row) => row.agent === 'coder' && row.team === 'default'));
  assert.ok(hierarchy.secondaries.some((row) => row.agent === 'researcher' && row.team === 'default'));
  assert.ok(
    hierarchy.secondaries.some((row) => (
      row.agent === 'quality-validator'
      && row.team === 'default'
      && row.leadsTeams.includes('quality')
    )),
    'onboarding must preserve unrelated configured secondary leads',
  );

  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.mode, 'complete');
  assert.deepEqual(persisted.selectedAssignment, selectedAssignment);
  assert.equal(persisted.lastError, undefined);
  if (process.platform !== 'win32') {
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  }

  const mutationCheckpoint = {
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  };
  const idempotent = await onboarding.runStarterFleetOnboarding(selectedAssignment);
  assert.equal(idempotent.phase, 'ready');
  assert.deepEqual({
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  }, mutationCheckpoint, 'a completed clean-profile retry must not duplicate agent or capability mutations');
  assert.equal(agents.size, 3);
  assert.equal(agents.get('lead').id, 'existing-lead-id');
  assert.equal(agents.get('lead').instructions, 'Keep this person-authored lead instruction.');
  assert.deepEqual(
    verificationBatches.map((batch) => batch.map((row) => row.name)),
    [['coder', 'researcher'], ['lead']],
    'creation and preserved-agent repair batches must each be verified before mutation',
  );
  assert.equal(
    calls.filter((row) => row.method === 'org:sync').length,
    2,
    'successful retry and idempotency pass must both complete hierarchy/instruction reconciliation',
  );

  // An upgraded active starter may retain every skill name while its effective
  // Brain MCP attachment is missing. Explicit setup must self-heal that state
  // without recreating the agent, changing its assignment/instructions, or
  // duplicating metadata on the following healthy pass.
  agents.get('lead').brainMcpReady = false;
  const brokenMcpCheckpoint = {
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  };
  const repairedMcp = await onboarding.runStarterFleetOnboarding(selectedAssignment);
  assert.equal(repairedMcp.phase, 'ready');
  assert.equal(repairedMcp.ready, true);
  assert.equal(agents.get('lead').brainMcpReady, true);
  assert.deepEqual({
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  }, {
    ...brokenMcpCheckpoint,
    rebuilds: brokenMcpCheckpoint.rebuilds + 1,
    skills: brokenMcpCheckpoint.skills + 1,
  }, 'broken effective Brain MCP must trigger one idempotent Brain reinstall and rebuild only');
  assert.deepEqual(
    installedSkills.at(-1),
    { name: 'lead', skill: 'brain' },
  );

  const repairedCheckpoint = {
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  };
  const repairedIdempotent = await onboarding.runStarterFleetOnboarding(selectedAssignment);
  assert.equal(repairedIdempotent.phase, 'ready');
  assert.deepEqual({
    creations: onboardPayloads.length,
    assignments: assignmentWrites.length,
    rebuilds: rebuilds.length,
    skills: installedSkills.length,
    instructions: instructionWrites.length,
  }, repairedCheckpoint, 'a repaired Brain MCP attachment must stay mutation-idempotent');
  assert.equal(
    calls.filter((row) => row.method === 'org:sync').length,
    4,
    'every successful reconciliation pass must complete hierarchy/instruction sync',
  );

  process.stdout.write('consumer onboarding integration smoke: ok\n');
} finally {
  delete globalThis.__IDACC_ONBOARDING_INTEGRATION_FIXTURE__;
  delete process.env.IDACC_ONBOARDING_STATE;
  delete process.env.IDACC_DATA_DIR;
  if (manager.listening) await close(manager);
  rmSync(temporary, { recursive: true, force: true });
}
