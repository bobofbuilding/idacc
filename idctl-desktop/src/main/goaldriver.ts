/**
 * Background driver for active Goals.
 *
 * Global `goalDriver.enabled` defaults on, but per-goal `autopilot` must also
 * be true before anything can spawn. IDACC publishes the operator configuration;
 * the manager owns the durable cadence and single-flight execution.
 */

import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { defaultGoalDriverSettings } from '../../../idctl/src/settings/schema.ts';
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

const sharedGoalDriverDefaults = defaultGoalDriverSettings();

export const GOAL_DRIVER_DEFAULTS: GoalDriverConfig = {
  enabled: sharedGoalDriverDefaults.enabled !== false,
  cadenceMs: sharedGoalDriverDefaults.cadenceMs ?? 15 * 60 * 1000,
  maxOpenTasksPerGoal: sharedGoalDriverDefaults.maxOpenTasksPerGoal ?? 3,
};

export function normalizeGoalDriverConfig(input?: Partial<GoalDriverConfig> | null): GoalDriverConfig {
  const requestedCadence = Number(input?.cadenceMs);
  const requestedTasks = Number(input?.maxOpenTasksPerGoal);
  return {
    enabled: typeof input?.enabled === 'boolean'
      ? input.enabled
      : GOAL_DRIVER_DEFAULTS.enabled,
    cadenceMs: Number.isFinite(requestedCadence) && requestedCadence > 0
      ? Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.floor(requestedCadence)))
      : GOAL_DRIVER_DEFAULTS.cadenceMs,
    maxOpenTasksPerGoal: Number.isFinite(requestedTasks) && requestedTasks > 0
      ? Math.max(1, Math.min(12, Math.floor(requestedTasks)))
      : GOAL_DRIVER_DEFAULTS.maxOpenTasksPerGoal,
  };
}

export function goalDriverControlValue(input?: Partial<GoalDriverConfig> | null): Record<string, number | boolean> {
  const config = normalizeGoalDriverConfig(input);
  return {
    schemaVersion: 1,
    enabled: config.enabled,
    cadenceMs: config.cadenceMs,
    maxTasksPerRun: config.maxOpenTasksPerGoal,
  };
}

export function dedupeGoalInstructionMemories<T extends { mem_key?: string; project?: string }>(memories: T[]): T[] {
  const canonicalProjects = new Set(
    memories
      .filter((memory) => String(memory.mem_key || '').startsWith('goals:active:'))
      .map((memory) => String(memory.project || memory.mem_key?.slice('goals:active:'.length) || '')),
  );
  return memories.filter((memory) => {
    const key = String(memory.mem_key || '');
    if (!key.startsWith('goals:autopilot:')) return true;
    const project = String(memory.project || key.slice('goals:autopilot:'.length));
    return !canonicalProjects.has(project);
  });
}

export async function syncGoalDriverConfig(client: ManagerClient, input?: Partial<GoalDriverConfig> | null): Promise<void> {
  await client.withTeam('default').controlStateSet('global', 'goal-driver', goalDriverControlValue(input));
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

export function buildActiveGoalInstructions(_team: string, goals: Goal[]): string {
  const lines = goals.slice().sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt).map((g) => {
    const owner = g.agent ? ` · agent: ${g.agent}` : '';
    const automation = g.autopilot ? ' · Autopilot' : '';
    return `- [${goalPriorityLabel(g)}${automation}] ${g.title || g.id} (${g.id}${owner}): ${clip(g.content || g.idea || '', 220)}`;
  });
  return [
    '## Active goals',
    '',
    lines.length
      ? `Keep this team's work aligned with these active goals. Autopilot marks goals eligible for bounded cadence work; it is not a second goal source.`
      : `No active goals are currently assigned to this team.`,
    ...lines,
  ].join('\n');
}

export function goalBrainEntity(goal: Goal) {
  const priority = normalizeGoalPriority(goal.priority);
  return {
    id: `goal:${goal.id}`,
    type: 'goal',
    name: goal.title || goal.id,
    status: goal.status,
    tags: ['goal', priority, 'dashboard-state', goal.autopilot ? 'autopilot' : 'manual'],
    data: {
      team: goal.team || 'default',
      priority,
      agent: goal.agent,
      autopilot: goal.autopilot === true,
    },
    exactId: true,
    mergeAliases: false,
  };
}

