/**
 * Disabled-by-default background driver for active Goals.
 *
 * Global `goalDriver.enabled` and per-goal `autopilot` must both be true before
 * anything can spawn. The loop is single-flight and best-effort: errors are
 * logged and recorded on the goal, never allowed to crash the app.
 */

import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { createAndDispatchPlan, decomposeWork, isActiveStatus, type SubTask } from './work.ts';
import { getGoal, listGoals, saveGoal, type Goal } from './goalstore.ts';

export interface GoalDriverConfig {
  enabled: boolean;
  cadenceMs: number;
  maxOpenTasksPerGoal: number;
}

export interface GoalDriverSummary {
  enabled: boolean;
  consideredGoals: number;
  drivenGoals: number;
  tasksSpawned: number;
  teamsSynced: number;
  errors: string[];
}

export const GOAL_DRIVER_DEFAULTS: GoalDriverConfig = {
  enabled: false,
  cadenceMs: 30 * 60 * 1000,
  maxOpenTasksPerGoal: 3,
};

export function normalizeGoalDriverConfig(input?: Partial<GoalDriverConfig> | null): GoalDriverConfig {
  return {
    enabled: input?.enabled === true,
    cadenceMs: Number.isFinite(input?.cadenceMs) && Number(input?.cadenceMs) > 0 ? Math.floor(Number(input!.cadenceMs)) : GOAL_DRIVER_DEFAULTS.cadenceMs,
    maxOpenTasksPerGoal: Number.isFinite(input?.maxOpenTasksPerGoal) && Number(input?.maxOpenTasksPerGoal) > 0
      ? Math.floor(Number(input!.maxOpenTasksPerGoal))
      : GOAL_DRIVER_DEFAULTS.maxOpenTasksPerGoal,
  };
}

export function goalTaskTag(goalId: string): string {
  return `[goal:${goalId}]`;
}

export function taskBelongsToGoal(task: Task, goalId: string): boolean {
  const tag = goalTaskTag(goalId);
  return [task.title, task.description, task.shortId, task.name, task.uuid].some((v) => String(v ?? '').includes(tag));
}

function taskDone(t: Task): boolean {
  return /done|complete/i.test(t.status ?? '');
}

function taskRef(t: Task): string {
  return t.shortId ?? t.name ?? t.uuid ?? t.title;
}

function pickActiveLead(agents: Pick<Agent, 'name' | 'status'>[]): string | null {
  const active = agents.filter((a) => isActiveStatus(a.status));
  if (!active.length) return null;
  return (
    active.find((a) => /(^|[-_ ])lead$/i.test(a.name)) ??
    active.find((a) => /lead/i.test(a.name)) ??
    active.find((a) => /manager|coordinator/i.test(a.name)) ??
    active[0]
  ).name;
}

