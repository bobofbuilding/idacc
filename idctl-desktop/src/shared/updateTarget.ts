export interface UpdateTargetReadiness {
  ok: boolean;
  reason?: string;
}

export function evaluateUpdateTarget(input: {
  isPackaged: boolean;
  bundlePath: string;
  appAsarExists: boolean;
}): UpdateTargetReadiness {
  if (!input.isPackaged) return { ok: false, reason: 'run a packaged application build to use self-update' };
  if (!/\.app\/?$/i.test(input.bundlePath.trim())) return { ok: false, reason: 'the running process is not inside a macOS application bundle' };
  if (!input.appAsarExists) return { ok: false, reason: 'the application bundle is incomplete (app.asar is missing)' };
  return { ok: true };
}
