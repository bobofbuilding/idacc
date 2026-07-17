import assert from 'node:assert/strict';

import {
  activityAddressExplorerUrl,
  activityAddressLabel,
  broadcasterActivityScope,
  buildBroadcasterAddressHints,
  extractPublicEvmAddresses,
  normalizeActivityText,
  shortPublicAddress,
} from '../src/renderer/activityFeed.ts';

const address = '0x00EC83EFd523767F5E89c93713729633Ab436dF3';
const message = `BLOCKED: broadcaster EOA ${address} still has 0 wei on Sepolia.`;

assert.deepEqual(extractPublicEvmAddresses(message), [address]);
assert.equal(extractPublicEvmAddresses(`${address} ${address}`).length, 1);
assert.deepEqual(extractPublicEvmAddresses(`private-like 0x${'a'.repeat(64)}`), []);
assert.equal(activityAddressLabel(message), 'broadcaster');
assert.equal(activityAddressExplorerUrl(message, address), `https://sepolia.etherscan.io/address/${address}`);
assert.equal(activityAddressExplorerUrl(`Base Sepolia ${address}`, address), `https://sepolia.basescan.org/address/${address}`);
assert.equal(shortPublicAddress(address), '0x00EC83…436dF3');
assert.equal(normalizeActivityText('one\n\n two'), 'one two');

const hints = buildBroadcasterAddressHints([
  { team: 'onchain-execution', actor: 'onchain-lead', timestamp: 10, text: 'broadcaster EOA is unfunded on Sepolia' },
  { team: 'onchain-execution', actor: 'onchain-lead', timestamp: 20, text: `broadcaster EOA ${address} has 0 wei` },
  { team: 'other-team', actor: 'onchain-lead', timestamp: 30, text: `broadcaster EOA 0x${'b'.repeat(40)}` },
]);
assert.deepEqual(hints.get(broadcasterActivityScope('onchain-execution', 'onchain-lead')), [address]);
assert.notDeepEqual(
  hints.get(broadcasterActivityScope('onchain-execution', 'onchain-lead')),
  hints.get(broadcasterActivityScope('other-team', 'onchain-lead')),
  'broadcaster hints must not cross team scope',
);

console.log('activity feed address and action guards ok');
