/**
 * Profile-backed living plan store.
 *
 * Plans belong to the IDACC user profile, not to a specially named Git
 * checkout. Existing <projectsRoot>/brain/plans data is imported once,
 * read-only, so upgrades preserve prior work without continuing the coupling.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import { loadSettings } from '../../../idctl/src/settings/store.ts';

const INDEX_HEADER = `# IDACC Living Plans

| # | Plan | Status | Effort | Notes |
|---:|---|---|---|---|
`;
const IMPORT_MARKER = '.legacy-import.json';

export interface BrainPlan {
  num?: string;
  title: string;
  file: string;
  status?: string;
  effort?: string;
  notes?: string;
  mtime?: number;
}

export interface BrainPlanStatusExpectation {
  status?: string;
  mtime?: number;
}

function profilePlansDir(): string {
  return join(configDir(resolveConfigPath()), 'brain-plans');
}

function legacyPlansDir(configured?: string): string | null {
  const roots = new Set<string>();
  const saved = configured ?? loadSettings().projectsRoot;
  if (saved?.trim()) roots.add(resolve(saved.trim()));
  if (process.env.IDACC_LEGACY_PROJECTS_ROOT?.trim()) {
    roots.add(resolve(process.env.IDACC_LEGACY_PROJECTS_ROOT.trim()));
  }
  // Never probe a fresh consumer's home directory or current working directory.
  // Import is allowed only from a projectsRoot already saved in this profile or
  // from the explicit one-time IDACC_LEGACY_PROJECTS_ROOT override.
  for (const root of roots) {
    const candidate = join(root, 'brain', 'plans');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isContained(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function ensureProfileStore(configured?: string): string {
  const dir = profilePlansDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, IMPORT_MARKER);
  const index = join(dir, 'README.md');

  if (!existsSync(marker)) {
    const legacy = legacyPlansDir(configured);
    let imported = 0;
    if (legacy && resolve(legacy) !== resolve(dir)) {
      for (const name of readdirSync(legacy)) {
        if (!/\.md$/i.test(name)) continue;
        const source = join(legacy, name);
        const destination = join(dir, basename(name));
        if (existsSync(destination)) continue;
        copyFileSync(source, destination);
        try { chmodSync(destination, 0o600); } catch { /* best effort */ }
        imported += 1;
      }
    }
    atomicWrite(marker, JSON.stringify({
      schemaVersion: 1,
      importedAt: new Date().toISOString(),
      source: legacy,
      imported,
    }, null, 2) + '\n');
  }

  if (!existsSync(index)) atomicWrite(index, INDEX_HEADER);
  return dir;
}

/** Always resolves to the app-owned profile store. */
export function brainPlansDir(configured?: string): string {
  return ensureProfileStore(configured);
}

function parseIndex(readme: string): BrainPlan[] {
  const out: BrainPlan[] = [];
  for (const line of readme.split(/\r?\n/)) {
    const match = /^\s*\|\s*([^|]*?)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!match) continue;
    const file = basename(match[3].trim().replace(/^\.\//, ''));
    if (!/\.md$/i.test(file)) continue;
    out.push({
      num: match[1].trim() || undefined,
      title: match[2].trim(),
      file,
      status: match[4].trim() || undefined,
      effort: match[5].trim() || undefined,
      notes: match[6].trim() || undefined,
    });
  }
  return out;
}

export function listBrainPlans(configured?: string): { dir: string; plans: BrainPlan[] } {
  const dir = brainPlansDir(configured);
  let plans: BrainPlan[] = [];
  const index = join(dir, 'README.md');
  try { plans = parseIndex(readFileSync(index, 'utf8')); } catch { /* use fallback */ }
  if (!plans.length) {
    plans = readdirSync(dir)
      .filter((name) => /\.md$/i.test(name) && name.toLowerCase() !== 'readme.md')
      .sort()
      .map((file) => ({
        file,
        title: file.replace(/\.md$/i, '').replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' '),
      }));
  }
  for (const plan of plans) {
    try {
      const full = resolve(dir, plan.file);
      if (isContained(dir, full)) plan.mtime = statSync(full).mtimeMs;
    } catch { /* missing plan is omitted from freshness metadata */ }
  }
  return { dir, plans };
}

