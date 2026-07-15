import assert from 'node:assert/strict';
import { inspectAlchemyAssets } from '../src/main/alchemyAssetInspector.ts';

const safeAddress = '0x1111111111111111111111111111111111111111';
const calls = [];
const fetcher = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
  if (String(url).includes('/nft/v3/')) {
    return new Response(JSON.stringify({ totalCount: 2, ownedNfts: [{}] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const request = JSON.parse(String(init.body));
  const result = request.method === 'eth_getBalance'
    ? '0x1'
    : { tokenBalances: [{ contractAddress: '0x2222222222222222222222222222222222222222', tokenBalance: '0x2' }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const report = await inspectAlchemyAssets({
  rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/test-key',
  safeAddress,
  chainId: 1,
  fetcher,
});
assert.equal(report.status, 'assets-present');
assert.equal(report.nativeBalanceWei, '1');
assert.equal(report.erc20Count, 1);
assert.equal(report.nftCount, 2);
assert.equal(report.tokenCount, 3);
assert.equal(calls.length, 3);
assert.match(calls[2].url, /\/nft\/v3\/test-key\/getNFTsForOwner/);

const blocked = await inspectAlchemyAssets({
  rpcUrl: 'https://example.invalid/v2/test-key',
  safeAddress,
  chainId: 1,
  fetcher,
});
assert.equal(blocked.status, 'unknown');
assert.match(blocked.message, /failed closed/i);

console.log('alchemy asset inspector smoke: ok');
