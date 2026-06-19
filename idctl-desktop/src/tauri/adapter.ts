/**
 * Tauri transport adapter. The same React UI as the Electron build, but data
 * access runs IN THE WEBVIEW: ManagerClient over the Tauri HTTP plugin (Rust
 * does the request → no CORS), and settings/keys persisted in localStorage
 * (the webview has no Node fs). Implements the exact method contract the views
 * call via store.ts `call()`.
 */

import { ManagerClient } from '../../../idctl/src/api/client.ts';
import { ProviderClient } from '../../../idctl/src/settings/ProviderClient.ts';
import { SCOPE_PRESETS, TTL_PRESETS } from '../../../idctl/src/keys/types.ts';
import type { AgentAccount, SessionKey } from '../../../idctl/src/keys/types.ts';
import { kindNeedsKey, type ProviderProfile, type McpServerProfile } from '../../../idctl/src/settings/schema.ts';
import { buildRuntimeCatalog } from '../../../idctl/src/settings/runtimeCatalog.ts';
import type { McpServerSpec, CreateSkillInput } from '../../../idctl/src/api/client.ts';

const MGR_DEFAULT = 'http://127.0.0.1:4100';
let managerUrl = localStorage.getItem('idctl.managerUrl') || MGR_DEFAULT;
let team = localStorage.getItem('idctl.team') || 'default';
let client = makeClient();

function makeClient(): ManagerClient {
  // Local control center on loopback → legitimate admin client.
  return new ManagerClient({ managerUrl, team, refreshMs: 3000, waitSeconds: 25, admin: true });
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

/** Enrich provider rows with key source (no env in the webview) + needsKey flag. */
function enrichProviders(list: ProviderProfile[]) {
  return list.map((p) => ({ ...p, keySource: (p.apiKey ? 'config' : 'none') as 'config' | 'env' | 'none', needsKey: kindNeedsKey(p.kind) }));
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

const M: Record<string, (...a: any[]) => Promise<unknown>> = {
  info: async () => ({ managerUrl, team, coordinator: lsGet<Record<string, string>>('idctl.coordinators', {})[team] ?? null }),
  health: () => client.health(),
  agents: () => client.agents(),
  teams: () => client.teams(),
  events: (since: number) => client.events(Number(since) || 0, { wait: 20, limit: 100 }),
  inboxPending: () => client.inboxPending(),
  tasks: () => client.tasks(),
  dispatch: (cmd: string) => client.dispatch(String(cmd)),
  remote: (cmd: string, agent?: string) => client.remote(String(cmd), agent),
  probeAll: () => client.probeAll(),
  probeOne: (n: string) => client.probeOne(String(n)),
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
  setAgentRuntime: (id: string, runtime: string) => client.setAgentRuntime(String(id), String(runtime)),
  spawnAgent: (spec: Parameters<ManagerClient['spawnAgent']>[0]) => client.spawnAgent(spec),
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

  // modules: skills + plugins catalog, install, MCP attach + rebuild
  librarySkills: () => client.librarySkills(),
  libraryPlugins: () => client.libraryPlugins(),
  installSkill: (skill: string, agent: string) => client.installSkill(String(skill), String(agent)),
  createSkill: (input: CreateSkillInput) => client.createSkill(input),
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

  // keys (localStorage mock)
  'keys:caps': async () => ({ provider: 'mock', chainId: CHAIN, chainLabel: 'Base Sepolia (mock)', live: false }),
  'keys:presets': async () => ({ scopes: SCOPE_PRESETS, ttls: TTL_PRESETS }),
  'keys:list': async (agents: string[]) => {
    const st = keysState();
    return (agents ?? []).map((a) => assembleAccount(a, st));
  },
  'keys:ensure': async (agent: string) => {
    const st = keysState();
    if (!st.accounts[agent]) {
      st.accounts[agent] = { agent, smartAccount: mockAddr('safe:' + agent), owner: OWNER, deployed: false, chainId: CHAIN };
      lsSet('idctl.keys', st);
    }
    return assembleAccount(agent, st);
  },
  'keys:deploy': async (agent: string) => {
    const st = keysState();
    st.accounts[agent] = { ...(st.accounts[agent] ?? { agent, smartAccount: mockAddr('safe:' + agent), owner: OWNER, deployed: false, chainId: CHAIN }), deployed: true };
    lsSet('idctl.keys', st);
    return assembleAccount(agent, st);
  },
  'keys:issue': async (agent: string, scopeIdx: number, ttlMs: number) => {
    const st = keysState();
    const now = Date.now();
    const id = 'sess_' + now.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    const ttl = Number(ttlMs);
    const key: SessionKey = { id, agent, address: mockAddr('session:' + agent + id), scope: SCOPE_PRESETS[Number(scopeIdx) || 0], createdAt: now, validUntil: ttl > 0 ? now + ttl : 0, status: 'active' };
    (st.sessions[agent] ??= []).push(key);
    lsSet('idctl.keys', st);
    return key;
  },
  'keys:revoke': async (agent: string, sessionId: string) => {
    const st = keysState();
    const s = (st.sessions[agent] ?? []).find((x) => x.id === sessionId);
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
      const map = lsGet<Record<string, string>>('idctl.coordinators', {});
      map[String(args[0])] = String(args[1]);
      lsSet('idctl.coordinators', map);
      return { ok: true, result: { ok: true } };
    }
    if (method === 'coordinator:setPrimary') {
      const t = String(args[0]);
      const a = String(args[1]);
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
          primary: lsGet<{ team: string; agent: string } | null>('idctl.primaryCoordinator', null),
          coordinators: lsGet<Record<string, string>>('idctl.coordinators', {}),
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
