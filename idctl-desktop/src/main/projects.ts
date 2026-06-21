/**
 * Project folder + git support for the Projects page (main process only — needs
 * the filesystem, `git`, and the native folder picker).
 *
 *   pickProjectFolder()  → native "choose a directory" dialog
 *   projectReadme(path)  → first H1 as name + first real paragraph as description
 *   projectGit(path)     → branch, remotes, fork?, ahead/behind vs the main branch
 *   projectGitRun(path)  → run a WHITELISTED git command (fetch/pull/status/log)
 *
 * ahead/behind is measured against the relevant remote's default branch: for a
 * fork (an `upstream` remote distinct from `origin`) we compare to upstream's
 * main (so "ahead" = your custom commits); otherwise to origin's main.
 */

import { BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { loadSettings } from '../../../idctl/src/settings/store.ts';

const execFileP = promisify(execFile);

const MANAGER_PLIST = join(homedir(), 'Library/LaunchAgents/io.bittrees.idagents-manager.plist');

/**
 * The folder whose subdirectories are tracked as projects. Resolution order:
 *   1. an explicitly configured root (the saved projectsRoot),
 *   2. $ID_WORKSPACE_DIR/projects (the manager's own env, if the app inherits it),
 *   3. ID_WORKSPACE_DIR from the manager's launchd plist + /projects (standard install),
 *   4. a few well-known relative candidates.
 * Returns the first one that exists, else null.
 */
export function detectProjectsRoot(configured?: string): string | null {
  const candidates: string[] = [];
  if (configured && configured.trim()) candidates.push(configured.trim());
  if (process.env.ID_WORKSPACE_DIR) candidates.push(join(process.env.ID_WORKSPACE_DIR, 'projects'));
  // ID_WORKSPACE_DIR declared in the manager's launchd plist (the canonical
  // source on a standard install — the GUI rarely inherits the env itself).
  try {
    if (existsSync(MANAGER_PLIST)) {
      const xml = readFileSync(MANAGER_PLIST, 'utf8');
      const m = xml.match(/<key>\s*ID_WORKSPACE_DIR\s*<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) candidates.push(join(m[1].trim(), 'projects'));
    }
  } catch {
    /* plist unreadable */
  }
  for (const rel of ['id-agents/workspace/projects', '../id-agents/workspace/projects', 'workspace/projects']) {
    candidates.push(join(process.cwd(), rel));
  }
  for (const c of candidates) {
    try { if (existsSync(c) && readdirSync(c)) return c; } catch { /* skip */ }
  }
  return null;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export interface DiscoveredProject {
  name: string;
  path: string;
  description?: string;
  remoteUrl?: string;
}

/** Immediate subdirectories of `root` as candidate projects (name/desc/remote). */
export async function scanProjectsRoot(root: string): Promise<{ root: string; found: DiscoveredProject[]; error?: string }> {
  if (!root || !existsSync(root)) return { root, found: [], error: 'projects folder not found' };
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      // Directories, plus symlinks that resolve to a directory (checked-out repos
      // are sometimes symlinked into the projects folder).
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDir(join(root, d.name))))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    return { root, found: [], error: e instanceof Error ? e.message : String(e) };
  }
  const found = await Promise.all(
    entries.map(async (name): Promise<DiscoveredProject> => {
      let path = join(root, name);
      try { path = realpathSync(path); } catch { /* keep as-is */ }
      const readme = projectReadme(path);
      // Only use a remote when the folder is its OWN repo root — a plain folder
      // nested in a larger repo would otherwise return the enclosing repo's URL.
      const remoteUrl = (await isOwnRepoRoot(path)) ? await git(path, ['remote', 'get-url', 'origin']).catch(() => '') : '';
      return { name: readme.name || name, path, description: readme.description, remoteUrl: remoteUrl || undefined };
    }),
  );
  return { root, found };
}

