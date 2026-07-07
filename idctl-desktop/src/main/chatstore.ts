/**
 * Persistent chat sessions (main process). Each saved conversation is one JSON
 * file under <config>/chats/, so threads survive navigation + app restarts and
 * can be reopened later. One file per session keeps writes cheap as history grows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';

/** Mirror idctl's config-path resolution so chats live beside config.json. */
function chatsDir(): string {
  const env = process.env.IDCTL_CONFIG?.trim();
  const base = env
    ? dirname(env)
    : process.env.XDG_CONFIG_HOME?.trim()?.startsWith('/')
      ? join(process.env.XDG_CONFIG_HOME.trim(), 'idctl')
      : join(homedir(), '.config', 'idctl');
  const dir = join(base, 'chats');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function chatImagesDir(): string {
  const dir = join(chatsDir(), 'images');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface ChatMessage {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  queryId?: string;
  files?: { name: string; path?: string; isImage: boolean }[];
  image?: { path: string; prompt: string; model: string };
}
export interface ChatSession {
  id: string;
  title: string;
  /** true once the user has manually edited the title — stops auto-titling from clobbering it. */
  named?: boolean;
  /** true when an agent reply landed that the user hasn't viewed yet (drives the Chat nav badge). */
  unread?: boolean;
  /** An in-flight dispatch awaiting a reply — persisted so the chat can resume
   *  polling after navigation, a long wait, or an app restart. */
  inflight?: { queryId: string; replyId: number; target: string; startedAt: number; plan?: { request: boolean; text: string } } | null;
  team: string;
  target: string;
  projectId?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Safe filename for a session id (defends the path even though ids are app-generated). */
function fileFor(id: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) throw new Error('invalid chat id');
  return join(chatsDir(), `${safe}.json`);
}

export interface ChatSummary { id: string; title: string; team: string; messageCount: number; updatedAt: number; unread?: boolean }

/** A session is worth keeping once it has a real exchange (not just the greeting). */
function hasContent(s: ChatSession): boolean {
  return Array.isArray(s.messages) && s.messages.some((m) => m.role !== 'system');
}

export function listChats(team?: string): ChatSummary[] {
  const dir = chatsDir();
  const out: ChatSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ChatSession;
      // Prune empty chats (no real message) left over from earlier behavior.
      if (!hasContent(s)) { try { rmSync(join(dir, f), { force: true }); } catch { /* */ } continue; }
      if (team && s.team !== team) continue;
      out.push({ id: s.id, title: s.title || '(untitled)', team: s.team, messageCount: s.messages.length, updatedAt: s.updatedAt || 0, unread: !!s.unread });
    } catch { /* skip a corrupt file */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function isRecoverableFailureText(text?: string): boolean {
  return /^\s*✗\s*(failed|agent failed|query failed|query expired|expired)\b/i.test(String(text || ''));
}

/** Sessions that have a persisted in-flight dispatch — so the renderer can resume
 *  polling ALL of them on mount (not just the last-open one), and a reply to a
 *  backgrounded chat still lands with an unread badge after a restart. `delivered`
 *  is true when the reply already landed (stale inflight → caller drops it). */
export function listInflightChats(team?: string): Array<{ id: string; inflight: NonNullable<ChatSession['inflight']>; delivered: boolean }> {
  const dir = chatsDir();
  const out: Array<{ id: string; inflight: NonNullable<ChatSession['inflight']>; delivered: boolean }> = [];
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ChatSession;
      if (team && s.team !== team) continue;
      const inf = s.inflight;
      if (!inf?.queryId) continue;
      const reply = (s.messages || []).find((m) => m.id === inf.replyId);
      const delivered = !!(reply && (reply.image || ((reply.text || '').trim() && !isRecoverableFailureText(reply.text))));
      out.push({ id: s.id, inflight: inf, delivered });
    } catch { /* skip a corrupt file */ }
  }
  return out;
}

/** Strip the renderer-only `pending` flag before a message is persisted. */
function stripPending(m: ChatMessage): ChatMessage {
  const { pending: _p, ...rest } = m as ChatMessage & { pending?: boolean };
  return rest;
}
/** Atomic write of a session file (tmp + rename, 0600). */
function writeSession(f: string, s: ChatSession): void {
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
}

// Cache the unread tally keyed by a cheap directory signature (filename + mtime
// + size of each chat file). Any chat write changes a file's mtime → the
// signature changes → we recompute; otherwise the 3s poll skips the JSON parse.
let _unreadCache: { sig: string; teams: string[] } | null = null;
function dirSignature(dir: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try { const st = statSync(join(dir, f)); parts.push(`${f}:${st.mtimeMs}:${st.size}`); } catch { /* gone */ }
  }
  return parts.join('|');
}

