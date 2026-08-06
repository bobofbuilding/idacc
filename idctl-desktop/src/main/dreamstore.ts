/**
 * Dream store (main process). A "dream" is one offline reflection pass an agent
 * runs over its recent work + the shared brain: a Markdown report with
 * consolidation / insights / ideas / simulations. One JSON file per report under
 * <config>/dreams/. The pass is dispatched from the renderer (/ask) and the
 * resulting report is saved here so the Dream tab is a morning digest.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function dreamsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'dreams');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface Dream {
  id: string;
  title: string;
  agent: string;
  team: string;
  focus?: string;     // optional user-provided focus for the pass
  content: string;    // the Markdown dream report
  createdAt: number;
  source?: {
    kind: 'schedule';
    scheduleId: string;
    queryId: string;
  };
}
export interface DreamSummary { id: string; title: string; agent: string; team: string; createdAt: number }

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid dream id');
  return join(dreamsDir(), `${safe}.json`);
}

export function listDreams(team?: string): DreamSummary[] {
  const dir = dreamsDir();
  const out: DreamSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Dream;
      if (team && d.team !== team) continue;
      out.push({ id: d.id, title: d.title || '(dream)', agent: d.agent, team: d.team, createdAt: d.createdAt || 0 });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getDream(id: string): Dream | null {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as Dream;
  } catch { return null; }
}

export function saveDream(dream: Dream): { ok: boolean; id: string } {
  if (!dream?.id) throw new Error('dream id required');
  const f = fileFor(dream.id);
  const payload: Dream = { ...dream, title: (dream.title || '').slice(0, 200), createdAt: dream.createdAt || Date.now() };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
  return { ok: true, id: dream.id };
}

export function removeDream(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
