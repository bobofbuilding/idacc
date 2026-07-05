import assert from 'node:assert/strict';
import { ManagerClient } from './client.ts';

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Headers }> = [];
let fallbackMode = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  calls.push({ url, headers: new Headers(init?.headers) });
  if (fallbackMode && url.endsWith('/tasks?status=done&limit=2')) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (fallbackMode && url.endsWith('/remote')) {
    return new Response(JSON.stringify({
      ok: true,
      result: {
        tasks: [
          { shortId: '#old00001', title: 'Old done row', status: 'done', createdAt: 1, completedAt: 10 },
          { shortId: '#todo0001', title: 'Todo row', status: 'todo', createdAt: 40 },
          { shortId: '#new00001', title: 'New done row', status: 'completed', createdAt: 2, completedAt: 30 },
          { shortId: '#mid00001', title: 'Middle done row', status: 'done', createdAt: 3, completedAt: 20 },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    tasks: [
      { shortId: '#done0001', title: 'Done row', status: 'done', createdAt: 1 },
      { shortId: '#done0002', title: 'Older done row', status: 'completed', createdAt: 0 },
      { shortId: '#todo0001', title: 'Todo row', status: 'todo', createdAt: 2 },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

try {
  const client = new ManagerClient({
    managerUrl: 'http://127.0.0.1:4100',
    team: 'ops-team',
    admin: true,
    refreshMs: 3000,
    waitSeconds: 25,
  });

  const rows = await client.tasksByStatus('done', { limit: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].shortId, '#done0001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4100/tasks?status=done&limit=1');
  assert.equal(calls[0].headers.get('x-id-team'), 'ops-team');
  assert.equal(calls[0].headers.get('x-id-admin'), '1');

  calls.length = 0;
  fallbackMode = true;
  const fallbackRows = await client.tasksByStatus('done', { limit: 2 });

  assert.deepEqual(fallbackRows.map((row) => row.shortId), ['#new00001', '#mid00001']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:4100/tasks?status=done&limit=2');
  assert.equal(calls[1].url, 'http://127.0.0.1:4100/remote');
  assert.equal(calls[1].headers.get('x-id-team'), 'ops-team');
  assert.equal(calls[1].headers.get('x-id-admin'), '1');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('[tasksByStatus.test] OK');
