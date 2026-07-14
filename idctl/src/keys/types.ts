/**
 * Agent key-management model: agent.bittrees.eth controls one Safe smart
 * account per agent. Agents act through scoped, revocable, time-boxed session
 * authority; the root Safe retains recovery and revocation authority.
 */

export const ROOT_AGENT_SAFE_ENS = 'agent.bittrees.eth';
export const ROOT_AGENT_SAFE_ADDRESS = '0x8A6445277b81b9dC27ef248aB25b53e6b255Cfb8';

export type AgentAccountStatus = 'draft' | 'active' | 'revoked';

/** Normalize a fleet agent name into its reserved ENS label. */
export function agentEnsLabel(agent: string): string {
  const unscoped = String(agent).trim().split(':').pop() ?? '';
  const label = unscoped
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63);
  if (!label) throw new Error('Agent name cannot produce a valid ENS label.');
  return label;
}

export function agentEnsName(agent: string): string {
  return `${agentEnsLabel(agent)}.${ROOT_AGENT_SAFE_ENS}`;
}

export interface SessionScope {
  /** Human label, e.g. "skill-publish", "registry-write". */
  label: string;
  /** Allowed target contract addresses ('*' = any). */
  targets: string[];
  /** Max native-token spend over the session lifetime, in wei (string). */
  spendLimitWei: string;
}

export type SessionStatus = 'active' | 'expired' | 'revoked';

export interface SessionKey {
  id: string;
  agent: string;
  /** The session signer address the agent uses to act. */
  address: string;
  scope: SessionScope;
  createdAt: number;
  /** Expiry (ms epoch); after this the key is invalid. */
  validUntil: number;
  status: SessionStatus;
}

export interface AgentAccount {
  agent: string;
  /** Canonical public identity controlled by the root Safe. */
  ensName: string;
  /** The agent's Safe smart-account address (counterfactual until deployed). */
  smartAccount: string;
  /** The root Safe with recovery and authority-revocation control. */
  owner: string;
  /** Whether the Safe is deployed on-chain (vs counterfactual). */
  deployed: boolean;
  chainId: number;
  status: AgentAccountStatus;
  revokedAt?: number;
  sessions: SessionKey[];
}

export interface KeyCapabilities {
  provider: 'mock' | 'safe-4337';
  chainId: number;
  /** Human label for the active chain, e.g. "Base Sepolia (mock)". */
  chainLabel: string;
  /** Whether the provider can actually deploy/broadcast (false for mock). */
  live: boolean;
}

export interface KeyAuthorityTarget {
  name: string;
  team?: string;
}

export interface LegacyKeyAuthority {
  agent: string;
  currentAuthorities: string[];
  source: 'mock-key-provider' | 'tauri-localStorage';
  account: boolean;
  deployed: boolean;
  totalSessions: number;
  activeSessions: number;
  nonExpiringSessions: number;
  note: string;
}

export interface KeyProvider {
  capabilities(): KeyCapabilities;
  /** All known agent accounts (creates nothing). */
  listAccounts(agents: string[]): Promise<AgentAccount[]>;
  /** Ensure an account exists for the agent (deterministic), returning it. */
  ensureAccount(agent: string, owner?: string): Promise<AgentAccount>;
  /** Mark the agent's Safe as deployed on-chain. */
  deployAccount(agent: string): Promise<AgentAccount>;
  /** Issue a scoped, expiring session key for the agent. */
  issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey>;
  /** Revoke a session key. */
  revokeSession(agent: string, sessionId: string): Promise<void>;
  /** Revoke every agent session while preserving the root-owned Safe. */
  revokeAccount(agent: string): Promise<AgentAccount>;
  /** Restore a previously revoked account under root authority. */
  restoreAccount(agent: string): Promise<AgentAccount>;
}

/** Preset scopes offered in the issue-session wizard. */
export const SCOPE_PRESETS: SessionScope[] = [
  { label: 'registry-write', targets: ['*'], spendLimitWei: '0' },
  { label: 'skill-publish', targets: ['*'], spendLimitWei: '10000000000000000' /* 0.01 */ },
  { label: 'payments', targets: ['*'], spendLimitWei: '100000000000000000' /* 0.1 */ },
  { label: 'full (no spend cap)', targets: ['*'], spendLimitWei: '0' },
];

/**
 * TTL options (ms) offered in the issue-session wizard. `ms: 0` is the sentinel
 * for a non-expiring key — it stays active until explicitly revoked (stored as
 * validUntil: 0). The provider and views treat validUntil===0 as "until revoked".
 */
export const NO_EXPIRY_MS = 0;
export const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 3600_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 604_800_000 },
  { label: '30 days', ms: 2_592_000_000 },
  { label: 'Until revoked', ms: NO_EXPIRY_MS },
];
