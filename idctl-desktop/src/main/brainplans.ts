/**
 * Profile-backed living plan store.
 *
 * Plans belong to the IDACC user profile, not to a specially named Git
 * checkout. Existing <projectsRoot>/brain/plans data is imported once,
 * read-only, so upgrades preserve prior work without continuing the coupling.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import { loadSettings } from '../../../idctl/src/settings/store.ts';
import { copyFilePrivateSync } from './privateFileCopy.ts';

const INDEX_HEADER = `# IDACC Living Plans

| # | Plan | Status | Effort | Notes |
|---:|---|---|---|---|
`;
const IMPORT_MARKER = '.legacy-import.json';

type LegacyImportSkipReason =
  | 'unsafe-entry'
  | 'unreadable-entry'
  | 'source-changed'
  | 'profile-entry-exists'
  | 'copy-failed';

type LegacyImportSourceError =
  | 'unsafe-source'
  | 'unreadable-source'
  | 'source-changed';

interface LegacyImportReport {
  importedFiles: string[];
  skipped: Array<{ file: string; reason: LegacyImportSkipReason }>;
  sourceError: LegacyImportSourceError | null;
}

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

export interface BrainPlanConsolidationRequest {
  files: string[];
  title?: string;
  configured?: string;
  expected?: Record<string, BrainPlanStatusExpectation>;
}

export interface BrainPlanConsolidationResult {
  ok: boolean;
  file?: string;
  num?: string;
  title?: string;
  status?: string;
  archived?: string[];
  error?: string;
  stale?: boolean;
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
    try {
      // Return the exact configured entry, including an unsafe direct symlink
      // or non-directory. The importer will record that rejection without
      // following it, and the one-time marker prevents endless retries.
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return candidate;
    }
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

function compareImportNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function legacyImportFailureReason(error: unknown): LegacyImportSkipReason {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '').toUpperCase();
  if (['EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(code)) return 'unreadable-entry';
  const message = error instanceof Error ? error.message : String(error);
  if (/changed (?:before|while)/i.test(message)) return 'source-changed';
  if (code === 'ELOOP' || /regular file|unsafe/i.test(message)) return 'unsafe-entry';
  return 'copy-failed';
}

function importLegacyPlans(legacy: string, destinationDir: string): LegacyImportReport {
  const report: LegacyImportReport = {
    importedFiles: [],
    skipped: [],
    sourceError: null,
  };

  let sourceDirectory: Stats;
  try {
    sourceDirectory = lstatSync(legacy);
  } catch {
    report.sourceError = 'unreadable-source';
    return report;
  }
  if (sourceDirectory.isSymbolicLink() || !sourceDirectory.isDirectory()) {
    report.sourceError = 'unsafe-source';
    return report;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(legacy, { withFileTypes: true })
      .filter((entry) => /\.md$/i.test(entry.name))
      .sort((left, right) => compareImportNames(left.name, right.name));
  } catch {
    report.sourceError = 'unreadable-source';
    return report;
  }

  for (const entry of entries) {
    const file = entry.name;
    const source = join(legacy, file);
    const destination = join(destinationDir, file);

    // Dirent metadata is only an early filter. The private copy helper repeats
    // the lstat/open/fstat identity checks and uses O_NOFOLLOW where supported.
    if (!entry.isFile() || entry.isSymbolicLink()) {
      report.skipped.push({ file, reason: 'unsafe-entry' });
      continue;
    }
    try {
      const sourceEntry = lstatSync(source);
      if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
        report.skipped.push({ file, reason: 'unsafe-entry' });
        continue;
      }
    } catch (error) {
      report.skipped.push({ file, reason: legacyImportFailureReason(error) });
      continue;
    }

    try {
      lstatSync(destination);
      report.skipped.push({ file, reason: 'profile-entry-exists' });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.skipped.push({ file, reason: legacyImportFailureReason(error) });
        continue;
      }
    }

    try {
      copyFilePrivateSync(source, destination);
      report.importedFiles.push(file);
    } catch (error) {
      report.skipped.push({ file, reason: legacyImportFailureReason(error) });
    }
  }

  // Processing is already sorted, but sort the serialized report explicitly so
  // retries, filesystems, and supported operating systems cannot reorder it.
  report.importedFiles.sort(compareImportNames);
  report.skipped.sort((left, right) => (
    compareImportNames(left.file, right.file)
    || compareImportNames(left.reason, right.reason)
  ));
  return report;
}

function ensureProfileStore(configured?: string): string {
  const dir = profilePlansDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, IMPORT_MARKER);
  const index = join(dir, 'README.md');

  if (!existsSync(marker)) {
    const legacy = legacyPlansDir(configured);
    let report: LegacyImportReport = {
      importedFiles: [],
      skipped: [],
      sourceError: null,
    };
    if (legacy && resolve(legacy) !== resolve(dir)) {
      report = importLegacyPlans(legacy, dir);
    }
    atomicWrite(marker, JSON.stringify({
      schemaVersion: 2,
      importedAt: new Date().toISOString(),
      source: legacy,
      imported: report.importedFiles.length,
      importedFiles: report.importedFiles,
      skipped: report.skipped,
      sourceError: report.sourceError,
    }, null, 2) + '\n');
  }

  if (!existsSync(index)) atomicWrite(index, INDEX_HEADER);
  return dir;
}

/** Always resolves to the app-owned profile store. */
export function brainPlansDir(configured?: string): string {
  return ensureProfileStore(configured);
}

