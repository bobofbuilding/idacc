import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { buildSafeRolesExecution, safeRolesRoleKey } from '../src/shared/safeRolesExecution.ts';

const rolesAddress = '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5';
const target = '0x1111111111111111111111111111111111111111';
const roleKey = safeRolesRoleKey('default:coder', 'registry-write');
const scope = { label: 'registry-write', targets: [target], spendLimitWei: '0' };
const call = buildSafeRolesExecution({ rolesAddress, target, data: '0x12345678', valueWei: '0', roleKey, scope });

assert.equal(call.to, rolesAddress);
assert.equal(call.value, '0x0');
assert.match(roleKey, /^0x[0-9a-f]{64}$/);
const iface = new Interface([
  'function execTransactionWithRole(address to,uint256 value,bytes data,uint8 operation,bytes32 roleKey,bool shouldRevert) returns (bool success)',
]);
const decoded = iface.decodeFunctionData('execTransactionWithRole', call.data);
assert.equal(decoded.to, target);
assert.equal(decoded.value, 0n);
assert.equal(decoded.data, '0x12345678');
assert.equal(decoded.operation, 0n);
assert.equal(decoded.roleKey, roleKey);
assert.equal(decoded.shouldRevert, true);

assert.throws(
  () => buildSafeRolesExecution({ rolesAddress, target, data: '0x', valueWei: '1', roleKey, scope }),
  /attested on-chain allowance/,
);
assert.throws(
  () => buildSafeRolesExecution({ rolesAddress, target, data: '0x', valueWei: '0', roleKey, scope: { ...scope, targets: ['*'] } }),
  /concrete target/,
);
assert.throws(
  () => buildSafeRolesExecution({ rolesAddress, target, data: '0x', valueWei: '0', roleKey, scope: { ...scope, targets: ['0x2222222222222222222222222222222222222222'] } }),
  /outside this agent role/,
);

console.log('safe roles execution smoke: ok');
