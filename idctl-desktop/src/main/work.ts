/**
 * Auto-decompose work for the fleet (main process).
 *
 * Given a free-text objective, ask the team lead to split it into concrete,
 * independently-actionable sub-tasks (with suggested owners and dependencies),
 * then create each as a real manager task and farm them out — independent tasks
 * dispatched in parallel, dependents chained after their prerequisites. The
 * Tasks view + live event feed then show the fleet working concurrently.
 */

import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, RemoteEnvelope, Task } from '../../../idctl/src/api/types.ts';
import { setTaskLane, setTaskDeps, loadSettings } from '../../../idctl/src/settings/store.ts';
import { optimizeAskCommand } from './contextBudget.ts';

export interface SubTask { title: string; description: string; agent: string; dependsOn: number[] }
export interface CreatedTask { idx: number; ref: string; title: string; agent: string; ok: boolean; error?: string; warning?: string; dependsOn: number[]; dispatched: boolean; deferred?: boolean }
export interface DecomposeResult { ok: boolean; subtasks: SubTask[]; raw: string; error?: string }
export interface CreatePlanResult { created: CreatedTask[]; dispatched: number; deferred: number }
export interface TeamLeadDelegationTarget { team: string; lead: string; activeCount: number; totalCount: number; runtime?: string; status?: string; skills: string[] }
export interface TeamLeadDelegatedTask extends CreatedTask { team: string; lead: string }
export interface TeamLeadDelegationResult {
  ok: boolean;
  targetCount: number;
  subtasks: SubTask[];
  created: TeamLeadDelegatedTask[];
  dispatched: number;
  deferred: number;
  errors: string[];
  raw?: string;
}
export interface TeamLeadDelegationOptions { currentTeam?: string; primaryLead?: string }

/** Quote a free-text argument as ONE token for the manager tokenizer (matches client qArg). */
function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
const GOAL_ID_RE = /\bgoal_[a-z0-9_]+\b/i;
const FALLBACK_GOAL_ID = 'goal_manual_dispatch';

function budgetedAskCommand(client: ManagerClient, command: string, source: string): string {
  return optimizeAskCommand(command, { source, team: client.team }).command;
}
function dispatchBudgeted(client: ManagerClient, command: string, source: string): Promise<string> {
  return client.dispatch(budgetedAskCommand(client, command, source));
}
function remoteBudgeted<T = unknown>(client: ManagerClient, command: string, source: string): Promise<RemoteEnvelope<T>> {
  return client.remote<T>(budgetedAskCommand(client, command, source));
}
function enqueueBudgeted(client: ManagerClient, command: string, source: string): Promise<RemoteEnvelope<{ queryId?: string; status?: string }>> {
  return remoteBudgeted<{ queryId?: string; status?: string }>(client, command, source);
}

/** A task is complete once the manager reports a done/complete status. */
function isTaskDone(status?: string): boolean { return /done|complete/i.test(status ?? ''); }

/** Every identifier a created task might be keyed by, so a dependent's stored ref
 *  matches the prerequisite regardless of which field the create call returned. */
function taskKeys(t: Task): string[] {
  return [t.shortId, t.name, t.uuid, t.title].filter(Boolean) as string[];
}
function taskRef(t: Task): string { return t.shortId ?? t.name ?? t.uuid ?? t.title; }
function clip(s: string, n: number): string { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

const MAX_SUBTASKS = boundedEnvInt('IDACC_WORK_MAX_SUBTASKS', 12, 1, 24);
const WORK_TASK_MANAGER_SUBTASK_CAP = boundedEnvInt('IDACC_WORK_TASK_MANAGER_SUBTASK_CAP', 3, 1, MAX_SUBTASKS);
const WORK_CREATE_TASK_CAP = boundedEnvInt('IDACC_WORK_CREATE_TASK_CAP', 3, 1, MAX_SUBTASKS);
const WORK_LEAD_QUEUE_MAX = positiveEnvInt('IDACC_WORK_LEAD_QUEUE_MAX', 2);
const WORK_LEAD_GUARD_TTL_MS = positiveEnvInt('IDACC_WORK_LEAD_GUARD_TTL_MINUTES', 45) * 60 * 1000;
const WORK_OWNER_OPEN_TASK_CAP = positiveEnvInt('IDACC_WORK_OWNER_OPEN_TASK_CAP', 1);
const WORK_QUEUE_TODO_CAP = positiveEnvInt('IDACC_WORK_QUEUE_TODO_CAP', 1);
const WORK_COMPLETION_DONE_TASK_LIMIT = positiveEnvInt('IDACC_WORK_DONE_POLL_LIMIT', 250);
const WORK_PLANNER_TEAM = process.env.IDACC_WORK_PLANNER_TEAM || 'ops-team';
const WORK_PLANNER_NAMES = (process.env.IDACC_WORK_PLANNER_NAMES || 'task-manager,task-master')
  .split(',')
  .map((name) => agentNameKey(name))
  .filter(Boolean);

function positiveEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  return Math.min(max, Math.max(min, value));
}

function extractGoalId(...texts: Array<string | undefined | null>): string {
  for (const text of texts) {
    const match = String(text || '').match(GOAL_ID_RE);
    if (match) return match[0];
  }
  return FALLBACK_GOAL_ID;
}

function taskBriefFlags(objective: string, st: Pick<SubTask, 'title' | 'description'>): string {
  const goalId = extractGoalId(st.description, objective);
  const expected = st.description
    ? `Complete this task and produce the requested output: ${clip(st.description, 220)}`
    : `Complete "${clip(st.title, 160)}" and report concise evidence.`;
  const acceptance = 'Owner delivers the expected output, cites evidence or blockers, keeps scope to this task, and closes with acceptance coverage or a failure note.';
  const validation = 'Owning lead reviews the completion; default coder and researcher validate substantial cross-team work.';
  const outOfScope = 'Unrelated refactors, destructive operations, credential changes, and optional follow-up recommendations beyond this task.';
  const backlog = 'Non-required recommendations or low-relevance follow-ups become backlog candidates instead of live delegated work.';
  const relevance = 'medium: improves managed-agent throughput and contributor readiness for Bittrees-related work.';
  return [
    ['--goal', goalId],
    ['--expected-output', expected],
    ['--acceptance', acceptance],
    ['--validation-path', validation],
    ['--out-of-scope', outOfScope],
    ['--backlog-policy', backlog],
    ['--bittrees-relevance', relevance],
  ].map(([flag, value]) => `${flag} ${qArg(value)}`).join(' ');
}

async function openTasks(client: ManagerClient): Promise<Task[]> {
  const [todo, doing] = await Promise.all([
    client.tasksByStatus('todo').catch(() => [] as Task[]),
    client.tasksByStatus('doing').catch(() => [] as Task[]),
  ]);
  return [...todo, ...doing];
}

async function recentDoneTasks(client: ManagerClient): Promise<Task[]> {
  return client.tasksByStatus('done', { limit: WORK_COMPLETION_DONE_TASK_LIMIT }).catch(() => [] as Task[]);
}

