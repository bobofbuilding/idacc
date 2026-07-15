import {
  AbiCoder,
  Interface,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  getCreate2Address,
  id,
  isAddress,
  keccak256,
  solidityPacked,
  toBeHex,
  zeroPadBytes,
  zeroPadValue,
} from 'ethers';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ROOT_AGENT_SAFE_ADDRESS,
  agentEnsName,
  type AgentAccount,
  type AssetGuardReport,
  type KeyCapabilities,
  type KeyOperationCall,
  type KeyOperationKind,
  type KeyProvider,
  type PreparedKeyOperation,
  type SessionKey,
  type SessionScope,
} from '../../../idctl/src/keys/types.ts';
import { SAFE_MODULE_MANIFEST } from '../../../idctl/src/keys/safeManifest.ts';

const PROVIDER_REVISION = 'safe-roles-walletconnect-v1';
const MAINNET_CHAIN_ID = 1;
const OPERATION_TTL_MS = 15 * 60_000;

function manifestAddress(name: string): string {
  const artifact = SAFE_MODULE_MANIFEST.artifacts.find((candidate) => candidate.name === name);
  if (!artifact) throw new Error(`Pinned Safe module artifact is missing: ${name}`);
  return getAddress(artifact.address.toLowerCase());
}

const SAFE_MODULE_SETUP = manifestAddress('Safe CreateAndAddModules 1.1.1');
const SAFE_SINGLETON = manifestAddress('Safe 1.4.1 singleton');
const SAFE_PROXY_FACTORY = manifestAddress('Safe 1.4.1 proxy factory');
const SAFE_FALLBACK_HANDLER = manifestAddress('Safe 1.4.1 compatibility fallback handler');
const ROLES_FACTORY = manifestAddress('Zodiac ModuleProxyFactory 3.0.1');
const ROLES_MASTERCOPY = manifestAddress('Zodiac Roles Modifier v2.1');

const SAFE_MODULE_SETUP_INTERFACE = new Interface([
  'function createAndAddModules(address proxyFactory,bytes data)',
]);
const SAFE_SETUP_INTERFACE = new Interface([
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)',
  'function isModuleEnabled(address module) view returns (bool)',
]);
const SAFE_PROXY_FACTORY_INTERFACE = new Interface([
  'function proxyCreationCode() view returns (bytes)',
  'function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address proxy)',
]);
const MODULE_PROXY_FACTORY_INTERFACE = new Interface([
  'function deployModule(address masterCopy,bytes initializer,uint256 saltNonce) returns (address proxy)',
]);
const MODULE_PROXY_INTERFACE = new Interface([
  'function setUp(bytes initializeParams)',
]);
const ROLES_INTERFACE = new Interface([
  'function setAvatar(address avatar)',
  'function setTarget(address target)',
  'function assignRoles(address module,bytes32[] roleKeys,bool[] memberOf)',
  'function scopeTarget(bytes32 roleKey,address targetAddress)',
  'function allowFunction(bytes32 roleKey,address targetAddress,bytes4 selector,uint8 options)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function avatar() view returns (address)',
  'function target() view returns (address)',
]);

interface SignerMetadata {
  address: string;
}

interface LiveAccountRecord {
  agent: string;
  ensName: string;
  smartAccount: string;
  authorityModule: string;
  owner: string;
  chainId: number;
  deployed: boolean;
  status: AgentAccount['status'];
  revokedAt?: number;
  sessions: SessionKey[];
}

interface ProviderState {
  schemaVersion: 1;
  accounts: Record<string, LiveAccountRecord>;
  operations: Record<string, PreparedKeyOperation>;
}

export interface SafeRolesProviderOptions {
  statePath: () => string;
  rpcRead: (chainId: number, method: string, params: unknown[]) => Promise<string>;
  ensureSigner: (agent: string) => SignerMetadata;
  rotateSigner: (agent: string) => SignerMetadata;
  inspectAssets: (chainId: number, safeAddress: string) => Promise<AssetGuardReport>;
}

function emptyState(): ProviderState {
  return { schemaVersion: 1, accounts: {}, operations: {} };
}

function operationId(agent: string, kind: KeyOperationKind): string {
  const entropy = `${Date.now()}:${randomBytes(16).toString('hex')}:${agent}:${kind}`;
  return `keyop_${createHash('sha256').update(entropy).digest('hex').slice(0, 20)}`;
}