/** Count saved chats with an unviewed agent reply (the Chat nav badge). Scoped
 *  to `team` when given so it matches the team whose chats are on screen. */
export function unreadChatCount(team?: string): number {
  try {
    const dir = chatsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const sig = dirSignature(dir, files);
    if (!_unreadCache || _unreadCache.sig !== sig) {
      const teams: string[] = [];
      for (const f of files) {
        try {
          const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ChatSession;
          if (s.unread && hasContent(s)) teams.push(s.team);
        } catch { /* skip a corrupt file */ }
      }
      _unreadCache = { sig, teams };
    }
    return team ? _unreadCache.teams.filter((t) => t === team).length : _unreadCache.teams.length;
  } catch { return 0; }
}

/** Clear a chat's unread flag (user has now viewed it). Preserves updatedAt so
 *  reading a thread never reorders the session list. No-op if already read. */
export function markChatRead(id: string): { ok: boolean } {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return { ok: true };
    const s = JSON.parse(readFileSync(f, 'utf8')) as ChatSession;
    if (!s.unread) return { ok: true };
    s.unread = false;
    writeSession(f, s);
    return { ok: true };
  } catch { return { ok: false }; }
}

/** Targeted patch for a session field/message — atomic main-side read-merge-write
 *  so concurrent background writers (title-gen, reply-resolve, system notices)
 *  can't clobber each other (the lost-update class). Returns {ok:false} when the
 *  file doesn't exist yet (caller falls back to a full saveChat). */
export interface ChatPatch {
  title?: string;           // explicit rename — always applied
  autoTitle?: string;       // generated title — applied only when not user-named
  named?: boolean;
  target?: string;
  projectId?: string;
  unread?: boolean;
  inflight?: { queryId: string; replyId: number; target: string; startedAt: number; plan?: { request: boolean; text: string } } | null; // set to null to clear
  appendMessage?: ChatMessage;
  patchMessage?: { id: number; patch: Partial<ChatMessage> };
  touch?: boolean;          // bump updatedAt (default true; false = don't reorder)
}
export function patchChat(id: string, p: ChatPatch): { ok: boolean; session?: ChatSession } {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return { ok: false };
    const s = JSON.parse(readFileSync(f, 'utf8')) as ChatSession;
    if (p.title !== undefined) s.title = String(p.title).slice(0, 200);
    if (p.autoTitle !== undefined && !s.named) s.title = String(p.autoTitle).slice(0, 200);
    if (p.named !== undefined) s.named = p.named;
    if (p.target !== undefined) s.target = p.target;
    if (p.projectId !== undefined) s.projectId = p.projectId;
    if (p.unread !== undefined) s.unread = p.unread;
    if (p.inflight !== undefined) s.inflight = p.inflight; // {…} to set, null to clear
    if (Array.isArray(s.messages) === false) s.messages = [];
    if (p.appendMessage) s.messages = [...s.messages, stripPending(p.appendMessage)];
    if (p.patchMessage) s.messages = s.messages.map((m) => (m.id === p.patchMessage!.id ? stripPending({ ...m, ...p.patchMessage!.patch }) : m));
    if (p.touch !== false) s.updatedAt = Date.now();
    writeSession(f, s);
    return { ok: true, session: s };
  } catch { return { ok: false }; }
}

export function getChat(id: string): ChatSession | null {
  try {
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as ChatSession;
  } catch { return null; }
}