/** An agent is routable only when it's actually running. Anything clearly
 *  stopped/offline/errored is skipped so work never dispatches into the void. */
export function isActiveStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  if (!s) return false;
  return !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}
/** Pick a team's coordinator among its ACTIVE agents using explicit lead metadata,
 *  lead-like names, and coordinator/router roles before generic manager names. */
function roleText(a: { metadata?: unknown }): string {
  const meta = a.metadata && typeof a.metadata === 'object' ? a.metadata as Record<string, unknown> : {};
  const catalog = meta.catalog && typeof meta.catalog === 'object' ? meta.catalog as Record<string, unknown> : {};
  return [
    meta.primaryLead === true ? 'primary lead' : '',
    meta.role,
    catalog.role,
    meta.description,
    catalog.description,
  ].map((v) => String(v || '').toLowerCase()).join('\n');
}

function roleNameText(a: { metadata?: unknown }): string {
  const meta = a.metadata && typeof a.metadata === 'object' ? a.metadata as Record<string, unknown> : {};
  const catalog = meta.catalog && typeof meta.catalog === 'object' ? meta.catalog as Record<string, unknown> : {};
  return [meta.role, catalog.role].map((v) => String(v || '').toLowerCase()).join('\n');
}

function leadRank(a: { name: string; metadata?: unknown }): number {
  const name = agentNameKey(a.name);
  const role = roleText(a);
  const roleName = roleNameText(a);
  if (role.includes('primary lead')) return 0;
  if (name === 'lead' || /(^|[-_\s])(lead|coordinator|router)$/.test(name)) return 1;
  if (/\b(team coordinator|coordinator|router|lead)\b/.test(roleName)) return 2;
  if (/\bcounsel\b/.test(name) && /\b(coordinat|team lead)\b/.test(role)) return 2;
  if (/^hr[-_\s]?manager$/.test(name)) return 3;
  if (/manager|coordinator/.test(name)) return 4;
  return 5;
}

function pickActiveLead(agents: { name: string; status?: string; metadata?: unknown }[]): string | null {
  const active = agents.filter((a) => isActiveStatus(a.status));
  if (!active.length) return null;
  return active
    .slice()
    .sort((a, b) => leadRank(a) - leadRank(b) || a.name.localeCompare(b.name))[0].name;
}

function agentNameKey(name?: string): string {
  return String(name || '').trim().toLowerCase();
}

type LeadDispatchRecord = { queryId?: string; at: number; purpose: string };
const leadDispatches = new Map<string, LeadDispatchRecord[]>();

function leadDispatchKey(client: ManagerClient, lead: string): string {
  return `${client.team ?? 'default'}:${agentNameKey(lead)}`;
}

function queryStillActive(status?: string): boolean {
  return status === 'pending' || status === 'processing';
}

async function localLeadDispatchCount(client: ManagerClient, lead: string): Promise<number> {
  const key = leadDispatchKey(client, lead);
  const rows = leadDispatches.get(key) ?? [];
  const now = Date.now();
  const kept: LeadDispatchRecord[] = [];
  for (const row of rows) {
    if (now - row.at > WORK_LEAD_GUARD_TTL_MS) continue;
    if (!row.queryId) {
      kept.push(row);
      continue;
    }
    try {
      const q = await client.query(row.queryId, 0);
      if (queryStillActive(q.status)) kept.push(row);
    } catch {
      kept.push(row);
    }
  }
  if (kept.length) leadDispatches.set(key, kept);
  else leadDispatches.delete(key);
  return kept.length;
}

async function leadQueueLoad(client: ManagerClient, lead: string): Promise<{ count: number; source: 'manager' | 'app-local' }> {
  const local = await localLeadDispatchCount(client, lead);
  const live = await client.activeAgentQueries(lead).catch(() => null);
  if (live) return { count: Math.max(local, live.count), source: 'manager' };
  return { count: local, source: 'app-local' };
}

async function guardLeadQueue(client: ManagerClient, lead: string, purpose: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const load = await leadQueueLoad(client, lead);
  if (load.count < WORK_LEAD_QUEUE_MAX) return { ok: true };
  return {
    ok: false,
    detail: `${purpose} deferred: ${client.team ?? 'default'}/${lead} already has ${load.count} active lead ${load.count === 1 ? 'query' : 'queries'} (${load.source}; limit ${WORK_LEAD_QUEUE_MAX})`,
  };
}

function recordLeadDispatch(client: ManagerClient, lead: string, queryId: string | undefined, purpose: string): void {
  const key = leadDispatchKey(client, lead);
  const rows = leadDispatches.get(key) ?? [];
  rows.push({ queryId, at: Date.now(), purpose });
  leadDispatches.set(key, rows.slice(-WORK_LEAD_QUEUE_MAX));
}

type DecompositionPlanner = {
  client: ManagerClient;
  agent: string;
  kind: 'task-manager' | 'lead';
};

async function resolveDecompositionPlanner(client: ManagerClient, fallbackLead: string): Promise<DecompositionPlanner> {
  const candidateTeams = [...new Set([client.team ?? 'default', WORK_PLANNER_TEAM].filter(Boolean))];
  for (const team of candidateTeams) {
    const scoped = team === client.team ? client : client.withTeam(team);
    const roster = await scoped.agents().catch(() => [] as Agent[]);
    const planner = roster.find((agent) =>
      isActiveStatus(agent.status) && WORK_PLANNER_NAMES.includes(agentNameKey(agent.name)),
    );
    if (planner) return { client: scoped, agent: planner.name, kind: 'task-manager' };
  }
  return { client, agent: fallbackLead, kind: 'lead' };
}

async function resolveActiveTeamLeadTargets(baseClient: ManagerClient, currentTeam = 'default'): Promise<TeamLeadDelegationTarget[]> {
  const teams = await baseClient.teams().catch(() => []);
  const names = [...new Set(teams.map((team) => String(team.name || '').trim()).filter(Boolean))]
    .filter((team) => team !== currentTeam && team !== 'default');
  const targets = await Promise.all(
    names.map(async (team): Promise<TeamLeadDelegationTarget | null> => {
      const agents = await baseClient.withTeam(team).agents().catch(() => [] as Agent[]);
      const activeCount = agents.filter((agent) => isActiveStatus(agent.status)).length;
      const lead = pickActiveLead(agents);
      if (!lead || isDefaultValidatorName(lead)) return null;
      const row = agents.find((agent) => agent.name === lead);
      return {
        team,
        lead,
        activeCount,
        totalCount: agents.length,
        runtime: row?.runtime,
        status: row?.status,
        skills: Array.isArray(row?.metadata?.skills) ? row!.metadata!.skills as string[] : [],
      };
    }),
  );
  return targets.filter((target): target is TeamLeadDelegationTarget => !!target && target.activeCount > 0);
}

