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

export interface SubTask { title: string; description: string; agent: string; dependsOn: number[] }
export interface CreatedTask { idx: number; ref: string; title: string; agent: string; ok: boolean; error?: string; dependsOn: number[]; dispatched: boolean }
export interface DecomposeResult { ok: boolean; subtasks: SubTask[]; raw: string; error?: string }
export interface CreatePlanResult { created: CreatedTask[]; dispatched: number; deferred: number }

/** Quote a free-text argument as ONE token for the manager tokenizer (matches client qArg). */
function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

const MAX_SUBTASKS = 12;

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
- Maximize parallelism: use an empty dependsOn whenever a task does not truly need another task's output.
- Only add a dependency when a task genuinely needs a prior task's result.
- Keep titles short and imperative; assign realistic owners chosen from the agent names above.`;

/** Ask the lead to decompose the objective; parse + sanitize into sub-tasks. */
export async function decomposeWork(
  client: ManagerClient,
  objective: string,
  lead: string,
  agents: { name: string; runtime?: string; skills?: string[] }[],
): Promise<DecomposeResult> {
  const obj = (objective || '').trim();
  if (!obj) return { ok: false, subtasks: [], raw: '', error: 'describe the work first' };
  const names = new Set(agents.map((a) => a.name));
  const fallback = names.has(lead) ? lead : (agents[0]?.name ?? lead);
  const agentLines =
    agents.map((a) => `- ${a.name}${a.runtime ? ` (${a.runtime})` : ''}${a.skills?.length ? ` — skills: ${a.skills.slice(0, 6).join(', ')}` : ''}`).join('\n') ||
    `- ${fallback}`;

  let raw = '';
  try {
    raw = await client.dispatch(`/ask ${lead} ${qArg(DECOMP_PROMPT(obj, agentLines))}`);
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
    if (!names.has(agent)) agent = fallback;
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
): Promise<CreatePlanResult> {
  // Defense-in-depth: never trust the renderer's owner names for an outward-facing
  // fleet dispatch. Re-validate every owner against the live roster and coerce an
  // unknown one to a real agent (the first available). Also clamp deps in-range.
  const roster = await client.agents().catch(() => [] as { name: string }[]);
  const names = new Set(roster.map((a) => a.name));
  const fallback = roster[0]?.name ?? '';
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

  // 1) Create all tasks (assigned to their owner) — fast, synchronous-ish.
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    const cmd = `/task create ${qArg(st.title)} --owner ${st.agent}${st.description ? ` --description ${qArg(st.description)}` : ''}`;
    try {
      const env = await client.remote<{ task?: { shortId?: string; name?: string } }>(cmd);
      const task = env.result?.task;
      const ref = task?.shortId ?? task?.name ?? st.title;
      created.push({ idx: i, ref, title: st.title, agent: st.agent, ok: true, dependsOn: st.dependsOn, dispatched: false });
    } catch (e) {
      created.push({ idx: i, ref: st.title, title: st.title, agent: st.agent, ok: false, error: e instanceof Error ? e.message : String(e), dependsOn: st.dependsOn, dispatched: false });
    }
  }

  // 2) Background wave-dispatch. Each task waits on its backward deps' dispatches.
  // Only BACKWARD deps (index < self) chain → guaranteed DAG (no deadlock). If a
  // prerequisite failed to be created, its dependents are NOT released — they'd
  // otherwise run against output that never got produced.
  const done: Promise<void>[] = new Array(list.length);
  const startSub = (i: number): Promise<void> => {
    const c = created[i];
    if (!c.ok) return Promise.resolve();
    const backDeps = (list[i].dependsOn || []).filter((d) => d >= 0 && d < i);
    if (backDeps.some((d) => !created[d]?.ok)) { c.dispatched = false; return Promise.resolve(); } // prereq never created
    const deps = backDeps.map((d) => done[d]).filter(Boolean);
    return Promise.allSettled(deps).then(() => {
      c.dispatched = true;
      return client.dispatch(`/ask ${c.agent} ${qArg(WORK_PROMPT(objective, list[i], c.ref))}`).then(() => {}, () => {});
    });
  };
  for (let i = 0; i < list.length; i++) done[i] = startSub(i);
  // Fire-and-forget: the fleet runs in the background; swallow to avoid unhandled rejections.
  void Promise.allSettled(done);

  const ok = created.filter((c) => c.ok);
  const ready = ok.filter((c) => list[c.idx].dependsOn.filter((d) => d < c.idx).length === 0);
  return { created, dispatched: ready.length, deferred: ok.length - ready.length };
}
