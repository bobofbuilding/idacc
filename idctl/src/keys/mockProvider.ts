/**
 * MockKeyProvider — simulates the Safe-account + 4337-session-key model locally
 * so the Keys UX is fully testable with no bundler/testnet. State persists to
 * ~/.config/idctl/keys-mock.json so it survives across runs (realistic UX).
 * Addresses are deterministic sha256-derived stand-ins (clearly not real keys).
 *
 * Swap this for a Safe4337KeyProvider (same KeyProvider interface) to go live —
 * the views never change.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { configDir, resolveConfigPath } from '../settings/paths.ts';
import {
  ROOT_AGENT_SAFE_ADDRESS,
  agentEnsName,
  type AgentAccount,
  type KeyAuthorityTarget,
  type KeyCapabilities,
  type KeyProvider,
  type LegacyKeyAuthority,
  type SessionKey,
  type SessionScope,
} from './types.ts';

const MOCK_CHAIN_ID = 84532; // Base Sepolia (target for the real wiring later)
const MOCK_OWNER = ROOT_AGENT_SAFE_ADDRESS;

function statePath(): string {
  return join(configDir(resolveConfigPath()), 'keys-mock.json');
}

/** Deterministic 20-byte hex address from a seed (clearly a mock, not a key). */
function mockAddr(seed: string): string {
  return '0x' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

interface MockState {
  accounts: Record<string, Omit<AgentAccount, 'sessions'>>;
  sessions: Record<string, SessionKey[]>;
}

function sessionActive(s: SessionKey): boolean {
  if (s.status === 'revoked') return false;
  if (s.validUntil === 0) return true;
  return s.validUntil >= Date.now();
}

function currentAuthority(target: KeyAuthorityTarget): string {
  const name = String(target.name || '');
  const team = target.team ? String(target.team) : undefined;
  return team ? `${team}:${name}` : name;
}

function loadMockState(): MockState {
  try {
    if (existsSync(statePath())) return JSON.parse(readFileSync(statePath(), 'utf8')) as MockState;
  } catch {
    /* ignore malformed legacy state */
  }
  return { accounts: {}, sessions: {} };
}

export function legacyMockAuthorityReport(targets: KeyAuthorityTarget[]): LegacyKeyAuthority[] {
  const st = loadMockState();
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
      source: 'mock-key-provider',
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

export class MockKeyProvider implements KeyProvider {
  private state: MockState = { accounts: {}, sessions: {} };

  constructor() {
    this.load();
  }

  capabilities(): KeyCapabilities {
    return { provider: 'mock', chainId: MOCK_CHAIN_ID, chainLabel: 'Base Sepolia (mock)', live: false };
  }

  private load(): void {
    try {
      if (existsSync(statePath())) this.state = JSON.parse(readFileSync(statePath(), 'utf8')) as MockState;
    } catch {
      this.state = { accounts: {}, sessions: {} };
    }
  }
  private save(): void {
    try {
      mkdirSync(configDir(resolveConfigPath()), { recursive: true, mode: 0o700 });
      writeFileSync(statePath(), JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  /** Recompute session status from expiry on read. validUntil===0 = until revoked. */
  private withStatus(s: SessionKey): SessionKey {
    if (s.status === 'revoked') return s;
    if (s.validUntil === 0) return { ...s, status: 'active' }; // never expires
    return { ...s, status: s.validUntil < Date.now() ? 'expired' : 'active' };
  }

  private assemble(agent: string): AgentAccount {
    const base = this.state.accounts[agent];
    const sessions = (this.state.sessions[agent] ?? []).map((s) => this.withStatus(s));
    const fallback = {
      agent,
      ensName: agentEnsName(agent),
      smartAccount: mockAddr(`safe:${agent}`),
      owner: MOCK_OWNER,
      deployed: false,
      chainId: MOCK_CHAIN_ID,
      status: 'draft' as const,
    };
    if (!base) return { ...fallback, sessions };
    return {
      ...fallback,
      ...base,
      ensName: base.ensName || fallback.ensName,
      status: base.status ?? (base.deployed ? 'active' : 'draft'),
      sessions,
    };
  }

  async listAccounts(agents: string[]): Promise<AgentAccount[]> {
    return agents.map((a) => this.assemble(a));
  }

  async ensureAccount(agent: string, owner = MOCK_OWNER): Promise<AgentAccount> {
    if (!this.state.accounts[agent]) {
      this.state.accounts[agent] = {
        agent,
        ensName: agentEnsName(agent),
        smartAccount: mockAddr(`safe:${agent}`),
        owner,
        deployed: false,
        chainId: MOCK_CHAIN_ID,
        status: 'draft',
      };
      this.save();
    }
    return this.assemble(agent);
  }

  async deployAccount(agent: string): Promise<AgentAccount> {
    const acct = await this.ensureAccount(agent);
    if (acct.status === 'revoked') throw new Error('Restore root-controlled authority before deploying this account.');
    this.state.accounts[agent] = { ...this.state.accounts[agent]!, deployed: true, status: 'active', revokedAt: undefined };
    this.save();
    return this.assemble(agent);
  }

  async issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey> {
    const account = await this.ensureAccount(agent);
    if (!account.deployed || account.status !== 'active') {
      throw new Error('Agent Safe must be deployed and active before issuing autonomous authority.');
    }
    const now = Date.now();
    const id = `sess_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const key: SessionKey = {
      id,
      agent,
      address: mockAddr(`session:${agent}:${id}`),
      scope,
      createdAt: now,
      validUntil: ttlMs > 0 ? now + ttlMs : 0, // 0 = until revoked
      status: 'active',
    };
    (this.state.sessions[agent] ??= []).push(key);
    this.save();
    return key;
  }

  async revokeSession(agent: string, sessionId: string): Promise<void> {
    const list = this.state.sessions[agent] ?? [];
    const s = list.find((x) => x.id === sessionId);
    if (s) {
      s.status = 'revoked';
      this.save();
    }
  }

  async revokeAccount(agent: string): Promise<AgentAccount> {
    const account = await this.ensureAccount(agent);
    const revokedAt = Date.now();
    this.state.accounts[agent] = { ...this.state.accounts[agent]!, status: 'revoked', revokedAt };
    for (const session of this.state.sessions[agent] ?? []) {
      if (session.status === 'active') session.status = 'revoked';
    }
    this.save();
    return { ...account, status: 'revoked', revokedAt, sessions: (this.state.sessions[agent] ?? []).map((s) => this.withStatus(s)) };
  }

  async restoreAccount(agent: string): Promise<AgentAccount> {
    const account = await this.ensureAccount(agent);
    this.state.accounts[agent] = {
      ...this.state.accounts[agent]!,
      status: account.deployed ? 'active' : 'draft',
      revokedAt: undefined,
    };
    this.save();
    return this.assemble(agent);
  }
}

let singleton: KeyProvider | null = null;
/** The active key provider (mock today; Safe4337 once wired). */
export function getKeyProvider(): KeyProvider {
  if (!singleton) singleton = new MockKeyProvider();
  return singleton;
}
