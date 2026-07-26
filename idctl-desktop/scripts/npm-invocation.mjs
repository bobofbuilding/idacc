import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  join,
  resolve,
} from 'node:path';

function isNpmCliName(path) {
  return /^npm(?:-cli)?\.(?:c?js)$/i.test(basename(path));
}

function regularFile(path, fileExists, lstat) {
  if (!path || !fileExists(path)) return false;
  try {
    const stat = lstat(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve npm's JavaScript entrypoint so child_process never has to execute a
 * Windows `.cmd` shim directly. npm sets npm_execpath for npm-run scripts; the
 * remaining candidates cover direct `node stage-unified-runtime.mjs` calls.
 */
export function resolveNpmCli(options = {}) {
  const {
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
    fileExists = existsSync,
    lstat = lstatSync,
    realpath = realpathSync,
  } = options;
  const candidates = [];
  const seen = new Set();
  const add = (path) => {
    if (!path) return;
    const absolute = resolve(path);
    const key = platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(absolute);
  };

  add(env.npm_execpath);
  add(env.NPM_CLI_JS);

  const executableDirectory = dirname(execPath);
  const executableRoot = dirname(executableDirectory);
  for (const candidate of [
    join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(executableRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(executableRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(executableRoot, 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ]) add(candidate);

  const pathEntries = String(env.PATH || env.Path || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const candidate of [
      join(entry, 'npm'),
      join(entry, 'npm.cmd'),
      join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      resolve(entry, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      resolve(entry, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
    ]) add(candidate);
  }

  for (const candidate of candidates) {
    if (!regularFile(candidate, fileExists, lstat)) continue;
    try {
      const resolved = realpath(candidate);
      if (isNpmCliName(resolved) && regularFile(resolved, fileExists, lstat)) {
        return resolved;
      }
    } catch {
      // Continue through deterministic candidates.
    }
  }
  return '';
}

function assertSafeFallbackArgs(args) {
  if (!args.every((arg) => typeof arg === 'string' && /^[A-Za-z0-9@._=:+/-]+$/.test(arg))) {
    throw new Error('npm command-shell fallback received an unsafe argument');
  }
}

/**
 * Return a shell-free npm invocation whenever its CLI can be resolved.
 * Windows retains a constrained cmd.exe fallback because npm ships npm.cmd,
 * not a directly executable npm binary, in standard Node distributions.
 */
export function npmInvocation(npmArgs, options = {}) {
  const {
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
  } = options;
  const args = [...npmArgs];
  const cli = resolveNpmCli({ ...options, env, execPath, platform });
  if (cli) {
    return {
      command: execPath,
      args: [cli, ...args],
      source: 'resolved-cli',
      cli,
    };
  }

  if (platform === 'win32') {
    assertSafeFallbackArgs(args);
    const command = String(env.ComSpec || env.COMSPEC || 'cmd.exe').trim();
    if (!command) throw new Error('npm CLI could not be resolved and ComSpec is unavailable');
    return {
      command,
      args: ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')],
      source: 'windows-command-shell',
      cli: '',
    };
  }

  // POSIX npm launchers are executable shebang scripts. This fallback is for
  // uncommon installations where their real npm-cli.js target is hidden.
  return {
    command: 'npm',
    args,
    source: 'posix-executable',
    cli: '',
  };
}