function clip(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function activeAutopilotGoals(): Goal[] {
  return listGoals()
    .map((g) => getGoal(g.id))
    .filter((g): g is Goal => !!g && g.status === 'active' && g.autopilot === true);
}

function teamGoalInstructions(team: string, goals: Goal[]): string {
  if (!goals.length) return '';
  const lines = goals.map((g) => `- ${g.title || g.id} (${g.id}): ${clip(g.content || g.idea || '', 220)}`);
  return [
    '## Active autopilot goals',
    '',
    `Keep this team's work aligned with these active operator goals:`,
    ...lines,
  ].join('\n');
}

async function syncTeamGoalInstructions(client: ManagerClient, goals: Goal[], errors: string[]): Promise<number> {
  const teams = new Set<string>();
  for (const g of goals) if (g.team) teams.add(g.team);
  for (const t of await client.teams().catch(() => [])) if (t.name) teams.add(t.name);
  if (!teams.size) teams.add(client.team ?? 'default');

  let ok = 0;
  for (const team of teams) {
    try {
      const teamGoals = goals.filter((g) => g.team === team);
      const wrote = await brain.memory('team-instructions', {
        key: `goals:autopilot:${team}`,
        content: teamGoalInstructions(team, teamGoals),
        tags: ['team-instruction', 'goals', 'autopilot'],
        shared: true,
        project: team,
      });
      if (wrote) ok++;
    } catch (e) {
      errors.push(`team ${team}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok;
}

function annotateSubtask(goal: Goal, st: SubTask): SubTask {
  const tag = goalTaskTag(goal.id);
  return {
    ...st,
    description: `${tag}\nGoal: ${goal.title || goal.id} (${goal.id})\n\n${st.description ?? ''}`.trim(),
  };
}

async function driveGoal(baseClient: ManagerClient, goal: Goal, cfg: GoalDriverConfig): Promise<{ spawned: number; refs: string[]; note: string }> {
  const teamClient = baseClient.withTeam(goal.team);
  const tasks = await teamClient.tasks().catch(() => [] as Task[]);
  const openTagged = tasks.filter((t) => taskBelongsToGoal(t, goal.id) && !taskDone(t));
  const openRefs = openTagged.map(taskRef).filter(Boolean);
  const slots = Math.max(0, cfg.maxOpenTasksPerGoal - openTagged.length);
  if (slots <= 0) return { spawned: 0, refs: openRefs, note: `open task cap reached (${openTagged.length}/${cfg.maxOpenTasksPerGoal})` };
  if (openTagged.length > 0) return { spawned: 0, refs: openRefs, note: `waiting on ${openTagged.length} open goal task(s)` };

  const agents = await teamClient.agents().catch(() => [] as Agent[]);
  const lead = pickActiveLead(agents);
  if (!lead) return { spawned: 0, refs: [], note: 'no active lead available' };

  const roster = agents.map((a) => ({
    name: a.name,
    runtime: a.runtime,
    status: a.status,
    skills: Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [],
  }));
  const decomp = await decomposeWork(teamClient, goal.content || goal.idea || goal.title, lead, roster);
  if (!decomp.ok || !decomp.subtasks.length) return { spawned: 0, refs: [], note: decomp.error || 'no subtasks produced' };

  const subtasks = decomp.subtasks.slice(0, slots).map((st) => annotateSubtask(goal, st));
  const created = await createAndDispatchPlan(teamClient, goal.content || goal.title, subtasks, { dispatch: true });
  const ok = created.created.filter((t) => t.ok);
  return {
    spawned: ok.length,
    refs: ok.map((t) => t.ref).filter(Boolean),
    note: ok.length ? `spawned ${ok.length} task(s)` : 'no tasks created',
  };
}

export async function runGoalDriverOnce(getClient: () => ManagerClient, rawCfg: Partial<GoalDriverConfig> = {}): Promise<GoalDriverSummary> {
  const cfg = normalizeGoalDriverConfig(rawCfg);
  const summary: GoalDriverSummary = { enabled: cfg.enabled, consideredGoals: 0, drivenGoals: 0, tasksSpawned: 0, teamsSynced: 0, errors: [] };
  if (!cfg.enabled) return summary;

  const client = getClient();
  const goals = activeAutopilotGoals();
  summary.consideredGoals = goals.length;
  summary.teamsSynced = await syncTeamGoalInstructions(client, goals, summary.errors);

  for (const goal of goals) {
    try {
      const result = await driveGoal(client, goal, cfg);
      summary.drivenGoals++;
      summary.tasksSpawned += result.spawned;
      saveGoal({
        ...goal,
        driver: {
          lastRunAt: Date.now(),
          taskRefs: result.refs,
          note: result.note,
        },
      });
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${goal.id}: ${note}`);
      try {
        saveGoal({ ...goal, driver: { ...(goal.driver ?? {}), lastRunAt: Date.now(), note } });
      } catch {
        /* best-effort */
      }
    }
  }

  return summary;
}

export function startGoalDriverLoop(getClient: () => ManagerClient, getCfg: () => Partial<GoalDriverConfig>): () => void {
  let stopped = false;
  let running = false;
  let lastRunAt = 0;

  const tick = async () => {
    if (stopped || running) return;
    const cfg = normalizeGoalDriverConfig(getCfg());
    if (!cfg.enabled) return;
    const now = Date.now();
    if (now - lastRunAt < cfg.cadenceMs) return;
    running = true;
    lastRunAt = now;
    try {
      const summary = await runGoalDriverOnce(getClient, cfg);
      if (summary.tasksSpawned || summary.errors.length) console.log('[goaldriver]', summary);
    } catch (e) {
      console.warn('[goaldriver] run failed:', e);
    } finally {
      running = false;
    }
  };

  const t0 = setTimeout(() => void tick(), 20_000);
  const iv = setInterval(() => void tick(), 60_000);
  (t0 as { unref?: () => void }).unref?.();
  (iv as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearTimeout(t0);
    clearInterval(iv);
  };
}
