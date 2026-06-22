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
  files?: { name: string; isImage: boolean }[];
  image?: { path: string; prompt: string; model: string };
}
export interface ChatSession {
  id: string;
  title: string;
  /** true once the user has manually edited the title — stops auto-titling from clobbering it. */
  named?: boolean;
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

export interface ChatSummary { id: string; title: string; team: string; messageCount: number; updatedAt: number }

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
      out.push({ id: s.id, title: s.title || '(untitled)', team: s.team, messageCount: s.messages.length, updatedAt: s.updatedAt || 0 });
    } catch { /* skip a corrupt file */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
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
  const payload: ChatSession = {
    ...session,
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