/** Parse owner/repo from a GitHub URL or git@ remote. */
function repoSlug(url: string): string | null {
  const m = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
/** The user's GitHub PAT, read from the configured github MCP server. */
function githubToken(): string | undefined {
  try {
    return loadSettings().mcpServers?.find((s) => s.name === 'github')?.env?.GITHUB_PERSONAL_ACCESS_TOKEN;
  } catch {
    return undefined;
  }
}

export interface GithubMeta {
  ok: boolean;
  slug?: string;
  name?: string;
  description?: string;
  topics?: string[];
  language?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  error?: string;
}

/** Repo metadata from the GitHub API (description, topics→tags, language). */
export async function githubMeta(url: string): Promise<GithubMeta> {
  const slug = repoSlug(url);
  if (!slug) return { ok: false, error: 'not a GitHub repo URL' };
  const tok = githubToken();
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'idctl' };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}`, { headers, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, error: `GitHub API ${r.status}` };
    const repo = (await r.json()) as Record<string, unknown>;
    return {
      ok: true,
      slug,
      name: String(repo.name ?? slug.split('/')[1]),
      description: (repo.description as string) || undefined,
      topics: Array.isArray(repo.topics) ? (repo.topics as string[]) : [],
      language: (repo.language as string) || undefined,
      defaultBranch: (repo.default_branch as string) || undefined,
      isPrivate: !!repo.private,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Clone a GitHub repo into `parentDir/<repo>`. Prefers SSH (the user's auth). */
export async function cloneGithub(url: string, parentDir: string): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const slug = repoSlug(url);
  if (!slug) return { ok: false, error: 'not a GitHub repo URL' };
  if (!parentDir || !existsSync(parentDir)) return { ok: false, error: 'destination folder not found' };
  const name = slug.split('/')[1];
  const dest = join(parentDir, name);
  if (existsSync(dest)) return { ok: false, error: `folder already exists: ${dest}` };
  const attempts = [`git@github.com:${slug}.git`, `https://github.com/${slug}.git`];
  let lastErr = '';
  for (const remote of attempts) {
    try {
      await execFileP('git', ['clone', remote, dest], { timeout: 300000 });
      return { ok: true, path: dest, name };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      lastErr = (err.stderr || err.message || 'clone failed').trim();
    }
  }
  return { ok: false, error: lastErr };
}

/** Run a git command in `cwd`, returning trimmed stdout (throws on failure). */
async function git(cwd: string, args: string[], timeoutMs = 10000): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: timeoutMs });
  return stdout.trim();
}
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true).catch(() => false);
}
/** True only when `path` is a git repo's own root — not a plain folder that
 *  merely sits inside a larger repo (whose status/remote would be misleading). */
async function isOwnRepoRoot(path: string): Promise<boolean> {
  const top = await git(path, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!top) return false;
  const norm = (p: string) => { try { return realpathSync(p); } catch { return p.replace(/\/+$/, ''); } };
  return norm(top) === norm(path);
}

export async function pickProjectFolder(defaultPath?: string): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] };
  // Open the dialog at the standard projects folder when we have one, so new
  // clones/imports land alongside the rest by default.
  const fallback = defaultPath || detectProjectsRoot();
  if (fallback && existsSync(fallback)) opts.defaultPath = fallback;
  const win = BrowserWindow.getFocusedWindow();
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}

