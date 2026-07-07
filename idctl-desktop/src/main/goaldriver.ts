/**
 * Background driver for active Goals.
 *
 * Global `goalDriver.enabled` defaults on, but per-goal `autopilot` must also
 * be true before anything can spawn. The loop is single-flight and best-effort:
 * errors are logged and recorded on the goal, never allowed to crash the app.
 */

import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { createAndDispatchPlan, decomposeWork, isActiveStatus, type SubTask } from './work.ts';
import { getGoal, goalPriorityRank, listGoals, normalizeGoalPriority, saveGoal, type Goal } from './goalstore.ts';

const GOAL_LEAD_OWNER_OPEN_TASK_CAP = 4;

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

interface GoalLeadTarget {
  team: string;
  lead: string;
  runtime?: string;
  status?: string;
  skills: string[];
}

export const GOAL_DRIVER_DEFAULTS: GoalDriverConfig = {
  enabled: true,
  cadenceMs: 15 * 60 * 1000,
  maxOpenTasksPerGoal: 8,
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

async function openTasksForTeam(client: ManagerClient): Promise<Task[]> {
  const [todo, doing] = await Promise.all([
    client.tasksByStatus('todo').catch(() => [] as Task[]),
    client.tasksByStatus('doing').catch(() => [] as Task[]),
  ]);
  return [...todo, ...doing];
}

async function tasksForGoalScope(baseClient: ManagerClient, goalTeam: string): Promise<Task[]> {
  if (goalTeam && goalTeam !== 'default') {
    return openTasksForTeam(baseClient.withTeam(goalTeam));
  }
  const teams = await baseClient.teams().catch(() => []);
  const teamNames = teams.length ? teams.map((team) => team.name).filter(Boolean) : [baseClient.team ?? 'default'];
  const rows = await Promise.all(
    Array.from(new Set(teamNames)).map((team) => openTasksForTeam(baseClient.withTeam(team))),
  );
  return rows.flat();
}

function agentNameKey(name?: string): string {
  return String(name || '').trim().toLowerCase();
}

function roleText(a: Pick<Agent, 'metadata'>): string {
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

function roleNameText(a: Pick<Agent, 'metadata'>): string {
  const meta = a.metadata && typeof a.metadata === 'object' ? a.metadata as Record<string, unknown> : {};
  const catalog = meta.catalog && typeof meta.catalog === 'object' ? meta.catalog as Record<string, unknown> : {};
  return [meta.role, catalog.role].map((v) => String(v || '').toLowerCase()).join('\n');
}

function leadRank(a: Pick<Agent, 'name' | 'metadata'>): number {
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

function pickActiveLead(agents: Pick<Agent, 'name' | 'status' | 'metadata'>[]): string | null {
  const active = agents.filter((a) => isActiveStatus(a.status));
  if (!active.length) return null;
  return active
    .slice()
    .sort((a, b) => leadRank(a) - leadRank(b) || a.name.localeCompare(b.name))[0].name;
}

function isWakeableGoalLeadStatus(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !/dead|exit|error|crash|down|disabled/.test(s);
}

function pickWakeableLead(agents: Pick<Agent, 'name' | 'status' | 'metadata'>[]): string | null {
  return agents
    .filter((a) => isWakeableGoalLeadStatus(a.status))
    .slice()
    .sort((a, b) =>
      leadRank(a) - leadRank(b)
      || Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status))
      || a.name.localeCompare(b.name),
    )[0]?.name
    ?? null;
}

function isDefaultValidator(name: string): boolean {
  return /^(coder|researcher)$/i.test(name.trim());
}

async function resolveGoalLeadTargets(baseClient: ManagerClient, goalTeam?: string): Promise<GoalLeadTarget[]> {
  const currentTeam = goalTeam || baseClient.team || 'default';
  const teams = await baseClient.teams().catch(() => []);
  const candidates = teams.filter((team) => team.name && team.name !== currentTeam && team.name !== 'default');
  const targets = await Promise.all(
    candidates.map(async (team): Promise<GoalLeadTarget | null> => {
      const agents = await baseClient.withTeam(team.name).agents().catch(() => [] as Agent[]);
      const leadName = pickWakeableLead(agents);
      if (!leadName || isDefaultValidator(leadName)) return null;
      const lead = agents.find((agent) => agent.name === leadName);
      return {
        team: team.name,
        lead: leadName,
        runtime: lead?.runtime,
        status: lead?.status,
        skills: Array.isArray(lead?.metadata?.skills) ? (lead!.metadata!.skills as string[]) : [],
      };
    }),
  );
  return targets.filter((target): target is GoalLeadTarget => !!target);
}

function clip(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function activeAutopilotGoals(): Goal[] {
  return listGoals()
    .map((g) => getGoal(g.id))
    .filter((g): g is Goal => !!g && g.status === 'active' && g.autopilot === true)
    .sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt);
}

function activeWorkGoals(): Goal[] {
  return listGoals()
    .map((g) => getGoal(g.id))
    .filter((g): g is Goal => !!g && g.status === 'active')
    .sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt);
}

