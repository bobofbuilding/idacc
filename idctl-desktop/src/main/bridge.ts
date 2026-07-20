/**
 * Main-process bridge to the id-agents manager + local stores. Reuses the
 * idctl ManagerClient, key provider, inference-provider client, and settings
 * store (all pure TS / Node) — the React renderer reaches them only via the
 * allow-listed methods below over IPC.
 */

import { inspectLibraryPluginMetadata, ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { configureControlEventEmitter } from './controlLog.ts';
import type { BrainAgentsReport, BrainControllerReport, BrainCoreHealthReport, BrainFleetReport, BrainGraphReport, BrainSkillIndex, BrainSkillNode } from '../../../idctl/src/api/brain.ts';
import { runOnboarding, type OnboardPlan, type PreparedRuntime } from '../../../idctl/src/api/onboard.ts';
import { slugName } from '../../../idctl/src/api/teamSpec.ts';
import { loadConfig, type Config } from '../../../idctl/src/config.ts';
import type { KeyAuthorityTarget, KeyProvider, PreparedKeyOperation, SessionScope } from '../../../idctl/src/keys/types.ts';
import { SCOPE_PRESETS, TTL_PRESETS } from '../../../idctl/src/keys/types.ts';
import {
  loadSettings,
  upsertProvider,
  removeProvider,
  resolveProviderKey,
  setDefaultProvider,
  toggleProviderEnabled,
  setProviderModelSelection,
  recordProviderSync,
  setCoordinator,
  getCoordinator,
  setPrimaryCoordinator,
  getSecondaryLeads,
  setSecondaryLeads,
  type SecondaryLead,
  upsertMcpServer,
  removeMcpServer,
  saveSettings,
  setLocalConcurrencyPref,
  setSkillTags,
  setTaskLane,
  setTaskDeps,
  setTaskReview,
  setGoalDriver,
  setHeadroomPilot,
} from '../../../idctl/src/settings/store.ts';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import { detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { discoverLocalServers, mergeLocalDiscoveryCandidates, type DiscoveredServer } from '../../../idctl/src/settings/localDiscovery.ts';
import { type HeadroomPilotSettings, type IdctlConfig, type ProviderKind, type ProviderModelSelection, type ProviderProfile, type McpServerProfile, type ProjectEntry } from '../../../idctl/src/settings/schema.ts';
import { providerNeedsKey } from '../../../idctl/src/settings/providerCatalog.ts';
import { buildProviderModelLanes, buildRuntimeCatalog, RUNTIMES, providerKindToRuntimes, isLocalProvider, settingsAvailableRuntimeSet, managedRuntimeHasEvidence, runtimeDisplayLabel, runtimeHasManagerHarness, type RuntimeModelLaneKind } from '../../../idctl/src/settings/runtimeCatalog.ts';
import { subsStatus } from './subscriptions.ts';
import { testMcpServer } from './mcpTest.ts';
import { headroomBackendContractAudit, headroomCoreAudit, headroomStatus } from './headroom.ts';
import { headroomPluginPathAudit } from './headroomPlugin.ts';
import { contextBudgetDryRun, contextBudgetReport, loadRecentContextBudgetRecords, optimizeAskCommand, readContextBudgetRecord } from './contextBudget.ts';
import { replayContextBudgetFromChatHistory, type ContextBudgetHistoryReplayOptions } from './contextReplay.ts';
import { decomposeWork, createAndDispatchPlan, delegateObjectiveToTeamLeads, fanOutObjective, teamLeads, triageUnassigned, type SubTask, type TeamLeadDelegationOptions } from './work.ts';
import { normalizeGoalDriverConfig, runGoalDriverOnce, startGoalDriverLoop, syncActiveWorkGoalInstructions, type GoalDriverConfig } from './goaldriver.ts';
import { processDraftProposalsOnce, startDraftDispatcherLoop } from './draftDispatcher.ts';
import { buildOrgHierarchy, previewOrgSync, syncOrg, startOrgSyncLoop } from './orgSync.ts';
import { syncDomainsForMethod } from '../shared/syncDomains.ts';
import { COALESCED_READ_METHODS, ReadCallCache } from '../shared/readCallCache.ts';
import { mapTeamAgentGroups } from '../shared/teamAgentGroups.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

interface ControllerProofRecord {
  agent: string;
  wallet: string;
  nonce: string;
  message: string;
  signature: string;
  verifiedAt: number;
  expiresAt: number;
}

const CONTROLLER_PROOF_TTL_MS = 10 * 60_000;
const controllerProofs = new Map<string, ControllerProofRecord>();
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIMARY_TEAM = 'default';
const DEFAULT_PRIMARY_AGENT = 'lead';
const DEFAULT_VALIDATORS = ['coder', 'researcher'];

function assertDefaultPrimaryWrite(team: string, agent: string): void {
  if (team !== PRIMARY_TEAM || agent !== DEFAULT_PRIMARY_AGENT) {
    throw new Error(`primary lead is locked to ${PRIMARY_TEAM}/${DEFAULT_PRIMARY_AGENT}`);
  }
}

function assertDefaultCoordinatorWrite(team: string, agent: string): void {
  if (team === PRIMARY_TEAM && agent !== DEFAULT_PRIMARY_AGENT) {
    throw new Error(`default coordinator is locked to ${PRIMARY_TEAM}/${DEFAULT_PRIMARY_AGENT}`);
  }
}

function normalizeSecondaryLeadWrites(leads: SecondaryLead[]): SecondaryLead[] {
  const byAgent = new Map<string, SecondaryLead>();
  for (const agent of DEFAULT_VALIDATORS) byAgent.set(agent, { agent, team: PRIMARY_TEAM, leadsTeams: [] });
  for (const lead of leads) {
    const agent = slugName(String(lead.agent ?? ''));
    if (!agent || agent === DEFAULT_PRIMARY_AGENT) continue;
    const existing = byAgent.get(agent) ?? { agent, team: PRIMARY_TEAM, leadsTeams: [] };
    existing.leadsTeams = Array.from(new Set([
      ...existing.leadsTeams,
      ...(lead.leadsTeams ?? []).map((t) => String(t).trim()).filter((t) => t && t !== PRIMARY_TEAM && t !== 'public'),
    ])).sort((a, b) => a.localeCompare(b));
    byAgent.set(agent, existing);
  }
  return Array.from(byAgent.values()).sort((a, b) => {
    const ai = DEFAULT_VALIDATORS.indexOf(a.agent);
    const bi = DEFAULT_VALIDATORS.indexOf(b.agent);
    return (ai === -1 ? DEFAULT_VALIDATORS.length : ai) - (bi === -1 ? DEFAULT_VALIDATORS.length : bi) || a.agent.localeCompare(b.agent);
  });
}

function controllerProofKey(agent: string, team?: string): string {
  return team ? `${team}:${agent}` : agent;
}

function challengeMessage(agent: string, wallet: string, nonce: string, team?: string): string {
  return [
    'ID Agents controller proof',
    `Team: ${team ?? 'default'}`,
    `Agent: ${agent}`,
    `Controller: ${wallet}`,
    `Nonce: ${nonce}`,
    'Purpose: verify controller authority for Control Center privileged identity and key actions.',
  ].join('\n');
}

function newControllerChallenge(agent: string, wallet: string, team?: string): ControllerProofRecord {
  if (!ETH_ADDRESS_RE.test(wallet)) {
    throw new Error('Controller wallet must be a valid 0x address.');
  }
  const nonce = randomBytes(16).toString('hex');
  const record: ControllerProofRecord = {
    agent,
    wallet: wallet.toLowerCase(),
    nonce,
    message: challengeMessage(agent, wallet, nonce, team),
    signature: '',
    verifiedAt: 0,
    expiresAt: Date.now() + CONTROLLER_PROOF_TTL_MS,
  };
  controllerProofs.set(controllerProofKey(agent, team), record);
  return record;
}

function isSignatureLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(value.trim());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function personalSignHash(message: string): Uint8Array {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

function recoverPersonalSignAddress(message: string, signature: string): string {
  const bytes = hexToBytes(signature.trim());
  const v = bytes[64];
  const recovery = v >= 35 ? (v - 35) % 2 : v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) {
    throw new Error('Controller signature has an unsupported recovery id.');
  }
  const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(recovery);
  const publicKey = sig.recoverPublicKey(personalSignHash(message)).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

async function verifyControllerChallenge(agent: string, wallet: string, signature: string, team?: string): Promise<ControllerProofRecord> {
  const key = controllerProofKey(agent, team);
  const record = controllerProofs.get(key);
  if (!record || record.wallet.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('No active controller challenge for this agent and wallet.');
  }
  if (record.expiresAt <= Date.now()) {
    controllerProofs.delete(key);
    throw new Error('Controller challenge expired. Start a new challenge.');
  }
  if (!isSignatureLike(signature)) {
    throw new Error('Controller signature must be a 0x-prefixed 65-byte wallet signature.');
  }
  const trimmed = signature.trim() as `0x${string}`;
  const recovered = recoverPersonalSignAddress(record.message, trimmed);
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Controller signature does not match the challenge wallet.');
  }
  const verified = { ...record, signature: trimmed, verifiedAt: Date.now() };
  controllerProofs.set(key, verified);
  return verified;
}

function controllerProofStatus(agent: string, wallet: string, team?: string): ControllerProofRecord | null {
  const key = controllerProofKey(agent, team);
  const record = controllerProofs.get(key);
  if (!record || record.wallet.toLowerCase() !== wallet.toLowerCase() || !record.verifiedAt) return null;
  if (record.expiresAt <= Date.now()) {
    controllerProofs.delete(key);
    return null;
  }
  return record;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ethAddress(value: unknown): string {
  const candidate = stringField(value);
  return ETH_ADDRESS_RE.test(candidate) ? candidate.toLowerCase() : '';
}

function providerWalletFromMetadata(meta: Record<string, unknown> | undefined): string {
  const providers = meta?.providers && typeof meta.providers === 'object'
    ? meta.providers as Record<string, unknown>
    : {};
  const skillmesh = providers.skillmesh && typeof providers.skillmesh === 'object'
    ? providers.skillmesh as Record<string, unknown>
    : {};
  return (
    ethAddress(meta?.provider_wallet_address) ||
    ethAddress(meta?.providerWalletAddress) ||
    ethAddress(skillmesh.address) ||
    ethAddress(skillmesh.wallet_address) ||
    ethAddress(skillmesh.walletAddress) ||
    ethAddress(meta?.skillmesh_address)
  );
}

function controllerWalletFromAgent(agent: Agent | undefined): string {
  const meta = agent?.metadata as Record<string, unknown> | undefined;
  const direct = agent as (Agent & { ows_address?: string | null }) | undefined;
  return (
    ethAddress(direct?.ows_address) ||
    ethAddress(meta?.ows_address) ||
    providerWalletFromMetadata(meta) ||
    ethAddress(agent?.ows_wallet) ||
    ethAddress(meta?.ows_wallet)
  );
}

async function controllerWalletForAgent(agent: string, team?: string): Promise<string> {
  const agents = await (team ? client.withTeam(team) : client).agents();
  const row = agents.find((a) => a.name === agent || a.id === agent || a.alias === agent);
  const wallet = controllerWalletFromAgent(row);
  if (!wallet || !ETH_ADDRESS_RE.test(wallet)) {
    throw new Error('No valid controller wallet is linked for this agent.');
  }
  return wallet;
}

async function startControllerChallenge(agent: string, wallet: string, team?: string): Promise<ControllerProofRecord> {
  const expected = await controllerWalletForAgent(agent, team);
  if (wallet.toLowerCase() !== expected) {
    throw new Error('Controller challenge wallet does not match the agent controller wallet.');
  }
  return newControllerChallenge(agent, expected, team);
}

async function verifyControllerChallengeForAgent(agent: string, wallet: string, signature: string, team?: string): Promise<ControllerProofRecord> {
  const expected = await controllerWalletForAgent(agent, team);
  if (wallet.toLowerCase() !== expected) {
    throw new Error('Controller signature wallet does not match the agent controller wallet.');
  }
  return verifyControllerChallenge(agent, expected, signature, team);
}

async function controllerProofStatusForAgent(agent: string, wallet: string, team?: string): Promise<ControllerProofRecord | null> {
  const expected = await controllerWalletForAgent(agent, team);
  if (wallet.toLowerCase() !== expected) return null;
  return controllerProofStatus(agent, expected, team);
}

async function requireControllerProof(agent: string, team?: string): Promise<void> {
  const expected = await controllerWalletForAgent(agent, team);
  const record = controllerProofs.get(controllerProofKey(agent, team));
  if (!record?.verifiedAt || record.expiresAt <= Date.now() || record.wallet.toLowerCase() !== expected) {
    throw new Error('Privileged identity and key actions require a fresh controller-wallet challenge.');
  }
}

async function requireControllerProofIfWalletExists(agent: string, team?: string): Promise<void> {
  try {
    await requireControllerProof(agent, team);
  } catch (err) {
    if (err instanceof Error && err.message === 'No valid controller wallet is linked for this agent.') return;
    throw err;
  }
}

/**
 * The codex runtime's real model list lives in the codex CLI's own cache
 * (~/.codex/models_cache.json), which reflects the signed-in ChatGPT
 * subscription. Visibility 'list' = user-selectable; sort by priority to match
 * the CLI's picker order. [] on any error (cache absent / not signed in).
 */
// ---- Projects-sync helpers -------------------------------------------------
/** Canonical path for dedup: realpath when it exists, else trailing-slash-trimmed. */
function normPath(p?: string): string {
  if (!p) return '';
  try { return realpathSync(p); } catch { return p.replace(/\/+$/, ''); }
}
/** Loose name key for adopting a same-named manual entry (case/punctuation-insensitive). */
function normName(n: string): string {
  return (n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
/** A git remote → a clean github.com/owner/repo link (best-effort, non-github passes through). */
function ghLink(remote: string): string {
  return remote.trim().replace(/^git@github\.com:/, 'github.com/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
}
/** Deterministic, collision-resistant id from a path (re-syncs reuse the id). */
function stableHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

async function previewProjectsSync(rootArg?: string): Promise<{
  ok: boolean;
  root: string | null;
  found: number;
  added: number;
  adopted: number;
  existing: number;
  total: number;
  addNames: string[];
  adoptNames: string[];
  error?: string;
}> {
  const root = detectProjectsRoot(typeof rootArg === 'string' && rootArg.trim() ? rootArg.trim() : loadSettings().projectsRoot);
  const projects = loadSettings().projects ?? [];
  if (!root) return { ok: false, root: null, found: 0, added: 0, adopted: 0, existing: 0, total: projects.length, addNames: [], adoptNames: [], error: 'no projects folder found' };
  const scan = await scanProjectsRoot(root);
  if (scan.error) return { ok: false, root, found: 0, added: 0, adopted: 0, existing: 0, total: projects.length, addNames: [], adoptNames: [], error: scan.error };
  const byPath = new Set(projects.map((p) => normPath(p.path)).filter(Boolean) as string[]);
  const pathlessByName = new Map<string, ProjectEntry>();
  for (const p of projects) { const k = normName(p.name); if (!p.path && k) pathlessByName.set(k, p); }
  let added = 0;
  let adopted = 0;
  let existing = 0;
  const addNames: string[] = [];
  const adoptNames: string[] = [];
  for (const d of scan.found) {
    const np = normPath(d.path);
    if (np && byPath.has(np)) { existing++; continue; }
    const key = normName(d.name);
    const adopt = key ? pathlessByName.get(key) : undefined;
    if (adopt) {
      adopted++;
      adoptNames.push(d.name);
      pathlessByName.delete(key);
      if (np) byPath.add(np);
      continue;
    }
    added++;
    addNames.push(d.name);
    if (np) byPath.add(np);
  }
  return { ok: true, root, found: scan.found.length, added, adopted, existing, total: projects.length + added, addNames, adoptNames };
}

type CliModelRuntime = 'grok' | 'antigravity';
type CliModelCacheEntry = { at: number; models: string[] };
const LIVE_CLI_MODEL_TIMEOUT_MS = 15_000;
const cliModelCache = new Map<CliModelRuntime, CliModelCacheEntry>();

function cliEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.grok/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
  ];
  return { ...process.env, PATH: Array.from(new Set(dirs)).join(':') };
}

function codexModelsFromCache(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
    const models = (JSON.parse(raw).models ?? []) as { slug?: string; visibility?: string; priority?: number }[];
    return models
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

const CODEX_GPT56_RE = /^gpt-5\.6(?:-|$)/i;
const MIN_CODEX_VERSION_FOR_GPT56 = '0.144.0';

function parseVersion(raw: string | undefined): [number, number, number] | null {
  const m = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: string | undefined, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return -1;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

function codexCliVersion(): string | undefined {
  try {
    return execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env: cliEnv(),
    }).trim();
  } catch {
    return undefined;
  }
}

function codexSupportsGpt56(cachedModels: string[]): boolean {
  if (cachedModels.some((model) => CODEX_GPT56_RE.test(model))) return true;
  return compareVersions(codexCliVersion(), MIN_CODEX_VERSION_FOR_GPT56) >= 0;
}

function filterCodexModelsForInstalledCli(models: string[], cachedModels: string[]): string[] {
  if (codexSupportsGpt56(cachedModels)) return models;
  return models.filter((model) => !CODEX_GPT56_RE.test(model));
}

function cachedCliModels(runtime: CliModelRuntime, refresh: boolean, load: () => string[]): string[] {
  const cached = cliModelCache.get(runtime);
  if (cached && !refresh) return cached.models;
  try {
    const models = load();
    cliModelCache.set(runtime, { at: Date.now(), models });
    return models;
  } catch {
    if (cached) return cached.models;
    cliModelCache.set(runtime, { at: Date.now(), models: [] });
    return [];
  }
}

function cliModelInfo(runtime: CliModelRuntime): CliModelCacheEntry | undefined {
  return cliModelCache.get(runtime);
}

function grokModelsFromCli(refresh = false): string[] {
  return cachedCliModels('grok', refresh, () => {
    const stdout = execFileSync('grok', ['models'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: LIVE_CLI_MODEL_TIMEOUT_MS,
      env: cliEnv(),
    });
    if (!/available models/i.test(stdout) || /not authenticated|not logged in|signed out|login required/i.test(stdout)) return [];
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[*-]\s*/, '').replace(/\s+\(default\)$/i, '').trim())
      .filter((line) => /^[a-z0-9][a-z0-9._:-]*$/i.test(line));
  });
}

function antigravityModelsFromCli(refresh = false): string[] {
  return cachedCliModels('antigravity', refresh, () => {
    for (const command of ['agy', 'antigravity']) {
      try {
        const stdout = execFileSync(command, ['models'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: LIVE_CLI_MODEL_TIMEOUT_MS,
          env: cliEnv(),
        });
        if (!stdout.trim() || /not authenticated|not logged in|signed out|login required/i.test(stdout)) continue;
        const models = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && line.length <= 120 && !/token|secret|bearer|api[_-]?key/i.test(line));
        if (models.length) return models;
      } catch {
        // Try the next known Antigravity CLI entry point.
      }
    }
    return [];
  });
}

/** Catalog with subscription CLI live model lists merged into curated/runtime providers. */
function runtimeCatalogWithLiveCliModels(options: { refreshCli?: boolean } = {}): Record<string, string[]> {
  const cat = buildRuntimeCatalog(loadSettings().providers);
  const codex = codexModelsFromCache();
  if (codex.length) cat.codex = Array.from(new Set([...codex, ...(cat.codex ?? [])]));
  cat.codex = filterCodexModelsForInstalledCli(cat.codex ?? [], codex);
  const refreshCli = Boolean(options.refreshCli);
  const grok = grokModelsFromCli(refreshCli);
  if (grok.length) cat.grok = Array.from(new Set([...grok, ...(cat.grok ?? [])]));
  const antigravity = antigravityModelsFromCli(refreshCli);
  if (antigravity.length) cat.antigravity = Array.from(new Set([...antigravity, ...(cat.antigravity ?? [])]));
  return cat;
}

/**
 * Per-runtime model freshness: the live list + where it came from + when it was last
 * refreshed. Feeds the UI so the operator can see each runtime's models really are current
 * (and which ones are curated fallbacks with no live source). codex reads its own CLI cache
 * (mtime = freshness); the claude and ollama runtimes read their backing provider's last sync;
 * cursor-cli is curated-only (no public model API).
 */
type RuntimeFreshness = {
  runtime: string;
  label?: string;
  kind?: 'harness' | RuntimeModelLaneKind;
  models: string[];
  count: number;
  source: 'codex-cache' | 'grok-cli' | 'antigravity-cli' | 'provider' | 'curated' | 'none';
  provider?: string;
  lastCheckedMs: number | null;
  selectable?: boolean;
  detail?: string;
};
async function runtimeFreshness(): Promise<RuntimeFreshness[]> {
  const providers = loadSettings().providers;
  const enrichedProviders = listProvidersEnriched();
  const cat = runtimeCatalogWithLiveCliModels();
  const grokInfo = cliModelInfo('grok');
  const antigravityInfo = cliModelInfo('antigravity');
  const managed = await subsStatus().then((rows) => Object.values(rows)).catch(() => []);
  const available = settingsAvailableRuntimeSet(enrichedProviders, managed);
  const managedByRuntime = new Map(managed.filter(managedRuntimeHasEvidence).map((s) => [s.runtime, s]));
  // Newest enabled provider that has synced models AND backs this runtime.
  const providerFor = (rt: string): ProviderProfile | undefined =>
    providers
      .filter(
        (p) =>
          p.enabled !== false &&
          (p.lastSync?.models?.length ?? 0) > 0 &&
          providerKindToRuntimes(p.kind as ProviderKind).includes(rt) &&
          (rt !== 'ollama' || isLocalProvider(p)),
      )
      .sort((a, b) => (b.lastSync?.at ?? 0) - (a.lastSync?.at ?? 0))[0];
  const providerRows = buildProviderModelLanes(enrichedProviders).map((lane): RuntimeFreshness => ({
    runtime: lane.id,
    label: lane.label,
    kind: lane.kind,
    models: lane.models,
    count: lane.models.length,
    source: lane.source,
    provider: lane.provider,
    lastCheckedMs: lane.lastCheckedMs,
    selectable: lane.selectable,
    detail: lane.detail,
  }));
  const hasConcreteLocalProviderLane = providerRows.some((row) => row.kind === 'local' && row.count > 0);
  const harnessRows = RUNTIMES
    .filter((rt) => !(rt === 'ollama' && hasConcreteLocalProviderLane))
    .map((rt): RuntimeFreshness => {
    const models = cat[rt] ?? [];
    const selectable = available.has(rt);
    const linkedSubscription = managedByRuntime.has(rt) && !runtimeHasManagerHarness(rt);
    const unavailableDetail = selectable
      ? undefined
      : linkedSubscription
        ? `${runtimeDisplayLabel(rt)} is linked in Settings, but the current id-agents manager does not expose a runnable ${runtimeDisplayLabel(rt)} harness yet. Keep using a supported harness or synced API provider lane until an adapter is available.`
        : 'Not currently available from Settings; install/sign in or sync a matching backend before assigning this harness.';
    if (rt === 'codex') {
      let mt: number | null = null;
      try { mt = statSync(join(homedir(), '.codex', 'models_cache.json')).mtimeMs; } catch { mt = null; }
      const live = codexModelsFromCache().length > 0;
      return { runtime: rt, kind: 'harness', models, count: models.length, source: live ? 'codex-cache' : 'curated', lastCheckedMs: live ? mt : null, selectable, detail: unavailableDetail };
    }
    if (rt === 'grok') {
      const live = (grokInfo?.models.length ?? 0) > 0;
      const canRun = selectable || live;
      return { runtime: rt, kind: 'harness', models, count: models.length, source: live ? 'grok-cli' : 'curated', lastCheckedMs: live ? grokInfo?.at ?? null : null, selectable: canRun, detail: canRun ? undefined : unavailableDetail };
    }
    if (rt === 'antigravity') {
      const live = (antigravityInfo?.models.length ?? 0) > 0;
      const canRun = selectable || live;
      return { runtime: rt, kind: 'harness', models, count: models.length, source: live ? 'antigravity-cli' : 'curated', lastCheckedMs: live ? antigravityInfo?.at ?? null : null, selectable: canRun, detail: canRun ? undefined : unavailableDetail };
    }
    const p = providerFor(rt);
    if (p) return { runtime: rt, kind: 'harness', models, count: models.length, source: 'provider', provider: p.name, lastCheckedMs: p.lastSync?.at ?? null, selectable, detail: unavailableDetail };
    return { runtime: rt, kind: 'harness', models, count: models.length, source: models.length ? 'curated' : 'none', lastCheckedMs: null, selectable, detail: unavailableDetail };
  });
  return [...harnessRows, ...providerRows];
}

/** Probe every enabled provider that backs a runtime, refresh its synced model list, and
 *  return the rebuilt per-runtime catalog. Shared by the manual `runtime:probe` method and
 *  the background model-refresh loop ("the checker that stays up to date"). */
async function probeAllRuntimes(): Promise<Record<string, string[]>> {
  const providers = loadSettings().providers;
  await Promise.all(
    providers
      .filter((p) => p.enabled !== false)
      .map(async (p) => {
        try {
          const outcome = await new ProviderClient(p, resolveProviderKey(p)).probe();
          recordProviderSync(p.name, {
            at: Date.now(),
            status: outcome.status,
            modelCount: outcome.models.length,
            models: outcome.models.slice(0, 200).map((m) => m.id),
            keySource: keySourceOf(p),
          });
        } catch {
          /* leave the provider's last sync as-is on probe failure */
        }
      }),
  );
  return runtimeCatalogWithLiveCliModels({ refreshCli: true });
}

type RuntimeAssignment = { name?: string; runtime?: string; model?: string };
type RuntimeAssignmentCheck = {
  name: string;
  runtime: string;
  label: string;
  model?: string;
  ok: boolean;
  detail: string;
  source: 'harness' | 'provider';
  provider?: string;
  modelCount?: number;
};
type RuntimeAssignmentVerification = {
  ok: boolean;
  checkedAt: number;
  rows: RuntimeAssignmentCheck[];
  refreshedCatalog: Record<string, string[]>;
  providers: ReturnType<typeof listProvidersEnriched>;
};

async function verifyRuntimeAssignments(assignments: RuntimeAssignment[]): Promise<RuntimeAssignmentVerification> {
  const rowsIn = (Array.isArray(assignments) ? assignments : [])
    .map((row, i) => ({
      name: String(row?.name ?? `row ${i + 1}`).trim() || `row ${i + 1}`,
      runtime: String(row?.runtime ?? '').trim(),
      model: String(row?.model ?? '').trim(),
    }));

  const providerNames = Array.from(new Set(rowsIn.map((row) => providerLaneName(row.runtime)).filter(Boolean))) as string[];
  await Promise.all(providerNames.map(async (name) => {
    const p = loadSettings().providers.find((x) => x.name === name);
    if (!p) return;
    try {
      const outcome = await new ProviderClient(p, resolveProviderKey(p)).probe(undefined, 8000);
      recordProviderSync(p.name, {
        at: Date.now(),
        status: outcome.status,
        modelCount: outcome.models.length,
        models: outcome.models.slice(0, 200).map((m) => m.id),
        keySource: keySourceOf(p),
      });
    } catch {
      recordProviderSync(p.name, {
        at: Date.now(),
        status: 'error',
        modelCount: 0,
        models: [],
        keySource: keySourceOf(p),
      });
    }
  }));

  const providers = listProvidersEnriched();
  const managed = await subsStatus().then((rows) => Object.values(rows)).catch(() => []);
  const availableHarnesses = settingsAvailableRuntimeSet(providers, managed);
  const providerLanes = new Map(buildProviderModelLanes(providers).map((lane) => [lane.id, lane]));
  const refreshedCatalog = runtimeCatalogWithLiveCliModels();
  for (const rt of ['grok', 'antigravity']) {
    if ((refreshedCatalog[rt] ?? []).length > 0) availableHarnesses.add(rt);
  }
  const rows = rowsIn.map((row): RuntimeAssignmentCheck => {
    if (!row.runtime) {
      return { name: row.name, runtime: '', label: 'None', model: row.model || undefined, ok: false, detail: 'No runtime selected.', source: 'harness', modelCount: 0 };
    }
    const providerName = providerLaneName(row.runtime);
    if (providerName) {
      const lane = providerLanes.get(row.runtime);
      const models = refreshedCatalog[row.runtime] ?? lane?.models ?? [];
      if (!lane) {
        return { name: row.name, runtime: row.runtime, label: runtimeDisplayLabel(row.runtime), model: row.model || undefined, ok: false, detail: `Provider lane "${providerName}" is missing or disabled in Settings.`, source: 'provider', provider: providerName, modelCount: 0 };
      }
      if (!lane.selectable) {
        return { name: row.name, runtime: row.runtime, label: lane.label, model: row.model || undefined, ok: false, detail: lane.detail, source: 'provider', provider: providerName, modelCount: models.length };
      }
      if (row.model && models.length && !models.includes(row.model)) {
        return { name: row.name, runtime: row.runtime, label: lane.label, model: row.model, ok: false, detail: `Model "${row.model}" is not in the latest synced ${providerName} model list.`, source: 'provider', provider: providerName, modelCount: models.length };
      }
      return { name: row.name, runtime: row.runtime, label: lane.label, model: row.model || undefined, ok: true, detail: `Verified API provider lane (${models.length} model${models.length === 1 ? '' : 's'}).`, source: 'provider', provider: providerName, modelCount: models.length };
    }

    const models = refreshedCatalog[row.runtime] ?? [];
    if (!availableHarnesses.has(row.runtime)) {
      return { name: row.name, runtime: row.runtime, label: runtimeDisplayLabel(row.runtime), model: row.model || undefined, ok: false, detail: 'Runtime is not currently available from Settings.', source: 'harness', modelCount: models.length };
    }
    if (row.model && models.length && !models.includes(row.model)) {
      return { name: row.name, runtime: row.runtime, label: runtimeDisplayLabel(row.runtime), model: row.model, ok: false, detail: `Model "${row.model}" is not in the current ${runtimeDisplayLabel(row.runtime)} catalog.`, source: 'harness', modelCount: models.length };
    }
    return { name: row.name, runtime: row.runtime, label: runtimeDisplayLabel(row.runtime), model: row.model || undefined, ok: true, detail: `Verified assignable harness (${models.length} model${models.length === 1 ? '' : 's'}).`, source: 'harness', modelCount: models.length };
  });

  return { ok: rows.every((row) => row.ok), checkedAt: Date.now(), rows, refreshedCatalog, providers };
}

/** Where a provider's API key resolves from, without exposing the value. */
function keySourceOf(p: ProviderProfile): 'config' | 'env' | 'none' {
  if (p.apiKey) return 'config';
  if (resolveProviderKey(p)) return 'env';
  return 'none';
}
/** Provider list enriched with the (non-secret) key source for the UI. */
function listProvidersEnriched(): (ProviderProfile & { keySource: 'config' | 'env' | 'none'; needsKey: boolean })[] {
  return loadSettings().providers.map((p) => ({ ...p, keySource: keySourceOf(p), needsKey: providerNeedsKey(p) }));
}

function isLoopbackProvider(p: ProviderProfile): boolean {
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function providerBridgeStamp(p: ProviderProfile): string {
  return JSON.stringify({
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    enabled: p.enabled !== false,
    default: p.default === true,
    keySource: keySourceOf(p),
    needsKey: providerNeedsKey(p),
    modelSelectionMode: p.modelSelection?.mode ?? 'all',
    modelSelectionModels: [...new Set(p.modelSelection?.models ?? [])].sort(),
  });
}

function normalizeProviderModelSelection(input: ProviderModelSelection): ProviderModelSelection {
  const models = Array.from(new Set((input?.models ?? []).map((m) => String(m).trim()).filter(Boolean)));
  return input?.mode === 'selected' && models.length
    ? { mode: 'selected', models, updatedAt: Date.now() }
    : { mode: 'all', models: [], updatedAt: Date.now() };
}

function providerLaneName(runtime: string): string | null {
  if (!runtime.startsWith('provider:')) return null;
  try {
    return decodeURIComponent(runtime.slice('provider:'.length));
  } catch {
    return runtime.slice('provider:'.length);
  }
}

function providerLaneEnvName(name: string): string {
  return `IDCTL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function resolveProviderLaneAssignment(runtime: string): { providerName: string; provider: { name: string; kind?: string; baseUrl: string; apiKey?: string; keyEnv?: string } } | null {
  const providerName = providerLaneName(runtime);
  if (!providerName) return null;
  const p = loadSettings().providers.find((x) => x.name === providerName);
  if (!p) throw new Error(`provider lane "${providerName}" is no longer configured in Settings`);
  if (!providerRouteReadyForAssignment(p)) throw new Error(`provider lane "${providerName}" is not ready; Connect & sync it in Settings first`);
  const apiKey = resolveProviderKey(p) || (!providerNeedsKey(p) && isLoopbackProvider(p) ? 'idacc-local-provider-no-key' : '');
  if (providerNeedsKey(p) && !apiKey) throw new Error(`provider lane "${providerName}" is missing an API key`);
  return {
    providerName,
    provider: {
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      keyEnv: providerLaneEnvName(p.name),
    },
  };
}

function providerRouteReadyForAssignment(p: ProviderProfile): boolean {
  const keyReady = !providerNeedsKey(p) || Boolean(resolveProviderKey(p));
  const modelCount = p.lastSync?.models?.length ?? p.lastSync?.modelCount ?? 0;
  return p.enabled !== false && keyReady && modelCount > 0 && (p.lastSync?.status === 'live' || p.lastSync?.status === 'preset' || modelCount > 0);
}

async function setAgentRuntimeFromSettings(agentId: string, runtime: string, team?: string) {
  const scoped = team ? client.withTeam(String(team)) : client;
  const assignment = resolveProviderLaneAssignment(runtime);
  if (!assignment) return scoped.setAgentRuntime(String(agentId), String(runtime));
  return scoped.setAgentProviderRuntime(String(agentId), String(runtime), assignment.provider);
}

async function prepareOnboardRuntime(plan: OnboardPlan): Promise<PreparedRuntime | undefined> {
  const runtime = String(plan.runtime ?? '');
  const assignment = resolveProviderLaneAssignment(runtime);
  if (!assignment) return undefined;
  return {
    label: `Assign API lane ${assignment.providerName}`,
    rebuildLabel: 'Rebuild to apply API lane',
    assignAfterSpawn: async (agentId, scopedClient, scopedPlan) => {
      await scopedClient.setAgentProviderRuntime(String(agentId), runtime, assignment.provider);
      if (scopedPlan.model?.trim()) await scopedClient.setAgentModel(String(agentId), scopedPlan.model.trim());
      return scopedPlan.model?.trim()
        ? `${assignment.providerName} - ${scopedPlan.model.trim()}`
        : assignment.providerName;
    },
  };
}

function skillGraphId(name: string): number {
  const h = createHash('sha256').update(`idacc-skill:${name.trim().toLowerCase()}`).digest('hex');
  return 1_000_000_000_000 + (Number.parseInt(h.slice(0, 10), 16) % 900_000_000_000);
}

function uniqueTags(values: unknown[]): string[] {
  return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))]
    .map((tag) => tag.slice(0, 80));
}

function skillDomain(tags: string[]): string {
  return tags.find((tag) => !/^(idacc|control-center|skill|skills|skill-catalog)$/i.test(tag)) ?? 'idacc-library';
}

function brainSkillNodes(skills: LibrarySkillEntry[], autoTags: Record<string, string[]>): BrainSkillNode[] {
  return skills
    .filter((skill) => skill.name?.trim())
    .map((skill) => {
      const tags = uniqueTags([...(skill.tags ?? []), ...(autoTags[skill.name] ?? []), 'idacc', 'skill-catalog']);
      return {
        skillId: skillGraphId(skill.name),
        name: skill.name,
        description: skill.description ?? '',
        domain: skillDomain(tags),
        tags,
        computeCost: 0,
        chainable: true,
      };
    });
}

function skillCatalogMemory(skills: LibrarySkillEntry[], nodes: BrainSkillNode[]): string {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  return [
    '# IDACC skill catalog',
    '',
    `Synced skills: ${nodes.length}`,
    `Updated: ${new Date().toISOString()}`,
    '',
    ...skills.slice(0, 200).map((skill) => {
      const node = byName.get(skill.name);
      const tags = node?.tags?.filter((tag) => !['idacc', 'skill-catalog'].includes(tag)).join(', ') || 'untagged';
      const desc = String(skill.description ?? '').replace(/\s+/g, ' ').trim();
      return `- ${skill.name} [${node?.skillId ?? 'unmapped'}] (${tags})${desc ? `: ${desc.slice(0, 220)}` : ''}`;
    }),
  ].join('\n');
}

function skillCatalogStamp(skills: LibrarySkillEntry[], autoTags: Record<string, string[]>): string {
  return JSON.stringify(skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      tags: uniqueTags([...(skill.tags ?? []), ...(autoTags[skill.name] ?? [])]).sort().join('|'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}
function pluginFsToolNames(sourcePath?: string): string[] {
  if (!sourcePath) return [];
  const toolsDir = join(sourcePath, 'tools');
  try {
    if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) return [];
    return readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name.replace(/\.[cm]?js$/i, ''))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function stripMarkdownFrontmatter(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (match ? text.slice(match[0].length) : text).trim();
}

type LocalSkillCandidate = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
  sourcePath: string;
  installed: boolean;
  duplicate: boolean;
};

function splitFrontmatterValue(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[, ]+/)
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseSkillFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') return { frontmatter: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\r$/, '');
    if (trimmed === '---' || trimmed === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    frontmatter[key] = value.trim().replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') };
}

function localSkillCandidateRoots(): Array<{ label: string; root: string }> {
  const home = homedir();
  return [
    { label: 'Codex', root: join(home, '.codex', 'skills') },
    { label: 'Agents', root: join(home, '.agents', 'skills') },
    { label: 'ID Agents', root: join(home, 'bob', 'Library', 'Assistants', 'idagents', '.agents', 'skills') },
  ];
}

function scanLocalSkillCandidates(installedNames: string[]): LocalSkillCandidate[] {
  const installed = new Set(installedNames);
  const seen = new Map<string, LocalSkillCandidate>();
  for (const { label, root } of localSkillCandidateRoots()) {
    try {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillFile = join(root, entry.name, 'SKILL.md');
        if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
        const raw = readFileSync(skillFile, 'utf8');
        const parsed = parseSkillFrontmatter(raw);
        const name = (parsed.frontmatter.name || entry.name).trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) continue;
        const desc = (parsed.frontmatter.description || parsed.body.match(/^#\s+(.+)$/m)?.[1] || `Local ${label} skill ${name}`)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1024);
        const tags = splitFrontmatterValue(parsed.frontmatter.tags || '')
          .concat(splitFrontmatterValue(parsed.frontmatter.category || ''))
          .filter((tag, idx, arr) => arr.indexOf(tag) === idx)
          .slice(0, 12);
        const candidate: LocalSkillCandidate = {
          id: `${label}:${name}`,
          name,
          description: desc || `Local ${label} skill ${name}`,
          tags,
          source: label,
          sourcePath: skillFile,
          installed: installed.has(name),
          duplicate: seen.has(name) || installed.has(name),
        };
        const existing = seen.get(name);
        if (!existing || (existing.installed && !candidate.installed)) seen.set(name, candidate);
      }
    } catch {
      // Ignore unreadable roots. The renderer surfaces only importable candidates.
    }
  }
  return [...seen.values()].sort((a, b) => Number(a.installed) - Number(b.installed) || a.name.localeCompare(b.name));
}

async function importLocalSkillCandidate(id: string): Promise<LibrarySkillEntry> {
  const library = await client.librarySkills();
  const candidates = scanLocalSkillCandidates(library.map((skill) => skill.name));
  const candidate = candidates.find((entry) => entry.id === id);
  if (!candidate) throw new Error('Local skill candidate is no longer available.');
  if (candidate.installed) throw new Error(`Skill ${candidate.name} already exists in the manager catalog.`);
  const raw = readFileSync(candidate.sourcePath, 'utf8');
  const parsed = parseSkillFrontmatter(raw);
  const metadata: Record<string, string> = {
    source: `local:${candidate.source.toLowerCase().replace(/\s+/g, '-')}`,
  };
  if (candidate.tags.length) metadata.tags = candidate.tags.join(', ');
  return client.createSkill({
    name: candidate.name,
    description: candidate.description,
    ...(parsed.frontmatter.license && { license: parsed.frontmatter.license }),
    ...(parsed.frontmatter.compatibility && { compatibility: parsed.frontmatter.compatibility }),
    ...(parsed.frontmatter['allowed-tools'] && { allowedTools: parsed.frontmatter['allowed-tools'] }),
    metadata,
    body: stripMarkdownFrontmatter(raw),
  });
}

function projectedSkillDescription(name: string, detailDescription?: string | null, body?: string): string {
  const fromDetail = String(detailDescription ?? '').replace(/\s+/g, ' ').trim();
  if (fromDetail) return fromDetail.slice(0, 1024);
  const heading = body?.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+/g, ' ').trim();
  return (heading ? `Projected plugin skill: ${heading}` : `Projected instruction skill from plugin ${name}`).slice(0, 1024);
}

async function inspectLibraryPlugins(): Promise<LibraryPluginInspection[]> {
  const [plugins, skills] = await Promise.all([
    client.libraryPlugins(),
    client.librarySkills().catch(() => [] as LibrarySkillEntry[]),
  ]);
  const skillNames = skills.map((skill) => skill.name);
  const inspections = await Promise.all(plugins.map(async (plugin) => {
    const detail = await client.libraryPluginDetail(plugin.name).catch(() => null);
    return inspectLibraryPluginMetadata(plugin, detail, skillNames, pluginFsToolNames(detail?.source_path ?? plugin.source_path));
  }));
  return inspections;
}

async function projectPluginSkill(name: string): Promise<ProjectPluginSkillResult> {
  const pluginName = String(name ?? '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) {
    throw new Error('Plugin skill projection requires a lowercase agentskills.io-compatible name.');
  }
  const [plugins, skills] = await Promise.all([client.libraryPlugins(), client.librarySkills()]);
  const plugin = plugins.find((entry) => entry.name === pluginName);
  if (!plugin) throw new Error(`Plugin ${pluginName} is no longer in the manager inventory.`);
  const detail = await client.libraryPluginDetail(pluginName);
  const inspection = inspectLibraryPluginMetadata(
    plugin,
    detail,
    skills.map((skill) => skill.name),
    pluginFsToolNames(detail?.source_path ?? plugin.source_path),
  );
  if (inspection.skillProjection !== 'available' || !detail?.skillBody) {
    throw new Error(`Plugin ${pluginName} cannot be digested as a plain skill: ${inspection.notes.join(' ') || inspection.skillProjection}`);
  }
  const body = stripMarkdownFrontmatter(detail.skillBody);
  const entry = await client.createSkill({
    name: pluginName,
    description: projectedSkillDescription(pluginName, detail.description ?? plugin.description, body),
    metadata: {
      tags: 'plugin,skill-catalog',
      source: 'plugin',
    },
    body,
  });
  return { ok: true, plugin: pluginName, projected: true, entry, inspection };
}
import type { LibrarySkillEntry, McpServerSpec, CreateSkillInput, LibraryPluginInspection, ProjectPluginSkillResult } from '../../../idctl/src/api/client.ts';
import { filterParkedMcpServers } from '../../../idctl/src/settings/mcpCatalog.ts';
import { brokerServerPath, mintAgentToken, revokeAgentToken, brokerUrl } from './computeruse/broker.ts';
// The Computer Use MCP server name. NEVER "computer-use" — Claude Code reserves that
// name and rejects the entire MCP config, breaking every dispatch. CU_MCP_ALIASES
// includes the old broken name so existing attachments can be detected + cleaned up.
const CU_MCP_NAME = 'mac-control';
const CU_MCP_ALIASES = ['mac-control', 'computer-use'];
function scopedAgentKey(agent: string, team?: string): string {
  const name = String(agent);
  return team ? `${String(team)}:${name}` : name;
}

function requireCurrentComputerUseAgent(agents: Agent[], agentId: string, agentName?: string): Agent {
  const id = String(agentId ?? '').trim();
  const name = String(agentName ?? '').trim();
  if (!id) throw new Error('computer-use agent id is required; refresh and choose the current roster row.');
  const found = agents.find((x) => String(x.id) === id);
  if (!found) throw new Error(`computer-use target no longer exists: ${name || id}`);
  if (name && String(found.name) !== name) {
    throw new Error(`computer-use target changed from ${name} to ${found.name}; refresh before changing access.`);
  }
  return found;
}

// idctl-desktop is the operator's local control center talking to 127.0.0.1,
// so it is a legitimate admin client (admin-gated routes: skill install, MCP attach).
let cfg: Config = loadConfig({ team: 'default', admin: true });
let client = new ManagerClient(cfg);
brain.setTransport((request) => client.brainRequest(request));
configureControlEventEmitter((event) => client.emitControlEvent(event));
let activeKeyProvider: KeyProvider | null = null;
const keys = new Proxy({} as KeyProvider, {
  get(_target, property) {
    if (!activeKeyProvider) throw new Error('Live Safe/Zodiac provider is still initializing. Retry after Identity refreshes.');
    const value = activeKeyProvider[property as keyof KeyProvider];
    return typeof value === 'function' ? value.bind(activeKeyProvider) : value;
  },
});

/** Install the Electron main-process provider before the Identity renderer starts. */
export function configureKeyProvider(provider: KeyProvider): void {
  activeKeyProvider = provider;
}
const RECENT_DONE_TASK_LIMIT = 25;
let doneTaskLimitUnsupportedAt = 0;

type OrgControlState = Pick<IdctlConfig, 'coordinators' | 'primaryCoordinator' | 'secondaryLeads' | 'orgSync'>;
type TaskOverlayControlState = Pick<IdctlConfig, 'taskLanes' | 'taskDeps' | 'taskReview'>;

let controlStateWriteTail: Promise<void> = Promise.resolve();

function controlStateClient(): ManagerClient {
  // App-wide control state must not move when the operator changes the visible
  // team. The default team is the durable control-plane namespace.
  return client.withTeam(PRIMARY_TEAM);
}

function serializeControlStateWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = controlStateWriteTail.then(write, write);
  controlStateWriteTail = next.then(() => undefined, () => undefined);
  return next;
}

function mirrorProjects(projects: ProjectEntry[]): ProjectEntry[] {
  const settings = loadSettings();
  settings.projects = projects;
  saveSettings(settings);
  return projects;
}

async function managerProjects(): Promise<ProjectEntry[]> {
  const local = loadSettings().projects ?? [];
  const rows = await controlStateClient().controlStateList<ProjectEntry>('project');
  if (rows.length > 0) {
    return mirrorProjects(rows.map((row) => row.value).filter((project) => Boolean(project?.id && project?.name)));
  }
  if (local.length > 0) {
    await Promise.all(local.map((project) => controlStateClient().controlStateSet('project', project.id, project)));
  }
  return local;
}

async function persistProject(project: ProjectEntry): Promise<ProjectEntry[]> {
  await controlStateClient().controlStateSet('project', project.id, project);
  const local = loadSettings().projects ?? [];
  const next = [...local.filter((entry) => entry.id !== project.id), project];
  return mirrorProjects(next);
}

async function persistAllProjects(projects: ProjectEntry[]): Promise<ProjectEntry[]> {
  await Promise.all(projects.map((project) => controlStateClient().controlStateSet('project', project.id, project)));
  return mirrorProjects(projects);
}

function orgControlSnapshot(settings = loadSettings()): OrgControlState {
  return {
    coordinators: settings.coordinators ?? {},
    primaryCoordinator: settings.primaryCoordinator,
    secondaryLeads: settings.secondaryLeads ?? [],
    orgSync: settings.orgSync ?? { enabled: true, autoRebuild: true },
  };
}

function mirrorOrgControl(value: OrgControlState): OrgControlState {
  const settings = loadSettings();
  settings.coordinators = value.coordinators ?? {};
  settings.primaryCoordinator = value.primaryCoordinator;
  settings.secondaryLeads = value.secondaryLeads ?? [];
  settings.orgSync = value.orgSync ?? { enabled: true, autoRebuild: true };
  saveSettings(settings);
  return orgControlSnapshot(settings);
}

async function managerOrgControl(): Promise<OrgControlState> {
  const manager = controlStateClient();
  const current = await manager.controlStateGet<OrgControlState>('global', 'organization');
  if (current) return mirrorOrgControl(current.value);
  const local = orgControlSnapshot();
  await manager.controlStateSet('global', 'organization', local);
  return local;
}

async function persistOrgControl(): Promise<OrgControlState> {
  const value = orgControlSnapshot();
  await serializeControlStateWrite(() => controlStateClient().controlStateSet('global', 'organization', value));
  return value;
}

function taskOverlaySnapshot(settings = loadSettings()): TaskOverlayControlState {
  return {
    taskLanes: settings.taskLanes ?? {},
    taskDeps: settings.taskDeps ?? {},
    taskReview: settings.taskReview ?? {},
  };
}

function mirrorTaskOverlay(value: TaskOverlayControlState): TaskOverlayControlState {
  const settings = loadSettings();
  settings.taskLanes = value.taskLanes ?? {};
  settings.taskDeps = value.taskDeps ?? {};
  settings.taskReview = value.taskReview ?? {};
  saveSettings(settings);
  return taskOverlaySnapshot(settings);
}

async function managerTaskOverlay(): Promise<TaskOverlayControlState> {
  const manager = controlStateClient();
  const current = await manager.controlStateGet<TaskOverlayControlState>('global', 'task-overlays');
  if (current) return mirrorTaskOverlay(current.value);
  const local = taskOverlaySnapshot();
  await manager.controlStateSet('global', 'task-overlays', local);
  return local;
}

async function persistTaskOverlay(): Promise<TaskOverlayControlState> {
  const value = taskOverlaySnapshot();
  await controlStateClient().controlStateSet('global', 'task-overlays', value);
  return value;
}

async function projectRouting(projectId?: string, fallbackTeam?: string, fallbackLead?: string): Promise<{
  project?: ProjectEntry;
  team?: string;
  lead?: string;
}> {
  const project = projectId
    ? (await managerProjects()).find((entry) => entry.id === projectId)
    : undefined;
  return {
    project,
    team: project?.team || fallbackTeam,
    lead: project?.lead || fallbackLead,
  };
}

function requireLiveKeyProvider(action: string): void {
  const capabilities = keys.capabilities();
  if (!capabilities.live) {
    throw new Error(
      `${action} is disabled because the active key provider is ${capabilities.provider}. `
      + 'Configure and verify the live Safe/ERC-7579 provider in Identity production readiness before changing on-chain authority.',
    );
  }
}

function resolveRequestedScope(input: number | SessionScope): SessionScope {
  if (typeof input === 'object' && input) return input;
  return SCOPE_PRESETS[Number(input) || 0] ?? SCOPE_PRESETS[0];
}

function requireBoundedLiveScope(scope: SessionScope): void {
  if (scope.label.toLowerCase().includes('full')) throw new Error('Full autonomous authority is not permitted.');
  if (!scope.targets.length || scope.targets.some((target) => target === '*')) {
    throw new Error('Live authority requires concrete contract targets; wildcard targets are refused.');
  }
  if (!(scope.functions ?? []).length) {
    throw new Error('Live authority requires explicit contract function signatures.');
  }
  if (scope.spendLimitWei !== '0') {
    throw new Error('Native-token value remains disabled until an attested allowance policy is configured.');
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function taskDedupeKey(t: Task): string {
  return String(t.shortId ?? t.uuid ?? t.name ?? `${t.teamName ?? ''}:${t.title}:${t.createdAt ?? ''}`);
}

function dedupeTasks(rows: Task[]): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const t of rows) {
    const id = taskDedupeKey(t);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(t);
  }
  return out;
}

async function managerTaskRows(team: string, status: 'todo' | 'doing' | 'done', limit?: number): Promise<Task[]> {
  if (status === 'done' && limit && doneTaskLimitUnsupportedAt && Date.now() - doneTaskLimitUnsupportedAt < 60_000) {
    return [];
  }
  const url = new URL('/tasks', client.managerUrl);
  url.searchParams.set('status', status);
  if (limit) url.searchParams.set('limit', String(limit));
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET /tasks?status=${status} -> ${res.status}`);
  const data = await res.json() as { tasks?: Task[] };
  const rows = data.tasks ?? [];
  if (status === 'done' && limit) {
    if (rows.length > limit) {
      doneTaskLimitUnsupportedAt = Date.now();
      return rows.slice(0, limit).map((t) => ({ ...t, teamName: t.teamName ?? team }));
    }
    doneTaskLimitUnsupportedAt = 0;
  }
  return rows.map((t) => ({ ...t, teamName: t.teamName ?? team }));
}

async function boardTasksForTeam(team: string): Promise<Task[]> {
  const scoped = client.withTeam(team);
  const readStatus = async (status: 'todo' | 'doing' | 'done', limit?: number): Promise<Task[]> => {
    try {
      return await managerTaskRows(team, status, limit);
    } catch {
      return (await scoped.tasksByStatus(status, limit ? { limit } : undefined).catch(() => []))
        .map((t) => ({ ...t, teamName: t.teamName ?? team }));
    }
  };
  const [todo, doing, done] = await Promise.all([
    readStatus('todo'),
    readStatus('doing'),
    readStatus('done', RECENT_DONE_TASK_LIMIT),
  ]);
  return dedupeTasks([...todo, ...doing, ...done]);
}

const readCallCache = new ReadCallCache();
const READ_ONLY_SYNC_METHODS = new Set([
  'configs',
  'librarySkills',
  'libraryTeams',
  'providers:list',
  'providers:probe',
  'providers:discover',
  'runtime:models',
  'runtime:freshness',
  'runtime:verifyAssignments',
  'subs:status',
]);

function goalDriverConfig(): GoalDriverConfig {
  return normalizeGoalDriverConfig(loadSettings().goalDriver);
}

async function eventTailCursor(scopedClient: ManagerClient): Promise<number> {
  const requestedTail = await scopedClient.events(0, { wait: 0, limit: 1, tail: true });
  if (!requestedTail.events?.length) return Number(requestedTail.next_seq) || 0;

  // Older managers ignore tail=1 and return the oldest retained event. Keep the
  // expensive catch-up inside the main process so React doesn't render thousands
  // of historical rows during startup. Patched managers return above immediately.
  let cursor = Number(requestedTail.next_seq) || 0;
  for (let i = 0; i < 200; i += 1) {
    const page = await scopedClient.events(cursor, { wait: 0, limit: 1000 });
    const next = Number(page.next_seq) || cursor;
    if (!page.events?.length || next <= cursor) return cursor;
    cursor = next;
    if (page.events.length < 1000) return cursor;
  }
  return cursor;
}

const METHODS: Record<string, (...a: any[]) => Promise<unknown>> = {
  // fleet
  health: () => client.health(),
  agents: () => client.agents(),
  teams: () => client.teams(),
  // Agents across ALL teams, grouped — for the Health roster.
  'agents:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    const groups = await mapTeamAgentGroups<Agent>(names, (name) => client.withTeam(name).agents());
    return groups.filter((g) => g.agents.length > 0);
  },
  events: (since: number) => client.events(Number(since) || 0, { wait: 20, limit: 100 }),
  'events:tail': () => eventTailCursor(client).then((next_seq) => ({ next_seq })),
  // Holistic activity: merge every team's recent events into one stream (tagged with
  // team), newest last. Used by the "All teams" Dashboard feed.
  'events:multi': async (limit?: number) => {
    const lim = Math.min(Number(limit) || 80, 120);
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    // Per-team cap so one hyperactive team can't flood the holistic feed — every team
    // contributes its NEWEST events; the union is then time-sorted.
    //
    // CRITICAL: the manager's `/events?since=N` returns events with seq > N, OLDEST-first,
    // so `since=0` returns the OLDEST retained events (the head of the ring), NOT the live
    // tail. Reading `since=0` directly showed days-old events ("activity not live"). Use
    // the manager's tail cursor, then fetch a recent window ending there and keep its
    // newest slice.
    const perTeam = Math.max(8, Math.ceil(lim / Math.max(1, names.length)));
    const win = Math.max(perTeam * 4, 200);
    const per = await Promise.all(
      names.map(async (name) => {
        const tc = client.withTeam(name);
        try {
          const next = await eventTailCursor(tc);
          const since = Math.max(0, next - win);
          const r = await tc.events(since, { wait: 0, limit: win });
          const evs = (r.events ?? []).map((e) => ({ ...e, team: e.team ?? name, timestamp: e.timestamp ?? e.occurred_at }));
          // This team's NEWEST perTeam by seq (seq is monotonic within a team).
          return evs.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)).slice(-perTeam);
        } catch {
          return [];
        }
      }),
    );
    // Merge every team; order newest-LAST by timestamp then seq (the Dashboard reverses to
    // show newest first); keep the newest `lim`.
    return per
      .flat()
      .sort((a, b) => ((a.timestamp ?? 0) - (b.timestamp ?? 0)) || ((Number(a.seq) || 0) - (Number(b.seq) || 0)))
      .slice(-lim);
  },
  // Holistic manager comms: merge every team's manager-owned /news inbox so the
  // Dashboard activity tile includes message/reply traffic even when no event
  // row was emitted for that communication.
  'news:allTeams': async (limit?: number) => {
    const lim = Math.min(Number(limit) || 80, 160);
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    const perTeam = Math.max(8, Math.ceil(lim / Math.max(1, names.length)));
    const per = await Promise.all(
      names.map(async (name) =>
        (await client.withTeam(name).news(perTeam).catch(() => []))
          .map((n) => ({ ...n, teamName: name })),
      ),
    );
    const seen = new Set<string>();
    const out: Array<(typeof per)[number][number]> = [];
    for (const n of per.flat()) {
      const id = `${n.teamName}:${n.id ?? `${n.timestamp}:${n.type}:${n.message ?? ''}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(n);
    }
    return out.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, lim);
  },
  // Live agent activity (tool/file steps) for the chat "what they're doing" feed.
  // Team-scoped so a same-named agent in another team can't bleed in; an optional
  // queryId narrows to a single dispatch (exact attribution when two dispatches
  // hit the same agent concurrently).
  'activity:get': (agent: string, since: number, team?: string, queryId?: string) =>
    client.activity(String(agent), Number(since) || 0, team ? String(team) : client.team, queryId ? String(queryId) : undefined),
  inboxPending: () => client.inboxPending(),
  // AI-assist: ask an agent to draft text (agent/team goals + instructions). Uses
  // the team's ★ coordinator when set, else any running agent.
  'ai:draft': (instruction: string, agent?: string) =>
    client.draftWithAI(String(instruction), { agent: agent ? String(agent) : (getCoordinator(client.team ?? 'default') ?? undefined) }),
  // Reply to a manager-inbox item (delivers the reply + clears it from pending).
  'inbox:respond': (queryId: string, message: string) => client.inboxRespond(String(queryId), String(message)),
  // Dismiss a manager-inbox item without a real answer (clears it from pending).
  'inbox:dismiss': (queryId: string) => client.inboxRespond(String(queryId), '(dismissed via control center)'),

  // tasks
  // Task board read model: open tasks plus bounded recent completions. The manager can hold
  // thousands of done rows; pulling all of them every live refresh makes Dashboard/Tasks lag.
  tasks: async () => boardTasksForTeam(client.team ?? cfg.team ?? 'default'),
  // Holistic task board: every team's open tasks plus recent done rows, each tagged with
  // teamName. Dedupe by stable id so global-pool managers do not show duplicate rows.
  'tasks:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    const per = await Promise.all(names.map((name) => boardTasksForTeam(name)));
    return dedupeTasks(per.flat());
  },
  // Manager-owned Kanban/dependency/review overlays. config.json is only a
  // rehydratable cache so board semantics survive desktop reinstalls/restarts.
  'tasks:lanes': async () => (await managerTaskOverlay()).taskLanes ?? {},
  'tasks:setLane': (ref: string, lane: string) => serializeControlStateWrite(async () => {
      await managerTaskOverlay();
      setTaskLane(String(ref), String(lane ?? ''));
      return (await persistTaskOverlay()).taskLanes ?? {};
    }),
  'tasks:deps': async () => (await managerTaskOverlay()).taskDeps ?? {},
  'tasks:setDeps': (ref: string, deps: string[]) => serializeControlStateWrite(async () => {
      await managerTaskOverlay();
      setTaskDeps(String(ref), Array.isArray(deps) ? deps.map(String) : []);
      return (await persistTaskOverlay()).taskDeps ?? {};
    }),
  'tasks:review': async () => (await managerTaskOverlay()).taskReview ?? {},
  'tasks:setReview': (ref: string, state: string) => serializeControlStateWrite(async () => {
      await managerTaskOverlay();
      setTaskReview(String(ref), String(state ?? ''));
      return (await persistTaskOverlay()).taskReview ?? {};
    }),

  // dispatch / lifecycle
  dispatch: (command: string) => {
    const prepared = optimizeAskCommand(String(command), { source: 'bridge:dispatch', team: client.team });
    return client.dispatch(prepared.command);
  },
  // team (optional, 3rd arg) routes the command to another team's fleet — used by the
  // holistic "All teams" Dashboard so per-agent actions hit the agent's own team.
  remote: (command: string, agent?: string, team?: string, timeoutMs?: number) => {
    const c = team ? client.withTeam(String(team)) : client;
    const prepared = optimizeAskCommand(String(command), { source: 'bridge:remote', team: c.team });
    const timeout = Number(timeoutMs);
    const signal = Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
    return c.remote(prepared.command, agent, signal);
  },

  // Resumable dispatch: START returns a queryId (or an inline reply for
  // manager-local commands); POLL checks that query. The renderer owns the loop
  // so an in-flight reply survives navigation, long tasks, and app restarts.
  'dispatch:start': async (command: string, sessionId?: string, team?: string) => {
    // sessionId = the desktop chat id → agent conversation key (isolates each chat).
    // team (optional) pins this dispatch to a specific team's manager namespace so
    // the caller (e.g. a per-page lead chat) is independent of the global active team.
    const c = team ? client.withTeam(String(team)) : client;
    const prepared = optimizeAskCommand(String(command), { source: 'bridge:dispatch:start', team: c.team });
    const env = await c.remote<{ queryId?: string; status?: string; result?: string; message?: string }>(prepared.command, undefined, undefined, sessionId ? String(sessionId) : undefined);
    const r = env.result as any;
    const queryId = r?.queryId;
    if (queryId) return { queryId: String(queryId) };
    const inline = typeof r === 'string' ? r : (r?.result ?? r?.message ?? '');
    return { inline: String(inline || '(no reply)') };
  },
  'query:poll': async (queryId: string, wait?: number, team?: string) => {
    const c = team ? client.withTeam(String(team)) : client;
    const q = await c.query(String(queryId), typeof wait === 'number' ? wait : undefined);
    const r = q.result as any;
    const text = typeof r === 'string' ? r : (r?.result ?? r?.message ?? '');
    return { status: q.status, text: String(text || ''), error: q.error };
  },

  // auto-decompose work for the fleet: lead splits an objective into sub-tasks…
  'work:decompose': async (objective: string, lead: string, team?: string, projectId?: string) => {
    const route = await projectRouting(projectId, team, lead);
    const c = route.team ? client.withTeam(String(route.team)) : client;
    const agents = await c.agents().catch(() => []);
    const list = agents.map((a) => ({
      name: a.name,
      runtime: a.runtime,
      status: a.status,
      skills: Array.isArray(a.metadata?.skills) ? (a.metadata!.skills as string[]) : [],
    }));
    const accountableLead = String(route.lead || getCoordinator(route.team || c.team || 'default') || 'lead');
    return decomposeWork(c, String(objective), accountableLead, list);
  },
  // …then create them all + farm out the work (parallel where possible). opts.lane
  // sets the Kanban lane; opts.dispatch=false queues them unowned instead of dispatching.
  // opts.team pins the plan to a specific team (independent of the global active team).
  // opts.respectOwners keeps explicit execution owners, but coordinator/validator owners
  // are still routed to an execution assignee when one exists.
  'work:createPlan': async (objective: string, subtasks: SubTask[], opts?: { dispatch?: boolean; lane?: string; team?: string; projectId?: string; planId?: string; respectOwners?: boolean; allowCoordinatorOwners?: boolean; allowInactiveOwners?: boolean; ownerOpenTaskCap?: number; coordinator?: string; leadCoordination?: boolean }) => {
    const route = await projectRouting(opts?.projectId, opts?.team, opts?.coordinator);
    const routed = { ...(opts ?? {}), team: route.team, coordinator: route.lead };
    return createAndDispatchPlan(route.team ? client.withTeam(String(route.team)) : client, String(objective), Array.isArray(subtasks) ? subtasks : [], routed);
  },
  // Explicit Plans/Goals delegation: resolve active team leads and create live,
  // assigned team-lead task rows. Returns failures for Inbox blocker routing.
  'work:delegateToTeamLeads': (objective: string, opts?: TeamLeadDelegationOptions) =>
    delegateObjectiveToTeamLeads(client, String(objective), opts ?? {}),
  // Cross-team fan-out: hand one objective to several teams' ACTIVE leads at once.
  'work:teamLeads': (teams: string[]) => teamLeads(client, Array.isArray(teams) ? teams.map(String) : []),
  'work:fanout': (objective: string, teams: string[]) =>
    fanOutObjective(client, String(objective), Array.isArray(teams) ? teams.map(String) : []),
  // Lead triages unassigned To-Do tasks: assign each to the best active agent + dispatch.
  'work:triage': async (lead: string, team?: string, projectId?: string) => {
    const route = await projectRouting(projectId, team, lead);
    return triageUnassigned(route.team ? client.withTeam(String(route.team)) : client, String(route.lead || 'lead'));
  },
  'draftDispatcher:runOnce': () => processDraftProposalsOnce(client),
  'goalDriver:getConfig': async () => goalDriverConfig(),
  'goalDriver:setConfig': async (partial: Partial<GoalDriverConfig>) => {
    setGoalDriver(normalizeGoalDriverConfig({ ...goalDriverConfig(), ...(partial ?? {}) }));
    return goalDriverConfig();
  },
  'goalDriver:runOnce': async () => runGoalDriverOnce(() => client, goalDriverConfig()),
  'goals:syncInstructions': async () => {
    const goalSync = await syncActiveWorkGoalInstructions(client);
    const org = await syncOrg(client, { autoRebuild: false });
    return { goalSync, org };
  },
  // Per-task token spend (keyed by task shortId) for the board cards.
  'tasks:usage': (team?: string) => (team ? client.withTeam(String(team)) : client).usageByTask(),
  // Control Center capability discovery (feature-detect CC-only manager routes).
  'manager:capabilities': () => client.capabilities(),

  // health probes
  probeAll: () => client.probeAll(),
  probeOne: (name: string, team?: string) => (team ? client.withTeam(String(team)) : client).probeOne(String(name)),
  'headroom:status': () => headroomStatus(),
  'headroom:audit': async () => headroomCoreAudit(loadSettings().headroomPilot),
  'headroom:pluginPath': async () => headroomPluginPathAudit({
    managerCapabilities: await client.capabilities().catch(() => null),
    managerPlugins: await client.libraryPlugins().catch(() => []),
    headroomStatus: await headroomStatus(),
  }),
  'headroom:backendContract': async () => {
    const pluginPath = await headroomPluginPathAudit({
      managerCapabilities: await client.capabilities().catch(() => null),
      managerPlugins: await client.libraryPlugins().catch(() => []),
      headroomStatus: await headroomStatus(),
    });
    return headroomBackendContractAudit(pluginPath);
  },
  'headroom:pilot': async () => loadSettings().headroomPilot,
  'headroom:setPilot': async (partial: Partial<HeadroomPilotSettings>) => setHeadroomPilot(partial).headroomPilot,
  'context:budgetReport': async () => contextBudgetReport(),
  'context:budgetRecent': async (limit?: number) => loadRecentContextBudgetRecords(Number(limit) || 20),
  'context:budgetRecord': async (id: string) => readContextBudgetRecord(String(id)),
  'context:budgetDryRun': async (command: string, source?: string, team?: string) =>
    contextBudgetDryRun(String(command), { source: source ? String(source) : 'bridge:dry-run', team: team ? String(team) : client.team }),
  'context:budgetReplayChats': async (options?: ContextBudgetHistoryReplayOptions) =>
    replayContextBudgetFromChatHistory(options ?? {}),

  // scheduling
  checkins: () => client.checkins(),
  'checkins:close': (id: string) => client.closeCheckin(String(id)),
  schedules: () => client.schedules(),
  // Every team's schedules, each tagged with its team — so the Schedule tab can surface
  // heartbeats whose target isn't in the CURRENT team's roster (e.g. a cross-team or
  // manager-level "task-master" heartbeat) instead of silently hiding them.
  'schedules:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    const per = await Promise.all(
      names.map(async (name) => (await client.withTeam(name).schedules().catch(() => [])).map((s) => ({ ...s, team: name }))),
    );
    return per.flat();
  },
  // team (optional, trailing) routes the schedule to an agent in a specific team —
  // used by the Work fold-out's Schedule/Loop/Dream modes (decoupled from active team).
  addHeartbeat: (agent: string, seconds: number, message: string, delivery?: 'internal' | 'talk', team?: string) =>
    (team ? client.withTeam(String(team)) : client).addHeartbeat(String(agent), Number(seconds), String(message), delivery),
  addCalendarCheckin: (agent: string, time: string, when: string, message: string, opts?: { timezone?: string; delivery?: 'internal' | 'talk' }, team?: string) =>
    (team ? client.withTeam(String(team)) : client).addCalendarCheckin(String(agent), String(time), String(when), String(message), opts ?? {}),
  // Optional trailing `team` routes the op to the schedule's own team (the Schedule tab's
  // cross-team heartbeat list controls heartbeats that live on other teams).
  pauseSchedule: (id: string, team?: string) => (team ? client.withTeam(String(team)) : client).pauseSchedule(String(id)),
  resumeSchedule: (id: string, team?: string) => (team ? client.withTeam(String(team)) : client).resumeSchedule(String(id)),
  removeSchedule: (id: string, team?: string) => (team ? client.withTeam(String(team)) : client).removeSchedule(String(id)),

  // teams / library
  libraryTeams: () => client.libraryTeams(),
  'team:install': (template: string, to: string) => client.installTeam(String(template), String(to)),
  configs: () => client.configs(),
  'team:preflight': (name: string) => client.deployPreflight(String(name)),
  deployTeam: (name: string) => client.deployTeam(String(name)),
  'team:delete': (name: string) => client.deleteTeam(String(name)),
  // Import a team from a pasted spec: spawn each parsed agent into a new team.
  'team:import': (team: string, agents: Array<{ name: string; role?: string; description?: string }>, opts: { runtime?: string; model?: string }) =>
    client.importTeam(String(team), agents ?? [], opts ?? {}),
  // Whole-team lifecycle: start/stop/rebuild every agent (fan-out), or probe the team.
  'team:lifecycle': (team: string, op: string) =>
    client.teamLifecycle(String(team), op === 'stop' ? 'stop' : op === 'rebuild' ? 'rebuild' : 'start'),
  'team:probe': (team: string) => client.probeTeam(String(team)),
  // Local-model (ollama) concurrency — how many local inferences run at once.
  'manager:localConcurrency': () => client.localConcurrency(),
  'manager:setLocalConcurrency': async (n: number) => {
    const r = await client.setLocalConcurrency(Number(n));
    setLocalConcurrencyPref(Number(n)); // persist → re-applied on connect (survives a manager restart)
    return r;
  },
  // Re-apply the persisted local concurrency to the manager — called on (re)connect.
  'manager:applyStoredConcurrency': async () => {
    const pref = loadSettings().localConcurrency;
    if (typeof pref === 'number' && pref >= 1) {
      return client.setLocalConcurrency(pref).then((r) => ({ applied: r.concurrency })).catch(() => ({ applied: null as number | null }));
    }
    return { applied: null as number | null };
  },
  // AI-assisted parse of a free-form spec → { team, agents }. Dispatches to the
  // team's designated coordinator (★) when set, else any running agent.
  'team:parseSpecAI': (spec: string) =>
    client.parseTeamSpecAI(String(spec), { agent: getCoordinator(client.team ?? 'default') ?? undefined }),
  // AI-assisted FULL team design → { team, agents[] } with per-agent runtime/model/skills/lead.
  // The renderer passes its available runtimes/models/skills so the model picks valid choices.
  'team:designAI': (
    spec: string,
    ctx?: { runtimes?: string[]; models?: Record<string, string[]>; skills?: string[]; agent?: string; fleetRoster?: string },
  ) =>
    client.designTeamAI(String(spec), { ...(ctx ?? {}), agent: ctx?.agent ?? getCoordinator(client.team ?? 'default') ?? undefined }),

  // team relay (cross-team delegation allow-list) + per-agent override
  teamConfig: (name: string) => client.teamConfig(String(name)),
  // Whole-fleet relay topology: every team's outbound delegate policy (delegates_to), for the
  // Route tab's routing overview. null = permissive (any team) · ['*'] = all · [] = blocked.
  'relay:matrix': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [cfg.team ?? 'default'];
    return Promise.all(
      names.map(async (name) => {
        try {
          const c = await client.teamConfig(name);
          return { team: name, delegates: (c?.delegates_to ?? null) as string[] | null };
        } catch {
          return { team: name, delegates: null as string[] | null };
        }
      }),
    );
  },
  setTeamDelegates: (name: string, delegates: string[] | null) => client.setTeamDelegates(String(name), delegates ?? null),
  setAgentDelegates: (id: string, delegates: string[] | null) => client.setAgentDelegates(String(id), delegates ?? null),

  // dashboard: switch runtime (rebuild required to apply)
  setAgentRuntime: (id: string, runtime: string, team?: string) =>
    setAgentRuntimeFromSettings(String(id), String(runtime), team ? String(team) : undefined),
  setAgentEffort: (id: string, effort: string, team?: string) =>
    (team ? client.withTeam(String(team)) : client).setAgentEffort(String(id), String(effort ?? '')),
  setAgentSpeed: (id: string, speed: string, team?: string) =>
    (team ? client.withTeam(String(team)) : client).setAgentSpeed(String(id), String(speed ?? '')),
  // reassign a local agent to another team (rebuilds it there)
  'agent:move': (id: string, team: string, sourceTeam?: string, createTarget?: boolean) =>
    (sourceTeam ? client.withTeam(String(sourceTeam)) : client).moveAgent(String(id), String(team), { createTarget: Boolean(createTarget) }),

  // per-agent persistent instructions (system-prompt addendum, e.g. coordinator role).
  // Optional `team` scopes the read to a specific team (so the HR structure editor can load a
  // cross-team agent's goals without switching the active team).
  'agent:getInstructions': (idOrName: string, team?: string) =>
    (team ? client.withTeam(String(team)) : client).agentInstructions(String(idOrName)),
  // Optional `team` scopes the call to a specific team (e.g. the Team Builder
  // wiring a lead in a freshly-created team that isn't the active one yet).
  'agent:setInstructions': (idOrName: string, instructions: string, team?: string) =>
    (team ? client.withTeam(String(team)) : client).setAgentInstructions(String(idOrName), String(instructions ?? '')),

  // teams: create + start a new agent
  spawnAgent: (spec: Parameters<ManagerClient['spawnAgent']>[0]) => client.spawnAgent(spec),
  'identity:controllerChallenge': async (agent: string, wallet: string, team?: string) => startControllerChallenge(String(agent), String(wallet), team ? String(team) : undefined),
  'identity:controllerVerify': async (agent: string, wallet: string, signature: string, team?: string) => verifyControllerChallengeForAgent(String(agent), String(wallet), String(signature), team ? String(team) : undefined),
  'identity:controllerStatus': async (agent: string, wallet: string, team?: string) => controllerProofStatusForAgent(String(agent), String(wallet), team ? String(team) : undefined),
  'identity:bindWallet': async (agent: string, wallet: string, team?: string) => {
    const name = String(agent).trim();
    const teamName = team ? String(team) : undefined;
    const address = ethAddress(wallet);
    if (!name) throw new Error('Choose an agent before binding a controller wallet.');
    if (!address) throw new Error('Controller wallet must be a valid 20-byte 0x address.');
    await requireControllerProofIfWalletExists(name, teamName);
    return (teamName ? client.withTeam(teamName) : client).bindAgentWallet(name, address);
  },
  'identity:register': async (agent: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    await requireControllerProof(name, teamName);
    return (teamName ? client.withTeam(teamName) : client).remote(`/register ${name}`);
  },
  'wallet:provision': async (agent: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    await requireControllerProofIfWalletExists(name, teamName);
    return (teamName ? client.withTeam(teamName) : client).remote(`/agent ${name} wallet provision`);
  },
  'onboard:run': (plan: OnboardPlan) => runOnboarding(client, plan, { prepareRuntime: prepareOnboardRuntime }),

  // dashboard: per-runtime model catalog (synced providers + codex cache + curated)
  'runtime:models': async () => runtimeCatalogWithLiveCliModels(),
  // Probe every enabled provider that backs a runtime, refresh its model list,
  // then return the rebuilt per-runtime catalog. This is "probe each runtime".
  'runtime:probe': async () => probeAllRuntimes(),
  'runtime:verifyAssignments': async (assignments: RuntimeAssignment[]) => verifyRuntimeAssignments(assignments),
  // Per-runtime model freshness (live list + source + when last refreshed) for the
  // "models stay up to date" panel.
  'runtime:freshness': async () => runtimeFreshness(),
  // Runtime credential lane cooldowns (newer managers); empty on stock/older managers.
  'runtime:cooldowns': async () => client.runtimeCooldowns(),

  // modules: skills + plugins catalog, install, MCP attach + rebuild
  librarySkills: () => client.librarySkills(),
  libraryPlugins: () => client.libraryPlugins(),
  libraryPluginInspections: () => inspectLibraryPlugins(),
  'skills:localCandidates': async () => {
    const skills = await client.librarySkills().catch(() => [] as LibrarySkillEntry[]);
    return scanLocalSkillCandidates(skills.map((skill) => skill.name));
  },
  'skills:importLocalCandidate': (id: string) => importLocalSkillCandidate(String(id)),
  // Skill auto-categorization (app-side tag overlay; never writes the SKILL.md).
  // Returns the cached name→tags overlay merged into the Capabilities catalog.
  'skills:autoTags': () => Promise.resolve(loadSettings().skillTags ?? {}),
  // Categorize library skills lacking frontmatter tags via one batch /ask (heuristic
  // fallback), persist to the overlay, and return the full overlay. force=true
  // re-categorizes every untagged skill (ignores the cache).
  'skills:categorize': async (force?: boolean) => {
    const skills = await client.librarySkills();
    const cached = loadSettings().skillTags ?? {};
    const targets = skills.filter((s) => !(s.tags && s.tags.length) && (force || !cached[s.name]));
    if (!targets.length) return cached;
    const derived = await client.categorizeSkillsAI(targets.map((s) => ({ name: s.name, description: s.description })));
    setSkillTags(derived);
    return loadSettings().skillTags ?? {};
  },
  'skills:brainSummary': async (): Promise<BrainSkillIndex | null> => brain.skillIndex(),
  'brain:coreHealth': async (): Promise<BrainCoreHealthReport | null> => brain.coreHealth(),
  'brain:agentsReport': async (): Promise<BrainAgentsReport | null> => brain.agentsReport(),
  'brain:controllerReport': async (): Promise<BrainControllerReport | null> => brain.controllerReport(),
  'brain:fleetReport': async (): Promise<BrainFleetReport | null> => brain.fleetReport(),
  'brain:graphReport': async (): Promise<BrainGraphReport | null> => brain.graphReport(),
  'skills:syncBrain': async (opts?: { catalogStamp?: string }) => {
    const skills = await client.librarySkills();
    const autoTags = loadSettings().skillTags ?? {};
    const stamp = skillCatalogStamp(skills, autoTags);
    if (opts?.catalogStamp && opts.catalogStamp !== stamp) {
      throw new Error('Local skill catalog changed before Brain sync; refresh and try again.');
    }
    const nodes = brainSkillNodes(skills, autoTags);
    const synced = await brain.syncSkillNodes(nodes);
    if (!synced?.ok) throw new Error('Brain skill graph sync failed or Brain is offline.');
    const memory = await brain.memory('control-center', {
      key: 'skills:catalog',
      content: skillCatalogMemory(skills, nodes),
      tags: ['dashboard-state', 'skills', 'skill-catalog'],
      shared: true,
      project: 'capabilities',
    });
    const index = await brain.skillIndex();
    return {
      ok: true,
      total: skills.length,
      count: Number(synced.count ?? nodes.length),
      memory,
      summary: index?.summary ?? null,
      index,
      generatedAt: index?.meta?.generatedAt ?? new Date().toISOString(),
    };
  },
  installSkill: (skill: string, agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).installSkill(String(skill), String(agent)),
  projectPluginSkill: (name: string) => projectPluginSkill(name),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
  deleteSkill: (name: string) => client.deleteSkill(String(name)),
  uninstallSkill: (skill: string, agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).uninstallSkill(String(skill), String(agent)),
  usage: () => client.usage(),
  setAgentMcp: (agentId: string, servers: McpServerSpec[], team?: string) => (team ? client.withTeam(String(team)) : client).setAgentMcp(String(agentId), filterParkedMcpServers(servers ?? [])),
  rebuildAgent: (agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).remote(`/agent ${agent} rebuild`),

  // Computer Use: attach/detach the bundled computer-use MCP server to an agent
  // (a "bless" — lets that agent drive the Mac through the broker). Merges with
  // the agent's existing MCP servers (never clobbers them) and dedupes by name.
  'cu:attach': async (agentId: string, agentName: string, team?: string) => {
    const teamName = team ? String(team) : undefined;
    const scopedClient = teamName ? client.withTeam(teamName) : client;
    // NEVER swallow the fetch into [] — a transient failure would make `cur` empty
    // and the wholesale-replace POST would WIPE the agent's other MCP servers. Let
    // it throw, and fail closed if the agent isn't found, so we only ever merge
    // onto a known-good current list.
    const agents = await scopedClient.agents();
    const a = requireCurrentComputerUseAgent(agents, agentId, agentName);
    const cur = (((a.metadata as any)?.mcpServers) ?? []) as McpServerSpec[];
    const authorityTeam = teamName ?? client.team ?? 'default';
    const authority = scopedAgentKey(a.name, authorityTeam);
    // Per-agent token + broker URL injected here, so the agent authenticates AS itself
    // (the broker derives identity from the token, not a self-reported name). The
    // server name MUST NOT be "computer-use" — Claude Code reserves that and rejects
    // the WHOLE MCP config, breaking every dispatch to the agent.
    const spec: McpServerSpec = { name: CU_MCP_NAME, command: 'node', args: [brokerServerPath()], env: { ID_CU_AGENT: authority, ID_CU_AGENT_NAME: String(a.name), ID_CU_TEAM: authorityTeam, ID_CU_TOKEN: mintAgentToken(authority), ID_CU_URL: brokerUrl() } };
    const next = filterParkedMcpServers([...cur.filter((s) => !CU_MCP_ALIASES.includes(s.name)), spec]); // also strips the old broken name
    return scopedClient.setAgentMcp(a.id, next);
  },
  'cu:detach': async (agentId: string, agentName?: string, team?: string) => {
    const teamName = team ? String(team) : undefined;
    const scopedClient = teamName ? client.withTeam(teamName) : client;
    const agents = await scopedClient.agents();
    const a = requireCurrentComputerUseAgent(agents, agentId, agentName);
    revokeAgentToken(scopedAgentKey(a.name, teamName ?? client.team ?? 'default'));
    const cur = (((a.metadata as any)?.mcpServers) ?? []) as McpServerSpec[];
    return scopedClient.setAgentMcp(a.id, filterParkedMcpServers(cur.filter((s) => !CU_MCP_ALIASES.includes(s.name))));
  },
  // Agents that have computer-use attached (for the view's "blessed" list) — detects
  // the old reserved name too, so a previously-broken agent shows up to be removed/re-blessed.
  'cu:attached': async (team?: string) => {
    const teamName = team ? String(team) : undefined;
    const scopedClient = teamName ? client.withTeam(teamName) : client;
    const agents = await scopedClient.agents();
    return agents
      .filter((a) => (((a.metadata as any)?.mcpServers ?? []) as { name: string }[]).some((s) => CU_MCP_ALIASES.includes(s.name)))
      .map((a) => ({ id: a.id, name: a.name, team: teamName ?? client.team ?? 'default', authority: scopedAgentKey(a.name, teamName ?? client.team ?? 'default') }));
  },

  // MCP server registry (local settings catalog)
  'mcp:list': async () => loadSettings().mcpServers ?? [],
  'mcp:add': async (profile: McpServerProfile) => {
    upsertMcpServer(profile);
    return loadSettings().mcpServers ?? [];
  },
  'mcp:remove': async (name: string) => {
    removeMcpServer(String(name));
    return loadSettings().mcpServers ?? [];
  },
  'mcp:test': (spec: McpServerSpec) => testMcpServer(spec),

  // Projects are Manager-owned. The settings copy is a cache used by existing
  // local git helpers and can be rebuilt from this control-plane registry.
  'projects:list': async () => managerProjects(),
  'projects:save': async (p: ProjectEntry) => {
    const project = { ...p, updatedAt: Date.now() };
    return serializeControlStateWrite(() => persistProject(project));
  },
  'projects:remove': async (id: string) => {
    const key = String(id);
    await serializeControlStateWrite(() => controlStateClient().controlStateDelete('project', key));
    const next = (loadSettings().projects ?? []).filter((project) => project.id !== key);
    return mirrorProjects(next);
  },
  // Detect the projects root (returns null if none found).
  'projects:detectRoot': async (root?: string) => detectProjectsRoot(typeof root === 'string' ? root : loadSettings().projectsRoot),
  // Preview the additive workspace sync before the renderer asks for confirmation.
  'projects:previewSyncRoot': async (rootArg?: string) => previewProjectsSync(typeof rootArg === 'string' ? rootArg : undefined),
  // Sync the workspace projects folder into the tracker. Additive + idempotent:
  // dedupes by folder path, adopts a path-less manual entry of the same name,
  // never deletes or overwrites your edits. Persists the resolved root.
  'projects:syncRoot': async (rootArg?: string) => {
    await managerProjects();
    const root = detectProjectsRoot(typeof rootArg === 'string' && rootArg.trim() ? rootArg.trim() : loadSettings().projectsRoot);
    if (!root) return { ok: false, root: null, added: 0, adopted: 0, total: (loadSettings().projects ?? []).length, error: 'no projects folder found' };
    const scan = await scanProjectsRoot(root);
    // Load once, merge in memory, write once (atomic). A single read-modify-write
    // shrinks the cross-process window vs the launchd syncer (no N-write burst).
    const cfg = loadSettings();
    const projects = cfg.projects ?? [];
    if (scan.error) {
      cfg.projects = projects;
      cfg.projectsRoot = root;
      saveSettings(cfg);
      return { ok: false, root, added: 0, adopted: 0, total: projects.length, error: scan.error };
    }
    const byPath = new Set(projects.map((p) => normPath(p.path)).filter(Boolean) as string[]);
    const pathlessByName = new Map<string, ProjectEntry>();
    for (const p of projects) { const k = normName(p.name); if (!p.path && k) pathlessByName.set(k, p); }
    let added = 0;
    let adopted = 0;
    const now = Date.now();
    for (const d of scan.found) {
      const np = normPath(d.path);
      if (np && byPath.has(np)) continue; // already tracked
      const link = d.remoteUrl ? ghLink(d.remoteUrl) : '';
      const key = normName(d.name);
      const adopt = key ? pathlessByName.get(key) : undefined; // never adopt on an empty key
      if (adopt) {
        adopt.path = d.path;
        if (!adopt.description && d.description) adopt.description = d.description;
        if (link && !(adopt.links ?? []).includes(link)) adopt.links = [...(adopt.links ?? []), link];
        adopt.updatedAt = now;
        pathlessByName.delete(key);
        if (np) byPath.add(np);
        adopted++;
        continue;
      }
      projects.push({
        id: `ws_${stableHash(d.path)}`,
        name: d.name,
        status: 'active',
        description: d.description,
        team: 'default', // default new projects to the default team (it delegates git work to git-manager)
        tags: ['workspace'],
        links: link ? [link] : [],
        path: d.path,
        createdAt: now,
        updatedAt: now,
      });
      if (np) byPath.add(np);
      added++;
    }
    cfg.projects = projects;
    cfg.projectsRoot = root;
    saveSettings(cfg);
    await serializeControlStateWrite(() => persistAllProjects(projects));
    return { ok: true, root, added, adopted, total: projects.length };
  },

  // identity & keys (chain-backed Safe + scoped Zodiac Roles proposals)
  'keys:caps': async () => keys.capabilities(),
  'keys:list': (agents: string[]) => keys.listAccounts(agents ?? []),
  'keys:legacyAuthority': async (_targets: KeyAuthorityTarget[]) => [],
  'keys:ensure': async (agent: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    requireLiveKeyProvider('Safe account preparation');
    await requireControllerProof(name, teamName);
    return keys.ensureAccount(scopedAgentKey(name, teamName));
  },
  'keys:deploy': async (agent: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    requireLiveKeyProvider('Safe deployment');
    await requireControllerProof(name, teamName);
    return keys.deployAccount(scopedAgentKey(name, teamName));
  },
  'keys:provision': async (agent: string, scopeInput: number | SessionScope, ttlMs: number, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    const scope = resolveRequestedScope(scopeInput);
    const ttl = Number(ttlMs);
    requireLiveKeyProvider('Safe and initial authority provisioning');
    await requireControllerProof(name, teamName);
    if (ttl !== 0) throw new Error('Choose Until revoked; finite expiry is not advertised without on-chain enforcement.');
    requireBoundedLiveScope(scope);
    return keys.provisionAccount(scopedAgentKey(name, teamName), scope, ttl);
  },
  'keys:issue': async (agent: string, scopeInput: number | SessionScope, ttlMs: number, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    const scope = resolveRequestedScope(scopeInput);
    const ttl = Number(ttlMs);
    requireLiveKeyProvider('Session authority issuance');
    await requireControllerProof(name, teamName);
    if (ttl !== 0) throw new Error('Choose Until revoked; finite expiry is not advertised without on-chain enforcement.');
    requireBoundedLiveScope(scope);
    return keys.issueSession(scopedAgentKey(name, teamName), scope, ttl);
  },
  'keys:revoke': async (agent: string, sessionId: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    requireLiveKeyProvider('Session authority revocation');
    await requireControllerProof(name, teamName);
    return keys.revokeSession(scopedAgentKey(name, teamName), String(sessionId));
  },
  'keys:rotate': async (agent: string, sessionId: string, scopeInput: number | SessionScope, ttlMs: number, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    const scope = resolveRequestedScope(scopeInput);
    const ttl = Number(ttlMs);
    requireLiveKeyProvider('Session authority rotation');
    await requireControllerProof(name, teamName);
    if (ttl !== 0) throw new Error('Choose Until revoked; finite expiry is not advertised without on-chain enforcement.');
    requireBoundedLiveScope(scope);
    return keys.rotateSession(scopedAgentKey(name, teamName), String(sessionId), scope, ttl);
  },
  'keys:assetGuard': async (agent: string, team?: string) => {
    return keys.inspectAssets(scopedAgentKey(String(agent), team ? String(team) : undefined));
  },
  // Account-level authority changes return guarded root-Safe proposals. Live
  // state is recorded only after the submitted receipts verify successfully.
  'keys:revokeAccount': async (agent: string, team?: string, assetsAcknowledged = false) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    requireLiveKeyProvider('Agent authority revocation');
    const key = scopedAgentKey(name, teamName);
    const assets = await keys.inspectAssets(key);
    if (assets.status === 'unknown' && keys.capabilities().live) {
      throw new Error(`Authority revocation blocked: assets could not be inspected. ${assets.message}`);
    }
    if (assets.status === 'assets-present' && !assetsAcknowledged) {
      throw new Error('Authority revocation requires explicit acknowledgement because the Safe holds assets. Assets remain in the Safe under root recovery control.');
    }
    return keys.revokeAccount(key);
  },
  'keys:restoreAccount': async (agent: string, team?: string) => {
    const name = String(agent);
    const teamName = team ? String(team) : undefined;
    requireLiveKeyProvider('Agent authority restoration');
    return keys.restoreAccount(scopedAgentKey(name, teamName));
  },
  'keys:recordSubmission': async (operationId: string, submissionId: string, chainId: number, rootSafe: string) => {
    const provider = activeKeyProvider as (KeyProvider & {
      recordSubmission?: (id: string, submission: string, chain: number, safe: string) => PreparedKeyOperation;
    }) | null;
    if (!provider?.recordSubmission) throw new Error('The active key provider cannot record root-Safe submissions.');
    return provider.recordSubmission(String(operationId), String(submissionId), Number(chainId), String(rootSafe));
  },
  'keys:finalizeOperation': async (operationId: string, txHashes: string[]) => {
    const provider = activeKeyProvider as (KeyProvider & {
      finalizeOperation?: (id: string, hashes: string[]) => Promise<unknown>;
    }) | null;
    if (!provider?.finalizeOperation) throw new Error('The active key provider cannot verify proposal receipts.');
    return provider.finalizeOperation(String(operationId), Array.isArray(txHashes) ? txHashes.map(String) : []);
  },
  'keys:presets': async () => ({ scopes: SCOPE_PRESETS, ttls: TTL_PRESETS }),

  // inference providers (settings store + probe + connect/sync)
  'providers:list': async () => listProvidersEnriched(),
  'providers:add': async (profile: ProviderProfile) => {
    upsertProvider(profile);
    return listProvidersEnriched();
  },
  'providers:remove': async (name: string) => {
    removeProvider(String(name));
    return listProvidersEnriched();
  },
  'providers:setDefault': async (name: string) => {
    setDefaultProvider(String(name));
    return listProvidersEnriched();
  },
  'providers:setModelSelection': async (name: string, selection: ProviderModelSelection, expectedStamp?: string) => {
    const providerName = String(name);
    const p = loadSettings().providers.find((x) => x.name === providerName);
    if (!p) throw new Error('provider not found');
    const expected = typeof expectedStamp === 'string' ? expectedStamp : '';
    if (expected && providerBridgeStamp(p) !== expected) throw new Error('provider changed before model selection save');
    setProviderModelSelection(providerName, normalizeProviderModelSelection(selection));
    return listProvidersEnriched();
  },
  'providers:toggle': async (name: string) => {
    toggleProviderEnabled(String(name));
    return listProvidersEnriched();
  },
  'providers:probe': async (name: string) => {
    const p = loadSettings().providers.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    return new ProviderClient(p, resolveProviderKey(p)).probe();
  },
  // Connect & sync: resolve the key (config → env), validate live, cache the
  // discovered model list onto the provider so models stay discoverable.
  'providers:connect': async (name: string, expectedStamp?: string) => {
    const p = loadSettings().providers.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    const expected = typeof expectedStamp === 'string' ? expectedStamp : '';
    if (expected && providerBridgeStamp(p) !== expected) throw new Error('provider changed before sync started');
    const key = resolveProviderKey(p);
    const outcome = await new ProviderClient(p, key).probe();
    const latest = loadSettings().providers.find((x) => x.name === name);
    if (!latest) throw new Error('provider removed before sync completed');
    if (expected && providerBridgeStamp(latest) !== expected) throw new Error('provider changed before sync completed');
    if (outcome.status === 'live' && latest.enabled === false && isLoopbackProvider(latest) && !providerNeedsKey(latest)) {
      upsertProvider({ ...latest, enabled: true });
    }
    recordProviderSync(String(name), {
      at: Date.now(),
      status: outcome.status,
      modelCount: outcome.models.length,
      models: outcome.models.slice(0, 200).map((m) => m.id),
      keySource: keySourceOf(p),
    });
    return { providers: listProvidersEnriched(), outcome };
  },
  // Scan localhost for running LLM servers and flag which are already configured
  // (matched by normalized baseUrl, so adding the same server twice is avoided).
  'providers:discover': async (extraCandidates?: unknown) => {
    const found = await discoverLocalServers({ candidates: mergeLocalDiscoveryCandidates(extraCandidates) });
    const have = new Set(loadSettings().providers.map((p) => normUrl(p.baseUrl)));
    return found.map((s: DiscoveredServer) => ({ ...s, alreadyAdded: have.has(normUrl(s.baseUrl)) }));
  },
};

