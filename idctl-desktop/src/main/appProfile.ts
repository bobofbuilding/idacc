import { app } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROFILE_SCHEMA_VERSION = 1;

export interface AppProfilePaths {
  root: string;
  config: string;
  brain: string;
  manager: string;
  workspace: string;
  logs: string;
  cache: string;
}

export function appProfilePaths(): AppProfilePaths {
  const root = process.env.IDACC_DATA_DIR?.trim()
    || join(app.getPath('userData'), 'profiles', process.env.IDACC_PROFILE?.trim() || 'default');
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

function copyIfAbsent(source: string, destination: string): void {
  if (!existsSync(source) || existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

function ensureManagedManagerProfile(configPath: string): void {
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim()) config = JSON.parse(raw) as Record<string, unknown>;
  }
  const managers = Array.isArray(config.managers)
    ? [...config.managers] as Array<Record<string, unknown>>
    : [];
  const url = process.env.MANAGER_URL || 'http://127.0.0.1:4110';
  const index = managers.findIndex((manager) => manager?.name === 'idacc-local');
  const profile = { ...(index >= 0 ? managers[index] : {}), name: 'idacc-local', url, team: 'default', managed: true };
  if (index >= 0) managers[index] = profile;
  else managers.unshift(profile);
  const next = { ...config, version: 1, managers, defaultManager: 'idacc-local', defaultTeam: String(config.defaultTeam || 'default') };
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, configPath);
}

/**
 * Establish the app-owned profile before any store is used. Existing IDACC
 * installs are migrated once. Cache/context-budget data is intentionally not
 * copied: it is reproducible, can be very large, and belongs under cache/.
 */
export function initializeAppProfile(): AppProfilePaths {
  const paths = appProfilePaths();
  for (const dir of Object.values(paths).filter((value) => value !== paths.config)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });

  const marker = join(paths.root, 'profile.json');
  if (!existsSync(marker)) {
    const legacy = join(homedir(), '.config', 'idctl');
    copyIfAbsent(join(legacy, 'config.json'), paths.config);
    for (const name of ['goals', 'plans', 'chats', 'dreams', 'loops', 'learn', 'questions', 'work']) {
      copyIfAbsent(join(legacy, name), join(dirname(paths.config), name));
    }
    // Key material remains user-owned, but is migrated into the isolated
    // profile with its existing restrictive permissions.
    for (const name of ['keys-mock.json', 'agent-signers.json', 'safe-roles-state.json']) {
      copyIfAbsent(join(legacy, name), join(dirname(paths.config), name));
    }
    const temporary = `${marker}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: 'default',
      createdAt: new Date().toISOString(),
      migratedFrom: existsSync(legacy) ? legacy : null,
    }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, marker);
  } else {
    const metadata = JSON.parse(readFileSync(marker, 'utf8')) as { schemaVersion?: number };
    if ((metadata.schemaVersion ?? 0) > PROFILE_SCHEMA_VERSION) {
      throw new Error('This IDACC profile was created by a newer application version.');
    }
  }

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
