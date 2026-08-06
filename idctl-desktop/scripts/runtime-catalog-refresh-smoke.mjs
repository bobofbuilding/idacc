#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getRuntimeCatalogSnapshot,
  primeRuntimeCatalogSnapshot,
} from '../src/renderer/runtimeCatalogCache.ts';

const originalNow = Date.now;
try {
  Date.now = () => 1_000;
  primeRuntimeCatalogSnapshot(4, {
    modelCatalog: { codex: ['gpt-test'] },
    providers: [],
    managedRuntimes: {},
    freshness: [],
  });
  assert.ok(getRuntimeCatalogSnapshot(4, { maxAgeMs: 5_000, freshness: true }));

  Date.now = () => 7_000;
  assert.equal(getRuntimeCatalogSnapshot(4, { maxAgeMs: 5_000, freshness: true }), null, 'same-version snapshots must expire');
  assert.equal(getRuntimeCatalogSnapshot(5, { maxAgeMs: 10_000, freshness: true }), null, 'version changes must invalidate immediately');
} finally {
  Date.now = originalNow;
}

const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const agentTable = readFileSync(new URL('../src/renderer/views/AgentTable.tsx', import.meta.url), 'utf8');
const teams = readFileSync(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');
assert.match(bridge, /runtimeModelCache/, 'subscription CLI model ids must survive app restarts in the settings cache');
assert.match(bridge, /savedCliModelInfo\(runtime\)/, 'normal catalog reads must hydrate the saved CLI model cache');
assert.doesNotMatch(main, /startModelRefreshLoop|model-refresh/, 'startup must not schedule background model discovery');
assert.doesNotMatch(agentTable, /setInterval|addEventListener\('focus'|runtime:probeLocal/, 'the fleet picker must not re-probe models on timers or focus');
assert.match(agentTable, /'runtime:probe'/, 'the model panel must retain an explicit full refresh action');
assert.match(teams, /loadRuntimeCatalogSnapshot\(hrRuntimeCatalogVersion\)/, 'Teams Build must use the shared cache on open');
assert.match(teams, /call<Record<string, string\[\]>>\('runtime:probe'\)/, 'Teams Build must refresh only after an explicit action');

console.log('runtime catalog cache policy smoke: ok');
