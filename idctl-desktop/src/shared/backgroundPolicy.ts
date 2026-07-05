/**
 * Background worker timing policy.
 *
 * Keep user-visible work responsive through event/write kicks, but avoid
 * needlessly waking idle workers that only poll local state.
 */

export const LEARN_QUEUE_RUNNER_DELAYS = Object.freeze({
  bootMs: 2_000,
  idleMs: 5 * 60_000,
  activeProcessingMs: 30_000,
  activeProcessingWithQueuedMs: 15_000,
  remainingQueuedMs: 750,
  alreadyRunningMs: 2_000,
  retryMs: 90_000,
  queuedWriteKickMs: 100,
  terminalWriteKickMs: 250,
});

export const LEARN_BRAIN_BACKFILL_RUNNER_DELAYS = Object.freeze({
  bootMs: 12_000,
  idleMs: 10 * 60_000,
  activeMs: 45_000,
  alreadyRunningMs: 15_000,
  retryMs: 5 * 60_000,
  materialReadyKickMs: 250,
  materialWriteKickMs: 500,
});

