const EVM_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

export type ActivityAddressHintSource = {
  team?: string;
  actor?: string;
  timestamp: number;
  text: string;
};

export function normalizeActivityText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractPublicEvmAddresses(value: string): string[] {
  return Array.from(new Set(value.match(EVM_ADDRESS_RE) ?? []));
}

export function broadcasterActivityScope(team?: string, actor?: string): string {
  return `${team ?? ''}:${actor ?? ''}`;
}

export function buildBroadcasterAddressHints(rows: ActivityAddressHintSource[]): Map<string, string[]> {
  const latest = new Map<string, { timestamp: number; addresses: string[] }>();
  for (const row of rows) {
    if (!/broadcaster\s+EOA/i.test(row.text)) continue;
    const addresses = extractPublicEvmAddresses(row.text);
    if (addresses.length === 0) continue;
    const scope = broadcasterActivityScope(row.team, row.actor);
    const current = latest.get(scope);
    if (!current || row.timestamp > current.timestamp) latest.set(scope, { timestamp: row.timestamp, addresses });
  }
  return new Map(Array.from(latest, ([scope, value]) => [scope, value.addresses]));
}

export function shortPublicAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

export function activityAddressLabel(context: string): string {
  if (/broadcaster\s+EOA/i.test(context)) return 'broadcaster';
  if (/root\s+safe/i.test(context)) return 'root Safe';
  if (/agent\s+safe/i.test(context)) return 'agent Safe';
  return 'wallet';
}

export function activityAddressExplorerUrl(context: string, address: string): string | undefined {
  if (/base\s+sepolia/i.test(context)) return `https://sepolia.basescan.org/address/${address}`;
  if (/sepolia/i.test(context)) return `https://sepolia.etherscan.io/address/${address}`;
  if (/\bbase\b/i.test(context)) return `https://basescan.org/address/${address}`;
  if (/ethereum|mainnet/i.test(context)) return `https://etherscan.io/address/${address}`;
  return undefined;
}
