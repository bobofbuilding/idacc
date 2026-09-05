import { useEffect, useMemo, useRef, useState } from 'react';
import { call, type FleetStore, type TeamAgent } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import {
  agentEnsName,
  type AgentAccount,
  type AssetGuardReport,
  type KeyAuthorityTarget,
  type KeyCapabilities,
  type PreparedKeyOperation,
  type KeyProductionReadiness,
  type LegacyKeyAuthority,
  type SessionKey,
  type SessionScope,
} from '../../../../idctl/src/keys/types.ts';
import { configuredRootIdentity, defaultRootIdentitySettings, LOCAL_AGENT_IDENTITY_ROOT, type EvmRpcKeySource, type EvmRpcProfile, type RootIdentityStatus } from '../../../../idctl/src/settings/schema.ts';
import { resolveRootSafeProvider, type Eip1193Provider } from '../walletConnect.ts';
import {
  EXECUTION_CHAINS,
  buildWalletSafeTransaction,
  chainByHex,
  contractValidationErrors,
  executionStamp,
  formatExecutionPreview,
  guardedExecutionReady,
  isEthAddress,
  isRootSafeThresholdRepair,
  normalizeChainHex,
  ROOT_SAFE_THRESHOLD_REPAIR_CALLDATA,
  rootIdentityChainHex,
  sameAddress,
  type ContractSimulation,
  type ExecutionChain,
} from '../../shared/signingGuardrails.ts';
import {
  classifyIdentityStandardEvidence,
  identityRegisterNoop,
  registeredIdentityDomain,
} from '../../shared/identityVerification.ts';

type EvidenceState = 'verified' | 'pending' | 'warn' | 'missing' | 'self';
type IdentityAgent = TeamAgent;
type EvmRpcRow = Omit<EvmRpcProfile, 'apiKey' | 'apiKeyEncrypted'> & { keySource: EvmRpcKeySource };
type ContractExecutionState = 'idle' | 'warn' | 'ready' | 'submitted';

interface ControllerProof {
  agent: string;
  wallet: string;
  nonce: string;
  message: string;
  signature: string;
  verifiedAt: number;
  expiresAt: number;
}

interface ReviewRow {
  label: string;
  state: EvidenceState;
  note: string;
}

interface ProcessStep extends ReviewRow {
  id: string;
  action?: 'provision' | 'challenge' | 'verify' | 'provision-authority' | 'issue-key' | 'review-chains' | 'review-standards' | 'refresh';
}

interface MetadataHit {
  path: string;
  value: unknown;
}

interface LiveIdentityEvidence {
  checkedAt: number;
  chainId: number;
  resolver: {
    state: 'verified' | 'mismatch' | 'unbound' | 'missing' | 'unavailable';
    address: string;
    resolvedAddress: string;
    detail: string;
  };
  contracts: Array<{
    address: string;
    state: 'verified' | 'missing' | 'unavailable';
    deployed: boolean;
    detail: string;
  }>;
}

interface BrainControllerLink {
  agent_id?: string;
  agentId?: string;
  role?: string;
  authority_level?: string;
  authorityLevel?: string;
  status?: string;
}

interface BrainController {
  controller_id?: string;
  controllerId?: string;
  scope_user_id?: string;
  type?: string;
  label?: string;
  name?: string;
  primary_wallet?: string;
  primaryWallet?: string;
  status?: string;
  agent_links?: BrainControllerLink[];
  agentLinks?: BrainControllerLink[];
}

type BrainControllerReport = {
  generatedAt?: string;
  route?: string;
  total?: number;
  activeLinks?: number;
  controllers?: BrainController[];
  warnings?: string[];
} | null;

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-';
}

function displayAgentEnsName(agent?: string, ensRoot = LOCAL_AGENT_IDENTITY_ROOT): string {
  if (!agent) return ensRoot;
  try {
    return agentEnsName(agent, ensRoot);
  } catch {
    return `invalid-label.${ensRoot}`;
  }
}

