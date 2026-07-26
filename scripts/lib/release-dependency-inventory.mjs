import {
  existsSync,
  lstatSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

function portablePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function safePackagePath(value) {
  const path = portablePath(value);
  return Boolean(
    path
    && !isAbsolute(path)
    && !path.startsWith('/')
    && !path.split('/').includes('..')
  );
}

function packagePathIsExcluded(packagePath, roots) {
  return roots.some((root) => packagePath === root || packagePath.startsWith(`${root}/`));
}

function literalPackageExclusion(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('!node_modules/')) return '';
  const path = portablePath(pattern.slice(1))
    .replace(/\{,\/\*\*\/\*\}$/, '')
    .replace(/\/\*\*\/\*$/, '')
    .replace(/\/\*\*$/, '');
  if (!safePackagePath(path) || /[*?[\]{}]/.test(path)) return '';
  return path;
}

/**
 * Return literal package roots that electron-builder explicitly removes from
 * this platform's packaged application. Positive `files` patterns are not an
 * inventory: most desktop dependencies are bundled into `out` by esbuild.
 */
export function desktopPackagedExclusionRoots(packageJson, platform) {
  const platformKey = {
    darwin: 'mac',
    win32: 'win',
    linux: 'linux',
  }[platform];
  const patterns = [
    ...(Array.isArray(packageJson?.build?.files) ? packageJson.build.files : []),
    ...(platformKey && Array.isArray(packageJson?.build?.[platformKey]?.files)
      ? packageJson.build[platformKey].files
      : []),
  ];
  return [...new Set(patterns.map(literalPackageExclusion).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Select production package-lock records that exist in the exact install tree
 * used for packaging. npm lockfiles retain records for optional packages for
 * other operating systems and architectures; those absent directories are not
 * shipped and must not be asserted in an SBOM or notice inventory.
 */
export function installedProductionPackageEntries(
  packageLock,
  installRoot,
  { excludedPackageRoots = [] } = {},
) {
  const roots = [...new Set(excludedPackageRoots.map(portablePath).filter(safePackagePath))]
    .sort((left, right) => left.localeCompare(right));
  const selected = [];

  for (const [rawPackagePath, record] of Object.entries(packageLock?.packages || {})) {
    if (!rawPackagePath || !record || typeof record !== 'object' || record.dev === true) continue;
    const packagePath = portablePath(rawPackagePath);
    if (!safePackagePath(packagePath)) {
      throw new Error(`package lock contains an unsafe package path: ${rawPackagePath}`);
    }
    if (packagePathIsExcluded(packagePath, roots)) continue;
    const installedPath = join(installRoot, ...packagePath.split('/'));
    if (!existsSync(installedPath)) continue;
    const stat = lstatSync(installedPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    selected.push({ packagePath, record });
  }

  return selected.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}
