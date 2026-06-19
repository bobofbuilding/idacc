/**
 * ManagerClient — the one and only surface that talks to the id-agents manager
 * daemon (:4100). Everything else in idctl goes through here.
 *
 * Design notes:
 *  - Manager-local commands (/agents, /task, /teams, /status) come back from
 *    POST /remote synchronously in `result`. Agent-dispatch commands (/ask,
 *    /sync, /deploy) come back as `{ result: { queryId } }` to be polled via
 *    GET /query/:id?wait=N. `remote()` returns the raw envelope so callers
 *    decide; `dispatch()` is the convenience wrapper that dispatches + polls.
 *  - Errors are split into NetworkError (couldn't reach / 5xx / transient) and
 *    ManagerError (4xx or {ok:false}) so the UI can show "manager is down" very
 *    differently from "manager rejected that".
 */

import type {
  Agent,
  EventsResponse,
  InboxItem,
  NewsItem,
  ProbeResult,
  QueryResult,
  RemoteEnvelope,
  Task,
  Team,
} from './types.ts';
import type { Config } from '../config.ts';

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}
export class ManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerError';
  }
}

/**
 * Quote a free-text argument for a `/remote` slash-command so the manager's
 * tokenizer keeps it as ONE token — otherwise spaces split it and embedded
 * `--delivery`/`--timezone`/`--sender` words get hijacked as flags. The
 * tokenizer unescapes `\"`/`\'` inside a double-quoted span, so escape
 * backslash then double-quote before wrapping.
 */
