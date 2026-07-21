/**
 * Per-runtime model catalog. Each agent runtime (harness) draws its models
 * from a backing inference provider:
 *   ollama runtime            ← ollama / lmstudio / openai-compatible (local servers)
 *   claude-* runtimes         ← anthropic provider (GET /v1/models with a key)
 *   codex runtime             ← openai provider
 *   cursor-cli runtime        ← (no public model API) curated only
 *   grok                       ← managed Grok Build CLI harness
 *   antigravity                ← managed Google Antigravity CLI harness
 *   q                          ← managed subscription CLI; linked in Settings,
 *                                 assignable only after id-agents exposes a harness
 *   copilot                    ← managed GitHub Copilot CLI harness
 *   kiro-cli                   ← managed Kiro CLI harness
 *   gemini                     ← legacy/current-only CLI id; API setup lives in providers
 *
 * When a backing provider is configured and has a synced model list, we use it
 * (that IS "probing the runtime"). Otherwise we fall back to a curated list of
 * the current known models so the dropdown is never empty.
 */

import type { ProviderKind, ProviderProfile } from './schema.ts';

/** Visible runtime/model lanes (remote runtime excluded). */
export const RUNTIMES = [
  'claude-agent-sdk',
  'claude-code-cli',
  'claude-code-local',
  'codex',
  'cursor-cli',
  'grok',
  'antigravity',
  'gemini',
  'copilot',
  'kiro-cli',
  'q',
  'ollama',
];

/**
 * Concrete runtime ids the current bundled id-agents manager can execute as
 * agent harnesses. Subscription CLIs can still be linked in Settings and shown
 * as model lanes, but they must not become assignable until the manager ships a
 * matching harness/adapter.
 */
export const MANAGER_EXECUTION_RUNTIMES = [
  'claude-agent-sdk',
  'claude-code-cli',
  'claude-code-local',
  'codex',
  'cursor-cli',
  'grok',
  'antigravity',
  'copilot',
  'kiro-cli',
  'ollama',
];

export type RuntimeModelLaneKind = 'subscription' | 'local' | 'api';
export type RuntimeModelLaneSource = 'provider' | 'none';

export interface RuntimeModelLane {
  /** Neutral provider/model lane id. Not a manager harness id. */
  id: string;
  label: string;
  kind: RuntimeModelLaneKind;
  provider: string;
  providerKind: ProviderKind;
  models: string[];
  source: RuntimeModelLaneSource;
  lastCheckedMs: number | null;
  /** True when IDACC can hand this lane to the manager provider-api harness. */
  selectable: boolean;
  detail: string;
}

const RUNTIME_LABELS: Record<string, string> = {
  'claude-agent-sdk': 'Claude API',
  'claude-code-cli': 'Claude Code',
  'claude-code-local': 'Claude Code (local alias)',
  codex: 'Codex',
  'cursor-cli': 'Cursor',
  grok: 'Grok Build',
  antigravity: 'Google Antigravity',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  'kiro-cli': 'Kiro',
  q: 'Amazon Q',
  ollama: 'Ollama',
};

export function runtimeDisplayLabel(runtime: string): string {
  if (runtime.startsWith('provider:')) {
    try { return decodeURIComponent(runtime.slice('provider:'.length)); } catch { return runtime.slice('provider:'.length); }
  }
  return RUNTIME_LABELS[runtime] ?? runtime.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}

export type RuntimePickerGroup = 'subscription' | 'local';

/**
 * Group manager harnesses in operator-facing runtime pickers. Only `ollama` is
 * a local-model runtime; `claude-code-local` is a legacy alias for the Claude
 * Code subscription CLI running as a local process.
 */
export function runtimePickerGroup(runtime: string | undefined): RuntimePickerGroup {
  return runtime === 'ollama' ? 'local' : 'subscription';
}

export function runtimeHasManagerHarness(runtime: string | undefined): boolean {
  return Boolean(runtime && MANAGER_EXECUTION_RUNTIMES.includes(runtime));
}

/**
 * Native capability support an agent runtime may or may not be able to consume
 * directly. Capabilities assignment in IDACC is broader than this table: the
 * Capabilities page can attach MCP metadata, skills, and portable plugin package
 * state to any local/API/subscription runtime, then surfaces whether the current
 * runtime has a native adapter, MCP/tool surface, Skill/workspace surface, or
 * direct fallback.
 *
 * "plugins" below means native Claude Code plugin bundles. IDACC-level portable
 * plugin packages use "portablePlugins" and must declare runtime adapters such
 * as SKILL.md, MCP, native plugin, or direct fallback instead of pretending one
 * native plugin loader works everywhere.
 */
