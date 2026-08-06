export function parentPidFromEnv(env = process.env, selfPid = process.pid) {
  const pid = Number(env.IDACC_PARENT_PID);
  return Number.isInteger(pid) && pid > 0 && pid !== selfPid ? pid : null;
}

export function processPidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return error?.code === 'EPERM';
  }
}

/**
 * Run a managed service's shutdown callback once if its explicit supervisor
 * disappears. Standalone Brain processes do not set IDACC_PARENT_PID.
 */
export function startParentDeathWatchdog(onParentExit, options = {}) {
  const parentPid = options.parentPid === undefined
    ? parentPidFromEnv()
    : options.parentPid;
  if (!parentPid || parentPid === process.pid) return () => {};

  const isAlive = options.isAlive ?? processPidIsAlive;
  const intervalMs = Math.max(50, Math.floor(options.intervalMs ?? 1_000));
  let fired = false;
  const timer = setInterval(() => {
    if (fired || isAlive(parentPid)) return;
    fired = true;
    clearInterval(timer);
    Promise.resolve(onParentExit()).catch((error) => {
      console.error('[brain] Parent-death shutdown failed:', error);
    });
  }, intervalMs);
  timer.unref?.();
  return () => {
    fired = true;
    clearInterval(timer);
  };
}
