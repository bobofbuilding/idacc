export interface UpdateTargetReadiness {
  ok: boolean;
  reason?: string;
}

export function evaluateUpdateTarget(input: {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  bundlePath: string;
  appAsarExists: boolean;
  appImagePath?: string;
}): UpdateTargetReadiness {
  if (!input.isPackaged) return { ok: false, reason: 'run a packaged application build to use self-update' };
  const platform = input.platform ?? 'darwin';
  if (!['darwin', 'win32', 'linux'].includes(platform)) return { ok: false, reason: `self-update is unsupported on ${platform}` };
  if (platform === 'darwin' && !/\.app\/?$/i.test(input.bundlePath.trim())) {
    return { ok: false, reason: 'the running process is not inside a macOS application bundle' };
  }
  if (platform === 'linux' && !input.appImagePath?.trim()) {
    return {
      ok: false,
      reason: 'Linux self-update requires the AppImage build; .deb and other package-manager installs update through the system package manager',
    };
  }
  if (!input.appAsarExists) return { ok: false, reason: 'the application bundle is incomplete (app.asar is missing)' };
  return { ok: true };
}