type ParsedIndexRow = BrainPlan & {
  statusStart: number;
  statusEnd: number;
};

type IndexDocumentLine = {
  text: string;
  start: number;
  end: number;
  separator: string;
  separatorEnd: number;
};

function splitIndexDocument(source: string): IndexDocumentLine[] {
  const lines: IndexDocumentLine[] = [];
  const separators = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separators.exec(source)) !== null) {
    lines.push({
      text: source.slice(start, match.index),
      start,
      end: match.index,
      separator: match[0],
      separatorEnd: separators.lastIndex,
    });
    start = separators.lastIndex;
  }
  lines.push({
    text: source.slice(start),
    start,
    end: source.length,
    separator: '',
    separatorEnd: source.length,
  });
  return lines;
}

function preferredIndexNewline(document: IndexDocumentLine[]): string {
  return document.find((line) => line.separator)?.separator ?? '\n';
}

function insertIndexRow(
  source: string,
  document: IndexDocumentLine[],
  afterLine: number,
  row: string,
): string {
  const newline = preferredIndexNewline(document);
  if (afterLine >= 0) {
    const anchor = document[afterLine];
    if (anchor.separator) {
      return `${source.slice(0, anchor.separatorEnd)}${row}${newline}${
        source.slice(anchor.separatorEnd)
      }`;
    }
    return `${source}${newline}${row}`;
  }
  if (!source) return row;
  const hasTrailingNewline = Boolean(document.at(-2)?.separator)
    && document.at(-1)?.text === '';
  return hasTrailingNewline
    ? `${source}${row}${newline}`
    : `${source}${newline}${row}`;
}

function parseIndex(readme: string, knownFiles: ReadonlySet<string>): BrainPlan[] {
  const out: BrainPlan[] = [];
  for (const line of readme.split(/\r?\n/)) {
    const parsed = parseIndexRow(line, knownFiles);
    if (parsed) {
      const { statusStart: _statusStart, statusEnd: _statusEnd, ...plan } = parsed;
      out.push(plan);
    }
  }
  return out;
}

function decodeIndexText(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#91;/gi, '[')
    .replace(/&#93;/gi, ']')
    .replace(/&#124;/gi, '|')
    .replace(/&amp;/gi, '&');
}

function encodeIndexText(value: string): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\|/g, '&#124;');
}

