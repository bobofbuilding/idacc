/**
 * Tauri transport adapter. The same React UI as the Electron build, but data
 * access runs IN THE WEBVIEW: ManagerClient over the Tauri HTTP plugin (Rust
 * does the request → no CORS), and settings/keys persisted in localStorage
 * (the webview has no Node fs). Implements the exact method contract the views
 * call via store.ts `call()`.
 */

import { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent } from '../../../idctl/src/api/types.ts';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { discoverLocalServers, type DiscoveredServer } from '../../../idctl/src/settings/localDiscovery.ts';
import { SCOPE_PRESETS, TTL_PRESETS } from '../../../idctl/src/keys/types.ts';
import type { AgentAccount, KeyAuthorityTarget, LegacyKeyAuthority, SessionKey } from '../../../idctl/src/keys/types.ts';
import { defaultHeadroomPilotSettings, kindNeedsKey, type HeadroomPilotSettings, type ProviderProfile, type McpServerProfile, type ProjectEntry } from '../../../idctl/src/settings/schema.ts';
import { buildRuntimeCatalog } from '../../../idctl/src/settings/runtimeCatalog.ts';
import type { McpServerSpec, CreateSkillInput } from '../../../idctl/src/api/client.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const MGR_DEFAULT = 'http://127.0.0.1:4100';
const WIKI_URL = 'docs/CONTROL_CENTER_WIKI.json';
let managerUrl = localStorage.getItem('idctl.managerUrl') || MGR_DEFAULT;
let team = localStorage.getItem('idctl.team') || 'default';
let client = makeClient();
const PRIMARY_TEAM = 'default';
const DEFAULT_PRIMARY_AGENT = 'lead';

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

function scopedAgentKey(agent: string, selectedTeam?: string): string {
  return selectedTeam ? `${selectedTeam}:${agent}` : agent;
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
  return list.map((p) => ({ ...p, keySource: (p.apiKey ? 'config' : 'none') as 'config' | 'env' | 'none', needsKey: kindNeedsKey(p.kind) }));
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

function controllerWalletFromAgent(agent: Agent | undefined): string {
  const meta = agent?.metadata as Record<string, unknown> | undefined;
  const direct = agent as (Agent & { ows_address?: string | null }) | undefined;
  return (
    ethAddress(direct?.ows_address) ||
    ethAddress(meta?.ows_address) ||
    ethAddress(meta?.skillmesh_address) ||
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

const M: Record<string, (...a: any[]) => Promise<unknown>> = {
  info: async () => ({ managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null }),
  health: () => client.health(),
  agents: () => client.agents(),
  teams: () => client.teams(),
  'agents:allTeams': async () => {
    const teams = await client.teams().catch(() => []);
    const names = teams.length ? teams.map((t) => t.name) : [team || 'default'];
    const groups = await Promise.all(
      names.map(async (name) => ({ team: name, agents: await client.withTeam(name).agents().catch(() => []) })),
    );
    return groups.filter((g) => g.agents.length > 0);
  },
  'wiki:get': () => fetchWiki(),
  events: (since: number) => client.events(Number(since) || 0, { wait: 20, limit: 100 }),
  inboxPending: () => client.inboxPending(),
  tasks: () => client.tasks(),
  dispatch: (cmd: string) => client.dispatch(String(cmd)),
  remote: (cmd: string, agent?: string, selectedTeam?: string) => clientFor(selectedTeam).remote(String(cmd), agent),
  probeAll: () => client.probeAll(),
  probeOne: (n: string, selectedTeam?: string) => clientFor(selectedTeam).probeOne(String(n)),
  'headroom:status': async () => ({
    cli: { found: false, error: 'Headroom status requires the Electron main process.' },
    proxy: { url: 'http://127.0.0.1:8787/mcp', reachable: false, error: 'not checked in this shell' },
  }),
  'headroom:pilot': async () => headroomPilotState(),
  'headroom:setPilot': async (partial: Partial<HeadroomPilotSettings>) => {
    const next = { ...headroomPilotState(), ...(partial ?? {}), updatedAt: Date.now() };
    lsSet('idctl.headroomPilot', next);
    return headroomPilotState();
  },
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
  setAgentRuntime: (id: string, runtime: string, selectedTeam?: string) => clientFor(selectedTeam).setAgentRuntime(String(id), String(runtime)),
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
  installSkill: (skill: string, agent: string) => client.installSkill(String(skill), String(agent)),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
  deleteSkill: (name: string) => client.deleteSkill(String(name)),
  uninstallSkill: (skill: string, agent: string) => client.uninstallSkill(String(skill), String(agent)),
  usage: () => client.usage(),
  setAgentMcp: (agentId: string, servers: McpServerSpec[]) => client.setAgentMcp(String(agentId), servers ?? []),
  rebuildAgent: (agent: string) => client.remote(`/agent ${agent} rebuild`),
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
  'providers:discover': async () => {
    const found = await discoverLocalServers();
    const norm = (u: string) => u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
    const have = new Set(lsGet<ProviderProfile[]>('idctl.providers', []).map((p) => norm(p.baseUrl)));
    return found.map((s: DiscoveredServer) => ({ ...s, alreadyAdded: have.has(norm(s.baseUrl)) }));
  },
  'cu:legacyAuthority': async () => [],
};

export async function tauriCall(method: string, args: unknown[] = []): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    if (method === 'setTeam') {
      team = String(args[0]) || 'default';
      localStorage.setItem('idctl.team', team);
      client = makeClient();
      return { ok: true, result: { managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null } };
    }
    if (method === 'setManager') {
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
    return { ok: true, result: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
