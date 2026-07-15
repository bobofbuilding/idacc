import { app, safeStorage } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAgentPrivateKey,
  ethereumAddressForPrivateKey,
  signEip1559Transaction,
  signEvmDigest,
  type AgentEip1559Transaction,
} from '../shared/agentSigner.ts';

interface SignerRecord {
  agent: string;
  address: string;
  encryptedPrivateKey: string;
  createdAt: number;
  rotatedAt?: number;
}

interface SignerVaultState {
  schemaVersion: 1;
  signers: Record<string, SignerRecord>;
}

export interface AgentSignerMetadata {
  agent: string;
  address: string;
  createdAt: number;
  rotatedAt?: number;
}

function signerVaultPath(): string {
  return join(app.getPath('userData'), 'keys', 'agent-signers.json');
}

function cleanAgentKey(value: string): string {
  const key = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,159}$/.test(key)) throw new Error('Invalid agent signer key.');
  return key;
}

function emptyState(): SignerVaultState {
  return { schemaVersion: 1, signers: {} };
}

function loadState(): SignerVaultState {
  const file = signerVaultPath();
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SignerVaultState>;
  if (parsed.schemaVersion !== 1 || !parsed.signers || typeof parsed.signers !== 'object') {
    throw new Error('Agent signer vault has an unsupported schema.');
  }
  return parsed as SignerVaultState;
}

function saveState(state: SignerVaultState): void {
  const file = signerVaultPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const pending = `${file}.tmp`;
  writeFileSync(pending, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(pending, 0o600);
  renameSync(pending, file);
  chmodSync(file, 0o600);
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('macOS Keychain-backed encryption is unavailable; refusing to create or use agent signing keys.');
  }
}

function publicMetadata(record: SignerRecord): AgentSignerMetadata {
  return {
    agent: record.agent,
    address: record.address,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
  };
}

function createRecord(agent: string, rotatedAt?: number): SignerRecord {
  requireEncryption();
  const privateKey = createAgentPrivateKey();
  try {
    const address = ethereumAddressForPrivateKey(privateKey);
    const encryptedPrivateKey = safeStorage.encryptString(Buffer.from(privateKey).toString('hex')).toString('base64');
    return { agent, address, encryptedPrivateKey, createdAt: Date.now(), rotatedAt };
  } finally {
    privateKey.fill(0);
  }
}

export function agentSignerVaultStatus(): { available: boolean; backend: string; signerCount: number; error?: string } {
  const available = safeStorage.isEncryptionAvailable();
  if (!available) return { available: false, backend: 'electron-safeStorage', signerCount: 0, error: 'Keychain-backed encryption is unavailable.' };
  try {
    return { available: true, backend: 'electron-safeStorage/macOS-Keychain', signerCount: Object.keys(loadState().signers).length };
  } catch (error) {
    return { available: false, backend: 'electron-safeStorage/macOS-Keychain', signerCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export function ensureAgentSigner(agentInput: string): AgentSignerMetadata {
  const agent = cleanAgentKey(agentInput);
  const state = loadState();
  const existing = state.signers[agent];
  if (existing) return publicMetadata(existing);
  const record = createRecord(agent);
  state.signers[agent] = record;
  saveState(state);
  return publicMetadata(record);
}

export function rotateAgentSigner(agentInput: string): AgentSignerMetadata {
  const agent = cleanAgentKey(agentInput);
  const state = loadState();
  const record = createRecord(agent, Date.now());
  state.signers[agent] = record;
  saveState(state);
  return publicMetadata(record);
}

export function signAgentDigest(agentInput: string, digestHex: string): { address: string; signature: string } {
  requireEncryption();
  const agent = cleanAgentKey(agentInput);
  const record = loadState().signers[agent];
  if (!record) throw new Error(`No signer exists for ${agent}.`);
  if (!/^0x[0-9a-f]{64}$/i.test(digestHex)) throw new Error('Digest must be 32-byte 0x hex.');
  const decrypted = safeStorage.decryptString(Buffer.from(record.encryptedPrivateKey, 'base64'));
  const privateKey = Buffer.from(decrypted, 'hex');
  try {
    if (privateKey.length !== 32 || ethereumAddressForPrivateKey(privateKey).toLowerCase() !== record.address.toLowerCase()) {
      throw new Error('Signer vault integrity check failed.');
    }
    return { address: record.address, signature: signEvmDigest(privateKey, Buffer.from(digestHex.slice(2), 'hex')) };
  } finally {
    privateKey.fill(0);
  }
}

/** Sign a fully priced EIP-1559 transaction without exposing key material. */
export function signAgentTransaction(agentInput: string, input: AgentEip1559Transaction): { address: string; rawTransaction: string; hash: string } {
  requireEncryption();
  const agent = cleanAgentKey(agentInput);
  const record = loadState().signers[agent];
  if (!record) throw new Error(`No signer exists for ${agent}.`);
  const decrypted = safeStorage.decryptString(Buffer.from(record.encryptedPrivateKey, 'base64'));
  const privateKey = Buffer.from(decrypted, 'hex');
  try {
    if (privateKey.length !== 32 || ethereumAddressForPrivateKey(privateKey).toLowerCase() !== record.address.toLowerCase()) {
      throw new Error('Signer vault integrity check failed.');
    }
    return { address: record.address, ...signEip1559Transaction(privateKey, input) };
  } finally {
    privateKey.fill(0);
  }
}