export function getBrainPlan(file: string, configured?: string): { file: string; content: string } | null {
  const dir = brainPlansDir(configured);
  const safe = basename(String(file || ''));
  if (!/\.md$/i.test(safe) || safe.toLowerCase() === 'readme.md') return null;
  const full = resolve(dir, safe);
  if (!isContained(dir, full) || !existsSync(full)) return null;
  try { return { file: safe, content: readFileSync(full, 'utf8') }; } catch { return null; }
}

function normStatusLabel(status: string): string | null {
  const value = String(status || '').toLowerCase();
  if (/done|✅/.test(value)) return '✅ DONE';
  if (/partial|🔄|progress/.test(value)) return '🔄 PARTIAL';
  if (/hold|pause|paused|blocked|🛑/.test(value)) return '🛑 ON HOLD';
  if (/pending|⏳|todo|not started/.test(value)) return '⏳ PENDING';
  return null;
}

function slugify(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
}

export function createBrainPlan(
  title: string,
  content: string,
  configured?: string,
): { ok: boolean; file?: string; num?: string; persisted?: boolean; committed?: boolean; error?: string } {
  const dir = brainPlansDir(configured);
  const index = join(dir, 'README.md');
  const cleanTitle = String(title || 'Untitled plan').trim().slice(0, 120);
  try {
    const numbers = readdirSync(dir)
      .map((name) => /^(\d+)/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    const num = String(next).padStart(2, '0');
    const file = `${num}-${slugify(cleanTitle)}.md`;
    const full = resolve(dir, file);
    if (!isContained(dir, full)) return { ok: false, error: 'invalid plan path' };
    if (existsSync(full)) return { ok: false, error: `${file} already exists` };

    const body = String(content || '').trim().replace(/^#\s+.*(\r?\n)+/, '');
    atomicWrite(full, `# Plan ${next} - ${cleanTitle}\n\n${body}\n`);

    const lines = readFileSync(index, 'utf8').split(/\r?\n/);
    let lastRow = -1;
    for (let i = 0; i < lines.length; i += 1) if (/^\|\s*\d+\s*\|/.test(lines[i])) lastRow = i;
    const row = `| ${num} | [${cleanTitle}](${file}) | ⏳ PENDING | planning+build | Created in IDACC. |`;
    if (lastRow >= 0) lines.splice(lastRow + 1, 0, row);
    else lines.push(row);
    atomicWrite(index, lines.join('\n'));
    return { ok: true, file, num, persisted: true, committed: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function setBrainPlanStatus(
  file: string,
  status: string,
  configured?: string,
  expected?: BrainPlanStatusExpectation,
): { ok: boolean; from?: string; to?: string; error?: string; stale?: boolean; current?: { status?: string; mtime?: number } } {
  const dir = brainPlansDir(configured);
  const safe = basename(String(file || ''));
  if (!/\.md$/i.test(safe)) return { ok: false, error: 'invalid plan file' };
  const label = normStatusLabel(status);
  if (!label) return { ok: false, error: `unrecognized status "${status}"` };
  const index = join(dir, 'README.md');
  try {
    const planPath = resolve(dir, safe);
    const currentMtime = isContained(dir, planPath) && existsSync(planPath)
      ? statSync(planPath).mtimeMs
      : undefined;
    const lines = readFileSync(index, 'utf8').split(/\r?\n/);
    let from: string | undefined;
    let changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(`](${safe})`) && !lines[i].includes(`](./${safe})`)) continue;
      const parts = lines[i].split('|');
      if (parts.length < 6) continue;
      from = parts[3].trim();
      const expectedStatus = String(expected?.status ?? '').trim();
      const expectedMtime = typeof expected?.mtime === 'number' ? expected.mtime : undefined;
      if (
        (expectedStatus && from !== expectedStatus)
        || (expectedMtime != null && (currentMtime == null || Math.abs(currentMtime - expectedMtime) > 0.5))
      ) {
        return {
          ok: false,
          error: 'plan changed since it was reviewed; refresh before writing status',
          stale: true,
          current: { status: from, mtime: currentMtime },
        };
      }
      parts[3] = ` ${label} `;
      lines[i] = parts.join('|');
      changed = true;
      break;
    }
    if (!changed) return { ok: false, error: 'plan row not found in profile index' };
    atomicWrite(index, lines.join('\n'));
    return { ok: true, from, to: label };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