function qArg(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class ManagerClient {
  constructor(private cfg: Config) {}

  get managerUrl(): string {
    return this.cfg.managerUrl;
  }
  get team(): string | undefined {
    return this.cfg.team;
  }
  /** Return a clone pinned to a different team (used by the team switcher). */
  withTeam(team: string | undefined): ManagerClient {
    return new ManagerClient({ ...this.cfg, team });
  }

  /** Return a clone with arbitrary config overrides (used to switch managers). */
  withConfig(overrides: Partial<Config>): ManagerClient {
    return new ManagerClient({ ...this.cfg, ...overrides });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.cfg.team) h['X-Id-Team'] = this.cfg.team;
    if (this.cfg.apiKey) h['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.admin) h['X-Id-Admin'] = '1';
    return h;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.managerUrl}${path}`, { headers: this.headers(), signal });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      if (res.status >= 500) throw new NetworkError(`GET ${path} → ${res.status}`);
      throw new ManagerError(`GET ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.managerUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { error?: string };
        detail = j?.error ? `: ${j.error}` : '';
      } catch {
        /* body not json */
      }
      if (res.status >= 500) throw new NetworkError(`POST ${path} → ${res.status}${detail}`);
      throw new ManagerError(`POST ${path} → ${res.status} ${res.statusText}${detail}`);
    }
    return (await res.json()) as T;
  }

  // ---- Health / liveness ------------------------------------------------

  async health(signal?: AbortSignal): Promise<{ status: string; team?: string; agents?: number }> {
    return this.get('/health', signal);
  }

  // ---- Teams & agents ---------------------------------------------------

  async teams(signal?: AbortSignal): Promise<Team[]> {
    const data = await this.get<{ teams?: Team[] }>('/teams', signal);
    return (data.teams ?? []).filter((t) => t.name.toLowerCase() !== 'all');
  }

  async agents(signal?: AbortSignal): Promise<Agent[]> {
    const q = this.cfg.team ? `?team=${encodeURIComponent(this.cfg.team)}` : '';
    const data = await this.get<{ agents?: Agent[] }>(`/agents${q}`, signal);
    return data.agents ?? [];
  }

  // ---- Live event stream ------------------------------------------------

  /** Long-poll the team event stream from a cursor. `wait` holds the socket. */
  async events(since: number, opts: { topics?: string; limit?: number; wait?: number } = {}, signal?: AbortSignal): Promise<EventsResponse> {
    const p = new URLSearchParams({ since: String(since), limit: String(opts.limit ?? 100) });
    if (opts.topics) p.set('topics', opts.topics);
    if (opts.wait) p.set('wait', String(opts.wait));
    return this.get<EventsResponse>(`/events?${p.toString()}`, signal);
  }

  // ---- Remote command surface ------------------------------------------

  /** Raw POST /remote. Returns the envelope; caller inspects `result`. */
  async remote<T = unknown>(command: string, agent?: string, signal?: AbortSignal): Promise<RemoteEnvelope<T>> {
    const env = await this.post<RemoteEnvelope<T>>('/remote', agent ? { agent, command } : { command }, signal);
    if (!env.ok) throw new ManagerError(env.error ?? 'manager rejected command');
    return env;
  }

  /** GET /query/:id with optional long-poll. */
  async query(queryId: string, wait?: number, signal?: AbortSignal): Promise<QueryResult> {
    const w = wait != null ? `?wait=${Math.max(0, Math.min(30, wait))}` : '';
    return this.get<QueryResult>(`/query/${encodeURIComponent(queryId)}${w}`, signal);
  }

  /**
   * Dispatch a /remote command that returns a queryId, then long-poll until a
   * terminal status. `onTick` fires after every poll so the UI can show "still
   * working…". Returns the agent's reply text (or throws ManagerError).
   */
  async dispatch(
    command: string,
    opts: { onTick?: (status: string) => void; totalTimeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const env = await this.remote<{ queryId?: string; status?: string; result?: string }>(command, undefined, opts.signal);
    const queryId = env.result?.queryId;
    // Some manager-local commands answer inline with no queryId.
    if (!queryId) return extractText(env.result) ?? '(no reply)';

    const deadline = Date.now() + (opts.totalTimeoutMs ?? 15 * 60 * 1000);
    while (Date.now() < deadline) {
      const q = await this.query(queryId, this.cfg.waitSeconds, opts.signal);
      opts.onTick?.(q.status);
      if (q.status === 'delivered') return extractText(q.result) ?? '(empty reply)';
      if (q.status === 'failed') throw new ManagerError(q.error || 'agent failed');
      if (q.status === 'expired') throw new ManagerError('query expired (agent did not reply in time)');
      if (q.status === 'cancelled') throw new ManagerError('query cancelled');
    }
    throw new ManagerError('timed out waiting for reply');
  }

  // ---- Conversational chat (manager inbox -> /talk) ---------------------

  /** Speak to the manager inbox. Returns the created queryId. */
  async talk(message: string, from = 'idctl', signal?: AbortSignal): Promise<string> {
    const r = await this.post<{ query_id: string }>('/talk', { message, from }, signal);
    return r.query_id;
  }

  // ---- Tasks ------------------------------------------------------------

  async tasks(signal?: AbortSignal): Promise<Task[]> {
    const env = await this.remote<{ tasks?: Task[] }>('/task', undefined, signal);
    return env.result?.tasks ?? [];
  }

  // ---- Manager inbox (questions awaiting a human) -----------------------

  async inboxPending(signal?: AbortSignal): Promise<InboxItem[]> {
    const data = await this.get<{ pending?: InboxItem[] }>('/manager/inbox/pending', signal);
    return data.pending ?? [];
  }

  async inboxRespond(queryId: string, message: string, sessionId?: string, signal?: AbortSignal): Promise<void> {
    await this.post('/manager/inbox/respond', { query_id: queryId, message, session_id: sessionId }, signal);
  }

  // ---- Local-model token usage (Ollama) ---------------------------------

  /**
   * Aggregated local-model (Ollama) token usage for the Health page: 24h/7d
   * windows + a recent-throughput reading. Returns null on managers that
   * predate the /usage route (older managers don't track tokens).
   */
  async usage(signal?: AbortSignal): Promise<UsageReport | null> {
    try {
      return await this.get<UsageReport>('/usage', signal);
    } catch (err) {
      if (err instanceof ManagerError) return null; // older manager: no route
      throw err;
    }
  }

  // ---- Health probes ----------------------------------------------------

  async probeAll(signal?: AbortSignal): Promise<ProbeResult> {
    const env = await this.remote<ProbeResult>('/agents probe', undefined, signal);
    return env.result as ProbeResult;
  }
  async probeOne(name: string, signal?: AbortSignal): Promise<ProbeResult> {
    const env = await this.remote<ProbeResult>(`/agent ${name} probe`, undefined, signal);
    return env.result as ProbeResult;
  }

  // ---- Model assignment / lifecycle ------------------------------------

  /**
   * Set an agent's model by id. NOTE: this only writes the DB and flips status
   * to `pending` — the agent must be restarted to actually load the new model.
   * Rejects (400) for non-local agents ("Only local runtime-backed agents have models").
   */
  async setAgentModel(agentId: string, model: string, signal?: AbortSignal): Promise<{ message?: string; status?: string }> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/model`, { model }, signal);
  }

  /**
   * Switch an agent's runtime (harness) by id. Writes the DB and flips status
   * to `pending`; the agent must be rebuilt to apply. Rejects (400) for
   * non-local agents or unknown runtimes.
   */
  async setAgentRuntime(agentId: string, runtime: string, signal?: AbortSignal): Promise<{ runtime?: string; needsRebuild?: boolean; message?: string }> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/runtime`, { runtime }, signal);
  }

  /** Restart an agent so a pending model/runtime change takes effect. */
  async restartAgent(name: string, signal?: AbortSignal): Promise<void> {
    await this.remote(`/agent ${name} rebuild`, undefined, signal);
  }

  /**
   * Create AND start a new local agent in the current team (POST /agents/spawn
   * with start:true). role/expertise seed the agent's catalog; heartbeatSeconds
   * enables an interval heartbeat; wallet provisions an OWS wallet post-create.
   */
  async spawnAgent(
    spec: { name: string; runtime?: string; model?: string; skills?: string[]; heartbeatSeconds?: number; role?: string; expertise?: string[]; wallet?: boolean },
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string; runtime?: string; port?: number }> {
    const catalog: Record<string, unknown> = {};
    if (spec.role?.trim()) catalog.role = spec.role.trim();
    if (spec.expertise?.length) catalog.expertise = spec.expertise;
    const body: Record<string, unknown> = {
      name: spec.name,
      start: true,
      ...(spec.runtime && { runtime: spec.runtime }),
      ...(spec.model && { model: spec.model }),
      ...(spec.skills?.length && { skills: spec.skills }),
      ...(spec.heartbeatSeconds && { heartbeat: spec.heartbeatSeconds }),
      ...(Object.keys(catalog).length && { metadata: { catalog } }),
    };
    const res = await this.post<{ id: string; name: string; runtime?: string; port?: number }>('/agents/spawn', body, signal);
    if (spec.wallet) {
      // Best-effort: agent is usable without it; surfaced in Identity & Keys.
      await this.remote(`/agent ${spec.name} wallet provision`, undefined, signal).catch(() => {});
    }
    return res;
  }

  // ---- Team relay (cross-team delegation allow-list) --------------------

  /** Read a team's relay policy. `delegates_to`: team names ("*"=all) or null=permissive. */
  async teamConfig(name: string, signal?: AbortSignal): Promise<{ name: string; delegates_to: string[] | null }> {
    return this.get(`/teams/${encodeURIComponent(name)}/config`, signal);
  }

  /** Set a team's relay allow-list. Pass string[] (or ["*"]), or null for permissive. */
  async setTeamDelegates(name: string, delegates: string[] | null, signal?: AbortSignal): Promise<{ name: string; delegates_to: string[] | null }> {
    return this.post(`/teams/${encodeURIComponent(name)}/delegates`, { delegates }, signal);
  }

  /**
   * Per-agent relay override. Overrides the team policy for this one agent;
   * null removes the override (inherit team). string[] (or ["*"]) restricts.
   */
  async setAgentDelegates(agentId: string, delegates: string[] | null, signal?: AbortSignal): Promise<{ agent: string; delegates_to: string[] | null }> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/delegates`, { delegates }, signal);
  }

  // ---- Scheduling / checkins -------------------------------------------

  async checkins(signal?: AbortSignal): Promise<CheckIn[]> {
    const d = await this.get<{ checkins?: CheckIn[] }>('/checkins', signal);
    return d.checkins ?? [];
  }

  /** All schedule definitions for the team (heartbeats + calendar check-ins), with last-run. */
  async schedules(signal?: AbortSignal): Promise<ScheduleEntry[]> {
    const env = await this.remote<{ schedules?: ScheduleEntry[] }>('/schedule list', undefined, signal);
    return env.result?.schedules ?? [];
  }

  /** Create/replace an agent's interval heartbeat (seconds, with a message). */
  async addHeartbeat(agent: string, seconds: number, message: string, delivery: 'internal' | 'talk' = 'internal', signal?: AbortSignal): Promise<unknown> {
    const env = await this.remote(`/schedule add heartbeat ${qArg(agent)} ${seconds} ${qArg(message)} --delivery ${delivery}`, undefined, signal);
    return env.result;
  }

  /** Create a recurring calendar check-in. `when` is days (mon,tue,…) or a date (YYYY-MM-DD). */
  async addCalendarCheckin(agent: string, time: string, when: string, message: string, opts: { timezone?: string; delivery?: 'internal' | 'talk'; signal?: AbortSignal } = {}): Promise<unknown> {
    const tz = opts.timezone ? ` --timezone ${qArg(opts.timezone)}` : '';
    const env = await this.remote(`/schedule add calendar ${qArg(agent)} ${qArg(time)} ${qArg(when)} ${qArg(message)} --delivery ${opts.delivery ?? 'talk'}${tz}`, undefined, opts.signal);
    return env.result;
  }

  async pauseSchedule(id: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.remote(`/schedule pause ${id}`, undefined, signal)).result;
  }
  async resumeSchedule(id: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.remote(`/schedule resume ${id}`, undefined, signal)).result;
  }
  async removeSchedule(id: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.remote(`/schedule remove ${id}`, undefined, signal)).result;
  }

  // ---- Library (persona templates + skills) -----------------------------

  async libraryAgents(signal?: AbortSignal): Promise<{ libraryRoot: string; entries: LibraryEntry[] }> {
    return this.get('/library/agents', signal);
  }

  // ---- Modules: skills + plugins catalog, install, MCP attach -----------

  /** Installable skills from the manager's library (SKILL.md catalog). */
  async librarySkills(signal?: AbortSignal): Promise<LibrarySkillEntry[]> {
    try {
      const d = await this.get<{ entries?: LibrarySkillEntry[] }>('/library/skills', signal);
      return d.entries ?? [];
    } catch (err) {
      if (err instanceof ManagerError) return []; // older manager: no route
      throw err;
    }
  }

  /** Installable plugins (plugins/claude-code). [] on managers without the route. */
  async libraryPlugins(signal?: AbortSignal): Promise<LibraryPluginEntry[]> {
    try {
      const d = await this.get<{ entries?: LibraryPluginEntry[] }>('/library/plugins', signal);
      return d.entries ?? [];
    } catch (err) {
      if (err instanceof ManagerError) return [];
      throw err;
    }
  }

  /** Install a library skill onto an agent (persists to metadata + live deploy). */
  async installSkill(skill: string, agent: string, signal?: AbortSignal): Promise<InstallSkillResult> {
    return this.post('/library/skills/install', { skill, agent }, signal);
  }

  /**
   * Create a new library skill (agentskills.io SKILL.md folder). Admin-gated on
   * the manager. Returns the created catalog entry; throws ManagerError on a
   * validation failure or name conflict (409 already_exists).
   */
  async createSkill(input: CreateSkillInput, signal?: AbortSignal): Promise<LibrarySkillEntry> {
    return this.post('/library/skills/create', input, signal);
  }

  /** Attach external MCP servers to an agent. Takes effect on next rebuild. */
  async setAgentMcp(agentId: string, servers: McpServerSpec[], signal?: AbortSignal): Promise<SetMcpResult> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/mcp`, { servers }, signal);
  }

  // ---- News feed --------------------------------------------------------

  async news(limit = 20, signal?: AbortSignal): Promise<NewsItem[]> {
    const d = await this.get<{ items?: NewsItem[] }>(`/news?limit=${limit}`, signal);
    return d.items ?? [];
  }

  // ---- Teams: library templates, deployable configs, create/load --------

  /**
   * Team templates from the upstream team library (id-agents ≥0.1.96).
   * Returns [] (and sets hasTeamLibrary=false) on managers that predate it.
   */
  async libraryTeams(signal?: AbortSignal): Promise<TeamTemplate[]> {
    try {
      const data = await this.get<{ teams?: TeamTemplate[]; entries?: TeamTemplate[] }>('/library/teams', signal);
      this._hasTeamLibrary = true;
      return data.teams ?? data.entries ?? [];
    } catch (err) {
      // 404 / not-found on older managers → no library; treat as empty.
      if (err instanceof ManagerError) {
        this._hasTeamLibrary = false;
        return [];
      }
      throw err;
    }
  }

  private _hasTeamLibrary?: boolean;
  /** Cached capability flag after a libraryTeams() probe (undefined = unknown). */
  get hasTeamLibrary(): boolean | undefined {
    return this._hasTeamLibrary;
  }

  /**
   * Install a library team template into a new team via the upstream endpoint
   * (POST /library/install rewrites the `team:` field via YAML AST). After
   * install, /deploy the new name to spawn it.
   */
  async installTeam(template: string, to: string, signal?: AbortSignal): Promise<unknown> {
    return this.post('/library/install', { from: `team:${template}`, to: `team:${to}` }, signal);
  }

  /** Server-side deployable team configs (configs/*.yaml on the manager host). */
  async configs(signal?: AbortSignal): Promise<ConfigEntry[]> {
    const env = await this.remote<{ configs?: ConfigEntry[] }>('/configs', undefined, signal);
    return env.result?.configs ?? [];
  }

  /**
   * Deploy (or CREATE) a team. The manager resolves `<name>` to
   * configs/<name>.yaml; if that file doesn't exist it falls back to
   * configs/default.yaml injecting name=<name> — i.e. `/deploy <newname>`
   * stands up a fresh team from the shipped default template. Returns the
   * agent's reply text once the dispatch completes.
   */
  async deployTeam(name: string, opts: { signal?: AbortSignal; onTick?: (s: string) => void } = {}): Promise<string> {
    return this.dispatch(`/deploy ${name}`, opts);
  }

  /** Non-destructive preflight of a deploy (what would be created). */
  async deployPreflight(name: string, signal?: AbortSignal): Promise<DeployPreflight | undefined> {
    const env = await this.remote<DeployPreflight>(`/deploy ${name} --dry-run`, undefined, signal);
    return env.result;
  }

  /** Reconcile an existing team against its YAML. */
  async syncTeam(name: string, opts: { signal?: AbortSignal; onTick?: (s: string) => void } = {}): Promise<string> {
    return this.dispatch(`/sync ${name}`, opts);
  }
}

