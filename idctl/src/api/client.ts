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
  ActiveAgentQueries,
  EventsResponse,
  ActivityResponse,
  InboxItem,
  ManagerEvent,
  NewsItem,
  ProbeResult,
  QueryResult,
  RemoteEnvelope,
  Task,
  Team,
} from './types.ts';
import type { Config } from '../config.ts';
import { slugName, type ParsedTeamSpec } from './teamSpec.ts';

/** One agent in an AI-designed team — richer than a ParsedTeamSpec agent: it also
 *  carries a suggested runtime/model/skills the team builder can apply per agent,
 *  and a `lead` flag nominating the single coordinator. */
export interface DesignedAgent {
  name: string;
  role: string;
  description: string;
  runtime?: string;
  model?: string;
  skills?: string[];
  lead?: boolean;
}
export interface DesignedTeam {
  team: string | null;
  agents: DesignedAgent[];
  suggestions?: {
    agents: string[];
    skills: string[];
  };
}

/**
 * Sanitize a raw, AI-produced team object into a trustworthy {@link DesignedTeam}:
 * slug names + dedupe, clamp role/description length, DROP any runtime/model/skill
 * the caller didn't offer (the model can hallucinate), and guarantee exactly one
 * lead (default to the first agent if none was flagged). Pure + side-effect free so
 * it is unit-testable without a live manager — {@link ManagerClient.designTeamAI}
 * calls it on the model's reply.
 */
export function sanitizeDesignedTeam(
  obj: { team?: unknown; agents?: unknown; suggestions?: unknown },
  opts: { runtimes?: string[]; models?: Record<string, string[]>; skills?: string[] } = {},
): DesignedTeam {
  const runtimeSet = new Set((opts.runtimes ?? []).filter(Boolean));
  const skillSet = new Set((opts.skills ?? []).filter(Boolean));
  const seen = new Set<string>();
  const agents: DesignedAgent[] = [];
  let leadAssigned = false;
  if (Array.isArray(obj.agents)) {
    for (const a of obj.agents) {
      const o = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
      const name = slugName(String(o.name ?? ''));
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const role = String(o.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const description = String(o.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000) || role;
      const runtime = runtimeSet.has(String(o.runtime ?? '')) ? String(o.runtime) : undefined;
      const modelList = runtime ? (opts.models?.[runtime] ?? []) : [];
      const model = modelList.includes(String(o.model ?? '')) ? String(o.model) : undefined;
      const agentSkills = Array.isArray(o.skills)
        ? [...new Set((o.skills as unknown[]).map((s) => String(s)).filter((s) => skillSet.has(s)))]
        : undefined;
      const lead = !leadAssigned && o.lead === true;
      if (lead) leadAssigned = true;
      agents.push({ name, role, description, runtime, model, skills: agentSkills, lead });
    }
  }
  // Guarantee exactly one lead — default to the first agent if the AI named none.
  if (!leadAssigned && agents.length) agents[0].lead = true;
  const team = typeof obj.team === 'string' && obj.team.trim() ? slugName(obj.team) : null;
  const suggestions = sanitizeDesignSuggestions(obj.suggestions);
  return suggestions.agents.length || suggestions.skills.length ? { team, agents, suggestions } : { team, agents };
}

function sanitizeDesignSuggestions(raw: unknown): { agents: string[]; skills: string[] } {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const clean = (items: unknown): string[] => {
    if (!Array.isArray(items)) return [];
    return [...new Set(items.map((item) => String(item).replace(/\s+/g, ' ').trim()).filter(Boolean))]
      .map((item) => item.slice(0, 240))
      .slice(0, 8);
  };
  return { agents: clean(o.agents), skills: clean(o.skills) };
}

/** Controlled vocabulary for skill auto-categorization. The AI picks tags from
 *  this set (plus at most one extra specific tag) so catalog tags stay consistent
 *  and filterable; the heuristic fallback maps onto the same vocabulary. */
export const SKILL_CATEGORIES = [
  'research', 'coding', 'documentation', 'communication', 'messaging', 'coordination',
  'knowledge', 'identity', 'wallet', 'onchain', 'payments', 'registry', 'catalog',
  'monitoring', 'deployment', 'automation', 'workflow', 'data', 'integration',
  'security', 'testing', 'admin', 'marketplace', 'general',
] as const;

// Keyword → category rules for the offline heuristic categorizer (the fallback
// when no agent is available, and the per-skill baseline AI results merge over).
const SKILL_TAG_RULES: Array<[RegExp, string[]]> = [
  [/research|investigat|analy|\bstudy\b|explore/i, ['research']],
  [/\bcod(e|ing)\b|implement|program|refactor|compil|file change|run command/i, ['coding']],
  [/document|\bdocs?\b|readme|write[- ]?up/i, ['documentation']],
  [/messag|\bchat\b|xmtp|\bemail\b|notif/i, ['messaging', 'communication']],
  [/communicat|send and receive|talk to/i, ['communication']],
  [/coordinat|delegat|orchestrat|\blead\b|\bteam\b/i, ['coordination']],
  [/knowledge|graph|memory|persistent|recall|\bbrain\b/i, ['knowledge']],
  [/identity|\bens\b|persona|profile/i, ['identity']],
  [/wallet|\bsign\b|transaction|on[- ]?chain|ethereum|\baddress(es)?\b/i, ['wallet', 'onchain']],
  [/\bpay\b|payment|invoice|\btoken\b|billing/i, ['payments']],
  [/regist(er|ry)|directory|public[- ]?agent|discover/i, ['registry']],
  [/catalog/i, ['catalog']],
  [/monitor|watch|alert|health|probe|uptime/i, ['monitoring']],
  [/deploy|release|publish|\bship\b/i, ['deployment']],
  [/\btask\b|lifecycle|discipline|\bclaim\b|workflow/i, ['workflow']],
  [/\badmin\b|manage|control|provision/i, ['admin']],
  [/\btest\b|verify|\bqa\b|assert/i, ['testing']],
  [/security|\bauth\b|secret|permission|guard/i, ['security']],
  [/market(place)?|listing/i, ['marketplace']],
  [/\bapi\b|integrat|connect|webhook/i, ['integration']],
  [/\bdata\b|database|\bsql\b|extract|\bcsv\b|\bjson\b|spreadsheet/i, ['data']],
  [/automat|schedul|\bcron\b|trigger/i, ['automation']],
];

/** Offline, deterministic categorizer: map a skill's name+description to up to
 *  `max` vocabulary tags. Returns ['general'] when nothing matches. Pure. */
export function heuristicSkillTags(name: string, description?: string | null, max = 4): string[] {
  const hay = `${name} ${description ?? ''}`;
  const out: string[] = [];
  for (const [re, tags] of SKILL_TAG_RULES) {
    if (re.test(hay)) for (const t of tags) if (!out.includes(t)) out.push(t);
  }
  return (out.length ? out : ['general']).slice(0, max);
}

/** Validate an AI categorization reply into a clean name→tags map: keep only the
 *  skill names we asked about, slug + dedupe each tag, cap per skill. Pure. */
export function sanitizeSkillTags(raw: unknown, names: string[], max = 4): Record<string, string[]> {
  const known = new Set(names);
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k) || !Array.isArray(v)) continue;
    const tags = [...new Set(v.map((t) => slugName(String(t))).filter(Boolean))].slice(0, max);
    if (tags.length) out[k] = tags;
  }
  return out;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type TaskStatusFilter = 'todo' | 'doing' | 'done';
