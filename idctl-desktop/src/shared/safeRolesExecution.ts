import { Interface, getAddress, id } from 'ethers';
import type { SessionScope } from '../../../idctl/src/keys/types.ts';

const ROLES_INTERFACE = new Interface([
  'function execTransactionWithRole(address to,uint256 value,bytes data,uint8 operation,bytes32 roleKey,bool shouldRevert) returns (bool success)',
]);

export interface SafeRolesExecutionInput {
  rolesAddress: string;
  target: string;
  data: string;
  valueWei: string;
  roleKey: string;
  scope: SessionScope;
}

export interface SafeRolesExecutionCall {
  to: string;
  data: string;
  value: '0x0';
}

function validCalldata(value: string): boolean {
  return /^0x(?:[0-9a-f]{2})*$/i.test(value);
}

function normalizedTargets(scope: SessionScope): string[] {
  if (!scope.targets.length || scope.targets.includes('*')) {
    throw new Error('Live Roles authority requires one or more concrete target addresses.');
  }
  return scope.targets.map((target) => getAddress(target));
}

/** Stable role identifier derived from the scoped agent identity and policy label. */
export function safeRolesRoleKey(agent: string, scopeLabel: string): string {
  const scopedAgent = agent.trim().toLowerCase();
  const label = scopeLabel.trim().toLowerCase();
  if (!scopedAgent || !label) throw new Error('Agent and scope label are required.');
  return id(`idacc:${scopedAgent}:${label}`);
}

/**
 * Build the zero-ETH transaction an agent signer submits to its Roles module.
 * Native value remains disabled until an on-chain Roles allowance is present;
 * an application-only counter is not a production spend guard.
 */
export function buildSafeRolesExecution(input: SafeRolesExecutionInput): SafeRolesExecutionCall {
  const rolesAddress = getAddress(input.rolesAddress);
  const target = getAddress(input.target);
  const targets = normalizedTargets(input.scope);
  if (!targets.some((allowed) => allowed === target)) throw new Error('Target is outside this agent role.');
  if (!/^0x[0-9a-f]{64}$/i.test(input.roleKey)) throw new Error('Role key must be a 32-byte value.');
  if (!validCalldata(input.data)) throw new Error('Role calldata must be even-length 0x hex.');
  if (!/^(0|[1-9][0-9]*)$/.test(input.valueWei)) throw new Error('Role value must be a non-negative integer in wei.');
  if (BigInt(input.valueWei) !== 0n) {
    throw new Error('Native value is blocked until the role has an attested on-chain allowance.');
  }
  return {
    to: rolesAddress,
    data: ROLES_INTERFACE.encodeFunctionData('execTransactionWithRole', [
      target,
      0n,
      input.data,
      0,
      input.roleKey,
      true,
    ]),
    value: '0x0',
  };
}