export async function syncActiveWorkGoalInstructions(client: ManagerClient): Promise<{ teamsSynced: number; activeGoals: number; errors: string[] }> {
  const goals = activeWorkGoals();
  const teams = new Set<string>();
  for (const g of goals) if (g.team) teams.add(g.team);
  for (const t of await client.teams().catch(() => [])) if (t.name) teams.add(t.name);
  if (!teams.size) teams.add(client.team ?? 'default');

  const errors: string[] = [];
  for (const goal of goals) {
    try {
      if (!(await brain.entity(goalBrainEntity(goal)))) errors.push(`goal ${goal.id}: Brain entity sync failed`);
    } catch (e) {
      errors.push(`goal ${goal.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let teamsSynced = 0;
  for (const team of teams) {
    try {
      const teamGoals = goals.filter((g) => g.team === team);
      const wrote = await brain.memory('team-instructions', {
        key: `goals:active:${team}`,
        content: buildActiveGoalInstructions(team, teamGoals),
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

export async function runGoalDriverOnce(getClient: () => ManagerClient, rawCfg: Partial<GoalDriverConfig> = {}): Promise<GoalDriverSummary> {
  const cfg = normalizeGoalDriverConfig(rawCfg);
  const summary: GoalDriverSummary = { enabled: cfg.enabled, consideredGoals: 0, drivenGoals: 0, tasksSpawned: 0, teamsSynced: 0, errors: [] };
  if (!cfg.enabled) return summary;

  const client = getClient();
  try {
    await syncGoalDriverConfig(client, cfg);
  } catch (e) {
    summary.errors.push(`manager cadence sync: ${e instanceof Error ? e.message : String(e)}`);
    return summary;
  }
  let goals = activeAutopilotGoals();
  summary.consideredGoals = goals.length;
  const instructionSync = await syncActiveWorkGoalInstructions(client);
  summary.teamsSynced = instructionSync.teamsSynced;
  summary.errors.push(...instructionSync.errors);
  const afterSyncGoals = activeAutopilotGoals();
  if (goalListDriverStamp(afterSyncGoals) !== goalListDriverStamp(goals)) {
    summary.errors.push('active goals changed during canonical instruction sync; resynced latest goals and skipped task spawn for this run');
    summary.consideredGoals = afterSyncGoals.length;
    const latestSync = await syncActiveWorkGoalInstructions(client);
    summary.teamsSynced += latestSync.teamsSynced;
    summary.errors.push(...latestSync.errors);
    return summary;
  }
  goals = afterSyncGoals;

  // The Manager is the authoritative goal executor while the unified app is
  // running and already enforces per-team, per-lead, duplicate, backlog, and
  // query-capacity guards. IDACC synchronizes goal knowledge and triggers that
  // single producer instead of creating a second, competing task fanout.
  try {
    const envelope = await client.withTeam('default').remote<ManagerGoalAutopilotSyncResult>(
      `/task sync-autopilot-goals --limit ${Math.max(1, Math.min(12, cfg.maxOpenTasksPerGoal, goals.length || 1))}`,
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
  let lastConfigStamp = '';

  const tick = async () => {
    if (stopped || running) return;
    const cfg = normalizeGoalDriverConfig(getCfg());
    const stamp = JSON.stringify(goalDriverControlValue(cfg));
    if (stamp === lastConfigStamp) return;
    running = true;
    try {
      await syncGoalDriverConfig(getClient(), cfg);
      lastConfigStamp = stamp;
    } catch (e) {
      console.warn('[goaldriver] manager cadence sync failed:', e);
    } finally {
      running = false;
    }
  };

  const t0 = setTimeout(() => void tick(), 5_000);
  const iv = setInterval(() => void tick(), 60_000);
  (t0 as { unref?: () => void }).unref?.();
  (iv as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearTimeout(t0);
    clearInterval(iv);
  };
}