function normRouteKey(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function teamLeadTargetForSubtask(targets: TeamLeadDelegationTarget[], st: SubTask, index: number): TeamLeadDelegationTarget {
  const byLead = new Map(targets.map((target) => [normRouteKey(target.lead), target]));
  const byTeam = new Map(targets.map((target) => [normRouteKey(target.team), target]));
  const ownerKey = normRouteKey(st.agent);
  const exact = byLead.get(ownerKey) ?? byTeam.get(ownerKey);
  if (exact) return exact;
  const hay = normRouteKey(`${st.agent} ${st.title} ${st.description}`);
  return targets.find((target) => hay.includes(normRouteKey(target.team)) || hay.includes(normRouteKey(target.lead)))
    ?? targets[index % targets.length];
}

function teamLeadPacket(target: TeamLeadDelegationTarget, st: SubTask): SubTask {
  const leadNote = `Team lead packet for ${target.team}: create child /task rows for active teammates before execution, coordinate the work, close with delegated child task names, and surface blockers immediately.`;
  return {
    title: st.title,
    agent: target.lead,
    description: clip([st.description, leadNote].filter(Boolean).join('\n\n'), 380),
    dependsOn: st.dependsOn,
  };
}

function deterministicTeamLeadSubtasks(objective: string, targets: TeamLeadDelegationTarget[]): SubTask[] {
  const obj = clip(objective, 1400);
  return targets.slice(0, MAX_SUBTASKS).map((target): SubTask => ({
    title: `Route objective through ${target.team}`,
    agent: target.lead,
    description: [
      `Planner fallback for ${target.team}: decompose this objective for active teammates before execution.`,
      'Create only the minimal child /task rows needed for your team, skip shipped or duplicate work, and surface any blocker up to the primary lead.',
      `Objective: ${obj}`,
    ].join('\n'),
    dependsOn: [],
  }));
}

function warningNeedsTriage(warning?: string): boolean {
  return !!warning && !/coordinator-owned parent kicked off for manager delegation/i.test(warning);
}

function isDefaultTeamName(team?: string): boolean {
  return !team || team === 'default';
}

function isDefaultValidatorName(name?: string): boolean {
  return /^(coder|researcher)$/i.test(String(name || '').trim());
}

/**
 * Execution owners are different from coordinators. A lead may decompose and
 * supervise, but work should go to non-lead assignees whenever the team has any.
 * On the default team, coder/researcher are validation leads; use them only if
 * no other non-lead assignee exists.
 */
function executionPoolForTeam<T extends { name: string; status?: string }>(
  agents: T[],
  lead: string,
  team?: string,
  allowCoordinator = false,
  allowInactiveOwners = false,
): T[] {
  const active = agents.filter((a) => isActiveStatus(a.status));
  const base = allowInactiveOwners ? agents : (active.length ? active : agents);
  if (allowCoordinator || base.length <= 1) return base;
  const leadKey = agentNameKey(lead);
  const withoutLead = base.filter((a) => agentNameKey(a.name) !== leadKey);
  if (!withoutLead.length) return base;
  if (isDefaultTeamName(team)) {
    const withoutValidators = withoutLead.filter((a) => !isDefaultValidatorName(a.name));
    if (withoutValidators.length) return withoutValidators;
  }
  return withoutLead;
}

function agentLine(
  a: { name: string; runtime?: string; skills?: string[]; status?: string },
  lead: string,
  assignableNames: Set<string>,
  team?: string,
): string {
  let suffix = '';
  if (!isActiveStatus(a.status)) suffix = ' [STOPPED - do not assign]';
  else if (!assignableNames.has(a.name)) {
    if (agentNameKey(a.name) === agentNameKey(lead)) suffix = ' [COORDINATOR - do not assign execution]';
    else if (isDefaultTeamName(team) && isDefaultValidatorName(a.name)) suffix = ' [VALIDATOR - do not assign execution unless no worker/team lead exists]';
    else suffix = ' [HELD - do not assign execution]';
  }
  return `- ${a.name}${a.runtime ? ` (${a.runtime})` : ''}${suffix}${a.skills?.length ? ` - skills: ${a.skills.slice(0, 6).join(', ')}` : ''}`;
}

/** Spread assignments so no single agent is handed a pile of tasks at once: cap each agent at
 *  max(2, ceil(total/active)) and move overflow to the least-loaded active agent. Keeps the
 *  best-fit owner up to the cap, then balances. Mutates items[].agent in place. */
function balanceOwners(items: { agent: string }[], activeNames: string[]): void {
  if (activeNames.length <= 1 || items.length <= 1) return;
  const cap = Math.max(2, Math.ceil(items.length / activeNames.length));
  const load: Record<string, number> = {};
  for (const n of activeNames) load[n] = 0;
  for (const it of items) {
    let agent = activeNames.includes(it.agent) ? it.agent : activeNames[0];
    if (load[agent] >= cap) agent = activeNames.reduce((a, b) => (load[b] < load[a] ? b : a), activeNames[0]);
    load[agent]++;
    it.agent = agent;
  }
}

/** Pull the first JSON array out of a model reply (tolerates code fences / surrounding prose). */
function extractJsonArray(text: string): unknown[] | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const v = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

type PlanCapacity = {
  ownerSlots: Map<string, number>;
  ownerOpen: Map<string, number>;
  ownerActiveQueries: Map<string, number>;
  queueTodoSlots: number;
  queueTodoCount: number;
};

function isOpenTaskStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !!s && !/done|complete|cancel|archive|reject/.test(s);
}

function isTodoStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return isOpenTaskStatus(s) && !/doing|claim|progress|start|active|block|stall/.test(s);
}

