import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import { auditPreview, estimateTokens, optimizeAskCommandCore, type ContextBudgetDecision, type ContextBudgetOptions } from '../shared/contextBudget.ts';

export interface ContextBudgetRecord {
  id: string;
  createdAt: number;
  source: string;
  team?: string;
  target?: string;
  route: ContextBudgetDecision['route'];
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  transforms: string[];
  reasons: string[];
  guardrails: string[];
  originalHash: string;
  sentHash: string;
  originalPreview: string;
  sentPreview: string;
  redactions: string[];
  previewTruncated: boolean;
  rawPromptPersisted: false;
}

export interface ContextBudgetMeasurement {
  inspected: number;
  optimized: number;
  direct: number;
  protectedDirect: number;
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  bySource: Record<string, number>;
  byTeam: Record<string, number>;
  byRoute: Record<string, number>;
  byTransform: Record<string, number>;
  byProtectedContent: Record<string, number>;
}

export interface ContextBudgetPersistentStats {
  updatedAt: number;
  storageFile: string;
  allTime: ContextBudgetMeasurement;
  today: ContextBudgetMeasurement;
  last7Days: ContextBudgetMeasurement;
}

export interface ContextBudgetReport {
  coreEnabled: true;
  frontendSurface: 'hidden';
  inspected: number;
  optimized: number;
  direct: number;
  protectedDirect: number;
  originalTokens: number;
  sentTokens: number;
  savedTokens: number;
  savingsRatio: number;
  recent: ContextBudgetRecord[];
  storageDir: string;
  persisted: ContextBudgetPersistentStats;
  policy: {
    route: 'deterministic-first';
    headroomEngine: 'not-required-for-core-budgeting';
    retrieval: 'hashes-and-redacted-previews-only';
    retention: typeof CONTEXT_BUDGET_RETENTION;
  };
  qualityGuards: string[];
}

export type ContextBudgetDecisionView = Omit<ContextBudgetDecision, 'command' | 'originalCommand'> & {
  originalPreview: string;
  commandPreview: string;
  redactions: string[];
  previewTruncated: boolean;
  rawPromptPersisted: false;
};

const MAX_RECENT = 80;
export const CONTEXT_BUDGET_RETENTION = {
  auditDays: 30,
  maxAuditRecords: 2_000,
  maxAuditBytes: 32 * 1024 * 1024,
  dailyStatsDays: 90,
} as const;
const recent: ContextBudgetRecord[] = [];
type MutableMeasurement = Omit<ContextBudgetMeasurement, 'savingsRatio'>;
interface StatsFile {
  version: 1;
  updatedAt: number;
  allTime: MutableMeasurement;
  days: Record<string, MutableMeasurement>;
}
const totals = {
  inspected: 0,
  optimized: 0,
  direct: 0,
  protectedDirect: 0,
  originalTokens: 0,
  sentTokens: 0,
  savedTokens: 0,
};
let migratedStoredRecords = false;
let statsCache: StatsFile | null = null;
let recordsSinceRetention = 0;

