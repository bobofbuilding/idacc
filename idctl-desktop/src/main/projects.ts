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
import { existsSync, readFileSync, writeFileSync, readdirSync, realpathSync, statSync, rmSync } from 'node:fs';
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
    const servers = loadSettings().mcpServers ?? [];
    // Match a github MCP server FLEXIBLY (name 'github', 'github pat', 'github-mcp', …)
    // or ANY server carrying a GITHUB_PERSONAL_ACCESS_TOKEN — a naming quirk must never
    // silently break GitHub auth. Then fall back to the environment.
    const cfg = servers.find((s) => /github/i.test(s.name ?? '') && s.env?.GITHUB_PERSONAL_ACCESS_TOKEN)?.env?.GITHUB_PERSONAL_ACCESS_TOKEN
      ?? servers.find((s) => s.env?.GITHUB_PERSONAL_ACCESS_TOKEN)?.env?.GITHUB_PERSONAL_ACCESS_TOKEN;
    return cfg || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GH_TOKEN || undefined;
  } catch {
    return process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GH_TOKEN || undefined;
  }
}

// (Retired) The app used to append a managed "secrets" block to every project's .gitignore
// and auto-commit it. In practice every repo already ignored .env, so the block was redundant
// noise — and stamping a tool-branded comment into others' repos was confusing. Removed; repos
// own their own .gitignore.

/** Can git actually reach this repo over SSH (the user's key) or HTTPS? This is the
 *  transport git uses, so it's the real "do I have access" test — independent of the
 *  GitHub API token (which may be absent/expired even when the repo is reachable). */
