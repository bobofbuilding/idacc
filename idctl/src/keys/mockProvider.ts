/**
 * MockKeyProvider — simulates the Safe-account + scoped-authority model locally
 * so the Keys UX is fully testable with no bundler/testnet. State persists to
 * ~/.config/idctl/keys-mock.json so it survives across runs (realistic UX).
 * Addresses are deterministic sha256-derived stand-ins (clearly not real keys).
 *
 * Swap this for an attested SafeRolesKeyProvider (same interface) to go live —
 * the views never change.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { configDir, resolveConfigPath } from '../settings/paths.ts';
import {
  ROOT_AGENT_SAFE_ADDRESS,
  agentEnsName,
  type AssetGuardReport,
  type AgentAccount,
  type KeyAuthorityTarget,
  type KeyCapabilities,
  type KeyProvider,
  type LegacyKeyAuthority,
  type ProvisionedAgentAuthority,
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
    return { provider: 'mock', chainId: MOCK_CHAIN_ID, chainLabel: 'Base Sepolia (mock)', live: false, assetInspection: 'none' };
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

  private newSession(agent: string, scope: SessionScope, ttlMs: number): SessionKey {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || scope.spendLimitWei === '0' || scope.label.toLowerCase().includes('full')) {
      throw new Error('Session authority must be finite, scoped, and spend-capped.');
    }
    const now = Date.now();
    const id = `sess_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    return {
      id,
      agent,
      address: mockAddr(`session:${agent}:${id}`),
      scope,
      createdAt: now,
      validUntil: now + ttlMs,
      status: 'active',
    };
  }

  async provisionAccount(agent: string, scope: SessionScope, ttlMs: number): Promise<ProvisionedAgentAuthority> {
    const existing = this.assemble(agent);
    if (existing.status === 'revoked') throw new Error('Restore root-controlled authority before provisioning this account.');
    const active = existing.sessions.find((session) => sessionActive(session));
    if (existing.deployed && active) return { account: existing, session: active, reused: true };
    const account = this.state.accounts[agent] ?? {
      agent,
      ensName: agentEnsName(agent),
      smartAccount: mockAddr(`safe:${agent}`),
      owner: MOCK_OWNER,
      deployed: false,
      chainId: MOCK_CHAIN_ID,
      status: 'draft' as const,
    };
    this.state.accounts[agent] = { ...account, deployed: true, status: 'active', revokedAt: undefined };
    const session = this.newSession(agent, scope, ttlMs);
    (this.state.sessions[agent] ??= []).push(session);
    this.save();
    return { account: this.assemble(agent), session, reused: false };
  }

  async issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey> {
    const account = await this.ensureAccount(agent);
    if (!account.deployed || account.status !== 'active') {
      throw new Error('Agent Safe must be deployed and active before issuing autonomous authority.');
    }
    const key = this.newSession(agent, scope, ttlMs);
    (this.state.sessions[agent] ??= []).push(key);
    this.save();
    return key;
  }

  async rotateSession(agent: string, sessionId: string, scope: SessionScope, ttlMs: number): Promise<SessionKey> {
    const account = this.assemble(agent);
    if (!account.deployed || account.status !== 'active') throw new Error('Agent Safe must be deployed and active before rotating authority.');
    const current = (this.state.sessions[agent] ?? []).find((session) => session.id === sessionId);
    if (!current || !sessionActive(current)) throw new Error('The session selected for rotation is no longer active.');
    const replacement = this.newSession(agent, scope, ttlMs);
    (this.state.sessions[agent] ??= []).push(replacement);
    current.status = 'revoked';
    this.save();
    return replacement;
  }

  async inspectAssets(agent: string): Promise<AssetGuardReport> {
    const account = this.assemble(agent);
    return {
      status: 'clear',
      checkedAt: Date.now(),
      chainId: account.chainId,
      safeAddress: account.smartAccount,
      nativeBalanceWei: '0',
      tokenCount: 0,
      source: 'mock',
      message: 'Mock provider only: no live Safe or on-chain assets exist in this lifecycle record.',
    };
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
/** The active key provider (mock today; Safe + Zodiac Roles once wired). */
export function getKeyProvider(): KeyProvider {
  if (!singleton) singleton = new MockKeyProvider();
  return singleton;
}
