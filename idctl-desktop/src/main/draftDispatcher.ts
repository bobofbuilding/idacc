/**
 * Promote task-shaped manager news replies into real manager tasks.
 *
 * The dashboard shows JSON-array work proposals as DRAFT activity rows. This
 * bridge turns recent, valid proposal batches into manager-owned tasks, routes
 * each item to the team that owns its target agent, and dispatches via /ask.
 */

import { createHash } from 'node:crypto';
import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, NewsItem, Task } from '../../../idctl/src/api/types.ts';
import { loadSettings, saveSettings, setTaskDeps } from '../../../idctl/src/settings/store.ts';
import type { DraftDispatcherProcessedRecord } from '../../../idctl/src/settings/schema.ts';
import { optimizeAskCommand } from './contextBudget.ts';
import { isActiveStatus, type CreatePlanResult, type CreatedTask, type SubTask } from './work.ts';

type DraftNewsItem = NewsItem & { teamName?: string };
type TeamRoster = { team: string; agents: Agent[]; active: Agent[]; lead: Agent | null };
type RoutedSubTask = SubTask & { team: string; sourceAgent: string };
type RoutedCreatedTask = CreatedTask & { team: string };

export interface ParsedDraftProposal {
  key: string;
  team: string;
  sourceNewsId?: string;
  sourceLabel: string;
  objective: string;
  at: number;
  subtasks: SubTask[];
}

export interface DraftDispatchRunResult {
  enabled: boolean;
  scanned: number;
  candidates: number;
  dispatched: number;
  createdTasks: number;
  skippedProcessed: number;
  failed: number;
  details: Array<{ key: string; team: string; status: 'dispatched' | 'failed' | 'skipped'; detail?: string; taskRefs?: string[] }>;
}

const MAX_SUBTASKS = 12;
const NEWS_LIMIT_PER_TEAM = 80;
const MAX_DRAFTS_PER_RUN = 4;
const RECENT_DRAFT_MS = 2 * 60 * 60 * 1000;
const PROCESSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PROCESSED_CAP = 1000;
const POLL_MS = 30_000;
const INITIAL_DELAY_MS = 12_000;

