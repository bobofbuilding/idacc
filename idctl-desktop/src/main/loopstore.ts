/**
 * Loop store (main process). A "loop" is a saved sequential agent→task chain:
 * an ordered list of steps, each routed to an agent, where each step's output
 * feeds the next. One JSON file per loop under <config>/loops/. The chain is
 * drafted/edited in the renderer (AI-assisted) and executed there (dispatch per
 * step); this store just persists the definition + the last run's results.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function loopsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'loops');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface LoopStep { agent: string; task: string }
export interface LoopStepResult { agent: string; task: string; status: 'ok' | 'failed' | 'skipped'; output?: string; error?: string }
export interface Loop {
  id: string;
  title: string;
  goal: string;          // the natural-language goal the chain was drafted from
  team: string;
  steps: LoopStep[];
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastResults?: LoopStepResult[];
}
export interface LoopSummary { id: string; title: string; team: string; steps: number; updatedAt: number; lastRunAt?: number }

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid loop id');
  return join(loopsDir(), `${safe}.json`);
}

export function listLoops(team?: string): LoopSummary[] {
  const dir = loopsDir();
  const out: LoopSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const l = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Loop;
      if (team && l.team !== team) continue;
      out.push({ id: l.id, title: l.title || '(untitled loop)', team: l.team, steps: Array.isArray(l.steps) ? l.steps.length : 0, updatedAt: l.updatedAt || 0, lastRunAt: l.lastRunAt });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLoop(id: string): Loop | null {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as Loop;
  } catch { return null; }
}

export function saveLoop(loop: Loop): { ok: boolean; id: string } {
  if (!loop?.id) throw new Error('loop id required');
  const f = fileFor(loop.id);
  const now = Date.now();
  const payload: Loop = {
    ...loop,
    title: (loop.title || '').slice(0, 200),
    steps: (Array.isArray(loop.steps) ? loop.steps : []).slice(0, 20),
    createdAt: loop.createdAt || now,
    updatedAt: now,
  };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
  return { ok: true, id: loop.id };
}

export function removeLoop(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