/** Loose URL normalization for de-duping discovered servers against existing providers. */
function normUrl(u: string): string {
  return u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
}

async function callRaw(method: string, args: unknown[] = []): Promise<unknown> {
  if (method === 'setTeam') {
    readCallCache.clear();
    client = client.withTeam(String(args[0]) || undefined);
    return info();
  }
  if (method === 'setManager') {
    readCallCache.clear();
    cfg = { ...cfg, managerUrl: String(args[0]) };
    client = new ManagerClient(cfg);
    return info();
  }
  if (method === 'info') return info();
  if (method === 'coordinator:get') {
    await managerOrgControl();
    return getCoordinator(String(args[0] ?? client.team ?? 'default')) ?? null;
  }
  if (method === 'coordinator:set') {
    await managerOrgControl();
    const team = String(args[0]);
    const agent = String(args[1]);
    assertDefaultCoordinatorWrite(team, agent);
    setCoordinator(team, agent);
    await persistOrgControl();
    return { ok: true };
  }
  if (method === 'coordinator:setPrimary') {
    await managerOrgControl();
    const team = String(args[0]);
    const agent = String(args[1]);
    assertDefaultPrimaryWrite(team, agent);
    setPrimaryCoordinator(team, agent);
    await persistOrgControl();
    return info();
  }
  if (method === 'coordinator:hierarchy') {
    await managerOrgControl();
    return buildOrgHierarchy(client);
  }
  // ---- Org sync (reactive goals & instructions) ----
  if (method === 'org:hierarchy') {
    await managerOrgControl();
    return buildOrgHierarchy(client);
  }
  if (method === 'org:preview') {
    await managerOrgControl();
    return previewOrgSync(client, (args[0] as { autoRebuild?: boolean }) ?? {});
  }
  if (method === 'org:sync') {
    await managerOrgControl();
    return syncOrg(client, (args[0] as { autoRebuild?: boolean }) ?? {});
  }
  if (method === 'org:getSecondaryLeads') {
    await managerOrgControl();
    return getSecondaryLeads();
  }
  if (method === 'org:setSecondaryLeads') {
    await managerOrgControl();
    setSecondaryLeads(normalizeSecondaryLeadWrites((args[0] as SecondaryLead[]) ?? []));
    await persistOrgControl();
    return { ok: true };
  }
  if (method === 'org:getConfig') {
    await managerOrgControl();
    return loadSettings().orgSync ?? { enabled: true, autoRebuild: true };
  }
  if (method === 'org:setConfig') {
    await managerOrgControl();
    const s = loadSettings();
    s.orgSync = { ...(s.orgSync ?? {}), ...((args[0] as { enabled?: boolean; autoRebuild?: boolean }) ?? {}) };
    saveSettings(s);
    await persistOrgControl();
    return s.orgSync;
  }
  const fn = METHODS[method];
  if (!fn) throw new Error(`unknown method: ${method}`);
  return fn(...args);
}