const inFlightDrafts = new Set<string>();

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}...` : t;
}
function stringField(v: unknown, max = 240): string {
  return typeof v === 'string' ? clip(v, max) : '';
}
function toMs(ts?: number | null): number {
  if (!ts) return 0;
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}
function sourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function firstJsonArrayText(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  for (let start = body.indexOf('['); start >= 0; start = body.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return body.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractJsonArray(text: string): unknown[] | null {
  const raw = firstJsonArrayText(text);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeDeps(value: unknown, max: number, self: number): number[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw.map((d) => Number(d))))
    .filter((d) => Number.isInteger(d) && d >= 0 && d < max && d !== self);
}

function sourceText(news: DraftNewsItem): string {
  const dataMessage = news.data && typeof news.data.message === 'string' ? news.data.message : '';
  return news.message || dataMessage || '';
}

export function parseDraftProposalFromNews(news: DraftNewsItem, team: string, now = Date.now(), maxAgeMs = RECENT_DRAFT_MS): ParsedDraftProposal | null {
  const text = sourceText(news);
  const at = toMs(news.timestamp);
  if (!text || !at || now - at > maxAgeMs) return null;
  if (!/reply|delivered|message/i.test(String(news.type ?? ''))) return null;

  const arr = extractJsonArray(text);
  if (!arr?.length) return null;
  const n = Math.min(arr.length, MAX_SUBTASKS);
  const subtasks: SubTask[] = [];
  for (let i = 0; i < n; i++) {
    const raw = arr[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const title = stringField(o.title ?? o.task ?? o.name, 120);
    const agent = stringField(o.agent ?? o.owner ?? o.assignee, 80);
    if (!title || !agent) return null;
    const description = stringField(o.description ?? o.detail ?? o.details ?? o.output, 320);
    const deps = o.dependsOn ?? o.depends_on ?? o.after;
    subtasks.push({ title, description, agent, dependsOn: normalizeDeps(deps, n, i) });
  }
  if (!subtasks.length) return null;

  const d = news.data ?? {};
  const actor = stringField(d.from ?? d.sender ?? d.agent ?? 'manager', 80) || 'manager';
  const target = stringField(d.to ?? d.target ?? 'remote', 80) || 'remote';
  const firstTitles = subtasks.slice(0, 3).map((s) => s.title).join('; ');
  const objectiveFromData = stringField(d.objective ?? d.prompt ?? d.title, 240);
  const objective = objectiveFromData || clip(`Auto-dispatch draft from ${actor} -> ${target}: ${firstTitles}${subtasks.length > 3 ? ` +${subtasks.length - 3} more` : ''}`, 240);
  const sourceNewsId = news.id !== undefined ? String(news.id) : (news.query_id || news.in_reply_to);
  const keyBase = sourceNewsId ? `id:${sourceNewsId}` : `ts:${news.timestamp ?? 0}:q:${news.query_id ?? news.in_reply_to ?? ''}`;
  const key = `${team}:${keyBase}:${sourceHash(text)}`;
  return {
    key,
    team,
    sourceNewsId,
    sourceLabel: `${team}/${sourceNewsId ? `news:${sourceNewsId}` : `news@${news.timestamp}`}`,
    objective,
    at,
    subtasks,
  };
}

function pickActiveLead(agents: Agent[]): Agent | null {
  const active = agents.filter((a) => isActiveStatus(a.status));
  if (!active.length) return null;
  return (
    active.find((a) => /(^|[-_ ])lead$/i.test(a.name)) ??
    active.find((a) => /lead/i.test(a.name)) ??
    active.find((a) => /manager|coordinator/i.test(a.name)) ??
    active[0]
  );
}

async function loadRosters(client: ManagerClient, teamNames: string[]): Promise<TeamRoster[]> {
  return Promise.all(teamNames.map(async (team) => {
    const agents = await client.withTeam(team).agents().catch(() => [] as Agent[]);
    const active = agents.filter((a) => isActiveStatus(a.status));
    return { team, agents, active, lead: pickActiveLead(agents) };
  }));
}

function routeSubtasks(sourceTeam: string, subtasks: SubTask[], rosters: TeamRoster[]): RoutedSubTask[] {
  const byTeam = new Map(rosters.map((r) => [r.team, r]));
  const matches = new Map<string, Array<{ team: string; agent: Agent; active: boolean }>>();
  for (const r of rosters) {
    for (const agent of r.agents) {
      const list = matches.get(agent.name) ?? [];
      list.push({ team: r.team, agent, active: isActiveStatus(agent.status) });
      matches.set(agent.name, list);
    }
  }
  const sourceRoster = byTeam.get(sourceTeam);
  const firstActiveRoster = sourceRoster?.active.length ? sourceRoster : rosters.find((r) => r.active.length);
  return subtasks.map((st) => {
    const exact = matches.get(st.agent) ?? [];
    const chosen =
      exact.find((m) => m.team === sourceTeam && m.active) ??
      exact.find((m) => m.active) ??
      exact.find((m) => m.team === sourceTeam) ??
      exact[0];
    if (chosen?.active) return { ...st, team: chosen.team, sourceAgent: st.agent, agent: st.agent };
    const chosenRoster = chosen ? byTeam.get(chosen.team) : undefined;
    const fallbackRoster = chosenRoster ?? firstActiveRoster ?? sourceRoster;
    const fallbackAgent = fallbackRoster?.lead ?? fallbackRoster?.active[0] ?? fallbackRoster?.agents[0];
    const team = fallbackRoster?.team ?? chosen?.team ?? sourceTeam;
    const agent = fallbackAgent?.name ?? st.agent;
    return { ...st, team, sourceAgent: st.agent, agent };
  });
}

function taskKeys(t: Task): string[] {
  return [t.shortId, t.name, t.uuid, t.title].filter(Boolean) as string[];
}
function isTaskDone(status?: string): boolean { return /done|complete/i.test(status ?? ''); }
function taskCreateCommand(st: RoutedSubTask, sourceLabel: string): string {
  const sourceNote = `Auto-dispatched from draft ${sourceLabel}.`;
  const desc = clip(`${st.description}${st.description ? '\n\n' : ''}${sourceNote}`, 400);
  return `/task create ${qArg(st.title)} --owner ${st.agent}${desc ? ` --description ${qArg(desc)}` : ''}`;
}
function taskPrompt(objective: string, st: RoutedSubTask, ref: string): string {
  const routedNote = st.sourceAgent !== st.agent ? `Original suggested owner: ${st.sourceAgent}. Routed to active owner: ${st.agent}.\n` : '';
  return `Team objective: ${objective}