export function openProjectFolder(path: string): { ok: boolean } {
  try { void shell.openPath(path); return { ok: true }; } catch { return { ok: false }; }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
/** ASCII-art banners / box-drawing dividers: too few real letters for prose. */
function looksLikeArt(s: string): boolean {
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  return s.length >= 8 && alnum / s.length < 0.45;
}

/** Pull a name (clean H1 title) and description (first real paragraph) from a README. */
export function projectReadme(path: string): { found: boolean; name?: string; description?: string } {
  if (!path || !existsSync(path)) return { found: false };
  let file = '';
  try {
    const f = readdirSync(path).find((n) => /^readme(\.(md|markdown|txt|rst))?$/i.test(n));
    if (f) file = join(path, f);
  } catch {
    /* unreadable dir */
  }
  if (!file) return { found: false, name: basename(path) };
  try {
    const text = readFileSync(file, 'utf8');
    // Name: the first H1 that's a clean, short title (not an ASCII-art banner or a
    // long instructional heading); otherwise fall back to the folder name.
    let name = basename(path);
    for (const m of text.matchAll(/^#\s+(.+?)\s*$/gm)) {
      const h = m[1].replace(/[#*`_]/g, '').trim();
      if (h && h.length <= 50 && !looksLikeArt(h)) { name = h; break; }
    }
    // Description: first prose paragraph — skip headings, badges, images, html,
    // lists, quotes, hr/underlines, and ASCII-art lines.
    let description = '';
    let pastTitle = false;
    for (const raw of text.split('\n')) {
      const s = raw.trim();
      if (!s) { if (pastTitle && description) break; continue; }
      if (/^#{1,6}\s/.test(s)) { pastTitle = true; continue; }
      if (/^[-=]{3,}$/.test(s)) continue;
      if (/^!?\[!?\[/.test(s) || /^<\/?[a-z]/i.test(s)) continue;
      if (/^[-*+]\s|^\d+\.\s|^>/.test(s)) continue;
      if (looksLikeArt(s)) continue;
      const cleaned = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').trim();
      if (cleaned && !looksLikeArt(cleaned)) { description = cleaned; break; }
    }
    return { found: true, name, description: description ? clip(description, 240) : undefined };
  } catch {
    return { found: false, name: basename(path) };
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  upstreamUrl?: string;
  isFork?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  compareRef?: string;
  error?: string;
}

/** Resolve a remote's default branch (origin/HEAD → name, else main/master). */
async function defaultBranchOf(path: string, remote: string): Promise<string> {
  const sym = await git(path, ['symbolic-ref', `refs/remotes/${remote}/HEAD`]).catch(() => '');
  if (sym) return sym.replace(`refs/remotes/${remote}/`, '');
  for (const b of ['main', 'master', 'develop']) {
    if (await gitOk(path, ['rev-parse', '--verify', `${remote}/${b}`])) return b;
  }
  return 'main';
}

export async function projectGit(path: string): Promise<GitInfo> {
  if (!path || !existsSync(path)) return { isRepo: false, error: 'folder not found' };
  try {
    // Treat as a repo only when the folder is its OWN root; a plain folder that
    // merely sits inside a larger repo would otherwise report that repo's status.
    if (!(await isOwnRepoRoot(path))) {
      return { isRepo: false };
    }
    const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    const remotes = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean);
    const remoteUrl = remotes.includes('origin') ? await git(path, ['remote', 'get-url', 'origin']).catch(() => '') : '';
    const upstreamUrl = remotes.includes('upstream') ? await git(path, ['remote', 'get-url', 'upstream']).catch(() => '') : '';
    const isFork = !!upstreamUrl && upstreamUrl !== remoteUrl;
    const dirty = !!(await git(path, ['status', '--porcelain']).catch(() => ''));

    const remote = isFork ? 'upstream' : (remotes.includes('origin') ? 'origin' : remotes[0]);
    let ahead: number | undefined;
    let behind: number | undefined;
    let compareRef: string | undefined;
    if (remote) {
      const def = await defaultBranchOf(path, remote);
      compareRef = `${remote}/${def}`;
      if (await gitOk(path, ['rev-parse', '--verify', compareRef])) {
        const counts = await git(path, ['rev-list', '--left-right', '--count', `${compareRef}...HEAD`]).catch(() => '');
        const m = counts.split(/\s+/).map((n) => Number(n));
        if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1])) {
          behind = m[0];
          ahead = m[1];
        }
      }
    }
    return { isRepo: true, branch, remoteUrl: remoteUrl || undefined, upstreamUrl: upstreamUrl || undefined, isFork, ahead, behind, dirty, compareRef };
  } catch (e) {
    return { isRepo: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whitelisted git commands the Projects page can run. */
const GIT_ACTIONS: Record<string, string[]> = {
  fetch: ['fetch', '--all', '--prune'],
  pull: ['pull', '--ff-only'],
  status: ['status', '-sb'],
  log: ['log', '--oneline', '--decorate', '-15'],
  diff: ['diff', '--stat'],
};

export async function projectGitRun(path: string, action: string): Promise<{ ok: boolean; output: string }> {
  const args = GIT_ACTIONS[action];
  if (!args) return { ok: false, output: `unknown git action: ${action}` };
  if (!path || !existsSync(path)) return { ok: false, output: 'folder not found' };
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd: path, timeout: 90000 });
    return { ok: true, output: `${stdout}${stderr}`.trim() || '(no output)' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
}
