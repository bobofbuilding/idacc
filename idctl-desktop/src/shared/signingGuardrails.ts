import type { ConfiguredRootIdentity } from '../../../idctl/src/settings/schema.ts';

export const ROOT_SAFE_THRESHOLD_REPAIR_CALLDATA = '0x694e80c30000000000000000000000000000000000000000000000000000000000000002';

export const EXECUTION_CHAINS = [
  { chainId: 1, hex: '0x1', name: 'Ethereum mainnet' },
  { chainId: 8453, hex: '0x2105', name: 'Base' },
  { chainId: 11155111, hex: '0xaa36a7', name: 'Ethereum Sepolia' },
  { chainId: 84532, hex: '0x14a34', name: 'Base Sepolia' },
] as const;

export type ExecutionChain = (typeof EXECUTION_CHAINS)[number];

export interface ContractSimulation {
  ok: boolean;
  stamp: string;
  message: string;
  preview: string;
}

export interface GuardedExecutionInput {
  rootIdentity: ConfiguredRootIdentity | null;
  account: string;
  providerChain: string;
  requiredChain: string;
  to: string;
  data: string;
  valueWei: string;
  simulation?: ContractSimulation | null;
  confirmed: boolean;
  policy?: ContributorSigningPolicy | null;
}

export interface ContributorSigningPolicy {
  boundary: 'read' | 'live';
  intent: 'read' | 'prepare' | 'live';
  operation: 'read' | 'spend' | 'approve' | 'grant_role';
  approval?: {
    unlimited?: boolean;
    amountWei?: string;
  };
  role?: {
    admin?: boolean;
  };
  spendCapWei?: string;
  spendWei?: string;
}

export interface GuardedExecutionTx {
  from: string;
  to: string;
  data: string;
  value: string;
}

export type GuardedExecutionResult =
  | {
    ok: true;
    stamp: string;
    tx: GuardedExecutionTx;
    preview: string;
  }
  | {
    ok: false;
    reason:
      | 'validation_failed'
      | 'policy_denied'
      | 'simulation_required'
      | 'human_confirmation_required'
      | 'invalid_value';
    errors: string[];
  };

export function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Normalize EIP-1193 and WalletConnect chain values to canonical 0x hex. */
export function normalizeChainHex(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? `0x${value.toString(16)}` : '';
  }
  if (typeof value === 'bigint') return value > 0n ? `0x${value.toString(16)}` : '';
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (/^0x[0-9a-f]+$/.test(raw)) return `0x${BigInt(raw).toString(16)}`;
  const tail = raw.includes(':') ? raw.split(':').pop() ?? '' : raw;
  if (!/^[0-9]+$/.test(tail)) return '';
  const chainId = BigInt(tail);
  return chainId > 0n ? `0x${chainId.toString(16)}` : '';
}

/** The only pre-readiness transaction IDACC allows: root Safe 2-of-2 repair. */
export function isRootSafeThresholdRepair(
  rootIdentity: ConfiguredRootIdentity | null,
  chain: string,
  to: string,
  data: string,
  valueWei: string,
): boolean {
  return Boolean(rootIdentity)
    && chain.trim().toLowerCase() === rootIdentityChainHex(rootIdentity!)
    && sameAddress(to, rootIdentity!.safeAddress)
    && normalizeTxData(data).toLowerCase() === ROOT_SAFE_THRESHOLD_REPAIR_CALLDATA
    && parseWei(valueWei) === 0n;
}

export function isHexCalldata(value: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(value.trim());
}

export function normalizeTxData(value: string): string {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : '0x';
}

