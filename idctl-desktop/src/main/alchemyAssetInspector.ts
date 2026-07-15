import type { AssetGuardReport } from '../../../idctl/src/keys/types.ts';

type FetchLike = typeof fetch;

interface InspectAlchemyAssetsInput {
  rpcUrl: string;
  safeAddress: string;
  chainId: number;
  fetcher?: FetchLike;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface TokenBalance {
  contractAddress?: string;
  tokenBalance?: string;
  error?: string | null;
}

interface TokenBalancePage {
  tokenBalances?: TokenBalance[];
  pageKey?: string;
}

function validAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(value);
}

function nftOwnerUrl(rpcUrl: string, owner: string): string {
  const url = new URL(rpcUrl);
  const match = url.pathname.match(/^\/v2\/([^/]+)\/?$/);
  if (!match?.[1] || !/\.g\.alchemy\.com$/i.test(url.hostname)) {
    throw new Error('Full asset inspection requires an Alchemy v2 RPC endpoint.');
  }
  url.pathname = `/nft/v3/${match[1]}/getNFTsForOwner`;
  url.search = '';
  url.searchParams.set('owner', owner);
  url.searchParams.set('withMetadata', 'false');
  url.searchParams.set('pageSize', '1');
  return url.toString();
}

async function rpc<T>(fetcher: FetchLike, rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetcher(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as RpcEnvelope<T> | null;
  if (!response.ok || body?.error || body?.result == null) {
    throw new Error(body?.error?.message ?? `${method} returned HTTP ${response.status}`);
  }
  return body.result;
}

function nonZeroHex(value: string | undefined): boolean {
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) > 0n;
}

export async function inspectAlchemyAssets(input: InspectAlchemyAssetsInput): Promise<AssetGuardReport> {
  const { rpcUrl, safeAddress, chainId, fetcher = fetch } = input;
  const checkedAt = Date.now();
  if (!validAddress(safeAddress)) {
    return { status: 'unknown', checkedAt, chainId, safeAddress, source: 'indexer', message: 'Safe address is invalid.' };
  }
  try {
    const nativeBalanceWei = BigInt(await rpc<string>(fetcher, rpcUrl, 'eth_getBalance', [safeAddress, 'latest'])).toString();
    let pageKey: string | undefined;
    let erc20Count = 0;
    for (let page = 0; page < 100; page += 1) {
      const options = { maxCount: 100, ...(pageKey ? { pageKey } : {}) };
      const result = await rpc<TokenBalancePage>(fetcher, rpcUrl, 'alchemy_getTokenBalances', [safeAddress, 'erc20', options]);
      if (!Array.isArray(result.tokenBalances)) throw new Error('Token API returned no balance list.');
      for (const balance of result.tokenBalances) {
        if (balance.error) throw new Error(`Token balance failed for ${balance.contractAddress ?? 'unknown contract'}.`);
        if (nonZeroHex(balance.tokenBalance)) erc20Count += 1;
      }
      pageKey = result.pageKey;
      if (!pageKey) break;
      if (page === 99) throw new Error('Token balance pagination exceeded the inspection limit.');
    }

    const nftResponse = await fetcher(nftOwnerUrl(rpcUrl, safeAddress), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const nftBody = await nftResponse.json().catch(() => null) as { totalCount?: number; ownedNfts?: unknown[]; error?: string } | null;
    if (!nftResponse.ok || nftBody?.error || !Number.isSafeInteger(nftBody?.totalCount) || (nftBody?.totalCount ?? -1) < 0) {
      throw new Error(nftBody?.error ?? `NFT API returned HTTP ${nftResponse.status}`);
    }
    const nftCount = nftBody?.totalCount ?? 0;
    const tokenCount = erc20Count + nftCount;
    const assetsPresent = BigInt(nativeBalanceWei) > 0n || tokenCount > 0;
    return {
      status: assetsPresent ? 'assets-present' : 'clear',
      checkedAt,
      chainId,
      safeAddress,
      nativeBalanceWei,
      tokenCount,
      erc20Count,
      nftCount,
      source: 'indexer',
      message: `Checked native, ${erc20Count} non-zero ERC-20 contract(s), and ${nftCount} ERC-721/ERC-1155 holding(s).`,
    };
  } catch (error) {
    return {
      status: 'unknown',
      checkedAt,
      chainId,
      safeAddress,
      source: 'indexer',
      message: `Full asset inspection failed closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
