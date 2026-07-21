import type UniversalProviderType from '@walletconnect/universal-provider';
import type { WalletConnectSettings } from '../../../idctl/src/settings/schema.ts';
import { AGENT_BITTREES_SAFE_ADDRESS, EXECUTION_CHAINS, normalizeChainHex, sameAddress } from '../shared/signingGuardrails.ts';
import { call } from './store.ts';

export interface Eip1193Provider {
  request<T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T>;
}

export type RootSignerSource = 'injected' | 'walletconnect';

export interface RootSignerConnection {
  provider: Eip1193Provider;
  source: RootSignerSource;
}

export interface WalletConnectState {
  phase: 'idle' | 'initializing' | 'pairing' | 'connected' | 'error';
  account: string;
  chainId: string;
  walletName: string;
  pairingUri: string;
  qrDataUrl: string;
  error: string;
}

type UniversalProvider = InstanceType<typeof UniversalProviderType>;

const listeners = new Set<() => void>();
let state: WalletConnectState = {
  phase: 'idle',
  account: '',
  chainId: '',
  walletName: '',
  pairingUri: '',
  qrDataUrl: '',
  error: '',
};
let provider: UniversalProvider | null = null;
let providerProjectId = '';
let connectInFlight: Promise<UniversalProvider> | null = null;

const OPTIONAL_METHODS = [
  'eth_accounts',
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_getCapabilities',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
];

function lazyModuleError(feature: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch dynamically imported module|module script failed|module not found/i.test(message)) {
    return new Error(
      `${feature} could not load because this application bundle changed while IDACC was running. ` +
      'Quit every IDACC window and reopen /Applications/ID Agents Control Center.app, then try again.',
    );
  }
  return err instanceof Error ? err : new Error(message);
}