async function remoteReachable(slug: string): Promise<boolean> {
  const env = { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=12', GIT_TERMINAL_PROMPT: '0' };
  for (const remote of [`git@github.com:${slug}.git`, `https://github.com/${slug}.git`]) {
    try { await execFileP('git', ['ls-remote', remote, 'HEAD'], { timeout: 25000, env }); return true; }
    catch { /* try next transport */ }
  }
  return false;
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

/** Authenticated GitHub API call (token from the configured github MCP server).
 *  The token travels only in the Authorization header — never on a command line. */
async function githubApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
  const tok = githubToken();
  if (!tok) return { ok: false, status: 0, error: 'no GitHub token configured — add it in Capabilities → github MCP server' };
  try {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'idctl', Authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return { ok: false, status: r.status, error: (typeof data.message === 'string' && data.message) || `GitHub API ${r.status}` };
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A project's working diff (for AI-drafting a commit message). Truncated so a huge
 *  diff can't blow up a prompt; includes a --stat header + untracked file list. */
export async function projectDiff(path: string): Promise<{ ok: boolean; stat: string; diff: string; untracked: string[]; error?: string }> {
  if (!path || !existsSync(path)) return { ok: false, stat: '', diff: '', untracked: [], error: 'folder not found' };
  if (!(await isOwnRepoRoot(path))) return { ok: false, stat: '', diff: '', untracked: [], error: 'not a git repository' };
  try {
    const stat = await git(path, ['diff', '--stat', 'HEAD']).catch(() => git(path, ['diff', '--stat']).catch(() => ''));
    let diff = await git(path, ['diff', 'HEAD'], 20000).catch(() => git(path, ['diff'], 20000).catch(() => ''));
    const MAX = 12000;
    if (diff.length > MAX) diff = diff.slice(0, MAX) + `\n… (diff truncated — ${diff.length - MAX} more chars)`;
    const untracked = (await git(path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean).slice(0, 60);
    return { ok: true, stat, diff, untracked };
  } catch (e) {
    return { ok: false, stat: '', diff: '', untracked: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Create a GitHub repo for a local folder and connect it as `origin` (SSH). Inits
 *  git if needed. Does NOT auto-commit/push — that's the Request-commit flow, so we
 *  never blindly push secrets/node_modules. Returns the new repo's slug + urls. */
export async function createGithubRepo(path: string, opts: { name?: string; description?: string; private?: boolean }): Promise<{ ok: boolean; slug?: string; sshUrl?: string; htmlUrl?: string; error?: string }> {
  if (!path || !existsSync(path)) return { ok: false, error: 'folder not found' };
  if (!githubToken()) return { ok: false, error: 'no GitHub token configured — add it in Capabilities → github MCP server' };
  const name = (opts.name || basename(path)).trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || basename(path);
  try {
    // Ensure a git repo with a 'main' branch (never touch an existing repo's history).
    if (!(await isOwnRepoRoot(path))) {
      await git(path, ['init']);
      await git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => {});
    }
    const remotes = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean);
    if (remotes.includes('origin')) {
      const existing = await git(path, ['remote', 'get-url', 'origin']).catch(() => '');
      return { ok: false, error: `this folder already has an 'origin' remote${existing ? ` (${existing})` : ''}` };
    }
    const res = await githubApi('POST', '/user/repos', { name, description: opts.description || undefined, private: !!opts.private, auto_init: false });
    if (!res.ok) return { ok: false, error: res.error };
    const repo = res.data ?? {};
    const slug = String(repo.full_name ?? '');
    const sshUrl = String(repo.ssh_url ?? `git@github.com:${slug}.git`);
    const htmlUrl = String(repo.html_url ?? `https://github.com/${slug}`);
    await git(path, ['remote', 'add', 'origin', sshUrl]); // SSH — never embed the token in the remote
    return { ok: true, slug, sshUrl, htmlUrl };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || 'failed to create repo').trim() };
  }
}

/** Link a local folder to an EXISTING GitHub repo: connect it as `origin` (SSH) and
 *  fetch the remote refs (so the project is up to date). Inits git if the folder
 *  isn't a repo yet. Idempotent if already linked to the same repo. Does not merge
 *  histories — the user pulls when ready (the buttons + the commit flow handle that). */
export async function linkGithubRepo(path: string, url: string): Promise<{ ok: boolean; slug?: string; remoteUrl?: string; error?: string }> {
  if (!path || !existsSync(path)) return { ok: false, error: 'folder not found' };
  const slug = repoSlug(url);
  if (!slug) return { ok: false, error: 'not a GitHub repo URL' };
  // Confirm the repo is reachable before wiring it up. Prefer the API (gives the default
  // branch), but FALL BACK to an SSH/HTTPS reachability check — git uses SSH (the user's
  // key), so a missing/expired API token must NOT block a repo that's actually reachable.
  const meta = await githubMeta(url);
  const defBranch = (meta.ok && meta.defaultBranch) || 'main';
  if (!meta.ok && !(await remoteReachable(slug))) {
    return { ok: false, error: `can't reach ${slug} — not found via the GitHub API (${meta.error}) or over SSH/HTTPS. Check the URL and that you have access.` };
  }
  try {
    if (!(await isOwnRepoRoot(path))) {
      await git(path, ['init']);
      await git(path, ['symbolic-ref', 'HEAD', `refs/heads/${defBranch}`]).catch(() => {});
    }
    const remotes = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean);
    const sshUrl = `git@github.com:${slug}.git`;
    if (remotes.includes('origin')) {
      const existing = await git(path, ['remote', 'get-url', 'origin']).catch(() => '');
      if (repoSlug(existing) !== slug) return { ok: false, error: `already linked to a different origin (${existing}) — remove it first` };
      await git(path, ['fetch', 'origin'], 120000).catch(() => {}); // idempotent: refresh refs
      return { ok: true, slug, remoteUrl: existing || sshUrl };
    }
    await git(path, ['remote', 'add', 'origin', sshUrl]); // SSH — never embed a token
    await git(path, ['fetch', 'origin'], 120000).catch(() => {}); // pull down refs; ignore auth hiccups
    return { ok: true, slug, remoteUrl: sshUrl };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || 'failed to link repo').trim() };
  }
}

/** Fork a GitHub repo to the authenticated user, clone the fork into parentDir, and
 *  wire `upstream` to the original (so projectGit reports it as a fork). */
