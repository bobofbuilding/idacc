import assert from 'node:assert/strict';
import { BrainClient, type BrainTransportRequest } from './brain.ts';
import { ManagerClient } from './client.ts';

const attempts: BrainTransportRequest[] = [];
const brain = new BrainClient({
  transport: async (request) => {
    attempts.push(request);
    if (attempts.length === 1) throw new Error('transient manager failure');
    return { body: { ok: true }, cacheControl: 'no-store', noStore: true };
  },
});

assert.equal(await brain.timeline({ type: 'control:test', subject: 'test' }), true);
assert.equal(attempts.length, 2);
assert.equal(attempts[0].idempotency_key, attempts[1].idempotency_key);
assert.match(attempts[0].idempotency_key ?? '', /^idacc:/);

const originalFetch = globalThis.fetch;
let captured: { url: string; init?: RequestInit } | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  captured = { url: String(input), init };
  return new Response(JSON.stringify({
    ok: true,
    body: { memories: [] },
    cacheControl: 'no-store',
    noStore: true,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

try {
  const manager = new ManagerClient({
    managerUrl: 'http://127.0.0.1:4100',
    team: 'default',
    admin: true,
    refreshMs: 3_000,
    waitSeconds: 25,
  });
  const result = await manager.brainRequest({ method: 'GET', path: '/memory/shared?limit=8' });
  assert.deepEqual(result.body, { memories: [] });
  assert.equal(captured?.url, 'http://127.0.0.1:4100/control/brain');
  assert.equal(new Headers(captured?.init?.headers).get('x-id-admin'), '1');
  assert.equal(new Headers(captured?.init?.headers).get('x-id-team'), 'default');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), { method: 'GET', path: '/memory/shared?limit=8' });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('[brainTransport.test] OK');