export type RuntimeCapability = 'mcp' | 'plugins' | 'portablePlugins' | 'skills';

/**
 * Which runtimes can directly USE each native capability today. Do not use this
 * table as a blanket "can select target" gate for portable capabilities.
 *
 * MCP — hard runtime feature: the Claude runtimes embed the SDK/CLI MCP client,
 * codex received `-c mcp_servers.*` config injection (2026-06), and ollama now
 * ships the agentic tool-calling loop (id-agents OllamaHarness.runWithTools +
 * McpToolHub) so local models with tool support can call MCP tools. A non-tool
 * ollama model degrades gracefully to plain text. Grok Build, GitHub Copilot
 * CLI, Kiro CLI, and the legacy Amazon Q CLI are listed as
 * managed CLI runtimes with MCP-capable vendor surfaces, but manager execution
 * still depends on a matching harness/adapter. cursor-cli and the remote runtime
 * still don't consume our McpServerSpec.
 *
 * skills — the manager deploys SKILL.md files to a runtime-aware dir for every
 * LOCAL runtime (`.claude/skills`, `.agents/skills` for codex/grok/antigravity/
 * ollama, `.cursor/skills`), so all local runtimes qualify; only the
 * remote-endpoint runtime (no workspace) is excluded. (getRuntimePaths in id-agents.)
 *
 * plugins — Claude Code plugin bundles; only the Claude-family runtimes load them.
 *
 * portablePlugins — IDACC plugin packages that declare adapters. Every local
 * runtime can consume at least the instruction/fallback portion, while tool
 * adapters still gate independently through MCP or native plugin support.
 */
const RUNTIME_CAPABILITIES: Record<RuntimeCapability, string[]> = {
  mcp: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
  skills: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
  plugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'],
  portablePlugins: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
};

/** Short, user-facing reason a runtime can't use a capability (for tooltips). */
const CAPABILITY_DENY_REASON: Record<RuntimeCapability, string> = {
  mcp: 'This runtime has no native MCP client today; attach can still be stored as neutral metadata when a manager adapter, runtime change, or direct fallback is available.',
  skills: 'This runtime has no native skill workspace today; assignment can still be stored when a manager prompt-side adapter or direct fallback is available.',
  plugins: 'Native plugin loaders are runtime-specific; Claude Code plugin bundles load only on Claude-family runtimes.',
  portablePlugins: 'Portable plugin packages require a declared Skill, MCP, native, or fallback adapter for this runtime.',
};

/** Does this runtime support the given capability? Unknown runtime → false. */
export function runtimeSupports(runtime: string | undefined, cap: RuntimeCapability): boolean {
  if (!runtime) return false;
  return RUNTIME_CAPABILITIES[cap]?.includes(runtime) ?? false;
}

/** Human-readable reason a runtime lacks a capability (empty if it has it). */
export function capabilityDenyReason(runtime: string | undefined, cap: RuntimeCapability): string {
  return runtimeSupports(runtime, cap) ? '' : CAPABILITY_DENY_REASON[cap];
}

/** Minimal provider shape needed to decide runtime availability. */
type ProviderForRuntime = {
  name?: string;
  kind: string;
  baseUrl?: string;
  enabled?: boolean;
  keySource?: string;
  needsKey?: boolean;
  lastSync?: { at?: number; status?: string; modelCount?: number; models?: string[] };
};

export const LOCAL_PROVIDER_LIVE_TTL_MS = 5 * 60 * 1000;

/** Minimal managed-subscription shape needed to decide runtime availability. */
export type ManagedRuntimeForOffer = {
  provider?: string;
  runtime?: string;
  installed?: boolean;
  loggedIn?: boolean;
  linked?: boolean;
  statusSupported?: boolean;
};

/**
 * Is the Anthropic API backend usable — wired in (an enabled `anthropic`
 * provider), key found (resolved from config or env), AND a live connect/sync?
 * The `claude-agent-sdk` runtime is the only one that calls the metered Anthropic
 * API (it needs `ANTHROPIC_API_KEY`), so the picker gates it on this. The other
 * claude-* runtimes use the CLI subscription and don't need a provider.
 */
export function anthropicApiReady(providers: ProviderForRuntime[]): boolean {
  return providers.some(
    (p) =>
      p.kind === 'anthropic' &&
      p.enabled !== false &&
      (p.keySource === 'config' || p.keySource === 'env') &&
      p.lastSync?.status === 'live',
  );
}

