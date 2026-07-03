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
export interface CreatedTask { idx: number; ref: string; title: string; agent: string; ok: boolean; error?: string; dependsOn: number[]; dispatched: boolean }
export interface DecomposeResult { ok: boolean; subtasks: SubTask[]; raw: string; error?: string }
export interface CreatePlanResult { created: CreatedTask[]; dispatched: number; deferred: number }

/** Quote a free-text argument as ONE token for the manager tokenizer (matches client qArg). */
function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function budgetedAskCommand(client: ManagerClient, command: string, source: string): string {
  return optimizeAskCommand(command, { source, team: client.team }).command;
}
function dispatchBudgeted(client: ManagerClient, command: string, source: string): Promise<string> {
  return client.dispatch(budgetedAskCommand(client, command, source));
}
function remoteBudgeted<T = unknown>(client: ManagerClient, command: string, source: string): Promise<RemoteEnvelope<T>> {
  return client.remote<T>(budgetedAskCommand(client, command, source));
}

/** A task is complete once the manager reports a done/complete status. */
function isTaskDone(status?: string): boolean { return /done|complete/i.test(status ?? ''); }

/** Every identifier a created task might be keyed by, so a dependent's stored ref
 *  matches the prerequisite regardless of which field the create call returned. */
function taskKeys(t: Task): string[] {
  return [t.shortId, t.name, t.uuid, t.title].filter(Boolean) as string[];
}
function clip(s: string, n: number): string { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

const MAX_SUBTASKS = 12;

/** An agent is routable only when it's actually running. Anything clearly
 *  stopped/offline/errored is skipped so work never dispatches into the void. */
export function isActiveStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  if (!s) return false;
  return !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}
/** Pick a team's coordinator among its ACTIVE agents: prefer a *-lead / manager
 *  name, else the first running agent. null when nothing is active. */
function pickActiveLead(agents: { name: string; status?: string }[]): string | null {
  const active = agents.filter((a) => isActiveStatus(a.status));
  if (!active.length) return null;
  return (
    active.find((a) => /(^|[-_ ])lead$/i.test(a.name)) ??
    active.find((a) => /lead/i.test(a.name)) ??
    active.find((a) => /manager|coordinator/i.test(a.name)) ??
    active[0]
  ).name;
}