Your assigned task (${ref}): ${st.title}
${st.description ? st.description + '\n' : ''}${routedNote}Do this task now. When finished, mark it done with: /task done ${ref}
If you cannot complete it, still mark it done with a brief failure note.`;
}
function budgetedCommand(client: ManagerClient, command: string, source: string): string {
  return optimizeAskCommand(command, { source, team: client.team }).command;
}

async function createAndDispatchRoutedDraft(client: ManagerClient, draft: ParsedDraftProposal, rosters: TeamRoster[]): Promise<CreatePlanResult> {
  const routed = routeSubtasks(draft.team, draft.subtasks, rosters);
  const created: RoutedCreatedTask[] = [];
  for (let i = 0; i < routed.length; i++) {
    const st = routed[i];
    const tc = client.withTeam(st.team);
    try {
      const env = await tc.remote<{ task?: { shortId?: string; name?: string } }>(budgetedCommand(tc, taskCreateCommand(st, draft.sourceLabel), 'draftDispatcher:create-task'));
      const task = env.result?.task;
      const ref = task?.shortId ?? task?.name ?? st.title;
      created.push({ idx: i, ref, title: st.title, agent: st.agent, ok: true, dependsOn: st.dependsOn, dispatched: false, team: st.team });
    } catch (e) {
      created.push({
        idx: i,
        ref: st.title,
        title: st.title,
        agent: st.agent,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        dependsOn: st.dependsOn,
        dispatched: false,
        team: st.team,
      });
    }
  }

  try {
    for (let i = 0; i < created.length; i++) {
      const c = created[i];
      if (!c.ok) continue;
      const refs = (routed[i].dependsOn || [])
        .filter((d) => d >= 0 && d < created.length && created[d]?.ok)
        .map((d) => created[d].ref);
      if (refs.length) setTaskDeps(c.ref, refs);
    }
  } catch { /* overlay is best-effort */ }

  const waiters: { team: string; ref: string; resolve: () => void; deadline: number }[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const tickPoll = async (): Promise<void> => {
    if (!waiters.length) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
      return;
    }
    const teams = [...new Set(waiters.map((w) => w.team))];
    const snaps = await Promise.all(teams.map(async (team) => [team, await client.withTeam(team).tasks().catch(() => [] as Task[])] as const));
    const doneKeys = new Set<string>();
    for (const [team, tasks] of snaps) {
      for (const t of tasks) {
        if (!isTaskDone(t.status)) continue;
        for (const key of taskKeys(t)) doneKeys.add(`${team}:${key}`);
      }
    }
    const now = Date.now();
    for (let k = waiters.length - 1; k >= 0; k--) {
      const w = waiters[k];
      if (doneKeys.has(`${w.team}:${w.ref}`) || now >= w.deadline) {
        waiters.splice(k, 1);
        w.resolve();
      }
    }
  };
  const waitForTaskDone = (team: string, ref: string): Promise<void> => new Promise((resolve) => {
    waiters.push({ team, ref, resolve, deadline: Date.now() + 20 * 60 * 1000 });
    if (!pollTimer) {
      pollTimer = setInterval(() => void tickPoll(), 5000);
      (pollTimer as { unref?: () => void }).unref?.();
    }
  });

  const done: Promise<void>[] = new Array(routed.length);
  const ownerChain: Record<string, Promise<void> | undefined> = {};
  const startSub = (i: number): Promise<void> => {
    const c = created[i];
    if (!c.ok) return Promise.resolve();
    const backDeps = (routed[i].dependsOn || []).filter((d) => d >= 0 && d < i);
    if (backDeps.some((d) => !created[d]?.ok)) { c.dispatched = false; return Promise.resolve(); }
    const deps = backDeps.map((d) => done[d]).filter(Boolean);
    const ownerKey = `${c.team}/${c.agent}`;
    const prevForOwner = ownerChain[ownerKey];
    const waits = prevForOwner ? [...deps, prevForOwner] : deps;
    const p = Promise.allSettled(waits).then(async () => {
      c.dispatched = true;
      const tc = client.withTeam(c.team);
      await tc.dispatch(budgetedCommand(tc, `/ask ${c.agent} ${qArg(taskPrompt(draft.objective, routed[i], c.ref))}`, 'draftDispatcher:task-dispatch')).then(() => {}, () => {});
      await waitForTaskDone(c.team, c.ref);
    });
    ownerChain[ownerKey] = p;
    return p;
  };
  for (let i = 0; i < routed.length; i++) done[i] = startSub(i);
  void Promise.allSettled(done);

  const ok = created.filter((c) => c.ok);
  const ready = ok.filter((c) => routed[c.idx].dependsOn.filter((d) => d < c.idx).length === 0);
  return { created, dispatched: ready.length, deferred: ok.length - ready.length };
}

function pruneProcessed(processed: Record<string, DraftDispatcherProcessedRecord>, now: number): Record<string, DraftDispatcherProcessedRecord> {
  const rows = Object.entries(processed)
    .filter(([, rec]) => now - rec.at <= PROCESSED_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, PROCESSED_CAP);
  return Object.fromEntries(rows);
}

function saveProcessed(processed: Record<string, DraftDispatcherProcessedRecord>, now: number): void {
  const cfg = loadSettings();
  cfg.draftDispatcher = {
    ...(cfg.draftDispatcher ?? {}),
    processed: pruneProcessed(processed, now),
    lastRunAt: now,
  };
  saveSettings(cfg);
}

export async function processDraftProposalsOnce(client: ManagerClient, opts: { now?: number; maxAgeMs?: number; maxDrafts?: number } = {}): Promise<DraftDispatchRunResult> {
  const now = opts.now ?? Date.now();
  const cfg = loadSettings();
  if (cfg.draftDispatcher?.enabled === false) {
    return { enabled: false, scanned: 0, candidates: 0, dispatched: 0, createdTasks: 0, skippedProcessed: 0, failed: 0, details: [] };
  }
  const rawProcessed = { ...(cfg.draftDispatcher?.processed ?? {}) };
  const processed = pruneProcessed(rawProcessed, now);
  let processedChanged = Object.keys(processed).length !== Object.keys(rawProcessed).length;
  const teams = await client.teams().catch(() => []);
  const teamNames = teams.length ? teams.map((t) => t.name).filter(Boolean) : [client.team ?? 'default'];
  const rosters = await loadRosters(client, teamNames);
  const drafts: ParsedDraftProposal[] = [];
  let scanned = 0;
  await Promise.all(teamNames.map(async (team) => {
    const rows = await client.withTeam(team).news(NEWS_LIMIT_PER_TEAM).catch(() => [] as NewsItem[]);
    scanned += rows.length;
    for (const row of rows) {
      const parsed = parseDraftProposalFromNews(row, team, now, opts.maxAgeMs ?? RECENT_DRAFT_MS);
      if (parsed) drafts.push(parsed);
    }
  }));
  drafts.sort((a, b) => b.at - a.at);

  const result: DraftDispatchRunResult = {
    enabled: true,
    scanned,
    candidates: drafts.length,
    dispatched: 0,
    createdTasks: 0,
    skippedProcessed: 0,
    failed: 0,
    details: [],
  };
  const maxDrafts = opts.maxDrafts ?? MAX_DRAFTS_PER_RUN;
  for (const draft of drafts) {
    if (processed[draft.key]) { result.skippedProcessed++; continue; }
    if (inFlightDrafts.has(draft.key)) { result.skippedProcessed++; continue; }
    if (result.dispatched >= maxDrafts) break;
    inFlightDrafts.add(draft.key);
    try {
      const plan = await createAndDispatchRoutedDraft(client, draft, rosters);
      const ok = plan.created.filter((c) => c.ok);
      if (!ok.length) {
        result.failed++;
        result.details.push({ key: draft.key, team: draft.team, status: 'failed', detail: plan.created.map((c) => c.error).filter(Boolean).join('; ') || 'no tasks created' });
        continue;
      }
      const refs = ok.map((c) => c.ref);
      processed[draft.key] = {
        at: now,
        team: draft.team,
        sourceNewsId: draft.sourceNewsId,
        taskRefs: refs,
        title: draft.subtasks[0]?.title,
        count: draft.subtasks.length,
      };
      processedChanged = true;
      result.dispatched++;
      result.createdTasks += ok.length;
      result.details.push({ key: draft.key, team: draft.team, status: 'dispatched', taskRefs: refs });
    } catch (e) {
      result.failed++;
      result.details.push({ key: draft.key, team: draft.team, status: 'failed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      inFlightDrafts.delete(draft.key);
    }
  }
  if (processedChanged) saveProcessed(processed, now);
  return result;
}

export function startDraftDispatcherLoop(clientProvider: () => ManagerClient): () => void {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const res = await processDraftProposalsOnce(clientProvider());
      if (res.enabled && (res.dispatched || res.failed)) {
        console.info('[draft-dispatcher]', JSON.stringify({ dispatched: res.dispatched, createdTasks: res.createdTasks, failed: res.failed }));
      }
    } catch (e) {
      console.warn('[draft-dispatcher] run failed:', e);
    } finally {
      running = false;
    }
  };
  const t0 = setTimeout(() => void tick(), INITIAL_DELAY_MS);
  const iv = setInterval(() => void tick(), POLL_MS);
  return () => { stopped = true; clearTimeout(t0); clearInterval(iv); };
}
