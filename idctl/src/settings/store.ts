/**
 * Settings store — load/save ~/.config/idctl/config.json and the profile
 * mutators the SettingsView calls. Key rules:
 *  - First run (no file) returns emptyConfig() in memory; never crashes.
 *  - Writes are atomic (temp + rename) and chmod 0600; dir is chmod 0700.
 *  - A loosely-permissioned file is self-healed to 0600 with a stderr warning.
 *  - API keys resolve config field → env var → (caller may add keychain later).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolveConfigPath, configDir } from './paths.ts';
import { emptyConfig, defaultUpdateSettings, DEFAULT_TEAM, type IdctlConfig, type ImageServerConfig, type ManagerProfile, type McpServerProfile, type ProjectEntry, type ProviderProfile, type ProviderSync, type UpdateSettings } from './schema.ts';

export function loadSettings(file = resolveConfigPath()): IdctlConfig {
  if (!existsSync(file)) return emptyConfig();
  try {
    // Self-heal loose permissions on a file that holds API keys.
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o077) {
        process.stderr.write(`idctl: config ${file} is readable by others; tightening to 0600\n`);
        chmodSync(file, 0o600);
      }
    } catch {
      /* stat best-effort */
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<IdctlConfig>;
    const cfg: IdctlConfig = {
      // Preserve any unknown top-level keys (forward-compat + parity with the
      // standalone sync script, which does a naive read-modify-write), then
      // normalize the known fields over them.
      ...(raw as IdctlConfig),
      version: 1,
      managers: Array.isArray(raw.managers) ? raw.managers : [],
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
      defaultManager: raw.defaultManager,
      // Merge so an absent block → defaults (autoUpgrade true), per-field overridable.
      update: { ...defaultUpdateSettings(), ...(raw.update ?? {}) },
      coordinators: raw.coordinators ?? {},
      primaryCoordinator: raw.primaryCoordinator,
      defaultTeam: raw.defaultTeam ?? DEFAULT_TEAM,
      // Absent → scope to just the default team (the shipped behaviour). An
      // explicit null/[] means "show all teams" (filtering disabled).
      knownTeams: raw.knownTeams === undefined ? [DEFAULT_TEAM] : raw.knownTeams,
      projects: Array.isArray(raw.projects) ? raw.projects : undefined,
      projectsRoot: typeof raw.projectsRoot === 'string' ? raw.projectsRoot : undefined,
      imageServer: raw.imageServer && typeof raw.imageServer === 'object' && typeof (raw.imageServer as any).url === 'string'
        ? raw.imageServer
        : undefined,
      localConcurrency: typeof raw.localConcurrency === 'number' && raw.localConcurrency >= 1
        ? Math.floor(raw.localConcurrency)
        : undefined,
    };
    // Validation: at most one default provider.
    let seenDefault = false;
    for (const p of cfg.providers) {
      if (p.default) {
        if (seenDefault) {
          process.stderr.write(`idctl: multiple default providers; keeping the first\n`);
          p.default = false;
        }
        seenDefault = true;
      }
    }
    return cfg;
  } catch (err) {
    process.stderr.write(`idctl: could not parse ${file} (${err instanceof Error ? err.message : err}); using empty config\n`);
    return emptyConfig();
  }
}