function addRuntime(out: string[], runtime?: string, options: { allowUnsupported?: boolean } = {}): void {
  if (!runtime || !RUNTIMES.includes(runtime) || out.includes(runtime)) return;
  if (!options.allowUnsupported && !runtimeHasManagerHarness(runtime)) return;
  out.push(runtime);
}

export function managedRuntimeHasEvidence(s: ManagedRuntimeForOffer): boolean {
  if (!s.runtime || s.installed === false) return false;
  // Legacy Amazon Q (`q`) is intentionally not promoted into Health/HR linked
  // runtime lanes. Settings may still show it when installed, and existing q
  // agent assignments remain visible through the current-runtime keep path.
  if (s.runtime === 'q') return false;
  return s.installed === true || s.loggedIn === true || s.linked === true;
}

function providerKeyReady(p: ProviderForRuntime): boolean {
  const implicitKeyed = p.kind === 'anthropic' || p.kind === 'openai';
  const needsKey = p.needsKey === true || (p.needsKey === undefined && implicitKeyed);
  return !needsKey || p.keySource === 'config' || p.keySource === 'env';
}

function providerHasModels(p: ProviderForRuntime): boolean {
  return p.lastSync?.status === 'preset' || (p.lastSync?.modelCount ?? p.lastSync?.models?.length ?? 0) > 0;
}

function providerRouteReady(p: ProviderForRuntime): boolean {
  if (providerIsLocalRoute(p)) return localProviderRouteIsLive(p);
  return p.enabled !== false && providerKeyReady(p) && (
    p.lastSync?.status === 'live' ||
    p.lastSync?.status === 'preset' ||
    providerHasModels(p)
  );
}

export function localProviderRouteIsLive(
  p: { kind: string; baseUrl?: string; enabled?: boolean; lastSync?: { at?: number; status?: string; modelCount?: number; models?: string[] } },
  now = Date.now(),
): boolean {
  const at = Number(p.lastSync?.at ?? 0);
  const modelCount = p.lastSync?.models?.length ?? p.lastSync?.modelCount ?? 0;
  return p.enabled !== false && providerIsLocalRoute(p) && p.lastSync?.status === 'live' &&
    modelCount > 0 && Number.isFinite(at) && at > 0 && now - at <= LOCAL_PROVIDER_LIVE_TTL_MS;
}

