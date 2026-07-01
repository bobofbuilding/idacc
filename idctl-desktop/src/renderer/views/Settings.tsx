import { Fragment, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import { defaultBaseUrl, type EvmRpcKeySource, type EvmRpcProfile, type EvmRpcRequest, type ProviderKind, type ProviderProfile } from '../../../../idctl/src/settings/schema.ts';
import type { ProbeOutcome } from '../../../../idctl/src/settings/ProviderClient.ts';
import type { DiscoveredServer } from '../../../../idctl/src/settings/localDiscovery.ts';
import { PROVIDER_CATALOG, findProvider, providerNeedsKey } from '../../../../idctl/src/settings/providerCatalog.ts';
import { TOP_LOCAL_MODEL_CATALOG, type ModelCapability, type LocalModelEntry } from '../../../../idctl/src/settings/modelCatalog.ts';
import { TOP_LOCAL_STACKS, type LocalStackEntry } from '../../../../idctl/src/settings/localStacks.ts';
import {
  CONTROL_CENTER_API_VERSION,
  CONTROL_CENTER_REQUIRED_FEATURES,
  CONTROL_CENTER_REQUIRED_ROUTES,
  controlCenterRouteKey,
} from '../../../../idctl/src/api/controlCenterContract.ts';

const MODEL_CAPS: ModelCapability[] = ['general', 'tools', 'reasoning', 'coding', 'vision', 'embedding', 'fast'];
const STARTER_LOCAL_MODEL_ID = 'qwen3:1.7b';
const SUB_NOTICE_TTL_MS = 18_000;
const SUB_AUTO_REFRESH_MS = 5 * 60 * 1000;
const API_FIRST_PROVIDER = PROVIDER_CATALOG.find((e) => !e.local) ?? findProvider('openai');
const DISCOVERY_MAX_AGE_MS = 2 * 60 * 1000;
const STACK_BACKEND_PRESET_FILTER = 'backend-presets';
const STACK_PRIMARY_FILTERS = ['all', STACK_BACKEND_PRESET_FILTER, 'start-here', 'easy', 'guided', 'advanced'];
const LOCAL_PROVIDER_STACK_IDS: Record<string, string> = {
  ollama: 'ollama',
  lmstudio: 'lm-studio',
  vllm: 'vllm',
  llamacpp: 'llama-cpp',
  localai: 'localai',
  jan: 'jan',
};

/** Hardware of the machine the control center commands (the manager host; localhost here). */
type HardwareInfo = { platform: string; arch: string; appleSilicon: boolean; cpu: string; cpuCores: number; gpu?: string; gpuCores?: number; totalRamGB: number; freeDiskGB: number | null; totalDiskGB: number | null };

/** A discovered local server enriched by the bridge with whether it's already configured. */
type Discovered = DiscoveredServer & { alreadyAdded: boolean };
type LocalStackInstallStatus = { id: string; installed: boolean; source?: string; detail?: string; checkedAt: number };

const API_KINDS: ProviderKind[] = ['openai-compatible', 'openai', 'anthropic'];

/** Provider profile enriched by the bridge with where its key resolves from. */
type ProviderRow = ProviderProfile & { keySource?: 'config' | 'env' | 'none'; needsKey?: boolean };
type EvmRpcRow = Omit<EvmRpcProfile, 'apiKey' | 'apiKeyEncrypted'> & { keySource: EvmRpcKeySource };
type ManagerCapabilities = {
  cc_api_version?: number;
  extension?: string;
  features?: string[];
  routes?: { method: string; path: string; group: string }[];
} | null;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function sortedKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}
function providerStamp(p: ProviderRow | ProviderProfile): string {
  const row = p as ProviderRow;
  return JSON.stringify({
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    enabled: p.enabled !== false,
    default: p.default === true,
    keySource: row.keySource ?? '',
    needsKey: row.needsKey === true,
  });
}
function providerListStamp(list: ProviderRow[]): string {
  return sortedKey(list.map(providerStamp));
}
function providerEndpoint(p: ProviderProfile): string {
  return `${p.kind} · ${p.baseUrl}`;
}
function discoveredStamp(s: DiscoveredServer): string {
  return JSON.stringify({
    id: s.id,
    kind: s.kind,
    baseUrl: s.baseUrl,
    status: s.status,
    models: sortedKey(s.models),
  });
}
function rpcStamp(rpc: EvmRpcRow): string {
  return JSON.stringify({
    id: rpc.id,
    network: rpc.network,
    httpsUrl: rpc.httpsUrl,
    enabled: rpc.enabled !== false,
    keySource: rpc.keySource,
  });
}
function imageServerStamp(server: { url: string; type: string; model?: string } | null): string {
  return server ? JSON.stringify({ url: server.url.replace(/\/+$/, ''), type: server.type, model: server.model ?? '' }) : '';
}
function imageMessageClass(msg: string): string {
  if (/(failed|blocked|changed)/i.test(msg)) return 'status-error';
  if (/(no server|not found|not configured)/i.test(msg)) return 'warn-text';
  return 'ok-text';
}

