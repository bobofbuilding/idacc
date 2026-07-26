import { extname, join } from 'node:path';

const DEFAULT_WINDOWS_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

export interface ExecutableCandidateOptions {
  platform?: NodeJS.Platform;
  pathExt?: string;
}

export function executableExtensions(
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32') return [''];
  return Array.from(new Set(
    (pathExt || DEFAULT_WINDOWS_PATH_EXT)
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => `${value.startsWith('.') ? '' : '.'}${value}`.toLowerCase()),
  ));
}

export function executableCandidatePaths(
  directory: string,
  binary: string,
  options: ExecutableCandidateOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const extensions = platform === 'win32' && !extname(binary)
    ? executableExtensions(platform, options.pathExt)
    : [''];
  return extensions.map((extension) => join(directory, `${binary}${extension}`));
}

export function executableRequiresShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}

export function installCommandSupported(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = String(command ?? '').trim();
  if (!normalized) return false;
  if (platform !== 'win32') return true;
  return !/(?:^|[|&;\s])(?:ba)?sh(?:\s|$)|\|\s*(?:ba)?sh\b/i.test(normalized);
}

export function terminalAutomationSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin';
}
