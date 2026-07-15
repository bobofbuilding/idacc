/**
 * Agent key-management model: agent.bittrees.eth controls one Safe smart
 * account per agent. Agents act through scoped, revocable authority; the root
 * Safe retains recovery and revocation authority. Expiry is only advertised
 * when the active provider can enforce it on-chain.
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
  /** Allowed contract function signatures, for example transfer(address,uint256). */
  functions?: string[];
  /** Max native-token spend over the session lifetime, in wei. Zero disables native value. */
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
  /** Latest root-Safe proposal awaiting or completing on-chain execution. */
  pendingOperation?: PreparedKeyOperation;
}

export type KeyOperationKind = 'deploy' | 'provision' | 'issue' | 'rotate' | 'revoke' | 'revoke-account' | 'restore';
export type KeyOperationStatus = 'prepared' | 'submitted' | 'executed' | 'failed' | 'expired';

export interface KeyOperationCall {
  to: string;
  data: string;
  value: string;
}

export interface KeyOperationSummary {
  id: string;
  kind: KeyOperationKind;
  chainId: number;
  status: KeyOperationStatus;
  createdAt: number;
  submittedAt?: number;
  completedAt?: number;
  submissionId?: string;
  error?: string;
}

/** Public transaction plan prepared for atomic submission by the connected root Safe. */
export interface PreparedKeyOperation extends KeyOperationSummary {
  agent: string;
  rootSafe: string;
  smartAccount: string;
  authorityModule: string;
  signerAddress?: string;
  revokedSignerAddresses?: string[];
  roleKey?: string;
  calls: KeyOperationCall[];
  scope?: SessionScope;
  validUntil?: number;
  previousSessionId?: string;
  expiresAt: number;
  digest: string;
}

export interface KeyCapabilities {
  provider: 'mock' | 'safe-roles';
  chainId: number;
  /** Human label for the active chain, e.g. "Base Sepolia (mock)". */
  chainLabel: string;
  /** Whether the provider can actually deploy/broadcast (false for mock). */
  live: boolean;
  /** Concrete provider implementation revision used by proposal evidence. */
  providerRevision?: string;
  /** Active on-chain authority model; mock providers must omit this. */
  authorityModel?: 'zodiac-roles-v2';
  /** Asset classes checked before authority revocation. */
  assetInspection?: 'none' | 'native-only' | 'full';
  /** Pinned, independently verified production module deployment evidence. */
  moduleSet?: {
    name: string;
    version: string;
    authorityModule: string;
    artifacts: string[];
    verified: boolean;
  };
}

export type KeyReadinessStatus = 'pass' | 'warn' | 'block';

export interface KeyReadinessCheck {
  id: string;
  label: string;
  status: KeyReadinessStatus;
  detail: string;
  remediation?: string;
}

/** Main-process evidence required before IDACC may prepare live Safe changes. */
export interface KeyProductionReadiness {
  ready: boolean;
  checkedAt: number;
  chainId: number;
  rootSafe: string;
  provider: KeyCapabilities['provider'];
  checks: KeyReadinessCheck[];
}

export type AssetGuardStatus = 'clear' | 'assets-present' | 'unknown';

/** Asset evidence checked before disabling an agent's autonomous authority. */
export interface AssetGuardReport {
  status: AssetGuardStatus;
  checkedAt: number;
  chainId: number;
  safeAddress: string;
  nativeBalanceWei?: string;
  tokenCount?: number;
  erc20Count?: number;
  nftCount?: number;
  source: 'mock' | 'rpc' | 'indexer';
  message: string;
}

export interface ProvisionedAgentAuthority {
  account: AgentAccount;
  session: SessionKey;
  reused: boolean;
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
  deployAccount(agent: string): Promise<AgentAccount | PreparedKeyOperation>;
  /** Deploy the Safe and install its initial scoped authority as one proposal. */
  provisionAccount(agent: string, scope: SessionScope, ttlMs: number): Promise<ProvisionedAgentAuthority | PreparedKeyOperation>;
  /** Issue scoped authority; expiry semantics are provider-specific. */
  issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<SessionKey | PreparedKeyOperation>;
  /** Atomically authorize a replacement session and revoke the prior grant. */
  rotateSession(agent: string, sessionId: string, scope: SessionScope, ttlMs: number): Promise<SessionKey | PreparedKeyOperation>;
  /** Revoke a session key. */
  revokeSession(agent: string, sessionId: string): Promise<void | PreparedKeyOperation>;
  /** Inspect native/token holdings before account-level authority changes. */
  inspectAssets(agent: string): Promise<AssetGuardReport>;
  /** Revoke every agent session while preserving the root-owned Safe. */
  revokeAccount(agent: string): Promise<AgentAccount | PreparedKeyOperation>;
  /** Restore a previously revoked account under root authority. */
  restoreAccount(agent: string): Promise<AgentAccount | PreparedKeyOperation>;
}

/** Preset scopes offered in the issue-session wizard. */
export const SCOPE_PRESETS: SessionScope[] = [
  { label: 'registry-write', targets: [], functions: [], spendLimitWei: '0' },
  { label: 'skill-publish', targets: [], functions: [], spendLimitWei: '0' },
  { label: 'payments-readonly', targets: [], functions: [], spendLimitWei: '0' },
  { label: 'full (disabled)', targets: [], functions: [], spendLimitWei: '0' },
];

/**
 * TTL options retained for provider compatibility. Zodiac Roles v2 does not
 * enforce wall-clock expiry, so the live provider exposes only "Until revoked"
 * and refuses to advertise finite TTLs as an on-chain security property.
 */
export const NO_EXPIRY_MS = 0;
export const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 3600_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 604_800_000 },
  { label: '30 days', ms: 2_592_000_000 },
  { label: 'Until revoked', ms: NO_EXPIRY_MS },
];