function taskLanesSnapshot(): Record<string, string> {
  try {
    return (loadSettings().taskLanes ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

function liveTaskLane(t: Task, lanes: Record<string, string>): boolean {
  const lane = lanes[taskRef(t)];
  return !lane || lane === 'todo' || lane === 'doing';
}

async function activeQueryCount(client: ManagerClient, agent: string): Promise<number> {
  const getter = (client as unknown as {
    activeAgentQueries?: (agentIdOrName: string) => Promise<{ count?: number } | null>;
  }).activeAgentQueries;
  if (typeof getter !== 'function') return 0;
  try {
    const active = await getter.call(client, agent);
    return Number(active?.count) || 0;
  } catch {
    return 0;
  }
}

async function planCapacity(client: ManagerClient, pool: Agent[], ownerOpenTaskCap = WORK_OWNER_OPEN_TASK_CAP): Promise<PlanCapacity> {
  const [tasks, queryCounts] = await Promise.all([
    openTasks(client),
    Promise.all(pool.map(async (agent) => [agentNameKey(agent.name), await activeQueryCount(client, agent.name)] as const)),
  ]);
  const lanes = taskLanesSnapshot();
  const open = tasks.filter((task) => isOpenTaskStatus(task.status) && liveTaskLane(task, lanes));
  const ownerOpen = new Map<string, number>();
  for (const task of open) {
    const owner = agentNameKey(task.ownerName || '');
    if (!owner) continue;
    ownerOpen.set(owner, (ownerOpen.get(owner) ?? 0) + 1);
  }
  const ownerActiveQueries = new Map<string, number>(queryCounts);
  const ownerSlots = new Map<string, number>();
  for (const agent of pool) {
    const key = agentNameKey(agent.name);
    const used = (ownerOpen.get(key) ?? 0) + (ownerActiveQueries.get(key) ?? 0);
    ownerSlots.set(key, Math.max(0, ownerOpenTaskCap - used));
  }
  const queueTodoCount = open.filter((task) => !task.ownerName && isTodoStatus(task.status)).length;
  return {
    ownerSlots,
    ownerOpen,
    ownerActiveQueries,
    queueTodoSlots: Math.max(0, WORK_QUEUE_TODO_CAP - queueTodoCount),
    queueTodoCount,
  };
}

function capacityDeferredTask(i: number, st: SubTask, reason: string): CreatedTask {
  return {
    idx: i,
    ref: st.title,
    title: st.title,
    agent: st.agent,
    ok: false,
    error: reason,
    warning: reason,
    dependsOn: st.dependsOn,
    dispatched: false,
    deferred: true,
  };
}

function consumeOwnerCapacity(capacity: PlanCapacity, team: string | undefined, agent: string): { ok: true } | { ok: false; reason: string } {
  const key = agentNameKey(agent);
  const slots = capacity.ownerSlots.get(key) ?? 0;
  if (slots > 0) {
    capacity.ownerSlots.set(key, slots - 1);
    return { ok: true };
  }
  const open = capacity.ownerOpen.get(key) ?? 0;
  const active = capacity.ownerActiveQueries.get(key) ?? 0;
  return {
    ok: false,
    reason: `capacity deferred: ${team ?? 'default'}/${agent} already has ${open} open task${open === 1 ? '' : 's'} and ${active} active quer${active === 1 ? 'y' : 'ies'}; no live task was created`,
  };
}

function consumeQueueCapacity(capacity: PlanCapacity, team: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (capacity.queueTodoSlots > 0) {
    capacity.queueTodoSlots--;
    capacity.queueTodoCount++;
    return { ok: true };
  }
  return {
    ok: false,
    reason: `capacity deferred: ${team ?? 'default'} already has ${capacity.queueTodoCount} unassigned todo task${capacity.queueTodoCount === 1 ? '' : 's'} (limit ${WORK_QUEUE_TODO_CAP}); no live task was created`,
  };
}

function decompositionCapForPlanner(kind: DecompositionPlanner['kind']): number {
  return kind === 'task-manager' ? WORK_TASK_MANAGER_SUBTASK_CAP : MAX_SUBTASKS;
}

const INTERNAL_WORK_DECOMPOSITION_MARKER = '[IDACC_INTERNAL_WORK_DECOMPOSITION]';

const DECOMP_PROMPT = (objective: string, agentLines: string, maxSubtasks: number) =>
  `${INTERNAL_WORK_DECOMPOSITION_MARKER}
You are the internal work planner. Break the objective below into a small set of concrete, independently-actionable sub-tasks for the fleet, and assign each to the best-suited execution owner.

Objective: ${objective}

Assignable agents:
${agentLines}

Return ONLY a JSON array (no prose, no markdown fence) of up to ${maxSubtasks} objects with this exact shape:
[{"title":"short imperative task","description":"1-2 sentences: what to do and the expected output","agent":"<one of the agent names above>","dependsOn":[<0-based indices of prerequisite tasks in THIS array; empty when it can start immediately>]}]

Rules:
- Assign work ONLY to agents that are running; never assign a task to one marked [STOPPED — do not assign].
- Do not assign execution to yourself/the coordinator when any non-coordinator assignee is available.
- On the default team, coder and researcher validate completed work; do not assign normal execution to them when another worker or team lead is available.
- Maximize parallelism: use an empty dependsOn whenever a task does not truly need another task's output.
- Only add a dependency when a task genuinely needs a prior task's result.
- Keep titles short and imperative; assign realistic owners chosen from the agent names above.`;

/** Ask the lead to decompose the objective; parse + sanitize into sub-tasks. */
export async function decomposeWork(
  client: ManagerClient,
  objective: string,
  lead: string,
  agents: { name: string; runtime?: string; skills?: string[]; status?: string }[],
): Promise<DecomposeResult> {
  const obj = (objective || '').trim();
  if (!obj) return { ok: false, subtasks: [], raw: '', error: 'describe the work first' };
  const names = new Set(agents.map((a) => a.name));
  const assignable = executionPoolForTeam(agents, lead, client.team);
  const assignableNames = new Set(assignable.map((a) => a.name));
  const firstActive = agents.find((a) => isActiveStatus(a.status))?.name;
  // Prefer routing to an agent that's actually running; fall back to anything only
  // if the whole roster is stopped.
  const fallback = assignable.find((a) => isActiveStatus(a.status))?.name ?? assignable[0]?.name ?? firstActive ?? (names.has(lead) ? lead : agents[0]?.name ?? lead);
  const visibleAgents = assignable.length ? assignable : agents;
  const agentLines =
    visibleAgents.map((a) => agentLine(a, lead, assignableNames, client.team)).join('\n') ||
    `- ${fallback}`;

  let raw = '';
  let maxSubtasks = MAX_SUBTASKS;
  try {
    const planner = await resolveDecompositionPlanner(client, lead);
    const guard = await guardLeadQueue(planner.client, planner.agent, planner.kind === 'task-manager' ? 'task-manager decomposition' : 'decomposition');
    let activePlanner = planner;
    if (!guard.ok && planner.kind === 'task-manager' && lead && planner.agent !== lead) {
      const leadGuard = await guardLeadQueue(client, lead, 'lead fallback decomposition');
      if (!leadGuard.ok) {
        return { ok: false, subtasks: [], raw: '', error: `${guard.detail}; lead fallback unavailable: ${leadGuard.detail}` };
      }
      activePlanner = { client, agent: lead, kind: 'lead' };
    } else if (!guard.ok) {
      return { ok: false, subtasks: [], raw: '', error: guard.detail };
    }
    maxSubtasks = decompositionCapForPlanner(activePlanner.kind);
    raw = await dispatchBudgeted(activePlanner.client, `/ask ${activePlanner.agent} ${qArg(DECOMP_PROMPT(obj, agentLines, maxSubtasks))}`, 'work:decompose');
  } catch (e) {
    return { ok: false, subtasks: [], raw: '', error: e instanceof Error ? e.message : String(e) };
  }
  if (!raw || raw === '(empty reply)' || raw === '(no reply)') return { ok: false, subtasks: [], raw, error: 'the lead returned an empty reply — try again' };

  const arr = extractJsonArray(raw);
  if (!arr) return { ok: false, subtasks: [], raw, error: 'could not parse a task list from the reply' };

  const n = Math.min(arr.length, maxSubtasks);
  const subtasks: SubTask[] = [];
  for (let i = 0; i < n; i++) {
    const o = (arr[i] ?? {}) as Record<string, unknown>;
    const title = clip(String(o.title ?? o.task ?? `Task ${i + 1}`), 120) || `Task ${i + 1}`;
    const description = clip(String(o.description ?? o.detail ?? ''), 400);
    let agent = String(o.agent ?? o.owner ?? '').trim();
    // Coerce unknown, stopped, coordinator, or validator-only owners to an execution assignee.
    if (!(assignableNames.size ? assignableNames.has(agent) : names.has(agent))) agent = fallback;
    const deps = Array.isArray(o.dependsOn) ? o.dependsOn : Array.isArray(o.depends_on) ? o.depends_on : [];
    const dependsOn = (deps as unknown[])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d < n && d !== i);
    subtasks.push({ title, description, agent, dependsOn });
  }
  return { ok: subtasks.length > 0, subtasks, raw, error: subtasks.length ? undefined : 'no tasks produced' };
}

const WORK_PROMPT = (objective: string, st: SubTask, ref: string) =>
  `Team objective: ${objective}

Your assigned task (${ref}): ${st.title}
${st.description ? st.description + '\n' : ''}
Do this task now. When finished, mark it done with: /task done ${ref} --acceptance "completed the assigned scope; evidence is in my reply"
If you delegated child tasks as a lead/coordinator, include their task names when closing: --delegated-task-names "child-task-one,child-task-two"
If you cannot complete it, mark it done with: /task done ${ref} --failure-note "<why this task could not be completed>".`;

/**
 * Create every sub-task (so they all appear in the Tasks view at once), then
 * farm out the work in the background: a task dispatches as soon as the work for
 * its earlier-listed prerequisites has been dispatched-and-returned. Only
 * BACKWARD dependencies (index < self) chain, which guarantees a DAG (no
 * deadlock) even if the model emitted a cycle. Returns once tasks are created;
 * the dispatches keep running in the background.
 */
export async function createAndDispatchPlan(
  client: ManagerClient,
  objective: string,
  subtasks: SubTask[],
  opts: { dispatch?: boolean; lane?: string; respectOwners?: boolean; allowCoordinatorOwners?: boolean; allowInactiveOwners?: boolean; ownerOpenTaskCap?: number; coordinator?: string; leadCoordination?: boolean } = {},
): Promise<CreatePlanResult> {
  // dispatch=false → create tasks UNOWNED (status todo) into a lane and DON'T farm them
  // out (a staged queue the lead works later). Default true = assign owners + dispatch.
  const dispatch = opts.dispatch !== false;
  // Defense-in-depth: never trust the renderer's owner names for an outward-facing
  // fleet dispatch. Re-validate every owner against the live roster and coerce an
  // unknown one to a real agent (the first available). Also clamp deps in-range.
  const roster = (await client.agents().catch(() => [])) as Agent[];
  // Auto-route to ACTIVE agents only: a stopped agent can't pick up work, so the
  // owner pool (and the coerce-to-fallback target) is the running roster whenever
  // any agent is running; degrade to the full roster only if nothing is active.
  const coordinator = String(opts.coordinator ?? pickActiveLead(roster) ?? '').trim();
  const pool = executionPoolForTeam(roster, coordinator, client.team, opts.allowCoordinatorOwners === true, opts.allowInactiveOwners === true);
  const names = new Set(pool.map((a) => a.name));
  const fallback = pool[0]?.name ?? '';
  const planItems = subtasks.slice(0, MAX_SUBTASKS).map((st, i, arr) => ({
    title: clip(String(st?.title ?? `Task ${i + 1}`), 120) || `Task ${i + 1}`,
    description: clip(String(st?.description ?? ''), 400),
    agent: names.has(st?.agent) ? st.agent : fallback,
    dependsOn: (Array.isArray(st?.dependsOn) ? st.dependsOn : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d < arr.length && d !== i),
  }));
  const createLimit = Math.min(WORK_CREATE_TASK_CAP, planItems.length);
  const list = planItems.slice(0, createLimit);
  const created: CreatedTask[] = [];
  if (!fallback) return { created, dispatched: 0, deferred: 0 }; // no agents → nothing to dispatch
  // Don't pile every task on one agent - spread across the active roster (best-fit up to a cap).
  // respectOwners=true keeps explicit execution owners, but still blocks coordinator/validator bypasses.
  if (!opts.respectOwners) balanceOwners(list, [...names]);
  const ownerOpenTaskCap = Number.isFinite(opts.ownerOpenTaskCap) && Number(opts.ownerOpenTaskCap) > 0
    ? Math.floor(Number(opts.ownerOpenTaskCap))
    : WORK_OWNER_OPEN_TASK_CAP;
  const capacity = await planCapacity(client, pool, ownerOpenTaskCap);
  const deferredIndexes = new Set<number>();

  // 1) Create only tasks that have immediate capacity; defer the rest without
  // materializing extra live manager rows.
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    const blockedDep = (st.dependsOn || []).find((d) => d >= 0 && d < i && deferredIndexes.has(d));
    if (blockedDep != null) {
      deferredIndexes.add(i);
      created.push(capacityDeferredTask(i, st, `capacity deferred: prerequisite #${blockedDep + 1} was deferred; no live task was created`));
      continue;
    }
    const gate = dispatch ? consumeOwnerCapacity(capacity, client.team, st.agent) : consumeQueueCapacity(capacity, client.team);
    if (!gate.ok) {
      deferredIndexes.add(i);
      created.push(capacityDeferredTask(i, st, gate.reason));
      continue;
    }
    // Dispatching: assign the owner now (manager sets owned→doing). Queuing: create
    // unowned (stays todo) and record the lead's suggested owner in the description.
    const desc = dispatch ? st.description : `${st.description}${st.description ? '\n\n' : ''}(suggested owner: ${st.agent})`.trim();
    const coordinationFlag = dispatch && opts.leadCoordination === true ? ' --lead-coordination' : '';
    const cmd = `/task create ${qArg(st.title)}${dispatch ? ` --owner ${st.agent}` : ''}${coordinationFlag}${desc ? ` --description ${qArg(desc)}` : ''} ${taskBriefFlags(objective, st)}`;
    try {
      const env = await client.remote<{ task?: { shortId?: string; name?: string; ownerName?: string | null; status?: string | null }; warning?: string }>(cmd);
      const task = env.result?.task;
      const remoteWarning = typeof env.result?.warning === 'string' && env.result.warning.trim() ? env.result.warning.trim() : undefined;
      const ref = task?.shortId ?? task?.name ?? st.title;
      if (opts.lane && ref) { try { setTaskLane(ref, opts.lane); } catch { /* overlay is best-effort */ } }
      const hasOwnerField = task ? Object.prototype.hasOwnProperty.call(task, 'ownerName') : false;
      const actualOwner = agentNameKey(task?.ownerName ?? '');
      const expectedOwner = agentNameKey(st.agent);
      const returnedTodo = task?.status ? isTodoStatus(task.status) : false;
      if (dispatch && ((hasOwnerField && actualOwner !== expectedOwner) || returnedTodo)) {
        const actual = task?.ownerName || (returnedTodo ? 'unowned todo' : 'unknown');
        created.push({
          idx: i,
          ref,
          title: st.title,
          agent: st.agent,
          ok: false,
          error: `dispatch did not assign requested owner ${st.agent}; manager returned ${actual}`,
          warning: remoteWarning,
          dependsOn: st.dependsOn,
          dispatched: false,
          deferred: true,
        });
        continue;
      }
      const coordinatorKickoff = dispatch
        && opts.allowCoordinatorOwners === true
        && agentNameKey(st.agent) === agentNameKey(coordinator);
      const localWarning = coordinatorKickoff ? 'coordinator-owned parent kicked off for manager delegation' : undefined;
      const warning = [remoteWarning, localWarning].filter(Boolean).join('; ') || undefined;
      created.push({
        idx: i,
        ref,
        title: st.title,
        agent: st.agent,
        ok: true,
        warning,
        dependsOn: st.dependsOn,
        dispatched: false,
        deferred: false,
      });
    } catch (e) {
      created.push({ idx: i, ref: st.title, title: st.title, agent: st.agent, ok: false, error: e instanceof Error ? e.message : String(e), dependsOn: st.dependsOn, dispatched: false });
    }
  }
  for (let i = createLimit; i < planItems.length; i++) {
    created.push(capacityDeferredTask(
      i,
      planItems[i],
      `capacity deferred: live task creation cap ${WORK_CREATE_TASK_CAP} reached for this plan; review remaining proposed work before creating more tasks`,
    ));
  }

  // Persist the dependency graph app-side (the manager has no deps field) so the board
  // can surface "blocked by …". Map each task's backward dep indices → the created refs.
  try {
    for (let i = 0; i < created.length; i++) {
      const c = created[i];
      if (!c.ok) continue;
      const refs = (planItems[i]?.dependsOn || [])
        .filter((d) => d >= 0 && d < created.length && created[d]?.ok)
        .map((d) => created[d].ref);
      if (refs.length) setTaskDeps(c.ref, refs);
    }
  } catch { /* overlay is best-effort */ }

  // Queue-only: tasks created in the lane, not farmed out — the lead works them later.
  if (!dispatch) return { created, dispatched: 0, deferred: created.filter((c) => c.ok || c.deferred).length };

  // 2) Background wave-dispatch. A dependent waits for its prerequisites to actually
  // COMPLETE (not merely be dispatched) before it runs — otherwise the manager, which
  // has no deps field, happily completes an aggregation task before its inputs exist.
  // Only BACKWARD deps (index < self) chain → guaranteed DAG (no deadlock). A prereq
  // that failed to be created never releases its dependents (they'd run against output
  // that never got produced).
  //
  // Shared completion poller (per-dispatch, self-cleaning): one tasks() snapshot per tick
  // resolves every waiter whose task reached done. A generous per-task safety deadline
  // releases a waiter even if its prereq never completes, so a wedged agent can't deadlock
  // the chain forever (the auto-pilot re-dispatches stalled prereqs in the meantime).
  const COMPLETION_POLL_MS = 5000;
  const COMPLETION_TIMEOUT_MS = 20 * 60 * 1000;
  const waiters: { ref: string; resolve: () => void; deadline: number }[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const tickPoll = async (): Promise<void> => {
    if (!waiters.length) { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } return; }
    const snap = await recentDoneTasks(client);
    const doneKeys = new Set<string>();
    for (const t of snap) if (isTaskDone(t.status)) for (const k of taskKeys(t)) doneKeys.add(k);
    const now = Date.now();
    for (let k = waiters.length - 1; k >= 0; k--) {
      const w = waiters[k];
      if (doneKeys.has(w.ref) || now >= w.deadline) { waiters.splice(k, 1); w.resolve(); }
    }
  };
  const waitForTaskDone = (ref: string): Promise<void> => new Promise((resolve) => {
    waiters.push({ ref, resolve, deadline: Date.now() + COMPLETION_TIMEOUT_MS });
    if (!pollTimer) { pollTimer = setInterval(() => void tickPoll(), COMPLETION_POLL_MS); (pollTimer as { unref?: () => void }).unref?.(); }
  });

  // done[i] resolves only AFTER task i completes, so dependents wait for OUTPUT, not dispatch.
  const done: Promise<void>[] = new Array(list.length);
  const initialEnqueues: Promise<void>[] = [];
  // One in-flight task per OWNER: an agent works (and finishes) its tasks one at a time. This
  // also serializes local-model agents so they never thrash a single GPU with concurrent runs.
  const ownerChain: Record<string, Promise<void> | undefined> = {};
  const startSub = (i: number): Promise<void> => {
    const c = created[i];
    if (!c.ok || c.deferred) return Promise.resolve();
    const backDeps = (list[i].dependsOn || []).filter((d) => d >= 0 && d < i);
    if (backDeps.some((d) => !created[d]?.ok || created[d]?.deferred)) { c.dispatched = false; return Promise.resolve(); } // prereq never created or manager-queued
    const deps = backDeps.map((d) => done[d]).filter(Boolean); // each resolves on prereq COMPLETION
    const prevForOwner = ownerChain[c.agent];
    const waits = prevForOwner ? [...deps, prevForOwner] : deps;
    let markEnqueued: () => void = () => {};
    const enqueued = new Promise<void>((resolve) => { markEnqueued = resolve; });
    if (!waits.length) initialEnqueues.push(enqueued);
    const p = Promise.allSettled(waits).then(async () => {
      try {
        await enqueueBudgeted(client, `/ask ${c.agent} ${qArg(WORK_PROMPT(objective, list[i], c.ref))}`, 'work:createPlan:task-dispatch');
        c.dispatched = true;
      } catch (e) {
        c.dispatched = false;
        c.error = `dispatch failed: ${e instanceof Error ? e.message : String(e)}`;
        return;
      } finally {
        markEnqueued();
      }
      // Hold this task's done-promise open until the task itself finishes — that's what gates
      // its dependents (and its owner's next task).
      await waitForTaskDone(c.ref);
    });
    ownerChain[c.agent] = p; // the owner's next task waits for THIS one to complete
    return p;
  };
  for (let i = 0; i < list.length; i++) done[i] = startSub(i);
  // Fire-and-forget: the fleet runs in the background; swallow to avoid unhandled rejections.
  void Promise.allSettled(done);
  await Promise.allSettled(initialEnqueues);

  const ok = created.filter((c) => c.ok);
  const runnable = ok.filter((c) => !c.deferred);
  const dispatched = runnable.filter((c) => c.dispatched).length;
  const capacityDeferred = created.filter((c) => !c.ok && c.deferred).length;
  return { created, dispatched, deferred: ok.length - dispatched + capacityDeferred };
}

// ---- Plan/objective delegation to team leads ------------------------------

/**
 * Turn one high-level objective into a bounded set of live, assigned team-lead
 * tasks. This is the explicit Plans/Goals path: it does not rely on background
 * Autopilot, and it returns capacity/decomposition failures to the caller so the
 * UI can surface them as Inbox blockers.
 */
export async function delegateObjectiveToTeamLeads(
  baseClient: ManagerClient,
  objective: string,
  opts: TeamLeadDelegationOptions = {},
): Promise<TeamLeadDelegationResult> {
  const obj = String(objective || '').trim();
  const errors: string[] = [];
  const created: TeamLeadDelegatedTask[] = [];
  if (!obj) {
    return { ok: false, targetCount: 0, subtasks: [], created, dispatched: 0, deferred: 0, errors: ['describe the objective first'] };
  }

  const currentTeam = opts.currentTeam || baseClient.team || 'default';
  const plannerClient = currentTeam === baseClient.team ? baseClient : baseClient.withTeam(currentTeam);
  const targets = await resolveActiveTeamLeadTargets(baseClient, currentTeam);
  if (!targets.length) {
    return { ok: false, targetCount: 0, subtasks: [], created, dispatched: 0, deferred: 0, errors: ['no active non-default team leads available'] };
  }

  const plannerRoster = await plannerClient.agents().catch(() => [] as Agent[]);
  const primaryLead = opts.primaryLead || pickActiveLead(plannerRoster) || '';
  if (!primaryLead) {
    return { ok: false, targetCount: targets.length, subtasks: [], created, dispatched: 0, deferred: 0, errors: [`no active planning lead available on ${currentTeam}`] };
  }

  const leadRoster = targets.map((target) => ({
    name: target.lead,
    runtime: target.runtime,
    status: target.status,
    skills: target.skills,
  }));
  const decomp = await decomposeWork(plannerClient, obj, primaryLead, leadRoster);
  let subtasks = decomp.subtasks;
  if (!decomp.ok || !subtasks.length) {
    const reason = decomp.error || 'no team-lead subtasks produced';
    subtasks = deterministicTeamLeadSubtasks(obj, targets);
    errors.push(`planner decomposition failed; used deterministic team-lead fallback (${reason})`);
  }

  const byTeam = new Map<string, Array<{ globalIndex: number; target: TeamLeadDelegationTarget; st: SubTask }>>();
  subtasks.forEach((st, index) => {
    const target = teamLeadTargetForSubtask(targets, st, index);
    const rows = byTeam.get(target.team) ?? [];
    rows.push({ globalIndex: index, target, st });
    byTeam.set(target.team, rows);
  });

  let dispatched = 0;
  let deferred = 0;
  await Promise.all([...byTeam].map(async ([team, rows]) => {
    const target = rows[0]?.target;
    if (!target) return;
    const localIndex = new Map(rows.map((row, index) => [row.globalIndex, index]));
    const batch = rows.map((row) => {
      const packet = teamLeadPacket(row.target, row.st);
      return {
        ...packet,
        dependsOn: (row.st.dependsOn || []).filter((dep) => localIndex.has(dep)).map((dep) => localIndex.get(dep) as number),
      };
    });
    try {
      const result = await createAndDispatchPlan(baseClient.withTeam(team), obj, batch, {
        dispatch: true,
        respectOwners: true,
        allowCoordinatorOwners: true,
      });
      dispatched += result.dispatched;
      deferred += result.deferred;
      for (const task of result.created) {
        created.push({ ...task, team, lead: target.lead });
        if (!task.ok) {
          const reason = task.error || task.warning || `task ${task.title || task.ref} was not created`;
          if (reason) errors.push(`${team}/${target.lead}: ${reason}`);
        } else if (warningNeedsTriage(task.warning)) {
          errors.push(`${team}/${target.lead}: ${task.warning}`);
        }
      }
    } catch (e) {
      errors.push(`${team}/${target.lead}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));

  return {
    ok: created.some((task) => task.ok),
    targetCount: targets.length,
    subtasks,
    created,
    dispatched,
    deferred,
    errors,
    raw: decomp.raw,
  };
}

// ---- Cross-team fan-out -------------------------------------------------

export interface TeamLead { team: string; lead: string | null; activeCount: number; totalCount: number }
export interface FanoutResult { team: string; lead?: string; status: 'dispatched' | 'deferred' | 'no-active-agent' | 'failed'; queryId?: string; detail?: string }

/** For each team, report its active lead + how many agents are running. Drives the
 *  fan-out picker so the UI can show which teams can actually take work right now. */
export async function teamLeads(client: ManagerClient, teams: string[]): Promise<TeamLead[]> {
  const uniq = [...new Set((teams || []).map((t) => String(t).trim()).filter(Boolean))];
  return Promise.all(
    uniq.map(async (team): Promise<TeamLead> => {
      const agents = (await client.withTeam(team).agents().catch(() => [])) as Agent[];
      const activeCount = agents.filter((a) => isActiveStatus(a.status)).length;
      return { team, lead: pickActiveLead(agents), activeCount, totalCount: agents.length };
    }),
  );
}

const FANOUT_PROMPT = (objective: string, team: string) =>
  `You are the lead of the "${team}" team. Take ownership of this objective for your team and drive it to completion:

${objective}

How to run it:
1. Break it into concrete, independently-actionable tasks for your ACTIVE teammates (skip anyone stopped).
2. Create each as a real task with dispatch-ready metadata: /task create "<short title>" --owner <teammate> --description "<what to do + expected output>" --goal "<goal id from objective, or goal_manual_dispatch>" --expected-output "<artifact or result>" --acceptance "<how to verify done>" --validation-path "coder and researcher review substantial work" --out-of-scope "<what not to do>" --backlog-policy "Non-required recommendations become backlog candidates." --bittrees-relevance "medium: improves managed-agent throughput and contributor readiness for Bittrees-related work."
3. Dispatch the work, coordinate, and keep task status updated as things progress.
4. Other teams are handling their own slices in parallel — own yours end to end.

Reply with a short summary of the tasks you created and who you assigned each to.`;

/**
 * Fan a single objective out across multiple teams. For each team we resolve its
 * ACTIVE lead and hand the objective to that lead scoped to its own team (so the
 * teams work in parallel). We confirm the manager accepted each dispatch (queryId)
 * but DON'T poll to completion — the leads run in the background, like
 * createAndDispatchPlan. Teams with no running agent are reported 'no-active-agent'
 * and never dispatched into the void.
 */
export async function fanOutObjective(client: ManagerClient, objective: string, teams: string[]): Promise<FanoutResult[]> {
  const obj = (objective || '').trim();
  const uniq = [...new Set((teams || []).map((t) => String(t).trim()).filter(Boolean))];
  if (!obj) return uniq.map((team) => ({ team, status: 'failed' as const, detail: 'describe the work first' }));
  return Promise.all(
    uniq.map(async (team): Promise<FanoutResult> => {
      try {
        const tc = client.withTeam(team);
        const agents = (await tc.agents().catch(() => [])) as Agent[];
        const lead = pickActiveLead(agents);
        if (!lead) return { team, status: 'no-active-agent', detail: agents.length ? `${agents.length} agent(s), none running` : 'no agents' };
        const guard = await guardLeadQueue(tc, lead, 'fan-out');
        if (!guard.ok) return { team, lead, status: 'deferred', detail: guard.detail };
        const env = await remoteBudgeted<{ queryId?: string }>(tc, `/ask ${lead} ${qArg(FANOUT_PROMPT(obj, team))}`, 'work:fanout');
        recordLeadDispatch(tc, lead, env.result?.queryId, 'work:fanout');
        return { team, lead, status: 'dispatched', queryId: env.result?.queryId };
      } catch (e) {
        return { team, status: 'failed', detail: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

// ---- Lead triage of unassigned To-Do tasks --------------------------------

export interface TriageResult { considered: number; assigned: { ref: string; agent: string }[]; skipped: number; dispatched: number; error?: string }

function statusCol(status: string): 'todo' | 'doing' | 'done' {
  if (/done|complete/i.test(status)) return 'done';
  if (/doing|claim|progress|start|active/i.test(status)) return 'doing';
  return 'todo';
}

const TRIAGE_PROMPT = (taskLines: string, agentLines: string) =>
  `You are the team lead. Assign each UNASSIGNED to-do task below to the best-suited ACTIVE agent on your team.

Tasks (ref :: title — description):
${taskLines}

Active agents:
${agentLines}

Return ONLY a JSON array (no prose, no markdown fence): [{"ref":"<task ref EXACTLY as given>","agent":"<one of the active agent names above>"}]
Rules:
- Assign EVERY task to exactly one ACTIVE agent; never assign one marked [STOPPED].
- Do not assign to yourself/the coordinator when another active assignee is available.
- Match each task to the agent whose role/skills fit best; spread load sensibly across agents.`;

const TRIAGE_WORK = (ref: string, title: string, desc: string) =>
  `You've been assigned task ${ref}: ${title}
${desc ? desc + '\n' : ''}Do this task now. When finished, mark it done with: /task done ${ref} --acceptance "completed the assigned scope; evidence is in my reply"
If you cannot complete it, mark it done with: /task done ${ref} --failure-note "<why this task could not be completed>".`;

/**
 * Have the team lead triage UNASSIGNED tasks that are sitting in the To-Do lane
 * (status=todo, no owner; Backlog/Holding waiting-lanes are intentionally skipped),
 * assign each to the best-fit ACTIVE agent, and dispatch the work (fire-and-forget,
 * background — like createAndDispatchPlan). Returns once assignments are made.
 */
export async function triageUnassigned(client: ManagerClient, lead: string, opts: { dispatch?: boolean } = {}): Promise<TriageResult> {
  const dispatch = opts.dispatch !== false;
  const [tasks, roster] = await Promise.all([
    client.tasksByStatus('todo').catch(() => [] as Task[]),
    client.agents().catch(() => [] as Agent[]) as Promise<Agent[]>,
  ]);
  const coordinator = pickActiveLead(roster) ?? lead;
  const active = executionPoolForTeam(roster, coordinator, client.team).filter((a) => isActiveStatus(a.status));
  const activeNames = new Set(active.map((a) => a.name));
  // Skip the waiting lanes (Backlog/Holding) — only triage the To-Do lane. Lanes are an
  // app-side overlay; a todo-status task with no overlay defaults to the To-Do lane.
  const lanes = (loadSettings().taskLanes ?? {}) as Record<string, string>;
  const unassigned = tasks.filter((t) => {
    if (t.ownerName) return false;
    if (statusCol(t.status) !== 'todo') return false;
    const lane = lanes[taskRef(t)];
    return !lane || lane === 'todo';
  });
  if (!unassigned.length) return { considered: 0, assigned: [], skipped: 0, dispatched: 0 };
  if (!active.length) return { considered: unassigned.length, assigned: [], skipped: unassigned.length, dispatched: 0, error: 'no active agents to assign to' };

  const byRef = new Map(unassigned.map((t) => [taskRef(t), t]));
  const taskLines = unassigned.map((t) => `- ${taskRef(t)} :: ${clip(t.title, 100)}${t.description ? ' — ' + clip(t.description, 140) : ''}`).join('\n');
  const agentLines = active.map((a) => {
    const skills = Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [];
    return `- ${a.name}${a.runtime ? ` (${a.runtime})` : ''}${skills.length ? ` — skills: ${skills.slice(0, 6).join(', ')}` : ''}`;
  }).join('\n');

  let raw = '';
  try { raw = await dispatchBudgeted(client, `/ask ${lead} ${qArg(TRIAGE_PROMPT(taskLines, agentLines))}`, 'work:triage'); }
  catch (e) { return { considered: unassigned.length, assigned: [], skipped: unassigned.length, dispatched: 0, error: e instanceof Error ? e.message : String(e) }; }

  const planned = new Map<string, string>(); // ref → agent (validated, active)
  for (const o of extractJsonArray(raw) ?? []) {
    const rec = (o ?? {}) as Record<string, unknown>;
    const ref = String(rec.ref ?? rec.task ?? '').trim();
    let agent = String(rec.agent ?? rec.owner ?? '').trim();
    if (!byRef.has(ref) || planned.has(ref)) continue;
    if (!activeNames.has(agent)) agent = active[0].name; // coerce to an active agent
    planned.set(ref, agent);
  }
  // Round-robin any tasks the model didn't cover onto active agents (none left behind).
  let i = 0;
  for (const ref of byRef.keys()) {
    if (!planned.has(ref)) { planned.set(ref, active[i % active.length].name); i++; }
  }
  // Spread so no agent gets a pile — best-fit up to a cap, overflow to the least-loaded.
  const plan = [...planned].map(([ref, agent]) => ({ ref, agent }));
  balanceOwners(plan, [...activeNames]);

  // Assign owners (sets the owner DB row; manager moves owned → doing).
  const assigned: { ref: string; agent: string }[] = [];
  for (const { ref, agent } of plan) {
    try { await client.remote(`/task assign ${ref} ${agent}`); assigned.push({ ref, agent }); }
    catch { /* skip this one; keep going */ }
  }
  // Dispatch in the background — but ONE in-flight /ask per owner (sequential per agent) so we
  // never overload a single agent with concurrent work.
  let dispatched = 0;
  if (dispatch) {
    const ownerChain: Record<string, Promise<void> | undefined> = {};
    for (const { ref, agent } of assigned) {
      const t = byRef.get(ref);
      if (!t) continue;
      dispatched++;
      const prev = ownerChain[agent] ?? Promise.resolve();
      ownerChain[agent] = prev.then(() => enqueueBudgeted(client, `/ask ${agent} ${qArg(TRIAGE_WORK(ref, t.title, clip(t.description ?? '', 400)))}`, 'work:triage:task-dispatch').then(() => {}, () => {}));
    }
  }
  return { considered: unassigned.length, assigned, skipped: unassigned.length - assigned.length, dispatched };
}