export function saveSettings(cfg: IdctlConfig, file = resolveConfigPath()): void {
  // SAFETY: never overwrite a config file that exists but doesn't parse — the
  // lenient loader returns an empty config on a parse error, and writing that
  // back would silently destroy unreadable secrets (API keys, MCP tokens).
  // An absent or empty file is fine to create.
  if (existsSync(file)) {
    try {
      const cur = readFileSync(file, 'utf8');
      if (cur.trim()) JSON.parse(cur);
    } catch {
      throw new Error(`refusing to overwrite unparseable config at ${file}; fix or remove it first`);
    }
  }
  const dir = configDir(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* umask-proofing best-effort */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

// ---- Key resolution -------------------------------------------------------

function envKeyName(name: string): string {
  return `IDCTL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

export function resolveProviderKey(p: ProviderProfile): string | undefined {
  if (p.apiKey) return p.apiKey;
  const named = process.env[envKeyName(p.name)];
  if (named) return named;
  if (p.kind === 'anthropic' && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (p.kind === 'openai' && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return undefined;
}

export function resolveManagerKey(m: ManagerProfile): string | undefined {
  return m.apiKey || process.env[envKeyName(m.name)] || undefined;
}

export function redactKey(k?: string): string {
  if (!k) return '—';
  if (k.length <= 6) return '••••';
  return `••••${k.slice(-4)}`;
}

// ---- Mutators (load → mutate → save) --------------------------------------

export function upsertManager(m: ManagerProfile, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const i = cfg.managers.findIndex((x) => x.name === m.name);
  if (i >= 0) cfg.managers[i] = m;
  else cfg.managers.push(m);
  saveSettings(cfg, file);
  return cfg;
}

export function removeManager(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.managers = cfg.managers.filter((x) => x.name !== name);
  if (cfg.defaultManager === name) cfg.defaultManager = undefined;
  saveSettings(cfg, file);
  return cfg;
}

export function setDefaultManager(name: string | undefined, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.defaultManager = name;
  saveSettings(cfg, file);
  return cfg;
}

/** Persist the preferred local-model concurrency (re-applied to the manager on
 *  connect so it survives a manager restart). Pass undefined to clear it. */
export function setLocalConcurrencyPref(n: number | undefined, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.localConcurrency = typeof n === 'number' && n >= 1 ? Math.floor(n) : undefined;
  saveSettings(cfg, file);
  return cfg;
}

export function upsertProvider(p: ProviderProfile, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const i = cfg.providers.findIndex((x) => x.name === p.name);
  if (i >= 0) cfg.providers[i] = p;
  else cfg.providers.push(p);
  saveSettings(cfg, file);
  return cfg;
}

export function removeProvider(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.providers = cfg.providers.filter((x) => x.name !== name);
  saveSettings(cfg, file);
  return cfg;
}

export function setDefaultProvider(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  for (const p of cfg.providers) p.default = p.name === name;
  saveSettings(cfg, file);
  return cfg;
}

export function toggleProviderEnabled(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const p = cfg.providers.find((x) => x.name === name);
  if (p) p.enabled = !p.enabled;
  saveSettings(cfg, file);
  return cfg;
}

/** Persist the cached result of a Connect & sync probe onto the provider. */
export function recordProviderSync(name: string, sync: ProviderSync, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const p = cfg.providers.find((x) => x.name === name);
  if (p) p.lastSync = sync;
  saveSettings(cfg, file);
  return cfg;
}

// ---- Self-update settings -------------------------------------------------

export function setUpdateSettings(partial: Partial<UpdateSettings>, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.update = { ...defaultUpdateSettings(), ...(cfg.update ?? {}), ...partial };
  saveSettings(cfg, file);
  return cfg;
}

// ---- MCP servers (Modules catalog) ----------------------------------------

export function upsertMcpServer(s: McpServerProfile, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const list = cfg.mcpServers ?? [];
  const i = list.findIndex((x) => x.name === s.name);
  if (i >= 0) list[i] = s;
  else list.push(s);
  cfg.mcpServers = list;
  saveSettings(cfg, file);
  return cfg;
}

export function removeMcpServer(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.mcpServers = (cfg.mcpServers ?? []).filter((x) => x.name !== name);
  saveSettings(cfg, file);
  return cfg;
}

// ---- Projects (local tracker) ---------------------------------------------

export function upsertProject(p: ProjectEntry, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const list = cfg.projects ?? [];
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  cfg.projects = list;
  saveSettings(cfg, file);
  return cfg;
}

/** Set (or clear, with null) the preferred local image-generation backend. */
export function setImageServer(server: ImageServerConfig | null, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  if (server && typeof server.url === 'string' && server.url.trim()) {
    cfg.imageServer = {
      url: server.url.trim().replace(/\/+$/, ''),
      type: server.type === 'openai' ? 'openai' : 'auto1111',
      model: typeof server.model === 'string' && server.model.trim() ? server.model.trim() : undefined,
    };
  } else {
    delete cfg.imageServer;
  }
  saveSettings(cfg, file);
  return cfg;
}

export function removeProject(id: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.projects = (cfg.projects ?? []).filter((x) => x.id !== id);
  saveSettings(cfg, file);
  return cfg;
}

export function setProjectsRoot(root: string | undefined, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.projectsRoot = root && root.trim() ? root.trim() : undefined;
  saveSettings(cfg, file);
  return cfg;
}

// ---- Teams ----------------------------------------------------------------

export function addKnownTeam(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const list = cfg.knownTeams ?? [];
  if (!list.includes(name)) list.push(name);
  cfg.knownTeams = list;
  saveSettings(cfg, file);
  return cfg;
}

export function removeKnownTeam(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.knownTeams = (cfg.knownTeams ?? []).filter((t) => t !== name);
  saveSettings(cfg, file);
  return cfg;
}

export function setCoordinator(team: string, agent: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.coordinators = { ...(cfg.coordinators ?? {}), [team]: agent };
  saveSettings(cfg, file);
  return cfg;
}

export function getCoordinator(team: string, file = resolveConfigPath()): string | undefined {
  return loadSettings(file).coordinators?.[team];
}

export function setPrimaryCoordinator(team: string, agent: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.primaryCoordinator = { team, agent };
  cfg.coordinators = { ...(cfg.coordinators ?? {}), [team]: agent }; // primary is also its team's lead
  saveSettings(cfg, file);
  return cfg;
}

/** Merge auto-derived skill tags into the client-side categorization overlay. */
export function setSkillTags(tags: Record<string, string[]>, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.skillTags = { ...(cfg.skillTags ?? {}), ...tags };
  saveSettings(cfg, file);
  return cfg;
}

/** Set (or clear, with lane='') a task's Kanban lane in the client-side overlay. */
export function setTaskLane(ref: string, lane: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const lanes = { ...(cfg.taskLanes ?? {}) };
  if (lane) lanes[ref] = lane; else delete lanes[ref];
  cfg.taskLanes = lanes;
  saveSettings(cfg, file);
  return cfg;
}

/** Record a task's prerequisite refs (app-side dependency overlay). Empty deps clears it. */
export function setTaskDeps(ref: string, deps: string[], file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const all = { ...(cfg.taskDeps ?? {}) };
  const clean = Array.from(new Set((deps ?? []).map(String).filter((d) => d && d !== ref)));
  if (clean.length) all[ref] = clean; else delete all[ref];
  cfg.taskDeps = all;
  saveSettings(cfg, file);
  return cfg;
}

export function setDefaultTeam(name: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.defaultTeam = name;
  if (cfg.knownTeams && !cfg.knownTeams.includes(name)) cfg.knownTeams.push(name);
  saveSettings(cfg, file);
  return cfg;
}
