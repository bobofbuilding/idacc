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
import { emptyConfig, defaultHeadroomPilotSettings, normalizeUpdateSettings, DEFAULT_TEAM, type DraftDispatcherSettings, type EvmRpcProfile, type EvmRpcRequest, type GoalDriverSettings, type HeadroomPilotSettings, type IdctlConfig, type ImageServerConfig, type LocalModelCatalogEntry, type ManagerProfile, type McpServerProfile, type ProjectEntry, type ProviderModelSelection, type ProviderProfile, type ProviderSync, type UpdateSettings, type WalletConnectSettings } from './schema.ts';
import { filterParkedMcpServers, isParkedMcpServer } from './mcpCatalog.ts';

function normalizeGoalDriver(input: unknown): GoalDriverSettings | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const out: GoalDriverSettings = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.cadenceMs === 'number' && Number.isFinite(raw.cadenceMs) && raw.cadenceMs > 0) out.cadenceMs = Math.floor(raw.cadenceMs);
  if (typeof raw.maxOpenTasksPerGoal === 'number' && Number.isFinite(raw.maxOpenTasksPerGoal) && raw.maxOpenTasksPerGoal > 0) out.maxOpenTasksPerGoal = Math.floor(raw.maxOpenTasksPerGoal);
  return out;
}

function normalizeDraftDispatcher(input: unknown): DraftDispatcherSettings | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const out: DraftDispatcherSettings = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.lastRunAt === 'number' && Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0) out.lastRunAt = Math.floor(raw.lastRunAt);
  if (raw.processed && typeof raw.processed === 'object' && !Array.isArray(raw.processed)) {
    const rows: Array<[string, NonNullable<DraftDispatcherSettings['processed']>[string]]> = [];
    for (const [key, value] of Object.entries(raw.processed as Record<string, unknown>)) {
      if (!key || !value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? Math.floor(rec.at) : 0;
      const team = cleanOptionalString(rec.team, 80);
      if (!at || !team) continue;
      rows.push([key.slice(0, 240), {
        at,
        team,
        sourceNewsId: cleanOptionalString(rec.sourceNewsId, 120),
        taskRefs: Array.isArray(rec.taskRefs) ? rec.taskRefs.map((x) => cleanOptionalString(x, 120)).filter((x): x is string => Boolean(x)).slice(0, 80) : undefined,
        title: cleanOptionalString(rec.title, 160),
        count: typeof rec.count === 'number' && Number.isFinite(rec.count) && rec.count > 0 ? Math.floor(rec.count) : undefined,
      }]);
    }
    rows.sort((a, b) => b[1].at - a[1].at);
    if (rows.length) out.processed = Object.fromEntries(rows.slice(0, 1000));
  }
  return out.enabled === undefined && !out.lastRunAt && !out.processed ? undefined : out;
}

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function cleanStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = Array.from(new Set(value.map((v) => String(v).trim()).filter(Boolean)));
  return out.length ? out : fallback;
}

function cleanOptionalString(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  return s ? s.slice(0, max) : undefined;
}

function cleanPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 1000) / 1000;
}

function normalizeWalletConnect(input: unknown): WalletConnectSettings | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<WalletConnectSettings>;
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  return {
    enabled: raw.enabled === true && /^[a-f0-9]{32}$/i.test(projectId),
    projectId: /^[a-f0-9]{32}$/i.test(projectId) ? projectId : '',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? Math.floor(raw.updatedAt) : undefined,
  };
}

function normalizeLocalModelCatalogEntry(raw: unknown): LocalModelCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<LocalModelCatalogEntry>;
  const id = cleanOptionalString(row.id, 128);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(id)) return null;
  const family = cleanOptionalString(row.family, 80) ?? id.split(':')[0];
  const params = cleanOptionalString(row.params, 40) ?? 'unknown';
  const capabilities = Array.from(new Set((Array.isArray(row.capabilities) ? row.capabilities : ['general'])
    .map((c) => cleanOptionalString(c, 32))
    .filter((c): c is string => Boolean(c))))
    .slice(0, 10);
  return {
    id,
    family,
    params,
    approxSizeGB: cleanPositiveNumber(row.approxSizeGB),
    contextTokens: cleanPositiveNumber(row.contextTokens),
    contextLabel: cleanOptionalString(row.contextLabel, 24),
    blurb: cleanOptionalString(row.blurb, 240),
    capabilities: capabilities.length ? capabilities : ['general'],
    license: cleanOptionalString(row.license, 80),
    recommended: row.recommended === true,
    source: row.source === 'manual' ? 'manual' : 'ollama-library',
    discoveredAt: cleanPositiveNumber(row.discoveredAt),
    updatedAt: cleanPositiveNumber(row.updatedAt),
  };
}

