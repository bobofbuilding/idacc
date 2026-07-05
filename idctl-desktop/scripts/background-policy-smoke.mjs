import assert from 'node:assert/strict';
import { LEARN_BRAIN_BACKFILL_RUNNER_DELAYS, LEARN_QUEUE_RUNNER_DELAYS } from '../src/shared/backgroundPolicy.ts';

assert.equal(LEARN_QUEUE_RUNNER_DELAYS.bootMs, 2_000, 'Learn queue should still recover shortly after app boot');
assert.equal(LEARN_QUEUE_RUNNER_DELAYS.queuedWriteKickMs, 100, 'new queued Learn material should process immediately');
assert.equal(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs, 250, 'terminal Learn updates should promptly drain/reconcile');
assert.equal(LEARN_QUEUE_RUNNER_DELAYS.remainingQueuedMs, 750, 'remaining queued Learn rows should drain in a tight controlled loop');
assert.equal(LEARN_QUEUE_RUNNER_DELAYS.activeProcessingWithQueuedMs, 15_000, 'queued rows behind an active processor should retry soon');
assert.equal(LEARN_QUEUE_RUNNER_DELAYS.activeProcessingMs, 30_000, 'active processing should be checked without tight polling');
assert.ok(
  LEARN_QUEUE_RUNNER_DELAYS.idleMs >= 5 * 60_000,
  'idle Learn queue polling should stay parked; material writes wake the runner directly',
);
assert.ok(
  LEARN_QUEUE_RUNNER_DELAYS.idleMs > LEARN_QUEUE_RUNNER_DELAYS.activeProcessingMs,
  'idle queue cadence should be slower than active-processing cadence',
);

assert.equal(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.bootMs, 12_000);
assert.equal(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs, 250);
assert.equal(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialWriteKickMs, 500);
assert.ok(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.idleMs >= 10 * 60_000);
