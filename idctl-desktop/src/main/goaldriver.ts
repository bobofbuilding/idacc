/**
 * Background driver for active Goals.
 *
 * Global `goalDriver.enabled` defaults on, but per-goal `autopilot` must also
 * be true before anything can spawn. The loop is single-flight and best-effort:
 * errors are logged and recorded on the goal, never allowed to crash the app.
 */

import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { getGoal, goalPriorityRank, listGoals, normalizeGoalPriority, type Goal } from './goalstore.ts';

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

interface ManagerGoalAutopilotSyncResult {
  consideredGoals?: number;
  drivenGoals?: number;
  tasksSpawned?: number;
  errors?: Array<{ goal?: string; error?: string }>;
}

export const GOAL_DRIVER_DEFAULTS: GoalDriverConfig = {
  enabled: true,
  cadenceMs: 15 * 60 * 1000,
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

  // The manager is the durable owner of goal execution: it remains alive when
  // IDACC closes and already enforces per-team, per-lead, duplicate, backlog,
  // and query-capacity guards. IDACC synchronizes goal knowledge and triggers
  // that single producer instead of creating a second, competing task fanout.
  try {
    const envelope = await client.withTeam('default').remote<ManagerGoalAutopilotSyncResult>(
      `/task sync-autopilot-goals --limit ${Math.max(1, Math.min(20, cfg.maxOpenTasksPerGoal, goals.length || 1))}`,
    );
    const report = envelope.result;
    summary.consideredGoals = Number(report?.consideredGoals) || summary.consideredGoals;
    summary.drivenGoals = Number(report?.drivenGoals) || 0;
    summary.tasksSpawned = Number(report?.tasksSpawned) || 0;
    for (const item of report?.errors ?? []) {
      summary.errors.push(`${item.goal ? `${item.goal}: ` : ''}${item.error || 'manager autopilot sync failed'}`);
    }
  } catch (e) {
    summary.errors.push(`manager autopilot sync: ${e instanceof Error ? e.message : String(e)}`);
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
