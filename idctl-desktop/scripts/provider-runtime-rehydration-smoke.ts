// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  providerRehydrationActionMessage,
  rehydrateManagedProviderAgents,
  settleProviderRuntimeRehydration,
} from '../src/main/providerRuntimeRehydration.ts';

async function main(): Promise<void> {
const secret = 'desktop-decrypted-provider-secret';
const calls: Array<{
  team: string;
  agentId: string;
  runtime: string;
  apiKey?: string;
}> = [];

const report = await rehydrateManagedProviderAgents({
  listTeams: async () => ['default', 'research', 'default'],
  listAgents: async (team) => {
    if (team === 'research') {
      return [{
        id: 'research-provider',
        name: 'researcher',
        runtime: 'provider:missing',
        metadata: { managerRestartRequested: true },
      }];
    }
    return [
      {
        id: 'marked-provider',
        name: 'coder',
        runtime: 'provider:openrouter',
        model: 'provider-model',
        metadata: { managerRestartRequested: true },
      },
      {
        id: 'metadata-provider',
        name: 'planner',
        runtime: 'provider-api',
        metadata: {
          runtime: 'provider:openrouter',
          managerRestartRequested: true,
        },
      },
      {
        id: 'parked-provider',
        name: 'intentionally-stopped',
        runtime: 'provider:openrouter',
        metadata: {},
      },
      {
        id: 'marked-subscription',
        name: 'subscription-agent',
        runtime: 'codex',
        metadata: { managerRestartRequested: true },
      },
    ];
  },
  resolveAssignment: (runtime) => {
    if (runtime === 'provider:missing') throw new Error(`missing ${secret}`);
    return {
      providerName: 'openrouter',
      availableModels: ['provider-model'],
      provider: {
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: secret,
      },
    };
  },
  rebindAndResume: async (team, agentId, runtime, provider) => {
    calls.push({ team, agentId, runtime, apiKey: provider.apiKey });
    return { resumed: true };
  },
});

assert.deepEqual(calls, [{
  team: 'default',
  agentId: 'marked-provider',
  runtime: 'provider:openrouter',
  apiKey: secret,
}, {
  team: 'default',
  agentId: 'metadata-provider',
  runtime: 'provider:openrouter',
  apiKey: secret,
}]);
assert.equal(report.attempted, 2);
assert.equal(report.resumed, 2);
assert.deepEqual(report.issues, [{
  team: 'research',
  agent: 'researcher',
  provider: 'missing',
  reason: 'provider_settings_unavailable',
}]);
assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
const message = providerRehydrationActionMessage(report);
assert.match(message || '', /Open Settings/i);
assert.match(message || '', /research\/researcher/);
assert.doesNotMatch(message || '', new RegExp(secret));

const missingModel = await rehydrateManagedProviderAgents({
  listTeams: async () => ['default'],
  listAgents: async () => [{
    id: 'stale-local-model',
    name: 'local-worker',
    runtime: 'provider:ollama',
    model: 'removed-model:latest',
    metadata: { managerRestartRequested: true },
  }],
  resolveAssignment: () => ({
    providerName: 'ollama',
    availableModels: ['installed-model:latest'],
    provider: {
      name: 'ollama',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    },
  }),
  rebindAndResume: async () => {
    throw new Error('an unavailable model must not be resumed');
  },
});
assert.deepEqual(missingModel, {
  attempted: 1,
  resumed: 0,
  issues: [{
    team: 'default',
    agent: 'local-worker',
    provider: 'ollama',
    model: 'removed-model:latest',
    reason: 'provider_model_unavailable',
  }],
});
assert.match(providerRehydrationActionMessage(missingModel) || '', /currently installed models/i);

let settlingAttempts = 0;
const settlingWaits: number[] = [];
const settled = await settleProviderRuntimeRehydration({
  resume: async () => {
    settlingAttempts += 1;
    if (settlingAttempts < 3) return { attempted: 0, resumed: 0, issues: [] };
    return { attempted: 1, resumed: 1, issues: [] };
  },
  wait: async (delayMs) => { settlingWaits.push(delayMs); },
});
assert.deepEqual(settled, { attempted: 1, resumed: 1, issues: [] });
assert.equal(settlingAttempts, 3);
assert.deepEqual(settlingWaits, [500, 1000]);

let retryableAttempts = 0;
const recoveredRetry = await settleProviderRuntimeRehydration({
  resume: async () => {
    retryableAttempts += 1;
    return retryableAttempts === 1
      ? { attempted: 1, resumed: 0, issues: [{ team: 'default', agent: 'worker', reason: 'manager_rebind_failed' }] }
      : { attempted: 1, resumed: 1, issues: [] };
  },
  wait: async () => {},
});
assert.equal(retryableAttempts, 2);
assert.deepEqual(recoveredRetry, { attempted: 1, resumed: 1, issues: [] });

const failed = await rehydrateManagedProviderAgents({
  listTeams: async () => ['default'],
  listAgents: async () => [{
    id: 'failed-provider',
    name: 'failed-agent',
    runtime: 'provider:openrouter',
    metadata: { managerRestartRequested: true },
  }],
  resolveAssignment: () => ({
    providerName: 'openrouter',
    provider: {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: secret,
    },
  }),
  rebindAndResume: async () => {
    throw new Error(`manager response accidentally contained ${secret}`);
  },
});
assert.deepEqual(failed, {
  attempted: 1,
  resumed: 0,
  issues: [{
    team: 'default',
    agent: 'failed-agent',
    provider: 'openrouter',
    reason: 'manager_rebind_failed',
  }],
});
assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));

