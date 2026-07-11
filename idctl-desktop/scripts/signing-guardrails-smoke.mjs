import assert from 'node:assert/strict';
import {
  AGENT_BITTREES_SAFE_ADDRESS,
  buildWalletSafeTransaction,
  contractValidationErrors,
  contributorSigningPolicyErrors,
  executionStamp,
  guardedExecutionReady,
} from '../src/shared/signingGuardrails.ts';

const valid = {
  account: AGENT_BITTREES_SAFE_ADDRESS,
  providerChain: '0x2105',
  requiredChain: '0x2105',
  to: '0x1111111111111111111111111111111111111111',
  data: '0x1234',
  valueWei: '0',
};

function simulation(overrides = {}) {
  const input = { ...valid, ...overrides };
  return {
    ok: true,
    stamp: executionStamp(input.requiredChain, input.account, input.to, input.data, input.valueWei),
    message: 'Simulation passed.',
    preview: 'preview',
  };
}

const negativeValidationCases = [
  {
    name: 'no connected wallet',
    input: { ...valid, account: '' },
    expected: /Connect wallet\/Safe first/,
  },
  {
    name: 'connected wallet is not the required Safe',
    input: { ...valid, account: '0x2222222222222222222222222222222222222222' },
    expected: /Connected account must be agent\.bittrees\.eth/,
  },
  {
    name: 'unsupported chain',
    input: { ...valid, requiredChain: '0x539' },
    expected: /Choose a supported chain/,
  },
  {
    name: 'wallet chain unavailable',
    input: { ...valid, providerChain: '' },
    expected: /Wallet chain is not available/,
  },
  {
    name: 'wallet chain mismatch',
    input: { ...valid, providerChain: '0xaa36a7' },
    expected: /Wallet chain must match Base/,
  },
  {
    name: 'invalid target',
    input: { ...valid, to: '0x1234' },
    expected: /Contract target must be a 20-byte 0x address/,
  },
  {
    name: 'invalid calldata',
    input: { ...valid, data: '0xabc' },
    expected: /Calldata must be 0x-prefixed even-length hex/,
  },
  {
    name: 'invalid wei value',
    input: { ...valid, valueWei: '-1' },
    expected: /Value must be a non-negative integer in wei/,
  },
];

for (const tc of negativeValidationCases) {
  const errors = contractValidationErrors(
    tc.input.account,
    tc.input.providerChain,
    tc.input.requiredChain,
    tc.input.to,
    tc.input.data,
    tc.input.valueWei,
  );
  assert.match(errors.join(' '), tc.expected, `${tc.name} should fail validation`);

  const readiness = guardedExecutionReady({
    ...tc.input,
    simulation: simulation(tc.input),
    confirmed: true,
  });
  assert.equal(readiness.ok, false, `${tc.name} should not become submit-ready`);
  assert.equal(readiness.reason, 'validation_failed', `${tc.name} should fail before simulation or confirmation checks`);
}

const missingSimulation = guardedExecutionReady({ ...valid, simulation: null, confirmed: true });
assert.equal(missingSimulation.ok, false);
assert.equal(missingSimulation.reason, 'simulation_required');
assert.match(missingSimulation.errors.join(' '), /Run a successful simulation/);

const failedSimulation = guardedExecutionReady({
  ...valid,
  simulation: { ...simulation(), ok: false, message: 'revert', preview: 'revert' },
  confirmed: true,
});
assert.equal(failedSimulation.ok, false);
assert.equal(failedSimulation.reason, 'simulation_required');

const staleSimulation = guardedExecutionReady({
  ...valid,
  data: '0x5678',
  simulation: simulation(),
  confirmed: true,
});
assert.equal(staleSimulation.ok, false);
assert.equal(staleSimulation.reason, 'simulation_required');

const missingConfirmation = guardedExecutionReady({
  ...valid,
  simulation: simulation(),
  confirmed: false,
});
assert.equal(missingConfirmation.ok, false);
assert.equal(missingConfirmation.reason, 'human_confirmation_required');
assert.match(missingConfirmation.errors.join(' '), /Human confirmation is required/);

const policyCases = [
  {
    name: 'unlimited allowance bypass',
    policy: { boundary: 'live', intent: 'live', operation: 'approve', approval: { unlimited: true } },
    expected: /Unlimited allowance approvals are not allowed/,
  },
  {
    name: 'admin role bypass',
    policy: { boundary: 'live', intent: 'live', operation: 'grant_role', role: { admin: true } },
    expected: /Admin-role grants are not allowed/,
  },
  {
    name: 'overspend beyond cap',
    policy: { boundary: 'live', intent: 'live', operation: 'spend', spendCapWei: '100', spendWei: '101' },
    expected: /Requested spend exceeds/,
  },
  {
    name: 'read-vs-live boundary violation',
    policy: { boundary: 'read', intent: 'live', operation: 'spend', spendCapWei: '100', spendWei: '1' },
    expected: /READ-scoped requests cannot request LIVE signing/,
  },
];

for (const tc of policyCases) {
  const errors = contributorSigningPolicyErrors(tc.policy);
  assert.match(errors.join(' '), tc.expected, `${tc.name} should fail policy validation`);

  const readiness = guardedExecutionReady({
    ...valid,
    simulation: simulation(),
    confirmed: true,
    policy: tc.policy,
  });
  assert.equal(readiness.ok, false, `${tc.name} should not become submit-ready`);
  assert.equal(readiness.reason, 'policy_denied', `${tc.name} should fail before wallet/Safe transaction construction`);
}

const tx = buildWalletSafeTransaction(valid.to, ' ', '123');
assert.deepEqual(tx, {
  from: AGENT_BITTREES_SAFE_ADDRESS,
  to: valid.to,
  data: '0x',
  value: '0x7b',
});

const ready = guardedExecutionReady({
  ...valid,
  simulation: simulation(),
  confirmed: true,
});
assert.equal(ready.ok, true);
assert.equal(ready.tx.from, AGENT_BITTREES_SAFE_ADDRESS);
assert.equal(ready.tx.to, valid.to);
assert.equal(ready.tx.data, valid.data);
assert.equal(ready.tx.value, '0x0');
assert.equal(ready.stamp, simulation().stamp);

console.log(`SIGNING_GUARDRAILS_SMOKE ${JSON.stringify({
  negativeCases: negativeValidationCases.length + 4 + policyCases.length,
  positiveCases: 2,
  broadcastFree: true,
}, null, 2)}`);