function emit(next: Partial<WalletConnectState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function sessionDetails(current: UniversalProvider): Pick<WalletConnectState, 'account' | 'chainId' | 'walletName'> {
  const namespace = current.session?.namespaces?.eip155;
  const accounts = namespace?.accounts ?? [];
  const parsed = accounts.map((value) => {
    const [namespaceName, chain, address] = value.split(':');
    return namespaceName === 'eip155' && address ? { chain, address } : null;
  }).filter((value): value is { chain: string; address: string } => Boolean(value));
  const defaultChain = current.rpcProviders?.eip155?.getDefaultChain?.() ?? parsed[0]?.chain ?? '';
  const selected = parsed.find((value) => value.chain === String(defaultChain).replace(/^eip155:/, '')) ?? parsed[0];
  return {
    account: selected?.address ?? '',
    chainId: normalizeChainHex(selected?.chain ?? defaultChain),
    walletName: current.session?.peer?.metadata?.name ?? 'WalletConnect wallet',
  };
}

async function qrDataUrl(uri: string): Promise<string> {
  // qrcode's browser bundle is CommonJS and esbuild exposes it as the default
  // export in a split chunk. Reading a named export works in Node but fails in
  // the packaged renderer, leaving the pairing modal without a QR code.
  const { default: qr } = await import('qrcode').catch((err) => {
    throw lazyModuleError('WalletConnect QR support', err);
  });
  return qr.toDataURL(uri, {
    width: 280,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#10141b', light: '#ffffff' },
  });
}

async function renderPairingQr(uri: string): Promise<void> {
  try {
    const data = await qrDataUrl(uri);
    if (state.pairingUri === uri) emit({ qrDataUrl: data, error: '' });
  } catch (err) {
    if (state.pairingUri === uri) {
      emit({ qrDataUrl: '', error: `QR generation failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

function bindProviderEvents(current: UniversalProvider): void {
  current.on('display_uri', (uri: string) => {
    emit({ phase: 'pairing', pairingUri: uri, qrDataUrl: '', error: '' });
    void renderPairingQr(uri);
  });
  current.on('chainChanged', (chain: unknown) => emit({ chainId: normalizeChainHex(chain) }));
  current.on('accountsChanged', (accounts: unknown) => {
    const account = Array.isArray(accounts) ? String(accounts[0] ?? '') : '';
    emit({ account });
  });
  current.on('session_update', () => emit({ ...sessionDetails(current) }));
  current.on('session_delete', () => emit({
    phase: 'idle', account: '', chainId: '', walletName: '', pairingUri: '', qrDataUrl: '', error: '',
  }));
}

async function initialize(settings: WalletConnectSettings): Promise<UniversalProvider> {
  if (!settings.enabled || !/^[a-f0-9]{32}$/i.test(settings.projectId)) {
    throw new Error('Enable the root Safe connector and save a valid Reown project ID in Settings first.');
  }
  if (provider && providerProjectId === settings.projectId) return provider;
  if (provider?.session) await provider.disconnect().catch(() => {});
  provider = null;
  providerProjectId = settings.projectId;
  emit({ phase: 'initializing', error: '', pairingUri: '', qrDataUrl: '' });
  const { UniversalProvider: Provider } = await import('@walletconnect/universal-provider').catch((err) => {
    throw lazyModuleError('WalletConnect', err);
  });
  const current = await Provider.init({
    projectId: settings.projectId,
    logger: 'error',
    metadata: {
      name: 'ID Agents Control Center',
      description: 'Root Safe approval for provisioning and revoking agent Safes',
      url: 'https://github.com/bobofbuilding/idacc',
      icons: [],
    },
  });
  provider = current;
  bindProviderEvents(current);
  if (current.session) emit({ phase: 'connected', ...sessionDetails(current), pairingUri: '', qrDataUrl: '' });
  else emit({ phase: 'idle' });
  return current;
}

export function subscribeWalletConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function walletConnectSnapshot(): WalletConnectState {
  return state;
}

export async function retryRootSafeQr(): Promise<void> {
  if (!state.pairingUri) return;
  emit({ qrDataUrl: '', error: '' });
  await renderPairingQr(state.pairingUri);
}

export function injectedRootSigner(): Eip1193Provider | null {
  return ((window as Window & { ethereum?: Eip1193Provider }).ethereum) ?? null;
}

export async function connectRootSafe(settings: WalletConnectSettings): Promise<UniversalProvider> {
  if (connectInFlight) return connectInFlight;
  connectInFlight = (async () => {
    const current = await initialize(settings);
    if (!current.session) {
      await current.connect({
        optionalNamespaces: {
          eip155: {
            methods: OPTIONAL_METHODS,
            chains: EXECUTION_CHAINS.map((chain) => `eip155:${chain.chainId}`),
            events: ['accountsChanged', 'chainChanged'],
          },
        },
      });
    }
    if (!current.session) throw new Error('WalletConnect pairing completed without an approved EVM session.');
    emit({ phase: 'connected', ...sessionDetails(current), pairingUri: '', qrDataUrl: '', error: '' });
    return current;
  })().catch((err) => {
    emit({ phase: 'error', pairingUri: '', qrDataUrl: '', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }).finally(() => { connectInFlight = null; });
  return connectInFlight;
}

export async function disconnectRootSafe(): Promise<void> {
  const current = provider;
  if (current?.session) await current.disconnect();
  provider = null;
  providerProjectId = '';
  emit({ phase: 'idle', account: '', chainId: '', walletName: '', pairingUri: '', qrDataUrl: '', error: '' });
}

export async function cancelRootSafePairing(): Promise<void> {
  provider?.abortPairingAttempt();
  await provider?.cleanupPendingPairings().catch(() => {});
  emit({ phase: provider?.session ? 'connected' : 'idle', pairingUri: '', qrDataUrl: '', error: '' });
}

export async function resolveRootSafeProvider(connect: boolean): Promise<RootSignerConnection | null> {
  const injected = injectedRootSigner();
  if (injected) {
    const accounts = await injected.request<string[]>({ method: 'eth_accounts' }).catch(() => []);
    if (accounts.some((account) => sameAddress(account, AGENT_BITTREES_SAFE_ADDRESS))) {
      return { provider: injected, source: 'injected' };
    }
  }
  const settings = await call<WalletConnectSettings>('walletConnect:get');
  const current = await initialize(settings);
  if (!current.session && connect) await connectRootSafe(settings);
  if (!current.session) return null;
  return { provider: current as Eip1193Provider, source: 'walletconnect' };
}