function encodeLinkTarget(value: string): string {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodedLinkTargets(value: string): string[] {
  const raw = String(value).trim().replace(/^\.\//, '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A legacy literal percent remains a valid filename candidate.
  }
  return [...new Set([decoded, raw])]
    .filter((candidate) => (
      candidate === basename(candidate)
      && /\.md$/i.test(candidate)
      && candidate.toLowerCase() !== 'readme.md'
    ));
}

function normalizePlanTitle(value: string, maxLength?: number): string {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    || 'Untitled plan';
  return typeof maxLength === 'number' ? normalized.slice(0, maxLength) : normalized;
}

function parseIndexRow(
  line: string,
  knownFiles?: ReadonlySet<string>,
  expectedFile?: string,
): ParsedIndexRow | null {
  const finalBar = line.trimEnd().length - 1;
  if (finalBar < 1 || line[finalBar] !== '|') return null;

  const firstBar = line.indexOf('|');
  const numberEnd = firstBar >= 0 ? line.indexOf('|', firstBar + 1) : -1;
  if (firstBar < 0 || numberEnd < 0) return null;

  let linkStart = numberEnd + 1;
  while (/\s/.test(line[linkStart] ?? '')) linkStart += 1;
  if (line[linkStart] !== '[') return null;

  const candidates: ParsedIndexRow[] = [];
  let titleEnd = line.indexOf('](', linkStart + 1);
  while (titleEnd >= 0 && titleEnd < finalBar) {
    let targetEnd = line.indexOf(')', titleEnd + 2);
    while (targetEnd >= 0 && targetEnd < finalBar) {
      let linkSeparator = targetEnd + 1;
      while (/\s/.test(line[linkSeparator] ?? '')) linkSeparator += 1;
      if (line[linkSeparator] === '|') {
        const statusSeparator = line.indexOf('|', linkSeparator + 1);
        const effortSeparator = statusSeparator >= 0
          ? line.indexOf('|', statusSeparator + 1)
          : -1;
        if (
          statusSeparator > linkSeparator
          && effortSeparator > statusSeparator
          && finalBar > effortSeparator
        ) {
          const target = line.slice(titleEnd + 2, targetEnd);
          for (const file of decodedLinkTargets(target)) {
            if (expectedFile && file !== expectedFile) continue;
            if (knownFiles && !knownFiles.has(file)) continue;

            const statusCell = line.slice(linkSeparator + 1, statusSeparator);
            const leadingStatusSpace = /^\s*/.exec(statusCell)?.[0].length ?? 0;
            const trailingStatusSpace = /\s*$/.exec(statusCell)?.[0].length ?? 0;
            const statusStart = linkSeparator + 1 + leadingStatusSpace;
            const statusEnd = Math.max(statusStart, statusSeparator - trailingStatusSpace);
            candidates.push({
              num: decodeIndexText(line.slice(firstBar + 1, numberEnd).trim()) || undefined,
              title: decodeIndexText(line.slice(linkStart + 1, titleEnd).trim()),
              file,
              status: decodeIndexText(statusCell.trim()) || undefined,
              effort: decodeIndexText(
                line.slice(statusSeparator + 1, effortSeparator).trim(),
              ) || undefined,
              // Notes are the final table field and may contain literal pipes
              // in a retained legacy row. Keep the complete remainder.
              notes: decodeIndexText(
                line.slice(effortSeparator + 1, finalBar).trim(),
              ) || undefined,
              statusStart,
              statusEnd,
            });
          }
        }
      }
      targetEnd = line.indexOf(')', targetEnd + 1);
    }
    titleEnd = line.indexOf('](', titleEnd + 2);
  }

  // An exact expected/known filename disambiguates legacy titles and targets
  // that themselves contain Markdown link punctuation.
  return candidates[0] ?? null;
}

function formatIndexRow(plan: BrainPlan): string {
  return `| ${encodeIndexText(plan.num ?? '')} | [${
    encodeIndexText(normalizePlanTitle(plan.title))
  }](${encodeLinkTarget(plan.file)}) | ${encodeIndexText(plan.status ?? '')} | ${
    encodeIndexText(plan.effort ?? '')
  } | ${encodeIndexText(plan.notes ?? '')} |`;
}

function fallbackPlanTitle(dir: string, file: string): string {
  try {
    const heading = readFileSync(join(dir, file), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1])
      .find((value): value is string => Boolean(value));
    if (heading) return normalizePlanTitle(heading.replace(/^Plan\s+\d+\s*[-:–—]\s*/i, ''));
  } catch {
    // Fall through to the deterministic filename-derived title.
  }
  return normalizePlanTitle(
    file.replace(/\.md$/i, '').replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' '),
  );
}

function containedPlanFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && /\.md$/i.test(entry.name)
      && entry.name.toLowerCase() !== 'readme.md'
      && isContained(dir, resolve(dir, entry.name))
    ))
    .map((entry) => entry.name)
    // Use code-point ordering rather than locale-sensitive sorting so the same
    // profile produces the same plan order on every supported operating system.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function listBrainPlans(configured?: string): { dir: string; plans: BrainPlan[] } {
  const dir = brainPlansDir(configured);
  const files = containedPlanFiles(dir);
  const knownFiles = new Set(files);
  let indexed: BrainPlan[] = [];
  const index = join(dir, 'README.md');
  try {
    indexed = parseIndex(readFileSync(index, 'utf8'), knownFiles);
  } catch {
    /* merge filesystem plans only */
  }
  const indexedByFile = new Map<string, BrainPlan>();
  for (const plan of indexed) {
    if (!indexedByFile.has(plan.file)) indexedByFile.set(plan.file, plan);
  }
  const plans = files.map((file) => (
    indexedByFile.get(file) ?? { file, title: fallbackPlanTitle(dir, file) }
  ));
  for (const plan of plans) {
    try {
      const full = resolve(dir, plan.file);
      if (isContained(dir, full) && lstatSync(full).isFile()) plan.mtime = statSync(full).mtimeMs;
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
  try {
    if (!lstatSync(full).isFile()) return null;
  } catch {
    return null;
  }
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

function expectedStatusChanged(
  expected: BrainPlanStatusExpectation | undefined,
  current: string | undefined,
): boolean {
  return Boolean(
    expected
    && Object.prototype.hasOwnProperty.call(expected, 'status')
    && String(expected.status ?? '').trim() !== String(current ?? '').trim(),
  );
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
  const cleanTitle = normalizePlanTitle(title, 120);
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

    const indexSource = readFileSync(index, 'utf8');
    const document = splitIndexDocument(indexSource);
    const lines = document.map((line) => line.text);
    let lastRow = -1;
    for (let i = 0; i < lines.length; i += 1) if (/^\|\s*\d+\s*\|/.test(lines[i])) lastRow = i;
    const row = formatIndexRow({
      num,
      title: cleanTitle,
      file,
      status: '⏳ PENDING',
      effort: 'planning+build',
      notes: 'Created in IDACC.',
    });
    atomicWrite(index, insertIndexRow(indexSource, document, lastRow, row));
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
  if (!/\.md$/i.test(safe) || safe.toLowerCase() === 'readme.md') {
    return { ok: false, error: 'invalid plan file' };
  }
  const label = normStatusLabel(status);
  if (!label) return { ok: false, error: `unrecognized status "${status}"` };
  const index = join(dir, 'README.md');
  try {
    const planPath = resolve(dir, safe);
    const planIsRegular = isContained(dir, planPath)
      && existsSync(planPath)
      && lstatSync(planPath).isFile();
    if (!planIsRegular) {
      return { ok: false, error: 'plan file is missing or is not a regular profile file' };
    }
    const currentMtime = statSync(planPath).mtimeMs;
    const indexSource = readFileSync(index, 'utf8');
    const document = splitIndexDocument(indexSource);
    const lines = document.map((line) => line.text);
    let from: string | undefined;
    let changed = false;
    let updatedIndex: string | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = parseIndexRow(lines[i], new Set([safe]), safe);
      if (!parsed || parsed.file !== safe) continue;
      from = parsed.status;
      const expectedMtime = typeof expected?.mtime === 'number' ? expected.mtime : undefined;
      if (
        expectedStatusChanged(expected, from)
        || (expectedMtime != null && (currentMtime == null || Math.abs(currentMtime - expectedMtime) > 0.5))
      ) {
        return {
          ok: false,
          error: 'plan changed since it was reviewed; refresh before writing status',
          stale: true,
          current: { status: from, mtime: currentMtime },
        };
      }
      // Existing profile rows are user-owned data. Replace only the status
      // payload, retaining title length, link spelling, effort, notes, spacing,
      // and any legacy literal pipes byte-for-byte.
      const updatedLine = `${lines[i].slice(0, parsed.statusStart)}${
        encodeIndexText(label)
      }${lines[i].slice(parsed.statusEnd)}`;
      updatedIndex = `${indexSource.slice(0, document[i].start)}${updatedLine}${
        indexSource.slice(document[i].end)
      }`;
      changed = true;
      break;
    }
    if (!changed) {
      const expectedMtime = typeof expected?.mtime === 'number' ? expected.mtime : undefined;
      if (
        expectedStatusChanged(expected, undefined)
        || (expectedMtime != null && (currentMtime == null || Math.abs(currentMtime - expectedMtime) > 0.5))
      ) {
        return {
          ok: false,
          error: 'plan changed since it was reviewed; refresh before writing status',
          stale: true,
          current: { status: undefined, mtime: currentMtime },
        };
      }
      const recovered = formatIndexRow({
        num: /^(\d+)/.exec(safe)?.[1],
        title: fallbackPlanTitle(dir, safe),
        file: safe,
        status: label,
        effort: 'recovered',
        notes: 'Recovered from a profile plan file.',
      });
      let lastRow = -1;
      const knownFiles = new Set(containedPlanFiles(dir));
      for (let i = 0; i < lines.length; i += 1) {
        if (parseIndexRow(lines[i], knownFiles)) lastRow = i;
      }
      updatedIndex = insertIndexRow(indexSource, document, lastRow, recovered);
      changed = true;
    }
    atomicWrite(index, updatedIndex ?? indexSource);
    return { ok: true, from, to: label };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function consolidationStatus(plans: BrainPlan[]): string {
  const statuses = plans.map((plan) => normStatusLabel(plan.status ?? '') ?? '⏳ PENDING');
  if (statuses.every((status) => status === '✅ DONE')) return '✅ DONE';
  if (statuses.some((status) => status === '🛑 ON HOLD')) return '🛑 ON HOLD';
  if (statuses.some((status) => status === '🔄 PARTIAL' || status === '✅ DONE')) return '🔄 PARTIAL';
  return '⏳ PENDING';
}

/**
 * Consolidate multiple profile-owned plans into one recoverable record.
 *
 * Source documents are copied into the profile's private archive before any
 * active record changes. The index and source mtimes are revalidated before
 * commit; a failure restores the original index and source files.
 */
export function consolidateBrainPlans(
  request: BrainPlanConsolidationRequest,
): BrainPlanConsolidationResult {
  const rawFiles = Array.isArray(request?.files) ? request.files.map((file) => String(file || '')) : [];
  if (rawFiles.length < 2 || rawFiles.length > 12) {
    return { ok: false, error: 'choose between 2 and 12 plans to consolidate' };
  }
  const files = rawFiles.map((file) => basename(file));
  if (
    new Set(files).size !== files.length
    || files.some((file, index) => (
      file !== rawFiles[index]
      || !/\.md$/i.test(file)
      || file.toLowerCase() === 'readme.md'
    ))
  ) {
    return { ok: false, error: 'plan selection contains an invalid or duplicate file' };
  }

  const dir = brainPlansDir(request.configured);
  const index = join(dir, 'README.md');
  const listed = listBrainPlans(request.configured).plans;
  const selected = files.map((file) => listed.find((plan) => plan.file === file));
  if (selected.some((plan) => !plan)) {
    return { ok: false, error: 'one or more selected plans no longer exist', stale: true };
  }
  const plans = selected as BrainPlan[];
  for (const plan of plans) {
    const expected = request.expected?.[plan.file];
    if (
      expectedStatusChanged(expected, plan.status)
      || (
        typeof expected?.mtime === 'number'
        && (typeof plan.mtime !== 'number' || Math.abs(plan.mtime - expected.mtime) > 0.5)
      )
    ) {
      return { ok: false, error: 'a selected plan changed; refresh before consolidating', stale: true };
    }
  }

  const sourcePaths = files.map((file) => resolve(dir, file));
  const sourceStats = new Map<string, Stats>();
  try {
    for (let i = 0; i < files.length; i += 1) {
      const source = sourcePaths[i];
      const stats = lstatSync(source);
      if (!isContained(dir, source) || stats.isSymbolicLink() || !stats.isFile()) {
        return { ok: false, error: `${files[i]} is not a regular profile plan`, stale: true };
      }
      sourceStats.set(files[i], stats);
    }
  } catch {
    return { ok: false, error: 'a selected plan changed; refresh before consolidating', stale: true };
  }

  const numbers = containedPlanFiles(dir)
    .map((name) => /^(\d+)/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const num = String(next).padStart(2, '0');
  const sourceNums = plans.map((plan) => plan.num || /^(\d+)/.exec(plan.file)?.[1] || plan.file);
  const title = normalizePlanTitle(
    request.title?.trim() || `Consolidated plans ${sourceNums.join(' + ')}`,
    120,
  );
  const file = `${num}-${slugify(title)}.md`;
  const destination = resolve(dir, file);
  if (!isContained(dir, destination) || existsSync(destination)) {
    return { ok: false, error: 'the consolidated plan destination is not available' };
  }

  let indexSource = '';
  let indexMtime = 0;
  const contents = new Map<string, string>();
  try {
    indexSource = readFileSync(index, 'utf8');
    indexMtime = statSync(index).mtimeMs;
    for (let i = 0; i < files.length; i += 1) {
      contents.set(files[i], readFileSync(sourcePaths[i], 'utf8'));
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const selectedSet = new Set(files);
  const indexDocument = splitIndexDocument(indexSource);
  const indexWithoutSources = indexDocument
    .filter((line) => !parseIndexRow(line.text, selectedSet))
    .map((line) => `${line.text}${line.separator}`)
    .join('');
  const remainingDocument = splitIndexDocument(indexWithoutSources);
  let lastRow = -1;
  const remainingFiles = new Set(containedPlanFiles(dir).filter((candidate) => !selectedSet.has(candidate)));
  for (let i = 0; i < remainingDocument.length; i += 1) {
    if (parseIndexRow(remainingDocument[i].text, remainingFiles)) lastRow = i;
  }
  const status = consolidationStatus(plans);
  const effort = [...new Set(plans.map((plan) => plan.effort).filter(Boolean))].join(' + ') || 'consolidated';
  const newRow = formatIndexRow({
    num,
    title,
    file,
    status,
    effort,
    notes: `Consolidates plans ${sourceNums.join(', ')}; source files archived.`,
  });
  const updatedIndex = insertIndexRow(indexWithoutSources, remainingDocument, lastRow, newRow);
  const body = plans.map((plan) => {
    const source = contents.get(plan.file)?.trimEnd() ?? '';
    return `## Source plan ${plan.num ?? plan.file} — ${plan.title}\n\n`
      + `<!-- IDACC consolidated source: ${plan.file} -->\n${source}\n`
      + `<!-- End IDACC consolidated source: ${plan.file} -->`;
  }).join('\n\n---\n\n');
  const consolidated = `# Plan ${next} - ${title}\n\n`
    + `This record consolidates plans ${sourceNums.join(', ')}. The original files are retained in the private plan archive.\n\n`
    + `${body}\n`;

  const archiveDir = join(dir, 'archive');
  const archivedPaths: string[] = [];
  const removedSources: string[] = [];
  let destinationWritten = false;
  let indexWritten = false;
  try {
    if (existsSync(archiveDir)) {
      const archiveStats = lstatSync(archiveDir);
      if (archiveStats.isSymbolicLink() || !archiveStats.isDirectory()) {
        throw new Error('private plan archive is not a safe directory');
      }
    } else {
      mkdirSync(archiveDir, { mode: 0o700 });
    }
    for (let i = 0; i < files.length; i += 1) {
      const archived = resolve(archiveDir, files[i]);
      if (!isContained(archiveDir, archived) || existsSync(archived)) {
        throw new Error(`archive already contains ${files[i]}`);
      }
      copyFilePrivateSync(sourcePaths[i], archived);
      archivedPaths.push(archived);
    }

    atomicWrite(destination, consolidated);
    destinationWritten = true;

    if (Math.abs(statSync(index).mtimeMs - indexMtime) > 0.5) {
      throw new Error('the plan index changed; refresh before consolidating');
    }
    for (const fileName of files) {
      const before = sourceStats.get(fileName)!;
      const current = lstatSync(resolve(dir, fileName));
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || current.size !== before.size
        || Math.abs(current.mtimeMs - before.mtimeMs) > 0.5
      ) {
        throw new Error(`${fileName} changed; refresh before consolidating`);
      }
    }

    atomicWrite(index, updatedIndex);
    indexWritten = true;
    for (const fileName of files) {
      const source = resolve(dir, fileName);
      const before = sourceStats.get(fileName)!;
      const current = lstatSync(source);
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || current.size !== before.size
        || Math.abs(current.mtimeMs - before.mtimeMs) > 0.5
      ) {
        throw new Error(`${fileName} changed before archival; the consolidation was rolled back`);
      }
      rmSync(source);
      removedSources.push(fileName);
    }
    return {
      ok: true,
      file,
      num,
      title,
      status,
      archived: files.map((source) => `archive/${source}`),
    };
  } catch (error) {
    let rollbackFailed = false;
    for (const fileName of removedSources) {
      const source = resolve(dir, fileName);
      const archived = resolve(archiveDir, fileName);
      try {
        if (!existsSync(source) && existsSync(archived)) copyFilePrivateSync(archived, source);
      } catch { rollbackFailed = true; }
    }
    try { if (indexWritten) atomicWrite(index, indexSource); } catch { rollbackFailed = true; }
    try { if (destinationWritten) rmSync(destination, { force: true }); } catch { rollbackFailed = true; }
    if (!rollbackFailed) {
      for (const archived of archivedPaths) {
        try { rmSync(archived, { force: true }); } catch { /* retained recovery copy */ }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: rollbackFailed
        ? `${message}; recovery copies remain in the private plan archive`
        : message,
      stale: /changed|refresh/i.test(message),
    };
  }
}
