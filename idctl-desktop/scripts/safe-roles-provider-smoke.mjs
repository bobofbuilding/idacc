import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, getBytes, getCreate2Address, id, keccak256, solidityPacked } from 'ethers';

const root = mkdtempSync(join(tmpdir(), 'idacc-safe-roles-'));
const signer = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'ab'.repeat(32)}`;

try {
  const { SafeRolesKeyProvider } = await import('../src/main/safeRolesProvider.ts');
  let expectedSafe = '';
  const provider = new SafeRolesKeyProvider({
    statePath: () => join(root, 'safe-roles-state.json'),
    rpcRead: async (_chainId, method, params) => {
      if (method === 'eth_getTransactionReceipt') return JSON.stringify({ status: '0x1' });
      if (method === 'eth_getCode') return '0x6001600055';
      if (method === 'eth_call') {
        const proxyCreationCode = '0x6080604052348015600f57600080fd5b50600080fd';
        const data = params?.[0]?.data ?? '';
        if (data === '0x53e5d935') return AbiCoder.defaultAbiCoder().encode(['bytes'], [proxyCreationCode]);
        if (data === id('avatar()').slice(0, 10) || data === id('target()').slice(0, 10)) {
          return AbiCoder.defaultAbiCoder().encode(['address'], [expectedSafe]);
        }
        return `0x${'0'.repeat(63)}1`;
      }
      throw new Error(`unexpected read: ${method}`);
    },
    ensureSigner: () => ({ address: signer }),
    rotateSigner: () => ({ address: '0x3333333333333333333333333333333333333333' }),
    inspectAssets: async () => ({
      status: 'clear',
      checkedAt: Date.now(),
      chainId: 1,
      safeAddress: target,
      nativeBalanceWei: '0',
      tokenCount: 0,
      source: 'rpc',
      message: 'clear',
    }),
  });

  assert.equal(provider.capabilities().provider, 'safe-roles');
  assert.equal(provider.capabilities().live, true);
  await assert.rejects(
    provider.provisionAccount('default:lead', { label: 'unsafe', targets: ['*'], functions: ['setValue(uint256)'], spendLimitWei: '0' }, 0),
    /concrete target contract addresses/,
  );
  await assert.rejects(
    provider.provisionAccount('default:lead', { label: 'unsafe', targets: [target], functions: [], spendLimitWei: '0' }, 0),
    /explicit function signatures/,
  );
  await assert.rejects(
    provider.provisionAccount('default:lead', { label: 'unsafe', targets: [target], functions: ['setValue(uint256)'], spendLimitWei: '1' }, 0),
    /zero native-token value/,
  );

  const operation = await provider.provisionAccount(
    'default:lead',
    { label: 'registry-write', targets: [target], functions: ['setValue(uint256)'], spendLimitWei: '0' },
    0,
  );
  expectedSafe = operation.smartAccount;
  assert.equal(operation.status, 'prepared');
  assert.equal(operation.kind, 'provision');
  assert.ok(operation.calls.length >= 6, 'deployment and scoped authority must be one atomic call set');
  assert.ok(operation.calls.every((call) => call.value === '0x0'));
  assert.ok(operation.calls.slice(1).every((call) => call.to === operation.authorityModule));
  assert.equal(operation.scope?.targets[0], target);
  assert.deepEqual(operation.scope?.functions, ['setValue(uint256)']);

  const safeFactory = new Interface(['function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce)']);
  const safeSetup = new Interface(['function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)']);
  const moduleSetup = new Interface(['function createAndAddModules(address proxyFactory,bytes data)']);
  const moduleFactory = new Interface(['function deployModule(address masterCopy,bytes initializer,uint256 saltNonce) returns (address proxy)']);
  const [, safeInitializer] = safeFactory.decodeFunctionData('createProxyWithNonce', operation.calls[0].data);
  const decodedSafeSetup = safeSetup.decodeFunctionData('setup', safeInitializer);
  const [, packedDeployment] = moduleSetup.decodeFunctionData('createAndAddModules', decodedSafeSetup.data);
  const packedBytes = getBytes(packedDeployment);
  const deploymentLength = Number(BigInt(`0x${Buffer.from(packedBytes.slice(0, 32)).toString('hex')}`));
  const deploymentData = `0x${Buffer.from(packedBytes.slice(32, 32 + deploymentLength)).toString('hex')}`;
  const [rolesMastercopy, rolesInitializer, rolesNonce] = moduleFactory.decodeFunctionData('deployModule', deploymentData);
  const rolesSalt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(rolesInitializer), rolesNonce]));
  const rolesProxyCode = `0x602d8060093d393df3363d3d373d3d3d363d73${rolesMastercopy.toLowerCase().slice(2)}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(
    operation.authorityModule,
    getCreate2Address(operation.smartAccount, rolesSalt, keccak256(rolesProxyCode)),
    'delegatecalled module deployment must use the agent Safe as the CREATE2 deployer',
  );

  assert.throws(
    () => provider.recordSubmission(operation.id, 'batch-1', 11155111, operation.rootSafe),
    /chain does not match/,
  );
  const submitted = provider.recordSubmission(operation.id, 'batch-1', 1, operation.rootSafe);
  assert.equal(submitted.status, 'submitted');

  const account = await provider.finalizeOperation(operation.id, [txHash]);
  assert.equal(account.deployed, true);
  assert.equal(account.status, 'active');
  assert.equal(account.sessions.length, 1);
  assert.equal(account.sessions[0].address, signer);
  assert.equal(account.pendingOperation, undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('safe roles provider smoke: ok');