export async function forkGithub(url: string, parentDir: string): Promise<{ ok: boolean; path?: string; name?: string; slug?: string; error?: string }> {
  const slug = repoSlug(url);
  if (!slug) return { ok: false, error: 'not a GitHub repo URL' };
  if (!parentDir || !existsSync(parentDir)) return { ok: false, error: 'destination folder not found' };
  if (!githubToken()) return { ok: false, error: 'no GitHub token configured — add it in Capabilities → github MCP server' };
  const res = await githubApi('POST', `/repos/${slug}/forks`, {}); // 202 Accepted; repo object returned now
  if (!res.ok) return { ok: false, error: res.error };
  const fork = res.data ?? {};
  const forkSlug = String(fork.full_name ?? '');
  const name = forkSlug.split('/')[1] || slug.split('/')[1];
  const dest = join(parentDir, name);
  if (existsSync(dest)) return { ok: false, error: `folder already exists: ${dest}` };
  const sshUrl = String(fork.ssh_url ?? `git@github.com:${forkSlug}.git`);
  const httpsUrl = String(fork.clone_url ?? `https://github.com/${forkSlug}.git`);
  // GitHub forks asynchronously — the clone can fail for a few seconds; retry SSH→HTTPS.
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const remote of [sshUrl, httpsUrl]) {
      try {
        await execFileP('git', ['clone', remote, dest], { timeout: 300000 });
        await git(dest, ['remote', 'add', 'upstream', `git@github.com:${slug}.git`]).catch(() => {});
        return { ok: true, path: dest, name, slug: forkSlug };
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        lastErr = (err.stderr || err.message || 'clone failed').trim();
        try { if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); } catch { /* leave it */ }
      }
    }
    await new Promise((r) => setTimeout(r, 2000)); // wait for the fork to materialize
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
  upstreamGone?: boolean; // tracking branch deleted on the remote (orphaned) — Pull self-heals
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
    // Orphaned branch: a tracking upstream is configured but its ref is gone (e.g. a
    // merged PR branch deleted on the remote) → Pull self-heals (smartPull).
    const sb = (await git(path, ['status', '-sb']).catch(() => '')).split('\n')[0] || '';
    const upstreamGone = /\[gone\]/.test(sb);

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
    return { isRepo: true, branch, remoteUrl: remoteUrl || undefined, upstreamUrl: upstreamUrl || undefined, isFork, ahead, behind, dirty, compareRef, upstreamGone };
  } catch (e) {
    return { isRepo: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whitelisted git commands the Projects page can run. */
const GIT_ACTIONS: Record<string, string[]> = {
  fetch: ['fetch', '--all', '--prune'],
  status: ['status', '-sb'],
  log: ['log', '--oneline', '--decorate', '-15'],
  diff: ['diff', '--stat'],
};

/**
 * Resilient, STANDARDIZED pull — self-heals the common stranded states so the
 * commit/sync process stays clean across every project. Never force-pushes,
 * auto-merges, or discards work:
 *   • live upstream            → git pull --ff-only
 *   • upstream deleted after a merged PR, branch already on the default branch
 *                              → switch back to the default branch + ff + delete the stale branch
 *   • default branch, no upstream set → set it → ff
 *   • orphaned branch with UNMERGED work → leave it; tell the user to push or switch
 */
async function smartPull(path: string): Promise<{ ok: boolean; output: string }> {
  const out: string[] = [];
  const run = async (args: string[], to = 120000): Promise<{ ok: boolean; text: string }> => {
    try { const { stdout, stderr } = await execFileP('git', args, { cwd: path, timeout: to }); return { ok: true, text: `${stdout}${stderr}`.trim() }; }
    catch (e) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, text: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() }; }
  };
  const f = await run(['fetch', '--all', '--prune']);
  out.push(`$ git fetch --all --prune${f.text ? `\n${f.text}` : ' ✓'}`);

  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  const def = await defaultBranchOf(path, 'origin');
  const defRemote = `origin/${def}`;
  const haveDefRemote = await gitOk(path, ['rev-parse', '--verify', defRemote]);
  const upstreamLive = await gitOk(path, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
  const hasUpstreamCfg = !!(await git(path, ['config', `branch.${branch}.merge`]).catch(() => ''));
  const trackedDirty = (await git(path, ['status', '--porcelain']).catch(() => '')).split('\n').some((l) => l && !l.startsWith('??'));

  // Normal path: a live upstream → fast-forward only (never auto-merge/rebase).
  if (upstreamLive) {
    const p = await run(['pull', '--ff-only']);
    out.push(`$ git pull --ff-only${p.text ? `\n${p.text}` : ' ✓ already up to date'}`);
    if (!p.ok) out.push(`⚠ Can't fast-forward — you have local commits the remote doesn't. Review Log/Diff, then push or reconcile; nothing was changed.`);
    return { ok: p.ok, output: out.join('\n\n') };
  }

  // Upstream is gone or unset → heal toward the default branch.
  if (branch === def) {
    if (!haveDefRemote) { out.push(`⚠ On ${def} but no ${defRemote} exists — nothing to pull from.`); return { ok: false, output: out.join('\n\n') }; }
    await git(path, ['branch', `--set-upstream-to=${defRemote}`, def]).catch(() => {});
    const p = await run(['merge', '--ff-only', defRemote]);
    out.push(`set upstream → ${defRemote}`, `$ git merge --ff-only ${defRemote}${p.text ? `\n${p.text}` : ' ✓ already up to date'}`);
    return { ok: p.ok, output: out.join('\n\n') };
  }

  // Non-default branch, gone/absent upstream. If its work is already on the default
  // branch (a merged + auto-deleted PR branch), switch back + ff + drop the stale branch.
  const mergedIntoDefault = haveDefRemote && await gitOk(path, ['merge-base', '--is-ancestor', 'HEAD', defRemote]);
  if (mergedIntoDefault) {
    if (trackedDirty) { out.push(`⚠ '${branch}' is already merged into ${def} (its remote branch was deleted), but you have uncommitted changes here. Commit or stash them, then pull again to return to ${def}.`); return { ok: false, output: out.join('\n\n') }; }
    const co = await run(['checkout', def]);
    out.push(`'${branch}' is already merged into ${def} (remote branch deleted) → switching back to ${def}`, co.text || '✓');
    if (!co.ok) return { ok: false, output: out.join('\n\n') };
    await git(path, ['branch', `--set-upstream-to=${defRemote}`, def]).catch(() => {});
    const p = await run(['merge', '--ff-only', defRemote]);
    out.push(`$ git merge --ff-only ${defRemote}${p.text ? `\n${p.text}` : ' ✓ already up to date'}`);
    const d = await run(['branch', '-d', branch]); // -d is safe: refuses if not merged
    out.push(d.text || `deleted stale merged branch '${branch}'`);
    return { ok: true, output: out.join('\n\n') };
  }

  // Orphaned branch with UNMERGED work — don't touch; preserve it.
  out.push(`⚠ You're on '${branch}', whose remote branch is gone${hasUpstreamCfg ? ' (deleted)' : ' (never pushed)'}, and it has commits not yet on ${def}. Nothing was changed so no work is lost — push it to back it up (\`git push -u origin ${branch}\`), or switch to ${def}.`);
  return { ok: false, output: out.join('\n\n') };
}

export async function projectGitRun(path: string, action: string): Promise<{ ok: boolean; output: string }> {
  if (!path || !existsSync(path)) return { ok: false, output: 'folder not found' };
  if (action === 'pull' || action === 'sync') return smartPull(path); // self-healing pull
  const args = GIT_ACTIONS[action];
  if (!args) return { ok: false, output: `unknown git action: ${action}` };
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd: path, timeout: 90000 });
    return { ok: true, output: `${stdout}${stderr}`.trim() || '(no output)' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
}