export function parseWei(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function weiToHex(value: string): string | null {
  const wei = parseWei(value);
  return wei == null ? null : `0x${wei.toString(16)}`;
}

export function chainByHex(hex: string): ExecutionChain | undefined {
  return EXECUTION_CHAINS.find((chain) => chain.hex.toLowerCase() === hex.trim().toLowerCase());
}

export function rootIdentityChainHex(rootIdentity: ConfiguredRootIdentity): string {
  return `0x${rootIdentity.chainId.toString(16)}`;
}

export function executionStamp(
  rootIdentity: ConfiguredRootIdentity | null,
  chainHex: string,
  account: string,
  to: string,
  data: string,
  valueWei: string,
): string {
  return JSON.stringify({
    chainHex: chainHex.toLowerCase(),
    from: account.toLowerCase(),
    safe: rootIdentity?.safeAddress.toLowerCase() ?? '',
    ensRoot: rootIdentity?.ensRoot.toLowerCase() ?? '',
    to: to.trim().toLowerCase(),
    data: normalizeTxData(data).toLowerCase(),
    valueWei: valueWei.trim(),
  });
}

export function formatExecutionPreview(
  rootIdentity: ConfiguredRootIdentity | null,
  chainHex: string,
  account: string,
  to: string,
  data: string,
  valueWei: string,
): string {
  const chain = chainByHex(chainHex);
  return JSON.stringify({
    chain: chain ? `${chain.name} (${chain.hex})` : chainHex,
    safeEns: rootIdentity?.ensRoot ?? 'not configured',
    from: account || 'not connected',
    requiredSafe: rootIdentity?.safeAddress ?? 'not configured',
    to: to.trim() || 'not set',
    valueWei: valueWei.trim() || '0',
    data: normalizeTxData(data),
  }, null, 2);
}

export function contractValidationErrors(
  rootIdentity: ConfiguredRootIdentity | null,
  account: string,
  providerChain: string,
  requiredChain: string,
  to: string,
  data: string,
  valueWei: string,
): string[] {
  const errors: string[] = [];
  const normalizedData = normalizeTxData(data);
  if (!rootIdentity) errors.push('Configure and explicitly enable a root ENS identity and Safe address in Settings first.');
  if (!account) errors.push('Connect wallet/Safe first.');
  else if (rootIdentity && !sameAddress(account, rootIdentity.safeAddress)) {
    errors.push(`Connected account must be ${rootIdentity.ensRoot} (${rootIdentity.safeAddress}).`);
  }
  if (!chainByHex(requiredChain)) errors.push('Choose a supported chain.');
  else if (rootIdentity && requiredChain.toLowerCase() !== rootIdentityChainHex(rootIdentity)) {
    errors.push(`Transaction chain must match configured root identity chain ${rootIdentity.chainId}.`);
  }
  if (!providerChain) errors.push('Wallet chain is not available.');
  else if (providerChain.toLowerCase() !== requiredChain.toLowerCase()) errors.push(`Wallet chain must match ${chainByHex(requiredChain)?.name ?? requiredChain}.`);
  if (!isEthAddress(to)) errors.push('Contract target must be a 20-byte 0x address.');
  if (!isHexCalldata(normalizedData)) errors.push('Calldata must be 0x-prefixed even-length hex.');
  if (weiToHex(valueWei) == null) errors.push('Value must be a non-negative integer in wei.');
  return errors;
}

export function buildWalletSafeTransaction(
  rootIdentity: ConfiguredRootIdentity | null,
  to: string,
  data: string,
  valueWei: string,
): GuardedExecutionTx | null {
  if (!rootIdentity) return null;
  const value = weiToHex(valueWei);
  if (value == null) return null;
  return {
    from: rootIdentity.safeAddress,
    to: to.trim(),
    data: normalizeTxData(data),
    value,
  };
}

export function contributorSigningPolicyErrors(policy: ContributorSigningPolicy | null | undefined): string[] {
  if (!policy) return [];
  const errors: string[] = [];

  if (policy.boundary === 'read' && policy.intent === 'live') {
    errors.push('READ-scoped requests cannot request LIVE signing or broadcast authority.');
  }

  if (policy.operation === 'approve' && policy.approval?.unlimited) {
    errors.push('Unlimited allowance approvals are not allowed for contributor signing.');
  }

  if (policy.operation === 'grant_role' && policy.role?.admin) {
    errors.push('Admin-role grants are not allowed for contributor signing.');
  }

  if (policy.operation === 'spend') {
    const spend = parseWei(policy.spendWei ?? '');
    const cap = parseWei(policy.spendCapWei ?? '');
    if (spend == null || cap == null) {
      errors.push('Spend requests require valid non-negative spend and cap values.');
    } else if (spend > cap) {
      errors.push('Requested spend exceeds the contributor signing spend cap.');
    }
  }

  return errors;
}

export function guardedExecutionReady(input: GuardedExecutionInput): GuardedExecutionResult {
  const errors = contractValidationErrors(
    input.rootIdentity,
    input.account,
    input.providerChain,
    input.requiredChain,
    input.to,
    input.data,
    input.valueWei,
  );
  if (errors.length) {
    return { ok: false, reason: 'validation_failed', errors };
  }

  const policyErrors = contributorSigningPolicyErrors(input.policy);
  if (policyErrors.length) {
    return { ok: false, reason: 'policy_denied', errors: policyErrors };
  }

  const stamp = executionStamp(input.rootIdentity, input.requiredChain, input.account, input.to, input.data, input.valueWei);
  if (!input.simulation?.ok || input.simulation.stamp !== stamp) {
    return {
      ok: false,
      reason: 'simulation_required',
      errors: ['Run a successful simulation for the current transaction before submit.'],
    };
  }

  if (!input.confirmed) {
    return {
      ok: false,
      reason: 'human_confirmation_required',
      errors: ['Human confirmation is required before wallet/Safe approval.'],
    };
  }

  const tx = buildWalletSafeTransaction(input.rootIdentity, input.to, input.data, input.valueWei);
  if (!tx) {
    return {
      ok: false,
      reason: 'invalid_value',
      errors: ['Value must be a non-negative integer in wei.'],
    };
  }

  return {
    ok: true,
    stamp,
    tx,
    preview: formatExecutionPreview(input.rootIdentity, input.requiredChain, input.account, input.to, input.data, input.valueWei),
  };
}