function normalizeLocalModelCatalog(input: unknown): LocalModelCatalogEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const byId = new Map<string, LocalModelCatalogEntry>();
  for (const raw of input) {
    const row = normalizeLocalModelCatalogEntry(raw);
    if (row) byId.set(row.id, row);
  }
  const rows = [...byId.values()].sort((a, b) => (b.updatedAt ?? b.discoveredAt ?? 0) - (a.updatedAt ?? a.discoveredAt ?? 0) || a.id.localeCompare(b.id));
  return rows.length ? rows.slice(0, 500) : undefined;
}

export function normalizeHeadroomPilot(input: unknown): HeadroomPilotSettings {
  const d = defaultHeadroomPilotSettings();
  if (!input || typeof input !== 'object') return d;
  const raw = input as Partial<HeadroomPilotSettings>;
  const enabled = raw.enabled === true;
  const mode = raw.mode === 'mcp' || raw.mode === 'proxy' || raw.mode === 'mcp-and-proxy'
    ? raw.mode
    : enabled
      ? 'mcp'
      : 'off';
  const minContextTokens = typeof raw.minContextTokens === 'number' && Number.isFinite(raw.minContextTokens) && raw.minContextTokens > 0
    ? Math.floor(raw.minContextTokens)
    : d.minContextTokens;
  return {
    enabled,
    mode: enabled ? mode : 'off',
    canaryPercent: clampPercent(raw.canaryPercent, d.canaryPercent),
    holdoutPercent: clampPercent(raw.holdoutPercent, d.holdoutPercent),
    minContextTokens,
    stateRoot: typeof raw.stateRoot === 'string' && raw.stateRoot.trim() ? raw.stateRoot.trim() : undefined,
    stateIsolation: raw.stateIsolation === 'per-team' ? 'per-team' : d.stateIsolation,
    telemetry: raw.telemetry === 'off' || raw.telemetry === 'on' || raw.telemetry === 'verify-before-pilot' ? raw.telemetry : d.telemetry,
    passthroughContent: cleanStringList(raw.passthroughContent, d.passthroughContent),
    validationGates: cleanStringList(raw.validationGates, d.validationGates),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined,
  };
}

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
      evmRpcs: Array.isArray(raw.evmRpcs) ? raw.evmRpcs : [],
      walletConnect: normalizeWalletConnect(raw.walletConnect),
      mcpServers: Array.isArray(raw.mcpServers) ? filterParkedMcpServers(raw.mcpServers) : [],
      defaultManager: raw.defaultManager,
      // Merge so an absent block → defaults (autoUpgrade true), per-field overridable.
      update: normalizeUpdateSettings(raw.update),
      coordinators: raw.coordinators ?? {},
      primaryCoordinator: raw.primaryCoordinator,
      goalDriver: normalizeGoalDriver(raw.goalDriver),
      draftDispatcher: normalizeDraftDispatcher(raw.draftDispatcher),
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
      localModelCatalog: normalizeLocalModelCatalog(raw.localModelCatalog),
      headroomPilot: normalizeHeadroomPilot(raw.headroomPilot),
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
  const providerHint = `${p.name} ${p.baseUrl}`.toLowerCase();
  if (providerHint.includes('nvidia') || providerHint.includes('integrate.api.nvidia.com')) {
    return process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY || process.env.NVIDIA_NIM_API_KEY || undefined;
  }
  if (providerHint.includes('perplexity') || providerHint.includes('api.perplexity.ai')) {
    return process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || undefined;
  }
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