function remaining(validUntil: number): string {
  if (validUntil === 0) return 'until revoked';
  const ms = validUntil - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.round(ms / 3600_000);
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

function timeAgo(ms: number | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function rpcStatusClass(status?: string): string {
  if (status === 'available') return 'ok-text';
  if (status === 'auth-error' || status === 'unreachable') return 'warn-text';
  if (status === 'error') return 'status-error';
  return 'muted';
}

function rpcKeyLabel(source: EvmRpcKeySource): string {
  if (source === 'encrypted') return 'linked';
  if (source === 'config') return 'configured';
  if (source === 'env') return 'env';
  return 'none';
}

function rpcMatchesExecutionChain(rpc: EvmRpcRow, chain: ExecutionChain): boolean {
  const label = `${rpc.id} ${rpc.network}`.toLowerCase();
  const hasChainId = new RegExp(`(?:^|[^0-9])${chain.chainId}(?:$|[^0-9])`).test(label);
  const hasChainHex = new RegExp(`(?:^|[^a-z0-9])${chain.hex.toLowerCase()}(?:$|[^a-z0-9])`).test(label);
  if (hasChainId || hasChainHex) return true;

  const hasBase = /(?:^|[^a-z])base(?:$|[^a-z])/.test(label);
  const hasEthereum = /(?:^|[^a-z])(?:ethereum|eth)(?:$|[^a-z])/.test(label);
  const hasSepolia = /(?:^|[^a-z])sepolia(?:$|[^a-z])/.test(label);
  if (chain.chainId === 84532) return hasBase && hasSepolia;
  if (chain.chainId === 11155111) return hasSepolia && !hasBase;
  if (chain.chainId === 8453) return hasBase && !hasSepolia;
  return hasEthereum && !hasSepolia && !hasBase;
}

function preferredRpc(rpcs: EvmRpcRow[]): EvmRpcRow | undefined {
  return [...rpcs].sort((a, b) => {
    const aAvailable = a.lastRequest?.status === 'available' ? 1 : 0;
    const bAvailable = b.lastRequest?.status === 'available' ? 1 : 0;
    return bAvailable - aAvailable || (b.lastRequest?.at ?? 0) - (a.lastRequest?.at ?? 0);
  })[0];
}

function safeStatusForChain(account: AgentAccount | undefined, chain: ExecutionChain): { state: EvidenceState; note: string } {
  if (!account?.smartAccount) return { state: 'missing', note: 'no Safe account record' };
  if (account.chainId !== chain.chainId) {
    return {
      state: 'pending',
      note: `deployment status unknown on this chain (known only for chain ${account.chainId})`,
    };
  }
  return {
    state: account.deployed ? 'verified' : 'warn',
    note: account.deployed ? 'deployed' : 'counterfactual; not deployed',
  };
}

function identityValue(
  a: { idchain_domain?: string | null; ows_wallet?: string | null; ows_address?: string | null; metadata?: unknown },
  key: 'idchain_domain' | 'ows_wallet' | 'ows_address',
): string {
  const meta = a.metadata as { idchain_domain?: unknown; ows_wallet?: unknown; ows_address?: unknown } | undefined;
  const direct = key === 'idchain_domain' ? a.idchain_domain : key === 'ows_wallet' ? a.ows_wallet : a.ows_address;
  const value = direct ?? meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function providerWalletFromMetadata(metadata: unknown): string {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const providers = meta.providers && typeof meta.providers === 'object' ? meta.providers as Record<string, unknown> : {};
  const skillmesh = providers.skillmesh && typeof providers.skillmesh === 'object' ? providers.skillmesh as Record<string, unknown> : {};
  const candidates = [
    meta.provider_wallet_address,
    meta.providerWalletAddress,
    skillmesh.address,
    skillmesh.wallet_address,
    skillmesh.walletAddress,
    meta.skillmesh_address,
  ];
  return candidates
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(isEthAddress) ?? '';
}

function metadataObject(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
}

function metadataValueAt(meta: Record<string, unknown>, path: string): unknown {
  let current: unknown = meta;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function hasMetadataValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function firstMetadataHit(meta: Record<string, unknown>, paths: string[]): MetadataHit | undefined {
  for (const path of paths) {
    const value = metadataValueAt(meta, path);
    if (hasMetadataValue(value)) return { path, value };
  }
  return undefined;
}

function metadataHitSource(hit: MetadataHit | undefined): string {
  return hit ? `declared in metadata.${hit.path}` : '';
}

function metadataContractAddresses(agent: Agent | undefined, account: AgentAccount | undefined): string[] {
  const meta = metadataObject(agent?.metadata);
  const paths = [
    'agentRegistry',
    'agent_registry',
    'metadata.metadata_contract',
    'metadataContract',
    'metadata_contract',
    'contractMetadataContract',
    'contract_metadata_contract',
    'metadata.contractMetadata',
    'metadata.contract_metadata',
  ];
  const addresses = new Set<string>();
  if (account?.smartAccount && isEthAddress(account.smartAccount)) addresses.add(account.smartAccount.toLowerCase());
  const collect = (value: unknown) => {
    if (typeof value === 'string' && isEthAddress(value)) addresses.add(value.toLowerCase());
    else if (Array.isArray(value)) value.slice(0, 16).forEach(collect);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).slice(0, 16).forEach(collect);
  };
  for (const path of paths) collect(metadataValueAt(meta, path));
  return [...addresses].slice(0, 8);
}

function controllerWallet(a: Agent | undefined): string {
  if (!a) return '';
  const candidates = [
    identityValue(a, 'ows_address'),
    providerWalletFromMetadata(a.metadata),
    identityValue(a, 'ows_wallet'),
  ];
  return candidates.find(isEthAddress) ?? '';
}

function hasWallet(a: Agent): boolean {
  return Boolean(controllerWallet(a));
}

function agentKey(a: IdentityAgent): string {
  return `${a.team ?? 'default'}:${a.name}`;
}

function legacyAuthorityTarget(authority: string, agents: IdentityAgent[]): IdentityAgent | undefined {
  const sep = authority.indexOf(':');
  if (sep < 0) return undefined;
  const team = authority.slice(0, sep);
  const name = authority.slice(sep + 1);
  return agents.find((a) => (a.team ?? 'default') === team && a.name === name);
}

function uniqueAgents(agents: IdentityAgent[]): IdentityAgent[] {
  const seen = new Set<string>();
  return agents.filter((a) => {
    const key = agentKey(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusLabel(state: EvidenceState): string {
  if (state === 'verified') return 'verified';
  if (state === 'pending') return 'pending';
  if (state === 'warn') return 'needs action';
  if (state === 'self') return 'declared';
  return 'unavailable';
}

function StatusPill({ state }: { state: EvidenceState }) {
  return <span className={`id-pill ${state}`}>{statusLabel(state)}</span>;
}

function statusTone(state: EvidenceState): string {
  if (state === 'verified') return 'ok-text';
  if (state === 'missing') return 'status-error';
  if (state === 'pending' || state === 'self') return 'muted';
  return 'warn-text';
}

function dotTone(state: EvidenceState): string {
  return state === 'verified' ? 'ok' : state === 'missing' ? 'err' : 'warn';
}

function isSignatureLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(value.trim());
}

function proofMatchesWallet(proof: ControllerProof | undefined, wallet: string): boolean {
  return Boolean(proof?.verifiedAt && proof.expiresAt > Date.now() && wallet && proof.wallet.toLowerCase() === wallet.toLowerCase());
}

function isUnsafeScope(scope: SessionScope | undefined): boolean {
  return !scope
    || scope.label.toLowerCase().includes('full')
    || scope.spendLimitWei !== '0'
    || !scope.targets.length
    || scope.targets.some((target) => target === '*' || !isEthAddress(target))
    || !(scope.functions ?? []).length;
}

function isUnsafeTtl(ttl: { label: string; ms: number } | undefined): boolean {
  return !ttl || ttl.ms !== 0;
}

function providerStatusLabel(caps: KeyCapabilities | null): string {
  if (!caps) return 'Checking key provider...';
  return caps.live ? `${caps.chainLabel} live provider` : `${caps.chainLabel} mock provider; no on-chain authority is created.`;
}

function sessionAuthority(session: SessionKey): { label: string; tone: 'safe' | 'broad' | 'critical' }[] {
  const badges: { label: string; tone: 'safe' | 'broad' | 'critical' }[] = [];
  const anyTarget = session.scope.targets.includes('*');
  badges.push(anyTarget ? { label: 'Any contract', tone: 'broad' } : { label: `${session.scope.targets.length} target${session.scope.targets.length === 1 ? '' : 's'}`, tone: 'safe' });
  badges.push(session.scope.spendLimitWei === '0' ? { label: 'No native spend', tone: 'safe' } : { label: 'Spend policy', tone: 'safe' });
  if (session.validUntil === 0) badges.push({ label: 'No expiry', tone: 'critical' });
  return badges;
}

function identityStandardRows(
  agent: Agent | undefined,
  domain: string,
  wallet: string,
  acct: AgentAccount | undefined,
  liveEvidence?: LiveIdentityEvidence | null,
): ReviewRow[] {
  if (!agent) {
    const states = classifyIdentityStandardEvidence({
      hasAgent: false,
      hasDomain: false,
      hasWallet: false,
      hasSmartAccount: false,
      ensBindingVerified: false,
      ensip24Declared: false,
      erc8004Declared: false,
      erc8048Declared: false,
      erc8049Declared: false,
      b20Declared: false,
    });
    return [
      { label: 'ENS address binding', state: states.ensBinding, note: 'select an agent' },
      { label: 'ENSIP-24 arbitrary data', state: states.ensip24, note: 'select an agent' },
      { label: 'ERC-8004', state: states.erc8004, note: 'select an agent' },
      { label: 'ERC-8048 / ERC-721T', state: states.erc8048, note: 'select an agent' },
      { label: 'ERC-8049', state: states.erc8049, note: 'select an agent' },
      { label: 'B20 extraMetadata', state: states.b20, note: 'select an agent' },
    ];
  }

  const meta = metadataObject(agent.metadata);
  const ensip24 = firstMetadataHit(meta, [
    'ensip24',
    'ensip_24',
    'ens.data',
    'ens.resolverData',
    'resolver.data',
    'resolverData',
    'ensip24Data',
    'dataResolver',
  ]);
  const erc8004 = firstMetadataHit(meta, [
    'erc8004',
    'erc_8004',
    'agentRegistry',
    'agent_registry',
    'agentId',
    'agent_id',
    'agentURI',
    'agent_uri',
    'metadata.agentURI',
    'metadata.agent_uri',
    'metadataURI',
    'metadata_uri',
    'registrationURI',
    'registration_uri',
    'agentWallet',
    'agent_wallet',
  ]);
  const erc8048 = firstMetadataHit(meta, [
    'erc8048',
    'erc_8048',
    'erc721t',
    'erc_721t',
    'tokenURI',
    'token_uri',
    'uri',
    'tokenId',
    'token_id',
    'metadata.context',
    'metadata.endpoint',
    'metadata.endpoints',
    'metadata.endpoints.mcp',
    'metadata.endpoints.a2a',
    'metadata.endpoints.web',
    'metadata.endpoints.x402',
    'metadata.address',
    'metadata.addresses',
    'metadata.metadata_contract',
    'metadataContract',
    'metadata_contract',
  ]);
  const erc8049 = firstMetadataHit(meta, [
    'erc8049',
    'erc_8049',
    'contractMetadata',
    'contract_metadata',
    'contractMetadataContract',
    'contract_metadata_contract',
    'contractMetadataKeys',
    'contract_metadata_keys',
    'metadata.contractMetadata',
    'metadata.contract_metadata',
    'metadata.ens_name',
  ]);
  const b20 = firstMetadataHit(meta, [
    'b20',
    'b20.extraMetadata',
    'b20.extra_metadata',
    'b20ExtraMetadata',
    'extraMetadata',
    'extra_metadata',
    'base.b20',
    'base.b20.extraMetadata',
    'token.extraMetadata',
  ]);
  const states = classifyIdentityStandardEvidence({
    hasAgent: true,
    hasDomain: Boolean(domain),
    hasWallet: Boolean(wallet),
    hasSmartAccount: Boolean(acct?.smartAccount),
    ensBindingVerified: liveEvidence?.resolver.state === 'verified',
    ensip24Declared: Boolean(ensip24),
    erc8004Declared: Boolean(erc8004),
    erc8048Declared: Boolean(erc8048),
    erc8049Declared: Boolean(erc8049),
    b20Declared: Boolean(b20),
  });

  return [
    {
      label: 'ENS address binding',
      state: states.ensBinding,
      note: liveEvidence?.resolver.detail
        ? liveEvidence.resolver.detail
        : domain
          ? `${domain}; live resolver address check pending`
          : 'no ENS/idchain name is declared',
    },
    {
      label: 'ENSIP-24 arbitrary data',
      state: states.ensip24,
      note: ensip24
        ? `${metadataHitSource(ensip24)}; draft data(bytes32,string) evidence remains unverified`
        : domain
          ? `${domain}; no ENSIP-24 arbitrary-data record is declared`
          : 'no arbitrary-data resolver evidence',
    },
    {
      label: 'ERC-8004',
      state: states.erc8004,
      note: erc8004
        ? `${metadataHitSource(erc8004)}; agentWallet/agentURI should be verified onchain`
        : wallet
          ? `controller wallet ${shortAddr(wallet)} can map to agentWallet; agent registry metadata not reported`
          : 'no agent registry, agentURI, agentId, or agentWallet evidence',
    },
    {
      label: 'ERC-8048 / ERC-721T',
      state: states.erc8048,
      note: erc8048
        ? `${metadataHitSource(erc8048)}; token-level context/endpoints remain untrusted until fetched and verified`
        : 'no token-level metadata, ERC-721T context, endpoint, address, or metadata_contract evidence',
    },
    {
      label: 'ERC-8049',
      state: states.erc8049,
      note: erc8049
        ? `${metadataHitSource(erc8049)}; contractMetadata(string) read pending`
        : acct?.smartAccount
          ? `account ${shortAddr(acct.smartAccount)} has no contract-level onchain metadata evidence yet`
          : 'no account or contractMetadata evidence',
    },
    {
      label: 'B20 extraMetadata',
      state: states.b20,
      note: b20
        ? `${metadataHitSource(b20)}; extraMetadata values are acknowledged but not rendered raw`
        : 'no Base B20 issuer extraMetadata evidence reported for this agent',
    },
  ];
}

function reviewRows(
  agent: Agent | undefined,
  acct: AgentAccount | undefined,
  domain: string,
  wallet: string,
  controllerVerified: boolean,
  liveEvidence: LiveIdentityEvidence | null,
): ReviewRow[] {
  const active = acct?.sessions.filter((s) => s.status === 'active') ?? [];
  const nonExpiring = active.filter((s) => s.validUntil === 0).length;
  return [
    {
      label: 'Controller proof',
      state: controllerVerified ? 'verified' : wallet ? 'warn' : 'missing',
      note: controllerVerified ? 'fresh wallet challenge recorded' : wallet ? 'sign a challenge before privileged actions' : 'provision a controller wallet first',
    },
    {
      label: 'Public identity',
      state: liveEvidence?.resolver.state === 'verified' ? 'verified' : domain && wallet ? 'self' : 'missing',
      note: liveEvidence?.resolver.detail ?? (domain && wallet ? `${domain} and ${shortAddr(wallet)} are Manager-declared; verify the live resolver binding.` : 'name or wallet is missing'),
    },
    {
      label: 'Safe account',
      state: acct?.deployed ? 'verified' : acct?.smartAccount ? 'warn' : 'missing',
      note: acct?.smartAccount ? `${shortAddr(acct.smartAccount)} ${acct.deployed ? 'deployed' : 'not deployed'}` : 'no account found',
    },
    {
      label: 'Session keys',
      state: nonExpiring ? 'warn' : active.length ? 'verified' : 'pending',
      note: nonExpiring ? `${nonExpiring} non-expiring grant needs review` : `${active.length} active grant${active.length === 1 ? '' : 's'}`,
    },
    {
      label: 'Live trust checks',
      state: 'pending',
      note: agent ? 'ENS address binding is checked separately from draft metadata-standard attestations' : 'select an agent',
    },
  ];
}

function activeSessionSort(a: SessionKey, b: SessionKey): number {
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  return b.createdAt - a.createdAt;
}

function identityAgentStamp(a: IdentityAgent): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    team: a.team ?? 'default',
    status: a.status ?? '',
    runtime: a.runtime ?? '',
    model: a.model ?? '',
    domain: identityValue(a, 'idchain_domain'),
    wallet: controllerWallet(a),
  });
}

function brainControllerLinks(c: BrainController): BrainControllerLink[] {
  return c.agent_links ?? c.agentLinks ?? [];
}

function brainLinkAgentId(link: BrainControllerLink): string {
  return String(link.agent_id ?? link.agentId ?? '').trim();
}

function brainControllerName(c: BrainController | undefined): string {
  if (!c) return 'none';
  return c.label || c.name || c.controller_id || c.controllerId || 'unnamed controller';
}

function brainControllerForAgent(
  report: BrainControllerReport,
  agent: IdentityAgent | undefined,
  duplicateNames: Set<string>,
): { state: EvidenceState; note: string; controller?: BrainController; ambiguous?: boolean } {
  if (!agent) return { state: 'missing', note: 'select an agent' };
  if (!report) return { state: 'warn', note: 'Brain /controllers unavailable; Brain Agents controller fallbacks are not verified' };
  const controllers = report.controllers ?? [];
  const team = agent.team ?? 'default';
  const strongIds = new Set([
    agent.id,
    `${team}/${agent.name}`,
    `${team}:${agent.name}`,
    `agent:${team}/${agent.name}`,
    `agent:${team}:${agent.name}`,
  ].filter(Boolean));
  const bareIds = new Set([agent.name, `agent:${agent.name}`]);
  const strong = controllers.find((c) => brainControllerLinks(c).some((link) => strongIds.has(brainLinkAgentId(link)) && (link.status ?? 'active') === 'active'));
  if (strong) return { state: 'verified', note: `Brain controller linked: ${brainControllerName(strong)}`, controller: strong };
  const bare = controllers.find((c) => brainControllerLinks(c).some((link) => bareIds.has(brainLinkAgentId(link)) && (link.status ?? 'active') === 'active'));
  if (bare) {
    if (duplicateNames.has(agent.name)) {
      return { state: 'warn', note: `Bare Brain controller link is ambiguous for duplicate agent name ${agent.name}`, controller: bare, ambiguous: true };
    }
    return { state: 'self', note: `Brain controller linked by bare agent id: ${brainControllerName(bare)}`, controller: bare };
  }
  return { state: 'warn', note: `No active Brain controller link for ${team}/${agent.name}` };
}

function sessionStamp(s: SessionKey): string {
  return JSON.stringify({
    id: s.id,
    address: s.address,
    status: s.status,
    validUntil: s.validUntil,
    scope: s.scope.label,
    spendLimitWei: s.scope.spendLimitWei,
  });
}
function accountStamp(a: AgentAccount | null | undefined): string {
  return JSON.stringify(a ? {
    agent: a.agent,
    ensName: a.ensName,
    smartAccount: a.smartAccount,
    owner: a.owner,
    deployed: a.deployed,
    chainId: a.chainId,
    status: a.status,
    revokedAt: a.revokedAt,
    pendingOperation: a.pendingOperation ? `${a.pendingOperation.id}:${a.pendingOperation.status}:${a.pendingOperation.digest}` : '',
    sessions: a.sessions.map(sessionStamp).sort(),
  } : null);
}

export function Identity({ store }: { store: FleetStore }) {
  const [identitySearch, setIdentitySearch] = useState('');
  const [caps, setCaps] = useState<KeyCapabilities | null>(null);
  const [productionReadiness, setProductionReadiness] = useState<KeyProductionReadiness | null>(null);
  const [rootIdentityStatus, setRootIdentityStatus] = useState<RootIdentityStatus>({
    settings: defaultRootIdentitySettings(),
    activeProvider: 'local',
  });
  const [accounts, setAccounts] = useState<Record<string, AgentAccount>>({});
  const [presets, setPresets] = useState<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [scopeIdx, setScopeIdx] = useState(1);
  const [ttlIdx, setTtlIdx] = useState(1);
  const [authorityTargetsInput, setAuthorityTargetsInput] = useState('');
  const [authorityFunctionsInput, setAuthorityFunctionsInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processMsg, setProcessMsg] = useState<string | null>(null);
  const [legacyMsg, setLegacyMsg] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Record<string, ControllerProof>>({});
  const [legacyKeys, setLegacyKeys] = useState<LegacyKeyAuthority[]>([]);
  const [brainControllers, setBrainControllers] = useState<BrainControllerReport>(null);
  const [evmRpcs, setEvmRpcs] = useState<EvmRpcRow[]>([]);
  const [walletInput, setWalletInput] = useState('');
  const [contractAccount, setContractAccount] = useState('');
  const [contractChain, setContractChain] = useState<(typeof EXECUTION_CHAINS)[number]['hex']>('0x1');
  const [providerChain, setProviderChain] = useState('');
  const [contractTo, setContractTo] = useState('');
  const [contractData, setContractData] = useState('0x');
  const [contractValue, setContractValue] = useState('0');
  const [contractConfirmed, setContractConfirmed] = useState(false);
  const [contractBusy, setContractBusy] = useState(false);
  const [contractSimulation, setContractSimulation] = useState<ContractSimulation | null>(null);
  const [contractMessage, setContractMessage] = useState('Connect the root Safe to prepare an agent Safe bootstrap or revocation proposal.');
  const [liveIdentityEvidence, setLiveIdentityEvidence] = useState<LiveIdentityEvidence | null>(null);
  const [identityEvidenceBusy, setIdentityEvidenceBusy] = useState(false);
  const identityEvidenceRequest = useRef(0);

  const identityAgents = useMemo(() => {
    const all = store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: store.team ?? 'default' }));
    const sorted = uniqueAgents(all).sort((a, b) => Number(hasWallet(b)) - Number(hasWallet(a)) || (a.team ?? '').localeCompare(b.team ?? '') || a.name.localeCompare(b.name));
    return sorted;
  }, [store.allAgents, store.agents, store.team]);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of identityAgents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [identityAgents]);
  const authorityTargets = useMemo<KeyAuthorityTarget[]>(() => identityAgents.map((a) => ({ name: a.name, team: a.team ?? 'default' })), [identityAgents]);
  const authorityTargetKey = useMemo(() => authorityTargets.map((a) => `${a.team ?? ''}:${a.name}`).join('|'), [authorityTargets]);
  const accountKeys = useMemo(() => identityAgents.map(agentKey), [identityAgents]);
  const selAgent = (sel ? identityAgents.find((a) => agentKey(a) === sel) : undefined) ?? identityAgents.find(hasWallet) ?? identityAgents[0];
  const selected = selAgent?.name;
  const selectedKey = selAgent ? agentKey(selAgent) : '';
  const acct = selectedKey ? accounts[selectedKey] : undefined;
  const selectedTeam = selAgent?.team;
  const domain = selAgent ? identityValue(selAgent, 'idchain_domain') : '';
  const registeredDomain = registeredIdentityDomain(selAgent);
  const rootIdentity = configuredRootIdentity(rootIdentityStatus.settings);
  const signingRootIdentity = rootIdentityStatus.activeProvider === 'safe-roles' && caps?.live
    ? rootIdentity
    : null;
  const rootEns = rootIdentity?.ensRoot ?? LOCAL_AGENT_IDENTITY_ROOT;
  const rootSafeAddress = rootIdentity?.safeAddress ?? '';
  const canonicalEns = acct?.ensName ?? displayAgentEnsName(selected, rootEns);
  const ensCollision = Boolean(selected && duplicateNames.has(selected));
  const wallet = controllerWallet(selAgent);
  const proof = selectedKey ? proofs[selectedKey] : undefined;
  const controllerVerified = proofMatchesWallet(proof, wallet);
  const activeSessions = useMemo(() => [...(acct?.sessions ?? [])].sort(activeSessionSort), [acct]);
  const activeSessionCount = activeSessions.filter((s) => s.status === 'active').length;
  const safeScopes = useMemo(
    () => (presets?.scopes ?? []).map((scope, idx) => ({ scope, idx })).filter(({ scope }) => !scope.label.toLowerCase().includes('full')),
    [presets],
  );
  const finiteTtls = useMemo(
    () => (presets?.ttls ?? []).map((ttl, idx) => ({ ttl, idx })).filter(({ ttl }) => ttl.ms === 0),
    [presets],
  );
  const selectedScopePreset = presets?.scopes[scopeIdx];
  const issueScope = useMemo<SessionScope | undefined>(() => {
    if (!selectedScopePreset) return undefined;
    return {
      label: selectedScopePreset.label,
      targets: authorityTargetsInput.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
      functions: authorityFunctionsInput.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
      spendLimitWei: '0',
    };
  }, [selectedScopePreset, authorityTargetsInput, authorityFunctionsInput]);
  const issueTtl = presets?.ttls[ttlIdx];
  const productionReady = productionReadiness?.ready === true;
  const issueBlocked = !productionReady || !controllerVerified || acct?.status !== 'active' || isUnsafeScope(issueScope) || isUnsafeTtl(issueTtl);
  const provisionBlocked = !productionReady || !controllerVerified || acct?.status === 'revoked' || isUnsafeScope(issueScope) || isUnsafeTtl(issueTtl);
  const review = useMemo(
    () => reviewRows(selAgent, acct, domain, wallet, controllerVerified, liveIdentityEvidence),
    [selAgent, acct, domain, wallet, controllerVerified, liveIdentityEvidence],
  );
  const standardCoverage = useMemo(
    () => identityStandardRows(selAgent, domain, wallet, acct, liveIdentityEvidence),
    [selAgent, domain, wallet, acct, liveIdentityEvidence],
  );
  const standardVerified = standardCoverage.filter((row) => row.state === 'verified').length;
  const standardDeclared = standardCoverage.filter((row) => row.state === 'self').length;
  const identityEvidenceContracts = useMemo(
    () => metadataContractAddresses(selAgent, acct),
    [selAgent, acct],
  );
  const identityEvidenceSubject = JSON.stringify({
    selectedKey,
    domain,
    wallet,
    smartAccount: acct?.smartAccount ?? '',
    chainId: acct?.chainId ?? rootIdentity?.chainId ?? 1,
    contracts: identityEvidenceContracts,
  });
  const enabledRpcs = useMemo(() => evmRpcs.filter((rpc) => rpc.enabled !== false), [evmRpcs]);
  const availableRpcs = enabledRpcs.filter((rpc) => rpc.lastRequest?.status === 'available');
  const walletInputValid = isEthAddress(walletInput);
  const executionChainRows = useMemo(() => EXECUTION_CHAINS.map((chain) => {
    const matching = evmRpcs.filter((rpc) => rpcMatchesExecutionChain(rpc, chain));
    const rpc = preferredRpc(matching.filter((row) => row.enabled !== false));
    const disabledRpc = preferredRpc(matching.filter((row) => row.enabled === false));
    const safe = safeStatusForChain(acct, chain);
    const rpcState: EvidenceState = !rpc ? 'warn' : rpc.lastRequest?.status === 'available' ? 'verified' : 'warn';
    const rpcNote = rpc
      ? rpc.lastRequest
        ? `${rpc.network}: ${rpc.lastRequest.status}${rpc.lastRequest.blockNumber != null ? ` · block ${rpc.lastRequest.blockNumber.toLocaleString()}` : ''} · checked ${timeAgo(rpc.lastRequest.at)}`
        : `${rpc.network}: configured; not checked`
      : disabledRpc
        ? `${disabledRpc.network}: configured but disabled; unverified`
        : 'No configured RPC; unverified';
    const state: EvidenceState = !wallet
      ? 'missing'
      : safe.state === 'missing'
        ? 'missing'
        : safe.state === 'verified' && rpcState === 'verified'
          ? 'verified'
          : safe.state === 'pending' && rpcState === 'verified'
            ? 'pending'
            : 'warn';
    return { chain, rpc, safe, rpcNote, state };
  }), [acct, evmRpcs, wallet]);
  const keyOperational = Boolean(caps?.live && acct?.deployed && acct.status === 'active' && activeSessionCount > 0);
  const contractStamp = useMemo(
    () => executionStamp(signingRootIdentity, contractChain, contractAccount, contractTo, contractData, contractValue),
    [contractAccount, contractChain, contractData, contractTo, contractValue, signingRootIdentity],
  );
  const contractInputErrors = useMemo(
    () => contractValidationErrors(signingRootIdentity, contractAccount, providerChain, contractChain, contractTo, contractData, contractValue),
    [contractAccount, contractChain, contractData, contractTo, contractValue, providerChain, signingRootIdentity],
  );
  const contractSimulationFresh = Boolean(contractSimulation?.ok && contractSimulation.stamp === contractStamp);
  const thresholdRepairPrepared = isRootSafeThresholdRepair(signingRootIdentity, contractChain, contractTo, contractData, contractValue);
  const contractCanSubmit = (productionReady || thresholdRepairPrepared) && contractInputErrors.length === 0 && contractSimulationFresh && contractConfirmed && !contractBusy;
  const contractPreview = contractSimulation?.stamp === contractStamp
    ? contractSimulation.preview
    : formatExecutionPreview(signingRootIdentity, contractChain, contractAccount, contractTo, contractData, contractValue);
  const contractExecutionState: ContractExecutionState = contractSimulationFresh && contractConfirmed ? 'ready' : contractInputErrors.length ? 'warn' : 'idle';
  const brainSelectedController = useMemo(() => brainControllerForAgent(brainControllers, selAgent, duplicateNames), [brainControllers, selAgent, duplicateNames]);
  const brainControllerMatches = useMemo(
    () => identityAgents.map((agent) => brainControllerForAgent(brainControllers, agent, duplicateNames)),
    [brainControllers, identityAgents, duplicateNames],
  );
  const brainLinkedAgents = brainControllerMatches.filter((match) => match.state === 'verified' || match.state === 'self').length;
  const brainAmbiguousLinks = brainControllerMatches.filter((match) => match.ambiguous).length;
  const brainControllerNeedsReview = !brainControllers || (brainControllers.activeLinks ?? 0) === 0 || brainSelectedController.state === 'warn' || brainAmbiguousLinks > 0;
  const identityProcess = useMemo<ProcessStep[]>(() => {
    const ensState: EvidenceState = ensCollision
      ? 'warn'
      : liveIdentityEvidence?.resolver.state === 'verified'
        ? 'verified'
        : domain && domain.toLowerCase() === canonicalEns.toLowerCase()
          ? 'self'
          : acct?.smartAccount
            ? 'pending'
            : 'missing';
    const liveProvider = caps?.live === true;
    const rootOwnsAccount = Boolean(liveProvider && rootIdentity && acct?.owner && sameAddress(acct.owner, rootSafeAddress));
    return [
      {
        id: 'ens',
        label: 'ENS identity',
        state: ensState,
        note: ensCollision
          ? 'Agent name is duplicated across teams; the ENS label is not unique.'
          : liveIdentityEvidence?.resolver.detail ?? (domain ? `${domain} is declared and must resolve to the selected signer or Safe.` : `${canonicalEns} is reserved for this agent.`),
        action: ensState === 'verified' ? undefined : 'review-standards',
      },
      {
        id: 'signer',
        label: 'Agent signer',
        state: wallet ? 'self' : 'missing',
        note: wallet ? `${shortAddr(wallet)} declared; the signed challenge below verifies control.` : 'Provision the signer used only through scoped Safe authority.',
        action: wallet ? undefined : 'provision',
      },
      {
        id: 'proof',
        label: 'Signer proof',
        state: controllerVerified ? 'verified' : wallet ? 'warn' : 'missing',
        note: controllerVerified ? `Verified until ${new Date(proof!.expiresAt).toLocaleTimeString()}` : wallet ? (proof?.signature ? 'Verify the pasted signer proof.' : 'Start a challenge and sign it with the agent signer.') : 'Agent signer required first.',
        action: controllerVerified || !wallet ? undefined : proof?.signature ? 'verify' : 'challenge',
      },
      {
        id: 'account',
        label: 'Agent Safe',
        state: !liveProvider ? 'warn' : acct?.status === 'revoked' ? 'warn' : acct?.deployed ? 'verified' : acct?.smartAccount ? 'pending' : 'missing',
        note: !liveProvider ? 'Simulation record only; no on-chain Safe has been verified.' : acct?.smartAccount ? `${shortAddr(acct.smartAccount)} ${acct.status === 'revoked' ? 'authority revoked' : acct.deployed ? 'deployed' : 'predicted'}` : 'Create the root-owned agent Safe after signer proof.',
        action: !productionReady || acct?.status === 'revoked' || !controllerVerified || acct?.deployed ? undefined : 'provision-authority',
      },
      {
        id: 'root',
        label: 'Root recovery',
        state: rootOwnsAccount ? 'verified' : 'missing',
        note: rootOwnsAccount ? `${rootEns} controls recovery and revocation.` : liveProvider && rootIdentity ? `Owner must be ${rootSafeAddress}.` : 'This profile is local/mock; no live root ownership is enabled.',
      },
      {
        id: 'authority',
        label: 'Autonomous authority',
        state: !liveProvider ? 'warn' : acct?.status === 'revoked' ? 'warn' : activeSessionCount > 0 ? 'verified' : acct?.deployed ? 'pending' : 'missing',
        note: !liveProvider ? 'Mock grants are test records, not on-chain autonomous authority.' : acct?.status === 'revoked' ? 'All agent authority is disabled; the Safe and audit history are preserved.' : activeSessionCount > 0 ? `${activeSessionCount} active scoped grant${activeSessionCount === 1 ? '' : 's'}` : 'Issue target- and function-scoped authority after deployment.',
        action: productionReady && controllerVerified && acct?.status !== 'revoked' && activeSessionCount === 0 ? 'provision-authority' : undefined,
      },
    ];
  }, [acct, activeSessionCount, canonicalEns, caps?.live, controllerVerified, domain, ensCollision, liveIdentityEvidence, productionReady, proof, rootEns, rootIdentity, rootSafeAddress, wallet]);
  const nextProcessStep = identityProcess.find((step) => step.action && step.state !== 'verified') ?? identityProcess.find((step) => step.action);
  const processReadyCount = identityProcess.filter((step) => step.state === 'verified').length;
  const processReviewCount = identityProcess.filter((step) => step.state === 'warn').length;
  const processState: EvidenceState = processReadyCount === identityProcess.length ? 'verified' : processReviewCount ? 'warn' : 'missing';
  const readinessPercent = Math.round((processReadyCount / identityProcess.length) * 100);
  const brainControllerLabel = brainControllers
    ? `Brain controllers ${brainLinkedAgents}/${identityAgents.length}`
    : 'Brain controllers --';
  const brainControllerTitle = brainControllers
    ? [
      `Route: ${brainControllers.route ?? '/controllers'}`,
      `Controllers: ${brainControllers.total ?? 0}`,
      `Active links: ${brainControllers.activeLinks ?? 0}`,
      `Linked current agents: ${brainLinkedAgents}/${identityAgents.length}`,
      brainAmbiguousLinks ? `Ambiguous bare-name links: ${brainAmbiguousLinks}` : '',
      brainControllers.generatedAt ? `Read: ${brainControllers.generatedAt}` : '',
      ...(brainControllers.warnings ?? []),
    ].filter(Boolean).join('\n')
    : 'Brain /controllers unavailable; Brain Agents controller fallback should not be trusted.';
  function controllerProofValidFor(agent: IdentityAgent): boolean {
    return proofMatchesWallet(proofs[agentKey(agent)], controllerWallet(agent));
  }

  async function freshIdentityAgents(): Promise<IdentityAgent[] | null> {
    const groups = await call<{ team: string; agents: Agent[] }[]>('agents:allTeams', { force: true }).catch(() => null);
    if (groups) return uniqueAgents(groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team }))));
    const ag = await call<Agent[]>('agents').catch(() => null);
    return ag ? uniqueAgents(ag.map((a) => ({ ...a, team: store.team ?? 'default' }))) : null;
  }

  function findFreshIdentityAgent(list: IdentityAgent[], a: IdentityAgent): IdentityAgent | undefined {
    const team = a.team ?? 'default';
    return list.find((x) => (x.team ?? 'default') === team && x.id === a.id)
      ?? list.find((x) => (x.team ?? 'default') === team && x.name === a.name);
  }

  async function ensureSelectedFresh(action: string): Promise<IdentityAgent | null> {
    if (!selAgent) {
      setError('Select an agent first.');
      return null;
    }
    const list = await freshIdentityAgents();
    if (!list) {
      setError(`Could not verify the current agent before ${action}. Refresh and try again.`);
      return null;
    }
    const current = findFreshIdentityAgent(list, selAgent);
    if (!current) {
      setError(`${selectedTeam ?? 'default'}/${selected ?? 'agent'} is no longer in the fleet snapshot. Refreshing Identity.`);
      store.refresh();
      return null;
    }
    if (identityAgentStamp(current) !== identityAgentStamp(selAgent)) {
      setError(`${selectedTeam ?? 'default'}/${selected ?? 'agent'} changed before ${action}. Refreshing Identity; review the current row before retrying.`);
      store.refresh();
      return null;
    }
    return current;
  }

  async function latestAccountFor(key: string): Promise<AgentAccount | null> {
    const list = await call<AgentAccount[]>('keys:list', [key]).catch(() => null);
    if (!list) return null;
    const next = list[0] ?? null;
    setAccounts((prev) => next ? { ...prev, [next.agent]: next } : prev);
    return next;
  }

  async function reload() {
    if (accountKeys.length === 0) return;
    try {
      const list = await call<AgentAccount[]>('keys:list', accountKeys);
      setAccounts(Object.fromEntries(list.map((a) => [a.agent, a])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load key accounts');
    }
  }

  useEffect(() => {
    call<RootIdentityStatus>('rootIdentity:get').then((status) => {
      setRootIdentityStatus(status);
      const configured = configuredRootIdentity(status.settings);
      if (configured) setContractChain(rootIdentityChainHex(configured) as (typeof EXECUTION_CHAINS)[number]['hex']);
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load root identity'));
    call<KeyCapabilities>('keys:caps').then(setCaps).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load key capabilities'));
    call<KeyProductionReadiness>('keys:productionReadiness', false).then(setProductionReadiness).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load production readiness'));
    call<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] }>('keys:presets').then(setPresets).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load key presets'));
  }, []);

  useEffect(() => {
    let live = true;
    call<EvmRpcRow[]>('evmRpc:list')
      .then((rows) => {
        if (live) setEvmRpcs(rows);
      })
      .catch(() => {
        if (live) setEvmRpcs([]);
      });
    return () => {
      live = false;
    };
  }, [store.lastUpdated]);

  useEffect(() => {
    let live = true;
    call<BrainControllerReport>('brain:controllerReport')
      .then((report) => {
        if (live) setBrainControllers(report);
      })
      .catch(() => {
        if (live) setBrainControllers(null);
      });
    return () => {
      live = false;
    };
  }, [store.lastUpdated]);

  useEffect(() => {
    void reload();
  }, [accountKeys.join('|')]);

  useEffect(() => {
    identityEvidenceRequest.current += 1;
    setLiveIdentityEvidence(null);
    setIdentityEvidenceBusy(false);
  }, [identityEvidenceSubject]);

  useEffect(() => {
    if (!authorityTargets.length) {
      setLegacyKeys([]);
      return;
    }
    let live = true;
    call<LegacyKeyAuthority[]>('keys:legacyAuthority', authorityTargets)
      .then((rows) => {
        if (live) setLegacyKeys(rows);
      })
      .catch(() => {
        if (live) setLegacyKeys([]);
      });
    return () => {
      live = false;
    };
  }, [authorityTargetKey]);

  useEffect(() => {
    const nextScope = safeScopes[0]?.idx;
    if (nextScope !== undefined && !(safeScopes.some(({ idx }) => idx === scopeIdx))) setScopeIdx(nextScope);
    const nextTtl = finiteTtls[0]?.idx;
    if (nextTtl !== undefined && !(finiteTtls.some(({ idx }) => idx === ttlIdx))) setTtlIdx(nextTtl);
  }, [presets, safeScopes, finiteTtls, scopeIdx, ttlIdx]);

  useEffect(() => {
    if (!selected || !wallet || controllerVerified) return;
    let live = true;
    call<ControllerProof | null>('identity:controllerStatus', selected, wallet, selectedTeam)
      .then((status) => {
        if (live && status) setProofs((prev) => ({ ...prev, [selectedKey]: status }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [selected, selectedKey, wallet, selectedTeam, controllerVerified]);

  async function act(method: string, ...args: unknown[]) {
    setError(null);
    setBusy(true);
    try {
      await call(method, ...args);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${method} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function finalizeSubmittedOperation(operationId: string, submissionId: string, provider: Eip1193Provider): Promise<boolean> {
    try {
      const status = await provider.request<{
        status?: number;
        receipts?: Array<{ transactionHash?: string; status?: string }>;
      }>({ method: 'wallet_getCallsStatus', params: [submissionId] });
      const receipts = Array.isArray(status?.receipts) ? status.receipts : [];
      const hashes = receipts
        .filter((receipt) => receipt.status === '0x1' && /^0x[0-9a-f]{64}$/i.test(receipt.transactionHash ?? ''))
        .map((receipt) => receipt.transactionHash as string);
      if (Number(status?.status) === 200 && hashes.length) {
        await call('keys:finalizeOperation', operationId, hashes);
        return true;
      }
    } catch {
      // Some wallets expose sendCalls before calls-status. The submitted state
      // remains visible and can be refreshed after the wallet gains support.
    }
    return false;
  }

  async function submitPreparedKeyOperation(operation: PreparedKeyOperation): Promise<void> {
    const connection = await resolveRootSafeProvider(true, signingRootIdentity?.safeAddress ?? '');
    if (!connection) throw new Error(`Connect ${rootEns} through WalletConnect before submitting this root-Safe proposal.`);
    const provider = connection.provider;
    const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' });
    const rootSafe = accounts.find((value) => isEthAddress(value)) ?? '';
    if (!sameAddress(rootSafe, operation.rootSafe)) throw new Error(`Connected account must be ${operation.rootSafe}.`);
    const requiredChain = `0x${operation.chainId.toString(16)}`;
    let chain = normalizeChainHex(await provider.request<unknown>({ method: 'eth_chainId' }));
    if (chain !== requiredChain) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: requiredChain }] });
      chain = normalizeChainHex(await provider.request<unknown>({ method: 'eth_chainId' }));
    }
    if (chain !== requiredChain) throw new Error(`Wallet remained on ${chain}; proposal requires ${requiredChain}.`);
    if (operation.expiresAt <= Date.now()) throw new Error('Prepared proposal expired before wallet submission. Prepare it again.');
    setProcessMsg(`Submitting ${operation.calls.length} atomic Safe/Zodiac calls through ${connection.source}...`);
    let submission: unknown;
    try {
      submission = await provider.request({
        method: 'wallet_sendCalls',
        params: [{
          from: rootSafe,
          chainId: requiredChain,
          atomicRequired: true,
          calls: operation.calls,
        }],
      });
    } catch (error) {
      throw new Error(`The connected root Safe must support atomic wallet_sendCalls; no partial lifecycle was submitted. ${error instanceof Error ? error.message : String(error)}`);
    }
    const submissionId = typeof submission === 'string'
      ? submission
      : (submission && typeof submission === 'object' && 'id' in submission ? String((submission as { id: unknown }).id) : '');
    if (!submissionId) throw new Error('WalletConnect did not return a batch submission id. No lifecycle state was recorded.');
    await call('keys:recordSubmission', operation.id, submissionId, operation.chainId, rootSafe);
    const finalized = await finalizeSubmittedOperation(operation.id, submissionId, provider);
    setProcessMsg(finalized
      ? `${operation.kind} executed and verified on-chain for ${operation.smartAccount}.`
      : `${operation.kind} proposal submitted. Identity remains pending until the root Safe executes it and receipts verify.`);
  }

  async function prepareAndSubmit(method: string, ...args: unknown[]) {
    setError(null);
    setBusy(true);
    try {
      const operation = await call<PreparedKeyOperation>(method, ...args);
      if (!operation?.id || !Array.isArray(operation.calls) || !operation.calls.length) {
        throw new Error('Live key provider did not return a guarded root-Safe operation.');
      }
      await submitPreparedKeyOperation(operation);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${method} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function syncPendingKeyOperation() {
    const pending = acct?.pendingOperation;
    if (!pending) return;
    setError(null);
    setBusy(true);
    try {
      if (pending.status === 'prepared') {
        await submitPreparedKeyOperation(pending);
      } else if (pending.status === 'submitted' && pending.submissionId) {
        const connection = await resolveRootSafeProvider(true, signingRootIdentity?.safeAddress ?? '');
        if (!connection) throw new Error('Reconnect the root Safe to check this proposal.');
        const finalized = await finalizeSubmittedOperation(pending.id, pending.submissionId, connection.provider);
        setProcessMsg(finalized ? 'Root-Safe proposal executed and verified on-chain.' : 'Root-Safe proposal is still awaiting execution or receipts.');
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pending proposal sync failed.');
    } finally {
      setBusy(false);
    }
  }

  async function identityAction(action: 'register' | 'provision') {
    const fresh = await ensureSelectedFresh(action === 'register' ? 'registering identity' : 'provisioning wallet');
    if (!fresh) return;
    const team = fresh.team ?? 'default';
    const freshWallet = controllerWallet(fresh);
    const freshRegistration = identityRegisterNoop(fresh);
    if (action === 'register' && freshRegistration.noop) {
      setError(null);
      setProcessMsg(`${team}/${fresh.name} is already registered as ${freshRegistration.domain}; no transaction or model request was sent.`);
      return;
    }
    if (action === 'provision' && freshWallet) {
      setError(`${team}/${fresh.name} already has controller wallet ${shortAddr(freshWallet)}. Refresh Identity and review the current row before provisioning a replacement.`);
      store.refresh();
      return;
    }
    if (action === 'register' && !controllerProofValidFor(fresh)) {
      setError('Register identity requires a fresh signed controller-wallet challenge.');
      return;
    }
    if (!window.confirm(`${action === 'register' ? 'Register identity' : 'Provision wallet'} for ${team}/${fresh.name}?\n\n${action === 'register' ? 'This writes the public identity binding for the selected controller wallet.' : 'This creates or binds a controller wallet for the agent.'}`)) return;
    const afterConfirm = await ensureSelectedFresh(action === 'register' ? 'registering identity after review' : 'provisioning wallet after review');
    if (!afterConfirm) return;
    const afterWallet = controllerWallet(afterConfirm);
    const afterRegistration = identityRegisterNoop(afterConfirm);
    if (action === 'register' && afterRegistration.noop) {
      setError(null);
      setProcessMsg(`${afterConfirm.team ?? 'default'}/${afterConfirm.name} was registered during review as ${afterRegistration.domain}; no duplicate transaction was sent.`);
      store.refresh();
      return;
    }
    if (action === 'provision' && afterWallet) {
      setError(`${afterConfirm.team ?? 'default'}/${afterConfirm.name} gained controller wallet ${shortAddr(afterWallet)} after review. Refresh Identity and use the verified controller flow before making account changes.`);
      store.refresh();
      return;
    }
    if (action === 'register' && !controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before registering identity.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await call<{ noop?: boolean; domain?: string }>(
        action === 'register' ? 'identity:register' : 'wallet:provision',
        afterConfirm.name,
        afterConfirm.team ?? 'default',
      );
      if (action === 'register') {
        setProcessMsg(result?.noop
          ? `${afterConfirm.team ?? 'default'}/${afterConfirm.name} is already registered as ${result.domain ?? 'its current identity'}; no duplicate transaction was sent.`
          : `Registration submitted for ${afterConfirm.team ?? 'default'}/${afterConfirm.name}. Refreshing public identity evidence.`);
      }
      store.refresh();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function verifyLiveIdentity() {
    if (!selAgent) return;
    const requestId = ++identityEvidenceRequest.current;
    setIdentityEvidenceBusy(true);
    setError(null);
    setProcessMsg('Reading public resolver and deployed contract evidence…');
    try {
      const evidence = await call<LiveIdentityEvidence>('identity:verifyEvidence', {
        domain,
        controllerWallet: wallet,
        smartAccount: acct?.smartAccount ?? '',
        chainId: acct?.chainId ?? rootIdentity?.chainId ?? 1,
        contractAddresses: identityEvidenceContracts,
      });
      if (identityEvidenceRequest.current !== requestId) return;
      setLiveIdentityEvidence(evidence);
      const deployed = evidence.contracts.filter((row) => row.deployed).length;
      setProcessMsg(`Live identity evidence refreshed: resolver ${evidence.resolver.state}; ${deployed}/${evidence.contracts.length} declared contract${evidence.contracts.length === 1 ? '' : 's'} deployed.`);
    } catch (err) {
      if (identityEvidenceRequest.current !== requestId) return;
      setLiveIdentityEvidence(null);
      setError(err instanceof Error ? err.message : 'Live identity verification failed.');
    } finally {
      if (identityEvidenceRequest.current === requestId) setIdentityEvidenceBusy(false);
    }
  }

  async function bindExistingWallet() {
    const address = walletInput.trim();
    if (!isEthAddress(address)) {
      setError('Enter a valid 20-byte 0x controller wallet address.');
      return;
    }
    const fresh = await ensureSelectedFresh('binding controller wallet');
    if (!fresh) return;
    if (controllerWallet(fresh)) {
      setError(`${fresh.team ?? 'default'}/${fresh.name} already has a controller wallet. Refresh Identity and use the signed controller flow before changing it.`);
      store.refresh();
      return;
    }
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Bind existing controller wallet for ${team}/${fresh.name}?\n\n${address}\n\nThis records the public address only. You will sign a challenge with that wallet before privileged actions unlock.`)) return;
    const afterConfirm = await ensureSelectedFresh('binding controller wallet after review');
    if (!afterConfirm) return;
    if (controllerWallet(afterConfirm)) {
      setError(`${afterConfirm.team ?? 'default'}/${afterConfirm.name} gained a controller wallet after review. Refresh Identity and review the current row before changing it.`);
      store.refresh();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await call('identity:bindWallet', afterConfirm.name, address, afterConfirm.team ?? 'default');
      setWalletInput('');
      store.refresh();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to bind controller wallet');
    } finally {
      setBusy(false);
    }
  }

  async function startChallenge() {
    const fresh = await ensureSelectedFresh('starting controller challenge');
    if (!fresh) return;
    const currentWallet = controllerWallet(fresh);
    if (!currentWallet) return;
    const key = agentKey(fresh);
    setError(null);
    setBusy(true);
    try {
      const challenge = await call<ControllerProof>('identity:controllerChallenge', fresh.name, currentWallet, fresh.team);
      setProofs((prev) => ({ ...prev, [key]: challenge }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start controller challenge');
    } finally {
      setBusy(false);
    }
  }

  function updateSignature(signature: string) {
    if (!selected || !proof) return;
    setProofs((prev) => ({
      ...prev,
      [selectedKey]: { ...proof, signature, verifiedAt: 0 },
    }));
  }

  async function verifyControllerProof() {
    const fresh = await ensureSelectedFresh('verifying controller proof');
    if (!fresh) return;
    const key = agentKey(fresh);
    const currentProof = proofs[key];
    const currentWallet = controllerWallet(fresh);
    if (!currentProof) return;
    if (!isSignatureLike(currentProof.signature)) {
      setError('Paste a 0x-prefixed 65-byte signature from the controller wallet.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const verified = await call<ControllerProof>('identity:controllerVerify', fresh.name, currentWallet, currentProof.signature, fresh.team);
      setProofs((prev) => ({ ...prev, [key]: verified }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify controller signature');
    } finally {
      setBusy(false);
    }
  }

  async function issueSession() {
    if (!productionReady) {
      setError('Session issuance is blocked until production readiness passes.');
      return;
    }
    const fresh = await ensureSelectedFresh('issuing session key');
    if (!presets || !fresh) {
      setError(controllerVerified ? 'Choose a concrete contract and function policy.' : 'Issue session key requires a signed controller-wallet challenge first.');
      return;
    }
    const reviewedTtlIdx = ttlIdx;
    const reviewedScope = issueScope;
    const reviewedTtl = presets.ttls[reviewedTtlIdx];
    if (!reviewedScope || !reviewedTtl || !controllerProofValidFor(fresh) || isUnsafeScope(reviewedScope) || isUnsafeTtl(reviewedTtl)) {
      setError(controllerProofValidFor(fresh) ? 'Choose concrete contracts and function signatures; native value remains disabled.' : 'Issue session key requires a signed controller-wallet challenge first.');
      return;
    }
    const team = fresh.team ?? 'default';
    const reviewedAccount = await latestAccountFor(agentKey(fresh));
    if (!window.confirm(`Issue session key for ${team}/${fresh.name}?\n\nScope: ${reviewedScope.label}\nDuration: ${reviewedTtl.label}\n\nThis creates live target- and function-scoped authority that remains active until explicitly revoked.`)) return;
    const afterConfirm = await ensureSelectedFresh('issuing session key after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before issuing a key.');
      return;
    }
    const latestAccount = await latestAccountFor(agentKey(afterConfirm));
    if (accountStamp(latestAccount) !== accountStamp(reviewedAccount)) {
      setError('Account or session state changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await prepareAndSubmit('keys:issue', afterConfirm.name, reviewedScope, reviewedTtl.ms, afterConfirm.team ?? 'default');
  }

  async function provisionAuthority() {
    if (!productionReady) {
      setError('Live Safe changes are blocked until every production readiness blocker is resolved. Run the production preflight and review its remediation steps.');
      return;
    }
    const fresh = await ensureSelectedFresh('provisioning agent Safe and authority');
    if (!presets || !fresh) return;
    if (duplicateNames.has(fresh.name)) {
      setError(`Cannot provision ${displayAgentEnsName(fresh.name, rootEns)} while its ENS label is ambiguous across teams.`);
      return;
    }
    const reviewedTtlIdx = ttlIdx;
    const reviewedScope = issueScope;
    const reviewedTtl = presets.ttls[reviewedTtlIdx];
    if (!reviewedScope || !reviewedTtl || !controllerProofValidFor(fresh) || isUnsafeScope(reviewedScope) || isUnsafeTtl(reviewedTtl)) {
      setError(controllerProofValidFor(fresh) ? 'Choose concrete contracts and function signatures; native value remains disabled.' : 'Provisioning requires a fresh signer proof.');
      return;
    }
    const reviewedAccount = await latestAccountFor(agentKey(fresh));
    if (reviewedAccount?.status === 'revoked') {
      setError('Restore root-controlled authority before provisioning a replacement session.');
      return;
    }
    if (reviewedAccount?.deployed && reviewedAccount.sessions.some((session) => session.status === 'active')) {
      setError('This Safe already has active authority. Rotate an existing grant or issue an additional scoped key.');
      return;
    }
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Provision ${displayAgentEnsName(fresh.name, rootEns)} for ${team}/${fresh.name}?\n\nPolicy: ${reviewedScope.label}\nDuration: ${reviewedTtl.label}\n\nThe live provider bundles Safe deployment, policy-module setup, and initial public session authority into one root-Safe proposal. The private session key remains in the agent runtime.`)) return;
    const afterConfirm = await ensureSelectedFresh('provisioning authority after review');
    if (!afterConfirm || !controllerProofValidFor(afterConfirm)) {
      setError('Signer proof expired or changed after confirmation. Sign a fresh challenge and retry.');
      return;
    }
    const latestAccount = await latestAccountFor(agentKey(afterConfirm));
    if (accountStamp(latestAccount) !== accountStamp(reviewedAccount)) {
      setError('Account or session state changed after confirmation. Identity refreshed the latest state; review and retry.');
      return;
    }
    await prepareAndSubmit('keys:provision', afterConfirm.name, reviewedScope, reviewedTtl.ms, afterConfirm.team ?? 'default');
  }

  async function rotateSession(session: SessionKey) {
    if (!productionReady) {
      setError('Authority rotation is blocked until production readiness passes.');
      return;
    }
    const fresh = await ensureSelectedFresh('rotating session authority');
    if (!presets || !fresh) return;
    const reviewedTtlIdx = ttlIdx;
    const reviewedScope = issueScope;
    const reviewedTtl = presets.ttls[reviewedTtlIdx];
    if (!reviewedScope || !reviewedTtl || !controllerProofValidFor(fresh) || isUnsafeScope(reviewedScope) || isUnsafeTtl(reviewedTtl)) {
      setError(controllerProofValidFor(fresh) ? 'Choose concrete contracts and function signatures; native value remains disabled.' : 'Rotation requires a fresh signer proof.');
      return;
    }
    const reviewedAccount = await latestAccountFor(agentKey(fresh));
    const current = reviewedAccount?.sessions.find((row) => row.id === session.id);
    if (!current || current.status !== 'active' || sessionStamp(current) !== sessionStamp(session)) {
      setError('Session authority changed before rotation. Identity refreshed the latest state; review and retry.');
      return;
    }
    if (!window.confirm(`Rotate authority for ${reviewedAccount!.ensName}?\n\nNew policy: ${reviewedScope.label}\nNew duration: ${reviewedTtl.label}\n\nThe replacement public key is authorized before the old grant is revoked in the same live Safe proposal. Safe ownership and assets do not change.`)) return;
    const afterConfirm = await ensureSelectedFresh('rotating authority after review');
    if (!afterConfirm || !controllerProofValidFor(afterConfirm)) {
      setError('Signer proof expired or changed after confirmation. Sign a fresh challenge and retry.');
      return;
    }
    const latestAccount = await latestAccountFor(agentKey(afterConfirm));
    if (accountStamp(latestAccount) !== accountStamp(reviewedAccount)) {
      setError('Account or session state changed after confirmation. Identity refreshed the latest state; review and retry.');
      return;
    }
    await prepareAndSubmit('keys:rotate', afterConfirm.name, current.id, reviewedScope, reviewedTtl.ms, afterConfirm.team ?? 'default');
  }

  async function revokeSession(s: SessionKey) {
    if (!productionReady) {
      setError('Session revocation is blocked until production readiness passes.');
      return;
    }
    const fresh = await ensureSelectedFresh('revoking session key');
    if (!fresh) return;
    const key = agentKey(fresh);
    const latest = await latestAccountFor(key);
    const current = latest?.sessions.find((row) => row.id === s.id);
    if (!current || current.status !== 'active' || sessionStamp(current) !== sessionStamp(s)) {
      setError('Session key changed before revoke. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    const team = fresh.team ?? 'default';
    if (!window.confirm(`Revoke session key ${shortAddr(current.address)}?\n\nThis disables the active delegated key for ${team}/${fresh.name}.`)) return;
    const afterConfirm = await ensureSelectedFresh('revoking session key after review');
    if (!afterConfirm) return;
    if (!controllerProofValidFor(afterConfirm)) {
      setError('Controller proof expired or changed after confirmation. Sign a fresh challenge before revoking.');
      return;
    }
    const latestAfterConfirm = await latestAccountFor(agentKey(afterConfirm));
    const currentAfterConfirm = latestAfterConfirm?.sessions.find((row) => row.id === current.id);
    if (!currentAfterConfirm || currentAfterConfirm.status !== 'active' || sessionStamp(currentAfterConfirm) !== sessionStamp(current)) {
      setError('Session key changed after confirmation. Identity has refreshed the latest account state; review and retry.');
      return;
    }
    await prepareAndSubmit('keys:revoke', afterConfirm.name, currentAfterConfirm.id, afterConfirm.team ?? 'default');
  }

  async function revokeAgentAuthority() {
    if (!productionReady) {
      setError('Agent authority revocation is blocked until production readiness passes.');
      return;
    }
    const fresh = await ensureSelectedFresh('revoking agent authority');
    if (!fresh) return;
    const latest = await latestAccountFor(agentKey(fresh));
    if (!latest || latest.status === 'revoked') {
      setError('Agent authority is already revoked or no account exists. Identity has refreshed the current state.');
      return;
    }
    const active = latest.sessions.filter((session) => session.status === 'active').length;
    let assets: AssetGuardReport;
    try {
      assets = await call<AssetGuardReport>('keys:assetGuard', fresh.name, fresh.team ?? 'default');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Asset inspection failed; authority revocation was not submitted.');
      return;
    }
    if (assets.status === 'unknown') {
      setError(`Authority revocation blocked until assets can be inspected. ${assets.message}`);
      return;
    }
    const assetWarning = assets.status === 'assets-present'
      ? `\n\nASSET WARNING\nNative balance: ${assets.nativeBalanceWei ?? 'unknown'} wei\nDetected tokens: ${assets.tokenCount ?? 'unknown'}\nAssets remain at this Safe and recoverable by ${rootEns}; they are not deleted or transferred.`
      : `\n\nAsset check: ${assets.message}`;
    if (!window.confirm(`Revoke all autonomous authority for ${latest.ensName}?\n\nSafe: ${latest.smartAccount}\nActive grants revoked: ${active}${assetWarning}\n\nThe Safe address, ownership, ENS identity, assets, and audit history are preserved. New scoped authority can be issued later.`)) return;
    const afterConfirm = await latestAccountFor(agentKey(fresh));
    if (!afterConfirm || accountStamp(afterConfirm) !== accountStamp(latest)) {
      setError('Account authority changed after review. Identity has refreshed the latest state; review and retry.');
      return;
    }
    await prepareAndSubmit('keys:revokeAccount', fresh.name, fresh.team ?? 'default', assets.status === 'assets-present');
  }

  async function restoreAgentAuthority() {
    if (!productionReady) {
      setError('Agent authority restoration is blocked until production readiness passes.');
      return;
    }
    const fresh = await ensureSelectedFresh('restoring agent authority');
    if (!fresh) return;
    const latest = await latestAccountFor(agentKey(fresh));
    if (!latest || latest.status !== 'revoked') {
      setError('Only a revoked agent account can be restored. Identity has refreshed the current state.');
      return;
    }
    if (!window.confirm(`Restore ${latest.ensName} under root authority?\n\nThis reopens the account lifecycle but does not restore revoked session grants. New scoped authority must be issued separately.`)) return;
    const afterConfirm = await latestAccountFor(agentKey(fresh));
    if (!afterConfirm || accountStamp(afterConfirm) !== accountStamp(latest)) {
      setError('Account authority changed after review. Identity has refreshed the latest state; review and retry.');
      return;
    }
    await act('keys:restoreAccount', fresh.name, fresh.team ?? 'default');
    setProcessMsg(`${latest.ensName} restored under ${rootEns}; issue new scoped authority when ready.`);
  }

  async function copyLegacyAuthority(authority: string) {
    try {
      await navigator.clipboard.writeText(authority);
      setLegacyMsg(`Copied scoped authority ${authority}.`);
    } catch {
      setLegacyMsg(`Copy failed. Scoped authority: ${authority}`);
    }
  }

  async function refreshIdentityProcess() {
    setError(null);
    setProcessMsg('Refreshing identity checks...');
    setBusy(true);
    try {
      await Promise.allSettled([
        reload(),
        call<RootIdentityStatus>('rootIdentity:get').then(setRootIdentityStatus),
        call<KeyCapabilities>('keys:caps').then(setCaps),
        call<KeyProductionReadiness>('keys:productionReadiness', true).then(setProductionReadiness),
        call<{ scopes: SessionScope[]; ttls: { label: string; ms: number }[] }>('keys:presets').then(setPresets),
        call<EvmRpcRow[]>('evmRpc:list').then(setEvmRpcs),
        call<BrainControllerReport>('brain:controllerReport').then(setBrainControllers),
        authorityTargets.length
          ? call<LegacyKeyAuthority[]>('keys:legacyAuthority', authorityTargets).then(setLegacyKeys)
          : Promise.resolve(setLegacyKeys([])),
      ]);
      store.refresh();
      setProcessMsg('Readiness checks refreshed.');
    } finally {
      setBusy(false);
    }
  }

  async function connectContractWallet() {
    setContractBusy(true);
    setContractMessage('Requesting root Safe connection...');
    try {
      const connection = await resolveRootSafeProvider(true, signingRootIdentity?.safeAddress ?? '');
      if (!connection) {
        setContractMessage('No root Safe provider is connected. Configure WalletConnect in Settings or use an injected wallet.');
        return;
      }
      const provider = connection.provider;
      const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' });
      const chain = await provider.request<unknown>({ method: 'eth_chainId' });
      const account = accounts.find((row) => typeof row === 'string' && isEthAddress(row)) ?? '';
      const chainHex = normalizeChainHex(chain);
      setContractAccount(account);
      setProviderChain(chainHex);
      setContractSimulation(null);
      setContractConfirmed(false);
      const errors = contractValidationErrors(signingRootIdentity, account, chainHex, contractChain, contractTo, contractData, contractValue);
      setContractMessage(errors.length ? errors.join(' ') : `Root Safe connection is ready through ${connection.source}.`);
    } catch (err) {
      setContractMessage(err instanceof Error ? err.message : 'Root Safe connection failed.');
    } finally {
      setContractBusy(false);
    }
  }

  async function switchContractChain() {
    setContractBusy(true);
    setContractMessage(`Requesting switch to ${chainByHex(contractChain)?.name ?? contractChain}...`);
    try {
      const connection = await resolveRootSafeProvider(false, signingRootIdentity?.safeAddress ?? '');
      if (!connection) {
        setContractMessage('Connect the root Safe before switching chains.');
        return;
      }
      const provider = connection.provider;
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: contractChain }] });
      const chain = await provider.request<unknown>({ method: 'eth_chainId' });
      const chainHex = normalizeChainHex(chain);
      setProviderChain(chainHex);
      setContractSimulation(null);
      setContractConfirmed(false);
      setContractMessage(chainHex === contractChain.toLowerCase() ? 'Wallet chain matches the guarded transaction.' : 'Wallet chain did not switch; review wallet/Safe state.');
    } catch (err) {
      setContractMessage(err instanceof Error ? err.message : 'Chain switch was rejected or failed.');
    } finally {
      setContractBusy(false);
    }
  }

  async function simulateContractExecution() {
    setContractBusy(true);
    setContractMessage('Simulating the root Safe proposal...');
    try {
      const connection = await resolveRootSafeProvider(false, signingRootIdentity?.safeAddress ?? '');
      if (!connection) {
        setContractMessage('Connect the root Safe before simulation.');
        return;
      }
      const provider = connection.provider;
      const accounts = await provider.request<string[]>({ method: 'eth_accounts' });
      const chain = await provider.request<unknown>({ method: 'eth_chainId' });
      const account = accounts.find((row) => typeof row === 'string' && isEthAddress(row)) ?? contractAccount;
      const chainHex = normalizeChainHex(chain);
      setContractAccount(account);
      setProviderChain(chainHex);
      const errors = contractValidationErrors(signingRootIdentity, account, chainHex, contractChain, contractTo, contractData, contractValue);
      if (errors.length) {
        setContractSimulation(null);
        setContractMessage(errors.join(' '));
        return;
      }
      const tx = buildWalletSafeTransaction(signingRootIdentity, contractTo, contractData, contractValue);
      if (!tx) {
        setContractSimulation(null);
        setContractMessage('Value must be a non-negative integer in wei.');
        return;
      }
      const requiredChainId = chainByHex(contractChain)?.chainId;
      if (!requiredChainId) throw new Error('Choose a supported chain before simulation.');
      const result = await call<string>('evmRpc:read', requiredChainId, 'eth_call', [tx, 'latest']);
      const stamp = executionStamp(signingRootIdentity, contractChain, account, contractTo, contractData, contractValue);
      setContractSimulation({
        ok: true,
        stamp,
        message: 'Simulation passed.',
        preview: `${formatExecutionPreview(signingRootIdentity, contractChain, account, contractTo, contractData, contractValue)}\n\neth_call result:\n${String(result)}`,
      });
      setContractConfirmed(false);
      setContractMessage('Simulation passed. Review the preview and confirm before submit.');
    } catch (err) {
      const stamp = executionStamp(signingRootIdentity, contractChain, contractAccount, contractTo, contractData, contractValue);
      const message = err instanceof Error ? err.message : 'Simulation failed.';
      setContractSimulation({
        ok: false,
        stamp,
        message,
        preview: `${formatExecutionPreview(signingRootIdentity, contractChain, contractAccount, contractTo, contractData, contractValue)}\n\neth_call error:\n${message}`,
      });
      setContractConfirmed(false);
      setContractMessage(`Simulation failed: ${message}`);
    } finally {
      setContractBusy(false);
    }
  }

  async function submitContractExecution() {
    const thresholdRepair = isRootSafeThresholdRepair(signingRootIdentity, contractChain, contractTo, contractData, contractValue);
    if (!productionReady && !thresholdRepair) {
      setContractMessage('Root Safe proposal submission is blocked until production readiness passes.');
      return;
    }
    setContractBusy(true);
    setContractMessage('Checking guarded submit state...');
    try {
      const connection = await resolveRootSafeProvider(false, signingRootIdentity?.safeAddress ?? '');
      if (!connection) {
        setContractMessage('Connect the root Safe before submitting a proposal.');
        return;
      }
      const provider = connection.provider;
      const accounts = await provider.request<string[]>({ method: 'eth_accounts' });
      const chain = await provider.request<unknown>({ method: 'eth_chainId' });
      const account = accounts.find((row) => typeof row === 'string' && isEthAddress(row)) ?? contractAccount;
      const chainHex = normalizeChainHex(chain);
      setContractAccount(account);
      setProviderChain(chainHex);
      const errors = contractValidationErrors(signingRootIdentity, account, chainHex, contractChain, contractTo, contractData, contractValue);
      if (errors.length) {
        setContractMessage(errors.join(' '));
        return;
      }
      const readiness = guardedExecutionReady({
        rootIdentity: signingRootIdentity,
        account,
        providerChain: chainHex,
        requiredChain: contractChain,
        to: contractTo,
        data: contractData,
        valueWei: contractValue,
        simulation: contractSimulation,
        confirmed: contractConfirmed,
      });
      if (!readiness.ok) {
        setContractMessage(readiness.errors.join(' '));
        return;
      }
      const purpose = thresholdRepair
        ? 'Raise the existing root Safe from threshold 1 to threshold 2. This exact self-call is the only proposal allowed before production readiness passes.'
        : 'Use this boundary only to provision or revoke an agent Safe.';
      if (!window.confirm(`Submit root Safe proposal through ${rootEns}?\n\n${purpose}\nTarget: ${contractTo.trim()}\nValue: ${contractValue.trim()} wei\nChain: ${chainByHex(contractChain)?.name ?? contractChain}\n\nThe root Safe must still approve before anything is broadcast.`)) return;
      const hash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [readiness.tx],
      });
      setContractMessage(`Root Safe submitted proposal ${hash}. Agent runtime transactions remain on the agent Safe session-key path.`);
      setContractConfirmed(false);
    } catch (err) {
      setContractMessage(err instanceof Error ? err.message : 'Root Safe proposal failed or was rejected.');
    } finally {
      setContractBusy(false);
    }
  }

  function prepareRootThresholdRepair() {
    if (!signingRootIdentity) {
      setContractMessage(rootIdentityStatus.error
        ? `Live signing remains disabled: ${rootIdentityStatus.error}`
        : 'Configure and explicitly enable this profile root identity in Settings before preparing a Safe repair.');
      return;
    }
    setContractChain(rootIdentityChainHex(signingRootIdentity) as (typeof EXECUTION_CHAINS)[number]['hex']);
    setContractTo(signingRootIdentity.safeAddress);
    setContractData(ROOT_SAFE_THRESHOLD_REPAIR_CALLDATA);
    setContractValue('0');
    setContractSimulation(null);
    setContractConfirmed(false);
    setContractMessage(`Threshold repair prepared. Connect ${rootEns} on Ethereum mainnet, simulate, review, and submit the Safe self-call. Both owners must approve the resulting 2-of-2 policy going forward.`);
  }

  function revealIdentitySection(id: string) {
    const section = document.getElementById(id);
    let ancestor = section?.parentElement;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function runProcessAction(action = nextProcessStep?.action) {
    switch (action) {
      case 'provision':
        await identityAction('provision');
        break;
      case 'challenge':
        await startChallenge();
        break;
      case 'verify':
        await verifyControllerProof();
        break;
      case 'provision-authority':
        await provisionAuthority();
        break;
      case 'issue-key':
        await issueSession();
        break;
      case 'review-chains':
        revealIdentitySection('identity-chain-access');
        setProcessMsg('Review chain routes below. Add or probe Agent RPCs from Settings if routes are missing.');
        break;
      case 'review-standards':
        revealIdentitySection('identity-standards');
        setProcessMsg('Review metadata standards below. Missing standards need manager metadata or future guarded onchain reads.');
        break;
      default:
        await refreshIdentityProcess();
        break;
    }
  }

  return (
    <div className="view identity-view">
      <header className="view-head">
        <div>
          <h1>Identity & Keys</h1>
          <div className="muted small">Optional wallet setup for agents. Review the next step below; ordinary local work does not require a wallet.</div>
        </div>
        <div className="identity-head-status">
          <span className={caps?.live ? 'ok-text' : 'warn-text'}>{providerStatusLabel(caps)}</span>
          <span className={brainControllerNeedsReview ? 'warn-text' : 'ok-text'} title={brainControllerTitle}>{brainControllerLabel}</span>
        </div>
      </header>

      <div className="cols identity-shell">
        <section className="card identity-agents">
          <h3>Agents</h3><input className="composer-input" aria-label="Search agent identities" placeholder="Find an agent…" value={identitySearch} onChange={(event) => setIdentitySearch(event.target.value)} />
          {identityAgents.filter((a) => `${a.name} ${a.team ?? ''}`.toLowerCase().includes(identitySearch.toLowerCase())).map((a) => {
            const agentWallet = controllerWallet(a);
            const agentProof = proofs[agentKey(a)];
            const verified = proofMatchesWallet(agentProof, agentWallet);
            const account = accounts[agentKey(a)];
            return (
              <button key={agentKey(a)} className={`target${agentKey(a) === selectedKey ? ' active' : ''}`} onClick={() => setSel(agentKey(a))}>
                <span>{a.name}</span>
                <span className="muted small">{account?.ensName ?? displayAgentEnsName(a.name, rootEns)}</span>
                <span className={account?.status === 'revoked' ? 'status-error small' : account?.status === 'active' ? 'ok-text small' : verified ? 'warn-text small' : 'muted small'}>
                  {account?.status === 'revoked' ? 'authority revoked' : account?.status === 'active' ? `${account.sessions.filter((session) => session.status === 'active').length} active grants` : verified ? 'signer verified' : agentWallet ? `signer ${shortAddr(agentWallet)}` : 'setup required'}
                </span>
              </button>
            );
          })}
        </section>

        <section className="grow identity-main">
          {acct ? (
            <>
              <section className="card identity-hero">
                <div>
                  <div className="muted small">agent wallet</div>
                  <h2>{canonicalEns}</h2>
                  <div className="identity-subtitle">
                    <span>{selected}</span>
                    {selectedTeam ? <span className="muted small">{selectedTeam}</span> : null}
                    <StatusPill state={!caps?.live ? 'warn' : acct.status === 'revoked' ? 'warn' : acct.status === 'active' ? 'verified' : 'pending'} />
                  </div>
                </div>
                <div className="identity-metrics">
                  <div><b>{caps?.live ? acct.status : 'simulation'}</b><span>lifecycle</span></div>
                  <div><b>{caps?.live ? (acct.deployed ? 'deployed' : 'predicted') : 'not verified'}</b><span>Agent Safe</span></div>
                  <div><b>{activeSessionCount}</b><span>active grants</span></div>
                  <div><b>{rootIdentity && sameAddress(acct.owner, rootSafeAddress) ? 'root' : caps?.live ? 'review' : 'local'}</b><span>recovery</span></div>
                </div>
              </section>

              <section className="card identity-authority-model" role="status">
                <div className="identity-authority-head">
                  <div>
                    <h3>Authority model</h3>
                    <span className="muted small">{canonicalEns}</span>
                  </div>
                  <div className="row-actions">
                    {acct.status === 'revoked' ? (
                      <button className="btn primary" disabled={busy || !productionReady} onClick={() => void restoreAgentAuthority()}>Restore authority</button>
                    ) : (
                      <button className="btn icon-danger" disabled={busy || !productionReady || !acct.smartAccount} onClick={() => void revokeAgentAuthority()}>Revoke authority</button>
                    )}
                  </div>
                </div>
                <div className="identity-authority-flow">
                  <div>
                    <span>Root authority</span>
                    <b>{rootEns}</b>
                    <small className="mono">{rootIdentity ? shortAddr(rootSafeAddress) : 'local/mock only'}</small>
                  </div>
                  <div>
                    <span>Agent Safe</span>
                    <b>{caps?.live ? (acct.deployed ? 'Deployed' : 'Counterfactual') : 'Simulation only'}</b>
                    <small className="mono">{shortAddr(acct.smartAccount)}</small>
                  </div>
                  <div>
                    <span>Agent authority</span>
                    <b>{acct.status === 'revoked' ? 'Disabled' : activeSessionCount ? 'Independent' : 'Not issued'}</b>
                    <small>{acct.status === 'revoked' ? 'Root recovery only' : `${activeSessionCount} finite grant${activeSessionCount === 1 ? '' : 's'}`}</small>
                  </div>
                </div>
                {ensCollision ? <div className="identity-alert"><b>ENS collision</b><span>{selected} exists in more than one team. Wallet creation is blocked until agent names are globally unique.</span></div> : null}
                {acct.pendingOperation ? (
                  <div className="identity-alert">
                    <b>{acct.pendingOperation.status === 'prepared' ? 'Proposal ready' : 'Proposal pending'}</b>
                    <span>{acct.pendingOperation.kind} · {acct.pendingOperation.calls.length} atomic call{acct.pendingOperation.calls.length === 1 ? '' : 's'} · {shortAddr(acct.pendingOperation.smartAccount)}</span>
                    <button className="btn primary" disabled={busy} onClick={() => void syncPendingKeyOperation()}>
                      {acct.pendingOperation.status === 'prepared' ? 'Submit proposal' : 'Check receipts'}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className={`card identity-readiness ${processState}`} role="status">
                <div className="identity-readiness-score" aria-label={`${readinessPercent}% of setup checks verified`}>
                  <b>{readinessPercent}%</b>
                  <span>verified now</span>
                </div>
                <div className="identity-readiness-copy">
                  <div className="identity-readiness-title">
                    <h3>Operational readiness</h3>
                    <StatusPill state={processState} />
                  </div>
                  <p>
                    {processState === 'verified'
                      ? 'Identity, account, chain routes, and scoped-key evidence are ready for the capabilities shown here.'
                      : nextProcessStep
                        ? <><b>Next: {nextProcessStep.label}.</b> {nextProcessStep.note}</>
                        : 'Review the setup evidence before enabling privileged work.'}
                  </p>
                  <div className="identity-progress" aria-hidden="true"><span style={{ width: `${readinessPercent}%` }} /></div>
                </div>
              </section>

              <details className="compact-details"><summary>Advanced: production evidence</summary><section className="card identity-process" role="status" aria-label="Safe production readiness">
                <div className="identity-process-head">
                  <div>
                    <h3>Production release gate</h3>
                    <p className="muted small">
                      Main-process checks must pass before IDACC can prepare any live Safe or session-authority change.
                    </p>
                  </div>
                  <div className="row-actions">
                    <StatusPill state={productionReady ? 'verified' : 'warn'} />
                    <button className="btn" disabled={busy} onClick={() => void refreshIdentityProcess()}>Re-run preflight</button>
                  </div>
                </div>
                {productionReadiness ? (
                  <div className="risk-list">
                    {productionReadiness.checks.map((check) => (
                      <div key={check.id} className="risk-row">
                        <span className={`dot ${check.status === 'pass' ? 'ok' : check.status === 'block' ? 'err' : 'warn'}`} />
                        <b>{check.label}</b>
                        <span className={check.status === 'pass' ? 'ok-text' : check.status === 'block' ? 'status-error' : 'warn-text'}>
                          {check.detail}{check.remediation ? ` ${check.remediation}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : <p className="muted small">Running production preflight...</p>}
              </section></details>

              {error ? (
                <div className="identity-alert" role="alert">
                  <b>Action failed</b>
                  <span>{error}</span>
                  <button className="btn" onClick={() => setError(null)}>Dismiss</button>
                </div>
              ) : null}

              <section className="card identity-process" role="status">
                <div className="identity-process-head">
                  <div>
                    <h3>Wallet setup · next steps</h3>
                    <p className="muted small">
                      Identity, signer proof, Safe ownership, and autonomous authority are checked as one guarded lifecycle.
                    </p>
                  </div>
                  <div className="row-actions">
                    <StatusPill state={processState} />
                    <button className="btn" disabled={busy} onClick={() => void refreshIdentityProcess()}>Run check</button>
                    <button className="btn primary" disabled={busy || !nextProcessStep?.action} onClick={() => void runProcessAction()}>
                      {nextProcessStep?.action === 'review-chains' || nextProcessStep?.action === 'review-standards' ? 'Review next' : nextProcessStep?.action ? 'Continue setup' : 'Ready'}
                    </button>
                  </div>
                </div>
                <div className="identity-process-steps">
                  {identityProcess.map((step) => (
                    <button
                      key={step.id}
                      className={`identity-step ${step.state}${step.id === nextProcessStep?.id ? ' next' : ''}`}
                      disabled={busy || !step.action}
                      onClick={() => void runProcessAction(step.action)}
                      title={step.action ? step.note : undefined}
                    >
                      <span className={`dot ${dotTone(step.state)}`} />
                      <b>{step.label}</b>
                      <span>{step.note}</span>
                    </button>
                  ))}
                </div>
                {processMsg ? <div className="muted small">{processMsg}</div> : null}
              </section>

              {legacyKeys.length ? (
                <details className="card identity-review-details identity-legacy" role="status">
                  <summary>
                    <span>
                      <b>Legacy authority</b>
                      <span className="muted small">{legacyKeys.length} bare-name record{legacyKeys.length === 1 ? '' : 's'} blocked from scoped authority</span>
                    </span>
                    <StatusPill state="warn" />
                  </summary>
                  <div className="identity-review-body">
                    <p className="muted small">
                      Older bare-name key records are not treated as current scoped authority. Select the scoped agent to recreate authority through the normal guarded flow.
                    </p>
                    <div className="risk-list">
                      {legacyKeys.map((row) => {
                        const firstAuthority = row.currentAuthorities[0] ?? '';
                        const target = row.currentAuthorities.map((a) => legacyAuthorityTarget(a, identityAgents)).find(Boolean);
                        return (
                          <div key={`${row.source}:${row.agent}`} className="risk-row">
                            <span className="dot warn" />
                            <b>{row.agent}</b>
                            <span>
                              <span className="warn-text">
                                {row.account ? 'account' : 'no account'}{row.deployed ? ' deployed' : ''}; {row.activeSessions}/{row.totalSessions} active sessions{row.nonExpiringSessions ? `, ${row.nonExpiringSessions} non-expiring` : ''}{' -> '}{row.currentAuthorities.join(', ')}
                              </span>
                              <span className="legacy-review-actions">
                                {target ? (
                                  <button className="btn small" disabled={busy} onClick={() => { setSel(agentKey(target)); setLegacyMsg(`Selected ${agentKey(target)}. Recreate scoped account/session authority from the normal controls; legacy records stay blocked.`); }}>
                                    Select scoped agent
                                  </button>
                                ) : null}
                                {firstAuthority ? (
                                  <button className="btn small" disabled={busy} onClick={() => void copyLegacyAuthority(firstAuthority)}>
                                    Copy scoped authority
                                  </button>
                                ) : null}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {legacyMsg ? <div className="muted small" style={{ marginTop: 8 }}>{legacyMsg}</div> : null}
                  </div>
                </details>
              ) : null}

              <details className={`card identity-review-details ${brainControllerNeedsReview ? 'identity-legacy' : ''}`} role="status">
                <summary>
                  <span>
                    <b>Brain controller sync</b>
                    <span className="muted small">{brainSelectedController.note}</span>
                  </span>
                  <StatusPill state={brainSelectedController.state} />
                </summary>
                <div className="identity-review-body">
                  <p className="muted small">
                    Read-only Brain <span className="mono">/controllers</span> evidence for accountable identity. It does not create, link, revoke, or promote controller records.
                  </p>
                  <div className="risk-list">
                    <div className="risk-row">
                      <span className={`dot ${dotTone(brainSelectedController.state)}`} />
                      <b>Selected agent</b>
                      <span className={statusTone(brainSelectedController.state)}>{brainSelectedController.note}</span>
                    </div>
                    <div className="risk-row">
                      <span className={`dot ${brainControllers && (brainControllers.activeLinks ?? 0) > 0 ? 'ok' : 'warn'}`} />
                      <b>Brain links</b>
                      <span className={brainControllers && (brainControllers.activeLinks ?? 0) > 0 ? 'ok-text' : 'warn-text'}>
                        {brainControllers ? `${brainControllers.activeLinks ?? 0} active links across ${brainControllers.total ?? 0} controllers; ${brainLinkedAgents}/${identityAgents.length} current agents matched` : 'route unavailable'}
                      </span>
                    </div>
                    <div className="risk-row">
                      <span className={`dot ${brainAmbiguousLinks ? 'warn' : 'ok'}`} />
                      <b>Fallback safety</b>
                      <span className={brainAmbiguousLinks ? 'warn-text' : 'muted'}>
                        {brainAmbiguousLinks ? `${brainAmbiguousLinks} bare-name Brain link${brainAmbiguousLinks === 1 ? '' : 's'} ambiguous across duplicate agent names` : 'Scoped or unique matches only; bare duplicate links stay review-only.'}
                      </span>
                    </div>
                  </div>
                </div>
              </details>

              <details id="identity-standards" className="card identity-review-details identity-standards" role="status">
                <summary>
                  <span>
                    <b>Onchain identity &amp; metadata evidence</b>
                    <span className="muted small">{standardVerified} verified · {standardDeclared} declared · {standardCoverage.length} tracked</span>
                  </span>
                  <StatusPill state={standardVerified === standardCoverage.length ? 'verified' : (standardVerified || standardDeclared) ? 'warn' : 'missing'} />
                </summary>
                <div className="identity-review-body">
                  <p className="muted small">
                    Read-only coverage check for public identity metadata. Live verification reads the Ethereum ENS address binding and deployed bytecode for the selected Safe and declared metadata contracts through your configured RPCs. Generic bytecode never proves conformance to a draft metadata standard. Raw resolver bytes, contract bytes, and issuer extraMetadata are never displayed.
                  </p>
                  <div className="row-actions" style={{ marginBottom: 10 }}>
                    <button className="btn" disabled={identityEvidenceBusy || !selAgent} onClick={() => void verifyLiveIdentity()}>
                      {identityEvidenceBusy ? 'Verifying…' : 'Verify live evidence'}
                    </button>
                    <span className="muted small">
                      {liveIdentityEvidence
                        ? `checked ${timeAgo(liveIdentityEvidence.checkedAt)} · chain ${liveIdentityEvidence.chainId}`
                        : 'No live resolver/contract read in this session.'}
                    </span>
                  </div>
                  <div className="risk-list">
                    {standardCoverage.map((row) => (
                      <div key={row.label} className="risk-row">
                        <span className={`dot ${dotTone(row.state)}`} />
                        <b>{row.label}</b>
                        <span className={statusTone(row.state)}>{row.note}</span>
                      </div>
                    ))}
                    {liveIdentityEvidence ? (
                      liveIdentityEvidence.contracts.length ? liveIdentityEvidence.contracts.map((contract) => {
                        const state: EvidenceState = contract.state === 'verified'
                          ? 'verified'
                          : contract.state === 'missing'
                            ? 'missing'
                            : 'warn';
                        return (
                          <div key={`contract:${contract.address}`} className="risk-row">
                            <span className={`dot ${dotTone(state)}`} />
                            <b>Declared contract {shortAddr(contract.address)}</b>
                            <span className={statusTone(state)}>{contract.detail}</span>
                          </div>
                        );
                      }) : (
                        <div className="risk-row">
                          <span className="dot warn" />
                          <b>Declared contracts</b>
                          <span className="warn-text">No valid contract address was declared in this agent's identity metadata, so bytecode could not be checked.</span>
                        </div>
                      )
                    ) : null}
                  </div>
                </div>
              </details>

              <section id="identity-chain-access" className="card identity-chain-access" role="status">
                <div className="identity-legacy-head">
                  <h3>Operational Chain Access</h3>
                  <StatusPill state={keyOperational && availableRpcs.length ? 'verified' : enabledRpcs.length ? 'warn' : 'missing'} />
                </div>
                <p className="muted small">
                  Active granted keys use the enabled EVM RPCs from Settings as the chain allowlist. RPC secrets stay encrypted in the main process and are never shown here.
                </p>
                <div className="risk-list">
                  <div className="risk-row">
                    <span className={`dot ${caps?.live ? 'ok' : 'warn'}`} />
                    <b>Signing mode</b>
                    <span className={caps?.live ? 'ok-text' : 'warn-text'}>
                      {caps?.live ? 'Live provider prepares atomic root-Safe proposals; agent sessions use the guarded signer path.' : 'Mock key provider only; configured chains are visible but transactions are not broadcast from IDACC yet.'}
                    </span>
                  </div>
                  <div className="risk-row">
                    <span className={`dot ${activeSessionCount > 0 ? 'ok' : 'warn'}`} />
                    <b>Granted key</b>
                    <span className={activeSessionCount > 0 ? 'ok-text' : 'warn-text'}>
                      {activeSessionCount > 0 ? `${activeSessionCount} active scoped key${activeSessionCount === 1 ? '' : 's'}` : 'Issue a scoped key before this agent can operate autonomously.'}
                    </span>
                  </div>
                  <div className="risk-row">
                    <span className="dot ok" />
                    <b>Custody &amp; storage</b>
                    <span className="ok-text">RPC secrets and profile-scoped agent signer keys are Electron safeStorage-encrypted. Root-wallet and OWS custody stays external; plaintext keys never persist in IDACC state or localStorage.</span>
                  </div>
                  {enabledRpcs.map((rpc) => (
                    <div key={rpc.id} className="risk-row">
                      <span className={`dot ${rpc.lastRequest?.status === 'available' ? 'ok' : rpc.lastRequest ? 'warn' : 'warn'}`} />
                      <b>{rpc.network}</b>
                      <span className={rpcStatusClass(rpc.lastRequest?.status)}>
                        {rpc.lastRequest
                          ? `${rpc.lastRequest.status}${rpc.lastRequest.blockNumber != null ? ` · block ${rpc.lastRequest.blockNumber.toLocaleString()}` : ''} · checked ${timeAgo(rpc.lastRequest.at)}`
                          : 'configured; not checked'} · key {rpcKeyLabel(rpc.keySource)}
                      </span>
                    </div>
                  ))}
                  {enabledRpcs.length === 0 ? (
                    <div className="risk-row">
                      <span className="dot err" />
                      <b>No chain RPCs</b>
                      <span className="status-error">Add agent chain RPCs in Settings before granted keys have any chain route.</span>
                    </div>
                  ) : null}
                </div>
              </section>

              <details className="compact-details"><summary>Advanced: network addresses</summary><section className="card" role="status">
                <div className="identity-legacy-head">
                  <h3>Per-chain addresses</h3>
                  <StatusPill state={executionChainRows.every((row) => row.state === 'verified') ? 'verified' : executionChainRows.some((row) => row.state === 'missing') ? 'missing' : executionChainRows.some((row) => row.state === 'warn') ? 'warn' : 'pending'} />
                </div>
                <p className="muted small">
                  The controller is the same EOA on every EVM chain. Safe deployment is only known for the key provider&apos;s current chain; other chains remain pending until live deployment reads are available.
                </p>
                <table className="grid identity-table">
                  <thead>
                    <tr>
                      <th>Chain</th>
                      <th>Controller EOA</th>
                      <th>Safe account</th>
                      <th>RPC / status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executionChainRows.map((row) => (
                      <tr key={row.chain.chainId}>
                        <td>
                          <b>{row.chain.name}</b><br />
                          <span className="muted small mono">{row.chain.chainId}</span>
                        </td>
                        <td>
                          {wallet ? (
                            <><span className="mono" title={wallet}>{shortAddr(wallet)}</span><br /><span className="muted small">same EOA</span></>
                          ) : <span className="status-error">not bound</span>}
                        </td>
                        <td>
                          {acct?.smartAccount ? (
                            <><span className="mono" title={acct.smartAccount}>{shortAddr(acct.smartAccount)}</span><br /><span className={statusTone(row.safe.state)}>{row.safe.note}</span></>
                          ) : <span className="status-error">{row.safe.note}</span>}
                        </td>
                        <td>
                          <StatusPill state={row.state} /><br />
                          <span className={rpcStatusClass(row.rpc?.lastRequest?.status)}>
                            {row.rpc ? `${row.rpcNote} · key ${rpcKeyLabel(row.rpc.keySource)}` : row.rpcNote}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section></details>

              <details className="compact-details"><summary>Advanced: root wallet proposal</summary><section className="card identity-contract-console" role="status">
                <div className="identity-legacy-head">
                  <h3>Root Safe Bootstrap Proposal</h3>
                  <StatusPill state={contractExecutionState === 'ready' ? 'verified' : contractInputErrors.length ? 'warn' : 'missing'} />
                </div>
                <p className="muted small">
                  Root Safe: <span className="mono">{rootEns}</span> <span className="mono">{rootSafeAddress || 'not configured'}</span>. Use this proposal boundary only to provision or revoke an agent Safe. Routine agent transactions use the agent&apos;s target- and function-scoped session key and do not prompt the root signer.
                </p>
                <div className="identity-contract-grid">
                  <label>
                    <span>Connected root Safe</span>
                    <input className="mono" value={contractAccount || 'not connected'} readOnly />
                  </label>
                  <label>
                    <span>Wallet chain</span>
                    <input value={providerChain ? (chainByHex(providerChain)?.name ?? providerChain) : 'not connected'} readOnly />
                  </label>
                  <label>
                    <span>Required chain</span>
                    <select
                      value={contractChain}
                      onChange={(e) => {
                        setContractChain(e.target.value as (typeof EXECUTION_CHAINS)[number]['hex']);
                        setContractConfirmed(false);
                      }}
                    >
                      {EXECUTION_CHAINS.map((chain) => (
                        <option key={chain.hex} value={chain.hex}>
                          {chain.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Value, wei</span>
                    <input
                      className="mono"
                      inputMode="numeric"
                      value={contractValue}
                      onChange={(e) => {
                        setContractValue(e.target.value);
                        setContractConfirmed(false);
                      }}
                    />
                  </label>
                  <label className="wide">
                    <span>Contract target</span>
                    <input
                      className="mono"
                      placeholder="0x..."
                      spellCheck={false}
                      value={contractTo}
                      onChange={(e) => {
                        setContractTo(e.target.value);
                        setContractConfirmed(false);
                      }}
                    />
                  </label>
                  <label className="wide">
                    <span>Calldata</span>
                    <textarea
                      className="identity-contract-data mono"
                      spellCheck={false}
                      value={contractData}
                      onChange={(e) => {
                        setContractData(e.target.value);
                        setContractConfirmed(false);
                      }}
                    />
                  </label>
                </div>
                <label className="identity-contract-confirm">
                  <input
                    type="checkbox"
                    checked={contractConfirmed}
                    disabled={!contractSimulationFresh}
                    onChange={(e) => setContractConfirmed(e.target.checked)}
                  />
                  <span>I reviewed the Safe, chain, target, calldata, value, and current simulation preview.</span>
                </label>
                <div className="row-actions identity-actions">
                  <button className="btn" disabled={contractBusy} onClick={prepareRootThresholdRepair}>
                    Prepare threshold 2
                  </button>
                  <button className="btn" disabled={contractBusy} onClick={() => void connectContractWallet()}>
                    Connect root Safe
                  </button>
                  <button className="btn" disabled={contractBusy || !contractAccount} onClick={() => void switchContractChain()}>
                    Switch chain
                  </button>
                  <button className="btn" disabled={contractBusy || !contractAccount} onClick={() => void simulateContractExecution()}>
                    Simulate
                  </button>
                  <button className="btn primary" disabled={!contractCanSubmit} onClick={() => void submitContractExecution()}>
                    Submit root proposal
                  </button>
                </div>
                {contractInputErrors.length ? (
                  <div className="risk-list identity-contract-errors">
                    {contractInputErrors.map((row) => (
                      <div key={row} className="risk-row">
                        <span className="dot warn" />
                        <b>Guard</b>
                        <span className="warn-text">{row}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className={contractSimulationFresh ? 'ok-text small' : contractSimulation?.ok === false ? 'status-error small' : 'muted small'}>
                  {contractSimulation?.stamp === contractStamp ? contractSimulation.message : contractMessage}
                </div>
                <pre className="identity-contract-preview">{contractPreview}</pre>
              </section></details>

              <section className="card identity-gate">
                <div>
                  <h3>Agent signer proof</h3>
                  <p className="muted">The signer proves possession before IDACC prepares account or authority changes. Root Safe approval remains the live administrative boundary.</p>
                </div>
                <div className="controller-proof">
                  <div className="risk-row">
                    <span className={`dot ${controllerVerified ? 'ok' : wallet ? 'warn' : 'err'}`} />
                    <b>{controllerVerified ? 'Signer verified' : 'Signer proof required'}</b>
                    <span className={controllerVerified ? 'ok-text' : wallet ? 'warn-text' : 'status-error'}>
                      {controllerVerified ? `valid until ${new Date(proof!.expiresAt).toLocaleTimeString()}` : wallet ? `signer ${shortAddr(wallet)}` : 'no agent signer'}
                    </span>
                  </div>
                  {proof ? (
                    <>
                      <textarea className="identity-proof-message mono" readOnly value={proof.message} />
                      <input
                        className="identity-proof-input mono"
                        value={proof.signature}
                        onChange={(e) => updateSignature(e.target.value)}
                        placeholder="Paste 0x signature from the agent signer"
                      />
                    </>
                  ) : null}
                  <div className="row-actions identity-actions">
                    <button className="btn" disabled={busy || !wallet} onClick={() => void startChallenge()}>New challenge</button>
                    <button className="btn primary" disabled={busy || !proof || !proof.signature || controllerVerified} onClick={() => void verifyControllerProof()}>Verify signature</button>
                  </div>
                </div>
              </section>

              <div className="identity-grid">
                <section className="card">
                  <h3>Agent Safe</h3>
                  <div className="kv identity-kv">
                    <span>ENS identity</span>
                    <b className="mono">{canonicalEns}</b>
                    <span>Agent signer</span>
                    <b className={wallet ? 'mono' : 'muted'}>{wallet ? shortAddr(wallet) : 'not provisioned'}</b>
                    <span>Safe address</span>
                    <b className="mono">{shortAddr(acct.smartAccount)}</b>
                    <span>Root owner</span>
                    <b className={rootIdentity && sameAddress(acct.owner, rootSafeAddress) ? 'mono ok-text' : caps?.live ? 'mono status-error' : 'mono muted'}>{shortAddr(acct.owner)}</b>
                    <span>Status</span>
                    <b className={!caps?.live ? 'warn-text' : acct.status === 'revoked' ? 'status-error' : acct.status === 'active' ? 'ok-text' : 'warn-text'}>{caps?.live ? acct.status : 'simulation only'}</b>
                    <span>Chain</span>
                    <b>{acct.chainId}</b>
                  </div>
                  {!wallet ? (
                    <div className="identity-contract-grid" style={{ marginTop: 12 }}>
                      <label className="wide">
                        <span>Bind existing agent signer</span>
                        <input
                          className="mono"
                          value={walletInput}
                          onChange={(event) => setWalletInput(event.target.value)}
                          aria-invalid={walletInput.length > 0 && !walletInputValid}
                          placeholder="0x..."
                        />
                      </label>
                    </div>
                  ) : null}
                  <div className="row-actions identity-actions">
                    {!wallet ? (
                      <>
                        <button className="btn" disabled={busy || !walletInputValid} onClick={() => void bindExistingWallet()}>
                          Bind signer
                        </button>
                        <button className="btn" disabled={busy} onClick={() => void identityAction('provision')}>
                          Provision signer
                        </button>
                      </>
                    ) : null}
                    <button className="btn" disabled={busy || Boolean(registeredDomain) || ensCollision || acct.status === 'revoked' || !controllerVerified} onClick={() => void identityAction('register')}>
                      {registeredDomain ? `Manager record · ${registeredDomain}` : 'Record ENS identity'}
                    </button>
                  </div>
                </section>

                <details className="compact-details"><summary>Security review evidence</summary><section className="card">
                  <h3>Security Review</h3>
                  <div className="risk-list">
                    {review.map((r) => (
                      <div key={r.label} className="risk-row">
                        <span className={`dot ${dotTone(r.state)}`} />
                        <b>{r.label}</b>
                        <span className={statusTone(r.state)}>{r.note}</span>
                      </div>
                    ))}
                  </div>
                </section></details>
              </div>

              <section className="card">
                <div className="identity-legacy-head">
                  <h3>Autonomous authority</h3>
                  <StatusPill state={!caps?.live ? 'warn' : acct.status === 'revoked' ? 'warn' : activeSessionCount ? 'verified' : 'pending'} />
                </div>
                <table className="grid identity-table">
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Authority</th>
                      <th>Signer</th>
                      <th>Spend cap</th>
                      <th>Lifetime</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSessions.map((s) => (
                      <tr key={s.id}>
                        <td className="b">{s.scope.label}</td>
                        <td>
                          <div className="identity-authority">
                            {sessionAuthority(s).map((badge) => (
                              <span key={badge.label} className={`identity-authority-badge ${badge.tone}`}>{badge.label}</span>
                            ))}
                          </div>
                        </td>
                        <td className="mono muted">{shortAddr(s.address)}</td>
                        <td className={s.scope.spendLimitWei === '0' ? 'warn-text mono small' : 'mono small'}>
                          {s.scope.spendLimitWei === '0' ? 'uncapped' : s.scope.spendLimitWei}
                        </td>
                        <td className={s.validUntil === 0 ? 'warn-text' : 'muted'}>{remaining(s.validUntil)}</td>
                        <td className={s.status === 'active' ? 'ok-text' : s.status === 'revoked' ? 'status-error' : 'muted'}>
                          {s.status}
                        </td>
                        <td className="row-actions">
                          {s.status === 'active' ? (
                            <>
                              <button className="btn" disabled={busy || !productionReady || !controllerVerified} onClick={() => void rotateSession(s)}>Rotate</button>
                              <button className="btn" disabled={busy || !productionReady || !controllerVerified} onClick={() => void revokeSession(s)}>Revoke</button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {activeSessions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="muted">
                          No session keys yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>

                {presets ? (
                  <div className="issue-policy">
                    <div className="issue-policy-fields">
                      <label>
                        <span>Allowed contracts</span>
                        <input
                          value={authorityTargetsInput}
                          onChange={(event) => setAuthorityTargetsInput(event.target.value)}
                          placeholder="0x..."
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        <span>Allowed functions</span>
                        <input
                          value={authorityFunctionsInput}
                          onChange={(event) => setAuthorityFunctionsInput(event.target.value)}
                          placeholder="functionName(type,type)"
                          spellCheck={false}
                        />
                      </label>
                    </div>
                    <div className="issue-row">
                      <select value={scopeIdx} onChange={(e) => setScopeIdx(Number(e.target.value))} disabled={!safeScopes.length}>
                        {safeScopes.map(({ scope, idx }) => (
                          <option key={idx} value={idx}>
                            {scope.label}
                          </option>
                        ))}
                      </select>
                      <select value={ttlIdx} onChange={(e) => setTtlIdx(Number(e.target.value))} disabled={!finiteTtls.length}>
                        {finiteTtls.map(({ ttl, idx }) => (
                          <option key={idx} value={idx}>
                            {ttl.label}
                          </option>
                        ))}
                      </select>
                      {acct.deployed && activeSessionCount > 0 ? (
                        <button className="btn" disabled={busy || issueBlocked} onClick={() => void issueSession()}>Add scoped key</button>
                      ) : (
                        <button className="btn primary" disabled={busy || provisionBlocked || ensCollision} onClick={() => void provisionAuthority()}>Provision Safe + authority</button>
                      )}
                    </div>
                  </div>
                ) : null}
                <p className="muted small">
                  Live provisioning submits one atomic root-Safe batch and remains pending until receipts verify. Private keys stay in macOS Keychain-backed storage. Authority is limited to the listed contracts and function selectors, cannot send native value, and remains active until an explicit on-chain revoke.
                </p>
              </section>

              <details className="compact-details"><summary>Advanced: rollout details</summary><section className="card identity-plan">
                <div className="identity-plan-head">
                  <div>
                    <h3>Authority rollout</h3>
                    <p className="muted small">The standard remains constant as local simulation is replaced by verified chain reads and live Safe proposals.</p>
                  </div>
                  <StatusPill state="pending" />
                </div>
                <div className="identity-plan-grid">
                  <div className="identity-plan-lane now">
                    <span className="identity-plan-kicker">Now</span>
                    <b>Guarded agent control</b>
                    <p>Fresh controller proofs gate account changes. Enabled RPCs form the chain allowlist, and the UI issues only zero-value, target- and function-scoped session keys.</p>
                  </div>
                  <div className="identity-plan-lane next">
                    <span className="identity-plan-kicker">Next</span>
                    <b>Live, per-chain evidence</b>
                    <p>Resolver, manifest, reputation, runtime-signature, and per-chain deployment reads replace pending or unknown evidence.</p>
                  </div>
                  <div className="identity-plan-lane later">
                    <span className="identity-plan-kicker">Live provider</span>
                    <b>Root-approved Safe execution</b>
                    <p>Safe proposals replace local simulation while Zodiac Roles grants stay scoped, independently usable, and root-revocable. Expiry is shown only when the live provider enforces it.</p>
                  </div>
                </div>
              </section></details>

              <details className="card identity-details">
                <summary>Advanced evidence</summary>
                <div className="identity-detail-grid">
                  <div className="kv identity-kv">
                    <span>ENS / ID-chain</span>
                    <b className={domain ? 'mono' : 'muted'}>{domain || '-'}</b>
                    <span>Runtime</span>
                    <b>{selAgent?.runtime ?? '-'}</b>
                    <span>Model</span>
                    <b>{selAgent?.model ?? '-'}</b>
                    <span>Provider</span>
                    <b>{caps?.provider ?? '-'}</b>
	                  </div>
	                  <div className="auth-list">
	                    <div><StatusPill state="pending" /><span>ENS address binding is verified separately. Draft ENSIP-24 / ERC-8004 / ERC-8048 / ERC-8049 / B20 evidence stays declared until canonical standard targets and interfaces are available.</span></div>
	                    <div><StatusPill state="pending" /><span>Manifest hashes, metadata-hook trust, and runtime signatures remain external trust claims until the Manager supplies a versioned attestation schema and trust roots.</span></div>
	                    <div><StatusPill state="self" /><span>Better Auth proves operator login only; it is not wallet or agent identity proof.</span></div>
	                  </div>
                </div>
              </details>
            </>
          ) : (
            <section className="card">
              <p className="muted">Select an agent.</p>
            </section>
          )}
        </section>
      </div>
    </div>
  );
}
