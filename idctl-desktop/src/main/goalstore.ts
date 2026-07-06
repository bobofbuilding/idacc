/**
 * Goal store (main process). Each goal is one JSON file under <config>/goals/,
 * holding the goal's markdown statement, status, and metadata. Goals are the
 * lightweight "what/why" that sit alongside Plans (the "how").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function goalsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'goals');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
export type GoalPriority = 'primary' | 'secondary' | 'general';
export type GoalOrigin = 'goals' | 'plans' | 'learn';
export interface Goal {
  id: string;
  title: string;
  idea: string;          // the rough idea the goal was drafted from (may be empty)
  agent?: string;        // which agent helped write/last-refined it
  team: string;
  origin?: GoalOrigin;   // user Goals tab records are "goals"; Work > Plans uses "plans"
  status: GoalStatus;
  priority?: GoalPriority; // primary goal first, secondary next, general supporting goals last
  autopilot?: boolean;   // opt-in: eligible for the disabled-by-default goal driver
  content: string;       // the goal statement (markdown)
  driver?: {
    lastRunAt?: number;
    taskRefs?: string[];
    note?: string;
  };
  createdAt: number;
  updatedAt: number;
}
export interface GoalSummary { id: string; title: string; status: GoalStatus; priority: GoalPriority; agent?: string; team: string; origin: GoalOrigin; updatedAt: number; autopilot?: boolean }
export interface ListGoalsOptions { includePlanObjectives?: boolean }

export function normalizeGoalPriority(input: unknown): GoalPriority {
  const value = String(input ?? '').trim().toLowerCase();
  return value === 'primary' || value === 'secondary' || value === 'general' ? value : 'general';
}

export function goalPriorityRank(input: unknown): number {
  const priority = normalizeGoalPriority(input);
  return priority === 'primary' ? 0 : priority === 'secondary' ? 1 : 2;
}

export function normalizeGoalOrigin(input: unknown): GoalOrigin {
  const value = String(input ?? '').trim().toLowerCase();
  return value === 'plans' || value === 'learn' ? value : 'goals';
}

export function isPlanObjectiveGoal(goal: Pick<Goal, 'id' | 'title' | 'idea'> & { origin?: unknown; driver?: { note?: string } }): boolean {
  if (normalizeGoalOrigin(goal.origin) === 'plans') return true;
  const id = String(goal.id || '');
  if (id.startsWith('goal_plan_')) return true;
  const title = String(goal.title || '').trim();
  const provenance = `${goal.idea || ''}\n${goal.driver?.note || ''}`;
  return title.startsWith('Plan:') && /\b(?:brain plan|Work\s*>\s*Plans)\b/i.test(provenance);
}

function normalizeGoal(goal: Goal): Goal {
  const origin = isPlanObjectiveGoal(goal) ? 'plans' : normalizeGoalOrigin(goal.origin);
  return {
    ...goal,
    origin,
    priority: normalizeGoalPriority(goal.priority),
  };
}

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid goal id');
  return join(goalsDir(), `${safe}.json`);
}

export function listGoals(team?: string, options: ListGoalsOptions = {}): GoalSummary[] {
  const dir = goalsDir();
  const out: GoalSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const g = normalizeGoal(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Goal);
      if (team && g.team !== team) continue;
      if (!options.includePlanObjectives && isPlanObjectiveGoal(g)) continue;
      out.push({
        id: g.id,
        title: g.title || '(untitled goal)',
        status: g.status ?? 'draft',
        priority: g.priority ?? 'general',
        agent: g.agent,
        team: g.team,
        origin: g.origin ?? 'goals',
        updatedAt: g.updatedAt || 0,
        autopilot: !!g.autopilot,
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => goalPriorityRank(a.priority) - goalPriorityRank(b.priority) || b.updatedAt - a.updatedAt);
}

export function getGoal(id: string): Goal | null {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    const goal = JSON.parse(readFileSync(f, 'utf8')) as Goal;
    return normalizeGoal(goal);
  } catch { return null; }
}

export function saveGoal(goal: Goal): { ok: boolean; id: string } {
  if (!goal?.id) throw new Error('goal id required');
  const f = fileFor(goal.id);
  const now = Date.now();
  const payload: Goal = {
    ...normalizeGoal(goal),
    title: (goal.title || '').slice(0, 200),
    createdAt: goal.createdAt || now,
    updatedAt: now,
  };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
  return { ok: true, id: goal.id };
}

export function removeGoal(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
