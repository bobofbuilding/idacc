/**
 * Blocker-question store (main process). App-side queue of multiple-choice questions
 * an agent raised when a task is blocked on a decision only the user can make. One
 * JSON file per question under <config>/questions/. They render in the Inbox with
 * clickable options; answering dispatches the choice to the relevant agent (renderer
 * side) and removes the question. No manager changes — purely client-side.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function questionsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'questions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface BlockerQuestion {
  id: string;
  question: string;
  options: string[];
  agent: string;        // who to deliver the chosen answer to
  taskRef?: string;
  taskTitle?: string;
  team: string;
  createdAt: number;
  dedupeKey?: string;   // stable producer key (learn:<id>, plan:<file>, task ref, etc.)
  fingerprint?: string; // normalized question fingerprint for duplicate suppression
  seenCount?: number;   // how many duplicate raises were folded into this item
  lastSeenAt?: number;
  source?: string;      // producer namespace (brain-approvals, learn, plan, etc.)
  metadata?: Record<string, unknown>;
}

function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid question id');
  return join(questionsDir(), `${safe}.json`);
}

export function listQuestions(team?: string): BlockerQuestion[] {
  const dir = questionsDir();
  const out: BlockerQuestion[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const q = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BlockerQuestion;
      if (team && q.team !== team) continue;
      if (q.question && Array.isArray(q.options) && q.options.length) out.push(q);
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function normText(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[`"'()[\]{}<>]/g, ' ')
    .replace(/[^a-z0-9:/._-]+/g, ' ')
    .replace(/\b(the|a|an|to|for|of|on|in|with|and|or|please|should|could|would|need|needs|needed|decision|question)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function questionTokens(s: string): Set<string> {
  return new Set(normText(s).split(/\s+/).filter((w) => w.length > 2));
}

function tokenOverlap(a: string, b: string): number {
  const left = questionTokens(a);
  const right = questionTokens(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit++;
  return hit / Math.max(left.size, right.size);
}

function scopeKey(q: Partial<BlockerQuestion>): string {
  return [
    normText(q.team || 'default'),
    normText(q.taskRef || q.taskTitle || q.agent || 'global'),
  ].join('|');
}

function fingerprintOf(q: Partial<BlockerQuestion>): string {
  return [
    scopeKey(q),
    normText(q.question),
  ].join('|');
}

function mergeOptions(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const option of [...(a ?? []), ...(b ?? [])]) {
    const clean = String(option || '').slice(0, 200).trim();
    if (!clean) continue;
    if (!out.some((existing) => normText(existing) === normText(clean))) out.push(clean);
  }
  return out.slice(0, 6);
}

function writeQuestion(payload: BlockerQuestion): { ok: boolean; id: string } {
  const f = fileFor(payload.id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  return { ok: true, id: payload.id };
}

function updateDuplicate(existing: BlockerQuestion, incoming: BlockerQuestion): { ok: boolean; id: string } {
  const payload: BlockerQuestion = {
    ...existing,
    options: mergeOptions(existing.options, incoming.options),
    agent: existing.agent || incoming.agent,
    taskRef: existing.taskRef || incoming.taskRef,
    taskTitle: existing.taskTitle || incoming.taskTitle,
    team: existing.team || incoming.team,
    dedupeKey: existing.dedupeKey || incoming.dedupeKey,
    fingerprint: existing.fingerprint || incoming.fingerprint,
    seenCount: Math.max(1, existing.seenCount || 1) + 1,
    lastSeenAt: Date.now(),
  };
  return writeQuestion(payload);
}

function findDuplicate(incoming: BlockerQuestion): BlockerQuestion | undefined {
  const incomingFp = incoming.fingerprint || fingerprintOf(incoming);
  const incomingScope = scopeKey(incoming);
  const incomingQuestion = incoming.question || '';
  return listQuestions().find((existing) => {
    if (incoming.id && existing.id === incoming.id) return true;
    if (incoming.dedupeKey && existing.dedupeKey === incoming.dedupeKey) return true;
    if ((existing.fingerprint || fingerprintOf(existing)) === incomingFp) return true;
    if (existing.taskRef && incoming.taskRef && existing.taskRef === incoming.taskRef) {
      const eq = normText(existing.question) === normText(incomingQuestion);
      const overlap = tokenOverlap(existing.question, incomingQuestion);
      return eq || overlap >= 0.82;
    }
    if (scopeKey(existing) === incomingScope) {
      const overlap = tokenOverlap(existing.question, incomingQuestion);
      const a = normText(existing.question);
      const b = normText(incomingQuestion);
      return overlap >= 0.88 || (!!a && !!b && (a.includes(b) || b.includes(a)));
    }
    return false;
  });
}

export function addQuestion(q: BlockerQuestion): { ok: boolean; id: string } {
  // Idempotent: blocker scans / plan scans / Learn gates may re-raise the same decision
  // repeatedly or with tiny wording changes. Normalize + scope before writing so the
  // Inbox has one live decision row, not a stack of duplicates.
  const questionLimit = q.source === 'brain-approvals' ? 5000 : 600;
  const incomingQuestion = String(q.question || '').slice(0, questionLimit).trim();
  const id = q?.id || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const payload: BlockerQuestion = {
    id,
    question: incomingQuestion,
    options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 6),
    agent: String(q.agent || ''),
    taskRef: q.taskRef ? String(q.taskRef) : undefined,
    taskTitle: q.taskTitle ? String(q.taskTitle).slice(0, 200) : undefined,
    team: String(q.team || ''),
    createdAt: q.createdAt || Date.now(),
    dedupeKey: q.dedupeKey ? String(q.dedupeKey).slice(0, 200) : undefined,
    seenCount: q.seenCount || 1,
    lastSeenAt: q.lastSeenAt || Date.now(),
    source: q.source ? String(q.source).slice(0, 120) : undefined,
    metadata: q.metadata && typeof q.metadata === 'object' ? q.metadata : undefined,
  };
  payload.fingerprint = q.fingerprint ? String(q.fingerprint).slice(0, 600) : fingerprintOf(payload);
  const dup = findDuplicate(payload);
  if (dup) return updateDuplicate(dup, payload);
  return writeQuestion(payload);
}

export function removeQuestion(id: string): { ok: boolean } {
  try { rmSync(fileFor(id), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}