export class ManagerError extends Error {
  /** HTTP status that produced this error (when known). 404 = route missing on
   *  a stock/older manager; used by requireRoute() to give an actionable message. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ManagerError';
    this.status = status;
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

const DEFAULT_MANAGER_TIMEOUT_MS = 35_000;
const LONG_POLL_GRACE_MS = 5_000;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textField(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function labelField(value: unknown): string | undefined {
  const direct = textField(value);
  if (direct != null) return direct;
  const obj = objectRecord(value);
  return textField(obj.name) ?? textField(obj.alias) ?? textField(obj.id) ?? textField(obj.query_id);
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => textField(item)?.trim()).filter((item): item is string => !!item);
}

function delegatesField(value: unknown): string[] | null {
  if (value === '*') return ['*'];
  return stringList(value) ?? null;
}

export function normalizeTaskRecord(raw: unknown): Task | null {
  const row = objectRecord(raw);
  if (!Object.keys(row).length) return null;
  const title = textField(row.title) ?? textField(row.name) ?? textField(row.shortId) ?? textField(row.uuid);
  if (!title) return null;
  return {
    ...(textField(row.name) ? { name: textField(row.name) } : {}),
    ...(textField(row.uuid) ? { uuid: textField(row.uuid) } : {}),
    ...(textField(row.shortId ?? row.short_id) ? { shortId: textField(row.shortId ?? row.short_id) } : {}),
    title,
    description: textField(row.description) ?? null,
    status: textField(row.status) ?? 'todo',
    ownerName: textField(row.ownerName ?? row.owner_name ?? row.owner) ?? null,
    ...(textField(row.teamName ?? row.team_name ?? row.team) ? { teamName: textField(row.teamName ?? row.team_name ?? row.team) } : {}),
    linkedEvents: stringList(row.linkedEvents ?? row.linked_events) ?? [],
    createdAt: numberField(row.createdAt ?? row.created_at) ?? 0,
    updatedAt: numberField(row.updatedAt ?? row.updated_at),
    completedAt: numberField(row.completedAt ?? row.completed_at) ?? null,
  };
}

export function normalizeManagerEvent(raw: unknown): ManagerEvent | null {
  const row = objectRecord(raw);
  if (!Object.keys(row).length) return null;
  const data = objectRecord(row.data);
  const topic = textField(row.topic) ?? textField(data.topic) ?? 'event';
  return {
    seq: numberField(row.seq) ?? 0,
    ...(textField(row.team) ? { team: textField(row.team) } : {}),
    topic,
    ...(labelField(row.actor) ? { actor: labelField(row.actor) } : {}),
    ...(labelField(row.subject) ? { subject: labelField(row.subject) } : {}),
    data,
    ...(numberField(row.timestamp) != null ? { timestamp: numberField(row.timestamp) } : {}),
    ...(numberField(row.occurred_at ?? row.occurredAt) != null ? { occurred_at: numberField(row.occurred_at ?? row.occurredAt) } : {}),
  };
}

function normalizeAgentRecord(raw: unknown): Agent | null {
  const row = objectRecord(raw);
  const id = textField(row.id) ?? textField(row.name);
  const name = textField(row.name) ?? textField(row.alias) ?? id;
  if (!id || !name) return null;
  const metadata = objectRecord(row.metadata);
  return {
    id,
    name,
    ...(textField(row.alias) ? { alias: textField(row.alias) } : {}),
    port: numberField(row.port) ?? 0,
    status: textField(row.status) ?? 'unknown',
    ...(textField(row.health) ? { health: textField(row.health) } : {}),
    ...(textField(row.model) ? { model: textField(row.model) } : {}),
    ...(textField(row.type) ? { type: textField(row.type) } : {}),
    ...(textField(row.runtime) ? { runtime: textField(row.runtime) } : {}),
    ...(textField(row.url) ? { url: textField(row.url) } : {}),
    ...(textField(row.workingDirectory ?? row.working_directory) ? { workingDirectory: textField(row.workingDirectory ?? row.working_directory) } : {}),
    createdAt: numberField(row.createdAt ?? row.created_at) ?? 0,
    lastHealthCheck: numberField(row.lastHealthCheck ?? row.last_health_check),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(textField(row.teamName ?? row.team_name ?? row.team) ? { teamName: textField(row.teamName ?? row.team_name ?? row.team) } : {}),
    ...(textField(row.deploymentShape) === 'remote-endpoint' ? { deploymentShape: 'remote-endpoint' as const } : textField(row.deploymentShape) === 'local-process' ? { deploymentShape: 'local-process' as const } : {}),
    pid: numberField(row.pid) ?? null,
    customer_domain: textField(row.customer_domain) ?? null,
    public_endpoint_url: textField(row.public_endpoint_url) ?? null,
    ows_wallet: textField(row.ows_wallet) ?? null,
    ows_address: textField(row.ows_address) ?? null,
    idchain_domain: textField(row.idchain_domain) ?? null,
    ssh_target: textField(row.ssh_target) ?? null,
    last_seen: numberField(row.last_seen) ?? null,
    last_probed_at: numberField(row.last_probed_at) ?? null,
    last_error: textField(row.last_error) ?? null,
    consecutive_failures: numberField(row.consecutive_failures),
  };
}

function normalizeTeamRecord(raw: unknown): Team | null {
  const row = objectRecord(raw);
  const name = textField(row.name);
  if (!name) return null;
  return {
    id: textField(row.id) ?? name,
    name,
    agentCount: numberField(row.agentCount ?? row.agent_count ?? row.agents) ?? 0,
    ...(textField(row.createdAt ?? row.created_at) ? { createdAt: textField(row.createdAt ?? row.created_at) } : {}),
  };
}

function normalizeInboxRecord(raw: unknown): InboxItem | null {
  const row = objectRecord(raw);
  const queryId = textField(row.query_id ?? row.queryId);
  if (!queryId) return null;
  const schedule = objectRecord(row.schedule);
  return {
    query_id: queryId,
    prompt: textField(row.prompt) ?? null,
    message: textField(row.message) ?? textField(row.prompt) ?? queryId,
    timestamp: numberField(row.timestamp) ?? numberField(row.createdAt ?? row.created_at) ?? Date.now(),
    status: textField(row.status) ?? 'pending',
    session_id: textField(row.session_id ?? row.sessionId) ?? null,
    from: textField(row.from) ?? null,
    reply_endpoint: textField(row.reply_endpoint ?? row.replyEndpoint) ?? null,
    schedule: Object.keys(schedule).length ? schedule : null,
    mode: textField(row.mode) ?? null,
  };
}

function taskStatusCol(status?: string): TaskStatusFilter {
  if (/done|complete/i.test(status ?? '')) return 'done';
  if (/doing|claim|progress|start|active/i.test(status ?? '')) return 'doing';
  return 'todo';
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

  private async responseErrorDetail(res: Response): Promise<string> {
    try {
      const text = await res.text();
      if (!text) return '';
      try {
        const j = JSON.parse(text) as { error?: unknown };
        return typeof j?.error === 'string' && j.error ? `: ${j.error}` : '';
      } catch {
        return `: ${text.slice(0, 400)}`;
      }
    } catch {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      return '';
    }
  }

  private async jsonOrThrow<T>(method: string, path: string, res: Response): Promise<T> {
    if (!res.ok) {
      const detail = await this.responseErrorDetail(res);
      if (res.status >= 500) throw new NetworkError(`${method} ${path} → ${res.status}${detail}`);
      throw new ManagerError(`${method} ${path} → ${res.status} ${res.statusText}${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  private requestSignal(signal?: AbortSignal, timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS): { signal?: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
    if (!signal && timeoutMs <= 0) return { signal: undefined, cleanup: () => {}, timedOut: () => false };
    const ctrl = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let didTimeout = false;
    const abortFromCaller = () => { try { ctrl.abort(signal?.reason); } catch { ctrl.abort(); } };
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        didTimeout = true;
        try { ctrl.abort(new Error(`manager request timed out after ${timeoutMs}ms`)); } catch { ctrl.abort(); }
      }, timeoutMs);
    }
    return {
      signal: ctrl.signal,
      cleanup: () => {
        if (timeout) clearTimeout(timeout);
        if (signal && !signal.aborted) signal.removeEventListener('abort', abortFromCaller);
      },
      timedOut: () => didTimeout,
    };
  }

  private requestError(method: string, path: string, err: unknown, timedOut: boolean): NetworkError {
    if (timedOut) return new NetworkError(`${method} ${path} timed out`);
    return new NetworkError(err instanceof Error ? err.message : String(err));
  }

  private async get<T>(path: string, signal?: AbortSignal, timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS): Promise<T> {
    const req = this.requestSignal(signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.managerUrl}${path}`, { headers: this.headers(), signal: req.signal });
    } catch (err) {
      req.cleanup();
      throw this.requestError('GET', path, err, req.timedOut());
    }
    try {
      return await this.jsonOrThrow<T>('GET', path, res);
    } finally {
      req.cleanup();
    }
  }

  private async del<T>(path: string, signal?: AbortSignal, timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS): Promise<T> {
    const req = this.requestSignal(signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.managerUrl}${path}`, { method: 'DELETE', headers: this.headers(), signal: req.signal });
    } catch (err) {
      req.cleanup();
      throw this.requestError('DELETE', path, err, req.timedOut());
    }
    try {
      return await this.jsonOrThrow<T>('DELETE', path, res);
    } finally {
      req.cleanup();
    }
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS): Promise<T> {
    const req = this.requestSignal(signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.managerUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal: req.signal,
      });
    } catch (err) {
      req.cleanup();
      throw this.requestError('POST', path, err, req.timedOut());
    }
    try {
      return await this.jsonOrThrow<T>('POST', path, res);
    } finally {
      req.cleanup();
    }
  }

  /**
   * Wrap a write whose manager route a stock/older id-agents may not expose.
   * A 404 (route missing) is rethrown as a clear, actionable ManagerError naming
   * the feature — instead of a raw "POST /x → 404 Not Found". Validation errors
   * (other 4xx), NetworkError, and success all pass through unchanged. This keeps
   * the control center honest: features that need a patched/newer manager say so.
   */
  private async requireRoute<T>(feature: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ManagerError && err.status === 404) {
        throw new ManagerError(
          `"${feature}" isn't available on the id-agents manager at ${this.cfg.managerUrl}. ` +
          `The endpoint returned 404 — this control-center feature needs a manager that ` +
          `includes it (a stock/older id-agents won't). Update the manager you're pointed at.`,
          404,
        );
      }
      throw err;
    }
  }

  // ---- Health / liveness ------------------------------------------------

  async health(signal?: AbortSignal): Promise<{ status: string; team?: string; agents?: number }> {
    return this.get('/health', signal);
  }

  // ---- Teams & agents ---------------------------------------------------

  async teams(signal?: AbortSignal): Promise<Team[]> {
    const data = await this.get<{ teams?: unknown[] }>('/teams', signal);
    return (data.teams ?? [])
      .map(normalizeTeamRecord)
      .filter((t): t is Team => !!t && t.name.toLowerCase() !== 'all');
  }

  async agents(signal?: AbortSignal): Promise<Agent[]> {
    const q = this.cfg.team ? `?team=${encodeURIComponent(this.cfg.team)}` : '';
    const data = await this.get<{ agents?: unknown[] }>(`/agents${q}`, signal);
    return (data.agents ?? []).map(normalizeAgentRecord).filter((a): a is Agent => !!a);
  }

  // ---- Live event stream ------------------------------------------------

  /** Long-poll the team event stream from a cursor. `wait` holds the socket. */
  async events(since: number, opts: { topics?: string; limit?: number; wait?: number; tail?: boolean } = {}, signal?: AbortSignal): Promise<EventsResponse> {
    const p = new URLSearchParams({ since: String(since), limit: String(opts.limit ?? 100) });
    if (opts.topics) p.set('topics', opts.topics);
    if (opts.wait) p.set('wait', String(opts.wait));
    if (opts.tail) p.set('tail', '1');
    const timeoutMs = opts.wait ? Math.max(DEFAULT_MANAGER_TIMEOUT_MS, (opts.wait * 1000) + LONG_POLL_GRACE_MS) : DEFAULT_MANAGER_TIMEOUT_MS;
    const resp = await this.get<EventsResponse & { events?: unknown[] }>(`/events?${p.toString()}`, signal, timeoutMs);
    return {
      ...resp,
      events: (resp.events ?? []).map(normalizeManagerEvent).filter((e): e is ManagerEvent => !!e),
      next_seq: numberField(resp.next_seq) ?? since,
    };
  }

  // ---- Remote command surface ------------------------------------------

  /** Read an agent's persistent system-prompt addendum ("instructions"). Empty
   *  on managers without the endpoint. */
  async agentInstructions(idOrName: string, signal?: AbortSignal): Promise<string> {
    try {
      const r = await this.get<{ instructions?: string }>(`/agents/${encodeURIComponent(idOrName)}/instructions`, signal);
      return r.instructions ?? '';
    } catch {
      return '';
    }
  }
  /** Set an agent's persistent instructions (system-prompt addendum). Takes effect
   *  on the agent's next rebuild. Returns whether a rebuild is needed. */
  async setAgentInstructions(idOrName: string, instructions: string, signal?: AbortSignal): Promise<{ ok: boolean; needsRebuild?: boolean }> {
    const r = await this.requireRoute('Set agent instructions', () =>
      this.post<{ agent?: string; needsRebuild?: boolean }>(`/agents/${encodeURIComponent(idOrName)}/instructions`, { instructions }, signal));
    return { ok: !!r.agent, needsRebuild: r.needsRebuild };
  }

  /** Live agent activity steps (tool/file), since a seq cursor. `team` scopes the
   *  filter so same-named agents in other teams don't bleed in. `queryId` narrows
   *  to a single dispatch (older managers ignore it → they fall back to agent+team,
   *  which is the pre-queryId behavior). Returns empty on managers that don't have
   *  the /activity endpoint (graceful degradation). */
  async activity(agent: string, since = 0, team?: string, queryId?: string, signal?: AbortSignal): Promise<ActivityResponse> {
    try {
      const p = new URLSearchParams({ agent: String(agent), since: String(since) });
      if (team) p.set('team', String(team));
      if (queryId) p.set('queryId', String(queryId));
      return await this.get<ActivityResponse>(`/activity?${p.toString()}`, signal);
    } catch {
      return { items: [], next_seq: since };
    }
  }

  /** Raw POST /remote. Returns the envelope; caller inspects `result`.
   *  `sessionId` (optional) is forwarded to the agent as the conversation id so a
   *  multi-turn chat resumes only its own context (no cross-chat creep). */
  async remote<T = unknown>(command: string, agent?: string, signal?: AbortSignal, sessionId?: string): Promise<RemoteEnvelope<T>> {
    const body: Record<string, unknown> = { command };
    if (agent) body.agent = agent;
    if (sessionId) body.session_id = sessionId;
    const env = await this.post<RemoteEnvelope<T>>('/remote', body, signal);
    if (!env.ok) throw new ManagerError(env.error ?? 'manager rejected command');
    return env;
  }

  /** GET /query/:id with optional long-poll. */
  async query(queryId: string, wait?: number, signal?: AbortSignal): Promise<QueryResult> {
    const boundedWait = wait != null ? Math.max(0, Math.min(30, wait)) : undefined;
    const w = boundedWait != null ? `?wait=${boundedWait}` : '';
    const timeoutMs = boundedWait ? Math.max(DEFAULT_MANAGER_TIMEOUT_MS, (boundedWait * 1000) + LONG_POLL_GRACE_MS) : DEFAULT_MANAGER_TIMEOUT_MS;
    return this.get<QueryResult>(`/query/${encodeURIComponent(queryId)}${w}`, signal, timeoutMs);
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
    try {
      const data = await this.get<{ tasks?: unknown[] }>('/tasks', signal);
      return (data.tasks ?? []).map(normalizeTaskRecord).filter((t): t is Task => !!t);
    } catch (err) {
      if (!(err instanceof ManagerError) || err.status !== 404) throw err;
      const env = await this.remote<{ tasks?: unknown[] }>('/task', undefined, signal);
      return (env.result?.tasks ?? []).map(normalizeTaskRecord).filter((t): t is Task => !!t);
    }
  }

  async tasksByStatus(
    status: TaskStatusFilter,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Task[]> {
    const params = new URLSearchParams({ status });
    if (opts.limit && Number.isFinite(opts.limit)) {
      params.set('limit', String(Math.max(1, Math.floor(opts.limit))));
    }
    const path = `/tasks?${params.toString()}`;
    try {
      const data = await this.get<{ tasks?: unknown[] }>(path, opts.signal);
      const rows = (data.tasks ?? []).map(normalizeTaskRecord).filter((t): t is Task => !!t);
      const filtered = rows.filter((task) => taskStatusCol(task.status) === status);
      return opts.limit ? filtered.slice(0, opts.limit) : filtered;
    } catch (err) {
      if (!(err instanceof ManagerError) || err.status !== 404) throw err;
      const rows = await this.tasks(opts.signal);
      const filtered = rows.filter((task) => taskStatusCol(task.status) === status);
      return opts.limit ? filtered.slice(0, opts.limit) : filtered;
    }
  }

  /** Control Center capability discovery — which CC-only routes this manager supports.
   *  Returns null on a stock/older manager (no /capabilities), so the GUI can degrade. */
  async capabilities(signal?: AbortSignal): Promise<{ cc_api_version?: number; features?: string[]; routes?: { method: string; path: string; group: string }[] } | null> {
    try {
      return await this.get('/capabilities', signal);
    } catch {
      return null;
    }
  }

  /** Pending/processing query depth for one agent. Null on older managers. */
  async activeAgentQueries(agentIdOrName: string, signal?: AbortSignal): Promise<ActiveAgentQueries | null> {
    try {
      const ref = encodeURIComponent(String(agentIdOrName));
      const d = await this.get<ActiveAgentQueries>(`/agents/${ref}/queries/active`, signal);
      return { ...d, count: Number(d.count) || 0, queries: Array.isArray(d.queries) ? d.queries : [] };
    } catch {
      return null;
    }
  }

  /** Per-task token spend, keyed by task shortId ("#abc12345"). Empty on older managers. */
  async usageByTask(signal?: AbortSignal): Promise<Record<string, TaskUsage>> {
    try {
      const d = await this.get<{ tasks?: Record<string, TaskUsage> }>('/usage/by-task', signal);
      return d.tasks ?? {};
    } catch {
      return {};
    }
  }

  // ---- Manager inbox (questions awaiting a human) -----------------------

  async inboxPending(signal?: AbortSignal): Promise<InboxItem[]> {
    const data = await this.get<{ pending?: unknown[] }>('/manager/inbox/pending', signal);
    return (data.pending ?? []).map(normalizeInboxRecord).filter((item): item is InboxItem => !!item);
  }

  async inboxRespond(queryId: string, message: string, sessionId?: string, signal?: AbortSignal): Promise<void> {
    await this.post('/manager/inbox/respond', { query_id: queryId, message, session_id: sessionId }, signal);
  }

  // ---- Manager token-usage telemetry ------------------------------------

  /**
   * Aggregated manager-reported token usage for the Health page: 24h/7d
   * windows + a last-turn throughput reading. Returns null on managers that
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

  /** Active runtime credential-lane cooldowns from newer managers. Empty on older managers. */
  async runtimeCooldowns(signal?: AbortSignal): Promise<RuntimeCooldown[]> {
    try {
      const d = await this.get<{ cooldowns?: RuntimeCooldown[] }>('/runtime/cooldowns', signal);
      return d.cooldowns ?? [];
    } catch (err) {
      if (err instanceof ManagerError) return [];
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
   * Set an agent's reasoning EFFORT (minimal|low|medium|high|xhigh, '' = default) via
   * its metadata. Lower effort = fewer reasoning tokens for codex / claude-code-cli
   * runtimes (n/a for ollama). Needs a rebuild to apply.
   */
  async setAgentEffort(agentId: string, effort: string, signal?: AbortSignal): Promise<{ metadata?: Record<string, unknown> }> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/metadata`, { metadata: { effort } }, signal);
  }

  /**
   * Set an agent's output speed (default|fast, '' = default) via metadata. Only
   * Claude Code runtimes currently expose this knob. Needs a rebuild to apply.
   */
  async setAgentSpeed(agentId: string, speed: string, signal?: AbortSignal): Promise<{ metadata?: Record<string, unknown> }> {
    return this.post(`/agents/${encodeURIComponent(agentId)}/metadata`, { metadata: { speed } }, signal);
  }

  /**
   * Switch an agent's runtime (harness) by id. Writes the DB and flips status
   * to `pending`; the agent must be rebuilt to apply. Rejects (400) for
   * non-local agents or unknown runtimes.
   */
  async setAgentRuntime(agentId: string, runtime: string, signal?: AbortSignal): Promise<{ runtime?: string; needsRebuild?: boolean; message?: string }> {
    return this.requireRoute('Switch agent runtime', () =>
      this.post(`/agents/${encodeURIComponent(agentId)}/runtime`, { runtime }, signal));
  }

  /**
   * Switch an agent to a Settings-backed provider API lane. The manager stores
   * only safe lane metadata and keeps the supplied API key process-local for the
   * immediate rebuild.
   */
  async setAgentProviderRuntime(
    agentId: string,
    runtime: string,
    provider: { name: string; kind?: string; baseUrl: string; apiKey?: string; keyEnv?: string },
    signal?: AbortSignal,
  ): Promise<{ runtime?: string; executionRuntime?: string; needsRebuild?: boolean; message?: string }> {
    return this.requireRoute('Switch agent provider runtime', () =>
      this.post(`/agents/${encodeURIComponent(agentId)}/runtime`, { runtime, provider }, signal));
  }

  /**
   * Reassign a local agent to a different team. Ports are global so no re-port is
   * needed; the manager updates the agent's team_id, rebuilds running agents under
   * the new team, and leaves stopped agents stopped with a warning. Rejects on name
   * collision in the target team (409) or same team (400).
   */
  async moveAgent(agentId: string, team: string, opts: { createTarget?: boolean; signal?: AbortSignal } = {}): Promise<{ ok: boolean; agent?: string; team?: string; rebuilt?: boolean; warning?: string; message?: string }> {
    return this.requireRoute('Reassign an agent to another team', () =>
      this.post(`/agents/${encodeURIComponent(agentId)}/team`, { team, ...(opts.createTarget ? { createTarget: true } : {}) }, opts.signal));
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
    spec: { name: string; runtime?: string; model?: string; skills?: string[]; heartbeatSeconds?: number; role?: string; description?: string; expertise?: string[]; wallet?: boolean },
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string; runtime?: string; port?: number }> {
    const catalog: Record<string, unknown> = {};
    if (spec.role?.trim()) catalog.role = spec.role.trim();
    if (spec.description?.trim()) catalog.description = spec.description.trim();
    if (spec.expertise?.length) catalog.expertise = spec.expertise;
    // The rich description becomes the agent's persona (manager writes
    // PROTOCOL_DEFAULTS + roleBody into its personality file). Fall back to the
    // short role so an agent still gets a one-line mandate when that's all we have.
    const roleBody = (spec.description?.trim() || spec.role?.trim()) || undefined;
    const body: Record<string, unknown> = {
      name: spec.name,
      start: true,
      ...(spec.runtime && { runtime: spec.runtime }),
      ...(spec.model && { model: spec.model }),
      ...(spec.skills?.length && { skills: spec.skills }),
      ...(spec.heartbeatSeconds && { heartbeat: spec.heartbeatSeconds }),
      ...(roleBody && { roleBody }),
      ...(Object.keys(catalog).length && { metadata: { catalog } }),
    };
    const res = await this.post<{ id: string; name: string; runtime?: string; port?: number }>('/agents/spawn', body, signal);
    if (spec.wallet) {
      // Best-effort: agent is usable without it; surfaced in Identity & Keys.
      await this.remote(`/agent ${spec.name} wallet provision`, undefined, signal).catch(() => {});
    }
    return res;
  }

  /**
   * Bulk-create a team from a parsed spec: spawn each agent into `team` (created on
   * the first spawn — the manager's getTeam → getOrCreateTeamId). Sequential and
   * best-effort — one agent's failure is recorded and the rest still spawn. The
   * caller picks runtime + model (applied to all). Reports progress per agent.
   */
  async importTeam(
    team: string,
    agents: Array<{ name: string; role?: string; description?: string }>,
    opts: { runtime?: string; model?: string; signal?: AbortSignal; onProgress?: (done: number, total: number, name: string) => void } = {},
  ): Promise<{ created: string[]; failed: Array<{ name: string; error: string }> }> {
    const teamClient = this.withTeam(team);
    const created: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      opts.onProgress?.(i, agents.length, a.name);
      try {
        await teamClient.spawnAgent({ name: a.name, runtime: opts.runtime, model: opts.model, role: a.role, description: a.description }, opts.signal);
        created.push(a.name);
      } catch (e) {
        failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { created, failed };
  }

  /**
   * Apply a lifecycle op to EVERY agent in `team`. start/stop/rebuild fan out as
   * `/agent <name> <op>` per agent — best-effort: an agent that errors is recorded
   * and the rest still run. (Use probeTeam() for a team-wide health probe.)
   */
  async teamLifecycle(
    team: string,
    op: 'start' | 'stop' | 'rebuild',
    opts: { signal?: AbortSignal; onProgress?: (done: number, total: number, name: string) => void } = {},
  ): Promise<{ op: string; total: number; done: string[]; failed: Array<{ name: string; error: string }> }> {
    const tc = this.withTeam(team);
    const agents = await tc.agents(opts.signal);
    const done: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      opts.onProgress?.(i, agents.length, a.name);
      try { await tc.remote(`/agent ${a.name} ${op}`, undefined, opts.signal); done.push(a.name); }
      catch (e) { failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) }); }
    }
    return { op, total: agents.length, done, failed };
  }

  /** Health-probe a whole team in one call (`/agents probe`, team-scoped). */
  async probeTeam(team: string, signal?: AbortSignal): Promise<ProbeResult> {
    return this.withTeam(team).probeAll(signal);
  }

  /** Read how many local-model (ollama) queries the manager runs at once + live stats. */
  async localConcurrency(signal?: AbortSignal): Promise<{ concurrency: number; active: number; queued: number }> {
    return this.requireRoute('Local-model concurrency', () => this.get('/manager/local-concurrency', signal));
  }
  /** Set the local-model concurrency (1–16). Applies live; not persisted across manager restarts. */
  async setLocalConcurrency(n: number, signal?: AbortSignal): Promise<{ concurrency: number }> {
    return this.requireRoute('Local-model concurrency', () => this.post('/manager/local-concurrency', { concurrency: n }, signal));
  }

  /**
   * Resolve an agent to handle a meta-task (AI team design / spec parse). These are
   * one-shot LLM calls that don't need to belong to the target team — any running
   * agent works. Prefer a lead/coordinator-named one; fall back to any running agent
   * in the current team. Returns undefined when there's none to ask.
   */
  private async resolveHelperAgent(preferred?: string): Promise<string | undefined> {
    if (preferred && preferred.includes('/')) return preferred;
    const agents = await this.agents().catch(() => []);
    // Liveness check mirrors the Health view's isUp() (status OR health).
    const running = agents.filter((a) => /running|online|ready|healthy/i.test(`${a.status ?? ''} ${a.health ?? ''}`) || !a.status);
    const pool = running.length ? running : agents;
    if (preferred) { const p = pool.find((a) => a.name === preferred); if (p) return p.name; }
    // A lead/coordinator-shaped name (also matches team-lead, eng-manager, …).
    const lead = pool.find((a) => /(^|[-_])(lead|coordinator|manager|orchestrator)([-_]|$)/i.test(a.name));
    return (lead ?? pool[0])?.name;
  }

  /**
   * AI-assist: ask an agent (the team's coordinator when set, else any running
   * agent) to draft text from a short instruction — used to draft agent/team goals
   * and instructions. Dispatches via /ask and returns the reply. Throws when no
   * agent is available to help.
   */
  async draftWithAI(instruction: string, opts: { agent?: string; onTick?: (s: string) => void; signal?: AbortSignal } = {}): Promise<string> {
    const agent = await this.resolveHelperAgent(opts.agent);
    if (!agent) throw new ManagerError('No running agent is available to help draft this. Onboard an agent first.');
    return this.dispatch(`/ask ${agent} ${qArg(instruction)}`, { onTick: opts.onTick, signal: opts.signal });
  }

  /**
   * AI-assisted parse: dispatch the raw spec to a team agent and ask for a strict
   * JSON {team, agents:[…]} plan — for messy free-form input the deterministic parser
   * can't handle. Dispatches via /ask (an AGENT), NOT /talk (which parks the prompt
   * in the human manager inbox). Names are re-slugged client-side; throws on failure
   * so the caller can fall back to the parser.
   */
  async parseTeamSpecAI(spec: string, opts: { onTick?: (status: string) => void; signal?: AbortSignal; agent?: string } = {}): Promise<ParsedTeamSpec> {
    const prompt =
      'Convert this team description into JSON ONLY — no prose, no markdown fences: ' +
      '{"team": "<slug or null>", "agents": [{"name": "<lowercase-hyphen-slug>", "role": "<one short line>", "description": "<full role and responsibilities, 1-4 sentences>"}]}. ' +
      'The role is a one-line summary; the description is the agent’s complete mandate. ' +
      'Extract every agent the spec proposes; invent nothing.\n\nSPEC:\n' + spec;
    const agent = await this.resolveHelperAgent(opts.agent);
    if (!agent) throw new ManagerError('No running agent is available to parse the spec. Onboard an agent first, or use the deterministic parse and edit the rows by hand.');
    // /ask dispatches to an AGENT and polls for its reply (NOT /talk, which parks
    // the prompt in the human manager inbox awaiting a person).
    const reply = await this.dispatch(`/ask ${agent} ${qArg(prompt)}`, { onTick: opts.onTick, signal: opts.signal });
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) throw new ManagerError('AI parse: no JSON object in the reply');
    let obj: { team?: unknown; agents?: unknown };
    try { obj = JSON.parse(reply.slice(start, end + 1)); }
    catch { throw new ManagerError('AI parse: reply was not valid JSON'); }
    const seen = new Set<string>();
    const agents: Array<{ name: string; role: string; description: string }> = [];
    if (Array.isArray(obj.agents)) {
      for (const a of obj.agents) {
        const o = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
        const name = slugName(String(o.name ?? ''));
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const role = String(o.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const description = String(o.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000) || role;
        agents.push({ name, role, description });
      }
    }
    const team = typeof obj.team === 'string' && obj.team.trim() ? slugName(obj.team) : null;
    return { team, agents };
  }

  /**
   * AI-assisted FULL team design — turns a plain-English goal (or a pasted spec)
   * into a complete roster with a suggested runtime, model, skills, and a single
   * coordinator per agent. Like {@link parseTeamSpecAI} it dispatches to the lead,
   * but the prompt is grounded by the caller's available runtimes/models/skills so
   * the model only picks valid choices; anything off-list is dropped client-side.
   */
  async designTeamAI(
    spec: string,
    opts: {
      runtimes?: string[];
      models?: Record<string, string[]>;
      skills?: string[];
      onTick?: (status: string) => void;
      signal?: AbortSignal;
      agent?: string;
      fleetRoster?: string;
    } = {},
  ): Promise<DesignedTeam> {
    const runtimes = (opts.runtimes ?? []).filter(Boolean);
    const skills = (opts.skills ?? []).filter(Boolean);
    const modelLines = runtimes
      .map((r) => `  - ${r}: ${(opts.models?.[r] ?? []).slice(0, 12).join(', ') || '(default only)'}`)
      .join('\n');
    const prompt =
      'You are designing a team of AI agents. Convert the description below into JSON ONLY — ' +
      'no prose, no markdown fences: ' +
      '{"team":"<slug or null>","agents":[{"name":"<lowercase-hyphen-slug>","role":"<one short line>",' +
      '"description":"<full mandate, 1-4 sentences>","runtime":"<one runtime id or empty>",' +
      '"model":"<a model for that runtime or empty>","skills":["<zero or more skill names>"],' +
      '"lead":<true for exactly ONE coordinator agent, false otherwise>}],"suggestions":{"agents":["<optional fleet-level agent idea>"],"skills":["<optional reusable skill idea>"]}}. ' +
      'Propose every agent the team needs and nothing more. ' +
      'You are authorized to make advisory suggestions for additional agents and reusable skills the collective should consider, but suggestions are not approvals to create or install them. ' +
      'Pick runtime ONLY from: ' + (runtimes.join(', ') || '(none available)') + '. ' +
      'Models available per runtime (pick one for the chosen runtime, or leave empty for the default):\n' +
      (modelLines || '  (none)') + '\n' +
      'Choose skills ONLY from this library (or none): ' + (skills.join(', ') || '(none)') + '. ' +
      'Mark exactly one agent as the lead (the coordinator). ' +
      (opts.fleetRoster
        ? 'Use this current fleet roster as context, including inactive teams and stopped agents. ' +
          'Do not duplicate an existing agent unless the user explicitly asks for another copy; prefer adding missing complementary agents to the requested team.\n\n' +
          'CURRENT FLEET ROSTER:\n' + opts.fleetRoster + '\n\n'
        : '') +
      'DESCRIPTION:\n' + spec;
    const agent = await this.resolveHelperAgent(opts.agent);
    if (!agent) throw new ManagerError('No running agent is available to design the team. Onboard at least one agent first, or fill the team in by hand.');
    // /ask dispatches to an AGENT and polls for its reply (NOT /talk, which parks
    // the prompt in the human manager inbox awaiting a person).
    const reply = await this.dispatch(`/ask ${agent} ${qArg(prompt)}`, { onTick: opts.onTick, signal: opts.signal });
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) throw new ManagerError('AI design: no JSON object in the reply');
    let obj: { team?: unknown; agents?: unknown; suggestions?: unknown };
    try { obj = JSON.parse(reply.slice(start, end + 1)); }
    catch { throw new ManagerError('AI design: reply was not valid JSON'); }
    return sanitizeDesignedTeam(obj, { runtimes, models: opts.models, skills });
  }

  /**
   * Auto-categorize library skills that lack frontmatter tags. Dispatches ONE
   * `/ask` to a running agent to tag the whole batch from {@link SKILL_CATEGORIES},
   * and uses the offline {@link heuristicSkillTags} as a per-skill baseline / full
   * fallback (no agent, or AI failure/garbage). Always returns a name→tags entry
   * for every input skill.
   */
  async categorizeSkillsAI(
    skills: Array<{ name: string; description?: string | null }>,
    opts: { agent?: string; onTick?: (status: string) => void; signal?: AbortSignal } = {},
  ): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const s of skills) out[s.name] = heuristicSkillTags(s.name, s.description); // baseline
    if (!skills.length) return out;
    const agent = await this.resolveHelperAgent(opts.agent);
    if (!agent) return out; // no running agent → heuristic only
    const list = skills
      .map((s) => `- ${s.name}: ${(s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
      .join('\n');
    const prompt =
      'Categorize each skill below with 1–3 short tags chosen from this controlled ' +
      'vocabulary (you MAY add at most one extra specific tag if clearly warranted): ' +
      SKILL_CATEGORIES.join(', ') + '. ' +
      'Return JSON ONLY — no prose, no markdown fences: a map of skill name → array of ' +
      'lowercase tag strings, e.g. {"pdf-tools":["data","documentation"]}. Cover every skill.\n\nSKILLS:\n' + list;
    try {
      const reply = await this.dispatch(`/ask ${agent} ${qArg(prompt)}`, { onTick: opts.onTick, signal: opts.signal });
      const start = reply.indexOf('{');
      const end = reply.lastIndexOf('}');
      if (start < 0 || end <= start) return out; // no JSON → keep heuristic baseline
      const ai = sanitizeSkillTags(JSON.parse(reply.slice(start, end + 1)), skills.map((s) => s.name));
      for (const [name, tags] of Object.entries(ai)) if (tags.length) out[name] = tags; // AI overrides baseline
      return out;
    } catch {
      return out; // AI dispatch/parse failed → heuristic baseline
    }
  }

  // ---- Team relay (cross-team delegation allow-list) --------------------

  /** Read a team's relay policy. `delegates_to`: team names ("*"=all) or null=permissive. */
  async teamConfig(name: string, signal?: AbortSignal): Promise<{ name: string; delegates_to: string[] | null }> {
    const cfg = await this.requireRoute('Read team relay policy', () =>
      this.get<{ name?: unknown; delegates_to?: unknown }>(`/teams/${encodeURIComponent(name)}/config`, signal));
    return { name: textField(cfg.name) ?? name, delegates_to: delegatesField(cfg.delegates_to) };
  }

  /** Set a team's relay allow-list. Pass string[] (or ["*"]), or null for permissive. */
  async setTeamDelegates(name: string, delegates: string[] | null, signal?: AbortSignal): Promise<{ name: string; delegates_to: string[] | null }> {
    const cfg = await this.requireRoute('Set team relay allow-list', () =>
      this.post<{ name?: unknown; delegates_to?: unknown }>(`/teams/${encodeURIComponent(name)}/delegates`, { delegates }, signal));
    return { name: textField(cfg.name) ?? name, delegates_to: delegatesField(cfg.delegates_to) };
  }

  /** Delete an EMPTY team. The manager refuses the `default` team and any team that
   *  still has agents (400 with a count); remove its agents first. */
  async deleteTeam(name: string, signal?: AbortSignal): Promise<{ success: boolean; name: string; message: string }> {
    return this.requireRoute('Delete a team', () =>
      this.del(`/teams/${encodeURIComponent(name)}`, signal));
  }

  /**
   * Per-agent relay override. Overrides the team policy for this one agent;
   * null removes the override (inherit team). string[] (or ["*"]) restricts.
   */
  async setAgentDelegates(agentId: string, delegates: string[] | null, signal?: AbortSignal): Promise<{ agent: string; delegates_to: string[] | null }> {
    const cfg = await this.requireRoute('Set agent relay override', () =>
      this.post<{ agent?: unknown; delegates_to?: unknown }>(`/agents/${encodeURIComponent(agentId)}/delegates`, { delegates }, signal));
    return { agent: textField(cfg.agent) ?? agentId, delegates_to: delegatesField(cfg.delegates_to) };
  }

  // ---- Scheduling / checkins -------------------------------------------

  async checkins(signal?: AbortSignal): Promise<CheckIn[]> {
    const d = await this.get<{ checkins?: CheckIn[] }>('/checkins', signal);
    return d.checkins ?? [];
  }

  /** Manually close a supervision check-in (stops it firing). */
  async closeCheckin(id: string, reason = 'closed from control center', signal?: AbortSignal): Promise<{ ok: boolean }> {
    try {
      await this.post(`/checkins/${encodeURIComponent(id)}/close`, { reason }, signal);
      return { ok: true };
    } catch {
      return { ok: false };
    }
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

  /** Detail for a single library plugin. Used for read-only adapter inspection. */
  async libraryPluginDetail(name: string, signal?: AbortSignal): Promise<LibraryPluginDetail | null> {
    try {
      return await this.get<LibraryPluginDetail>(`/library/plugins/${encodeURIComponent(name)}`, signal);
    } catch (err) {
      if (err instanceof ManagerError && err.status === 404) return null;
      throw err;
    }
  }

  /** Install a library skill onto an agent (persists to metadata + live deploy). */
  async installSkill(skill: string, agent: string, signal?: AbortSignal): Promise<InstallSkillResult> {
    return this.requireRoute('Install a library skill', () =>
      this.post('/library/skills/install', { skill, agent }, signal));
  }

  /**
   * Create a new library skill (agentskills.io SKILL.md folder). Admin-gated on
   * the manager. Returns the created catalog entry; throws ManagerError on a
   * validation failure or name conflict (409 already_exists).
   */
  async createSkill(input: CreateSkillInput, signal?: AbortSignal): Promise<LibrarySkillEntry> {
    return this.requireRoute('Create a library skill', () =>
      this.post('/library/skills/create', input, signal));
  }

  /** Delete a library skill folder. Admin-gated; throws ManagerError on failure. */
  async deleteSkill(name: string, signal?: AbortSignal): Promise<{ removed: string }> {
    return this.requireRoute('Delete a library skill', () =>
      this.del(`/library/skills/${encodeURIComponent(name)}`, signal));
  }

  /** Uninstall a skill from an agent (inverse of installSkill). */
  async uninstallSkill(skill: string, agent: string, signal?: AbortSignal): Promise<{ uninstalled: string; agent: string; skills: string[] }> {
    return this.requireRoute('Uninstall a skill', () =>
      this.post('/library/skills/uninstall', { skill, agent }, signal));
  }

  /** Attach external MCP servers to an agent. Takes effect on next rebuild. */
  async setAgentMcp(agentId: string, servers: McpServerSpec[], signal?: AbortSignal): Promise<SetMcpResult> {
    return this.requireRoute('Attach MCP servers', () =>
      this.post(`/agents/${encodeURIComponent(agentId)}/mcp`, { servers }, signal));
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
  status?: string;                 // active | snoozed | closed | expired
  intervalSeconds?: number | null;
  iterationCount?: number;
  maxIterations?: number | null;
  nextFireAt?: number | null;      // ms epoch
  nextDueAt?: number;              // ms epoch — when this check-in is next due (alias of nextFireAt on some managers)
  lastFireAt?: number | null;      // ms epoch
  owner?: string | null;           // the dispatcher (who delegated), resolved name
  closedReason?: string | null;
  /** The task this check-in supervises, resolved server-side (newer managers). */
  linkedTask?: { name?: string; title?: string; status?: string; owner?: string | null; gone?: boolean } | null;
  [key: string]: unknown;
}

export interface RuntimeCooldown {
  laneId: string;
  runtime: string;
  kind?: 'subscription' | 'metered-api' | string;
  coolingUntilMs: number;
  observedAtMs?: number;
  reason?: string;
  teamId?: string;
  agentId?: string;
  agentName?: string;
  queryId?: string;
  resetText?: string;
  message?: string;
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

export interface LibraryPluginDetail extends LibraryPluginEntry {
  /** Full plugin.json contents from the manager, when the detail route exists. */
  manifest?: Record<string, unknown> | null;
  /** Root SKILL.md body from the plugin, when present. */
  skillBody?: string | null;
}

export type LibraryPluginAdapterKind = 'skill' | 'mcp' | 'native-plugin' | 'direct-fallback';
export type LibraryPluginClassification =
  | 'portable-package'
  | 'instruction-skill'
  | 'hybrid-tool-plugin'
  | 'native-tool-plugin'
  | 'manifest-only'
  | 'unknown';
export type LibraryPluginSkillProjection = 'available' | 'already-in-catalog' | 'blocked-tools' | 'not-available';

/** Sanitized plugin inspection for neutral Capabilities UI. No raw SKILL body is exposed. */
export interface LibraryPluginInspection extends LibraryPluginEntry {
  hasSkillMd: boolean;
  hasTools: boolean;
  toolCount: number;
  tools: string[];
  entrypoint?: string | null;
  adapterKinds: LibraryPluginAdapterKind[];
  classification: LibraryPluginClassification;
  skillProjection: LibraryPluginSkillProjection;
  notes: string[];
}

export interface ProjectPluginSkillResult {
  ok: boolean;
  plugin: string;
  projected: boolean;
  entry?: LibrarySkillEntry;
  inspection?: LibraryPluginInspection;
}

function manifestObject(manifest: unknown): Record<string, unknown> {
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
}

function manifestString(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pushUnique(out: string[], value: unknown): void {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text && !out.includes(text)) out.push(text.slice(0, 120));
}

function manifestScriptNames(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const scripts = manifest.scripts;
  if (Array.isArray(scripts)) {
    for (const item of scripts) {
      if (typeof item === 'string') pushUnique(out, item);
      else if (item && typeof item === 'object') {
        const script = item as Record<string, unknown>;
        pushUnique(out, script.name ?? script.command ?? script.path);
      }
    }
  } else if (scripts && typeof scripts === 'object') {
    for (const key of Object.keys(scripts)) pushUnique(out, key);
  }
  const tools = manifest.tools;
  if (Array.isArray(tools)) {
    for (const item of tools) {
      if (typeof item === 'string') pushUnique(out, item);
      else if (item && typeof item === 'object') pushUnique(out, (item as Record<string, unknown>).name);
    }
  } else if (tools && typeof tools === 'object') {
    for (const key of Object.keys(tools)) pushUnique(out, key);
  }
  return out;
}

function skillBodyToolNames(pluginName: string, skillBody?: string | null): string[] {
  if (!skillBody) return [];
  const out: string[] = [];
  const quoted = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`plugins/${quoted}/tools/([A-Za-z0-9._-]+)`, 'g');
  for (const match of skillBody.matchAll(re)) pushUnique(out, match[1]);
  return out;
}

function manifestPortableAdapters(manifest: Record<string, unknown>): LibraryPluginAdapterKind[] {
  const out: LibraryPluginAdapterKind[] = [];
  const portable = manifestObject(manifest.idaccPortablePlugin);
  const adapters = manifestObject(portable.adapters);
  if (adapters.skill) out.push('skill');
  if (adapters.mcp) out.push('mcp');
  if (adapters.nativePlugin || adapters.native || adapters.plugin) out.push('native-plugin');
  if (adapters.directFallback || adapters.fallback) out.push('direct-fallback');
  return out;
}

export function inspectLibraryPluginMetadata(
  entry: LibraryPluginEntry,
  detail: LibraryPluginDetail | null,
  skillNames: Iterable<string> = [],
  extraToolNames: string[] = [],
): LibraryPluginInspection {
  const manifest = manifestObject(detail?.manifest);
  const entrypoint = manifestString(manifest, 'entrypoint');
  const hasSkillMd = Boolean(detail?.skillBody) || /^SKILL\.md$/i.test(entrypoint ?? '');
  const toolNames = [...new Set([
    ...manifestScriptNames(manifest),
    ...skillBodyToolNames(entry.name, detail?.skillBody),
    ...extraToolNames,
  ].map((tool) => String(tool).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const portableAdapters = manifestPortableAdapters(manifest);
  const hasTools = toolNames.length > 0;
  const hasDeclaredPortableFallback = portableAdapters.includes('direct-fallback');
  const adapterKinds = [...portableAdapters];
  if (!adapterKinds.includes('skill') && hasSkillMd) adapterKinds.push('skill');
  if (!adapterKinds.includes('native-plugin') && hasTools) adapterKinds.push('native-plugin');
  const classification: LibraryPluginClassification = hasDeclaredPortableFallback && adapterKinds.includes('skill')
    ? 'portable-package'
    : hasSkillMd && hasTools
      ? 'hybrid-tool-plugin'
      : hasSkillMd
        ? 'instruction-skill'
        : hasTools
          ? 'native-tool-plugin'
          : entry.hasManifest || detail?.hasManifest
            ? 'manifest-only'
            : 'unknown';
  const catalogHasSkill = new Set([...skillNames].map((name) => String(name).trim())).has(entry.name);
  const skillProjection: LibraryPluginSkillProjection = !hasSkillMd || !detail?.skillBody
    ? 'not-available'
    : catalogHasSkill
      ? 'already-in-catalog'
      : hasTools
        ? 'blocked-tools'
        : 'available';
  const notes: string[] = [];
  if (!detail) notes.push('Plugin detail route unavailable; showing list metadata only.');
  if (classification === 'portable-package') notes.push('Declares portable adapters, including direct fallback.');
  if (classification === 'instruction-skill') notes.push('Root SKILL.md has no detected tools; it can be digested into the skill catalog.');
  if (classification === 'hybrid-tool-plugin') notes.push('Root SKILL.md references tools; keep tool execution behind a plugin, MCP, or fallback adapter.');
  if (classification === 'native-tool-plugin') notes.push('Tool-bearing package; do not assume cross-runtime support without adapter metadata.');
  if (skillProjection === 'already-in-catalog') notes.push('A same-named skill already exists in the library catalog.');
  if (skillProjection === 'blocked-tools') notes.push('Skill projection is blocked because tool calls would be lost.');
  const detailEntry = detail ? { ...detail } : {};
  delete (detailEntry as Partial<LibraryPluginDetail>).manifest;
  delete (detailEntry as Partial<LibraryPluginDetail>).skillBody;
  return {
    ...entry,
    ...detailEntry,
    hasSkillMd,
    hasTools,
    toolCount: toolNames.length,
    tools: toolNames,
    entrypoint,
    adapterKinds,
    classification,
    skillProjection,
    notes,
  };
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
  input?: number;
  output: number;
  /** input + output (preferred for "total tokens"); falls back to output on old managers. */
  total?: number;
  avgTps: number;
}

/** Per-task token spend (tokens = input + output across the task's turns). */
export interface TaskUsage {
  tokens: number;
  input: number;
  output: number;
  /** Total generation time across the task's turns, ms. */
  ms: number;
  turns: number;
}

/** Per-local-model usage (any OpenAI-compatible local server: Ollama / LM Studio / …). */
export interface UsageModel {
  model: string;
  count: number;
  input?: number;
  output: number;
  total?: number;
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
  /** Per-model breakdown (added by newer managers; may be absent on older ones). */
  models?: UsageModel[];
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
