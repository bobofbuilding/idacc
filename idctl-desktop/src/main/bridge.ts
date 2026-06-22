/**
 * Main-process bridge to the id-agents manager + local stores. Reuses the
 * idctl ManagerClient, key provider, inference-provider client, and settings
 * store (all pure TS / Node) — the React renderer reaches them only via the
 * allow-listed methods below over IPC.
 */

import { ManagerClient } from '../../../idctl/src/api/client.ts';
import { loadConfig, type Config } from '../../../idctl/src/config.ts';
import { getKeyProvider } from '../../../idctl/src/keys/mockProvider.ts';
import { SCOPE_PRESETS, TTL_PRESETS } from '../../../idctl/src/keys/types.ts';
import {
  loadSettings,
  upsertProvider,
  removeProvider,
  resolveProviderKey,
  setDefaultProvider,
  toggleProviderEnabled,
  recordProviderSync,
  setCoordinator,
  getCoordinator,
  setPrimaryCoordinator,
  upsertMcpServer,
  removeMcpServer,
  upsertProject,
  removeProject,
  saveSettings,
} from '../../../idctl/src/settings/store.ts';
import { detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { discoverLocalServers, type DiscoveredServer } from '../../../idctl/src/settings/localDiscovery.ts';
import { kindNeedsKey, type ProviderProfile, type McpServerProfile, type ProjectEntry } from '../../../idctl/src/settings/schema.ts';
import { buildRuntimeCatalog } from '../../../idctl/src/settings/runtimeCatalog.ts';
import { testMcpServer } from './mcpTest.ts';
import { decomposeWork, createAndDispatchPlan, type SubTask } from './work.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The codex runtime's real model list lives in the codex CLI's own cache
 * (~/.codex/models_cache.json), which reflects the signed-in ChatGPT
 * subscription. Visibility 'list' = user-selectable; sort by priority to match
 * the CLI's picker order. [] on any error (cache absent / not signed in).
 */
// ---- Projects-sync helpers -------------------------------------------------
/** Canonical path for dedup: realpath when it exists, else trailing-slash-trimmed. */
function normPath(p?: string): string {
  if (!p) return '';
  try { return realpathSync(p); } catch { return p.replace(/\/+$/, ''); }
}
/** Loose name key for adopting a same-named manual entry (case/punctuation-insensitive). */
function normName(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
/** A git remote → a clean github.com/owner/repo link (best-effort, non-github passes through). */
function ghLink(remote: string): string {
  return remote.trim().replace(/^git@github\.com:/, 'github.com/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
}
/** Deterministic, collision-resistant id from a path (re-syncs reuse the id). */
function stableHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function codexModelsFromCache(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
    const models = (JSON.parse(raw).models ?? []) as { slug?: string; visibility?: string; priority?: number }[];
    return models
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

/** Catalog with the codex runtime's models merged from the live codex cache. */
function runtimeCatalogWithCodex(): Record<string, string[]> {
  const cat = buildRuntimeCatalog(loadSettings().providers);
  const codex = codexModelsFromCache();
  if (codex.length) cat.codex = Array.from(new Set([...codex, ...(cat.codex ?? [])]));
  return cat;
}

/** Where a provider's API key resolves from, without exposing the value. */
function keySourceOf(p: ProviderProfile): 'config' | 'env' | 'none' {
  if (p.apiKey) return 'config';
  if (resolveProviderKey(p)) return 'env';
  return 'none';
}
/** Provider list enriched with the (non-secret) key source for the UI. */
function listProvidersEnriched(): (ProviderProfile & { keySource: 'config' | 'env' | 'none'; needsKey: boolean })[] {
  return loadSettings().providers.map((p) => ({ ...p, keySource: keySourceOf(p), needsKey: kindNeedsKey(p.kind) }));
}
import type { McpServerSpec, CreateSkillInput } from '../../../idctl/src/api/client.ts';

// idctl-desktop is the operator's local control center talking to 127.0.0.1,
// so it is a legitimate admin client (admin-gated routes: skill install, MCP attach).
let cfg: Config = loadConfig({ team: 'default', admin: true });
let client = new ManagerClient(cfg);
const keys = getKeyProvider();

const METHODS: Record<string, (...a: any[]) => Promise<unknown>> = {
  // fleet
  health: () => client.health(),
  agents: () => client.agents(),
  teams: () => client.teams(),
  // Agents across ALL teams, grouped — for the Health roster.
  'agents:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    const groups = await Promise.all(
      names.map(async (name) => ({ team: name, agents: await client.withTeam(name).agents().catch(() => []) })),
    );
    return groups.filter((g) => g.agents.length > 0);
  },
  events: (since: number) => client.events(Number(since) || 0, { wait: 20, limit: 100 }),
  inboxPending: () => client.inboxPending(),

  // tasks
  tasks: () => client.tasks(),

  // dispatch / lifecycle
  dispatch: (command: string) => client.dispatch(String(command)),
  remote: (command: string, agent?: string) => client.remote(String(command), agent),

  // auto-decompose work for the fleet: lead splits an objective into sub-tasks…
  'work:decompose': async (objective: string, lead: string) => {
    const agents = await client.agents().catch(() => []);
    const list = agents.map((a) => ({
      name: a.name,
      runtime: a.runtime,
      skills: Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [],
    }));
    return decomposeWork(client, String(objective), String(lead), list);
  },
  // …then create them all + farm out the work (parallel where possible).
  'work:createPlan': (objective: string, subtasks: SubTask[]) =>
    createAndDispatchPlan(client, String(objective), Array.isArray(subtasks) ? subtasks : []),

  // health probes
  probeAll: () => client.probeAll(),
  probeOne: (name: string) => client.probeOne(String(name)),

  // scheduling
  checkins: () => client.checkins(),
  schedules: () => client.schedules(),
  addHeartbeat: (agent: string, seconds: number, message: string, delivery?: 'internal' | 'talk') =>
    client.addHeartbeat(String(agent), Number(seconds), String(message), delivery),
  addCalendarCheckin: (agent: string, time: string, when: string, message: string, opts?: { timezone?: string; delivery?: 'internal' | 'talk' }) =>
    client.addCalendarCheckin(String(agent), String(time), String(when), String(message), opts ?? {}),
  pauseSchedule: (id: string) => client.pauseSchedule(String(id)),
  resumeSchedule: (id: string) => client.resumeSchedule(String(id)),
  removeSchedule: (id: string) => client.removeSchedule(String(id)),

  // teams / library
  libraryTeams: () => client.libraryTeams(),
  configs: () => client.configs(),
  deployTeam: (name: string) => client.deployTeam(String(name)),

  // team relay (cross-team delegation allow-list) + per-agent override
  teamConfig: (name: string) => client.teamConfig(String(name)),
  setTeamDelegates: (name: string, delegates: string[] | null) => client.setTeamDelegates(String(name), delegates ?? null),
  setAgentDelegates: (id: string, delegates: string[] | null) => client.setAgentDelegates(String(id), delegates ?? null),

  // dashboard: switch runtime (rebuild required to apply)
  setAgentRuntime: (id: string, runtime: string) => client.setAgentRuntime(String(id), String(runtime)),

  // teams: create + start a new agent
  spawnAgent: (spec: Parameters<ManagerClient['spawnAgent']>[0]) => client.spawnAgent(spec),

  // dashboard: per-runtime model catalog (synced providers + codex cache + curated)
  'runtime:models': async () => runtimeCatalogWithCodex(),
  // Probe every enabled provider that backs a runtime, refresh its model list,
  // then return the rebuilt per-runtime catalog. This is "probe each runtime".
  'runtime:probe': async () => {
    const providers = loadSettings().providers;
    await Promise.all(
      providers
        .filter((p) => p.enabled !== false)
        .map(async (p) => {
          try {
            const outcome = await new ProviderClient(p, resolveProviderKey(p)).probe();
            recordProviderSync(p.name, {
              at: Date.now(),
              status: outcome.status,
              modelCount: outcome.models.length,
              models: outcome.models.slice(0, 200).map((m) => m.id),
              keySource: keySourceOf(p),
            });
          } catch {
            /* leave the provider's last sync as-is on probe failure */
          }
        }),
    );
    return runtimeCatalogWithCodex();
  },

  // modules: skills + plugins catalog, install, MCP attach + rebuild
  librarySkills: () => client.librarySkills(),
  libraryPlugins: () => client.libraryPlugins(),
  installSkill: (skill: string, agent: string) => client.installSkill(String(skill), String(agent)),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
  deleteSkill: (name: string) => client.deleteSkill(String(name)),
  uninstallSkill: (skill: string, agent: string) => client.uninstallSkill(String(skill), String(agent)),
  usage: () => client.usage(),
  setAgentMcp: (agentId: string, servers: McpServerSpec[]) => client.setAgentMcp(String(agentId), servers ?? []),
  rebuildAgent: (agent: string) => client.remote(`/agent ${agent} rebuild`),

  // MCP server registry (local settings catalog)
  'mcp:list': async () => loadSettings().mcpServers ?? [],
  'mcp:add': async (profile: McpServerProfile) => {
    upsertMcpServer(profile);
    return loadSettings().mcpServers ?? [];
  },
  'mcp:remove': async (name: string) => {
    removeMcpServer(String(name));
    return loadSettings().mcpServers ?? [];
  },
  'mcp:test': (spec: McpServerSpec) => testMcpServer(spec),

  // projects (local tracker — client-side config)
  'projects:list': async () => loadSettings().projects ?? [],
  'projects:save': async (p: ProjectEntry) => {
    upsertProject(p);
    return loadSettings().projects ?? [];
  },
  'projects:remove': async (id: string) => {
    removeProject(String(id));
    return loadSettings().projects ?? [];
  },
  // Detect the projects root (returns null if none found).
  'projects:detectRoot': async (root?: string) => detectProjectsRoot(typeof root === 'string' ? root : loadSettings().projectsRoot),
  // Sync the workspace projects folder into the tracker. Additive + idempotent:
  // dedupes by folder path, adopts a path-less manual entry of the same name,
  // never deletes or overwrites your edits. Persists the resolved root.
  'projects:syncRoot': async (rootArg?: string) => {
    const root = detectProjectsRoot(typeof rootArg === 'string' && rootArg.trim() ? rootArg.trim() : loadSettings().projectsRoot);
    if (!root) return { ok: false, root: null, added: 0, adopted: 0, total: (loadSettings().projects ?? []).length, error: 'no projects folder found' };
    const scan = await scanProjectsRoot(root);
    // Load once, merge in memory, write once (atomic). A single read-modify-write
    // shrinks the cross-process window vs the launchd syncer (no N-write burst).
    const cfg = loadSettings();
    const projects = cfg.projects ?? [];
    if (scan.error) {
      cfg.projects = projects;
      cfg.projectsRoot = root;
      saveSettings(cfg);
      return { ok: false, root, added: 0, adopted: 0, total: projects.length, error: scan.error };
    }
    const byPath = new Set(projects.map((p) => normPath(p.path)).filter(Boolean) as string[]);
    const pathlessByName = new Map<string, ProjectEntry>();
    for (const p of projects) { const k = normName(p.name); if (!p.path && k) pathlessByName.set(k, p); }
    let added = 0;
    let adopted = 0;
    const now = Date.now();
    for (const d of scan.found) {
      const np = normPath(d.path);
      if (np && byPath.has(np)) continue; // already tracked
      const link = d.remoteUrl ? ghLink(d.remoteUrl) : '';
      const key = normName(d.name);
      const adopt = key ? pathlessByName.get(key) : undefined; // never adopt on an empty key
      if (adopt) {
        adopt.path = d.path;
        if (!adopt.description && d.description) adopt.description = d.description;
        if (link && !(adopt.links ?? []).includes(link)) adopt.links = [...(adopt.links ?? []), link];
        adopt.updatedAt = now;
        pathlessByName.delete(key);
        if (np) byPath.add(np);
        adopted++;
        continue;
      }
      projects.push({
        id: `ws_${stableHash(d.path)}`,
        name: d.name,
        status: 'active',
        description: d.description,
        tags: ['workspace'],
        links: link ? [link] : [],
        path: d.path,
        createdAt: now,
        updatedAt: now,
      });
      if (np) byPath.add(np);
      added++;
    }
    cfg.projects = projects;
    cfg.projectsRoot = root;
    saveSettings(cfg);
    return { ok: true, root, added, adopted, total: projects.length };
  },

  // identity & keys (Safe + ERC-4337 session keys; mock today)
  'keys:caps': async () => keys.capabilities(),
  'keys:list': (agents: string[]) => keys.listAccounts(agents ?? []),
  'keys:ensure': (agent: string) => keys.ensureAccount(String(agent)),
  'keys:deploy': (agent: string) => keys.deployAccount(String(agent)),
  'keys:issue': (agent: string, scopeIdx: number, ttlMs: number) =>
    keys.issueSession(String(agent), SCOPE_PRESETS[Number(scopeIdx) || 0], Number(ttlMs)),
  'keys:revoke': (agent: string, sessionId: string) => keys.revokeSession(String(agent), String(sessionId)),
  'keys:presets': async () => ({ scopes: SCOPE_PRESETS, ttls: TTL_PRESETS }),

  // inference providers (settings store + probe + connect/sync)
  'providers:list': async () => listProvidersEnriched(),
  'providers:add': async (profile: ProviderProfile) => {
    upsertProvider(profile);
    return listProvidersEnriched();
  },
  'providers:remove': async (name: string) => {
    removeProvider(String(name));
    return listProvidersEnriched();
  },
  'providers:setDefault': async (name: string) => {
    setDefaultProvider(String(name));
    return listProvidersEnriched();
  },
  'providers:toggle': async (name: string) => {
    toggleProviderEnabled(String(name));
    return listProvidersEnriched();
  },
  'providers:probe': async (name: string) => {
    const p = loadSettings().providers.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    return new ProviderClient(p, resolveProviderKey(p)).probe();
  },
  // Connect & sync: resolve the key (config → env), validate live, cache the
  // discovered model list onto the provider so models stay discoverable.
  'providers:connect': async (name: string) => {
    const p = loadSettings().providers.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    const key = resolveProviderKey(p);
    const outcome = await new ProviderClient(p, key).probe();
    recordProviderSync(String(name), {
      at: Date.now(),
      status: outcome.status,
      modelCount: outcome.models.length,
      models: outcome.models.slice(0, 200).map((m) => m.id),
      keySource: keySourceOf(p),
    });
    return { providers: listProvidersEnriched(), outcome };
  },
  // Scan localhost for running LLM servers and flag which are already configured
  // (matched by normalized baseUrl, so adding the same server twice is avoided).
  'providers:discover': async () => {
    const found = await discoverLocalServers();
    const have = new Set(loadSettings().providers.map((p) => normUrl(p.baseUrl)));
    return found.map((s: DiscoveredServer) => ({ ...s, alreadyAdded: have.has(normUrl(s.baseUrl)) }));
  },
};

/** Loose URL normalization for de-duping discovered servers against existing providers. */
function normUrl(u: string): string {
  return u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
}

export async function call(method: string, args: unknown[] = []): Promise<unknown> {
  if (method === 'setTeam') {
    client = client.withTeam(String(args[0]) || undefined);
    return info();
  }
  if (method === 'setManager') {
    cfg = { ...cfg, managerUrl: String(args[0]) };
    client = new ManagerClient(cfg);
    return info();
  }
  if (method === 'info') return info();
  if (method === 'coordinator:get') return getCoordinator(String(args[0] ?? client.team ?? 'default')) ?? null;
  if (method === 'coordinator:set') {
    setCoordinator(String(args[0]), String(args[1]));
    return { ok: true };
  }
  if (method === 'coordinator:setPrimary') {
    setPrimaryCoordinator(String(args[0]), String(args[1]));
    return info();
  }
  if (method === 'coordinator:hierarchy') {
    const s = loadSettings();
    return { primary: s.primaryCoordinator ?? null, coordinators: s.coordinators ?? {} };
  }
  const fn = METHODS[method];
  if (!fn) throw new Error(`unknown method: ${method}`);
  return fn(...args);
}

export function info() {
  const team = client.team ?? 'default';
  return { managerUrl: client.managerUrl, team, coordinator: getCoordinator(team) ?? null };
}
