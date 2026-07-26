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
