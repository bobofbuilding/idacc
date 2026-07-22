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
assert.match(bridge, /readCallCache\.clear\(\);\s*onRefresh\(scope\)/, 'background refresh must invalidate reads and notify the shell');
assert.match(main, /startModelRefreshLoop\(\(\) => publishStoreChange\('runtime:probe'\)\)/, 'main process must publish runtime-catalog changes');

console.log('runtime catalog auto-refresh smoke: ok');
