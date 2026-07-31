import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { selectAppProfile } from './appProfileSelection.ts';
import {
  readAppProfilePreferenceForSelection,
  validateExplicitProfileDataDir,
} from './appProfilePreference.ts';
import { migrateAppProfile, PROFILE_SCHEMA_VERSION } from './profileMigrations.ts';

export { PROFILE_SCHEMA_VERSION } from './profileMigrations.ts';

export interface AppProfilePaths {
  root: string;
  config: string;
  brain: string;
  manager: string;
  workspace: string;
  logs: string;
  cache: string;
}

function profilePaths(root: string): AppProfilePaths {
  return {
    root,
    config: join(root, 'config', 'config.json'),
    brain: join(root, 'brain'),
    manager: join(root, 'manager'),
    workspace: join(root, 'workspace'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
  };
}

function legacyBrainDatabaseCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  const explicit = process.env.IDACC_LEGACY_BRAIN_DB?.trim();
  if (explicit && isAbsolute(explicit)) candidates.push(resolve(explicit));

  if (process.platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'ID Agents', 'Brain', 'brain.db'));
    const plist = join(home, 'Library', 'LaunchAgents', 'io.bittrees.brain.plist');
    if (existsSync(plist)) {
      const result = spawnSync('/usr/bin/plutil', [
        '-extract',
        'ProgramArguments',
        'json',
        '-o',
        '-',
        plist,
      ], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!result.error && result.status === 0) {
        try {
          const args = JSON.parse(result.stdout) as unknown;
          if (Array.isArray(args)) {
            const entrypoint = args.find((value): value is string => (
              typeof value === 'string'
              && isAbsolute(value)
              && basename(value) === 'brain.mjs'
            ));
            if (entrypoint) candidates.push(join(dirname(entrypoint), 'brain.db'));
          }
        } catch {
          // A malformed retired service definition is not a trusted import source.
        }
      }
    }
  } else if (process.platform === 'win32') {
    candidates.push(join(
      process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
      'ID Agents',
      'Brain',
      'brain.db',
    ));
  } else {
    candidates.push(join(
      process.env.XDG_STATE_HOME || join(home, '.local', 'state'),
      'id-agents',
      'brain',
      'brain.db',
    ));
  }
  return [...new Set(candidates.map((path) => resolve(path)))];
}

function appProfileSelection() {
  const userDataRoot = app.getPath('userData');
  const environment = {
    dataDir: process.env.IDACC_DATA_DIR?.trim(),
    profile: process.env.IDACC_PROFILE?.trim(),
  };
  const preference = readAppProfilePreferenceForSelection(userDataRoot, environment);
  const requestedDataDir = environment.dataDir || preference?.dataDir;
  const dataDir = requestedDataDir
    ? validateExplicitProfileDataDir(requestedDataDir, userDataRoot, {
      // An environment override is also the supported headless way to create a
      // new dedicated profile. Persisted pointers must still resolve so a stale
      // or moved profile cannot silently become a new empty one.
      allowMissing: Boolean(environment.dataDir),
      protectedRoots: [
        app.getPath('home'),
      ],
      protectedTrees: [
        app.getAppPath(),
        process.resourcesPath,
      ],
    })
    : undefined;
  return selectAppProfile(userDataRoot, {
    dataDir,
    profile: environment.profile || preference?.profile,
  });
}

export function appProfilePaths(): AppProfilePaths {
  return profilePaths(appProfileSelection().root);
}

function ensureManagedManagerProfile(configPath: string, managedUrl?: string): void {
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim()) config = JSON.parse(raw) as Record<string, unknown>;
  }
  const managers = Array.isArray(config.managers)
    ? [...config.managers] as Array<Record<string, unknown>>
    : [];
  const url = managedUrl || process.env.MANAGER_URL || 'http://127.0.0.1:4110';
  const index = managers.findIndex((manager) => manager?.name === 'idacc-local');
  const profile = { ...(index >= 0 ? managers[index] : {}), name: 'idacc-local', url, team: 'default', managed: true };
  if (index >= 0) managers[index] = profile;
  else managers.unshift(profile);
  const next = { ...config, version: 1, managers, defaultManager: 'idacc-local', defaultTeam: String(config.defaultTeam || 'default') };
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, configPath);
}

/** Keep CLI and desktop consumers pointed at the supervisor's live endpoint. */
export function updateManagedManagerProfileUrl(configPath: string, url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('Managed manager URL must be an explicit 127.0.0.1 HTTP endpoint.');
  }
  ensureManagedManagerProfile(configPath, parsed.origin);
}

/**
 * Establish the app-owned profile before any store is used. Existing IDACC
 * installs are migrated once. Context-budget data is copied into the bounded
 * profile cache by the migration framework; the legacy copy is retained as a
 * rollback-safe backup.
 */
export function initializeAppProfile(): AppProfilePaths {
  const selection = appProfileSelection();
  const paths = profilePaths(selection.root);
  migrateAppProfile(paths, {
    profileName: selection.profileName,
    legacyConfigDir: join(homedir(), '.config', 'idctl'),
    legacyManagerDir: join(homedir(), '.id-agents'),
    legacyBrainDatabases: legacyBrainDatabaseCandidates(),
    legacyDesktopSignerVault: join(app.getPath('userData'), 'keys', 'agent-signers.json'),
    allowLegacyImport: selection.profileName === 'default' && !selection.explicitDataDir,
  });

  process.env.IDACC_DATA_DIR = paths.root;
  process.env.IDCTL_CONFIG = paths.config;
  process.env.XDG_CACHE_HOME = paths.cache;
  process.env.AGENT_MANAGER_WORKDIR = paths.workspace;
  process.env.ID_WORKSPACE_DIR = paths.workspace;
  process.env.SQLITE_PATH = join(paths.manager, 'id-agents.db');
  process.env.BRAIN_STATE_DIR = paths.brain;
  process.env.BRAIN_DB_PATH = join(paths.brain, 'brain.db');
  // App-owned ports intentionally differ from legacy developer launchd ports,
  // so an old checkout cannot silently impersonate the bundled consumer stack.
  process.env.MANAGER_URL ||= 'http://127.0.0.1:4110';
  process.env.BRAIN_URL ||= 'http://127.0.0.1:4210';
  process.env.IDACC_BRAIN_URL ||= process.env.BRAIN_URL;
  ensureManagedManagerProfile(paths.config);
  return paths;
}