const inventoryFailure = await rehydrateManagedProviderAgents({
  listTeams: async () => {
    throw new Error(`inventory accidentally contained ${secret}`);
  },
  listAgents: async () => [],
  resolveAssignment: () => null,
  rebindAndResume: async () => ({ resumed: false }),
});
assert.deepEqual(inventoryFailure, {
  attempted: 0,
  resumed: 0,
  issues: [{
    team: 'all teams',
    reason: 'fleet_inventory_unavailable',
  }],
});
assert.doesNotMatch(JSON.stringify(inventoryFailure), new RegExp(secret));

const abortController = new AbortController();
let signalListAgentsStarted!: () => void;
const listAgentsStarted = new Promise<void>((resolve) => {
  signalListAgentsStarted = resolve;
});
let rebindAfterAbort = false;
const aborted = rehydrateManagedProviderAgents({
  listTeams: async (signal) => {
    assert.equal(signal, abortController.signal);
    return ['default'];
  },
  listAgents: async (_team, signal) => {
    assert.equal(signal, abortController.signal);
    signalListAgentsStarted();
    return await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('inventory request cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  },
  resolveAssignment: () => null,
  rebindAndResume: async () => {
    rebindAfterAbort = true;
    return { resumed: true };
  },
}, abortController.signal);
await listAgentsStarted;
abortController.abort();
await assert.rejects(aborted, { name: 'AbortError' });
assert.equal(rebindAfterAbort, false);

const bridgeSource = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../src/main/providerRuntimeRehydration.ts', import.meta.url), 'utf8');
const stackSource = readFileSync(new URL('../src/main/unifiedStack.ts', import.meta.url), 'utf8');
const managerSourcePath = process.env.IDACC_MANAGER_SOURCE
  ? join(process.env.IDACC_MANAGER_SOURCE, 'src', 'agent-manager-db.ts')
  : new URL('../../.runtime-sources/manager/src/agent-manager-db.ts', import.meta.url);
const managerSource = existsSync(managerSourcePath)
  ? readFileSync(managerSourcePath, 'utf8')
  : null;
assert.doesNotMatch(
  bridgeSource,
  /keyEnv:\s*providerLaneEnvName/,
  'desktop provider assignments must hand off decrypted credentials inline without persisting a synthetic env reference',
);
assert.match(mainSource, /subscribeUnifiedStackServiceReady\(\(event\) => \{/);
assert.match(mainSource, /event\.name !== 'manager'/);
assert.match(mainSource, /rehydrateProviderAgentsForReadyManager\(\)/);
assert.match(mainSource, /resumeProviderAgentsWithStartupRetry\(abort\.signal\)/);
assert.match(providerSource, /issue\.reason === 'manager_rebind_failed'/);
assert.match(mainSource, /settleProviderRuntimeRehydration/);
assert.match(mainSource, /providerRuntimeRehydrationAbort\?\.abort\(\)/);
assert.ok(
  (stackSource.match(/notifyServiceReady\(service\)/g) || []).length >= 2,
  'both watchdog and explicit status probes must announce a verified Manager generation',
);
if (process.env.IDACC_REQUIRE_MANAGER_POLICY_SOURCE === '1') {
  assert.ok(managerSource, 'the pinned Manager policy source is required for this cross-component gate');
}
if (managerSource) {
  assert.match(managerSource, /providerRuntimeHasLaunchBinding/);
  assert.match(managerSource, /providerRuntimeHasDurableEnvironmentBinding/);
  assert.match(managerSource, /resumeAfterManagerRestart/);
}

console.log('provider runtime restart rehydration smoke passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