/** Save which synced provider models should be offered in Health/Fleet pickers. */
export function setProviderModelSelection(name: string, selection: ProviderModelSelection, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const p = cfg.providers.find((x) => x.name === name);
  if (p) {
    const selected = Array.from(new Set((selection.models ?? []).map((m) => String(m).trim()).filter(Boolean)));
    p.modelSelection = selection.mode === 'selected' && selected.length
      ? { mode: 'selected', models: selected, updatedAt: selection.updatedAt ?? Date.now() }
      : { mode: 'all', models: [], updatedAt: selection.updatedAt ?? Date.now() };
  }
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

// ---- EVM RPC endpoints ----------------------------------------------------

function normalizeRpcId(id: string, network: string): string {
  return (id || network || 'evm-rpc').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'evm-rpc';
}

export function upsertEvmRpc(input: EvmRpcProfile, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const list = cfg.evmRpcs ?? [];
  const id = normalizeRpcId(input.id, input.network);
  const i = list.findIndex((x) => x.id === id);
  const prev = i >= 0 ? list[i] : undefined;
  const rpc: EvmRpcProfile = {
    ...(prev ?? {}),
    ...input,
    id,
    network: input.network.trim(),
    httpsUrl: input.httpsUrl.trim(),
    enabled: input.enabled !== false,
    apiKey: input.apiKey !== undefined ? input.apiKey : prev?.apiKey,
    apiKeyEncrypted: input.apiKeyEncrypted !== undefined ? input.apiKeyEncrypted : prev?.apiKeyEncrypted,
  };
  if (!rpc.apiKey) delete rpc.apiKey;
  if (!rpc.apiKeyEncrypted) delete rpc.apiKeyEncrypted;
  if (i >= 0) list[i] = rpc;
  else list.push(rpc);
  cfg.evmRpcs = list;
  saveSettings(cfg, file);
  return cfg;
}

export function removeEvmRpc(id: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.evmRpcs = (cfg.evmRpcs ?? []).filter((x) => x.id !== id);
  saveSettings(cfg, file);
  return cfg;
}

export function recordEvmRpcRequest(id: string, lastRequest: EvmRpcRequest, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const rpc = (cfg.evmRpcs ?? []).find((x) => x.id === id);
  if (rpc) rpc.lastRequest = lastRequest;
  saveSettings(cfg, file);
  return cfg;
}

// ---- WalletConnect operator signer ---------------------------------------

export function setWalletConnectSettings(
  input: Partial<WalletConnectSettings>,
  file = resolveConfigPath(),
): IdctlConfig {
  const cfg = loadSettings(file);
  const previous = cfg.walletConnect ?? { enabled: false, projectId: '' };
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : previous.projectId;
  if (projectId && !/^[a-f0-9]{32}$/i.test(projectId)) {
    throw new Error('WalletConnect project ID must be 32 hexadecimal characters');
  }
  const enabled = input.enabled === undefined ? previous.enabled : input.enabled === true;
  if (enabled && !projectId) throw new Error('WalletConnect project ID is required when the connector is enabled');
  cfg.walletConnect = { enabled, projectId, updatedAt: Date.now() };
  saveSettings(cfg, file);
  return cfg;
}

// ---- Self-update settings -------------------------------------------------

export function setUpdateSettings(partial: Partial<UpdateSettings>, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.update = normalizeUpdateSettings({ ...(cfg.update ?? {}), ...partial });
  saveSettings(cfg, file);
  return cfg;
}

export function setGoalDriver(partial: Partial<GoalDriverSettings>, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.goalDriver = normalizeGoalDriver({ ...(cfg.goalDriver ?? {}), ...(partial ?? {}) });
  saveSettings(cfg, file);
  return cfg;
}

export function setHeadroomPilot(partial: Partial<HeadroomPilotSettings>, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.headroomPilot = normalizeHeadroomPilot({
    ...(cfg.headroomPilot ?? defaultHeadroomPilotSettings()),
    ...(partial ?? {}),
    updatedAt: Date.now(),
  });
  saveSettings(cfg, file);
  return cfg;
}

// ---- MCP servers (Modules catalog) ----------------------------------------

export function upsertMcpServer(s: McpServerProfile, file = resolveConfigPath()): IdctlConfig {
  if (isParkedMcpServer(s)) {
    throw new Error(`MCP server "${s.name}" is parked because it is a reference/test server and should not be attached to production agents.`);
  }
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

export function listLocalModelCatalog(file = resolveConfigPath()): LocalModelCatalogEntry[] {
  return loadSettings(file).localModelCatalog ?? [];
}

/** Merge discovered local model metadata into the app-side catalog overlay. */
export function mergeLocalModelCatalog(entries: LocalModelCatalogEntry[], file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const byId = new Map<string, LocalModelCatalogEntry>();
  for (const row of cfg.localModelCatalog ?? []) {
    const clean = normalizeLocalModelCatalogEntry(row);
    if (clean) byId.set(clean.id, clean);
  }
  for (const row of entries ?? []) {
    const clean = normalizeLocalModelCatalogEntry(row);
    if (!clean) continue;
    const previous = byId.get(clean.id);
    byId.set(clean.id, {
      ...(previous ?? {}),
      ...clean,
      discoveredAt: previous?.discoveredAt ?? clean.discoveredAt ?? Date.now(),
      updatedAt: clean.updatedAt ?? Date.now(),
    });
  }
  cfg.localModelCatalog = normalizeLocalModelCatalog([...byId.values()]);
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

export type SecondaryLead = { agent: string; team: string; leadsTeams: string[] };

export function getSecondaryLeads(file = resolveConfigPath()): SecondaryLead[] {
  return loadSettings(file).secondaryLeads ?? [];
}

export function setSecondaryLeads(leads: SecondaryLead[], file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  cfg.secondaryLeads = leads;
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

/** Set a task's adjustment-loop state (needs-adjustment | under-review | rework).
 *  Empty clears it. A fresh 'needs-adjustment' on a task already past review
 *  (under-review/rework) is promoted to 'rework' — i.e. it got blocked AGAIN. */
export function setTaskReview(ref: string, state: string, file = resolveConfigPath()): IdctlConfig {
  const cfg = loadSettings(file);
  const all = { ...(cfg.taskReview ?? {}) };
  const now = Date.now();
  const cur = all[ref]?.state;
  if (!state) delete all[ref];
  else if (state === 'needs-adjustment' && (cur === 'under-review' || cur === 'rework')) all[ref] = { state: 'rework', at: now };
  else all[ref] = { state, at: now };
  cfg.taskReview = all;
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
