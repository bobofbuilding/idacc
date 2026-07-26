export interface SingleFlightBackgroundGate {
  isStopped(): boolean;
  run(work: () => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
}

export interface DelayedBackgroundWork {
  activeCount(): number;
  isStopped(): boolean;
  schedule(delayMs: number, work: () => Promise<void> | void): boolean;
  stop(): Promise<void>;
}

export interface TrackedBackgroundWork {
  activeCount(): number;
  isStopped(): boolean;
  run(work: () => Promise<unknown> | unknown): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Admit at most one background pass at a time. `stop()` closes admission
 * synchronously and resolves only after the already-admitted pass settles.
 */
export function createSingleFlightBackgroundGate(): SingleFlightBackgroundGate {
  let stopped = false;
  let active: Promise<void> | null = null;

  return {
    isStopped: () => stopped,
    run: (work) => {
      if (stopped) return Promise.resolve();
      if (active) return active;
      const pending = Promise.resolve().then(work);
      const tracked = pending.finally(() => {
        if (active === tracked) active = null;
      });
      active = tracked;
      return tracked;
    },
    stop: () => {
      stopped = true;
      return active ?? Promise.resolve();
    },
  };
}

/**
 * Own delayed one-shot background work. Stop cancels every pending timer
 * synchronously and drains work whose timer already fired.
 */
export function createDelayedBackgroundWork(): DelayedBackgroundWork {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Set<Promise<void>>();

  return {
    activeCount: () => active.size,
    isStopped: () => stopped,
    schedule: (delayMs, work) => {
      if (stopped) return false;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        const run = Promise.resolve().then(work);
        active.add(run);
        void run.then(
          () => { active.delete(run); },
          () => { active.delete(run); },
        );
      }, Math.max(0, delayMs));
      timers.add(timer);
      timer.unref?.();
      return true;
    },
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const admitted = [...active];
      return Promise.all(admitted).then(() => undefined);
    },
  };
}

/**
 * Own an arbitrary number of best-effort background writes. Work is admitted
 * through a factory so `stop()` can close admission synchronously before any
 * later Manager or Brain request is created, while still waiting for every
 * request that was already accepted.
 */
export function createTrackedBackgroundWork(): TrackedBackgroundWork {
  let stopped = false;
  const active = new Set<Promise<void>>();

  return {
    activeCount: () => active.size,
    isStopped: () => stopped,
    run: (work) => {
      if (stopped) return Promise.resolve();
      const pending = Promise.resolve()
        .then(work)
        .then(
          () => undefined,
          () => undefined,
        );
      active.add(pending);
      void pending.then(() => {
        active.delete(pending);
      });
      return pending;
    },
    stop: () => {
      stopped = true;
      return Promise.all([...active]).then(() => undefined);
    },
  };
}