export function saveChat(session: ChatSession): { ok: boolean; id: string; skipped?: boolean } {
  if (!session?.id) throw new Error('session id required');
  // Only cache chats that have an actual message — skip empty "New chat" shells.
  if (!hasContent(session)) return { ok: true, id: session.id, skipped: true };
  const f = fileFor(session.id);
  const now = Date.now();
  // `inflight` is owned exclusively by patchChat (a targeted, atomic field). A
  // full save carries whatever snapshot the renderer happened to hold, which can
  // be stale (e.g. a title/target edit mid-dispatch, or right after a reply
  // cleared it) — so preserve the authoritative on-disk value and never let a
  // full save resurrect or wipe an inflight. Only the create case uses the
  // incoming value (there's nothing on disk yet to preserve).
  let inflight = session.inflight ?? null;
  try { if (existsSync(f)) inflight = (JSON.parse(readFileSync(f, 'utf8')) as ChatSession).inflight ?? null; } catch { /* file unreadable → keep incoming */ }
  const payload: ChatSession = {
    ...session,
    inflight,
    title: (session.title || '').slice(0, 200),
    // Strip the renderer-only `pending` flag so an in-flight reply interrupted by
    // a switch/quit doesn't persist as a frozen "thinking…" spinner.
    messages: (Array.isArray(session.messages) ? session.messages : []).map((m) => {
      const { pending: _p, ...rest } = m as ChatMessage & { pending?: boolean };
      return rest;
    }),
    createdAt: session.createdAt || now,
    updatedAt: now,
  };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  try { renameSync(tmp, f); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* */ } throw e; }
  try { if ((statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600); } catch { /* best-effort */ }
  return { ok: true, id: session.id };
}

export function renameChat(id: string, title: string): { ok: boolean } {
  const s = getChat(id);
  if (!s) return { ok: false };
  s.title = String(title || '').slice(0, 200);
  saveChat(s);
  return { ok: true };
}

/** Generate a short chat title from the opening message using a local Ollama
 *  model (free, no cloud cost). Returns '' on any failure — caller keeps its
 *  own fallback (the clipped first message). */
export async function genTitle(text: string): Promise<string> {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return '';
  const ollama = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let installed: string[] = [];
  try {
    const r = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) installed = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch { return ''; }
  // Prefer the smallest installed model for a fast, cheap title.
  const order = ['llama3.2:1b', 'qwen3:1.7b', 'qwen2.5:3b', 'qwen3:4b', 'llama3.2:latest'];
  const model = order.find((m) => installed.includes(m)) || installed[0];
  if (!model) return '';
  const prompt = `Give a concise 3-6 word title (Title Case, no quotes, no trailing punctuation) for a conversation that opens with:\n"${clean}"\nTitle:`;
  try {
    const r = await fetch(`${ollama}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 24, temperature: 0.2 } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return '';
    let t = String(((await r.json()) as { response?: string }).response ?? '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s"'`]+|[\s"'`]+$/g, '').split('\n')[0].replace(/[.!?]+$/, '').trim();
    return t.slice(0, 60);
  } catch {
    return '';
  }
}

/** One-line, plain-English summary of what produced an agent reply — drives the
 *  chat's "behind the scenes" summary line. Local Ollama (free, no cloud cost);
 *  returns '' on any failure (the caller keeps a deterministic rollup fallback). */
export async function genReason(text: string): Promise<string> {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean) return '';
  const ollama = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let installed: string[] = [];
  try {
    const r = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) installed = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch { return ''; }
  // Prefer the smallest installed model for a fast, cheap summary.
  const order = ['llama3.2:1b', 'qwen3:1.7b', 'qwen2.5:3b', 'qwen3:4b', 'llama3.2:latest'];
  const model = order.find((m) => installed.includes(m)) || installed[0];
  if (!model) return '';
  const prompt = `In one short sentence (max ~14 words, plain English, no quotes, no trailing punctuation), summarize what the assistant did or decided to produce this reply:\n"${clean}"\nSummary:`;
  try {
    const r = await fetch(`${ollama}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 48, temperature: 0.2 } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return '';
    let t = String(((await r.json()) as { response?: string }).response ?? '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s"'`]+|[\s"'`]+$/g, '').split('\n')[0].replace(/[.!?]+$/, '').trim();
    return t.slice(0, 120);
  } catch {
    return '';
  }
}

export function removeChat(id: string): { ok: boolean } {
  try {
    // Prune this chat's generated images (only files that resolve inside the
    // image cache dir — so a hand-edited path can't delete arbitrary files).
    const s = getChat(id);
    if (s) {
      let realDir = '';
      try { realDir = realpathSync(chatImagesDir()); } catch { /* dir gone */ }
      for (const m of s.messages ?? []) {
        const p = m.image?.path;
        if (!p || !realDir) continue;
        try {
          if (!existsSync(p)) continue;
          const real = realpathSync(p);
          if (real === realDir || real.startsWith(realDir + sep)) rmSync(real, { force: true });
        } catch { /* skip a file we can't resolve */ }
      }
    }
    rmSync(fileFor(id), { force: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
