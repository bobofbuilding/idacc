import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderClient } from './ProviderClient.ts';
import {
  normalizeProviderBaseUrl,
  providerTransportDecision,
  providerUrlIsLoopback,
} from './providerTransport.ts';
import {
  loadSettings,
  resolveProviderKey,
  upsertProvider,
} from './store.ts';

assert.equal(normalizeProviderBaseUrl('https://API.EXAMPLE.com/v1/'), 'https://api.example.com/v1');
assert.equal(normalizeProviderBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
assert.equal(normalizeProviderBaseUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1');
assert.equal(normalizeProviderBaseUrl('http://[::1]:1234/v1'), 'http://[::1]:1234/v1');
assert.equal(providerUrlIsLoopback('https://127.0.0.1/v1'), true);

for (const rejected of [
  'http://example.com/v1',
  'http://127.1:8000/v1',
  'http://2130706433:8000/v1',
  'http://localhost.:8000/v1',
  'http://user:secret@localhost:8000/v1',
  'https://user:secret@example.com/v1',
  'https://example.com/v1?token=secret',
  'https://example.com/v1?',
  'https://example.com/v1#models',
  'https://example.com/v1#',
  'ftp://example.com/v1',
]) {
  assert.equal(providerTransportDecision(rejected).ok, false, `${rejected} must be rejected`);
  assert.throws(() => normalizeProviderBaseUrl(rejected));
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error('fetch must not run');
}) as typeof fetch;
try {
  const outcome = await new ProviderClient({
    name: 'legacy-insecure',
    kind: 'openai-compatible',
    baseUrl: 'http://models.example.com/v1',
    enabled: true,
  }, 'must-not-be-forwarded').probe();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'error');
  assert.equal(fetchCalls, 0, 'an insecure legacy provider must fail before fetch');
} finally {
  globalThis.fetch = originalFetch;
}

const scratch = mkdtempSync(join(tmpdir(), 'idacc-provider-transport-'));
try {
  const config = join(scratch, 'config.json');
  assert.throws(() => upsertProvider({
    name: 'insecure',
    kind: 'openai-compatible',
    baseUrl: 'http://models.example.com/v1',
    apiKey: 'must-not-persist',
    enabled: true,
  }, config), /Plain HTTP providers/);
  assert.equal(existsSync(config), false);

  upsertProvider({
    name: 'secure',
    kind: 'openai-compatible',
    baseUrl: 'https://API.EXAMPLE.com/v1/',
    enabled: true,
  }, config);
  assert.equal(loadSettings(config).providers[0]?.baseUrl, 'https://api.example.com/v1');

  writeFileSync(config, JSON.stringify({
    version: 1,
    managers: [],
    providers: [{
      name: 'legacy',
      kind: 'openai-compatible',
      baseUrl: 'http://models.example.com/v1',
      apiKey: 'legacy-secret',
      enabled: true,
      default: true,
    }],
  }));
  const legacy = loadSettings(config).providers[0];
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.default, false);
  assert.equal(resolveProviderKey(legacy), undefined);
  assert.match(readFileSync(config, 'utf8'), /legacy-secret/, 'load is non-destructive so the user can repair or remove the row');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('provider transport policy: ok');
