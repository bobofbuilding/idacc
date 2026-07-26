export type AppShutdownIntent =
  | { kind: 'quit' }
  | { kind: 'exit'; code: number }
  | { kind: 'relaunch' }
  | { kind: 'install-update' };

export interface AppShutdownEvent {
  preventDefault(): void;
}

export interface AppShutdownHost {
  prependListener(event: 'before-quit', listener: (event: AppShutdownEvent) => void): unknown;
  once(event: 'will-quit', listener: () => void): unknown;
  quit(): void;
  exit(code: number): void;
  relaunch(): void;
}

export interface AppShutdownCoordinatorOptions {
  app: AppShutdownHost;
  cleanup: () => Promise<void> | void;
  installPreparedUpdate: () => void;
  onError?: (error: unknown) => void;
  updateQuitFallbackMs?: number;
}

export interface AppShutdownCoordinator {
  isQuiescing(): boolean;
  intent(): AppShutdownIntent | null;
  status(): AppShutdownStatus;
  request(intent: AppShutdownIntent): Promise<void>;
  retry(): Promise<void>;
}

export type AppShutdownPhase = 'running' | 'quiescing' | 'cleanup-failed' | 'finalizing';

export interface AppShutdownStatus {
  phase: AppShutdownPhase;
  intent: AppShutdownIntent | null;
  cleanupAttempts: number;
}

export interface BoundedWorkDrain {
  activeCount(): number;
  begin(): () => void;
  drain(): Promise<boolean>;
}

export type ShutdownReentryDisposition = 'normal' | 'recover-cleanup' | 'ignore';

export function shutdownReentryDisposition(
  phase: AppShutdownPhase,
): ShutdownReentryDisposition {
  if (phase === 'running') return 'normal';
  if (phase === 'cleanup-failed') return 'recover-cleanup';
  return 'ignore';
}

/**
 * Select primary cleanup only after this process has won Electron's
 * single-instance lock. A losing secondary has no owned services and exits
 * without invoking any primary cleanup closure.
 */
export function cleanupOwnedPrimaryInstance(
  ownsSingleInstanceLock: boolean,
  cleanup: () => Promise<void> | void,
): Promise<void> {
  if (!ownsSingleInstanceLock) return Promise.resolve();
  return Promise.resolve().then(cleanup);
}

const DEFAULT_UPDATE_QUIT_FALLBACK_MS = 5_000;

/**
 * Observe whether already-admitted work settles before a shared shutdown
 * deadline. Rejection still counts as settled; the owning drain remains
 * responsible for surfacing the captured error.
 */
export function workSettledWithin(
  work: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    Promise.resolve(work).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/**
 * Track work accepted before quiescence and give it a bounded opportunity to
 * finish before process-owned services are stopped.
 */
export function createBoundedWorkDrain(timeoutMs: number): BoundedWorkDrain {
  let active = 0;
  const waiters = new Set<(drained: boolean) => void>();

  return {
    activeCount: () => active,
    begin: () => {
      active += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        active = Math.max(0, active - 1);
        if (active !== 0) return;
        for (const resolve of [...waiters]) resolve(true);
      };
    },
    drain: async () => {
      if (active === 0) return true;
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (drained: boolean) => {
          waiters.delete(finish);
          if (timer) clearTimeout(timer);
          timer = null;
          resolve(drained);
        };
        waiters.add(finish);
        timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      });
    },
  };
}

/**
 * Own every process-terminal path from application bootstrap onward.
 *
 * The first terminal intent wins. Only one cleanup attempt runs at a time, and
 * Electron remains quiesced after failure until that same intent is retried.
 */
export function createAppShutdownCoordinator(
  options: AppShutdownCoordinatorOptions,
): AppShutdownCoordinator {
  const {
    app,
    cleanup,
    installPreparedUpdate,
    onError,
    updateQuitFallbackMs = DEFAULT_UPDATE_QUIT_FALLBACK_MS,
  } = options;
  let selectedIntent: AppShutdownIntent | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let phase: AppShutdownPhase = 'running';
  let cleanupAttempts = 0;

  const report = (error: unknown): void => {
    try { onError?.(error); } catch { /* shutdown must continue even if reporting fails */ }
  };

  const quit = (): void => {
    try {
      app.quit();
    } catch (error) {
      report(error);
      app.exit(1);
    }
  };

  const finalize = (intent: AppShutdownIntent): void => {
    phase = 'finalizing';
    if (intent.kind === 'exit') {
      app.exit(intent.code);
      return;
    }
    if (intent.kind === 'relaunch') {
      try {
        app.relaunch();
      } catch (error) {
        report(error);
      }
      quit();
      return;
    }
    if (intent.kind === 'install-update') {
      let fallback: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        fallback = null;
        quit();
      }, Math.max(0, updateQuitFallbackMs));
      app.once('will-quit', () => {
        if (fallback) clearTimeout(fallback);
        fallback = null;
      });
      try {
        installPreparedUpdate();
      } catch (error) {
        if (fallback) clearTimeout(fallback);
        fallback = null;
        report(error);
        quit();
      }
      return;
    }
    quit();
  };

  const attemptCleanup = (): Promise<void> => {
    if (!selectedIntent) return Promise.resolve();
    const intent = selectedIntent;
    phase = 'quiescing';
    cleanupAttempts += 1;
    shutdownPromise = Promise.resolve()
      .then(cleanup)
      .then(() => finalize(intent))
      .catch((error) => {
        phase = 'cleanup-failed';
        report(error);
      });
    return shutdownPromise;
  };

  const request = (intent: AppShutdownIntent): Promise<void> => {
    if (phase === 'cleanup-failed') return attemptCleanup();
    if (phase !== 'running') return shutdownPromise ?? Promise.resolve();
    selectedIntent = intent;
    return attemptCleanup();
  };

  // Register during module bootstrap so menu, keyboard, OS-session, and updater
  // quits cannot race ahead of the cleanup gate while startup is still running.
  app.prependListener('before-quit', (event) => {
    if (phase === 'finalizing') return;
    event.preventDefault();
    void request({ kind: 'quit' });
  });

  return {
    isQuiescing: () => phase !== 'running',
    intent: () => selectedIntent,
    status: () => ({ phase, intent: selectedIntent, cleanupAttempts }),
    request,
    retry: () => {
      if (phase !== 'cleanup-failed') return shutdownPromise ?? Promise.resolve();
      return attemptCleanup();
    },
  };
}
