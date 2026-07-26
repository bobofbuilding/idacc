import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AppProfilePaths } from './appProfile.ts';

export interface ManagerRuntimeProfile {
  libraryRoot: string;
  skillsRoot: string;
  pluginsRoot: string;
  agentLogDir: string;
}

interface SeedState {
  schemaVersion: 1;
  catalogs: Record<string, Record<string, string>>;
}

const SEED_STATE_SCHEMA = 1;
const SEED_STATE_FILE = '.idacc-seed-state.json';

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function emptySeedState(): SeedState {
  return { schemaVersion: SEED_STATE_SCHEMA, catalogs: {} };
}

function readSeedState(path: string): SeedState {
  if (!existsSync(path)) return emptySeedState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeedState>;
    if (parsed.schemaVersion !== SEED_STATE_SCHEMA || !parsed.catalogs || typeof parsed.catalogs !== 'object') {
      return emptySeedState();
    }
    const catalogs: Record<string, Record<string, string>> = {};
    for (const [catalog, files] of Object.entries(parsed.catalogs)) {
      if (!files || typeof files !== 'object' || Array.isArray(files)) continue;
      catalogs[catalog] = Object.fromEntries(
        Object.entries(files).filter(([name, digest]) => (
          Boolean(name)
          && typeof digest === 'string'
          && /^[a-f0-9]{64}$/.test(digest)
        )),
      );
    }
    return { schemaVersion: SEED_STATE_SCHEMA, catalogs };
  } catch {
    // A missing/corrupt old ledger must never cause existing profile content to
    // be overwritten. The merge below treats every existing file as user-owned.
    return emptySeedState();
  }
}

function assertContained(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))) return;
  throw new Error(`Runtime seed path escapes its catalog root: ${path}`);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  assertContained(root, path);
  const relativeName = relative(resolve(root), resolve(path));
  let current = resolve(root);
  for (const component of relativeName ? relativeName.split(sep) : []) {
    current = join(current, component);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic link in the writable runtime profile: ${current}`);
    }
  }
}

function atomicWrite(path: string, content: Buffer | string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${path.split(sep).pop()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, content);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try { chmodSync(path, mode); } catch { /* best effort on filesystems without POSIX modes */ }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
  }
}

function sourceFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!existsSync(root)) return files;

  const walk = (directory: string): void => {
    assertContained(root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assertContained(root, path);
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundled runtime seed catalogs cannot contain symbolic links: ${path}`);
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Bundled runtime seed catalogs may contain only files and directories: ${path}`);
      }
      const name = relative(root, path).split(sep).join('/');
      files.set(name, readFileSync(path));
    }
  };

  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Bundled runtime seed catalog is not a real directory: ${root}`);
  }
  walk(root);
  return files;
}

function destinationPath(root: string, relativeName: string): string {
  const path = resolve(root, ...relativeName.split('/'));
  assertContained(root, path);
  assertNoSymlinkComponents(root, path);
  return path;
}

/**
 * Merge one immutable release catalog into its writable profile copy.
 *
 * The ledger records only the last bundled hash. A file is upgraded when its
 * profile copy still matches that hash; edited files and explicit deletions are
 * preserved. On the first ledger-aware release, pre-existing content is treated
 * as user-owned unless it already exactly matches the current seed.
 */
function mergeSeedCatalog(
  catalog: string,
  source: string,
  destination: string,
  state: SeedState,
): void {
  const bundled = sourceFiles(source);
  if (!bundled.size && !existsSync(source)) return;
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Writable runtime catalog is not a real directory: ${destination}`);
    }
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  try { chmodSync(destination, 0o700); } catch { /* best effort */ }

  const previous = state.catalogs[catalog] ?? {};
  const next: Record<string, string> = {};
  for (const [name, content] of bundled) {
    const bundledHash = sha256(content);
    const destinationFile = destinationPath(destination, name);
    const previousHash = previous[name];

    if (!existsSync(destinationFile)) {
      // A missing destination with a previous ledger entry represents an
      // intentional user deletion; a brand-new bundled path is installed.
      if (!previousHash) atomicWrite(destinationFile, content);
      next[name] = bundledHash;
      continue;
    }

    const destinationStat = lstatSync(destinationFile);
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`Refusing to follow a symbolic link in the writable runtime profile: ${destinationFile}`);
    }
    if (!destinationStat.isFile()) {
      throw new Error(`Runtime seed destination is not a regular file: ${destinationFile}`);
    }

    const installedHash = sha256(readFileSync(destinationFile));
    if (installedHash === bundledHash) {
      try { chmodSync(destinationFile, 0o600); } catch { /* best effort */ }
    } else if (previousHash && installedHash === previousHash) {
      atomicWrite(destinationFile, content);
    }
    // Otherwise this is a user edit (or a pre-ledger file), so preserve it.
    next[name] = bundledHash;
  }

  // Files removed from the release are retained in the profile as user data,
  // but removed from the managed ledger so a future same-name seed cannot
  // silently claim ownership.
  state.catalogs[catalog] = next;
}

/**
 * Materialize the Manager's writable catalog into the app-owned profile.
 * Bundled configs, skills, and plugins are immutable release inputs; user
 * installs and edits must never mutate the signed application payload.
 */
export function prepareManagerRuntimeProfile(
  runtimeManagerRoot: string,
  profile: AppProfilePaths,
): ManagerRuntimeProfile {
  const profileLibrary = join(profile.manager, 'library');
  const libraryRoot = join(profileLibrary, 'configs');
  const skillsRoot = join(profileLibrary, 'skills');
  const pluginsRoot = join(profileLibrary, 'plugins', 'claude-code');
  const agentLogDir = join(profile.logs, 'agents');
  const statePath = join(profile.manager, SEED_STATE_FILE);
  if (existsSync(profile.manager)) {
    const managerStat = lstatSync(profile.manager);
    if (managerStat.isSymbolicLink() || !managerStat.isDirectory()) {
      throw new Error(`Manager profile root is not a real directory: ${profile.manager}`);
    }
  } else {
    mkdirSync(profile.manager, { recursive: true, mode: 0o700 });
  }
  mkdirSync(profileLibrary, { recursive: true, mode: 0o700 });
  try { chmodSync(profileLibrary, 0o700); } catch { /* best effort */ }
  if (existsSync(agentLogDir)) {
    const agentLogStat = lstatSync(agentLogDir);
    if (agentLogStat.isSymbolicLink() || !agentLogStat.isDirectory()) {
      throw new Error(`Agent log profile root is not a real directory: ${agentLogDir}`);
    }
  } else {
    mkdirSync(agentLogDir, { recursive: true, mode: 0o700 });
  }
  try { chmodSync(agentLogDir, 0o700); } catch { /* best effort */ }

  const state = readSeedState(statePath);
  mergeSeedCatalog('configs', resolve(runtimeManagerRoot, 'configs'), libraryRoot, state);
  mergeSeedCatalog('skills', resolve(runtimeManagerRoot, 'skills'), skillsRoot, state);
  mergeSeedCatalog('plugins/claude-code', resolve(runtimeManagerRoot, 'plugins', 'claude-code'), pluginsRoot, state);
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);

  return { libraryRoot, skillsRoot, pluginsRoot, agentLogDir };
}
