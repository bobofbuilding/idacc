import assert from 'node:assert/strict';
import { ManagerClient } from './client.ts';

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method?: string; body?: string | null }> = [];

try {
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : null });
    return new Response(JSON.stringify({
      ok: true,
      runtime: 'claude-code-cli',
      model: '',
      issues: [],
      detail: '',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const client = new ManagerClient({ managerUrl: 'http://127.0.0.1:4100', refreshMs: 3000, waitSeconds: 25 });
  const result = await client.runtimePreflight('claude-code-cli');
  assert.equal(result?.ok, true);
  assert.equal(result?.runtime, 'claude-code-cli');
  assert.equal(result?.model, '');
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4100/runtime/preflight');
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0]?.body ?? '{}'), { runtime: 'claude-code-cli' });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(await client.runtimePreflight('codex'), null);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('[runtimePreflight.test] OK');
