import { app } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WIKI_FILE = 'CONTROL_CENTER_WIKI.json';
let wikiCache: { path: string; mtimeMs: number; doc: unknown } | null = null;

function uniq(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function candidates(): string[] {
  const envPath = process.env.IDCTL_WIKI_PATH ? resolve(process.env.IDCTL_WIKI_PATH) : '';
  const appPath = app.getAppPath();
  const cwd = process.cwd();
  const resources = process.resourcesPath || '';
  return uniq([
    envPath,
    join(appPath, '..', 'docs', WIKI_FILE),
    join(appPath, 'docs', WIKI_FILE),
    resources ? join(resources, 'docs', WIKI_FILE) : '',
    join(cwd, '..', 'docs', WIKI_FILE),
    join(cwd, 'docs', WIKI_FILE),
  ]);
}

function wikiPath(): string {
  const found = candidates().find((p) => existsSync(p));
  if (!found) throw new Error(`wiki file not found (${candidates().join(', ')})`);
  return found;
}

export function readWiki(): { path: string; mtimeMs: number; loadedAt: number; doc: unknown } {
  const path = wikiPath();
  const st = statSync(path);
  if (wikiCache && wikiCache.path === path && wikiCache.mtimeMs === st.mtimeMs) {
    return { ...wikiCache, loadedAt: Date.now() };
  }
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw) as unknown;
  wikiCache = { path, mtimeMs: st.mtimeMs, doc };
  return { path, mtimeMs: st.mtimeMs, loadedAt: Date.now(), doc };
}
