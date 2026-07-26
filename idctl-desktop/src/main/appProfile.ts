import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectAppProfile } from './appProfileSelection.ts';
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

function appProfileSelection() {
  return selectAppProfile(app.getPath('userData'), {
    dataDir: process.env.IDACC_DATA_DIR,
    profile: process.env.IDACC_PROFILE,
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