function stableNonce(agent: string, purpose: string, chainId: number): bigint {
  return BigInt(`0x${createHash('sha256').update(`${PROVIDER_REVISION}:${chainId}:${agent}:${purpose}`).digest('hex')}`);
}

function operationDigest(operation: Omit<PreparedKeyOperation, 'digest'>): string {
  const canonical = JSON.stringify({
    id: operation.id,
    kind: operation.kind,
    agent: operation.agent,
    chainId: operation.chainId,
    rootSafe: operation.rootSafe.toLowerCase(),
    smartAccount: operation.smartAccount.toLowerCase(),
    authorityModule: operation.authorityModule.toLowerCase(),
    signerAddress: operation.signerAddress?.toLowerCase(),
    revokedSignerAddresses: operation.revokedSignerAddresses?.map((address) => address.toLowerCase()).sort(),
    roleKey: operation.roleKey,
    calls: operation.calls.map((call) => ({
      to: call.to.toLowerCase(),
      data: call.data.toLowerCase(),
      value: call.value,
    })),
    expiresAt: operation.expiresAt,
  });
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

function validFunctionSignature(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\([^\n\r()]*\)$/.test(value.trim());
}

function normalizeScope(scope: SessionScope): SessionScope {
  const targets = Array.from(new Set(scope.targets.map((target) => target.trim()).filter(Boolean)));
  const functions = Array.from(new Set((scope.functions ?? []).map((fn) => fn.trim()).filter(Boolean)));
  if (!targets.length || targets.some((target) => target === '*' || !isAddress(target))) {
    throw new Error('Live authority requires one or more concrete target contract addresses. Wildcards are refused.');
  }
  if (!functions.length || functions.some((fn) => !validFunctionSignature(fn))) {
    throw new Error('Live authority requires explicit function signatures such as transfer(address,uint256).');
  }
  if (scope.spendLimitWei !== '0') {
    throw new Error('This provider currently enforces zero native-token value. Non-zero spend requires an attested on-chain allowance policy.');
  }
  return {
    label: scope.label.trim() || 'scoped-authority',
    targets: targets.map(getAddress),
    functions,
    spendLimitWei: '0',
  };
}

function rolesInitializer(setupArgs: { types: string[]; values: unknown[] }): string {
  return MODULE_PROXY_INTERFACE.encodeFunctionData('setUp', [
    AbiCoder.defaultAbiCoder().encode(setupArgs.types, setupArgs.values),
  ]);
}

function rolesProxyCreationCode(mastercopy: string): string {
  return `0x602d8060093d393df3363d3d373d3d3d363d73${mastercopy.toLowerCase().slice(2)}5af43d82803e903d91602b57fd5bf3`;
}

function predictRolesProxy(deployer: string, setupArgs: { types: string[]; values: unknown[] }, saltNonce: bigint): string {
  const initializer = rolesInitializer(setupArgs);
  const salt = keccak256(concat([
    keccak256(initializer),
    AbiCoder.defaultAbiCoder().encode(['uint256'], [saltNonce]),
  ]));
  // createAndAddModules delegatecalls the module factory, so CREATE2 executes
  // from the new Safe rather than from the shared factory contract.
  return getCreate2Address(deployer, salt, keccak256(rolesProxyCreationCode(ROLES_MASTERCOPY)));
}

function encodeRolesDeployment(setupArgs: { types: string[]; values: unknown[] }, saltNonce: bigint): string {
  return MODULE_PROXY_FACTORY_INTERFACE.encodeFunctionData('deployModule', [
    ROLES_MASTERCOPY,
    rolesInitializer(setupArgs),
    saltNonce,
  ]);
}

function sessionActive(session: SessionKey): boolean {
  return session.status === 'active' && (session.validUntil === 0 || session.validUntil > Date.now());
}

export class SafeRolesKeyProvider implements KeyProvider {
  private state: ProviderState;
  private readonly options: SafeRolesProviderOptions;

  constructor(options: SafeRolesProviderOptions) {
    this.options = options;
    this.state = this.load();
  }

  capabilities(): KeyCapabilities {
    return {
      provider: 'safe-roles',
      chainId: MAINNET_CHAIN_ID,
      chainLabel: 'Ethereum mainnet',
      live: true,
      providerRevision: PROVIDER_REVISION,
      authorityModel: 'zodiac-roles-v2',
      assetInspection: 'full',
      moduleSet: {
        name: SAFE_MODULE_MANIFEST.id,
        version: SAFE_MODULE_MANIFEST.authority.contractVersion,
        authorityModule: ROLES_MASTERCOPY,
        artifacts: SAFE_MODULE_MANIFEST.artifacts.map((artifact) => artifact.name),
        verified: true,
      },
    };
  }

  private load(): ProviderState {
    const file = this.options.statePath();
    try {
      if (!existsSync(file)) return emptyState();
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProviderState>;
      if (parsed.schemaVersion !== 1 || !parsed.accounts || !parsed.operations) throw new Error('unsupported schema');
      return parsed as ProviderState;
    } catch (error) {
      if (existsSync(file)) {
        const backup = `${file}.corrupt-${Date.now()}`;
        renameSync(file, backup);
        console.error(`[safe-roles] malformed state preserved at ${backup}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return emptyState();
    }
  }

  private save(): void {
    const file = this.options.statePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const pending = `${file}.tmp`;
    writeFileSync(pending, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(pending, 0o600);
    renameSync(pending, file);
    chmodSync(file, 0o600);
  }

  private pendingFor(agent: string): PreparedKeyOperation | undefined {
    return Object.values(this.state.operations)
      .filter((operation) => operation.agent === agent && (operation.status === 'prepared' || operation.status === 'submitted'))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  private assemble(agent: string): AgentAccount {
    const record = this.state.accounts[agent];
    const pending = this.pendingFor(agent);
    if (!record) {
      return {
        agent,
        ensName: agentEnsName(agent),
        smartAccount: pending?.smartAccount ?? ZeroAddress,
        owner: ROOT_AGENT_SAFE_ADDRESS,
        deployed: false,
        chainId: pending?.chainId ?? MAINNET_CHAIN_ID,
        status: 'draft',
        sessions: [],
        pendingOperation: pending,
      };
    }
    return {
      ...record,
      sessions: record.sessions.map((session) => (
        session.status === 'active' && session.validUntil > 0 && session.validUntil <= Date.now()
          ? { ...session, status: 'expired' as const }
          : session
      )),
      pendingOperation: pending,
    };
  }

  async listAccounts(agents: string[]): Promise<AgentAccount[]> {
    return agents.map((agent) => this.assemble(agent));
  }

  async ensureAccount(agent: string, owner = ROOT_AGENT_SAFE_ADDRESS): Promise<AgentAccount> {
    if (owner.toLowerCase() !== ROOT_AGENT_SAFE_ADDRESS.toLowerCase()) throw new Error('Agent Safes must remain root-Safe controlled.');
    const existing = this.state.accounts[agent];
    if (existing) return this.assemble(agent);
    const predicted = await this.prepareDeployment(agent, MAINNET_CHAIN_ID);
    this.state.accounts[agent] = {
      agent,
      ensName: agentEnsName(agent),
      smartAccount: predicted.smartAccount,
      authorityModule: predicted.authorityModule,
      owner: ROOT_AGENT_SAFE_ADDRESS,
      chainId: MAINNET_CHAIN_ID,
      deployed: false,
      status: 'draft',
      sessions: [],
    };
    this.save();
    return this.assemble(agent);
  }

  private async prepareDeployment(agent: string, chainId: number): Promise<{
    smartAccount: string;
    authorityModule: string;
    calls: KeyOperationCall[];
  }> {
    const rolesSalt = stableNonce(agent, 'roles', chainId);
    const roleSetup = {
      types: ['address', 'address', 'address'],
      values: [ROOT_AGENT_SAFE_ADDRESS, ZeroAddress, ZeroAddress],
    };
    const rolesDeploymentData = encodeRolesDeployment(roleSetup, rolesSalt);
    const rolesDeploymentBytes = getBytes(rolesDeploymentData);
    const paddedRolesDeployment = zeroPadBytes(rolesDeploymentData, Math.ceil(rolesDeploymentBytes.length / 32) * 32);
    const moduleSetupData = concat([
      zeroPadValue(toBeHex(rolesDeploymentBytes.length), 32),
      paddedRolesDeployment,
    ]);
    const safeSalt = stableNonce(agent, 'safe', chainId);
    const initializer = SAFE_SETUP_INTERFACE.encodeFunctionData('setup', [
      [ROOT_AGENT_SAFE_ADDRESS],
      1,
      SAFE_MODULE_SETUP,
      SAFE_MODULE_SETUP_INTERFACE.encodeFunctionData('createAndAddModules', [ROLES_FACTORY, moduleSetupData]),
      SAFE_FALLBACK_HANDLER,
      ZeroAddress,
      0,
      ZeroAddress,
    ]);
    const proxyCreationResult = await this.options.rpcRead(chainId, 'eth_call', [{
      to: SAFE_PROXY_FACTORY,
      data: SAFE_PROXY_FACTORY_INTERFACE.encodeFunctionData('proxyCreationCode'),
    }, 'latest']);
    const [proxyCreationCode] = AbiCoder.defaultAbiCoder().decode(['bytes'], proxyCreationResult) as unknown as [string];
    const deploymentBytecode = concat([proxyCreationCode, zeroPadValue(SAFE_SINGLETON, 32)]);
    const create2Salt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(initializer), safeSalt]));
    const smartAccount = getAddress(getCreate2Address(SAFE_PROXY_FACTORY, create2Salt, keccak256(deploymentBytecode)));
    const authorityModule = getAddress(predictRolesProxy(smartAccount, roleSetup, rolesSalt));
    const safeDeploymentData = SAFE_PROXY_FACTORY_INTERFACE.encodeFunctionData('createProxyWithNonce', [
      SAFE_SINGLETON,
      initializer,
      safeSalt,
    ]);
    return {
      smartAccount,
      authorityModule,
      calls: [
        { to: SAFE_PROXY_FACTORY, data: safeDeploymentData, value: '0x0' },
        { to: authorityModule, data: ROLES_INTERFACE.encodeFunctionData('setAvatar', [smartAccount]), value: '0x0' },
        { to: authorityModule, data: ROLES_INTERFACE.encodeFunctionData('setTarget', [smartAccount]), value: '0x0' },
      ],
    };
  }

  private authorityCalls(agent: string, authorityModule: string, signerAddress: string, scope: SessionScope, enabled: boolean): {
    calls: KeyOperationCall[];
    roleKey: string;
    scope: SessionScope;
  } {
    const normalized = normalizeScope(scope);
    const roleKey = id(`idacc:${agent.trim().toLowerCase()}:${normalized.label.trim().toLowerCase()}`);
    const calls: KeyOperationCall[] = [{
      to: authorityModule,
      data: ROLES_INTERFACE.encodeFunctionData('assignRoles', [signerAddress, [roleKey], [enabled]]),
      value: '0x0',
    }];
    if (enabled) {
      for (const target of normalized.targets) {
        calls.push({
          to: authorityModule,
          data: ROLES_INTERFACE.encodeFunctionData('scopeTarget', [roleKey, target]),
          value: '0x0',
        });
        for (const signature of normalized.functions ?? []) {
          calls.push({
            to: authorityModule,
            data: ROLES_INTERFACE.encodeFunctionData('allowFunction', [roleKey, target, id(signature).slice(0, 10), 0]),
            value: '0x0',
          });
        }
      }
    }
    return { calls, roleKey, scope: normalized };
  }

  private persistOperation(input: Omit<PreparedKeyOperation, 'digest'>): PreparedKeyOperation {
    const operation: PreparedKeyOperation = { ...input, digest: operationDigest(input) };
    const duplicate = Object.values(this.state.operations).find((candidate) => (
      candidate.agent === operation.agent
      && candidate.kind === operation.kind
      && (candidate.status === 'prepared' || candidate.status === 'submitted')
    ));
    if (duplicate) return duplicate;
    this.state.operations[operation.id] = operation;
    this.save();
    return operation;
  }

  async deployAccount(agent: string): Promise<PreparedKeyOperation> {
    const existing = this.assemble(agent);
    if (existing.deployed) throw new Error('Agent Safe is already deployed.');
    const deployment = await this.prepareDeployment(agent, MAINNET_CHAIN_ID);
    return this.persistOperation({
      id: operationId(agent, 'deploy'),
      kind: 'deploy',
      agent,
      chainId: MAINNET_CHAIN_ID,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: deployment.smartAccount,
      authorityModule: deployment.authorityModule,
      calls: deployment.calls,
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async provisionAccount(agent: string, scope: SessionScope, ttlMs: number): Promise<PreparedKeyOperation> {
    if (ttlMs !== 0) throw new Error('Zodiac Roles authority is on-chain revocable, not time-expiring. Choose Until revoked; IDACC will not advertise an unenforced TTL.');
    const boundedScope = normalizeScope(scope);
    const current = this.assemble(agent);
    if (current.deployed && current.sessions.some(sessionActive)) throw new Error('Agent Safe already has active authority.');
    const deployment = await this.prepareDeployment(agent, MAINNET_CHAIN_ID);
    const signer = this.options.ensureSigner(agent);
    const authority = this.authorityCalls(agent, deployment.authorityModule, signer.address, boundedScope, true);
    return this.persistOperation({
      id: operationId(agent, 'provision'),
      kind: 'provision',
      agent,
      chainId: MAINNET_CHAIN_ID,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: deployment.smartAccount,
      authorityModule: deployment.authorityModule,
      signerAddress: signer.address,
      roleKey: authority.roleKey,
      calls: [...deployment.calls, ...authority.calls],
      scope: authority.scope,
      validUntil: 0,
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async issueSession(agent: string, scope: SessionScope, ttlMs: number): Promise<PreparedKeyOperation> {
    if (ttlMs !== 0) throw new Error('Choose Until revoked; finite TTL is not advertised without on-chain expiry enforcement.');
    const boundedScope = normalizeScope(scope);
    const account = this.state.accounts[agent];
    if (!account?.deployed || account.status !== 'active') throw new Error('Agent Safe must be verified on-chain before authority can be issued.');
    if (account.sessions.some(sessionActive)) throw new Error('This signer already has active authority. Rotate the current authority instead.');
    const signer = this.options.ensureSigner(agent);
    const authority = this.authorityCalls(agent, account.authorityModule, signer.address, boundedScope, true);
    return this.persistOperation({
      id: operationId(agent, 'issue'),
      kind: 'issue',
      agent,
      chainId: account.chainId,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: account.smartAccount,
      authorityModule: account.authorityModule,
      signerAddress: signer.address,
      roleKey: authority.roleKey,
      calls: authority.calls,
      scope: authority.scope,
      validUntil: 0,
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async rotateSession(agent: string, sessionId: string, scope: SessionScope, ttlMs: number): Promise<PreparedKeyOperation> {
    if (ttlMs !== 0) throw new Error('Choose Until revoked; finite TTL is not advertised without on-chain expiry enforcement.');
    const boundedScope = normalizeScope(scope);
    const account = this.state.accounts[agent];
    const previous = account?.sessions.find((session) => session.id === sessionId && sessionActive(session));
    if (!account?.deployed || !previous) throw new Error('The active session selected for rotation was not found.');
    const signer = this.options.rotateSigner(agent);
    const authority = this.authorityCalls(agent, account.authorityModule, signer.address, boundedScope, true);
    const revoke = this.authorityCalls(agent, account.authorityModule, previous.address, previous.scope, false);
    return this.persistOperation({
      id: operationId(agent, 'rotate'),
      kind: 'rotate',
      agent,
      chainId: account.chainId,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: account.smartAccount,
      authorityModule: account.authorityModule,
      signerAddress: signer.address,
      roleKey: authority.roleKey,
      calls: [...authority.calls, ...revoke.calls],
      scope: authority.scope,
      validUntil: 0,
      previousSessionId: sessionId,
      revokedSignerAddresses: [previous.address],
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async revokeSession(agent: string, sessionId: string): Promise<PreparedKeyOperation> {
    const account = this.state.accounts[agent];
    const session = account?.sessions.find((candidate) => candidate.id === sessionId && sessionActive(candidate));
    if (!account?.deployed || !session) throw new Error('The active session selected for revocation was not found.');
    const revoke = this.authorityCalls(agent, account.authorityModule, session.address, session.scope, false);
    return this.persistOperation({
      id: operationId(agent, 'revoke'),
      kind: 'revoke',
      agent,
      chainId: account.chainId,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: account.smartAccount,
      authorityModule: account.authorityModule,
      signerAddress: session.address,
      roleKey: revoke.roleKey,
      calls: revoke.calls,
      previousSessionId: sessionId,
      revokedSignerAddresses: [session.address],
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async inspectAssets(agent: string): Promise<AssetGuardReport> {
    const account = this.assemble(agent);
    if (!account.deployed || !isAddress(account.smartAccount) || account.smartAccount === ZeroAddress) {
      return {
        status: 'clear',
        checkedAt: Date.now(),
        chainId: account.chainId,
        safeAddress: account.smartAccount,
        nativeBalanceWei: '0',
        tokenCount: 0,
        source: 'rpc',
        message: 'No deployed agent Safe exists, so there are no on-chain assets to strand.',
      };
    }
    return this.options.inspectAssets(account.chainId, account.smartAccount);
  }

  async revokeAccount(agent: string): Promise<PreparedKeyOperation> {
    const account = this.state.accounts[agent];
    if (!account?.deployed || account.status === 'revoked') throw new Error('Agent authority is already revoked or not deployed.');
    const sessions = account.sessions.filter(sessionActive);
    if (!sessions.length) throw new Error('No active on-chain authority exists for this agent.');
    const calls = sessions.flatMap((session) => this.authorityCalls(agent, account.authorityModule, session.address, session.scope, false).calls);
    return this.persistOperation({
      id: operationId(agent, 'revoke-account'),
      kind: 'revoke-account',
      agent,
      chainId: account.chainId,
      rootSafe: ROOT_AGENT_SAFE_ADDRESS,
      smartAccount: account.smartAccount,
      authorityModule: account.authorityModule,
      calls,
      revokedSignerAddresses: sessions.map((session) => session.address),
      status: 'prepared',
      createdAt: Date.now(),
      expiresAt: Date.now() + OPERATION_TTL_MS,
    });
  }

  async restoreAccount(agent: string): Promise<AgentAccount> {
    const account = this.state.accounts[agent];
    if (!account?.deployed || account.status !== 'revoked') throw new Error('Only a verified revoked Safe can be restored.');
    throw new Error('Restoration requires issuing a new scoped signer; revoked role membership is never re-enabled implicitly.');
  }

  recordSubmission(operationIdInput: string, submissionId: string, chainId: number, rootSafe: string): PreparedKeyOperation {
    const operation = this.state.operations[operationIdInput];
    if (!operation) throw new Error('Prepared key operation was not found.');
    if (operation.status !== 'prepared') throw new Error(`Key operation is already ${operation.status}.`);
    if (operation.expiresAt <= Date.now()) {
      operation.status = 'expired';
      this.save();
      throw new Error('Prepared key operation expired; prepare a fresh proposal.');
    }
    if (operation.chainId !== chainId) throw new Error('Connected chain does not match the prepared key operation.');
    if (getAddress(rootSafe) !== getAddress(operation.rootSafe)) throw new Error('Connected account is not the configured root Safe.');
    if (!submissionId.trim()) throw new Error('Wallet did not return a submission identifier.');
    operation.status = 'submitted';
    operation.submissionId = submissionId.trim();
    operation.submittedAt = Date.now();
    this.save();
    return operation;
  }

  async finalizeOperation(operationIdInput: string, txHashes: string[]): Promise<AgentAccount> {
    const operation = this.state.operations[operationIdInput];
    if (!operation || operation.status !== 'submitted') throw new Error('A submitted key operation is required.');
    const hashes = Array.from(new Set(txHashes.map((hash) => hash.trim()).filter((hash) => /^0x[0-9a-f]{64}$/i.test(hash))));
    if (!hashes.length) throw new Error('Wallet call status did not include a transaction receipt yet.');
    for (const hash of hashes) {
      const receipt = JSON.parse(await this.options.rpcRead(operation.chainId, 'eth_getTransactionReceipt', [hash])) as { status?: string } | null;
      if (!receipt || receipt.status !== '0x1') throw new Error(`Transaction ${hash} is not confirmed successfully.`);
    }
    if (operation.kind === 'deploy' || operation.kind === 'provision') {
      const safeCode = await this.options.rpcRead(operation.chainId, 'eth_getCode', [operation.smartAccount, 'latest']);
      const rolesCode = await this.options.rpcRead(operation.chainId, 'eth_getCode', [operation.authorityModule, 'latest']);
      if (safeCode === '0x' || rolesCode === '0x') throw new Error('Confirmed receipt did not produce the expected Safe and Roles contracts.');
      const moduleEnabled = await this.options.rpcRead(operation.chainId, 'eth_call', [{
        to: operation.smartAccount,
        data: SAFE_SETUP_INTERFACE.encodeFunctionData('isModuleEnabled', [operation.authorityModule]),
      }, 'latest']);
      const avatarResult = await this.options.rpcRead(operation.chainId, 'eth_call', [{
        to: operation.authorityModule,
        data: ROLES_INTERFACE.encodeFunctionData('avatar'),
      }, 'latest']);
      const targetResult = await this.options.rpcRead(operation.chainId, 'eth_call', [{
        to: operation.authorityModule,
        data: ROLES_INTERFACE.encodeFunctionData('target'),
      }, 'latest']);
      const [avatar] = ROLES_INTERFACE.decodeFunctionResult('avatar', avatarResult) as unknown as [string];
      const [target] = ROLES_INTERFACE.decodeFunctionResult('target', targetResult) as unknown as [string];
      if (BigInt(moduleEnabled) === 0n) throw new Error('Confirmed Safe has not enabled the expected Roles module.');
      if (getAddress(avatar) !== getAddress(operation.smartAccount) || getAddress(target) !== getAddress(operation.smartAccount)) {
        throw new Error('Confirmed Roles module is not bound to the expected agent Safe.');
      }
    }
    if (operation.signerAddress) {
      const membership = await this.options.rpcRead(operation.chainId, 'eth_call', [{
        to: operation.authorityModule,
        data: ROLES_INTERFACE.encodeFunctionData('isModuleEnabled', [operation.signerAddress]),
      }, 'latest']);
      const enabled = BigInt(membership) !== 0n;
      const expected = operation.kind !== 'revoke';
      if (enabled !== expected) throw new Error('On-chain role membership does not match the submitted lifecycle change.');
    }
    for (const revokedSigner of operation.revokedSignerAddresses ?? []) {
      const membership = await this.options.rpcRead(operation.chainId, 'eth_call', [{
        to: operation.authorityModule,
        data: ROLES_INTERFACE.encodeFunctionData('isModuleEnabled', [revokedSigner]),
      }, 'latest']);
      if (BigInt(membership) !== 0n) throw new Error(`Revoked signer ${revokedSigner} is still enabled on-chain.`);
    }
    const account = this.state.accounts[operation.agent] ?? {
      agent: operation.agent,
      ensName: agentEnsName(operation.agent),
      smartAccount: operation.smartAccount,
      authorityModule: operation.authorityModule,
      owner: operation.rootSafe,
      chainId: operation.chainId,
      deployed: false,
      status: 'draft' as const,
      sessions: [],
    };
    account.smartAccount = operation.smartAccount;
    account.authorityModule = operation.authorityModule;
    account.deployed = true;
    if (operation.kind === 'revoke-account') {
      account.status = 'revoked';
      account.revokedAt = Date.now();
      account.sessions = account.sessions.map((session) => sessionActive(session) ? { ...session, status: 'revoked' } : session);
    } else {
      account.status = 'active';
      account.revokedAt = undefined;
    }
    if (operation.kind === 'revoke' && operation.previousSessionId) {
      account.sessions = account.sessions.map((session) => session.id === operation.previousSessionId ? { ...session, status: 'revoked' } : session);
    }
    if (operation.kind === 'rotate' && operation.previousSessionId) {
      account.sessions = account.sessions.map((session) => session.id === operation.previousSessionId ? { ...session, status: 'revoked' } : session);
    }
    if ((operation.kind === 'provision' || operation.kind === 'issue' || operation.kind === 'rotate') && operation.signerAddress && operation.scope) {
      account.sessions.push({
        id: `sess_${operation.id}`,
        agent: operation.agent,
        address: operation.signerAddress,
        scope: operation.scope,
        createdAt: operation.completedAt ?? Date.now(),
        validUntil: 0,
        status: 'active',
      });
    }
    operation.status = 'executed';
    operation.completedAt = Date.now();
    this.state.accounts[operation.agent] = account;
    this.save();
    return this.assemble(operation.agent);
  }
}