function goalDriverStamp(goal: Goal): string {
  return [
    goal.id,
    goal.team,
    goal.status,
    normalizeGoalPriority(goal.priority),
    goal.autopilot ? '1' : '0',
    goal.updatedAt,
    goal.title || '',
    goal.content || '',
    goal.idea || '',
  ].join('\u001f');
}

function goalListDriverStamp(goals: Goal[]): string {
  return [...goals].map(goalDriverStamp).sort().join('\u001e');
}

function freshActiveGoalForDriver(goal: Goal): Goal | null {
  const latest = getGoal(goal.id);
  if (!latest || latest.status !== 'active' || latest.autopilot !== true) return null;
  return goalDriverStamp(latest) === goalDriverStamp(goal) ? latest : null;
}

function saveGoalDriverMetadata(goalId: string, driver: NonNullable<Goal['driver']>): boolean {
  const latest = getGoal(goalId);
  if (!latest) return false;
  saveGoal({ ...latest, driver });
  return true;
}

function goalPriorityLabel(goal: Goal): string {
  const priority = normalizeGoalPriority(goal.priority);
  return priority === 'primary' ? 'Primary' : priority === 'secondary' ? 'Secondary' : 'General';
}

function teamGoalInstructions(team: string, goals: Goal[]): string {
  if (!goals.length) return '';
  const lines = goals
    .slice()
    .sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt)
    .map((g) => `- [${goalPriorityLabel(g)}] ${g.title || g.id} (${g.id}): ${clip(g.content || g.idea || '', 220)}`);
  return [
    '## Active autopilot goals',
    '',
    `Keep this team's work aligned with these active operator goals:`,
    ...lines,
  ].join('\n');
}

function teamActiveWorkGoalInstructions(team: string, goals: Goal[]): string {
  const lines = goals.slice().sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt).map((g) => {
    const owner = g.agent ? ` · agent: ${g.agent}` : '';
    return `- [${goalPriorityLabel(g)}] ${g.title || g.id} (${g.id}${owner}): ${clip(g.content || g.idea || '', 220)}`;
  });
  return [
    '## Active Work goals',
    '',
    lines.length
      ? `Keep this team's work aligned with these active Work goals:`
      : `No active Work goals are currently assigned to this team.`,
    ...lines,
  ].join('\n');
}