export interface ConfigEntry {
  name: string;
  description?: string;
  agents?: number | unknown[];
}

export interface TeamTemplate {
  name: string;
  description?: string;
  agents?: number | unknown[];
  [key: string]: unknown;
}

export interface DeployPreflight {
  dryRun: boolean;
  configPath?: string;
  teamName?: string;
  calendarCount?: number;
  agents?: { name: string; runtime?: string; model?: string }[];
}

export interface CheckIn {
  id?: string | number;
  title?: string;
  dispatcher?: string;
  delegate?: string;
  status?: string;
  intervalSeconds?: number;
  nextDueAt?: number;
  linkedTask?: string;
  [key: string]: unknown;
}

export interface LibraryEntry {
  name: string;
  shape?: string;
  hasReadme?: boolean;
  subfolders?: string[];
  source_path?: string;
}

export interface LibrarySkillEntry {
  name: string;
  hasSkillMd?: boolean;
  source_path?: string;
  /** SKILL.md frontmatter description (catalog display). */
  description?: string | null;
  /** Tags parsed from frontmatter metadata.tags (catalog filtering). */
  tags?: string[];
  /** SKILL.md frontmatter license. */
  license?: string | null;
}

export interface LibraryPluginEntry {
  name: string;
  hasManifest?: boolean;
  version?: string | null;
  description?: string | null;
  source_path?: string;
  /** Manifest author name, when present. */
  author?: string | null;
  /** Origin: repository/homepage/marketplace URL, or "bundled (local)". */
  source?: string | null;
}

