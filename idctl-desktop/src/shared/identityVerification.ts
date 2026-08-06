import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Agent } from '../../../idctl/src/api/types.ts';

export const ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const ENS_RESOLVER_SELECTOR = '0178b8bf';
export const ENS_ADDR_SELECTOR = '3b3b57de';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ensNamehash(name: string): string {
  let node: Uint8Array<ArrayBufferLike> = new Uint8Array(32);
  const labels = String(name).trim().replace(/\.$/, '').toLowerCase().split('.').filter(Boolean);
  for (const label of labels.reverse()) {
    const labelHash = keccak_256(new TextEncoder().encode(label));
    const joined = new Uint8Array(64);
    joined.set(node, 0);
    joined.set(labelHash, 32);
    node = keccak_256(joined);
  }
  return `0x${bytesToHex(node)}`;
}

export function encodeEnsCall(selector: string, name: string): string {
  const clean = selector.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(clean)) throw new Error('ENS selector must be four bytes.');
  return `0x${clean}${ensNamehash(name).slice(2)}`;
}

export function decodeAbiAddress(data: string): string | null {
  const clean = String(data).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64,}$/.test(clean)) return null;
  const address = `0x${clean.slice(24, 64)}`;
  return /^0x0{40}$/i.test(address) ? null : address.toLowerCase();
}

export function hasRuntimeCode(code: string): boolean {
  return /^0x[0-9a-f]{2,}$/i.test(code) && !/^0x0*$/i.test(code);
}

export type EnsBindingState = 'verified' | 'mismatch' | 'unbound' | 'missing';
export type IdentityStandardEvidenceState = 'verified' | 'warn' | 'missing' | 'self';

export type IdentityStandardEvidence = {
  ensBinding: IdentityStandardEvidenceState;
  ensip24: IdentityStandardEvidenceState;
  erc8004: IdentityStandardEvidenceState;
  erc8048: IdentityStandardEvidenceState;
  erc8049: IdentityStandardEvidenceState;
  b20: IdentityStandardEvidenceState;
};

/**
 * Keep generic public evidence distinct from standard conformance. A matching
 * ENS address record can verify that one binding, but neither it nor deployed
 * bytecode can promote draft metadata standards beyond Manager-declared
 * evidence without canonical targets and a versioned attestation contract.
 */
export function classifyIdentityStandardEvidence(input: {
  hasAgent: boolean;
  hasDomain: boolean;
  hasWallet: boolean;
  hasSmartAccount: boolean;
  ensBindingVerified: boolean;
  ensip24Declared: boolean;
  erc8004Declared: boolean;
  erc8048Declared: boolean;
  erc8049Declared: boolean;
  b20Declared: boolean;
}): IdentityStandardEvidence {
  if (!input.hasAgent) {
    return {
      ensBinding: 'missing',
      ensip24: 'missing',
      erc8004: 'missing',
      erc8048: 'missing',
      erc8049: 'missing',
      b20: 'missing',
    };
  }
  return {
    ensBinding: input.ensBindingVerified ? 'verified' : input.hasDomain ? 'warn' : 'missing',
    ensip24: input.ensip24Declared ? 'self' : input.hasDomain ? 'warn' : 'missing',
    erc8004: input.erc8004Declared ? 'self' : input.hasWallet ? 'warn' : 'missing',
    erc8048: input.erc8048Declared ? 'self' : input.hasDomain || input.hasWallet ? 'warn' : 'missing',
    erc8049: input.erc8049Declared ? 'self' : input.hasSmartAccount ? 'warn' : 'missing',
    b20: input.b20Declared ? 'self' : 'warn',
  };
}

/**
 * Resolver output is only a verified identity binding when it matches at
 * least one declared controller/account address. Resolution by itself is
 * public evidence, not proof that the selected Agent owns the name.
 */
export function classifyEnsBinding(
  resolvedAddress: string | null | undefined,
  expectedAddresses: Iterable<string>,
): EnsBindingState {
  const resolved = String(resolvedAddress ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(resolved) || /^0x0{40}$/.test(resolved)) return 'missing';
  const expected = new Set(
    [...expectedAddresses]
      .map((address) => String(address).trim().toLowerCase())
      .filter((address) => /^0x[0-9a-f]{40}$/.test(address)),
  );
  if (!expected.size) return 'unbound';
  return expected.has(resolved) ? 'verified' : 'mismatch';
}

export function registeredIdentityDomain(agent: Agent | undefined): string {
  if (!agent) return '';
  const meta = agent.metadata && typeof agent.metadata === 'object'
    ? agent.metadata as Record<string, unknown>
    : {};
  const values = [
    agent.idchain_domain,
    meta.idchain_domain,
    (agent as Agent & { domain?: unknown }).domain,
  ];
  return values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .find(Boolean) ?? '';
}

export function identityRegisterNoop(agent: Agent | undefined): { noop: boolean; domain?: string } {
  const domain = registeredIdentityDomain(agent);
  return domain ? { noop: true, domain } : { noop: false };
}