function providerIsLocalRoute(p: ProviderForRuntime): boolean {
  if (p.kind === 'ollama' || p.kind === 'lmstudio') return true;
  if (p.kind !== 'openai-compatible' || !p.baseUrl) return false;
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

function managedRuntimeReady(s: ManagedRuntimeForOffer): boolean {
  if (!s.runtime || s.installed === false) return false;
  if (s.statusSupported === true) return s.loggedIn === true;
  // These CLIs do not expose a safe non-interactive account status in Settings;
  // require both binary presence and non-secret linked-account evidence.
  // The manager-harness gate is applied separately before a runtime is offered
  // for assignment. Grok and Antigravity expose model probes, so they should
  // arrive here with statusSupported=true and loggedIn=true rather than using
  // linked evidence. Gemini CLI is excluded from managed sign-ins; use
  // Google Gemini API under Inference backends. Existing gemini assignments
  // remain current-only via keep.
  return s.runtime === 'copilot' && s.installed === true && s.linked === true;
}

/**
 * Runtime ids that Settings can prove are currently assignable. This includes
 * concrete manager harnesses; provider lane ids are offered separately by
 * buildProviderModelLanes() because they need provider metadata at write time.
 */
export function settingsAvailableRuntimeSet(
  providers: ProviderForRuntime[],
  managed: ManagedRuntimeForOffer[] = [],
): Set<string> {
  return new Set(offerableRuntimes(providers, undefined, managed));
}

/**
 * Runtime ids to offer in runtime pickers. The list is intentionally Settings-led:
 * installed/signed-in managed CLIs, configured live API backends with matching
 * harnesses, and synced local model servers. `keep` preserves an agent's current
 * runtime for visibility even when that runtime is no longer newly available.
 */
export function offerableRuntimes(
  providers: ProviderForRuntime[],
  keep?: string,
  managed: ManagedRuntimeForOffer[] = [],
): string[] {
  const out: string[] = [];
  addRuntime(out, keep, { allowUnsupported: true });

  for (const s of managed) {
    if (!managedRuntimeReady(s)) continue;
    addRuntime(out, s.runtime);
  }

  for (const p of providers) {
    if (!providerRouteReady(p)) continue;
    if (p.kind === 'anthropic') addRuntime(out, 'claude-agent-sdk');
    else if (p.kind === 'openai') addRuntime(out, 'codex');
    else if (p.kind === 'ollama' && providerIsLocalRoute(p)) addRuntime(out, 'ollama');
  }

  return out;
}

/**
 * Reasoning-effort options PER RUNTIME. Only the subscription runtimes that read
 * ID_AGENT_EFFORT honor this, and each accepts a different scale:
 *   codex (`-c model_reasoning_effort`) → minimal | low | medium | high  (its ceiling is
 *      high; the harness maps a requested xhigh back down to high, so we don't offer it)
 *   claude-code-cli / -local (`--effort`) → low | medium | high | xhigh  (the harness maps
 *      minimal → low, so we start the scale at low)
 * Every other runtime (ollama, cursor-cli, claude-agent-sdk, remote) has no effort knob → [].
 * Passing an out-of-range value is SAFE — both harnesses validate against their own regex and
 * silently ignore anything else — but offering the runtime's real scale keeps the UI honest.
 */
export const RUNTIME_EFFORTS: Record<string, string[]> = {
  codex: ['minimal', 'low', 'medium', 'high'],
  'claude-code-cli': ['low', 'medium', 'high', 'xhigh'],
  'claude-code-local': ['low', 'medium', 'high', 'xhigh'],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
  copilot: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'kiro-cli': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** The effort scale this runtime honors (empty if it has no reasoning-effort knob). */
export function effortOptions(runtime?: string): string[] {
  return RUNTIME_EFFORTS[runtime ?? ''] ?? [];
}

/** Does this runtime have a reasoning-effort knob at all? */
export function runtimeHasEffort(runtime?: string): boolean {
  return effortOptions(runtime).length > 0;
}

/**
 * Output speed options per runtime. Claude Code's interactive `/fast` toggle is
 * exposed in the UI for Claude Code runtimes only; other runtimes have no speed
 * knob.
 */
export const RUNTIME_SPEEDS: Record<string, string[]> = {
  'claude-code-cli': ['default', 'fast'],
  'claude-code-local': ['default', 'fast'],
};

/** The speed scale this runtime honors (empty if it has no speed knob). */
export function speedOptions(runtime?: string): string[] {
  return RUNTIME_SPEEDS[runtime ?? ''] ?? [];
}

/** Does this runtime have an output-speed knob at all? */
export function runtimeHasSpeed(runtime?: string): boolean {
  return speedOptions(runtime).length > 0;
}

/** Current known models per runtime, used when no probeable provider is configured. */
export const RUNTIME_CURATED: Record<string, string[]> = {
  'claude-agent-sdk': ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  'claude-code-cli': ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  'claude-code-local': ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  // Fallback only — the bridge merges the live list from ~/.codex/models_cache.json.
  // Keep current Codex/OpenAI model ids here so a stale local Codex cache does
  // not hide newly rolled-out eligible models from the IDACC picker.
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.3-codex'],
  'cursor-cli': ['sonnet-4', 'composer-2'],
  grok: ['grok-composer-2.5-fast', 'grok-build'],
  antigravity: ['Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (High)', 'Gemini 3.5 Flash (Low)', 'Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'],
  // These managed CLIs own model/account selection; keep fallback catalogs minimal.
  gemini: ['default'],
  copilot: ['default'],
  'kiro-cli': ['auto', 'claude-sonnet-4.5', 'claude-sonnet-4', 'claude-haiku-4.5', 'deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1', 'glm-5', 'qwen3-coder-next'],
  q: ['default'],
  ollama: [],
};

/** Which runtimes a given provider kind supplies models for. */
export function providerKindToRuntimes(kind: ProviderKind): string[] {
  switch (kind) {
    case 'ollama':
      return ['ollama'];
    case 'lmstudio':
    case 'openai-compatible':
      // These servers implement an OpenAI-compatible API, not Ollama's API.
      // They are assigned through their provider:<name> lane and the manager's
      // provider-api harness so the configured base URL remains authoritative.
      return [];
    case 'anthropic':
      return ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'];
    case 'openai':
      return ['codex'];
    default:
      return [];
  }
}

/**
 * Is this provider a LOCAL model server (its endpoint is on this machine)? The
 * generic ollama runtime is reserved for an actual Ollama provider. Other local
 * OpenAI-compatible servers are exposed as provider lanes so their configured
 * endpoint cannot be mistaken for Ollama's API.
 */
export function isLocalProvider(p: ProviderProfile): boolean {
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

export function providerModelLaneId(p: Pick<ProviderProfile, 'name'>): string {
  return `provider:${encodeURIComponent(p.name)}`;
}

export function providerModelLaneKind(p: ProviderProfile): RuntimeModelLaneKind {
  if (p.kind === 'anthropic' || p.kind === 'openai') return 'subscription';
  return isLocalProvider(p) ? 'local' : 'api';
}

export function providerModelLaneLabel(p: ProviderProfile): string {
  const kind = providerModelLaneKind(p);
  const prefix = kind === 'subscription' ? 'Subscription' : kind === 'local' ? 'Local' : 'API';
  return `${prefix} · ${prettyProviderLaneName(p.name)}`;
}

function prettyProviderLaneName(name: string | undefined): string {
  const n = String(name ?? '').trim();
  const key = n.toLowerCase();
  if (key === 'ollama') return 'Ollama';
  if (key === 'lmstudio' || key === 'lm-studio' || key === 'lm studio') return 'LM Studio';
  if (key === 'localai' || key === 'local-ai') return 'LocalAI';
  if (key === 'mlx-lm-server' || key === 'mlx_lm.server') return 'MLX';
  return n || 'provider';
}

function uniqueModels(models: string[] | undefined): string[] {
  return Array.from(new Set((models ?? []).map((m) => String(m).trim()).filter(Boolean)));
}

export function providerVisibleModels(p: Pick<ProviderProfile, 'lastSync' | 'modelSelection'>): string[] {
  const synced = uniqueModels(p.lastSync?.models);
  if (!synced.length || p.modelSelection?.mode !== 'selected') return synced;
  const selected = new Set(uniqueModels(p.modelSelection.models));
  const visible = synced.filter((m) => selected.has(m));
  // If the saved selection went stale after a provider refresh, fail open so the
  // Health dropdown never goes blank while Settings still shows the mismatch.
  return visible.length ? visible : synced;
}

/**
 * Provider/model lanes are neutral catalog entries from Settings. They expose
 * every configured subscription, local, and API backend in Health/Fleet without
 * pretending the manager can execute a provider id directly as an agent harness.
 */
export function buildProviderModelLanes(providers: Array<ProviderProfile & { keySource?: string; needsKey?: boolean }>): RuntimeModelLane[] {
  return providers
    .filter((p) => p.enabled !== false)
    .map((p) => {
      const models = providerVisibleModels(p);
      const kind = providerModelLaneKind(p);
      const routeReady = providerRouteReady(p);
      const selectable = (kind === 'api' || kind === 'local') && routeReady && models.length > 0;
      const detail = kind === 'api'
        ? selectable
          ? 'Configured API provider lane. IDACC can assign this through the manager provider-api harness.'
          : 'Configured API provider lane. Connect & sync this backend before assigning it to an agent.'
        : kind === 'local'
          ? selectable
            ? 'Configured local model lane. IDACC can assign this through the manager provider-api harness.'
            : 'Configured local model lane. Start the local server, then Connect & sync it before assigning it to an agent.'
          : 'Configured subscription/API provider lane. Agent assignment uses the matching manager harness when available.';
      return {
        id: providerModelLaneId(p),
        label: providerModelLaneLabel(p),
        kind,
        provider: p.name,
        providerKind: p.kind,
        models,
        source: models.length ? 'provider' as const : 'none' as const,
        lastCheckedMs: p.lastSync?.at ?? null,
        selectable,
        detail,
      };
    });
}

/**
 * Build the per-runtime model catalog from the configured providers' cached
 * sync results, merged over the curated defaults. Only enabled providers that
 * have synced models contribute.
 */
export function buildRuntimeCatalog(providers: ProviderProfile[]): Record<string, string[]> {
  const cat: Record<string, string[]> = {};
  for (const rt of RUNTIMES) cat[rt] = [...(RUNTIME_CURATED[rt] ?? [])];

  for (const p of providers) {
    if (p.enabled === false) continue;
    const models = providerVisibleModels(p);
    if (!models.length) continue;
    const lane = providerModelLaneId(p);
    cat[lane] = Array.from(new Set([...(cat[lane] ?? []), ...models]));
    for (const rt of providerKindToRuntimes(p.kind)) {
      // The ollama runtime can only serve models from a LOCAL Ollama server.
      if (rt === 'ollama' && !isLocalProvider(p)) continue;
      cat[rt] = Array.from(new Set([...(cat[rt] ?? []), ...models]));
    }
  }
  return cat;
}
