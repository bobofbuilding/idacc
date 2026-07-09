/**
 * Tauri transport adapter. The same React UI as the Electron build, but data
 * access runs IN THE WEBVIEW: ManagerClient over the Tauri HTTP plugin (Rust
 * does the request → no CORS), and settings/keys persisted in localStorage
 * (the webview has no Node fs). Implements the exact method contract the views
 * call via store.ts `call()`.
 */

import { inspectLibraryPluginMetadata, ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { discoverLocalServers, mergeLocalDiscoveryCandidates, type DiscoveredServer } from '../../../idctl/src/settings/localDiscovery.ts';
import { SCOPE_PRESETS, TTL_PRESETS } from '../../../idctl/src/keys/types.ts';
import type { AgentAccount, KeyAuthorityTarget, LegacyKeyAuthority, SessionKey } from '../../../idctl/src/keys/types.ts';
import { defaultHeadroomPilotSettings, type HeadroomPilotSettings, type ProviderModelSelection, type ProviderProfile, type McpServerProfile, type ProjectEntry } from '../../../idctl/src/settings/schema.ts';
import { providerNeedsKey } from '../../../idctl/src/settings/providerCatalog.ts';
import { buildProviderModelLanes, buildRuntimeCatalog, isLocalProvider, providerKindToRuntimes, RUNTIMES, settingsAvailableRuntimeSet } from '../../../idctl/src/settings/runtimeCatalog.ts';
import type { LibraryPluginInspection, LibrarySkillEntry, McpServerSpec, CreateSkillInput, ProjectPluginSkillResult } from '../../../idctl/src/api/client.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { auditPreview, optimizeAskCommandCore, type ContextBudgetDecision } from '../shared/contextBudget.ts';
import { syncDomainsForMethod } from '../shared/syncDomains.ts';
import { COALESCED_READ_METHODS, ReadCallCache } from '../shared/readCallCache.ts';
import { mapTeamAgentGroups } from '../shared/teamAgentGroups.ts';

const MGR_DEFAULT = 'http://127.0.0.1:4100';
const WIKI_URL = 'docs/CONTROL_CENTER_WIKI.json';
let managerUrl = localStorage.getItem('idctl.managerUrl') || MGR_DEFAULT;
let team = localStorage.getItem('idctl.team') || 'default';
let client = makeClient();
const PRIMARY_TEAM = 'default';
const DEFAULT_PRIMARY_AGENT = 'lead';
const RECENT_DONE_TASK_LIMIT = 25;
let doneTaskLimitUnsupportedAt = 0;

function assertDefaultPrimaryWrite(targetTeam: string, agent: string): void {
  if (targetTeam !== PRIMARY_TEAM || agent !== DEFAULT_PRIMARY_AGENT) {
    throw new Error(`primary lead is locked to ${PRIMARY_TEAM}/${DEFAULT_PRIMARY_AGENT}`);
  }
}

function assertDefaultCoordinatorWrite(targetTeam: string, agent: string): void {
  if (targetTeam === PRIMARY_TEAM && agent !== DEFAULT_PRIMARY_AGENT) {
    throw new Error(`default coordinator is locked to ${PRIMARY_TEAM}/${DEFAULT_PRIMARY_AGENT}`);
  }
}

interface WikiPayload {
  path: string;
  mtimeMs: number;
  loadedAt: number;
  doc: Record<string, unknown>;
}

function makeClient(): ManagerClient {
  // Local control center on loopback → legitimate admin client.
  return new ManagerClient({ managerUrl, team, refreshMs: 3000, waitSeconds: 25, admin: true });
}

async function managerTaskRows(targetTeam: string, status: 'todo' | 'doing' | 'done', limit?: number): Promise<Task[]> {
  if (status === 'done' && limit && doneTaskLimitUnsupportedAt && Date.now() - doneTaskLimitUnsupportedAt < 60_000) {
    return [];
  }
  const url = new URL('/tasks', managerUrl);
  url.searchParams.set('status', status);
  if (limit) url.searchParams.set('limit', String(limit));
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', 'X-Id-Team': targetTeam, 'X-Id-Admin': '1' } });
  if (!res.ok) throw new Error(`GET /tasks?status=${status} -> ${res.status}`);
  const data = await res.json() as { tasks?: Task[] };
  const rows = data.tasks ?? [];
  if (status === 'done' && limit) {
    if (rows.length > limit) {
      doneTaskLimitUnsupportedAt = Date.now();
      return rows.slice(0, limit).map((t) => ({ ...t, teamName: t.teamName ?? targetTeam }));
    }
    doneTaskLimitUnsupportedAt = 0;
  }
  return rows.map((t) => ({ ...t, teamName: t.teamName ?? targetTeam }));
}

async function boardTasksForTeam(targetTeam: string): Promise<Task[]> {
  const scoped = client.withTeam(targetTeam);
  const readStatus = async (status: 'todo' | 'doing' | 'done', limit?: number): Promise<Task[]> => {
    try {
      return await managerTaskRows(targetTeam, status, limit);
    } catch {
      return (await scoped.tasksByStatus(status, limit ? { limit } : undefined).catch(() => []))
        .map((t) => ({ ...t, teamName: t.teamName ?? targetTeam }));
    }
  };
  const [todo, doing, done] = await Promise.all([
    readStatus('todo'),
    readStatus('doing'),
    readStatus('done', RECENT_DONE_TASK_LIMIT),
  ]);
  const seen = new Set<string>();
  return [...todo, ...doing, ...done].filter((t) => {
    const id = String(t.shortId ?? t.uuid ?? t.name ?? `${t.teamName ?? ''}:${t.title}:${t.createdAt ?? ''}`);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function scopedAgentKey(agent: string, selectedTeam?: string): string {
  return selectedTeam ? `${selectedTeam}:${agent}` : agent;
}

const COMPUTER_USE_UNAVAILABLE = 'Computer Use requires the Electron desktop broker; this shell cannot capture or drive the screen.';
function computerUseUnavailableStatus() {
  return {
    available: false,
    unavailableReason: COMPUTER_USE_UNAVAILABLE,
    armed: false,
    watching: false,
    port: 0,
    url: '',
    lastAgent: '',
    actions: 0,
    serverStaged: false,
    captureFailing: false,
    blessed: [] as string[],
    driverOk: false,
    accessibility: false,
    supervised: true,
    paused: false,
    pending: [] as unknown[],
    panicHotkey: false,
  };
}
function computerUseUnavailablePermissions() {
  return {
    screenRecording: 'unknown',
    accessibility: false,
    inputMonitoring: 'unknown',
    automation: { status: 'unknown', targets: [] as string[] },
    tcc: { readable: false, error: COMPUTER_USE_UNAVAILABLE },
    platform: 'webview',
  };
}

// ---- localStorage helpers --------------------------------------------------
function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, val: unknown): void {
  localStorage.setItem(key, JSON.stringify(val));
}

async function fetchWiki(): Promise<WikiPayload> {
  const res = await fetch(WIKI_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`wiki load failed: ${res.status} ${res.statusText}`);
  const doc = await res.json() as Record<string, unknown>;
  const now = Date.now();
  return { path: WIKI_URL, mtimeMs: now, loadedAt: now, doc };
}

/** Enrich provider rows with key source (no env in the webview) + needsKey flag. */
function enrichProviders(list: ProviderProfile[]) {
  return list.map((p) => ({ ...p, keySource: (p.apiKey ? 'config' : 'none') as 'config' | 'env' | 'none', needsKey: providerNeedsKey(p) }));
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

function providerRouteReadyForAssignment(p: ProviderProfile): boolean {
  const modelCount = p.lastSync?.models?.length ?? p.lastSync?.modelCount ?? 0;
  return p.enabled !== false && (!providerNeedsKey(p) || Boolean(p.apiKey)) && modelCount > 0 && (
    p.lastSync?.status === 'live' ||
    p.lastSync?.status === 'preset' ||
    modelCount > 0
  );
}

async function setAgentRuntimeFromSettings(agentId: string, runtime: string, selectedTeam?: string) {
  const providerName = providerLaneName(runtime);
  const scoped = clientFor(selectedTeam);
  if (!providerName) return scoped.setAgentRuntime(String(agentId), String(runtime));
  const p = lsGet<ProviderProfile[]>('idctl.providers', []).find((x) => x.name === providerName);
  if (!p) throw new Error(`provider lane "${providerName}" is no longer configured in Settings`);
  if (!providerRouteReadyForAssignment(p)) throw new Error(`provider lane "${providerName}" is not ready; Connect & sync it in Settings first`);
  if (providerNeedsKey(p) && !p.apiKey) throw new Error(`provider lane "${providerName}" is missing an API key`);
  return scoped.setAgentProviderRuntime(String(agentId), String(runtime), {
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    ...(p.apiKey ? { apiKey: p.apiKey } : {}),
  });
}

function runtimeFreshnessLocal() {
  const providers = lsGet<ProviderProfile[]>('idctl.providers', []);
  const enrichedProviders = enrichProviders(providers);
  const cat = buildRuntimeCatalog(providers);
  const available = settingsAvailableRuntimeSet(enrichedProviders, []);
  const providerFor = (rt: string): ProviderProfile | undefined =>
    providers
      .filter(
        (p) =>
          p.enabled !== false &&
          (p.lastSync?.models?.length ?? 0) > 0 &&
          providerKindToRuntimes(p.kind).includes(rt) &&
          (rt !== 'ollama' || isLocalProvider(p)),
      )
      .sort((a, b) => (b.lastSync?.at ?? 0) - (a.lastSync?.at ?? 0))[0];
  const harnessRows = RUNTIMES.map((rt) => {
    const models = cat[rt] ?? [];
    const selectable = available.has(rt);
    const unavailableDetail = selectable ? undefined : 'Not currently available from Settings in this shell; install/sign in or sync a matching backend before assigning this harness.';
    const p = providerFor(rt);
    if (p) {
      return { runtime: rt, kind: 'harness', models, count: models.length, source: 'provider', provider: p.name, lastCheckedMs: p.lastSync?.at ?? null, selectable, detail: unavailableDetail };
    }
    return { runtime: rt, kind: 'harness', models, count: models.length, source: models.length ? 'curated' : 'none', lastCheckedMs: null, selectable, detail: unavailableDetail };
  });
  const providerRows = buildProviderModelLanes(enrichedProviders).map((lane) => ({
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
  return [...harnessRows, ...providerRows];
}

function headroomPilotState(): HeadroomPilotSettings {
  const d = defaultHeadroomPilotSettings();
  const raw = lsGet<Partial<HeadroomPilotSettings>>('idctl.headroomPilot', {});
  const enabled = raw.enabled === true;
  const mode = raw.mode === 'mcp' || raw.mode === 'proxy' || raw.mode === 'mcp-and-proxy'
    ? raw.mode
    : enabled
      ? 'mcp'
      : 'off';
  return {
    ...d,
    ...raw,
    enabled,
    mode: enabled ? mode : 'off',
    canaryPercent: Math.max(0, Math.min(100, Math.round(Number(raw.canaryPercent ?? d.canaryPercent)))),
    holdoutPercent: Math.max(0, Math.min(100, Math.round(Number(raw.holdoutPercent ?? d.holdoutPercent)))),
    minContextTokens: Math.max(1, Math.floor(Number(raw.minContextTokens ?? d.minContextTokens))),
    stateIsolation: raw.stateIsolation === 'per-team' ? 'per-team' : d.stateIsolation,
    telemetry: raw.telemetry === 'off' || raw.telemetry === 'on' || raw.telemetry === 'verify-before-pilot' ? raw.telemetry : d.telemetry,
    passthroughContent: Array.isArray(raw.passthroughContent) && raw.passthroughContent.length ? raw.passthroughContent : d.passthroughContent,
    validationGates: Array.isArray(raw.validationGates) && raw.validationGates.length ? raw.validationGates : d.validationGates,
  };
}

// ---- mock keys (localStorage) ----------------------------------------------
const CHAIN = 84532;
const OWNER = '0x' + 'a657'.padEnd(40, '0');
function mockAddr(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let hex = '';
  let x = h >>> 0;
  for (let i = 0; i < 40; i++) {
    x = (Math.imul(x, 0x01000193) ^ (i + seed.length)) >>> 0;
    hex += (x & 0xf).toString(16);
  }
  return '0x' + hex;
}
interface KeysState {
  accounts: Record<string, Omit<AgentAccount, 'sessions'>>;
  sessions: Record<string, SessionKey[]>;
}
function keysState(): KeysState {
  return lsGet<KeysState>('idctl.keys', { accounts: {}, sessions: {} });
}
function withStatus(s: SessionKey): SessionKey {
  if (s.status === 'revoked') return s;
  if (s.validUntil === 0) return { ...s, status: 'active' }; // until revoked
  return { ...s, status: s.validUntil < Date.now() ? 'expired' : 'active' };
}
function assembleAccount(agent: string, st: KeysState): AgentAccount {
  const base = st.accounts[agent];
  const sessions = (st.sessions[agent] ?? []).map(withStatus);
  return base
    ? { ...base, sessions }
    : { agent, smartAccount: mockAddr('safe:' + agent), owner: OWNER, deployed: false, chainId: CHAIN, sessions };
}
function sessionActive(s: SessionKey): boolean {
  if (s.status === 'revoked') return false;
  if (s.validUntil === 0) return true;
  return s.validUntil >= Date.now();
}
function currentAuthority(target: KeyAuthorityTarget): string {
  const name = String(target.name || '');
  const targetTeam = target.team ? String(target.team) : undefined;
  return targetTeam ? `${targetTeam}:${name}` : name;
}
function legacyKeyAuthorityReport(targets: KeyAuthorityTarget[]): LegacyKeyAuthority[] {
  const st = keysState();
  const byName = new Map<string, Set<string>>();
  for (const target of targets ?? []) {
    const name = String(target.name || '').trim();
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? new Set()).add(currentAuthority(target)));
  }
  const rows: LegacyKeyAuthority[] = [];
  for (const [agent, currentSet] of byName) {
    if (agent.includes(':')) continue;
    const account = st.accounts[agent];
    const sessions = st.sessions[agent] ?? [];
    if (!account && !sessions.length) continue;
    const active = sessions.filter(sessionActive);
    rows.push({
      agent,
      currentAuthorities: [...currentSet].filter((a) => a !== agent).sort(),
      source: 'tauri-localStorage',
      account: Boolean(account),
      deployed: Boolean(account?.deployed),
      totalSessions: sessions.length,
      activeSessions: active.length,
      nonExpiringSessions: active.filter((s) => s.validUntil === 0).length,
      note: 'Bare-name key state is not used by the scoped dashboard. Review before copying, revoking, or deleting it.',
    });
  }
  return rows.filter((row) => row.currentAuthorities.length > 0);
}

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
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const controllerProofs = new Map<string, ControllerProofRecord>();

function controllerProofKey(agent: string, selectedTeam?: string): string {
  return scopedAgentKey(agent, selectedTeam);
}

function challengeMessage(agent: string, wallet: string, nonce: string, selectedTeam?: string): string {
  return [
    'ID Agents controller proof',
    `Team: ${selectedTeam ?? 'default'}`,
    `Agent: ${agent}`,
    `Controller: ${wallet}`,
    `Nonce: ${nonce}`,
    'Purpose: verify controller authority for Control Center privileged identity and key actions.',
  ].join('\n');
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newControllerChallenge(agent: string, wallet: string, selectedTeam?: string): ControllerProofRecord {
  if (!ETH_ADDRESS_RE.test(wallet)) throw new Error('Controller wallet must be a valid 0x address.');
  const nonce = randomHex(16);
  const record: ControllerProofRecord = {
    agent,
    wallet: wallet.toLowerCase(),
    nonce,
    message: challengeMessage(agent, wallet, nonce, selectedTeam),
    signature: '',
    verifiedAt: 0,
    expiresAt: Date.now() + CONTROLLER_PROOF_TTL_MS,
  };
  controllerProofs.set(controllerProofKey(agent, selectedTeam), record);
  return record;
}

function isSignatureLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(value.trim());
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function personalSignHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix);
  msg.set(body, prefix.length);
  return keccak_256(msg);
}

function recoverPersonalSignAddress(message: string, signature: string): string {
  const bytes = hexToBytes(signature.trim());
  const v = bytes[64];
  const recovery = v >= 35 ? (v - 35) % 2 : v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error('Controller signature has an unsupported recovery id.');
  const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(recovery);
  const publicKey = sig.recoverPublicKey(personalSignHash(message)).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

async function verifyControllerChallenge(agent: string, wallet: string, signature: string, selectedTeam?: string): Promise<ControllerProofRecord> {
  const key = controllerProofKey(agent, selectedTeam);
  const record = controllerProofs.get(key);
  if (!record || record.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('No active controller challenge for this agent and wallet.');
  if (record.expiresAt <= Date.now()) {
    controllerProofs.delete(key);
    throw new Error('Controller challenge expired. Start a new challenge.');
  }
  if (!isSignatureLike(signature)) throw new Error('Controller signature must be a 0x-prefixed 65-byte wallet signature.');
  const trimmed = signature.trim();
  const recovered = recoverPersonalSignAddress(record.message, trimmed);
  if (recovered.toLowerCase() !== wallet.toLowerCase()) throw new Error('Controller signature does not match the challenge wallet.');
  const verified = { ...record, signature: trimmed, verifiedAt: Date.now() };
  controllerProofs.set(key, verified);
  return verified;
}

function controllerProofStatus(agent: string, wallet: string, selectedTeam?: string): ControllerProofRecord | null {
  const key = controllerProofKey(agent, selectedTeam);
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

async function controllerWalletForAgent(agent: string, selectedTeam?: string): Promise<string> {
  const agents = await (selectedTeam ? client.withTeam(selectedTeam) : client).agents();
  const row = agents.find((a) => a.name === agent || a.id === agent || a.alias === agent);
  const wallet = controllerWalletFromAgent(row);
  if (!wallet || !ETH_ADDRESS_RE.test(wallet)) throw new Error('No valid controller wallet is linked for this agent.');
  return wallet;
}

async function startControllerChallenge(agent: string, wallet: string, selectedTeam?: string): Promise<ControllerProofRecord> {
  const expected = await controllerWalletForAgent(agent, selectedTeam);
  if (wallet.toLowerCase() !== expected) throw new Error('Controller challenge wallet does not match the agent controller wallet.');
  return newControllerChallenge(agent, expected, selectedTeam);
}

async function verifyControllerChallengeForAgent(agent: string, wallet: string, signature: string, selectedTeam?: string): Promise<ControllerProofRecord> {
  const expected = await controllerWalletForAgent(agent, selectedTeam);
  if (wallet.toLowerCase() !== expected) throw new Error('Controller signature wallet does not match the agent controller wallet.');
  return verifyControllerChallenge(agent, expected, signature, selectedTeam);
}

async function controllerProofStatusForAgent(agent: string, wallet: string, selectedTeam?: string): Promise<ControllerProofRecord | null> {
  const expected = await controllerWalletForAgent(agent, selectedTeam);
  if (wallet.toLowerCase() !== expected) return null;
  return controllerProofStatus(agent, expected, selectedTeam);
}

async function requireControllerProof(agent: string, selectedTeam?: string): Promise<void> {
  const expected = await controllerWalletForAgent(agent, selectedTeam);
  const record = controllerProofs.get(controllerProofKey(agent, selectedTeam));
  if (!record?.verifiedAt || record.expiresAt <= Date.now() || record.wallet.toLowerCase() !== expected) {
    throw new Error('Privileged identity and key actions require a fresh controller-wallet challenge.');
  }
}

async function requireControllerProofIfWalletExists(agent: string, selectedTeam?: string): Promise<void> {
  try {
    await requireControllerProof(agent, selectedTeam);
  } catch (err) {
    if (err instanceof Error && err.message === 'No valid controller wallet is linked for this agent.') return;
    throw err;
  }
}

function unsafeSession(scopeIdx: number, ttlMs: number): boolean {
  const scope = SCOPE_PRESETS[Number(scopeIdx) || 0] ?? SCOPE_PRESETS[0];
  const ttl = Number(ttlMs);
  return !Number.isFinite(ttl) || ttl <= 0 || scope.label.toLowerCase().includes('full') || scope.spendLimitWei === '0';
}
function clientFor(selectedTeam?: string): ManagerClient {
  const selected = String(selectedTeam ?? '').trim();
  return selected ? client.withTeam(selected) : client;
}

const contextBudgetStats = {
  inspected: 0,
  optimized: 0,
  direct: 0,
  protectedDirect: 0,
  originalTokens: 0,
  sentTokens: 0,
  savedTokens: 0,
  recent: [] as ContextBudgetDecision[],
};

function contextDecisionView(decision: ContextBudgetDecision) {
  const original = auditPreview(decision.originalCommand);
  const command = auditPreview(decision.command);
  const { command: _command, originalCommand: _originalCommand, ...rest } = decision;
  void _command;
  void _originalCommand;
  return {
    ...rest,
    originalPreview: original.preview,
    commandPreview: command.preview,
    redactions: Array.from(new Set([...original.redactions, ...command.redactions])),
    previewTruncated: original.truncated || command.truncated,
    rawPromptPersisted: false,
  };
}

function budgetTauriCommand(command: string, source: string, selectedTeam?: string): string {
  const decision = optimizeAskCommandCore(command, { source, team: selectedTeam ?? team });
  contextBudgetStats.inspected += 1;
  contextBudgetStats.originalTokens += decision.originalTokens;
  contextBudgetStats.sentTokens += decision.sentTokens;
  contextBudgetStats.savedTokens += decision.savedTokens;
  if (decision.changed) contextBudgetStats.optimized += 1;
  else contextBudgetStats.direct += 1;
  if (decision.protectedContent.length) contextBudgetStats.protectedDirect += 1;
  contextBudgetStats.recent.unshift(decision);
  contextBudgetStats.recent.splice(20);
  return decision.command;
}

function contextBudgetReport() {
  const measurement = {
    inspected: contextBudgetStats.inspected,
    optimized: contextBudgetStats.optimized,
    direct: contextBudgetStats.direct,
    protectedDirect: contextBudgetStats.protectedDirect,
    originalTokens: contextBudgetStats.originalTokens,
    sentTokens: contextBudgetStats.sentTokens,
    savedTokens: contextBudgetStats.savedTokens,
    savingsRatio: contextBudgetStats.originalTokens > 0 ? contextBudgetStats.savedTokens / contextBudgetStats.originalTokens : 0,
    bySource: {},
    byTeam: {},
    byRoute: {},
    byTransform: {},
    byProtectedContent: {},
  };
  return {
    coreEnabled: true,
    frontendSurface: 'hidden',
    inspected: contextBudgetStats.inspected,
    optimized: contextBudgetStats.optimized,
    direct: contextBudgetStats.direct,
    protectedDirect: contextBudgetStats.protectedDirect,
    originalTokens: contextBudgetStats.originalTokens,
    sentTokens: contextBudgetStats.sentTokens,
    savedTokens: contextBudgetStats.savedTokens,
    savingsRatio: contextBudgetStats.originalTokens > 0 ? contextBudgetStats.savedTokens / contextBudgetStats.originalTokens : 0,
    recent: contextBudgetStats.recent.map(contextDecisionView),
    storageDir: '(unavailable in Tauri webview shell)',
    persisted: {
      updatedAt: 0,
      storageFile: '(unavailable in Tauri webview shell)',
      allTime: measurement,
      today: measurement,
      last7Days: measurement,
    },
    policy: {
      route: 'deterministic-first',
      headroomEngine: 'not-required-for-core-budgeting',
      retrieval: 'in-memory-redacted-previews-only',
    },
    qualityGuards: [
      'Only /ask payloads are eligible; manager lifecycle commands pass through unchanged.',
      'Secrets, auth material, agent instruction sidecars, active code patches, and wallet/key material always use the direct route.',
      'The hot path uses deterministic compaction only; no AI summarizer rewrites prompts before dispatch.',
      'If savings are below the minimum gate, the exact original prompt is sent.',
      'Hidden reports and dry-runs return redacted previews only; raw prompts are not persisted.',
    ],
  };
}

function emptyContextBudgetHistoryReplay() {
  const totals = {
    inspected: 0,
    optimized: 0,
    direct: 0,
    protectedDirect: 0,
    originalTokens: 0,
    sentTokens: 0,
    savedTokens: 0,
    savingsRatio: 0,
    bySource: {},
    byTeam: {},
    byRoute: {},
    byTransform: {},
    byProtectedContent: {},
  };
  return {
    corpus: 'local-chat-history',
    dryRunOnly: true,
    rawPromptPersisted: false,
    managerContacted: false,
    storage: 'none',
    scannedSessions: 0,
    scannedMessages: 0,
    eligibleMessages: 0,
    skippedMessages: 0,
    limits: { limitSessions: 0, maxMessages: 0, sampleLimit: 0 },
    totals,
    samples: [],
    guardrails: [
      'Historical replay requires Electron main-process file access; this shell returns an empty no-prompt report.',
    ],
  };
}

function headroomPluginPathFallback() {
  return {
    coreReady: false,
    pilotReady: false,
    verdict: 'valid-pilot-path-runtime-neutral-contract-required',
    candidate: {
      name: 'idacc-context-retrieval',
      bundled: false,
      bundledPath: null,
      manifestOk: false,
      skillOk: false,
      toolOk: false,
      smokeOk: false,
      mcpOk: false,
      portableOk: false,
      adapterCoverage: {
        portablePluginRuntimes: [],
        skillRuntimes: [],
        mcpRuntimes: [],
        nativePluginRuntimes: [],
        directFallbackRuntimes: [],
        unsupportedRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
      },
      smokeError: 'Plugin candidate validation requires Electron packaged resources.',
    },
    manager: {
      capabilitiesRoute: false,
      retrievalFeatureAdvertised: false,
      pluginListed: false,
      pluginSourcePath: null,
    },
    headroom: {
      mcpCatalogEntry: true,
      cliFound: false,
      proxyReachable: false,
    },
    runtimeCoverage: {
      allRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
      pluginRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local'],
      portablePluginRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
      mcpRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'grok', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
      directFallbackRuntimes: ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
      pluginOnlyWouldExclude: ['codex', 'cursor-cli', 'grok', 'antigravity', 'gemini', 'copilot', 'kiro-cli', 'q', 'ollama'],
    },
    modeMatrix: [
      { mode: 'direct-deterministic', coreEligible: true, pilotEligible: true, reason: 'Universal fallback.' },
      { mode: 'idacc-context-retrieval-plugin', coreEligible: false, pilotEligible: false, reason: 'Electron packaged resources are required for validation.' },
      { mode: 'idacc-portable-plugin-package', coreEligible: false, pilotEligible: false, reason: 'Electron packaged resources are required for portable adapter validation.' },
    ],
    guardrails: [
      'Plugin-only routing is not core-eligible because it would exclude non-Claude runtimes.',
      'IDACC plugins are runtime-neutral only as portable packages with declared Skill, MCP, native-plugin, and direct-fallback adapters; native plugin loaders remain runtime-specific.',
      'Direct deterministic routing remains the universal fallback for stock managers and unsupported runtimes.',
    ],
    blockers: ['Use the Electron build to validate packaged plugin resources and Headroom CLI/proxy status.'],
  };
}

function stripMarkdownFrontmatter(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (match ? text.slice(match[0].length) : text).trim();
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
    return inspectLibraryPluginMetadata(plugin, detail, skillNames);
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
  const inspection = inspectLibraryPluginMetadata(plugin, detail, skills.map((skill) => skill.name));
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

const M: Record<string, (...a: any[]) => Promise<unknown>> = {
  info: async () => ({ managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null }),
  health: () => client.health(),
  agents: () => client.agents(),
  teams: () => client.teams(),
  'agents:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [team || 'default'];
    const groups = await mapTeamAgentGroups<Agent>(names, (name) => client.withTeam(name).agents());
    return groups.filter((g) => g.agents.length > 0);
  },
  'wiki:get': () => fetchWiki(),
  events: (since: number) => client.events(Number(since) || 0, { wait: 20, limit: 100 }),
  inboxPending: () => client.inboxPending(),
  tasks: () => boardTasksForTeam(team || 'default'),
  dispatch: (cmd: string) => client.dispatch(budgetTauriCommand(String(cmd), 'tauri:dispatch', team)),
  remote: (cmd: string, agent?: string, selectedTeam?: string) => {
    const c = clientFor(selectedTeam);
    return c.remote(budgetTauriCommand(String(cmd), 'tauri:remote', selectedTeam ?? c.team), agent);
  },
  probeAll: () => client.probeAll(),
  probeOne: (n: string, selectedTeam?: string) => clientFor(selectedTeam).probeOne(String(n)),
  'headroom:status': async () => ({
    cli: { found: false, error: 'Headroom status requires the Electron main process.' },
    proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: false, error: 'not checked in this shell' },
  }),
  'headroom:audit': async () => {
    const status = {
      cli: { found: false, error: 'Headroom status requires the Electron main process.' },
      proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: false, error: 'not checked in this shell' },
    };
    return {
      coreReady: false,
      healthSurface: 'hidden',
      decision: 'not-ready',
      status,
      reasons: [
        'Headroom CLI/proxy status is unavailable in this shell.',
        'IDACC has no manager-side contract that proves compressed prompt recovery before an agent acts.',
      ],
      blockedInsertionPoints: ['Work, Chat, Plans, Learn, and validator prompts stay on direct routes.'],
      requiredForCore: ['Electron/main-process Headroom detection plus manager retrieval-handle support.'],
      safeToday: ['Keep Headroom out of the Health UI and use direct routing.'],
      policy: headroomPilotState(),
    };
  },
  'headroom:pluginPath': async () => headroomPluginPathFallback(),
  'headroom:backendContract': async () => {
    const replay = emptyContextBudgetHistoryReplay();
    const pluginPath = headroomPluginPathFallback();
    return {
      coreReady: false,
      validationReady: false,
      decision: 'validate-idacc-plugin-path-first',
      managerChangeLevel: 'none-now-minimal-later',
      recommendedPath: 'idacc-owned-plugin-candidate',
      status: {
        cli: { found: false, error: 'Headroom status requires the Electron main process.' },
        proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: false, error: 'not checked in this shell' },
      },
      historyReplay: {
        corpus: replay.corpus,
        dryRunOnly: replay.dryRunOnly,
        rawPromptPersisted: replay.rawPromptPersisted,
        managerContacted: replay.managerContacted,
        scannedSessions: replay.scannedSessions,
        eligibleMessages: replay.eligibleMessages,
        totals: replay.totals,
        guardrails: replay.guardrails,
      },
      pluginPath,
      phases: ['Use the Electron build for local chat-history replay and plugin validation.'],
      pluginCandidate: {
        name: 'idacc-context-retrieval',
        installSurface: 'Capabilities or Settings reviewed install',
        managerRequirement: 'existing id-agents plugin attachment and rebuild flow',
        purpose: 'Expose a narrow local retrieval tool for context handles without forking the base manager hot path.',
      },
      requiredContract: ['Manager /capabilities must advertise context-retrieval before handle routing.'],
      validationGates: ['Electron replay and plugin smoke tests must pass before activation.'],
      blockers: ['Tauri shell cannot validate local plugin file access.'],
    };
  },
  'headroom:pilot': async () => headroomPilotState(),
  'headroom:setPilot': async (partial: Partial<HeadroomPilotSettings>) => {
    const next = { ...headroomPilotState(), ...(partial ?? {}), updatedAt: Date.now() };
    lsSet('idctl.headroomPilot', next);
    return headroomPilotState();
  },
  'context:budgetReport': async () => contextBudgetReport(),
  'context:budgetRecent': async () => contextBudgetStats.recent.map(contextDecisionView),
  'context:budgetRecord': async () => null,
  'context:budgetDryRun': async (command: string, source?: string, selectedTeam?: string) =>
    contextDecisionView(optimizeAskCommandCore(String(command), { source: source ? String(source) : 'tauri:dry-run', team: selectedTeam ? String(selectedTeam) : team })),
  'context:budgetReplayChats': async () => emptyContextBudgetHistoryReplay(),
  checkins: () => client.checkins(),
  schedules: () => client.schedules(),
  addHeartbeat: (agent: string, seconds: number, message: string, delivery?: 'internal' | 'talk') => client.addHeartbeat(String(agent), Number(seconds), String(message), delivery),
  addCalendarCheckin: (agent: string, time: string, when: string, message: string, opts?: { timezone?: string; delivery?: 'internal' | 'talk' }) => client.addCalendarCheckin(String(agent), String(time), String(when), String(message), opts ?? {}),
  pauseSchedule: (id: string) => client.pauseSchedule(String(id)),
  resumeSchedule: (id: string) => client.resumeSchedule(String(id)),
  removeSchedule: (id: string) => client.removeSchedule(String(id)),
  libraryTeams: () => client.libraryTeams(),
  configs: () => client.configs(),
  deployTeam: (n: string) => client.deployTeam(String(n)),
  teamConfig: (n: string) => client.teamConfig(String(n)),
  setTeamDelegates: (n: string, delegates: string[] | null) => client.setTeamDelegates(String(n), delegates ?? null),
  setAgentDelegates: (id: string, delegates: string[] | null) => client.setAgentDelegates(String(id), delegates ?? null),
  setAgentRuntime: (id: string, runtime: string, selectedTeam?: string) =>
    setAgentRuntimeFromSettings(String(id), String(runtime), selectedTeam ? String(selectedTeam) : undefined),
  setAgentEffort: (id: string, effort: string, selectedTeam?: string) => clientFor(selectedTeam).setAgentEffort(String(id), String(effort ?? '')),
  setAgentSpeed: (id: string, speed: string, selectedTeam?: string) => clientFor(selectedTeam).setAgentSpeed(String(id), String(speed ?? '')),
  spawnAgent: (spec: Parameters<ManagerClient['spawnAgent']>[0]) => client.spawnAgent(spec),
  'identity:controllerChallenge': async (agent: string, wallet: string, selectedTeam?: string) => startControllerChallenge(String(agent), String(wallet), selectedTeam ? String(selectedTeam) : undefined),
  'identity:controllerVerify': async (agent: string, wallet: string, signature: string, selectedTeam?: string) => verifyControllerChallengeForAgent(String(agent), String(wallet), String(signature), selectedTeam ? String(selectedTeam) : undefined),
  'identity:controllerStatus': async (agent: string, wallet: string, selectedTeam?: string) => controllerProofStatusForAgent(String(agent), String(wallet), selectedTeam ? String(selectedTeam) : undefined),
  'identity:register': async (agent: string, selectedTeam?: string) => {
    const name = String(agent);
    const teamName = selectedTeam ? String(selectedTeam) : undefined;
    await requireControllerProof(name, teamName);
    return (teamName ? client.withTeam(teamName) : client).remote(`/register ${name}`);
  },
  'wallet:provision': async (agent: string, selectedTeam?: string) => {
    const name = String(agent);
    const teamName = selectedTeam ? String(selectedTeam) : undefined;
    await requireControllerProofIfWalletExists(name, teamName);
    return (teamName ? client.withTeam(teamName) : client).remote(`/agent ${name} wallet provision`);
  },
  'runtime:models': async () => buildRuntimeCatalog(lsGet<ProviderProfile[]>('idctl.providers', [])),
  'runtime:freshness': async () => runtimeFreshnessLocal(),
  'runtime:probe': async () => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    await Promise.all(
      list.filter((p) => p.enabled !== false).map(async (p) => {
        try {
          const outcome = await new ProviderClient(p, p.apiKey).probe();
          p.lastSync = { at: Date.now(), status: outcome.status, modelCount: outcome.models.length, models: outcome.models.slice(0, 200).map((m) => m.id), keySource: p.apiKey ? 'config' : 'none' };
        } catch { /* keep last sync */ }
      }),
    );
    lsSet('idctl.providers', list);
    return buildRuntimeCatalog(list);
  },
  'runtime:cooldowns': async () => client.runtimeCooldowns(),
  'manager:capabilities': () => client.capabilities(),

  // modules: skills + plugins catalog, install, MCP attach + rebuild
  librarySkills: () => client.librarySkills(),
  libraryPlugins: () => client.libraryPlugins(),
  libraryPluginInspections: () => inspectLibraryPlugins(),
  'skills:localCandidates': async () => [],
  'skills:importLocalCandidate': async () => {
    throw new Error('Local skill import requires the Electron build.');
  },
  installSkill: (skill: string, agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).installSkill(String(skill), String(agent)),
  projectPluginSkill: (name: string) => projectPluginSkill(name),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
  deleteSkill: (name: string) => client.deleteSkill(String(name)),
  uninstallSkill: (skill: string, agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).uninstallSkill(String(skill), String(agent)),
  usage: () => client.usage(),
  setAgentMcp: (agentId: string, servers: McpServerSpec[], team?: string) => (team ? client.withTeam(String(team)) : client).setAgentMcp(String(agentId), servers ?? []),
  rebuildAgent: (agent: string, team?: string) => (team ? client.withTeam(String(team)) : client).remote(`/agent ${agent} rebuild`),
  'mcp:list': async () => lsGet<McpServerProfile[]>('idctl.mcpServers', []),
  'mcp:add': async (p: McpServerProfile) => {
    const list = lsGet<McpServerProfile[]>('idctl.mcpServers', []);
    const i = list.findIndex((x) => x.name === p.name);
    if (i >= 0) list[i] = p;
    else list.push(p);
    lsSet('idctl.mcpServers', list);
    return list;
  },
  'mcp:remove': async (name: string) => {
    const list = lsGet<McpServerProfile[]>('idctl.mcpServers', []).filter((x) => x.name !== name);
    lsSet('idctl.mcpServers', list);
    return list;
  },
  'mcp:test': async () => ({ ok: false, error: 'Test requires the Electron build.' }),

  // projects (local tracker)
  'projects:list': async () => lsGet<ProjectEntry[]>('idctl.projects', []),
  'projects:save': async (p: ProjectEntry) => {
    const list = lsGet<ProjectEntry[]>('idctl.projects', []);
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p; else list.push(p);
    lsSet('idctl.projects', list);
    return list;
  },
  'projects:remove': async (id: string) => {
    const list = lsGet<ProjectEntry[]>('idctl.projects', []).filter((x) => x.id !== id);
    lsSet('idctl.projects', list);
    return list;
  },

  // keys (localStorage mock)
  'keys:caps': async () => ({ provider: 'mock', chainId: CHAIN, chainLabel: 'Base Sepolia (mock)', live: false }),
  'keys:presets': async () => ({ scopes: SCOPE_PRESETS, ttls: TTL_PRESETS }),
  'keys:list': async (agents: string[]) => {
    const st = keysState();
    return (agents ?? []).map((a) => assembleAccount(a, st));
  },
  'keys:legacyAuthority': async (targets: KeyAuthorityTarget[]) => legacyKeyAuthorityReport(targets ?? []),
  'keys:ensure': async (agent: string, selectedTeam?: string) => {
    await requireControllerProof(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const key = scopedAgentKey(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const st = keysState();
    if (!st.accounts[key]) {
      st.accounts[key] = { agent: key, smartAccount: mockAddr('safe:' + key), owner: OWNER, deployed: false, chainId: CHAIN };
      lsSet('idctl.keys', st);
    }
    return assembleAccount(key, st);
  },
  'keys:deploy': async (agent: string, selectedTeam?: string) => {
    await requireControllerProof(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const key = scopedAgentKey(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const st = keysState();
    st.accounts[key] = { ...(st.accounts[key] ?? { agent: key, smartAccount: mockAddr('safe:' + key), owner: OWNER, deployed: false, chainId: CHAIN }), deployed: true };
    lsSet('idctl.keys', st);
    return assembleAccount(key, st);
  },
  'keys:issue': async (agent: string, scopeIdx: number, ttlMs: number, selectedTeam?: string) => {
    await requireControllerProof(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    if (unsafeSession(scopeIdx, ttlMs)) throw new Error('Refusing to issue uncapped, full, non-expiring, or invalid session keys from the Control Center.');
    const key = scopedAgentKey(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const st = keysState();
    const now = Date.now();
    const id = 'sess_' + now.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    const ttl = Number(ttlMs);
    const session: SessionKey = { id, agent: key, address: mockAddr('session:' + key + id), scope: SCOPE_PRESETS[Number(scopeIdx) || 0], createdAt: now, validUntil: ttl > 0 ? now + ttl : 0, status: 'active' };
    (st.sessions[key] ??= []).push(session);
    lsSet('idctl.keys', st);
    return session;
  },
  'keys:revoke': async (agent: string, sessionId: string, selectedTeam?: string) => {
    await requireControllerProof(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const key = scopedAgentKey(String(agent), selectedTeam ? String(selectedTeam) : undefined);
    const st = keysState();
    const s = (st.sessions[key] ?? []).find((x) => x.id === sessionId);
    if (s) {
      s.status = 'revoked';
      lsSet('idctl.keys', st);
    }
    return null;
  },

  // providers (localStorage + live probe + connect/sync)
  'providers:list': async () => enrichProviders(lsGet<ProviderProfile[]>('idctl.providers', [])),
  'providers:add': async (p: ProviderProfile) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    const i = list.findIndex((x) => x.name === p.name);
    if (i >= 0) list[i] = p;
    else list.push(p);
    lsSet('idctl.providers', list);
    return enrichProviders(list);
  },
  'providers:remove': async (name: string) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []).filter((x) => x.name !== name);
    lsSet('idctl.providers', list);
    return enrichProviders(list);
  },
  'providers:setDefault': async (name: string) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    for (const p of list) p.default = p.name === name;
    lsSet('idctl.providers', list);
    return enrichProviders(list);
  },
  'providers:setModelSelection': async (name: string, selection: ProviderModelSelection) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    const p = list.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    p.modelSelection = normalizeProviderModelSelection(selection);
    lsSet('idctl.providers', list);
    return enrichProviders(list);
  },
  'providers:toggle': async (name: string) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    const p = list.find((x) => x.name === name);
    if (p) p.enabled = !p.enabled;
    lsSet('idctl.providers', list);
    return enrichProviders(list);
  },
  'providers:probe': async (name: string) => {
    const p = lsGet<ProviderProfile[]>('idctl.providers', []).find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    return new ProviderClient(p, p.apiKey).probe();
  },
  'providers:connect': async (name: string) => {
    const list = lsGet<ProviderProfile[]>('idctl.providers', []);
    const p = list.find((x) => x.name === name);
    if (!p) throw new Error('provider not found');
    const outcome = await new ProviderClient(p, p.apiKey).probe();
    p.lastSync = {
      at: Date.now(),
      status: outcome.status,
      modelCount: outcome.models.length,
      models: outcome.models.slice(0, 200).map((m) => m.id),
      keySource: p.apiKey ? 'config' : 'none',
    };
    lsSet('idctl.providers', list);
    return { providers: enrichProviders(list), outcome };
  },
  'providers:discover': async (extraCandidates?: unknown) => {
    const found = await discoverLocalServers({ candidates: mergeLocalDiscoveryCandidates(extraCandidates) });
    const norm = (u: string) => u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
    const have = new Set(lsGet<ProviderProfile[]>('idctl.providers', []).map((p) => norm(p.baseUrl)));
    return found.map((s: DiscoveredServer) => ({ ...s, alreadyAdded: have.has(norm(s.baseUrl)) }));
  },
  'cu:permissions': async () => computerUseUnavailablePermissions(),
  'cu:status': async () => computerUseUnavailableStatus(),
  'cu:attached': async () => [],
  'cu:audit': async () => [],
  'cu:pending': async () => [],
  'cu:watch': async () => ({ ok: false, unavailable: true, message: COMPUTER_USE_UNAVAILABLE }),
  'cu:arm': async () => computerUseUnavailableStatus(),
  'cu:disarm': async () => ({ ok: false, unavailable: true, message: COMPUTER_USE_UNAVAILABLE }),
  'cu:panic': async () => ({ ok: false, unavailable: true, message: COMPUTER_USE_UNAVAILABLE }),
  'cu:setSupervised': async () => computerUseUnavailableStatus(),
  'cu:pause': async () => computerUseUnavailableStatus(),
  'cu:confirm': async () => ({ ok: false }),
  'cu:attach': async () => { throw new Error(COMPUTER_USE_UNAVAILABLE); },
  'cu:detach': async () => { throw new Error(COMPUTER_USE_UNAVAILABLE); },
  'cu:openPermission': async () => ({ ok: false, unavailable: true, message: COMPUTER_USE_UNAVAILABLE }),
  'cu:relaunch': async () => ({ ok: false, unavailable: true, message: COMPUTER_USE_UNAVAILABLE }),
  'cu:legacyAuthority': async () => [],
};

const readCallCache = new ReadCallCache();

function clearReadCache(): void {
  readCallCache.clear();
}

export async function tauriCall(method: string, args: unknown[] = []): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    if (method === 'setTeam') {
      clearReadCache();
      team = String(args[0]) || 'default';
      localStorage.setItem('idctl.team', team);
      client = makeClient();
      return { ok: true, result: { managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null } };
    }
    if (method === 'setManager') {
      clearReadCache();
      managerUrl = String(args[0]);
      localStorage.setItem('idctl.managerUrl', managerUrl);
      client = makeClient();
      return { ok: true, result: { managerUrl, team } };
    }
    if (method === 'coordinator:get') {
      return { ok: true, result: lsGet<Record<string, string>>('idctl.coordinators', {})[String(args[0] ?? team)] ?? null };
    }
    if (method === 'coordinator:set') {
      const targetTeam = String(args[0]);
      const agent = String(args[1]);
      assertDefaultCoordinatorWrite(targetTeam, agent);
      const map = lsGet<Record<string, string>>('idctl.coordinators', {});
      map[targetTeam] = agent;
      lsSet('idctl.coordinators', map);
      clearReadCache();
      return { ok: true, result: { ok: true } };
    }
    if (method === 'coordinator:setPrimary') {
      const t = String(args[0]);
      const a = String(args[1]);
      assertDefaultPrimaryWrite(t, a);
      lsSet('idctl.primaryCoordinator', { team: t, agent: a });
      const map = lsGet<Record<string, string>>('idctl.coordinators', {});
      map[t] = a; // primary is also its team's lead
      lsSet('idctl.coordinators', map);
      clearReadCache();
      return { ok: true, result: { managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null } };
    }
    if (method === 'coordinator:hierarchy') {
      return {
        ok: true,
        result: {
          primary: { team: PRIMARY_TEAM, agent: DEFAULT_PRIMARY_AGENT },
          coordinators: { ...lsGet<Record<string, string>>('idctl.coordinators', {}), [PRIMARY_TEAM]: DEFAULT_PRIMARY_AGENT },
        },
      };
    }
    const fn = M[method];
    if (!fn) throw new Error('unknown method: ' + method);
    const result = COALESCED_READ_METHODS.has(method)
      ? await readCallCache.run(method, args, () => fn(...args))
      : await fn(...args);
    if (!COALESCED_READ_METHODS.has(method) && syncDomainsForMethod(method).length > 0) {
      clearReadCache();
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