/** Input for createSkill — mirrors the agentskills.io SKILL.md frontmatter. */
export interface CreateSkillInput {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Space-separated tool allow-list → frontmatter `allowed-tools`. */
  allowedTools?: string;
  /** Arbitrary string→string map → frontmatter `metadata` (tags, category…). */
  metadata?: Record<string, string>;
  /** Markdown instructions (body after the frontmatter). */
  body?: string;
  overwrite?: boolean;
}

/** MCP server transport — only the serializable kinds cross the spawn boundary. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** Normalized MCP server definition (matches id-agents harness McpServerSpec). */
export interface McpServerSpec {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface InstallSkillResult {
  installed: string;
  agent: string;
  skills: string[];
}

/** One agent's token throughput within a usage window. */
export interface UsageAgent {
  agent: string;
  count: number;
  output: number;
  avgTps: number;
}

/** Aggregated token usage over a window (24h or 7d). */
export interface UsageWindow {
  count: number;
  input: number;
  output: number;
  total: number;
  avgPerQuery: number;
  /** Token-weighted average throughput (output tokens / generation seconds). */
  avgTps: number;
  agents: UsageAgent[];
}

export interface UsageReport {
  now: number;
  day: UsageWindow;
  week: UsageWindow;
  recent: { tps: number | null; output: number | null; model: string; agent: string; at: number } | null;
}

export interface ScheduleEntry {
  id: string;
  title: string;
  kind: 'heartbeat' | 'calendar';
  active: boolean;
  deliveryMode: 'internal' | 'talk';
  sourceType: string;
  targets: string[];
  intervalSeconds: number | null;
  timezone: string | null;
  localTimeSeconds: number | null;
  localDate: string | null;
  daysOfWeek: string | null;
  message: string;
  createdAt: number;
  /** Unix seconds of the most recent run, or null if never fired. */
  lastRunAt: number | null;
  lastStatus: 'pending' | 'sent' | 'failed' | 'skipped' | null;
}

export interface SetMcpResult {
  agent: string;
  mcpServers: McpServerSpec[];
  needsRebuild: boolean;
}

/** Pull human-readable text out of the assorted result envelopes. */
export function extractText(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.result === 'string') return r.result;
    if (r.result && typeof r.result === 'object') {
      const inner = r.result as Record<string, unknown>;
      if (typeof inner.result === 'string') return inner.result;
      if (typeof inner.message === 'string') return inner.message;
    }
    if (typeof r.message === 'string') return r.message;
    if (typeof r.output === 'string') return r.output;
  }
  return undefined;
}