export async function call(method: string, args: unknown[] = []): Promise<unknown> {
  if (COALESCED_READ_METHODS.has(method)) {
    return readCallCache.run(method, args, () => callRaw(method, args));
  }
  const result = await callRaw(method, args);
  if (!READ_ONLY_SYNC_METHODS.has(method) && syncDomainsForMethod(method).length > 0) {
    readCallCache.clear();
  }
  return result;
}

export function info() {
  const team = client.team ?? 'default';
  return { managerUrl: client.managerUrl, team, coordinator: getCoordinator(team) ?? null };
}

/** Start the reactive org-sync loop, always reading the live (possibly-reassigned) client. */
export function startOrgSync(): () => void {
  return startOrgSyncLoop(() => client);
}

/** Start the disabled-by-default goal driver loop against the live manager client. */
export function startGoalDriver(): () => void {
  return startGoalDriverLoop(() => client, goalDriverConfig);
}

/** Promote task-shaped draft replies into manager-routed tasks in the background. */
export function startDraftDispatcher(): () => void {
  return startDraftDispatcherLoop(() => client);
}

/**
 * Background model-refresh — the "checker that stays up to date". Re-probes every runtime's
 * backing provider on boot (after a short settle) and every 6h, so the per-runtime model
 * lists keep current as providers add/drop models. codex models are read live from its CLI
 * cache on every catalog read, so they need no probe; this keeps the API-backed runtimes fresh.
 */
export function startModelRefreshLoop(): () => void {
  let stopped = false;
  const tick = () => { if (!stopped) void probeAllRuntimes().catch(() => {}); };
  const t0 = setTimeout(tick, 30_000);
  const iv = setInterval(tick, 6 * 60 * 60 * 1000);
  return () => { stopped = true; clearTimeout(t0); clearInterval(iv); };
}
