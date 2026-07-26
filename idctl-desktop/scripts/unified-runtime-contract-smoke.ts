import assert from 'node:assert/strict';
import { listenerCursorAdvancedFromRelay } from '../src/main/unifiedRuntimeContractSelftest.ts';

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

process.stdout.write('unified runtime contract smoke: ok\n');
