import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export interface ComputerUseWorkLease {
  readonly generation: number;
  isCurrent(): boolean;
  finish(): void;
}

export interface ComputerUseRequestLifecycle {
  openAdmission(): void;
  closeAdmission(): void;
  invalidateActiveWork(): void;
  begin(): ComputerUseWorkLease | null;
  isAccepting(): boolean;
  activeCount(): number;
  drain(timeoutMs: number): Promise<boolean>;
}

/**
 * Generation-bound admission and drain barrier for Computer Use work.
 *
 * Closing or invalidating the gate makes every previously admitted lease stale
 * synchronously. Callers must re-check their lease after each await before
 * exposing a captured frame, executing input, writing audit state, or replying.
 */
export function createComputerUseRequestLifecycle(): ComputerUseRequestLifecycle {
  let accepting = false;
  let generation = 0;
  let active = 0;
  const idleWaiters = new Set<() => void>();

  const notifyIdle = (): void => {
    if (active !== 0) return;
    for (const resolve of [...idleWaiters]) resolve();
  };

  return {
    openAdmission: () => {
      generation += 1;
      accepting = true;
    },
    closeAdmission: () => {
      generation += 1;
      accepting = false;
    },
    invalidateActiveWork: () => {
      generation += 1;
    },
    begin: () => {
      if (!accepting) return null;
      const admittedGeneration = generation;
      active += 1;
      let finished = false;
      return {
        generation: admittedGeneration,
        isCurrent: () => (
          !finished
          && accepting
          && generation === admittedGeneration
        ),
        finish: () => {
          if (finished) return;
          finished = true;
          active = Math.max(0, active - 1);
          notifyIdle();
        },
      };
    },
    isAccepting: () => accepting,
    activeCount: () => active,
    drain: async (timeoutMs) => {
      if (active === 0) return true;
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (drained: boolean): void => {
          idleWaiters.delete(onIdle);
          if (timer) clearTimeout(timer);
          timer = null;
          resolve(drained);
        };
        const onIdle = (): void => finish(true);
        idleWaiters.add(onIdle);
        timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      });
    },
  };
}

export function trackComputerUseServerSockets(
  server: Server,
  sockets: Set<Socket>,
): void {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
}

/**
 * Stop listener admission and abort every existing connection, including a
 * client that never finishes its request body. Resolves false on the bounded
 * deadline and throws only for a concrete listener-close error.
 */
export async function closeComputerUseServer(
  server: Server | null,
  sockets: Set<Socket>,
  timeoutMs: number,
): Promise<boolean> {
  if (!server) return true;
  let closeError: unknown;
  const closed = new Promise<void>((resolve) => {
    try {
      server.close((error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (error && code !== 'ERR_SERVER_NOT_RUNNING') closeError = error;
        resolve();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') {
        closeError = error;
      }
      resolve();
    }
  });

  try { server.closeIdleConnections(); } catch { /* explicit sockets are the backstop */ }
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* already closed */ }
  }
  try { server.closeAllConnections(); } catch { /* explicit sockets are the backstop */ }

  const settled = await new Promise<boolean>((resolve) => {
    let complete = false;
    const finish = (result: boolean): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    closed.then(() => finish(true));
  });
  if (closeError) throw closeError;
  return settled;
}