export function Settings({ store, navigate }: { store: FleetStore; navigate?: (view: string) => void }) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [evmRpcs, setEvmRpcs] = useState<EvmRpcRow[]>([]);
  const [rpcNetwork, setRpcNetwork] = useState('Ethereum mainnet');
  const [rpcUrl, setRpcUrl] = useState('https://eth-mainnet.g.alchemy.com/v2/{API_KEY}');
  const [rpcApiKey, setRpcApiKey] = useState('');
  const [rpcEditing, setRpcEditing] = useState<string | null>(null);
  const [rpcBusy, setRpcBusy] = useState<string | null>(null);
  const [rpcMsg, setRpcMsg] = useState('');
  const [probe, setProbe] = useState<Record<string, ProbeOutcome>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // add-provider form
  const [catalogId, setCatalogId] = useState<string>(API_FIRST_PROVIDER?.id ?? 'openai');
  const [kind, setKind] = useState<ProviderKind>(API_FIRST_PROVIDER?.kind ?? 'openai');
  const [name, setName] = useState(API_FIRST_PROVIDER?.id ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(API_FIRST_PROVIDER?.baseUrl ?? defaultBaseUrl('openai'));
  const [apiKey, setApiKey] = useState('');
  const [replaceProviderArmed, setReplaceProviderArmed] = useState(false);
  const [providerMsg, setProviderMsg] = useState('');
  // local LLM discovery (scan localhost for running servers)
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [discoveredAt, setDiscoveredAt] = useState<number | null>(null);
  const [stackInstallStatus, setStackInstallStatus] = useState<Record<string, LocalStackInstallStatus>>({});
  const [stackInstallChecking, setStackInstallChecking] = useState(false);
  const [showStackMoreFilters, setShowStackMoreFilters] = useState(false);
  function resetProviderAddReview() {
    setReplaceProviderArmed(false);
    setProviderMsg('');
  }
  function pickProvider(id: string) {
    resetProviderAddReview();
    setCatalogId(id);
    if (id === 'custom') {
      setKind('openai-compatible');
      setName('');
      setBaseUrl(defaultBaseUrl('openai-compatible'));
      return;
    }
    const e = findProvider(id);
    if (!e) return;
    setKind(e.kind);
    setBaseUrl(e.baseUrl);
    setName(e.id);
  }
  // self-update
  const [version, setVersion] = useState('');
  const [upd, setUpd] = useState<{ autoUpgrade?: boolean; updateManifestUrl?: string; updateRepo?: string } | null>(null);
  const [updStatus, setUpdStatus] = useState<{ latest?: string; available?: boolean; staged?: boolean; checking?: boolean; error?: string; lastChecked?: number } | null>(null);
  const [managerCaps, setManagerCaps] = useState<ManagerCapabilities | undefined>(undefined);
  const [managerReportCopied, setManagerReportCopied] = useState(false);
  // managed subscription OAuth runtimes
  type Sub = {
    provider: string;
    runtime: string;
    label: string;
    loggedIn: boolean;
    account?: string;
    accountSource?: string;
    linked?: boolean;
    installed?: boolean;
    installedSource?: string;
    statusSupported?: boolean;
    loginSupported?: boolean;
    logoutSupported?: boolean;
    installSupported?: boolean;
    plan?: string;
    email?: string;
    method?: string;
    detail?: string;
    postInstall?: string;
    installOpensApp?: boolean;
  };
  type SubKey = 'claude' | 'chatgpt' | 'cursor' | 'grok' | 'antigravity' | 'copilot' | 'kiro-cli' | 'q';
  const managedSubRows: { key: SubKey; label: string; runtime: string }[] = [
    { key: 'claude', label: 'Claude (Anthropic)', runtime: 'claude-code-cli' },
    { key: 'chatgpt', label: 'OpenAI (ChatGPT)', runtime: 'codex' },
    { key: 'cursor', label: 'Cursor', runtime: 'cursor-cli' },
    { key: 'grok', label: 'xAI Grok Build', runtime: 'grok' },
    { key: 'antigravity', label: 'Google Antigravity CLI', runtime: 'antigravity' },
    { key: 'copilot', label: 'GitHub Copilot CLI', runtime: 'copilot' },
    { key: 'kiro-cli', label: 'Kiro CLI', runtime: 'kiro-cli' },
    { key: 'q', label: 'Amazon Q CLI (legacy)', runtime: 'q' },
  ];
  const [subs, setSubs] = useState<Record<SubKey, Sub> | null>(null);
  const [subsBusy, setSubsBusy] = useState(false);
  const [subBusy, setSubBusy] = useState<string | null>(null);
  const [subNotice, setSubNotice] = useState('');
  const [subsCheckedAt, setSubsCheckedAt] = useState<number | null>(null);
  const visibleManagedSubRows = managedSubRows.filter(({ key }) => key !== 'q' || subs?.q?.installed === true);

  async function refreshManagedSubscriptions(options: { busy?: boolean; notice?: boolean } = {}) {
    if (options.busy) setSubsBusy(true);
    try {
      const next = await call<Record<SubKey, Sub>>('subs:status').catch(() => null);
      if (next) {
        setSubs(next);
        setSubsCheckedAt(Date.now());
      }
      // Keep model picker data current too. The main process also refreshes provider
      // models on boot + every 6h; this warms the renderer-visible catalog/freshness
      // routes when Settings is open without running package installers or updaters.
      void call<Record<string, string[]>>('runtime:models').catch(() => null);
      void call('runtime:freshness').catch(() => null);
      if (options.notice) setSubNotice('Managed runtimes refreshed. Account status and model freshness were checked.');
    } finally {
      if (options.busy) setSubsBusy(false);
    }
  }

  async function reload() {
    setProviders(await call<ProviderRow[]>('providers:list').catch(() => []));
    setEvmRpcs(await call<EvmRpcRow[]>('evmRpc:list').catch(() => []));
    setVersion(await call<string>('app:version').catch(() => ''));
    setManagerCaps(await call<ManagerCapabilities>('manager:capabilities').catch(() => null));
    const u = await call<typeof upd>('update:getSettings').catch(() => null);
    setUpd(u);
    setUpdStatus(await call<typeof updStatus>('update:status').catch(() => null));
    // Kick a FRESH check so the card reflects the true latest when you open
    // Settings (the cached status above can lag a release until the next check).
    void call<typeof updStatus>('update:check').then((s) => { if (s) setUpdStatus(s); }).catch(() => {});
    await refreshManagedSubscriptions();
    void checkStackInstalls();
  }
  async function reloadManagerCapabilities() {
    setManagerCaps(undefined);
    setManagerCaps(await call<ManagerCapabilities>('manager:capabilities').catch(() => null));
  }
  async function recheckSubs() {
    await refreshManagedSubscriptions({ busy: true, notice: true });
  }
  async function signinSub(provider: SubKey) {
    setSubBusy(provider);
    try {
      const r = await call<{ started: boolean; url?: string; command?: string; error?: string }>('subs:signin', provider);
      if (r.error) {
        if (r.command) {
          try { await navigator.clipboard.writeText(r.command); } catch { /* clipboard best-effort */ }
          window.alert(`Couldn't open Terminal automatically — the command is copied to your clipboard. Paste it into a terminal:\n\n${r.command}`);
        } else {
          window.alert(`sign-in failed: ${r.error}`);
        }
        return;
      }
      const label = managedSubRows.find((row) => row.key === provider)?.label ?? provider;
      const note = provider === 'antigravity'
          ? `${label} opened from IDACC. Finish the Antigravity login flow, then Re-check if the row does not update automatically. Agent assignment remains disabled until the manager exposes an Antigravity harness.`
          : `${label} account flow started from IDACC. Finish the vendor prompt/browser flow, then Re-check if the row does not update automatically.`;
      setSubNotice(note);
      setTimeout(() => void refreshManagedSubscriptions(), 4000);
    } finally {
      setSubBusy(null);
    }
  }
  async function installSub(provider: SubKey) {
    setSubBusy(provider);
    try {
      const r = await call<{ ok: boolean; ran: boolean; command?: string; error?: string; postInstall?: string; installOpensApp?: boolean }>('subs:install', provider);
      if (r.ran) {
        const label = managedSubRows.find((row) => row.key === provider)?.label ?? provider;
        const note = r.installOpensApp
          ? `${label} installer opened in Terminal. Its vendor installer may open the app once; IDACC will re-check for the CLI automatically.`
          : `${label} installer opened in Terminal. IDACC will re-check for the CLI automatically.`;
        setSubNotice(r.postInstall ? `${note} ${r.postInstall}` : note);
        scheduleSubInstallChecks(provider, label);
      } else if (r.command) {
        try { await navigator.clipboard.writeText(r.command); } catch { /* clipboard best-effort */ }
        setSubNotice(`Terminal automation was blocked; copied the install command. Paste it into a terminal, then use Re-check.`);
        window.alert(`Couldn't open Terminal automatically — the install command is copied to your clipboard. Paste it into a terminal:\n\n${r.command}`);
      } else {
        window.alert(`install unavailable: ${r.error ?? 'unknown'}`);
      }
    } finally {
      setSubBusy(null);
    }
  }
  function scheduleSubInstallChecks(provider: SubKey, label: string) {
    [5000, 12000, 25000, 45000].forEach((delay, idx, arr) => {
      setTimeout(async () => {
        const next = await call<Record<SubKey, Sub>>('subs:status').catch(() => null);
        if (!next) return;
        setSubs(next);
        setSubsCheckedAt(Date.now());
        const current = next[provider];
        if (current?.installed) {
          setSubNotice(`${label} detected. It is now available in IDACC; use Manage account here when you want to sign in or switch accounts.`);
        } else if (idx === arr.length - 1) {
          setSubNotice(`${label} was not detected yet. Finish the installer, make sure the CLI is on PATH, then Re-check.`);
        }
      }, delay);
    });
  }
  async function signoutSub(provider: SubKey) {
    const label = managedSubRows.find((row) => row.key === provider)?.label ?? provider;
    if (!window.confirm(`Sign out of ${label}? Agents on that runtime will lose subscription access until you sign back in.`)) return;
    setSubBusy(provider);
    try {
      const r = await call<{ ok: boolean; error?: string }>('subs:signout', provider);
      if (!r.ok) window.alert(`sign-out failed: ${r.error ?? 'unknown error'}`);
      await recheckSubs();
    } finally {
      setSubBusy(null);
    }
  }
  async function saveUpdate(partial: Record<string, unknown>) {
    const u = await call<typeof upd>('update:setSettings', partial);
    setUpd(u);
  }
  async function checkUpdate() {
    setUpdStatus({ checking: true });
    setUpdStatus(await call<typeof updStatus>('update:check').catch((e) => ({ error: String(e) })));
  }
  useEffect(() => {
    reload();
  }, [store.team, store.coordinator]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await call<Record<SubKey, Sub>>('subs:status').catch(() => null);
      if (!cancelled && next) {
        setSubs(next);
        setSubsCheckedAt(Date.now());
      }
      void call<Record<string, string[]>>('runtime:models').catch(() => null);
      void call('runtime:freshness').catch(() => null);
    };
    const onVisibility = () => { if (!document.hidden) void tick(); };
    const onFocus = () => { void tick(); };
    const interval = window.setInterval(() => void tick(), SUB_AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);


  async function freshProviders(): Promise<ProviderRow[]> {
    return call<ProviderRow[]>('providers:list').catch(() => []);
  }
  function enabledProviderCount(list = providers, except?: string): number {
    return list.filter((x) => x.enabled && x.name !== except).length;
  }
  function findProviderRow(list: ProviderRow[], providerName: string): ProviderRow | undefined {
    return list.find((x) => x.name === providerName);
  }
  async function ensureProviderFresh(n: string, label: string): Promise<{ current: ProviderRow; list: ProviderRow[] } | null> {
    const rendered = findProviderRow(providers, n);
    const list = await freshProviders();
    const current = findProviderRow(list, n);
    if (!current) {
      setProviders(list);
      window.alert(`${label} blocked: "${n}" is no longer configured. Refreshed inference backends.`);
      return null;
    }
    if (rendered && providerStamp(current) !== providerStamp(rendered)) {
      setProviders(list);
      window.alert(`${label} blocked: "${n}" changed since this page rendered. Refreshed inference backends; review the current row before trying again.`);
      return null;
    }
    return { current, list };
  }
  async function recheckProviderBeforeWrite(n: string, expected: ProviderRow, label: string): Promise<ProviderRow[] | null> {
    const list = await freshProviders();
    const current = findProviderRow(list, n);
    if (!current || providerStamp(current) !== providerStamp(expected)) {
      setProviders(list);
      window.alert(`${label} blocked: "${n}" changed during confirmation. Refreshed inference backends; review the current row before trying again.`);
      return null;
    }
    return list;
  }
  async function addProviderProfile(p: ProviderProfile, after?: () => void) {
    setBusy(true);
    try {
      const before = await freshProviders();
      const existing = findProviderRow(before, p.name);
      if (existing) {
        const msg = `Replace inference backend "${p.name}"?\n\nBefore: ${providerEndpoint(existing)}\nAfter:  ${providerEndpoint(p)}\n\nAgents without an explicit backend may use the updated provider on their next run or rebuild.`;
        if (!window.confirm(msg)) return;
        const latest = await freshProviders();
        const still = findProviderRow(latest, p.name);
        if (!still || providerStamp(still) !== providerStamp(existing)) {
          setProviders(latest);
          window.alert(`Replace blocked: "${p.name}" changed during confirmation. Refreshed inference backends; review the current row before trying again.`);
          return;
        }
      }
      setProviders(await call<ProviderRow[]>('providers:add', p));
      setProviderMsg(existing ? `replaced "${p.name}"` : `added "${p.name}"`);
      after?.();
    } finally {
      setBusy(false);
    }
  }
  async function addProvider() {
    const entry = findProvider(catalogId);
    const p: ProviderProfile = {
      name: name.trim() || kind,
      kind,
      baseUrl: baseUrl.trim() || defaultBaseUrl(kind),
      apiKey: apiKey.trim() || undefined,
      needsKey: entry?.needsKey ?? addNeedsKey,
      enabled: true,
    };
    const renderedExisting = findProviderRow(providers, p.name);
    if (providerReplaceIsNoop(renderedExisting, p)) {
      setProviderMsg(`"${p.name}" is already configured.`);
      return;
    }
    if (renderedExisting && !replaceProviderArmed) {
      setProviderMsg(`Review replacement for "${p.name}" before adding.`);
      return;
    }
    // Providers with limited/no GET /models coverage ship a preset list so their
    // models appear even before the first successful discovery probe.
    if (entry?.models?.length) {
      p.lastSync = { at: Date.now(), status: 'preset', modelCount: entry.models.length, models: entry.models };
    }
    await addProviderProfile(p, () => {
      setName('');
      setApiKey('');
      setReplaceProviderArmed(false);
    });
  }
  async function connect(n: string) {
    setBusy(true);
    try {
      const fresh = await ensureProviderFresh(n, 'Connect & sync');
      if (!fresh) return;
      const r = await call<{ providers: ProviderRow[]; outcome: ProbeOutcome }>('providers:connect', n, providerStamp(fresh.current));
      setProviders(r.providers);
      setProbe((m) => ({ ...m, [n]: r.outcome }));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(n: string) {
    const fresh = await ensureProviderFresh(n, 'Set default backend');
    if (!fresh) return;
    const p = fresh.current;
    if (p.default) { setProviders(fresh.list); return; }
    if (!providerRouteReady(p)) {
      setProviders(fresh.list);
      window.alert(`Set default backend blocked: "${p.name}" is not route-ready.\n\n${providerDefaultBlockReason(p)}\n\nRun Connect & sync first, or choose a backend with a live/preset model list.`);
      return;
    }
    if (!window.confirm(`Set "${p.name}" as the default inference backend?\n\nAgents without an explicit backend can start using this provider on their next run or rebuild.`)) return;
    const latest = await recheckProviderBeforeWrite(n, p, 'Set default backend');
    if (!latest) return;
    const still = findProviderRow(latest, n);
    if (!still || !providerRouteReady(still)) {
      setProviders(latest);
      window.alert(`Set default backend blocked: "${n}" is no longer route-ready. Run Connect & sync, then try again.`);
      return;
    }
    setProviders(await call<ProviderRow[]>('providers:setDefault', n));
  }
  async function toggle(n: string) {
    const fresh = await ensureProviderFresh(n, 'Toggle backend');
    if (!fresh) return;
    const p = fresh.current;
    if (p.enabled && enabledProviderCount(fresh.list, n) === 0) {
      window.alert('Refusing to disable the last enabled inference backend. Enable another backend first.');
      setProviders(fresh.list);
      return;
    }
    if (p.enabled && !window.confirm(`Disable inference backend "${p.name}"?\n\nAgents that depend on this provider may lose model options until another backend is enabled or selected.`)) return;
    const latest = await recheckProviderBeforeWrite(n, p, 'Toggle backend');
    if (!latest) return;
    if (p.enabled && enabledProviderCount(latest, n) === 0) {
      window.alert('Refusing to disable the last enabled inference backend. Enable another backend first.');
      setProviders(latest);
      return;
    }
    setProviders(await call<ProviderRow[]>('providers:toggle', n));
  }
  async function removeProviderProfile(n: string) {
    const fresh = await ensureProviderFresh(n, 'Remove backend');
    if (!fresh) return;
    const p = fresh.current;
    if (p.enabled && enabledProviderCount(fresh.list, n) === 0) {
      window.alert('Refusing to remove the last enabled inference backend. Enable another backend first.');
      setProviders(fresh.list);
      return;
    }
    const defaultNote = p.default ? '\n\nIt is currently the default backend.' : '';
    if (!window.confirm(`Remove inference backend "${n}"?${defaultNote}\n\nAgents that depend on this provider may lose model options until another backend is configured.`)) return;
    const latest = await recheckProviderBeforeWrite(n, p, 'Remove backend');
    if (!latest) return;
    if (p.enabled && enabledProviderCount(latest, n) === 0) {
      window.alert('Refusing to remove the last enabled inference backend. Enable another backend first.');
      setProviders(latest);
      return;
    }
    setProviders(await call<ProviderRow[]>('providers:remove', n));
  }
  function rpcIdFromNetwork(network: string): string {
    return network.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'evm-rpc';
  }
  async function freshRpcs(): Promise<EvmRpcRow[]> {
    return call<EvmRpcRow[]>('evmRpc:list').catch(() => []);
  }
  function findRpcRow(list: EvmRpcRow[], id: string): EvmRpcRow | undefined {
    return list.find((x) => x.id === id);
  }
  async function ensureRpcFresh(id: string, label: string): Promise<{ current: EvmRpcRow; list: EvmRpcRow[] } | null> {
    const rendered = findRpcRow(evmRpcs, id);
    const list = await freshRpcs();
    const current = findRpcRow(list, id);
    if (!current) {
      setEvmRpcs(list);
      setRpcMsg(`${label} blocked: RPC row disappeared. Refreshed.`);
      return null;
    }
    if (rendered && rpcStamp(current) !== rpcStamp(rendered)) {
      setEvmRpcs(list);
      setRpcMsg(`${label} blocked: RPC row changed since this page rendered. Refreshed.`);
      return null;
    }
    return { current, list };
  }
  async function saveRpc() {
    const network = rpcNetwork.trim();
    const httpsUrl = rpcUrl.trim();
    if (!network || !httpsUrl) { setRpcMsg('network and HTTPS URL are required'); return; }
    const id = rpcEditing ?? rpcIdFromNetwork(network);
    setRpcBusy('save'); setRpcMsg('');
    try {
      const latest = await freshRpcs();
      const existing = findRpcRow(latest, id);
      const rendered = findRpcRow(evmRpcs, id);
      if (rpcEditing) {
        if (!existing) {
          setEvmRpcs(latest);
          setRpcMsg('save blocked: RPC row disappeared. Refreshed.');
          return;
        }
        if (rendered && rpcStamp(existing) !== rpcStamp(rendered)) {
          setEvmRpcs(latest);
          setRpcMsg('save blocked: RPC row changed since this page rendered. Refreshed.');
          return;
        }
      } else if (existing) {
        if (!window.confirm(`Replace EVM RPC endpoint "${existing.network}"?\n\nBefore: ${existing.httpsUrl}\nAfter:  ${httpsUrl}`)) {
          setEvmRpcs(latest);
          return;
        }
        const afterConfirm = await freshRpcs();
        const still = findRpcRow(afterConfirm, id);
        if (!still || rpcStamp(still) !== rpcStamp(existing)) {
          setEvmRpcs(afterConfirm);
          setRpcMsg('replace blocked: RPC row changed during confirmation. Refreshed.');
          return;
        }
      }
      setEvmRpcs(await call<EvmRpcRow[]>('evmRpc:save', {
        id,
        network,
        httpsUrl,
        apiKey: rpcApiKey.trim() || undefined,
        enabled: true,
      } satisfies EvmRpcProfile));
      setRpcEditing(null);
      setRpcApiKey('');
      setRpcMsg('saved');
    } catch (err) {
      setRpcMsg(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRpcBusy(null);
    }
  }
  function editRpc(rpc: EvmRpcRow) {
    setRpcEditing(rpc.id);
    setRpcNetwork(rpc.network);
    setRpcUrl(rpc.httpsUrl);
    setRpcApiKey('');
    setRpcMsg('enter a new key only if you want to replace the linked key');
  }
  async function removeRpc(id: string) {
    setRpcBusy(id);
    try {
      const fresh = await ensureRpcFresh(id, 'remove');
      if (!fresh) return;
      if (!window.confirm(`Remove EVM RPC endpoint "${fresh.current.network}"?\n\n${fresh.current.httpsUrl}`)) return;
      const latest = await freshRpcs();
      const still = findRpcRow(latest, id);
      if (!still || rpcStamp(still) !== rpcStamp(fresh.current)) {
        setEvmRpcs(latest);
        setRpcMsg('remove blocked: RPC row changed during confirmation. Refreshed.');
        return;
      }
      setEvmRpcs(await call<EvmRpcRow[]>('evmRpc:remove', id));
      if (rpcEditing === id) setRpcEditing(null);
    } finally {
      setRpcBusy(null);
    }
  }
  async function probeRpc(id: string) {
    setRpcBusy(id);
    try {
      const fresh = await ensureRpcFresh(id, 'check');
      if (!fresh) return;
      const r = await call<{ rpcs: EvmRpcRow[]; outcome: EvmRpcRequest }>('evmRpc:probe', id);
      setEvmRpcs(r.rpcs);
    } finally {
      setRpcBusy(null);
    }
  }
  function rpcStatusClass(status?: string): string {
    if (status === 'available') return 'ok-text';
    if (status === 'auth-error' || status === 'error') return 'status-error';
    if (status === 'unreachable') return 'warn-text';
    return 'muted';
  }
  function rpcKeyLabel(source: EvmRpcKeySource): string {
    if (source === 'encrypted') return 'linked';
    if (source === 'env') return 'env';
    if (source === 'config') return 'legacy';
    return 'public';
  }

  // Local LLM discovery: scan localhost for running servers, then one-click add.
  async function checkStackInstalls(): Promise<Record<string, LocalStackInstallStatus>> {
    setStackInstallChecking(true);
    try {
      const status = await call<Record<string, LocalStackInstallStatus>>('stack:installStatus', TOP_LOCAL_STACKS.map((s) => s.id)).catch((): Record<string, LocalStackInstallStatus> => ({}));
      setStackInstallStatus(status);
      return status;
    } finally {
      setStackInstallChecking(false);
    }
  }
  async function runDiscover(opts: { autoAddKnownStacks?: boolean } = {}): Promise<Discovered[]> {
    setDiscovering(true);
    try {
      const [found] = await Promise.all([
        call<Discovered[]>('providers:discover').catch(() => []),
        checkStackInstalls(),
      ]);
      const autoAddedUrls = opts.autoAddKnownStacks ? await autoAddKnownStackBackends(found) : new Set<string>();
      const displayed = autoAddedUrls.size
        ? found.map((s) => autoAddedUrls.has(normUrl(s.baseUrl)) ? { ...s, alreadyAdded: true } : s)
        : found;
      setDiscovered(displayed);
      setDiscoveredAt(Date.now());
      return displayed;
    } finally {
      setDiscovering(false);
    }
  }
  /** Normalize a baseUrl for matching a discovered server against existing providers. */
  function normUrl(u: string): string {
    return u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
  }
  /** A provider name that won't overwrite an existing, differently-pointed provider. */
  function uniqueProviderName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }
  /** Turn a discovered server into a provider profile (carrying its model list). */
  function discoveredToProfile(s: Discovered, providerName: string): ProviderProfile {
    return {
      name: providerName,
      kind: s.kind,
      baseUrl: s.baseUrl,
      enabled: true,
      ...(s.status === 'live' && s.models.length
        ? { lastSync: { at: Date.now(), status: 'live', modelCount: s.modelCount, models: s.models.slice(0, 200) } }
        : {}),
    };
  }
  function findDiscoveredMatch(list: Discovered[], s: Discovered): Discovered | undefined {
    return list.find((x) => x.id === s.id && x.kind === s.kind && normUrl(x.baseUrl) === normUrl(s.baseUrl));
  }
  async function autoAddKnownStackBackends(found: Discovered[]): Promise<Set<string>> {
    const stackBases = new Set(TOP_LOCAL_STACKS.map((s) => s.apiBase).filter((u): u is string => Boolean(u)).map(normUrl));
    const liveKnown = found.filter((s) => s.status === 'live' && stackBases.has(normUrl(s.baseUrl)));
    if (!liveKnown.length) return new Set();
    const latest = await freshProviders();
    const existingUrls = new Set(latest.map((p) => normUrl(p.baseUrl)));
    const pending = liveKnown.filter((s) => !existingUrls.has(normUrl(s.baseUrl)));
    if (!pending.length) {
      setProviders(latest);
      return new Set();
    }
    setBusy(true);
    const addedUrls = new Set<string>();
    const addedNames: string[] = [];
    try {
      const taken = new Set(latest.map((p) => p.name));
      let nextProviders: ProviderRow[] | null = null;
      for (const server of pending) {
        const providerName = uniqueProviderName(server.id, taken);
        taken.add(providerName);
        nextProviders = await call<ProviderRow[]>('providers:add', discoveredToProfile(server, providerName));
        addedUrls.add(normUrl(server.baseUrl));
        addedNames.push(providerName);
      }
      setProviders(nextProviders ?? latest);
      setProviderMsg(`auto-added local backend${addedNames.length === 1 ? '' : 's'}: ${addedNames.join(', ')}`);
      setStackMsg(`auto-added backend${addedNames.length === 1 ? '' : 's'}: ${addedNames.join(', ')}`);
      return addedUrls;
    } finally {
      setBusy(false);
    }
  }
  async function freshDiscoveredBeforeAdd(s: Discovered): Promise<Discovered | null> {
    const fresh = await runDiscover();
    const current = findDiscoveredMatch(fresh, s);
    if (!current) {
      window.alert(`${s.name} is no longer answering on ${s.baseUrl}. Refreshed the discovered server list; start the server and scan again before adding it.`);
      return null;
    }
    if (discoveredStamp(current) !== discoveredStamp(s)) {
      window.alert(`${s.name} changed since this scan. Refreshed the discovered server list; review its current model/status row before adding it.`);
      return null;
    }
    return current;
  }
  async function addDiscovered(s: Discovered) {
    setBusy(true);
    try {
      const latest = await freshProviders();
      if (latest.some((p) => normUrl(p.baseUrl) === normUrl(s.baseUrl))) {
        setProviders(latest);
        await runDiscover();
        window.alert(`${s.name} is already configured as an inference backend. Refreshed the discovered server list.`);
        return;
      }
      const current = await freshDiscoveredBeforeAdd(s);
      if (!current) {
        setProviders(await freshProviders());
        return;
      }
      const latestAfterScan = await freshProviders();
      if (latestAfterScan.some((p) => normUrl(p.baseUrl) === normUrl(current.baseUrl))) {
        setProviders(latestAfterScan);
        await runDiscover();
        window.alert(`${current.name} was configured while the scan refreshed. Review the current backend row before changing routing.`);
        return;
      }
      const providerName = uniqueProviderName(current.id, new Set(latestAfterScan.map((p) => p.name)));
      await addProviderProfile(discoveredToProfile(current, providerName));
      await reload();
      await runDiscover(); // refresh the alreadyAdded flags
    } finally {
      setBusy(false);
    }
  }
  async function addStackBackend(s: LocalStackEntry) {
    if (!s.apiBase) {
      setStackMsg(`${s.name} does not expose an addable local API preset.`);
      return;
    }
    setStackMsg(`checking ${s.name} before adding backend…`);
    const fresh = await runDiscover();
    const match = fresh.find((x) => normUrl(x.baseUrl) === normUrl(s.apiBase ?? ''));
    if (!match || match.status !== 'live') {
      setStackMsg(`${s.name} is installed, but no live server answered at ${s.apiBase}. Start its server, then scan again.`);
      return;
    }
    await addDiscovered(match);
    setStackMsg(`${s.name} added as an inference backend.`);
  }
  // Local models (Ollama): list installed + download a new one (streamed progress).
  const POPULAR = TOP_LOCAL_MODEL_CATALOG.map((m) => m.id);
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size?: number; parameterSize?: string }[]>([]);
  const [pullName, setPullName] = useState(STARTER_LOCAL_MODEL_ID);
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState('');
  // catalog browsers: model filters + stacks filter + copy feedback
  const [modelQuery, setModelQuery] = useState('');
  const [modelCap, setModelCap] = useState<ModelCapability | 'all'>('all');
  const [showHeavy, setShowHeavy] = useState(false); // reveal models too heavy for this machine
  const [stackTag, setStackTag] = useState<string>(STACK_BACKEND_PRESET_FILTER);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [stackConfirm, setStackConfirm] = useState<string | null>(null);
  const [stackMsg, setStackMsg] = useState('');

  // How many local-model (ollama) queries the manager runs at once. Cloud runtimes
  // (codex/claude) parallelize freely; local agents share one server, so this caps
  // concurrent local inference (raise it only if your machine can handle it).
  const [localConc, setLocalConc] = useState<{ concurrency: number; active: number; queued: number } | null>(null);
  const [concInput, setConcInput] = useState('');
  const [concBusy, setConcBusy] = useState(false);
  const [concMsg, setConcMsg] = useState('');
  async function loadConc() {
    const r = await call<{ concurrency: number; active: number; queued: number }>('manager:localConcurrency').catch(() => null);
    setLocalConc(r);
    if (r) setConcInput(String(r.concurrency));
  }
  async function saveConc() {
    const n = Number(concInput);
    if (!Number.isFinite(n) || n < 1 || n > 16) { setConcMsg('enter a number 1–16'); return; }
    setConcBusy(true); setConcMsg('');
    try {
      const current = await call<{ concurrency: number; active: number; queued: number }>('manager:localConcurrency').catch(() => null);
      if (!current) { setConcMsg('failed: manager unreachable'); return; }
      if (localConc && current.concurrency !== localConc.concurrency) {
        setLocalConc(current);
        setConcInput(String(current.concurrency));
        setConcMsg('blocked: concurrency changed since this page rendered; refreshed');
        return;
      }
      const r = await call<{ concurrency: number }>('manager:setLocalConcurrency', n);
      setConcMsg(`now ${r.concurrency} concurrent ✓`);
      await loadConc();
    } catch (e) { setConcMsg(`failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setConcBusy(false); }
  }

  // Local image generator (preferred over API fallback for image creation).
  type ImgServer = { url: string; type: 'auto1111' | 'openai'; model?: string };
  const [imgServer, setImgServer] = useState<ImgServer | null>(null);
  const [imgUrl, setImgUrl] = useState('');
  const [imgType, setImgType] = useState<'auto1111' | 'openai'>('auto1111');
  const [imgMsg, setImgMsg] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  async function loadImgServer() {
    const s = await call<ImgServer | null>('image:getServer').catch(() => null);
    setImgServer(s);
    if (s) { setImgUrl(s.url); setImgType(s.type); }
  }
  async function saveImgServer(next?: { url: string; type: 'auto1111' | 'openai' } | null) {
    setImgBusy(true); setImgMsg('');
    try {
      const url = next === null ? '' : (next?.url ?? imgUrl).trim();
      const type = next === null ? imgType : next?.type ?? imgType;
      const current = await call<ImgServer | null>('image:getServer').catch(() => null);
      if (imageServerStamp(current) !== imageServerStamp(imgServer)) {
        setImgServer(current);
        if (current) { setImgUrl(current.url); setImgType(current.type); }
        else setImgUrl('');
        setImgMsg('save blocked: image server changed since this page rendered; refreshed');
        return;
      }
      if (!url && imgServer && !window.confirm('Clear the local image generator?\n\nImage creation will fall back to an image-capable API backend when available.')) return;
      if (url && imgServer && imageServerStamp({ url, type }) !== imageServerStamp(imgServer) && !window.confirm(`Replace local image generator?\n\nBefore: ${imgServer.type} · ${imgServer.url}\nAfter:  ${type} · ${url}`)) return;
      const afterReview = await call<ImgServer | null>('image:getServer').catch(() => null);
      if (imageServerStamp(afterReview) !== imageServerStamp(imgServer)) {
        setImgServer(afterReview);
        if (afterReview) { setImgUrl(afterReview.url); setImgType(afterReview.type); }
        else setImgUrl('');
        setImgMsg('save blocked: image server changed during review; refreshed');
        return;
      }
      const saved = await call<ImgServer | null>('image:setServer', url ? { url, type } : null);
      setImgServer(saved);
      if (saved) { setImgUrl(saved.url); setImgType(saved.type); }
      else setImgUrl('');
      setImgMsg(url ? 'saved ✓ — local image server will be tried first' : 'cleared — image creation will use an image-capable API backend when available');
    } catch {
      setImgMsg('save failed');
    } finally { setImgBusy(false); }
  }
  async function detectImg() {
    setImgBusy(true); setImgMsg('scanning localhost…');
    try {
      const found = await call<ImgServer | null>('image:detectServer').catch(() => null);
      if (found) { setImgUrl(found.url); setImgType(found.type); setImgMsg(`found ${found.type === 'auto1111' ? 'Stable Diffusion WebUI' : 'OpenAI Images API'} at ${found.url} — click Save to use it`); }
      else setImgMsg('no server found on localhost ports 7860, 7861, 8080, or 1234');
    } finally { setImgBusy(false); }
  }

  async function loadOllama() {
    const r = await call<{ ok: boolean; models: { name: string; size?: number; parameterSize?: string }[] }>('ollama:tags').catch(() => ({ ok: false, models: [] as { name: string }[] }));
    setOllamaModels(r.models ?? []);
    return r.models ?? [];
  }
  async function ensureOllamaBackend(models?: { name: string }[]) {
    const base = 'http://127.0.0.1:11434';
    const latest = await freshProviders();
    if (latest.some((p) => p.kind === 'ollama' || normUrl(p.baseUrl) === normUrl(base))) {
      setProviders(latest);
      return;
    }
    const rows = models ?? ollamaModels;
    const profile: ProviderProfile = {
      name: uniqueProviderName('ollama', new Set(latest.map((p) => p.name))),
      kind: 'ollama',
      baseUrl: base,
      enabled: true,
      ...(rows.length
        ? { lastSync: { at: Date.now(), status: 'live', modelCount: rows.length, models: rows.map((m) => m.name).slice(0, 200) } }
        : {}),
    };
    await call('providers:add', profile);
    await reload();
  }
  async function pull(modelId: string) {
    const m = modelId.trim();
    if (!m || pulling) return;
    setPulling(true);
    setPullMsg(`starting ${m}…`);
    try {
      const r = await call<{ ok: boolean; error?: string }>('ollama:pull', m);
      if (!r.ok) setPullMsg(`failed: ${r.error}`);
      else {
        const models = await loadOllama();
        await ensureOllamaBackend(models);
        setPullMsg(`downloaded ${m} ✓ · Ollama connected`);
      }
    } finally {
      setPulling(false);
    }
  }
  async function pullModel() { await pull(pullName); }
  async function addOllamaBackendFromReadiness() {
    if (!window.confirm('Add Ollama at http://127.0.0.1:11434 as an enabled inference backend?')) return;
    const models = await loadOllama();
    await ensureOllamaBackend(models);
  }
  /** Is a catalog model already pulled? (handles implicit :latest tags) */
  function modelInstalled(id: string): boolean {
    if (ollamaModels.some((m) => m.name === id)) return true;
    return !id.includes(':') && ollamaModels.some((m) => m.name.split(':')[0] === id);
  }
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
  }
  const filteredModels = TOP_LOCAL_MODEL_CATALOG.filter((m) => {
    if (modelCap !== 'all' && !m.capabilities.includes(modelCap)) return false;
    const q = modelQuery.trim().toLowerCase();
    return !q || m.id.toLowerCase().includes(q) || m.family.toLowerCase().includes(q) || (m.blurb ?? '').toLowerCase().includes(q);
  });
  const stackTagOrder = ['start-here', 'easy', 'guided', 'advanced', 'expert', 'desktop', 'gui', 'apple-silicon'];
  const stackTags = Array.from(new Set(TOP_LOCAL_STACKS.flatMap((s) => s.tags ?? []))).sort((a, b) => {
    const ai = stackTagOrder.indexOf(a);
    const bi = stackTagOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b);
  });
  const localProviderStackIds = new Set(PROVIDER_CATALOG.filter((e) => e.local).map((e) => LOCAL_PROVIDER_STACK_IDS[e.id]).filter(Boolean));
  const stackPrimaryFilters = STACK_PRIMARY_FILTERS.filter((t) => t === 'all' || t === STACK_BACKEND_PRESET_FILTER || stackTags.includes(t));
  const stackMoreFilters = stackTags.filter((t) => !stackPrimaryFilters.includes(t));
  const stackMoreActive = !stackPrimaryFilters.includes(stackTag);
  const filteredStacks = stackTag === 'all'
    ? TOP_LOCAL_STACKS
    : stackTag === STACK_BACKEND_PRESET_FILTER
      ? TOP_LOCAL_STACKS.filter((s) => localProviderStackIds.has(s.id))
      : TOP_LOCAL_STACKS.filter((s) => (s.tags ?? []).includes(stackTag));
  const stackFilterCount = stackTag === 'all'
    ? `${TOP_LOCAL_STACKS.length} stacks`
    : stackTag === STACK_BACKEND_PRESET_FILTER
      ? `${filteredStacks.length} backend presets`
      : `${filteredStacks.length}/${TOP_LOCAL_STACKS.length}`;
  const discoveryStale = discoveredAt != null && Date.now() - discoveredAt > DISCOVERY_MAX_AGE_MS;
  const runningPorts = new Set((discovered ?? []).map((d) => d.port));
  const addProviderName = name.trim() || kind;
  const addProviderBaseUrl = baseUrl.trim() || defaultBaseUrl(kind);
  const selectedProviderEntry = findProvider(catalogId);
  const addNeedsKey = providerNeedsKey({ name: addProviderName, kind, baseUrl: addProviderBaseUrl });
  const replaceCandidate = findProviderRow(providers, addProviderName);
  const providerDraft: ProviderProfile = {
    name: addProviderName,
    kind,
    baseUrl: addProviderBaseUrl,
    apiKey: apiKey.trim() || undefined,
    needsKey: addNeedsKey,
    enabled: true,
  };
  const replaceProviderNoop = providerReplaceIsNoop(replaceCandidate, providerDraft);
  const replaceProviderNeedsReview = !!replaceCandidate && !replaceProviderNoop;
  const showProviderCatalogNote = !!(selectedProviderEntry && !selectedProviderEntry.local && (selectedProviderEntry.notes || selectedProviderEntry.models?.length));
  const showProviderKeyHint = addNeedsKey && !selectedProviderEntry?.local;
  const defaultProvider = providers.find((p) => p.default);
  const enabledProviders = providers.filter((p) => p.enabled !== false);
  const localProviders = providers.filter(isLocalProvider);
  const syncedProviders = providers.filter(providerModelReady);
  const routeReadyProviders = enabledProviders.filter(providerRouteReady);
  const defaultRouteReady = defaultProvider ? providerRouteReady(defaultProvider) : false;
  const starterModel = TOP_LOCAL_MODEL_CATALOG.find((m) => m.id === STARTER_LOCAL_MODEL_ID) ?? TOP_LOCAL_MODEL_CATALOG[0];
  const starterInstalled = modelInstalled(STARTER_LOCAL_MODEL_ID);
  const localBackendConfigured = localProviders.some((p) => p.enabled !== false);
  const localRouteReadyProviders = localProviders.filter(providerRouteReady);
  const localBackendReady = localRouteReadyProviders.length > 0;
  const localSyncCandidate = localProviders.find((p) => p.enabled !== false && providerKeyReady(p) && !providerRouteReady(p));
  const localDrivingTone = localBackendReady ? 'ok' : localBackendConfigured || starterInstalled ? 'warn' : 'err';
  const localDrivingTitle = localBackendReady
    ? 'Backend ready'
    : localSyncCandidate
      ? 'Sync local backend'
      : starterInstalled
        ? 'Add Ollama backend'
        : 'Download starter model';
  const localDrivingDetail = localBackendReady
    ? `${localRouteReadyProviders.map((p) => p.name).join(', ')} available for local routing.`
    : localSyncCandidate
      ? `${localSyncCandidate.name} is configured but its model list is not synced.`
      : starterInstalled
        ? `${STARTER_LOCAL_MODEL_ID} is installed and ready to attach.`
        : `Start with ${STARTER_LOCAL_MODEL_ID}.`;
  const providersNeedingKeys = enabledProviders.filter((p) => providerNeedsKey(p) && !providerKeyReady(p)).length;
  const textRuntimeReady = store.connection === 'online' && (defaultRouteReady || routeReadyProviders.length > 0);
  const managerFeatureSet = new Set(managerCaps?.features ?? []);
  const managerRouteSet = new Set((managerCaps?.routes ?? []).map(controlCenterRouteKey));
  const missingManagerFeatures = CONTROL_CENTER_REQUIRED_FEATURES.filter((feature) => !managerFeatureSet.has(feature));
  const missingManagerRoutes = CONTROL_CENTER_REQUIRED_ROUTES.filter((route) => !managerRouteSet.has(controlCenterRouteKey(route)));
  const managerExtensionIssues = [
    ...missingManagerFeatures.map((feature) => `feature:${feature}`),
    ...missingManagerRoutes.map(controlCenterRouteKey),
  ];
  const managerApiVersion = managerCaps?.cc_api_version ?? 0;
  const managerExtensionReady = store.connection === 'online' && !!managerCaps && managerApiVersion >= CONTROL_CENTER_API_VERSION && managerExtensionIssues.length === 0;
  const managerExtensionTone = store.connection !== 'online'
    ? 'err'
    : managerCaps === undefined
      ? 'warn'
      : !managerCaps
        ? 'err'
        : managerApiVersion < CONTROL_CENTER_API_VERSION || managerExtensionIssues.length
          ? 'warn'
          : 'ok';
  const managerExtensionTitle = store.connection !== 'online'
    ? 'offline'
    : managerCaps === undefined
      ? 'checking...'
      : !managerCaps
        ? 'stock/unknown'
        : managerApiVersion < CONTROL_CENTER_API_VERSION
          ? `CC API v${managerApiVersion || '?'}`
        : missingManagerFeatures.length
            ? `${CONTROL_CENTER_REQUIRED_FEATURES.length - missingManagerFeatures.length}/${CONTROL_CENTER_REQUIRED_FEATURES.length} features`
            : missingManagerRoutes.length
              ? `${CONTROL_CENTER_REQUIRED_ROUTES.length - missingManagerRoutes.length}/${CONTROL_CENTER_REQUIRED_ROUTES.length} routes`
            : `CC API v${managerApiVersion}`;
  const managerExtensionDetail = store.connection !== 'online'
    ? 'connect manager first'
    : managerCaps === undefined
      ? 'reading /capabilities'
      : !managerCaps
        ? 'missing /capabilities; update id-agents manager'
        : missingManagerFeatures.length
          ? `missing ${missingManagerFeatures.slice(0, 3).join(', ')}${missingManagerFeatures.length > 3 ? '...' : ''}`
          : missingManagerRoutes.length
            ? `missing ${missingManagerRoutes.slice(0, 2).map(controlCenterRouteKey).join(', ')}${missingManagerRoutes.length > 2 ? '...' : ''}`
          : `${managerCaps.routes?.length ?? 0} extension routes`;
  const readinessState = store.connection !== 'online'
    ? 'manager offline'
    : managerCaps === undefined
      ? 'checking manager'
    : !managerExtensionReady
      ? 'manager update'
      : textRuntimeReady
        ? 'ready'
        : 'needs backend';
  const readinessTone = store.connection !== 'online' || managerExtensionTone === 'err' ? 'err' : textRuntimeReady && managerExtensionReady ? 'ok' : 'warn';
  const readinessNeedsBackend = store.connection === 'online' && managerExtensionReady && !textRuntimeReady;
  const readinessSyncCandidate = !defaultRouteReady && defaultProvider && providerKeyReady(defaultProvider)
    ? defaultProvider
    : readinessNeedsBackend
      ? enabledProviders.find((p) => providerKeyReady(p) && !providerRouteReady(p))
      : undefined;
  const showReadinessStarterDownload = readinessNeedsBackend && providers.length === 0 && !starterInstalled && !!starterModel;
  const showReadinessAddOllama = readinessNeedsBackend && providers.length === 0 && starterInstalled && !localBackendConfigured;
  const showReadinessScan = readinessNeedsBackend && providers.length === 0 && !readinessSyncCandidate && !showReadinessStarterDownload && !showReadinessAddOllama;
  const showReadinessManagerCheck = managerCaps === undefined || !managerExtensionReady;
  const showReadinessManagerReport = managerCaps !== undefined && !managerExtensionReady;
  const readinessHint = !managerExtensionReady
    ? 'Resolve manager compatibility first; diagnostics appear only while this checkpoint is not green.'
    : textRuntimeReady
      ? defaultRouteReady
        ? 'Ready. A backend is pinned; provider tools stay in Inference backends below.'
        : 'Ready. Routing is open across ready backends; pinning a default is optional.'
      : providers.length
        ? 'Add missing keys or sync a backend in Inference backends below.'
        : 'Add a backend below, or use the starter local path if you want offline inference.';
  const managerCompatibilityReport = [
    'IDACC manager compatibility report',
    `manager: ${store.managerUrl || '(not configured)'}`,
    `connection: ${store.connection}`,
    `required CC API: ${CONTROL_CENTER_API_VERSION}`,
    `reported CC API: ${managerCaps?.cc_api_version ?? 'none'}`,
    `extension: ${managerCaps?.extension ?? 'none'}`,
    `ready: ${managerExtensionReady ? 'yes' : 'no'}`,
    `features: ${(managerCaps?.features ?? []).join(', ') || 'none'}`,
    `missing features: ${missingManagerFeatures.join(', ') || 'none'}`,
    `routes: ${CONTROL_CENTER_REQUIRED_ROUTES.length - missingManagerRoutes.length}/${CONTROL_CENTER_REQUIRED_ROUTES.length} required`,
    `missing routes: ${missingManagerRoutes.map(controlCenterRouteKey).join(', ') || 'none'}`,
  ].join('\n');
  async function copyManagerCompatibilityReport() {
    await copyText(managerCompatibilityReport);
    setManagerReportCopied(true);
    window.setTimeout(() => setManagerReportCopied(false), 1600);
  }

  function providerPort(p: ProviderRow): number | null {
    try {
      const u = new URL(p.baseUrl);
      if (u.port) return Number(u.port);
      if (u.protocol === 'http:') return 80;
      if (u.protocol === 'https:') return 443;
      return null;
    } catch { return null; }
  }
  function providerStatus(p: ProviderRow): string | undefined {
    return probe[p.name]?.status ?? p.lastSync?.status;
  }
  function providerReplaceIsNoop(existing: ProviderRow | undefined, draft: ProviderProfile): boolean {
    return !!existing &&
      existing.enabled !== false &&
      existing.kind === draft.kind &&
      normUrl(existing.baseUrl) === normUrl(draft.baseUrl) &&
      !draft.apiKey;
  }
  function providerKeyReady(p: ProviderRow): boolean {
    return !providerNeedsKey(p) || p.keySource === 'config' || p.keySource === 'env';
  }
  function providerModelReady(p: ProviderRow): boolean {
    return (probe[p.name]?.models?.length ?? p.lastSync?.modelCount ?? 0) > 0 || p.lastSync?.status === 'preset';
  }
  function providerRouteReady(p: ProviderRow): boolean {
    return p.enabled !== false && providerKeyReady(p) && (providerStatus(p) === 'live' || p.lastSync?.status === 'preset' || providerModelReady(p));
  }
  function providerDefaultBlockReason(p: ProviderRow): string {
    if (p.enabled === false) return 'The backend is disabled.';
    if (!providerKeyReady(p)) return 'The backend is missing a required API key.';
    if (!providerModelReady(p)) return 'The backend has no synced/preset model list yet.';
    return `Current status is ${providerStatus(p) ?? 'not synced'}.`;
  }
  function isLocalProvider(p: ProviderRow): boolean {
    return p.kind === 'ollama' || p.kind === 'lmstudio' || (p.baseUrl || '').includes('127.0.0.1') || (p.baseUrl || '').includes('localhost');
  }
  /** Warn if a model is too large for the commanded machine's RAM/disk. */
  function fitWarn(m: LocalModelEntry): { level: 'warn' | 'error'; msg: string } | null {
    if (!hardware || !m.approxSizeGB) return null;
    const size = m.approxSizeGB;
    if (hardware.freeDiskGB != null && size > hardware.freeDiskGB) return { level: 'error', msg: `needs ${size}GB · ${hardware.freeDiskGB}GB disk free` };
    const ram = hardware.totalRamGB; // unified memory on Apple Silicon bounds Ollama
    if (size > ram * 0.9) return { level: 'error', msg: `~${size}GB won't fit in ${ram}GB RAM` };
    if (size > ram * 0.6) return { level: 'warn', msg: `heavy for ${ram}GB RAM` };
    return null;
  }
  async function removeModel(id: string) {
    setRemoving(id); setPullMsg(`removing ${id}…`);
    try {
      const r = await call<{ ok: boolean; error?: string }>('ollama:remove', id);
      setPullMsg(r.ok ? `removed ${id} ✓` : `remove failed: ${r.error}`);
      if (r.ok) await loadOllama();
    } finally { setRemoving(null); setConfirmRemove(null); }
  }
  // Stack install/uninstall commands: runnable (open Terminal) vs app-download (link out).
  const RUNNABLE_RE = /^(brew|pip|pipx|uv|cargo|curl|docker|conda|npm|npx)\b/;
  function stackCommand(command?: string): string {
    return (command ?? '').split('#')[0].trim();
  }
  function stackEaseLabel(s: LocalStackEntry): string {
    if (s.installEase === 'start-here') return 'start here';
    if (s.installEase === 'easy') return 'easy';
    if (s.installEase === 'guided') return 'guided';
    if (s.installEase === 'advanced') return 'advanced';
    if (s.installEase === 'expert') return 'expert';
    return '';
  }
  function stackFilterLabel(t: string): string {
    return t === STACK_BACKEND_PRESET_FILTER ? 'backend presets' : t;
  }
  function stackPrimaryAction(s: LocalStackEntry): boolean {
    if (!stackInstallCmd(s)) return false;
    return ['start-here', 'easy', 'guided', 'advanced'].includes(s.installEase ?? '');
  }
  function stackInstallLabel(s: LocalStackEntry): string {
    if (stackPrimaryAction(s)) return 'Install';
    return 'Review command';
  }
  function stackInstallCmd(s: LocalStackEntry): string | null {
    const c = stackCommand(s.install);
    return c && RUNNABLE_RE.test(c) ? c : null;
  }
  function stackUninstallCmd(s: LocalStackEntry): string | null {
    const c = stackCommand(s.uninstall);
    return c && RUNNABLE_RE.test(c) ? c : null;
  }
  function stackConfiguredProviders(s: LocalStackEntry): ProviderRow[] {
    const apiBase = s.apiBase ? normUrl(s.apiBase) : null;
    return providers.filter((p) => apiBase && normUrl(p.baseUrl) === apiBase);
  }
  function stackClaimedPorts(s: LocalStackEntry): number[] {
    const ports = new Set<number>();
    const addPort = (value: string | number | undefined | null) => {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
    };
    addPort(s.defaultPort);
    if (s.apiBase) {
      try {
        const u = new URL(s.apiBase);
        addPort(u.port || (u.protocol === 'http:' ? 80 : u.protocol === 'https:' ? 443 : null));
      } catch { /* ignore catalog display hints that are not parseable URLs */ }
    }
    const install = stackCommand(s.install);
    for (const match of install.matchAll(/\s-p\s+(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d+):\d+/g)) addPort(match[1]);
    for (const match of install.matchAll(/(?:--port|--tcp)\s+(\d+)/g)) addPort(match[1]);
    return [...ports].sort((a, b) => a - b);
  }
  function stackPortLabel(s: LocalStackEntry): string | null {
    const ports = stackClaimedPorts(s);
    if (!ports.length) return null;
    return ports.length === 1 ? `:${ports[0]}` : `ports ${ports.join('/')}`;
  }
  function stackPortConflicts(s: LocalStackEntry): { live: number[]; configured: { port: number; names: string[] }[] } {
    const ports = stackClaimedPorts(s);
    const live = ports.filter((p) => runningPorts.has(p));
    const configured = ports
      .map((port) => ({
        port,
        names: providers.filter((p) => providerPort(p) === port).map((p) => p.name),
      }))
      .filter((hit) => hit.names.length > 0);
    return { live, configured };
  }
  function reviewStackInstall(s: LocalStackEntry) {
    const conflicts = stackPortConflicts(s);
    const warnings = [
      conflicts.live.length ? `Live server detected on port ${conflicts.live.join(', ')}; stop it or edit the Terminal command to use another port.` : '',
      ...conflicts.configured.map((hit) => `Configured inference backend on port ${hit.port}: ${hit.names.join(', ')}.`),
    ].filter(Boolean);
    if (warnings.length && !window.confirm([
      `Review install for ${s.name}?`,
      '',
      ...warnings.map((w) => `- ${w}`),
      '',
      'The command will open visibly in Terminal and can be edited or cancelled there.',
    ].join('\n'))) return;
    setStackConfirm(`i:${s.id}`);
  }
  async function reviewStackUninstall(s: LocalStackEntry, running: boolean, configuredProviders: ProviderRow[]) {
    const status = await call<Record<string, LocalStackInstallStatus>>('stack:installStatus', [s.id]).catch((): Record<string, LocalStackInstallStatus> => ({}));
    setStackInstallStatus((prev) => ({ ...prev, ...status }));
    if (!status[s.id]?.installed) {
      setStackConfirm(null);
      setStackMsg(`No matching ${s.name} package/container install found; uninstall stays hidden.`);
      return;
    }
    const warnings = [
      running ? `A server is currently detected on port ${s.defaultPort}; stop it before uninstalling.` : '',
      configuredProviders.length ? `A matching inference backend is configured (${configuredProviders.map((p) => p.name).join(', ')}); remove or disable it before relying on routing again.` : '',
      s.uninstallNote ?? '',
    ].filter(Boolean);
    if (warnings.length && !window.confirm([
      `Review uninstall for ${s.name}?`,
      '',
      ...warnings.map((w) => `- ${w}`),
      '',
      'The command will open visibly in Terminal and can be cancelled there.',
    ].join('\n'))) return;
    setStackConfirm(`u:${s.id}`);
  }
  function scheduleStackInstallChecks(s: LocalStackEntry, action: 'install' | 'uninstall') {
    [6000, 18000, 36000].forEach((delay, idx, arr) => {
      setTimeout(async () => {
        const status = await call<Record<string, LocalStackInstallStatus>>('stack:installStatus', [s.id]).catch((): Record<string, LocalStackInstallStatus> => ({}));
        setStackInstallStatus((prev) => ({ ...prev, ...status }));
        const installed = status[s.id]?.installed === true;
        if (action === 'install' && installed) {
          setStackMsg(`${s.name} installed. Start its local server, then Scan running to add it as a backend.`);
        } else if (action === 'uninstall' && !installed) {
          setStackMsg(`${s.name} uninstall no longer has matching package/container evidence.`);
        } else if (idx === arr.length - 1) {
          setStackMsg(action === 'install'
            ? `${s.name} install not detected yet. Finish the installer, then Scan running once the server is started.`
            : `${s.name} still appears installed. Finish the uninstall command, then check again.`);
        }
      }, delay);
    });
  }
  async function runStackCmd(s: LocalStackEntry, action: 'install' | 'uninstall' = 'install') {
    const cmd = action === 'install' ? stackInstallCmd(s) : stackUninstallCmd(s);
    if (!cmd) return;
    setStackConfirm(null);
    const r = await call<{ ran: boolean }>('app:runInTerminal', cmd).catch(() => ({ ran: false }));
    if (r.ran) {
      setStackMsg(action === 'install'
        ? `opened Terminal to install ${s.name}. Install only adds the app/server; start it before adding a backend.`
        : `opened Terminal to uninstall ${s.name}. Review and stop it there if anything looks wrong.`);
      scheduleStackInstallChecks(s, action);
    } else {
      await copyText(cmd);
      setStackMsg(`Terminal automation was blocked — ${action} command copied to clipboard`);
    }
  }
  /** Real port conflict only: one of this stack's claimed ports is ACTUALLY in use right now
   *  by a detected running server or a configured provider. We no longer warn about stacks
   *  that merely share a possible port unless the port is live/configured; run "Scan running"
   *  to refresh what's live. */
  function stackPortWarn(s: LocalStackEntry): { level: 'warn' | 'error'; msg: string } | null {
    const conflicts = stackPortConflicts(s);
    if (conflicts.live.length) {
      return { level: 'error', msg: `live server on port ${conflicts.live.join(', ')} — use a different port if installing another stack` };
    }
    if (conflicts.configured.length) {
      return { level: 'warn', msg: `backend configured on port ${conflicts.configured.map((hit) => hit.port).join(', ')}; scan running servers before reusing it` };
    }
    return null;
  }
  useEffect(() => {
    void loadOllama();
    void loadConc();
    void loadImgServer();
    void call<HardwareInfo>('app:hardware').then(setHardware).catch(() => {});
    const idagents = (window as { idagents?: { onOllamaPull?: (cb: (p: unknown) => void) => () => void } }).idagents;
    const off = idagents?.onOllamaPull?.((p) => {
      const o = p as { model?: string; status?: string; pct?: number; done?: boolean; error?: string };
      if (o.done) setPullMsg(o.error ? `failed: ${o.error}` : `downloaded ${o.model} ✓`);
      else setPullMsg(`${o.model}: ${o.status ?? 'pulling'}${o.pct != null ? ` · ${o.pct}%` : ''}`);
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!subNotice) return;
    const timer = window.setTimeout(() => setSubNotice(''), SUB_NOTICE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [subNotice]);

  function subStatusNode(s: Sub | undefined) {
    const account = s?.account || s?.email;
    if (s?.loggedIn) {
      return (
        <span className="ok-text">
          ● signed in
          {s.plan ? ` · ${s.plan}` : ''}
          {account ? ` · ${account}` : ''}
          {!account && s.detail ? ` · ${s.detail}` : ''}
        </span>
      );
    }
    if (s?.installed === false) return <span className="warn-text" title={s.detail}>○ CLI not installed</span>;
    if (s?.installed && s.linked && account) {
      return (
        <span title={s.detail || s.accountSource}>
          <span className="ok-text">● account linked · {account}</span>
          <span className="muted"> · status not live</span>
        </span>
      );
    }
    if (s?.installed && s.statusSupported === false) {
      return (
        <span title={s.detail}>
          <span className="ok-text">● installed</span>
          <span className="muted"> · managed in IDACC</span>
        </span>
      );
    }
    return <span className="muted" title={s?.detail}>○ not signed in</span>;
  }
  function subPrimaryLabel(s: Sub | undefined): string {
    if (s?.installed === false) return s.installSupported ? 'Install' : 'Install unavailable';
    if (s?.loggedIn && s.loginSupported) return 'Switch account';
    if (s?.statusSupported === false && s?.loginSupported) return 'Manage account';
    if (s?.statusSupported === false) return 'Installed';
    return s?.loginSupported ? 'Sign in' : 'Managed in CLI';
  }
  function subPrimaryDisabled(key: SubKey, s: Sub | undefined): boolean {
    if (subBusy === key) return true;
    if (s?.installed === false) return !s.installSupported;
    return !s?.loginSupported;
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Settings</h1>
      </header>

      <section className="card settings-readiness">
        <div className="settings-readiness-head">
          <h3>First-run readiness</h3>
          <span className={`pill ${readinessTone}`}>{readinessState}</span>
        </div>
        <div className="readiness-grid">
          <div className={`readiness-check ${store.connection === 'online' ? 'ok' : 'err'}`}>
            <span>Manager</span>
            <b>{store.connection === 'online' ? 'online' : store.connection}</b>
            <small className="mono">{store.managerUrl || 'not connected'}</small>
          </div>
          <div className={`readiness-check ${managerExtensionTone}`}>
            <span>Manager extension</span>
            <b>{managerExtensionTitle}</b>
            <small title={managerExtensionIssues.length ? `Missing: ${managerExtensionIssues.join(', ')}` : managerCaps?.extension}>{managerExtensionDetail}</small>
          </div>
          <div className={`readiness-check ${routeReadyProviders.length ? 'ok' : providers.length ? 'warn' : 'err'}`}>
            <span>Routing</span>
            <b>{defaultRouteReady ? defaultProvider?.name : routeReadyProviders.length ? 'open routing' : 'no ready backend'}</b>
            <small>
              {defaultRouteReady
                ? 'explicit default'
                : routeReadyProviders.length
                  ? `${routeReadyProviders.length} ready backend${routeReadyProviders.length === 1 ? '' : 's'}`
                  : providers.length
                    ? 'sync or enable a backend'
                    : 'add a backend'}
            </small>
          </div>
          <div className={`readiness-check ${localBackendReady ? 'ok' : localBackendConfigured || starterInstalled ? 'warn' : 'err'}`}>
            <span>Local runtime</span>
            <b>{localBackendReady ? 'ready' : localBackendConfigured ? 'needs model/sync' : starterInstalled ? 'model installed' : 'starter missing'}</b>
            <small>{starterInstalled ? STARTER_LOCAL_MODEL_ID : starterModel ? `${STARTER_LOCAL_MODEL_ID} recommended` : 'Ollama starter'}</small>
          </div>
          <div className={`readiness-check ${routeReadyProviders.length ? 'ok' : providers.length ? 'warn' : 'err'}`}>
            <span>Backends</span>
            <b>{routeReadyProviders.length}/{enabledProviders.length} ready</b>
            <small>{providersNeedingKeys ? `${providersNeedingKeys} need keys` : `${syncedProviders.length}/${providers.length} synced`}</small>
          </div>
        </div>
        <div className="row-actions readiness-actions">
          <span className="muted small grow">{readinessHint}</span>
          {showReadinessStarterDownload ? (
            <button className="btn small primary" disabled={pulling} onClick={() => void pull(STARTER_LOCAL_MODEL_ID)}>
              {pulling ? 'Downloading...' : 'Download starter'}
            </button>
          ) : null}
          {showReadinessAddOllama ? (
            <button className="btn small" disabled={busy} onClick={() => void addOllamaBackendFromReadiness()}>
              Add Ollama backend
            </button>
          ) : null}
          {readinessSyncCandidate ? (
            <button className="btn small" disabled={busy} onClick={() => void connect(readinessSyncCandidate.name)}>
              Sync {readinessSyncCandidate.name}
            </button>
          ) : null}
          {showReadinessScan ? (
            <button className="btn small" disabled={discovering} onClick={() => void runDiscover()}>
              {discovering ? 'Scanning...' : 'Scan running'}
            </button>
          ) : null}
          {showReadinessManagerCheck ? (
            <button className="btn small" onClick={() => void reloadManagerCapabilities()}>
              Re-check manager
            </button>
          ) : null}
          {showReadinessManagerReport ? (
            <button className="btn small" onClick={() => void copyManagerCompatibilityReport()}>
              {managerReportCopied ? 'Report copied' : 'Copy manager report'}
            </button>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h3>Hardware — compute on the commanded machine</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          The machine running the manager and Ollama (where local models download and run){store.managerUrl ? <> · <span className="mono">{store.managerUrl.replace(/^https?:\/\//, '')}</span></> : null}. Local-model size warnings are checked against it.
        </p>
        {hardware ? (
          <div className="kv hw-grid" style={{ gridTemplateColumns: '120px 1fr', gap: '5px 12px' }}>
            <span>chip / CPU</span>
            <b>{hardware.cpu}{hardware.appleSilicon ? ' · Apple Silicon' : ''}</b>
            <span>CPU cores</span>
            <b>{hardware.cpuCores}</b>
            {hardware.gpu || hardware.gpuCores ? (
              <>
                <span>GPU</span>
                <b>{hardware.gpu ?? 'integrated'}{hardware.gpuCores ? ` · ${hardware.gpuCores} cores` : ''}</b>
              </>
            ) : null}
            <span>memory</span>
            <b>{hardware.totalRamGB} GB{hardware.appleSilicon ? ' unified' : ' RAM'}</b>
            <span>disk free</span>
            <b>{hardware.freeDiskGB != null ? `${hardware.freeDiskGB} GB${hardware.totalDiskGB ? ` of ${hardware.totalDiskGB} GB` : ''}` : '—'}</b>
            <span>platform</span>
            <b className="mono">{hardware.platform} · {hardware.arch}</b>
          </div>
        ) : (
          <p className="muted small">detecting…</p>
        )}
      </section>

      <section className="card">
        <h3>Connection</h3>
        <div className="kv">
          <span>manager</span>
          <b className="mono">{store.managerUrl || '—'}</b>
          <span>team</span>
          <b>{store.team ?? 'default'}</b>
          <span>coordinator</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b>{store.coordinator || '(auto: lead/first)'}</b>
            <button className="btn small" type="button" onClick={() => navigate?.('teams:route')} title="Open HR Manager Route → Hierarchy & sync to change team coordinators with a fresh hierarchy preview">
              Open HR Route
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>EVM data RPCs</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          JSON-RPC endpoints for chain data availability checks. Public RPCs can leave the key blank; Alchemy/Infura-style URLs can use <span className="mono">{'{API_KEY}'}</span>. Linked keys are encrypted by the desktop app and never shown back here.
        </p>
        <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input style={{ flex: '1 1 190px' }} placeholder="network, e.g. Base mainnet" value={rpcNetwork} disabled={rpcBusy === 'save'} onChange={(e) => setRpcNetwork(e.target.value)} />
          <input style={{ flex: '2 1 360px' }} placeholder="https://… JSON-RPC URL" value={rpcUrl} disabled={rpcBusy === 'save'} onChange={(e) => setRpcUrl(e.target.value)} />
          <input style={{ flex: '1 1 220px' }} type="password" placeholder={rpcEditing ? 'new API key (optional)' : 'API key (optional)'} value={rpcApiKey} disabled={rpcBusy === 'save'} onChange={(e) => setRpcApiKey(e.target.value)} />
          <button className="btn primary" disabled={rpcBusy === 'save'} onClick={() => void saveRpc()}>{rpcBusy === 'save' ? 'Saving…' : rpcEditing ? 'Update RPC' : 'Add RPC'}</button>
          {rpcEditing ? <button className="btn" disabled={rpcBusy === 'save'} onClick={() => { setRpcEditing(null); setRpcApiKey(''); setRpcMsg(''); }}>Cancel</button> : null}
        </div>
        {rpcMsg ? <div className={`small ${/failed|required/.test(rpcMsg) ? 'status-error' : /saved/.test(rpcMsg) ? 'ok-text' : 'muted'}`} style={{ marginTop: 6 }}>{rpcMsg}</div> : null}
        <div className="catalog-grid" style={{ marginTop: 12 }}>
          {evmRpcs.map((rpc) => (
            <div className="catalog-row" key={rpc.id}>
              <span className="b">{rpc.network}</span>
              <span className="mono small grow" title={rpc.httpsUrl}>{rpc.httpsUrl}</span>
              <span className={`small ${rpc.keySource === 'none' ? 'muted' : 'ok-text'}`}>key: {rpcKeyLabel(rpc.keySource)}</span>
              <span className={`small ${rpcStatusClass(rpc.lastRequest?.status)}`}>
                {rpc.lastRequest
                  ? `${rpc.lastRequest.status}${rpc.lastRequest.blockNumber != null ? ` · block ${rpc.lastRequest.blockNumber.toLocaleString()}` : ''} · ${timeAgo(rpc.lastRequest.at)}`
                  : 'not checked'}
              </span>
              <button className="btn small" disabled={!!rpcBusy} onClick={() => void probeRpc(rpc.id)}>{rpcBusy === rpc.id ? 'Checking…' : 'Check'}</button>
              <button className="btn small" disabled={!!rpcBusy} onClick={() => editRpc(rpc)}>Edit</button>
              <button className="btn small icon-danger" disabled={!!rpcBusy} onClick={() => void removeRpc(rpc.id)}>Remove</button>
            </div>
          ))}
          {evmRpcs.length === 0 ? <p className="muted small center pad">No EVM data RPCs configured.</p> : null}
        </div>
      </section>

      <section className="card">
        <h3>Self-update</h3>
        <div className="kv">
          <span>version</span>
          <b className="mono">v{version || '—'}</b>
          <span>status</span>
          <b className={updStatus?.available ? 'warn-text' : updStatus?.error ? 'status-error' : 'ok-text'}>
            {updStatus?.checking
              ? 'checking…'
              : updStatus?.error
                ? `error: ${updStatus.error}`
                : updStatus?.available
                  ? `update ready: v${updStatus.latest}${updStatus.staged ? ' (downloaded — restart to apply)' : ''}`
                  : updStatus?.latest
                    ? `up to date (latest v${updStatus.latest})`
                    : 'up to date'}
          </b>
          <span>auto-upgrade</span>
          <b>
            <input
              type="checkbox"
              checked={upd?.autoUpgrade ?? true}
              onChange={(e) => void saveUpdate({ autoUpgrade: e.target.checked })}
            />{' '}
            <span className="muted small">apply a staged update on next launch</span>
          </b>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="muted small grow">{upd?.updateRepo ? `updates from GitHub releases · ${upd.updateRepo}` : ''}</span>
          <button className="btn" onClick={() => void checkUpdate()}>Check now</button>
        </div>
      </section>

      <section className="card">
        <h3>Managed subscription sign-ins</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Local CLI sign-ins and subscription-backed runtimes are launched and tracked from IDACC. Signed in means live CLI status; account linked means safe local account evidence. API-key providers are configured under <b>Inference backends</b>. Account status and model freshness auto-check on open, focus, and every 5 minutes.
        </p>
        {visibleManagedSubRows.map(({ key, label, runtime }) => {
          const s = subs?.[key];
          const canInstall = s?.installed === false && s.installSupported;
          const canLaunch = s?.installed !== false && s?.loginSupported;
          const showPrimary = canInstall || canLaunch;
          const showSignOut = !!(s?.installed === true && (s?.loggedIn || s?.linked) && s.logoutSupported);
          return (
            <div className="kv" key={key} style={{ marginBottom: 8 }}>
              <span>{label}</span>
              <b>
                {subStatusNode(s)}
                <span className="muted small" style={{ marginLeft: 8 }} title="Managed runtime id">
                  <span className="mono">{s?.runtime ?? runtime}</span>
                </span>
                {s?.installedSource ? (
                  <span className="muted small" style={{ marginLeft: 8 }} title={s.installedSource}>
                    detected
                  </span>
                ) : null}
                {showPrimary || showSignOut ? (
                  <span className="row-actions" style={{ display: 'inline-flex', marginLeft: 12 }}>
                    {showPrimary ? (
                      <button
                        className="btn"
                        disabled={subPrimaryDisabled(key, s)}
                        onClick={() => void (canInstall ? installSub(key) : canLaunch ? signinSub(key) : undefined)}
                        title={s?.detail}
                      >
                        {subPrimaryLabel(s)}
                      </button>
                    ) : null}
                    {showSignOut ? (
                      <button className="btn" disabled={subBusy === key} onClick={() => void signoutSub(key)}>
                        Sign out
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </b>
            </div>
          );
        })}
        <div className="row-actions" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
          <span className="muted small grow">
            {subsCheckedAt ? `last checked ${timeAgo(subsCheckedAt)}` : 'auto-check pending'}
          </span>
          <button className="btn" disabled={subsBusy} onClick={() => void recheckSubs()}>{subsBusy ? 'Checking…' : 'Re-check now'}</button>
        </div>
        {subNotice ? <p className="muted small" style={{ marginTop: 8 }}>{subNotice}</p> : null}
      </section>

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Local models (Ollama)</h3>
          <span className="grow" />
          <span className={ollamaModels.length ? 'ok-text small' : 'warn-text small'}>
            {ollamaModels.length ? `${ollamaModels.length} models` : 'no models'}
          </span>
          <span className={localBackendReady ? 'ok-text small' : 'warn-text small'}>
            {localBackendReady ? 'backend ready' : localBackendConfigured ? 'sync needed' : 'backend not added'}
          </span>
          <button className="btn small" disabled={discovering} onClick={() => void runDiscover()}>
            {discovering ? 'Scanning…' : 'Scan running'}
          </button>
        </div>
        <div className={`local-driving-strip ${localDrivingTone}`}>
          <div className="grow">
            <b>{localDrivingTitle}</b>
            <span>{localDrivingDetail}</span>
          </div>
          <div className="row-actions">
            {!starterInstalled && starterModel ? (
              <button className="btn small primary" disabled={pulling} onClick={() => void pull(STARTER_LOCAL_MODEL_ID)}>
                {pulling ? 'Downloading…' : 'Download starter'}
              </button>
            ) : null}
            {starterInstalled && !localBackendConfigured ? (
              <button className="btn small" disabled={busy} onClick={() => void addOllamaBackendFromReadiness()}>
                Add Ollama backend
              </button>
            ) : null}
            {localSyncCandidate ? (
              <button className="btn small" disabled={busy} onClick={() => void connect(localSyncCandidate.name)}>
                Sync {localSyncCandidate.name}
              </button>
            ) : null}
          </div>
        </div>
        <div className="row-actions" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
          <span className="muted small">Local concurrency</span>
          <input type="number" min={1} max={16} style={{ width: 64 }} value={concInput} disabled={concBusy || !localConc}
            onChange={(e) => setConcInput(e.target.value)} />
          <button className="btn small primary" disabled={concBusy || !localConc || concInput === String(localConc?.concurrency)} onClick={() => void saveConc()}>
            {concBusy ? '…' : 'Apply'}
          </button>
          {localConc ? <span className="muted small">running {localConc.active}{localConc.queued ? ` · ${localConc.queued} queued` : ''}</span> : <span className="muted small">manager unreachable</span>}
          {concMsg ? <span className={`small ${/fail|1–16/.test(concMsg) ? 'status-error' : 'ok-text'}`}>{concMsg}</span> : null}
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="muted small">installed:</span>
          {ollamaModels.length === 0 ? (
            <span className="muted small grow">none yet</span>
          ) : (
            <span className="chips grow">
              {ollamaModels.map((m) => (
                <span className="chip" key={m.name} title={m.parameterSize ? `${m.parameterSize}` : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {m.name}
                  {confirmRemove === m.name ? (
                    <>
                      <button disabled={removing === m.name} title={`Uninstall ${m.name}`} onClick={() => void removeModel(m.name)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e5534b', fontWeight: 600, padding: 0, fontSize: 11 }}>{removing === m.name ? '…' : 'remove?'}</button>
                      <button title="Cancel" onClick={() => setConfirmRemove(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)', padding: 0 }}>×</button>
                    </>
                  ) : (
                    <button title={`Uninstall ${m.name}`} onClick={() => setConfirmRemove(m.name)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)', padding: 0, fontSize: 11, lineHeight: 1 }}>✕</button>
                  )}
                </span>
              ))}
            </span>
          )}
          <button className="btn small" title="Refresh installed list" onClick={() => void loadOllama()}>↻</button>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <input list="ollama-popular" style={{ width: 240 }} placeholder="model, e.g. llama3.2:1b" value={pullName} disabled={pulling} onChange={(e) => setPullName(e.target.value)} />
          <datalist id="ollama-popular">{POPULAR.map((m) => <option key={m} value={m} />)}</datalist>
          <button className="btn primary" disabled={pulling || !pullName.trim()} onClick={() => void pullModel()}>
            {pulling ? 'Downloading…' : 'Download'}
          </button>
          {pullMsg ? <span className={`small grow ${/failed/.test(pullMsg) ? 'status-error' : pulling ? 'warn-text' : 'ok-text'}`}>{pullMsg}</span> : null}
        </div>

        {/* Browsable model catalog */}
        <div className="model-catalog">
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            <input className="catalog-search" placeholder="search models…" value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} />
            <span className="chips">
              {(['all', ...MODEL_CAPS] as (ModelCapability | 'all')[]).map((c) => (
                <button key={c} className={`chip${modelCap === c ? ' on' : ''}`} onClick={() => setModelCap(c)}>
                  {modelCap === c ? '✓ ' : ''}{c}
                </button>
              ))}
            </span>
          </div>
          {(() => {
            const renderModelRow = (m: LocalModelEntry) => {
              const inst = modelInstalled(m.id);
              const warn = fitWarn(m);
              return (
                <div className="catalog-row" key={m.id} title={`${m.blurb ?? ''}${m.license ? `  ·  ${m.license}` : ''}`}>
                  <span className="b mono">{m.id}{m.recommended ? <span className="ok-text small" title="Recommended in its size class"> ★</span> : null}</span>
                  <span className="muted small">{m.params}{m.approxSizeGB ? ` · ~${m.approxSizeGB}GB` : ''}{m.contextLabel ? ` · ${m.contextLabel} ctx` : ''}</span>
                  <span className="chips grow">
                    {m.capabilities.slice(0, 3).map((c) => <span key={c} className="chip tag">{c}</span>)}
                  </span>
                  {warn ? <span className={`small ${warn.level === 'error' ? 'status-error' : 'warn-text'}`} title="Checked against the commanded machine's RAM/disk">⚠ {warn.msg}</span> : null}
                  {inst ? (
                    confirmRemove === m.id ? (
                      <>
                        <button className="btn small icon-danger" disabled={removing === m.id} onClick={() => void removeModel(m.id)}>{removing === m.id ? '…' : 'Remove?'}</button>
                        <button className="btn small" disabled={removing === m.id} onClick={() => setConfirmRemove(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="ok-text small">installed ✓</span>
                        <button className="btn small icon-danger" title="Uninstall this model" onClick={() => setConfirmRemove(m.id)}>✕</button>
                      </>
                    )
                  ) : (
                    <button className="btn small primary" disabled={pulling} title={warn ? warn.msg : undefined} onClick={() => void pull(m.id)}>Download</button>
                  )}
                </div>
              );
            };
            // Auto-hide models too heavy for this machine (but keep any you've installed); list
            // them at the bottom behind a show/hide toggle.
            const heavy = filteredModels.filter((m) => fitWarn(m) && !modelInstalled(m.id));
            const fits = filteredModels.filter((m) => !(fitWarn(m) && !modelInstalled(m.id)));
            return (
              <div className="catalog-grid">
                {fits.map(renderModelRow)}
                {filteredModels.length === 0 ? <p className="muted small center pad">No models match.</p> : null}
                {heavy.length ? (
                  <button className="btn small" style={{ marginTop: 6, alignSelf: 'flex-start' }} onClick={() => setShowHeavy((v) => !v)}
                    title="These exceed your machine's RAM/disk (checked at the top)">
                    {showHeavy ? '▾ hide' : '▸ show'} {heavy.length} model{heavy.length > 1 ? 's' : ''} too heavy for this machine
                  </button>
                ) : null}
                {showHeavy ? heavy.map(renderModelRow) : null}
              </div>
            );
          })()}
        </div>
      </section>

      <section className="card">
        <h3>Local image generator</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Optional local image server for chat image requests. IDACC tries this first; if it is unset or unreachable, image generation falls back to an image-capable API backend configured under <b>Inference backends</b>. Run <a className="ext-link" href="https://github.com/AUTOMATIC1111/stable-diffusion-webui" target="_blank" rel="noreferrer">Automatic1111</a> / Forge with <span className="mono">--api</span> on <span className="mono">:7860</span>, or a <a className="ext-link" href="https://localai.io" target="_blank" rel="noreferrer">LocalAI</a>-style OpenAI Images API on <span className="mono">:8080</span>.
        </p>
        <div className="local-image-actions">
          <input className="local-image-url" placeholder="http://127.0.0.1:7860" value={imgUrl} disabled={imgBusy} onChange={(e) => setImgUrl(e.target.value)} />
          <select className="local-image-type" value={imgType} disabled={imgBusy} onChange={(e) => setImgType(e.target.value as 'auto1111' | 'openai')} title="Local image API style">
            <option value="auto1111">Stable Diffusion WebUI</option>
            <option value="openai">OpenAI Images API</option>
          </select>
          <button className="btn" disabled={imgBusy} onClick={() => void detectImg()}>Scan local</button>
          <button className="btn primary" disabled={imgBusy} onClick={() => void saveImgServer()}>{imgBusy ? '…' : 'Save'}</button>
          {imgServer ? <button className="btn" disabled={imgBusy} title="Clear — use an image-capable API backend when available" onClick={() => void saveImgServer(null)}>Clear</button> : null}
        </div>
        <div className="local-image-status">
          <div>
            <span className="muted small">Local preference</span>{' '}
            {imgServer
              ? <><b className="accent-text">{imgServer.type === 'auto1111' ? 'Stable Diffusion WebUI' : 'OpenAI Images API'}</b> <span className="mono">{imgServer.url}</span></>
              : <span className="muted">not configured</span>}
          </div>
          <div className="muted small">Fallback: image-capable API backend from Inference backends when available.</div>
          {imgMsg ? <div className={`small ${imageMessageClass(imgMsg)}`}>{imgMsg}</div> : null}
        </div>
      </section>

      <section className="card">
        <h3>Local LLM stacks</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Self-hostable inference servers you can run <b>next to Ollama</b>. <b>Install</b> only installs the app/server; <b>running</b> means a local API answered a scan; <b>backend added</b> means IDACC can route agents to it.
        </p>
        <div className="stack-toolbar">
          <div className="stack-toolbar-main">
            <div className="stack-filter-primary" role="group" aria-label="Local stack filters">
              {stackPrimaryFilters.map((t) => (
                <button key={t} className={`chip${stackTag === t ? ' on' : ''}`} onClick={() => setStackTag(t)}>
                  {stackTag === t ? '✓ ' : ''}{stackFilterLabel(t)}
                </button>
              ))}
              <button className={`chip${stackMoreActive ? ' on' : ''}`} onClick={() => setShowStackMoreFilters((v) => !v)}>
                {stackMoreActive ? '✓ ' : ''}more filters
              </button>
            </div>
            <span className="muted small">{stackFilterCount}</span>
          </div>
          <div className="stack-toolbar-actions">
            <button className="btn small" disabled={discovering} title="Scan local APIs and auto-add live backend presets" onClick={() => void runDiscover({ autoAddKnownStacks: true })}>{discovering ? 'Scanning…' : 'Scan running'}</button>
            {discoveredAt ? (
              <span className={`small ${discoveryStale ? 'warn-text' : 'muted'}`}>
                scan {timeAgo(discoveredAt)}{discoveryStale ? ' · refresh before routing' : ''}
              </span>
            ) : null}
            {stackInstallChecking ? <span className="muted small">checking installs…</span> : null}
          </div>
          {(showStackMoreFilters || stackMoreActive) && stackMoreFilters.length ? (
            <div className="stack-filter-more">
              <label className="muted small" htmlFor="stack-more-filter">tag</label>
              <select id="stack-more-filter" className="cell-select" value={stackMoreActive ? stackTag : ''} onChange={(e) => e.target.value && setStackTag(e.target.value)}>
                <option value="">choose a tag</option>
                {stackMoreFilters.map((t) => <option key={t} value={t}>{stackFilterLabel(t)}</option>)}
              </select>
              {stackMoreActive ? <button className="btn small" onClick={() => setStackTag(STACK_BACKEND_PRESET_FILTER)}>Back to presets</button> : null}
            </div>
          ) : null}
          {stackMsg ? <div className="muted small stack-toolbar-msg">{stackMsg}</div> : null}
        </div>
        <div className="stack-list">
          {filteredStacks.map((s) => {
            const running = stackClaimedPorts(s).some((port) => runningPorts.has(port));
            const pw = stackPortWarn(s);
            const ic = stackInstallCmd(s);
            const uc = stackUninstallCmd(s);
            const installStatus = stackInstallStatus[s.id];
            const stackInstalled = installStatus?.installed === true;
            const configuredProviders = stackConfiguredProviders(s);
            const configured = configuredProviders.length > 0;
            const confirmInstall = stackConfirm === `i:${s.id}`;
            const confirmUninstall = stackConfirm === `u:${s.id}`;
            const portLabel = stackPortLabel(s);
            return (
              <div className="stack-row" key={s.id}>
                <div className="stack-head">
                  <span className="b">{s.name}</span>
                  {portLabel ? <span className="muted small mono">{portLabel}</span> : null}
                  <span className="muted small">{s.openaiCompatible ? 'OpenAI-compatible' : s.apiKind}</span>
                  {stackEaseLabel(s) ? <span className="chip tag" title={s.installNote}>{stackEaseLabel(s)}</span> : null}
                  {s.appleSilicon ? <span className="chip tag" title="Apple-Silicon native">Apple Silicon</span> : null}
                  {stackInstalled ? <span className="chip tag" title={installStatus?.detail ?? 'Detected installed package/container'}>installed</span> : null}
                  {running ? (
                    <span className={`small ${discoveryStale ? 'warn-text' : 'ok-text'}`} title={`Detected by scan ${discoveredAt ? timeAgo(discoveredAt) : 'recently'}`}>
                      {discoveryStale ? 'last scan running' : '● running'}
                    </span>
                  ) : null}
                  {configured ? <span className="chip tag" title="A matching inference backend is configured below">backend configured</span> : null}
                  {pw ? <span className={`small ${pw.level === 'error' ? 'status-error' : 'warn-text'}`} title="Port-conflict risk if you run this on its default port">⚠ {pw.msg}</span> : null}
                  <span className="grow" />
                  <a className="ext-link small" href={s.homepage} target="_blank" rel="noreferrer">docs ↗</a>
                </div>
                <p className="muted small stack-blurb">{s.blurb}</p>
                {s.installNote ? <p className="muted small stack-blurb">{s.installNote}</p> : null}
                <div className="stack-install">
                  {confirmInstall && ic && !stackInstalled ? (
                    <>
                      <code className="mono">{ic}</code>
                      <button className={`btn small${stackPrimaryAction(s) ? ' primary' : ''}`} title="Runs in your Terminal — visible and abortable" onClick={() => void runStackCmd(s, 'install')}>Run install</button>
                      <button className="btn small" onClick={() => setStackConfirm(null)}>Cancel</button>
                    </>
                  ) : confirmUninstall && uc && stackInstalled ? (
                    <>
                      <code className="mono">{uc}</code>
                      <button className="btn small" title="Runs in your Terminal — visible and abortable" onClick={() => void runStackCmd(s, 'uninstall')}>Run uninstall</button>
                      <button className="btn small" onClick={() => setStackConfirm(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      {!stackInstalled && ic ? (
                        <button className={`btn small${stackPrimaryAction(s) ? ' primary' : ''}`} title={ic} onClick={() => reviewStackInstall(s)}>{stackInstallLabel(s)}</button>
                      ) : !stackInstalled ? (
                        <a className="btn small" href={s.homepage} target="_blank" rel="noreferrer" title="No CLI install — opens the download page">Get ↗</a>
                      ) : null}
                      {running && !configured && s.apiBase ? (
                        <button className="btn small primary" title={`Add ${s.apiBase} as an inference backend after a fresh scan`} onClick={() => void addStackBackend(s)}>Add backend</button>
                      ) : null}
                      {configuredProviders.length === 1 ? (
                        <button className="btn small" title={`Remove inference backend ${configuredProviders[0].name}; does not uninstall the app/server`} onClick={() => void removeProviderProfile(configuredProviders[0].name)}>Remove backend</button>
                      ) : null}
                      {uc && stackInstalled ? (
                        <button className="btn small" title={s.uninstallNote ?? uc} onClick={() => void reviewStackUninstall(s, running, configuredProviders)}>Uninstall</button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card grow" id="inference-backends">
        <h3>Inference backends</h3>

        <table className="grid">
          <thead>
            <tr>
              <th>default</th>
              <th>on</th>
              <th>name</th>
              <th>key</th>
              <th>status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const o = probe[p.name];
              const sync = p.lastSync;
              const statusText = o
                ? o.status === 'live'
                  ? `live · ${o.models.length} models`
                  : o.status
                : sync
                  ? `${sync.status === 'live' ? `synced · ${sync.modelCount} models` : sync.status} · ${timeAgo(sync.at)}`
                  : 'not synced';
              const readyForDefault = providerRouteReady(p);
              const statusOk = readyForDefault;
              const statusWarn = (o?.status ?? sync?.status) === 'auth-error';
              const keyBadge = !p.needsKey
                ? null
                : p.keySource === 'config'
                  ? <span className="chip" title="API key stored in config">key ✓</span>
                  : p.keySource === 'env'
                    ? <span className="chip" title="API key detected from environment">env key</span>
                    : <span className="warn-text small" title="No API key — paste one when adding, or set the env var">no key</span>;
              const canExpand = (sync?.models?.length ?? 0) > 0;
              return (
                <Fragment key={p.name}>
                  <tr>
                    <td>
                      <button
                        className={`star${p.default ? ' on' : ''}`}
                        disabled={busy || (!p.default && !readyForDefault)}
                        title={p.default ? 'Default backend' : readyForDefault ? 'Set as default backend' : `Connect & sync before setting default: ${providerDefaultBlockReason(p)}`}
                        onClick={() => void setDefault(p.name)}
                      >
                        {p.default ? '★' : '☆'}
                      </button>
                    </td>
                    <td>
                      <input type="checkbox" checked={p.enabled} title="Enabled" onChange={() => void toggle(p.name)} />
                    </td>
                    <td>
                      <div className="b">{p.name}</div>
                      <div className="muted small mono">{p.kind} · {p.baseUrl}</div>
                    </td>
                    <td>{keyBadge}</td>
                    <td className={statusOk ? 'ok-text' : statusWarn ? 'warn-text' : sync || o ? 'status-error' : 'muted'}>
                      {statusText}
                      {canExpand ? (
                        <button className="btn small" style={{ marginLeft: 6, padding: '1px 6px' }} onClick={() => setExpanded(expanded === p.name ? null : p.name)}>
                          {expanded === p.name ? 'hide' : 'models'}
                        </button>
                      ) : null}
                    </td>
                    <td className="row-actions">
                      <button className="btn primary" disabled={busy} onClick={() => void connect(p.name)} title="Validate the key live and sync the model list">
                        Connect &amp; sync
                      </button>
                      <button className="btn" onClick={() => void removeProviderProfile(p.name)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                  {expanded === p.name && sync?.models?.length ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="chips">
                          {sync.models.map((m) => (
                            <span className="chip" key={m}>{m}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {providers.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted center pad">
                  No backends yet — add an API backend below, or scan a local stack above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div className="add-provider">
          <select value={catalogId} onChange={(e) => pickProvider(e.target.value)} title="Pick a provider to fill its endpoint">
            <optgroup label="API / Cloud">
              {PROVIDER_CATALOG.filter((e) => !e.local).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
            <option value="custom">Custom…</option>
          </select>
          {catalogId === 'custom' ? (
            <select value={kind} onChange={(e) => { const k = e.target.value as ProviderKind; resetProviderAddReview(); setKind(k); setBaseUrl(defaultBaseUrl(k)); }}>
              {API_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          ) : null}
          <input placeholder="name" value={name} onChange={(e) => { resetProviderAddReview(); setName(e.target.value); }} />
          <input placeholder="base URL" value={baseUrl} onChange={(e) => { resetProviderAddReview(); setBaseUrl(e.target.value); }} />
          <input
            placeholder={addNeedsKey ? 'API key (or leave blank to use env)' : 'API key (not needed)'}
            value={apiKey}
            onChange={(e) => { resetProviderAddReview(); setApiKey(e.target.value); }}
            type="password"
          />
          <button className="btn primary" disabled={busy || replaceProviderNoop || (replaceProviderNeedsReview && !replaceProviderArmed)} onClick={() => void addProvider()}>
            {replaceProviderNoop ? 'Configured' : replaceProviderNeedsReview ? 'Replace' : 'Add'}
          </button>
        </div>
        {replaceProviderNeedsReview ? (
          <div className="provider-replace-review">
            <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={replaceProviderArmed} onChange={(e) => { setReplaceProviderArmed(e.target.checked); setProviderMsg(''); }} />
              Replace {addProviderName}
            </label>
            <span className="muted small">{providerEndpoint(replaceCandidate)} → {providerEndpoint(providerDraft)}</span>
            {providerDraft.apiKey ? <span className="muted small">key update included</span> : null}
          </div>
        ) : null}
        {selectedProviderEntry && showProviderCatalogNote ? (
          <div className="provider-catalog-note">
            {selectedProviderEntry.notes ? <span className="muted small">{selectedProviderEntry.notes}</span> : null}
            {selectedProviderEntry.models?.length ? (
              <span className="chips">
                {selectedProviderEntry.models.map((m) => <span className="chip tag mono" key={m}>{m}</span>)}
              </span>
            ) : null}
          </div>
        ) : null}
        {providerMsg ? <div className={`small ${/added|replaced|already configured/.test(providerMsg) ? 'ok-text' : 'warn-text'}`} style={{ marginTop: 6 }}>{providerMsg}</div> : null}
        {showProviderKeyHint ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            API key can be pasted here or provided by env; Connect &amp; sync validates the backend and model list.
          </p>
        ) : null}
      </section>
    </div>
  );
}
