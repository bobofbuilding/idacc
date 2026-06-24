/**
 * Main-process bridge to the id-agents manager + local stores. Reuses the
 * idctl ManagerClient, key provider, inference-provider client, and settings
 * store (all pure TS / Node) — the React renderer reaches them only via the
 * allow-listed methods below over IPC.
 */

import { ManagerClient } from '../../../idctl/src/api/client.ts';
import { runOnboarding, type OnboardPlan } from '../../../idctl/src/api/onboard.ts';
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
  setLocalConcurrencyPref,
  setSkillTags,
  setTaskLane,
} from '../../../idctl/src/settings/store.ts';
import { detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { discoverLocalServers, type DiscoveredServer } from '../../../idctl/src/settings/localDiscovery.ts';
import { kindNeedsKey, type ProviderProfile, type McpServerProfile, type ProjectEntry } from '../../../idctl/src/settings/schema.ts';
import { buildRuntimeCatalog } from '../../../idctl/src/settings/runtimeCatalog.ts';
import { testMcpServer } from './mcpTest.ts';
import { decomposeWork, createAndDispatchPlan, fanOutObjective, teamLeads, triageUnassigned, type SubTask } from './work.ts';
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
import { brokerServerPath, mintAgentToken, revokeAgentToken, brokerUrl } from './computeruse/broker.ts';
// The Computer Use MCP server name. NEVER "computer-use" — Claude Code reserves that
// name and rejects the entire MCP config, breaking every dispatch. CU_MCP_ALIASES
// includes the old broken name so existing attachments can be detected + cleaned up.
const CU_MCP_NAME = 'mac-control';
const CU_MCP_ALIASES = ['mac-control', 'computer-use'];

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
  // Live agent activity (tool/file steps) for the chat "what they're doing" feed.
  // Team-scoped so a same-named agent in another team can't bleed in; an optional
  // queryId narrows to a single dispatch (exact attribution when two dispatches
  // hit the same agent concurrently).
  'activity:get': (agent: string, since: number, team?: string, queryId?: string) =>
    client.activity(String(agent), Number(since) || 0, team ? String(team) : client.team, queryId ? String(queryId) : undefined),
  inboxPending: () => client.inboxPending(),
  // AI-assist: ask an agent to draft text (agent/team goals + instructions). Uses
  // the team's ★ coordinator when set, else any running agent.
  'ai:draft': (instruction: string, agent?: string) =>
    client.draftWithAI(String(instruction), { agent: agent ? String(agent) : (getCoordinator(client.team ?? 'default') ?? undefined) }),
  // Reply to a manager-inbox item (delivers the reply + clears it from pending).
  'inbox:respond': (queryId: string, message: string) => client.inboxRespond(String(queryId), String(message)),
  // Dismiss a manager-inbox item without a real answer (clears it from pending).
  'inbox:dismiss': (queryId: string) => client.inboxRespond(String(queryId), '(dismissed via control center)'),

  // tasks
  tasks: () => client.tasks(),
  // app-side Kanban lane overlay (task ref → fine-grained lane; never sent to the manager)
  'tasks:lanes': () => Promise.resolve(loadSettings().taskLanes ?? {}),
  'tasks:setLane': (ref: string, lane: string) => Promise.resolve(setTaskLane(String(ref), String(lane ?? '')).taskLanes ?? {}),

  // dispatch / lifecycle
  dispatch: (command: string) => client.dispatch(String(command)),
  remote: (command: string, agent?: string) => client.remote(String(command), agent),

  // Resumable dispatch: START returns a queryId (or an inline reply for
  // manager-local commands); POLL checks that query. The renderer owns the loop
  // so an in-flight reply survives navigation, long tasks, and app restarts.
  'dispatch:start': async (command: string, sessionId?: string) => {
    // sessionId = the desktop chat id → agent conversation key (isolates each chat).
    const env = await client.remote<{ queryId?: string; status?: string; result?: string; message?: string }>(String(command), undefined, undefined, sessionId ? String(sessionId) : undefined);
    const r = env.result as any;
    const queryId = r?.queryId;
    if (queryId) return { queryId: String(queryId) };
    const inline = typeof r === 'string' ? r : (r?.result ?? r?.message ?? '');
    return { inline: String(inline || '(no reply)') };
  },
  'query:poll': async (queryId: string, wait?: number) => {
    const q = await client.query(String(queryId), typeof wait === 'number' ? wait : undefined);
    const r = q.result as any;
    const text = typeof r === 'string' ? r : (r?.result ?? r?.message ?? '');
    return { status: q.status, text: String(text || ''), error: q.error };
  },

  // auto-decompose work for the fleet: lead splits an objective into sub-tasks…
  'work:decompose': async (objective: string, lead: string) => {
    const agents = await client.agents().catch(() => []);
    const list = agents.map((a) => ({
      name: a.name,
      runtime: a.runtime,
      status: a.status,
      skills: Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [],
    }));
    return decomposeWork(client, String(objective), String(lead), list);
  },
  // …then create them all + farm out the work (parallel where possible). opts.lane
  // sets the Kanban lane; opts.dispatch=false queues them unowned instead of dispatching.
  'work:createPlan': (objective: string, subtasks: SubTask[], opts?: { dispatch?: boolean; lane?: string }) =>
    createAndDispatchPlan(client, String(objective), Array.isArray(subtasks) ? subtasks : [], opts ?? {}),
  // Cross-team fan-out: hand one objective to several teams' ACTIVE leads at once.
  'work:teamLeads': (teams: string[]) => teamLeads(client, Array.isArray(teams) ? teams.map(String) : []),
  'work:fanout': (objective: string, teams: string[]) =>
    fanOutObjective(client, String(objective), Array.isArray(teams) ? teams.map(String) : []),
  // Lead triages unassigned To-Do tasks: assign each to the best active agent + dispatch.
  'work:triage': (lead: string) => triageUnassigned(client, String(lead)),

  // health probes
  probeAll: () => client.probeAll(),
  probeOne: (name: string) => client.probeOne(String(name)),

  // scheduling
  checkins: () => client.checkins(),
  'checkins:close': (id: string) => client.closeCheckin(String(id)),
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
  'team:install': (template: string, to: string) => client.installTeam(String(template), String(to)),
  configs: () => client.configs(),
  'team:preflight': (name: string) => client.deployPreflight(String(name)),
  deployTeam: (name: string) => client.deployTeam(String(name)),
  'team:delete': (name: string) => client.deleteTeam(String(name)),
  // Import a team from a pasted spec: spawn each parsed agent into a new team.
  'team:import': (team: string, agents: Array<{ name: string; role?: string; description?: string }>, opts: { runtime?: string; model?: string }) =>
    client.importTeam(String(team), agents ?? [], opts ?? {}),
  // Whole-team lifecycle: start/stop/rebuild every agent (fan-out), or probe the team.
  'team:lifecycle': (team: string, op: string) =>
    client.teamLifecycle(String(team), op === 'stop' ? 'stop' : op === 'rebuild' ? 'rebuild' : 'start'),
  'team:probe': (team: string) => client.probeTeam(String(team)),
  // Local-model (ollama) concurrency — how many local inferences run at once.
  'manager:localConcurrency': () => client.localConcurrency(),
  'manager:setLocalConcurrency': async (n: number) => {
    const r = await client.setLocalConcurrency(Number(n));
    setLocalConcurrencyPref(Number(n)); // persist → re-applied on connect (survives a manager restart)
    return r;
  },
  // Re-apply the persisted local concurrency to the manager — called on (re)connect.
  'manager:applyStoredConcurrency': async () => {
    const pref = loadSettings().localConcurrency;
    if (typeof pref === 'number' && pref >= 1) {
      return client.setLocalConcurrency(pref).then((r) => ({ applied: r.concurrency })).catch(() => ({ applied: null as number | null }));
    }
    return { applied: null as number | null };
  },
  // AI-assisted parse of a free-form spec → { team, agents }. Dispatches to the
  // team's designated coordinator (★) when set, else any running agent.
  'team:parseSpecAI': (spec: string) =>
    client.parseTeamSpecAI(String(spec), { agent: getCoordinator(client.team ?? 'default') ?? undefined }),
  // AI-assisted FULL team design → { team, agents[] } with per-agent runtime/model/skills/lead.
  // The renderer passes its available runtimes/models/skills so the model picks valid choices.
  'team:designAI': (spec: string, ctx?: { runtimes?: string[]; models?: Record<string, string[]>; skills?: string[] }) =>
    client.designTeamAI(String(spec), { ...(ctx ?? {}), agent: getCoordinator(client.team ?? 'default') ?? undefined }),

  // team relay (cross-team delegation allow-list) + per-agent override
  teamConfig: (name: string) => client.teamConfig(String(name)),
  setTeamDelegates: (name: string, delegates: string[] | null) => client.setTeamDelegates(String(name), delegates ?? null),
  setAgentDelegates: (id: string, delegates: string[] | null) => client.setAgentDelegates(String(id), delegates ?? null),

  // dashboard: switch runtime (rebuild required to apply)
  setAgentRuntime: (id: string, runtime: string) => client.setAgentRuntime(String(id), String(runtime)),
  // reassign a local agent to another team (rebuilds it there)
  'agent:move': (id: string, team: string) => client.moveAgent(String(id), String(team)),

  // per-agent persistent instructions (system-prompt addendum, e.g. coordinator role)
  'agent:getInstructions': (idOrName: string) => client.agentInstructions(String(idOrName)),
  // Optional `team` scopes the call to a specific team (e.g. the Team Builder
  // wiring a lead in a freshly-created team that isn't the active one yet).
  'agent:setInstructions': (idOrName: string, instructions: string, team?: string) =>
    (team ? client.withTeam(String(team)) : client).setAgentInstructions(String(idOrName), String(instructions ?? '')),

  // teams: create + start a new agent
  spawnAgent: (spec: Parameters<ManagerClient['spawnAgent']>[0]) => client.spawnAgent(spec),
  'identity:register': (agent: string) => client.remote(`/register ${String(agent)}`),
  'wallet:provision': (agent: string) => client.remote(`/agent ${String(agent)} wallet provision`),
  'onboard:run': (plan: OnboardPlan) => runOnboarding(client, plan),

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
  // Skill auto-categorization (app-side tag overlay; never writes the SKILL.md).
  // Returns the cached name→tags overlay merged into the Capabilities catalog.
  'skills:autoTags': () => Promise.resolve(loadSettings().skillTags ?? {}),
  // Categorize library skills lacking frontmatter tags via one batch /ask (heuristic
  // fallback), persist to the overlay, and return the full overlay. force=true
  // re-categorizes every untagged skill (ignores the cache).
  'skills:categorize': async (force?: boolean) => {
    const skills = await client.librarySkills();
    const cached = loadSettings().skillTags ?? {};
    const targets = skills.filter((s) => !(s.tags && s.tags.length) && (force || !cached[s.name]));
    if (!targets.length) return cached;
    const derived = await client.categorizeSkillsAI(targets.map((s) => ({ name: s.name, description: s.description })));
    setSkillTags(derived);
    return loadSettings().skillTags ?? {};
  },
  installSkill: (skill: string, agent: string) => client.installSkill(String(skill), String(agent)),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
  deleteSkill: (name: string) => client.deleteSkill(String(name)),
  uninstallSkill: (skill: string, agent: string) => client.uninstallSkill(String(skill), String(agent)),
  usage: () => client.usage(),
  setAgentMcp: (agentId: string, servers: McpServerSpec[]) => client.setAgentMcp(String(agentId), servers ?? []),
  rebuildAgent: (agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).remote(`/agent ${agent} rebuild`),

  // Computer Use: attach/detach the bundled computer-use MCP server to an agent
  // (a "bless" — lets that agent drive the Mac through the broker). Merges with
  // the agent's existing MCP servers (never clobbers them) and dedupes by name.
  'cu:attach': async (agentId: string, agentName: string) => {
    // NEVER swallow the fetch into [] — a transient failure would make `cur` empty
    // and the wholesale-replace POST would WIPE the agent's other MCP servers. Let
    // it throw, and fail closed if the agent isn't found, so we only ever merge
    // onto a known-good current list.
    const agents = await client.agents();
    const a = agents.find((x) => x.id === agentId || x.name === agentId || x.name === agentName);
    if (!a) throw new Error(`agent not found: ${agentName || agentId}`);
    const cur = (((a.metadata as any)?.mcpServers) ?? []) as McpServerSpec[];
    // Per-agent token + broker URL injected here, so the agent authenticates AS itself
    // (the broker derives identity from the token, not a self-reported name). The
    // server name MUST NOT be "computer-use" — Claude Code reserves that and rejects
    // the WHOLE MCP config, breaking every dispatch to the agent.
    const spec: McpServerSpec = { name: CU_MCP_NAME, command: 'node', args: [brokerServerPath()], env: { ID_CU_AGENT: String(a.name), ID_CU_TOKEN: mintAgentToken(a.name), ID_CU_URL: brokerUrl() } };
    const next = [...cur.filter((s) => !CU_MCP_ALIASES.includes(s.name)), spec]; // also strips the old broken name
    return client.setAgentMcp(a.id, next);
  },
  'cu:detach': async (agentId: string, agentName?: string) => {
    const agents = await client.agents();
    const a = agents.find((x) => x.id === agentId || x.name === agentId || x.name === agentName);
    if (!a) throw new Error(`agent not found: ${agentName || agentId}`);
    revokeAgentToken(a.name);
    const cur = (((a.metadata as any)?.mcpServers) ?? []) as McpServerSpec[];
    return client.setAgentMcp(a.id, cur.filter((s) => !CU_MCP_ALIASES.includes(s.name)));
  },
  // Agents that have computer-use attached (for the view's "blessed" list) — detects
  // the old reserved name too, so a previously-broken agent shows up to be removed/re-blessed.
  'cu:attached': async () => {
    const agents = await client.agents().catch(() => [] as Awaited<ReturnType<typeof client.agents>>);
    return agents
      .filter((a) => (((a.metadata as any)?.mcpServers ?? []) as { name: string }[]).some((s) => CU_MCP_ALIASES.includes(s.name)))
      .map((a) => ({ id: a.id, name: a.name }));
  },

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