function agentNameKey(name?: string): string {
  return String(name || '').trim().toLowerCase();
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
): T[] {
  const active = agents.filter((a) => isActiveStatus(a.status));
  const base = active.length ? active : agents;
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

const DECOMP_PROMPT = (objective: string, agentLines: string) =>
  `You are the team lead. Break the objective below into a small set of concrete, independently-actionable sub-tasks for your fleet, and assign each to the best-suited agent.

Objective: ${objective}

Available agents:
${agentLines}

Return ONLY a JSON array (no prose, no markdown fence) of up to ${MAX_SUBTASKS} objects with this exact shape:
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
  const agentLines =
    agents.map((a) => agentLine(a, lead, assignableNames, client.team)).join('\n') ||
    `- ${fallback}`;

  let raw = '';
  try {
    raw = await dispatchBudgeted(client, `/ask ${lead} ${qArg(DECOMP_PROMPT(obj, agentLines))}`, 'work:decompose');
  } catch (e) {
    return { ok: false, subtasks: [], raw: '', error: e instanceof Error ? e.message : String(e) };
  }
  if (!raw || raw === '(empty reply)' || raw === '(no reply)') return { ok: false, subtasks: [], raw, error: 'the lead returned an empty reply — try again' };

  const arr = extractJsonArray(raw);
  if (!arr) return { ok: false, subtasks: [], raw, error: 'could not parse a task list from the reply' };

  const n = Math.min(arr.length, MAX_SUBTASKS);
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
Do this task now. When finished, mark it done with: /task done ${ref}
If you cannot complete it, still mark it done with a brief failure note.`;

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
  opts: { dispatch?: boolean; lane?: string; respectOwners?: boolean } = {},
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
  const coordinator = pickActiveLead(roster) ?? '';
  const pool = executionPoolForTeam(roster, coordinator, client.team);
  const names = new Set(pool.map((a) => a.name));
  const fallback = pool[0]?.name ?? '';
  const list = subtasks.slice(0, MAX_SUBTASKS).map((st, i, arr) => ({
    title: clip(String(st?.title ?? `Task ${i + 1}`), 120) || `Task ${i + 1}`,
    description: clip(String(st?.description ?? ''), 400),
    agent: names.has(st?.agent) ? st.agent : fallback,
    dependsOn: (Array.isArray(st?.dependsOn) ? st.dependsOn : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d < arr.length && d !== i),
  }));
  const created: CreatedTask[] = [];
  if (!fallback) return { created, dispatched: 0, deferred: 0 }; // no agents → nothing to dispatch
  // Don't pile every task on one agent - spread across the active roster (best-fit up to a cap).
  // respectOwners=true keeps explicit execution owners, but still blocks coordinator/validator bypasses.
  if (!opts.respectOwners) balanceOwners(list, [...names]);

  // 1) Create all tasks (assigned to their owner) — fast, synchronous-ish.
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    // Dispatching: assign the owner now (manager sets owned→doing). Queuing: create
    // unowned (stays todo) and record the lead's suggested owner in the description.
    const desc = dispatch ? st.description : `${st.description}${st.description ? '\n\n' : ''}(suggested owner: ${st.agent})`.trim();
    const cmd = `/task create ${qArg(st.title)}${dispatch ? ` --owner ${st.agent}` : ''}${desc ? ` --description ${qArg(desc)}` : ''}`;
    try {
      const env = await client.remote<{ task?: { shortId?: string; name?: string } }>(cmd);
      const task = env.result?.task;
      const ref = task?.shortId ?? task?.name ?? st.title;
      if (opts.lane && ref) { try { setTaskLane(ref, opts.lane); } catch { /* overlay is best-effort */ } }
      created.push({ idx: i, ref, title: st.title, agent: st.agent, ok: true, dependsOn: st.dependsOn, dispatched: false });
    } catch (e) {
      created.push({ idx: i, ref: st.title, title: st.title, agent: st.agent, ok: false, error: e instanceof Error ? e.message : String(e), dependsOn: st.dependsOn, dispatched: false });
    }
  }

  // Persist the dependency graph app-side (the manager has no deps field) so the board
  // can surface "blocked by …". Map each task's backward dep indices → the created refs.
  try {
    for (let i = 0; i < created.length; i++) {
      const c = created[i];
      if (!c.ok) continue;
      const refs = (list[i].dependsOn || [])
        .filter((d) => d >= 0 && d < created.length && created[d]?.ok)
        .map((d) => created[d].ref);
      if (refs.length) setTaskDeps(c.ref, refs);
    }
  } catch { /* overlay is best-effort */ }

  // Queue-only: tasks created in the lane, not farmed out — the lead works them later.
  if (!dispatch) return { created, dispatched: 0, deferred: created.filter((c) => c.ok).length };

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
    const snap = await client.tasks().catch(() => [] as Task[]);
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
  // One in-flight task per OWNER: an agent works (and finishes) its tasks one at a time. This
  // also serializes local-model agents so they never thrash a single GPU with concurrent runs.
  const ownerChain: Record<string, Promise<void> | undefined> = {};
  const startSub = (i: number): Promise<void> => {
    const c = created[i];
    if (!c.ok) return Promise.resolve();
    const backDeps = (list[i].dependsOn || []).filter((d) => d >= 0 && d < i);
    if (backDeps.some((d) => !created[d]?.ok)) { c.dispatched = false; return Promise.resolve(); } // prereq never created
    const deps = backDeps.map((d) => done[d]).filter(Boolean); // each resolves on prereq COMPLETION
    const prevForOwner = ownerChain[c.agent];
    const waits = prevForOwner ? [...deps, prevForOwner] : deps;
    const p = Promise.allSettled(waits).then(async () => {
      c.dispatched = true;
      await dispatchBudgeted(client, `/ask ${c.agent} ${qArg(WORK_PROMPT(objective, list[i], c.ref))}`, 'work:createPlan:task-dispatch').then(() => {}, () => {});
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

  const ok = created.filter((c) => c.ok);
  const ready = ok.filter((c) => list[c.idx].dependsOn.filter((d) => d < c.idx).length === 0);
  return { created, dispatched: ready.length, deferred: ok.length - ready.length };
}

// ---- Cross-team fan-out -------------------------------------------------

export interface TeamLead { team: string; lead: string | null; activeCount: number; totalCount: number }
export interface FanoutResult { team: string; lead?: string; status: 'dispatched' | 'no-active-agent' | 'failed'; queryId?: string; detail?: string }

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
2. Create each as a real task: /task create "<short title>" --owner <teammate> --description "<what to do + expected output>".
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
        const env = await remoteBudgeted<{ queryId?: string }>(tc, `/ask ${lead} ${qArg(FANOUT_PROMPT(obj, team))}`, 'work:fanout');
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
function taskRef(t: Task): string { return t.shortId ?? t.name ?? t.uuid ?? t.title; }

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
${desc ? desc + '\n' : ''}Do this task now. When finished, mark it done with: /task done ${ref}
If you cannot complete it, still mark it done with a brief failure note.`;

/**
 * Have the team lead triage UNASSIGNED tasks that are sitting in the To-Do lane
 * (status=todo, no owner; Backlog/Holding waiting-lanes are intentionally skipped),
 * assign each to the best-fit ACTIVE agent, and dispatch the work (fire-and-forget,
 * background — like createAndDispatchPlan). Returns once assignments are made.
 */
export async function triageUnassigned(client: ManagerClient, lead: string, opts: { dispatch?: boolean } = {}): Promise<TriageResult> {
  const dispatch = opts.dispatch !== false;
  const [tasks, roster] = await Promise.all([
    client.tasks().catch(() => [] as Task[]),
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
      ownerChain[agent] = prev.then(() => dispatchBudgeted(client, `/ask ${agent} ${qArg(TRIAGE_WORK(ref, t.title, clip(t.description ?? '', 400)))}`, 'work:triage:task-dispatch').then(() => {}, () => {}));
    }
  }
  return { considered: unassigned.length, assigned, skipped: unassigned.length - assigned.length, dispatched };
}