function budgetDir(): string {
  const profileRoot = process.env.IDACC_DATA_DIR?.trim();
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  const cacheRoot = profileRoot
    ? join(profileRoot, 'cache')
    : xdgCache && isAbsolute(xdgCache)
      ? xdgCache
      : join(configDir(resolveConfigPath()), 'cache');
  const dir = join(cacheRoot, 'context-budget');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function statsFile(): string {
  return join(budgetDir(), 'stats.json');
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function recordId(hash: string): string {
  return `cb_${Date.now().toString(36)}_${hash.slice(0, 12)}`;
}

function writeRecord(record: ContextBudgetRecord): void {
  const dir = budgetDir();
  const file = join(dir, `${record.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup */ }
    throw err;
  }
  recordsSinceRetention += 1;
  if (recordsSinceRetention >= 25) {
    recordsSinceRetention = 0;
    pruneContextBudgetStorage();
  }
}

function emptyMeasurement(): MutableMeasurement {
  return {
    inspected: 0,
    optimized: 0,
    direct: 0,
    protectedDirect: 0,
    originalTokens: 0,
    sentTokens: 0,
    savedTokens: 0,
    bySource: {},
    byTeam: {},
    byRoute: {},
    byTransform: {},
    byProtectedContent: {},
  };
}

function cleanCountMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = String(key || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const count = Number(raw);
    if (cleanKey && Number.isFinite(count) && count > 0) out[cleanKey] = Math.floor(count);
  }
  return out;
}

function normalizeMeasurement(raw: unknown): MutableMeasurement {
  const input = raw && typeof raw === 'object' ? raw as Partial<MutableMeasurement> : {};
  return {
    inspected: Math.max(0, Math.floor(Number(input.inspected) || 0)),
    optimized: Math.max(0, Math.floor(Number(input.optimized) || 0)),
    direct: Math.max(0, Math.floor(Number(input.direct) || 0)),
    protectedDirect: Math.max(0, Math.floor(Number(input.protectedDirect) || 0)),
    originalTokens: Math.max(0, Math.floor(Number(input.originalTokens) || 0)),
    sentTokens: Math.max(0, Math.floor(Number(input.sentTokens) || 0)),
    savedTokens: Math.max(0, Math.floor(Number(input.savedTokens) || 0)),
    bySource: cleanCountMap(input.bySource),
    byTeam: cleanCountMap(input.byTeam),
    byRoute: cleanCountMap(input.byRoute),
    byTransform: cleanCountMap(input.byTransform),
    byProtectedContent: cleanCountMap(input.byProtectedContent),
  };
}

function measurementView(bucket: MutableMeasurement): ContextBudgetMeasurement {
  return {
    ...bucket,
    savingsRatio: bucket.originalTokens > 0 ? bucket.savedTokens / bucket.originalTokens : 0,
  };
}

function addMapValue(map: Record<string, number>, key: string | undefined, amount = 1): void {
  const clean = String(key || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown';
  map[clean] = (map[clean] ?? 0) + amount;
}

function addMeasurement(target: MutableMeasurement, decision: ContextBudgetDecision): void {
  target.inspected += 1;
  target.originalTokens += decision.originalTokens;
  target.sentTokens += decision.sentTokens;
  target.savedTokens += decision.savedTokens;
  if (decision.changed) target.optimized += 1;
  else target.direct += 1;
  if (decision.protectedContent.length) target.protectedDirect += 1;
  addMapValue(target.bySource, decision.source);
  addMapValue(target.byTeam, decision.team ?? 'default');
  addMapValue(target.byRoute, decision.route);
  for (const transform of decision.transforms) addMapValue(target.byTransform, transform);
  for (const label of decision.protectedContent) addMapValue(target.byProtectedContent, label);
}

function mergeMeasurement(into: MutableMeasurement, from: MutableMeasurement): MutableMeasurement {
  into.inspected += from.inspected;
  into.optimized += from.optimized;
  into.direct += from.direct;
  into.protectedDirect += from.protectedDirect;
  into.originalTokens += from.originalTokens;
  into.sentTokens += from.sentTokens;
  into.savedTokens += from.savedTokens;
  for (const [key, count] of Object.entries(from.bySource)) addMapValue(into.bySource, key, count);
  for (const [key, count] of Object.entries(from.byTeam)) addMapValue(into.byTeam, key, count);
  for (const [key, count] of Object.entries(from.byRoute)) addMapValue(into.byRoute, key, count);
  for (const [key, count] of Object.entries(from.byTransform)) addMapValue(into.byTransform, key, count);
  for (const [key, count] of Object.entries(from.byProtectedContent)) addMapValue(into.byProtectedContent, key, count);
  return into;
}

function normalizeStats(raw: unknown): StatsFile {
  const input = raw && typeof raw === 'object' ? raw as Partial<StatsFile> : {};
  const days: Record<string, MutableMeasurement> = {};
  const rawDays = input.days && typeof input.days === 'object' ? input.days : {};
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (CONTEXT_BUDGET_RETENTION.dailyStatsDays - 1));
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  for (const [day, value] of Object.entries(rawDays)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoffDay) days[day] = normalizeMeasurement(value);
  }
  return {
    version: 1,
    updatedAt: Math.max(0, Math.floor(Number(input.updatedAt) || 0)),
    allTime: normalizeMeasurement(input.allTime),
    days,
  };
}

function loadStats(): StatsFile {
  if (statsCache) return statsCache;
  try {
    statsCache = normalizeStats(JSON.parse(readFileSync(statsFile(), 'utf8')) as unknown);
  } catch {
    statsCache = { version: 1, updatedAt: 0, allTime: emptyMeasurement(), days: {} };
  }
  return statsCache;
}

function saveStats(stats: StatsFile): void {
  const file = statsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup */ }
    throw err;
  }
}

function recordPersistentMeasurement(decision: ContextBudgetDecision): void {
  try {
    const stats = loadStats();
    const day = new Date().toISOString().slice(0, 10);
    addMeasurement(stats.allTime, decision);
    addMeasurement(stats.days[day] ??= emptyMeasurement(), decision);
    stats.updatedAt = Date.now();
    saveStats(stats);
  } catch {
    /* Measurement is best-effort; dispatch must not fail because stats could not write. */
  }
}

function persistentStatsView(): ContextBudgetPersistentStats {
  const stats = loadStats();
  const todayKey = new Date().toISOString().slice(0, 10);
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 6);
  const cutoffDay = cutoffDate.toISOString().slice(0, 10);
  const last7 = emptyMeasurement();
  for (const [day, bucket] of Object.entries(stats.days)) {
    if (day >= cutoffDay) mergeMeasurement(last7, bucket);
  }
  return {
    updatedAt: stats.updatedAt,
    storageFile: statsFile(),
    allTime: measurementView(stats.allTime),
    today: measurementView(stats.days[todayKey] ?? emptyMeasurement()),
    last7Days: measurementView(last7),
  };
}

function migrateStoredRecordFiles(): void {
  if (migratedStoredRecords) return;
  migratedStoredRecords = true;
  let files: string[] = [];
  try {
    const dir = budgetDir();
    files = readdirSync(dir).filter((f) => /^cb_.*\.json$/.test(f));
    for (const f of files) {
      const file = join(dir, f);
      const rawText = readFileSync(file, 'utf8');
      if (!/\"(?:originalCommand|sentCommand)\"/.test(rawText)) continue;
      const sanitized = sanitizeRecord(JSON.parse(rawText) as ContextBudgetRecord & { originalCommand?: string; sentCommand?: string });
      const tmp = `${file}.${process.pid}.sanitize`;
      writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n', { mode: 0o600 });
      try { renameSync(tmp, file); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup */ } throw err; }
    }
  } catch {
    /* Migration is best-effort; hidden read routes still sanitize legacy records before returning them. */
  }
  pruneContextBudgetStorage();
}

/** Bound profile cache growth by age, count, and total bytes. */
export function pruneContextBudgetStorage(now = Date.now()): { removed: number; kept: number; bytes: number } {
  const cutoff = now - CONTEXT_BUDGET_RETENTION.auditDays * 24 * 60 * 60 * 1_000;
  try {
    const dir = budgetDir();
    const entries = readdirSync(dir)
      .filter((name) => /^cb_.*\.json$/.test(name))
      .map((name) => {
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          return { path, mtime: stat.mtimeMs, bytes: stat.size };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtime: number; bytes: number } => Boolean(entry))
      .sort((a, b) => b.mtime - a.mtime);
    let kept = 0;
    let bytes = 0;
    let removed = 0;
    for (const entry of entries) {
      const withinBounds = entry.mtime >= cutoff
        && kept < CONTEXT_BUDGET_RETENTION.maxAuditRecords
        && bytes + entry.bytes <= CONTEXT_BUDGET_RETENTION.maxAuditBytes;
      if (withinBounds) {
        kept += 1;
        bytes += entry.bytes;
        continue;
      }
      try {
        rmSync(entry.path, { force: true });
        removed += 1;
      } catch {
        // Cache cleanup is best-effort and must not affect dispatch.
      }
    }
    return { removed, kept, bytes };
  } catch {
    return { removed: 0, kept: 0, bytes: 0 };
  }
}

function sanitizeRecord(raw: ContextBudgetRecord | (Partial<ContextBudgetRecord> & { originalCommand?: string; sentCommand?: string })): ContextBudgetRecord {
  const legacy = raw as Partial<ContextBudgetRecord> & { originalCommand?: string; sentCommand?: string };
  const originalText = typeof raw.originalPreview === 'string' ? raw.originalPreview : String(legacy.originalCommand ?? '');
  const sentText = typeof raw.sentPreview === 'string' ? raw.sentPreview : String(legacy.sentCommand ?? '');
  const original = auditPreview(originalText);
  const sent = auditPreview(sentText);
  const redactions = Array.from(new Set([...(raw.redactions ?? []), ...original.redactions, ...sent.redactions]));
  return {
    id: String(raw.id ?? recordId(hashText(originalText || sentText))),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    source: String(raw.source ?? 'unknown'),
    team: raw.team,
    target: raw.target,
    route: raw.route === 'optimized-deterministic' ? 'optimized-deterministic' : 'direct',
    originalTokens: Number(raw.originalTokens ?? estimateTokens(originalText)) || 0,
    sentTokens: Number(raw.sentTokens ?? estimateTokens(sentText)) || 0,
    savedTokens: Number(raw.savedTokens ?? 0) || 0,
    savingsRatio: Number(raw.savingsRatio ?? 0) || 0,
    transforms: Array.isArray(raw.transforms) ? raw.transforms.map(String) : [],
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
    guardrails: Array.isArray(raw.guardrails) ? raw.guardrails.map(String) : [],
    originalHash: String(raw.originalHash ?? hashText(originalText)),
    sentHash: String(raw.sentHash ?? hashText(sentText)),
    originalPreview: original.preview,
    sentPreview: sent.preview,
    redactions,
    previewTruncated: Boolean(raw.previewTruncated || original.truncated || sent.truncated),
    rawPromptPersisted: false,
  };
}

function decisionView(decision: ContextBudgetDecision): ContextBudgetDecisionView {
  const original = auditPreview(decision.originalCommand);
  const command = auditPreview(decision.command);
  const redactions = Array.from(new Set([...original.redactions, ...command.redactions]));
  const { command: _command, originalCommand: _originalCommand, ...rest } = decision;
  void _command;
  void _originalCommand;
  return {
    ...rest,
    originalPreview: original.preview,
    commandPreview: command.preview,
    redactions,
    previewTruncated: original.truncated || command.truncated,
    rawPromptPersisted: false,
  };
}

function remember(decision: ContextBudgetDecision): void {
  migrateStoredRecordFiles();
  totals.inspected += 1;
  totals.originalTokens += decision.originalTokens;
  totals.sentTokens += decision.sentTokens;
  totals.savedTokens += decision.savedTokens;
  if (decision.changed) totals.optimized += 1;
  else totals.direct += 1;
  if (decision.protectedContent.length) totals.protectedDirect += 1;
  recordPersistentMeasurement(decision);

  if (!decision.changed) return;
  const originalHash = hashText(decision.originalCommand);
  const sentHash = hashText(decision.command);
  const original = auditPreview(decision.originalCommand);
  const sent = auditPreview(decision.command);
  const record: ContextBudgetRecord = {
    id: recordId(originalHash),
    createdAt: Date.now(),
    source: decision.source,
    team: decision.team,
    target: decision.target,
    route: decision.route,
    originalTokens: decision.originalTokens,
    sentTokens: decision.sentTokens,
    savedTokens: decision.savedTokens,
    savingsRatio: decision.savingsRatio,
    transforms: decision.transforms,
    reasons: decision.reasons,
    guardrails: decision.guardrails,
    originalHash,
    sentHash,
    originalPreview: original.preview,
    sentPreview: sent.preview,
    redactions: Array.from(new Set([...original.redactions, ...sent.redactions])),
    previewTruncated: original.truncated || sent.truncated,
    rawPromptPersisted: false,
  };
  recent.unshift(record);
  recent.splice(MAX_RECENT);
  try { writeRecord(record); } catch { /* audit persistence is best-effort; dispatch must not fail */ }
}

export function optimizeAskCommand(command: string, options: ContextBudgetOptions = {}): ContextBudgetDecision {
  const decision = optimizeAskCommandCore(command, options);
  remember(decision);
  return decision;
}

export function contextBudgetReport(): ContextBudgetReport {
  migrateStoredRecordFiles();
  const savedTokens = totals.savedTokens;
  const originalTokens = totals.originalTokens;
  const sentTokens = totals.sentTokens;
  return {
    coreEnabled: true,
    frontendSurface: 'hidden',
    inspected: totals.inspected,
    optimized: totals.optimized,
    direct: totals.direct,
    protectedDirect: totals.protectedDirect,
    originalTokens,
    sentTokens,
    savedTokens,
    savingsRatio: originalTokens > 0 ? savedTokens / originalTokens : 0,
    recent: recent.slice(0, 20),
    storageDir: budgetDir(),
    persisted: persistentStatsView(),
    policy: {
      route: 'deterministic-first',
      headroomEngine: 'not-required-for-core-budgeting',
      retrieval: 'hashes-and-redacted-previews-only',
      retention: CONTEXT_BUDGET_RETENTION,
    },
    qualityGuards: [
      'Only /ask payloads are eligible; manager lifecycle commands pass through unchanged.',
      'Secrets, auth material, agent instruction sidecars, active code patches, and wallet/key material always use the direct route.',
      'The hot path uses deterministic whitespace, exact-duplicate, and background-section compaction only; no AI summarizer rewrites prompts before dispatch.',
      'If savings are below the minimum gate, the exact original prompt is sent.',
      'Optimized prompts are stored with hashes and redacted bounded previews only; raw prompts, secrets, auth material, and wallet/key material are not persisted in audit records.',
    ],
  };
}

export function readContextBudgetRecord(id: string): ContextBudgetRecord | null {
  migrateStoredRecordFiles();
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safe) return null;
  const file = join(budgetDir(), `${safe}.json`);
  if (!existsSync(file)) return null;
  try {
    return sanitizeRecord(JSON.parse(readFileSync(file, 'utf8')) as ContextBudgetRecord);
  } catch {
    return null;
  }
}

export function loadRecentContextBudgetRecords(limit = 20): ContextBudgetRecord[] {
  migrateStoredRecordFiles();
  try {
    return readdirSync(budgetDir())
      .filter((f) => /^cb_.*\.json$/.test(f))
      .map((f) => {
        const path = join(budgetDir(), f);
        try { return sanitizeRecord(JSON.parse(readFileSync(path, 'utf8')) as ContextBudgetRecord); } catch { return null; }
      })
      .filter((r): r is ContextBudgetRecord => !!r)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
  } catch {
    return [];
  }
}

export function contextBudgetDryRun(command: string, options: ContextBudgetOptions = {}): ContextBudgetDecisionView {
  const decision = optimizeAskCommandCore(command, { ...options, source: options.source ?? 'dry-run' });
  return decisionView({
    ...decision,
    originalTokens: decision.originalTokens || estimateTokens(command),
  });
}