export async function syncActiveWorkGoalInstructions(client: ManagerClient): Promise<{ teamsSynced: number; activeGoals: number; errors: string[] }> {
  const goals = activeWorkGoals();
  const teams = new Set<string>();
  for (const g of goals) if (g.team) teams.add(g.team);
  for (const t of await client.teams().catch(() => [])) if (t.name) teams.add(t.name);
  if (!teams.size) teams.add(client.team ?? 'default');

  const errors: string[] = [];
  let teamsSynced = 0;
  for (const team of teams) {
    try {
      const teamGoals = goals.filter((g) => g.team === team);
      const wrote = await brain.memory('team-instructions', {
        key: `goals:active:${team}`,
        content: teamActiveWorkGoalInstructions(team, teamGoals),
        tags: ['team-instruction', 'goals', 'work'],
        shared: true,
        project: team,
      });
      if (wrote) teamsSynced++;
    } catch (e) {
      errors.push(`team ${team}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { teamsSynced, activeGoals: goals.length, errors };
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

function deterministicGoalLeadSubtasks(goal: Goal, targets: GoalLeadTarget[], slots: number, reason: string): SubTask[] {
  const usable = targets.slice(0, Math.max(1, Math.min(slots, targets.length)));
  return usable.map((target) => ({
    title: `Advance active goal: ${clip(goal.title || goal.id, 82)}`,
    description: [
      `Autopilot planner fallback: ${reason}`,
      `Active goal ${goal.id}: ${goal.title || goal.id}`,
      'Create only the minimal child tasks needed on your team, skip duplicate or already-covered work, and close with concrete evidence or blockers.',
      'Keep recommendations aligned to this active goal; optional follow-ups become backlog candidates instead of live work.',
    ].join('\n'),
    agent: target.lead,
    dependsOn: [],
  }));
}

function goalLeadTargetForSubtask(targets: GoalLeadTarget[], st: SubTask, index: number): GoalLeadTarget {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const agentKey = norm(st.agent || '');
  const exact = targets.find((target) => norm(target.lead) === agentKey || norm(target.team) === agentKey);
  if (exact) return exact;
  const hay = norm(`${st.agent} ${st.title} ${st.description}`);
  const hinted = targets.find((target) => hay.includes(norm(target.team)) || hay.includes(norm(target.lead)));
  return hinted ?? targets[index % targets.length];
}

async function createGoalLeadTasks(
  baseClient: ManagerClient,
  objective: string,
  subtasks: SubTask[],
  targets: GoalLeadTarget[],
): Promise<{ ok: number; refs: string[] }> {
  const byTeam = new Map<string, SubTask[]>();
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    const target = goalLeadTargetForSubtask(targets, st, i);
    const team = target.team;
    const list = byTeam.get(team) ?? [];
    list.push({
      ...st,
      agent: target.lead,
      description: st.agent && st.agent !== target.lead
        ? `${st.description ?? ''}\n\nAutopilot routed owner hint "${st.agent}" to ${target.team}/${target.lead}.`.trim()
        : st.description,
    });
    byTeam.set(team, list);
  }

  const results = await Promise.all(
    [...byTeam].map(async ([team, teamSubtasks]) =>
      createAndDispatchPlan(baseClient.withTeam(team), objective, teamSubtasks, {
        dispatch: true,
        respectOwners: true,
        allowCoordinatorOwners: true,
        allowInactiveOwners: true,
        ownerOpenTaskCap: GOAL_LEAD_OWNER_OPEN_TASK_CAP,
        coordinator: teamSubtasks[0]?.agent,
        leadCoordination: true,
      }).catch(() => ({ created: [], dispatched: 0, deferred: 0 })),
    ),
  );

  const created = results.flatMap((result) => result.created).filter((task) => task.ok);
  return { ok: created.length, refs: created.map((task) => task.ref).filter(Boolean) };
}

async function driveGoal(baseClient: ManagerClient, goal: Goal, cfg: GoalDriverConfig): Promise<{ spawned: number; refs: string[]; note: string }> {
  const teamClient = baseClient.withTeam(goal.team);
  const goalTeam = goal.team || baseClient.team || 'default';
  const tasks = await tasksForGoalScope(baseClient, goalTeam);
  const openTagged = tasks.filter((t) => taskBelongsToGoal(t, goal.id) && !taskDone(t));
  const openRefs = openTagged.map(taskRef).filter(Boolean);
  const slots = Math.max(0, cfg.maxOpenTasksPerGoal - openTagged.length);
  if (slots <= 0) return { spawned: 0, refs: openRefs, note: `open task cap reached (${openTagged.length}/${cfg.maxOpenTasksPerGoal})` };

  const agents = await teamClient.agents().catch(() => [] as Agent[]);
  const lead = pickActiveLead(agents);
  if (!lead) return { spawned: 0, refs: [], note: 'no active lead available' };

  if (goalTeam !== 'default') {
    const roster = agents.map((a) => ({
      name: a.name,
      runtime: a.runtime,
      status: a.status,
      skills: Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [],
    }));
    const decomp = await decomposeWork(teamClient, goal.content || goal.idea || goal.title, lead, roster);
    if (!decomp.ok || !decomp.subtasks.length) return { spawned: 0, refs: [], note: decomp.error || 'no subtasks produced' };
    if (!freshActiveGoalForDriver(goal)) return { spawned: 0, refs: [], note: 'goal changed or autopilot was disabled before task creation' };

    const subtasks = decomp.subtasks.slice(0, slots).map((st) => annotateSubtask(goal, st));
    const created = await createAndDispatchPlan(teamClient, goal.content || goal.title, subtasks, { dispatch: true });
    const ok = created.created.filter((t) => t.ok);
    return {
      spawned: ok.length,
      refs: ok.map((t) => t.ref).filter(Boolean),
      note: ok.length ? `spawned ${ok.length} task(s)` : 'no tasks created',
    };
  }

  const targets = await resolveGoalLeadTargets(baseClient, goal.team);
  if (!targets.length) return { spawned: 0, refs: [], note: 'no active non-default team leads available' };
  const plannedSubtasks = deterministicGoalLeadSubtasks(goal, targets, slots, 'default-team Autopilot direct team-lead fanout');
  if (!freshActiveGoalForDriver(goal)) return { spawned: 0, refs: [], note: 'goal changed or autopilot was disabled before team-lead task creation' };

  const subtasks = plannedSubtasks.slice(0, slots).map((st) => annotateSubtask(goal, st));
  const created = await createGoalLeadTasks(baseClient, goal.content || goal.title, subtasks, targets);
  const totalRefs = [...openRefs, ...created.refs];
  return {
    spawned: created.ok,
    refs: totalRefs,
    note: created.ok
      ? `spawned ${created.ok} task(s) to team leads via direct fanout${openTagged.length ? `; ${openTagged.length} existing open goal task(s) remain` : ''}`
      : `no team-lead tasks created via direct fanout${openTagged.length ? `; ${openTagged.length} existing open goal task(s) remain` : ''}`,
  };
}

export async function runGoalDriverOnce(getClient: () => ManagerClient, rawCfg: Partial<GoalDriverConfig> = {}): Promise<GoalDriverSummary> {
  const cfg = normalizeGoalDriverConfig(rawCfg);
  const summary: GoalDriverSummary = { enabled: cfg.enabled, consideredGoals: 0, drivenGoals: 0, tasksSpawned: 0, teamsSynced: 0, errors: [] };
  if (!cfg.enabled) return summary;

  const client = getClient();
  let goals = activeAutopilotGoals();
  summary.consideredGoals = goals.length;
  summary.teamsSynced = await syncTeamGoalInstructions(client, goals, summary.errors);
  const afterSyncGoals = activeAutopilotGoals();
  if (goalListDriverStamp(afterSyncGoals) !== goalListDriverStamp(goals)) {
    summary.errors.push('active Autopilot goals changed during team-instruction sync; resynced latest goals and skipped task spawn for this run');
    summary.consideredGoals = afterSyncGoals.length;
    summary.teamsSynced += await syncTeamGoalInstructions(client, afterSyncGoals, summary.errors);
    return summary;
  }
  goals = afterSyncGoals;

  for (const goal of goals) {
    try {
      const current = freshActiveGoalForDriver(goal);
      if (!current) {
        summary.errors.push(`${goal.id}: skipped because the goal changed or Autopilot was disabled before task spawn`);
        continue;
      }
      const result = await driveGoal(client, current, cfg);
      summary.drivenGoals++;
      summary.tasksSpawned += result.spawned;
      saveGoalDriverMetadata(current.id, {
        lastRunAt: Date.now(),
        taskRefs: result.refs,
        note: result.note,
      });
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${goal.id}: ${note}`);
      try {
        saveGoalDriverMetadata(goal.id, { ...(goal.driver ?? {}), lastRunAt: Date.now(), note });
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
