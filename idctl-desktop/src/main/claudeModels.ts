import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export type ClaudeModelDiscovery = {
  models: string[];
  lastCheckedMs: number | null;
  restricted: boolean;
  detail: string;
};

export type ClaudeModelDiscoveryOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  managedSettingsPaths?: string[];
};

const CLAUDE_CODE_ALIASES = ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan'];
const EXPLICIT_MODEL_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function readJson(path: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > 240 || /\s/.test(model) || /token|secret|bearer|api[_-]?key/i.test(model)) return null;
  return model;
}

function looksLikeClaudeModel(value: unknown): value is string {
  const model = normalizeModel(value);
  return Boolean(
    model &&
    (/^(?:default|best|fable|opus|sonnet|haiku|opusplan)(?:\[1m\])?$/i.test(model) ||
      /^claude-[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/i.test(model)),
  );
}

function addModel(out: Set<string>, value: unknown): void {
  const model = normalizeModel(value);
  if (model) out.add(model);
}

function collectRecognizedModels(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 5 || value == null) return;
  if (looksLikeClaudeModel(value)) {
    out.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRecognizedModels(item, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (/token|secret|credential|oauth/i.test(key)) continue;
    if (looksLikeClaudeModel(key)) out.add(key);
    collectRecognizedModels(item, out, depth + 1);
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeModel).filter((model): model is string => Boolean(model));
}

function defaultManagedSettingsPaths(): string[] {
  if (process.platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  }
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return [join(programData, 'ClaudeCode', 'managed-settings.json')];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

function settingsModels(settings: JsonRecord | null): Set<string> {
  const out = new Set<string>();
  if (!settings) return out;
  addModel(out, settings.model);
  for (const model of stringList(settings.availableModels)) addModel(out, model);

  const overrides = asRecord(settings.modelOverrides);
  for (const model of Object.keys(overrides ?? {})) addModel(out, model);

  const env = asRecord(settings.env);
  for (const key of EXPLICIT_MODEL_ENV) addModel(out, env?.[key]);
  return out;
}

function cacheModels(cache: JsonRecord | null): Set<string> {
  const out = new Set<string>();
  if (!cache) return out;

  for (const option of Array.isArray(cache.additionalModelOptionsCache) ? cache.additionalModelOptionsCache : []) {
    addModel(out, asRecord(option)?.value);
  }
  for (const model of Object.keys(asRecord(cache.additionalModelCostsCache) ?? {})) {
    if (looksLikeClaudeModel(model)) out.add(model);
  }

  const slots = asRecord(cache.clientDataCacheSlots);
  for (const slot of Object.values(slots ?? {})) addModel(out, asRecord(slot)?.model);

  collectRecognizedModels(cache.modelAccessCache, out);
  collectRecognizedModels(cache.orgModelDefaultCache, out);
  return out;
}

function newestMtime(paths: string[]): number | null {
  let latest = 0;
  for (const path of paths) {
    try { latest = Math.max(latest, statSync(path).mtimeMs); } catch { /* optional source */ }
  }
  return latest || null;
}

/**
 * Claude Code has no noninteractive model-list command. Build the selectable
 * lane from its rolling aliases plus the same local policy/account cache that
 * feeds the CLI picker. The CLI still performs the final plan/entitlement check.
 */
export function discoverClaudeCliModels(options: ClaudeModelDiscoveryOptions = {}): ClaudeModelDiscovery {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const userSettingsPath = join(home, '.claude', 'settings.json');
  const accountCachePath = join(home, '.claude.json');
  const managedPaths = options.managedSettingsPaths ?? defaultManagedSettingsPaths();
  const managedSettingsPath = managedPaths.find(existsSync);
  const managedSettings = managedSettingsPath ? readJson(managedSettingsPath) : null;
  const userSettings = readJson(userSettingsPath);
  const accountCache = readJson(accountCachePath);

  const managedAllowlist = stringList(managedSettings?.availableModels);
  const userAllowlist = stringList(userSettings?.availableModels);
  const managedRestricts = Array.isArray(managedSettings?.availableModels);
  const userRestricts = Array.isArray(userSettings?.availableModels);
  const allowlist = managedRestricts ? managedAllowlist : userAllowlist;
  const restricted = managedRestricts || userRestricts;
  const models = new Set<string>();

  if (restricted) {
    models.add('default');
    for (const model of allowlist) addModel(models, model);
  } else {
    for (const alias of CLAUDE_CODE_ALIASES) models.add(alias);
    for (const model of settingsModels(userSettings)) models.add(model);
    for (const model of settingsModels(managedSettings)) models.add(model);
    for (const model of cacheModels(accountCache)) models.add(model);
    for (const key of EXPLICIT_MODEL_ENV) addModel(models, env[key]);
  }

  if (env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') {
    for (const model of models) {
      if (/\[1m\]$/i.test(model)) models.delete(model);
    }
  }

  const paths = [userSettingsPath, accountCachePath, ...(managedSettingsPath ? [managedSettingsPath] : [])];
  return {
    models: Array.from(models),
    lastCheckedMs: newestMtime(paths),
    restricted,
    detail: restricted
      ? 'Claude Code model choices follow the configured availableModels policy; Default remains available for the signed-in subscription tier.'
      : 'Claude Code exposes no model-list command. IDACC merged rolling CLI aliases with locally offered, pinned, and configured model choices; Claude Code verifies plan access when work is dispatched.',
  };
}
