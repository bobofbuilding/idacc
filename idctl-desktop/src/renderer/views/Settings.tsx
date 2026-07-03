import { Fragment, useEffect, useRef, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import { defaultBaseUrl, type EvmRpcKeySource, type EvmRpcProfile, type EvmRpcRequest, type ProviderKind, type ProviderModelSelection, type ProviderProfile } from '../../../../idctl/src/settings/schema.ts';
import type { ProbeOutcome } from '../../../../idctl/src/settings/ProviderClient.ts';
import type { DiscoveredServer, LocalServerCandidate } from '../../../../idctl/src/settings/localDiscovery.ts';
import { PROVIDER_CATALOG, findProvider, providerNeedsKey } from '../../../../idctl/src/settings/providerCatalog.ts';
import { LOCAL_MODEL_CATALOG, TOP_LOCAL_MODEL_CATALOG, type ModelCapability, type LocalModelEntry } from '../../../../idctl/src/settings/modelCatalog.ts';
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
const OLLAMA_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
const SETTINGS_FOCUS_REFRESH_MIN_MS = 60 * 1000;
const API_FIRST_PROVIDER = PROVIDER_CATALOG.find((e) => !e.local) ?? findProvider('openai');
const DISCOVERY_MAX_AGE_MS = 2 * 60 * 1000;
const STACK_BACKEND_PRESET_FILTER = 'backend-presets';
const STACK_PRIMARY_FILTERS = ['all', STACK_BACKEND_PRESET_FILTER, 'start-here', 'easy', 'guided', 'advanced'];
const STACK_RUNNABLE_CMD_RE = /^(brew|python3?|pip3?|pipx|uv|cargo|curl|docker|conda|npm|npx|open)\b/;
const STACK_PLACEHOLDER_CMD_RE = /<[^>\s][^>]*>/;
const STACK_BACKGROUND_START_IDS = new Set(['mlx-lm-server']);
const LOCAL_CONCURRENCY_OPTIONS = Array.from({ length: 16 }, (_, i) => i + 1);
const LOCAL_PROVIDER_STACK_IDS: Record<string, string> = {
  ollama: 'ollama',
  lmstudio: 'lm-studio',
  vllm: 'vllm',
  llamacpp: 'llama-cpp',
  localai: 'localai',
  'mlx-lm-server': 'mlx-lm-server',
  tgi: 'tgi',
  jan: 'jan',
  gpt4all: 'gpt4all',
};

/** Hardware of the machine the control center commands (the manager host; localhost here). */
type HardwareInfo = { platform: string; arch: string; appleSilicon: boolean; cpu: string; cpuCores: number; gpu?: string; gpuCores?: number; totalRamGB: number; freeDiskGB: number | null; totalDiskGB: number | null };

/** A discovered local server enriched by the bridge with whether it's already configured. */
type Discovered = DiscoveredServer & { alreadyAdded: boolean };
type LocalStackInstallStatus = { id: string; installed: boolean; source?: string; detail?: string; port?: number; checkedAt: number };
type BackgroundStackStatus = { id: string; name: string; running: boolean; pid?: number; command?: string; startedAt?: number; port?: number; logPath?: string; detail?: string };
type StackInstallDraft = { command: string; port?: number; originalPort?: number; baseUrl?: string; autoFixed?: boolean; note?: string };
type DockerStatus = { installed: boolean; serverRunning: boolean; version?: string; serverVersion?: string; error?: string };
type OllamaModel = { name: string; size?: number; parameterSize?: string; digest?: string; modifiedAt?: string };
type OllamaCatalogModel = {
  name: string;
  family: string;
  digest?: string;
  sizeLabel?: string;
  contextLabel?: string;
  inputLabel?: string;
  updatedLabel?: string;
  isMlx?: boolean;
};
type OllamaCatalogCheck = {
  ok: boolean;
  checkedAt: number;
  source: 'ollama-library';
  watchedFamilies: string[];
  models: OllamaCatalogModel[];
  newModels: OllamaCatalogModel[];
  installedUpdates: Array<OllamaCatalogModel & { localDigest?: string }>;
  savedModels?: LocalCatalogModelEntry[];
  savedCount?: number;
  error?: string;
};
type LocalCatalogModelEntry = LocalModelEntry & {
  source?: 'ollama-library' | 'manual';
  discoveredAt?: number;
  updatedAt?: number;
};

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
    modelSelectionMode: p.modelSelection?.mode ?? 'all',
    modelSelectionModels: [...new Set(p.modelSelection?.models ?? [])].sort(),
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
  if (/(no server|not found|not configured|draft|unsaved)/i.test(msg)) return 'warn-text';
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
  const [providerModelSearch, setProviderModelSearch] = useState<Record<string, string>>({});
  const [providerModelDrafts, setProviderModelDrafts] = useState<Record<string, string[]>>({});
  // local LLM discovery (scan localhost for running servers)
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [discoveredAt, setDiscoveredAt] = useState<number | null>(null);
  const discoverPromiseRef = useRef<Promise<Discovered[]> | null>(null);
  const localRefreshRunningRef = useRef(false);
  const localRefreshLastAtRef = useRef(0);
  const subRefreshRunningRef = useRef(false);
  const subRefreshLastAtRef = useRef(0);
  const [stackInstallStatus, setStackInstallStatus] = useState<Record<string, LocalStackInstallStatus>>({});
  const [stackBackgroundStatus, setStackBackgroundStatus] = useState<Record<string, BackgroundStackStatus>>({});
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
    const tick = async (reason: 'timer' | 'focus' | 'visibility' = 'timer') => {
      const now = Date.now();
      if (subRefreshRunningRef.current) return;
      if (reason !== 'timer' && now - subRefreshLastAtRef.current < SETTINGS_FOCUS_REFRESH_MIN_MS) return;
      subRefreshRunningRef.current = true;
      subRefreshLastAtRef.current = now;
      try {
        const next = await call<Record<SubKey, Sub>>('subs:status').catch(() => null);
        if (!cancelled && next) {
          setSubs(next);
          setSubsCheckedAt(Date.now());
        }
        void call<Record<string, string[]>>('runtime:models').catch(() => null);
        void call('runtime:freshness').catch(() => null);
      } finally {
        subRefreshRunningRef.current = false;
      }
    };
    const onVisibility = () => { if (!document.hidden) void tick('visibility'); };
    const onFocus = () => { void tick('focus'); };
    const interval = window.setInterval(() => void tick('timer'), SUB_AUTO_REFRESH_MS);
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
  async function checkBackgroundStacks(): Promise<Record<string, BackgroundStackStatus>> {
    const status = await call<Record<string, BackgroundStackStatus>>('stack:backgroundStatus', TOP_LOCAL_STACKS.map((s) => s.id)).catch((): Record<string, BackgroundStackStatus> => ({}));
    setStackBackgroundStatus(status);
    return status;
  }
  async function checkStackInstalls(): Promise<Record<string, LocalStackInstallStatus>> {
    setStackInstallChecking(true);
    try {
      const status = await call<Record<string, LocalStackInstallStatus>>('stack:installStatus', TOP_LOCAL_STACKS.map((s) => s.id)).catch((): Record<string, LocalStackInstallStatus> => ({}));
      setStackInstallStatus(status);
      setStackPortOverrides((prev) => {
        const next = { ...prev };
        for (const [id, row] of Object.entries(status)) {
          if (row.port) next[id] = row.port;
        }
        return next;
      });
      await autoAddInstalledStackBackendPlaceholders(status);
      return status;
    } finally {
      setStackInstallChecking(false);
    }
  }
  async function runDiscover(opts: { autoAddKnownStacks?: boolean } = {}): Promise<Discovered[]> {
    if (discoverPromiseRef.current) return discoverPromiseRef.current;
    let task: Promise<Discovered[]>;
    task = (async () => {
      setDiscovering(true);
      const [found] = await Promise.all([
        call<Discovered[]>('providers:discover', stackExtraDiscoveryCandidates()).catch(() => []),
        checkStackInstalls(),
        checkBackgroundStacks(),
      ]);
      const autoAddedUrls = opts.autoAddKnownStacks ? await autoAddKnownStackBackends(found) : new Set<string>();
      const displayed = autoAddedUrls.size
        ? found.map((s) => autoAddedUrls.has(normUrl(s.baseUrl)) ? { ...s, alreadyAdded: true } : s)
        : found;
      setDiscovered(displayed);
      setDiscoveredAt(Date.now());
      return displayed;
    })().finally(() => {
      if (discoverPromiseRef.current === task) {
        discoverPromiseRef.current = null;
        setDiscovering(false);
      }
    });
    discoverPromiseRef.current = task;
    return task;
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
  function stackApiBaseForInstallStatus(s: LocalStackEntry, status?: LocalStackInstallStatus): string | undefined {
    if (!s.apiBase) return undefined;
    const port = status?.port ?? stackPortOverride(s);
    return port ? withBaseUrlPort(s.apiBase, port) : s.apiBase;
  }
  function stackKind(s: LocalStackEntry): ProviderKind | null {
    return ['ollama', 'lmstudio', 'openai-compatible', 'anthropic', 'openai'].includes(s.apiKind)
      ? s.apiKind as ProviderKind
      : null;
  }
  function stackPlaceholderProfile(s: LocalStackEntry, providerName: string, status?: LocalStackInstallStatus): ProviderProfile | null {
    const kind = stackKind(s);
    const baseUrl = stackApiBaseForInstallStatus(s, status);
    if (!kind || !baseUrl) return null;
    return {
      name: providerName,
      kind,
      baseUrl,
      enabled: false,
      needsKey: false,
    };
  }
  function findDiscoveredMatch(list: Discovered[], s: Discovered): Discovered | undefined {
    return list.find((x) => x.id === s.id && x.kind === s.kind && normUrl(x.baseUrl) === normUrl(s.baseUrl));
  }
  async function autoAddInstalledStackBackendPlaceholders(status: Record<string, LocalStackInstallStatus>): Promise<Set<string>> {
    const installed = TOP_LOCAL_STACKS
      .filter((s) => s.id !== 'ollama' && status[s.id]?.installed && stackKind(s) && stackApiBaseForInstallStatus(s, status[s.id]))
      .filter((s) => !STACK_PLACEHOLDER_CMD_RE.test(stackCommand(s.install)));
    if (!installed.length) return new Set();
    const latest = await freshProviders();
    const taken = new Set(latest.map((p) => p.name));
    const existingUrls = new Set(latest.map((p) => normUrl(p.baseUrl)));
    let nextProviders: ProviderRow[] | null = null;
    const added = new Set<string>();
    const addedNames: string[] = [];
    for (const stack of installed) {
      const baseUrl = stackApiBaseForInstallStatus(stack, status[stack.id]);
      if (!baseUrl || existingUrls.has(normUrl(baseUrl))) continue;
      const providerName = uniqueProviderName(stackProviderId(stack), taken);
      const profile = stackPlaceholderProfile(stack, providerName, status[stack.id]);
      if (!profile) continue;
      taken.add(providerName);
      existingUrls.add(normUrl(baseUrl));
      nextProviders = await call<ProviderRow[]>('providers:add', profile);
      added.add(normUrl(baseUrl));
      addedNames.push(providerName);
    }
    if (nextProviders) {
      setProviders(nextProviders);
      setProviderMsg(`added pending local backend${addedNames.length === 1 ? '' : 's'}: ${addedNames.join(', ')}`);
      setStackMsg(`added pending backend${addedNames.length === 1 ? '' : 's'}: ${addedNames.join(', ')} — start the server, then Connect & sync`);
    }
    return added;
  }
  async function autoAddKnownStackBackends(found: Discovered[]): Promise<Set<string>> {
    const stackBases = new Set(TOP_LOCAL_STACKS.flatMap((s) => [s.apiBase, stackApiBase(s)]).filter((u): u is string => Boolean(u)).map(normUrl));
    const liveKnown = found.filter((s) => s.status === 'live' && stackBases.has(normUrl(s.baseUrl)));
    if (!liveKnown.length) return new Set();
    const latest = await freshProviders();
    const byUrl = new Map(latest.map((p) => [normUrl(p.baseUrl), p]));
    const pending = liveKnown.filter((s) => {
      const existing = byUrl.get(normUrl(s.baseUrl));
      if (!existing) return true;
      return existing.enabled === false && !existing.lastSync && !providerModelReady(existing);
    });
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
        const existing = byUrl.get(normUrl(server.baseUrl));
        const providerName = existing?.name ?? uniqueProviderName(server.id, taken);
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
    const apiBase = stackApiBase(s);
    if (!apiBase) {
      setStackMsg(`${s.name} does not expose an addable local API preset.`);
      return;
    }
    setStackMsg(`checking ${s.name} before adding backend…`);
    const fresh = await runDiscover();
    const match = fresh.find((x) => normUrl(x.baseUrl) === normUrl(apiBase));
    if (!match || match.status !== 'live') {
      setStackMsg(`${s.name} is installed, but no live server answered at ${apiBase}. Start its server, then scan again.`);
      return;
    }
    await addDiscovered(match);
    setStackMsg(`${s.name} added as an inference backend.`);
  }
  // Local models & backends: list installed Ollama models, pull/re-pull models, and reflect local stack API readiness.
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [localCatalogModels, setLocalCatalogModels] = useState<LocalCatalogModelEntry[]>([]);
  const [ollamaCatalog, setOllamaCatalog] = useState<OllamaCatalogCheck | null>(null);
  const [ollamaCatalogChecking, setOllamaCatalogChecking] = useState(false);
  const [ollamaCatalogMsg, setOllamaCatalogMsg] = useState('');
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
  const [stackInstallDrafts, setStackInstallDrafts] = useState<Record<string, StackInstallDraft>>({});
  const [stackPortOverrides, setStackPortOverrides] = useState<Record<string, number>>({});
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
  type ImgProbe = { ok: boolean; url: string; type: 'auto1111' | 'openai'; detail: string };
  const [imgServer, setImgServer] = useState<ImgServer | null>(null);
  const [imgProbe, setImgProbe] = useState<ImgProbe | null>(null);
  const [imgUrl, setImgUrl] = useState('');
  const [imgType, setImgType] = useState<'auto1111' | 'openai'>('auto1111');
  const [imgMsg, setImgMsg] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  async function loadImgServer() {
    const s = await call<ImgServer | null>('image:getServer').catch(() => null);
    setImgServer(s);
    setImgProbe(null);
    if (s) { setImgUrl(s.url); setImgType(s.type); }
    if (s) void probeImgServer(s);
  }
  async function probeImgServer(server?: ImgServer | null): Promise<ImgProbe | null> {
    const target = server ?? imageDraftServer;
    if (!target?.url) { setImgProbe(null); return null; }
    const probe = await call<ImgProbe | null>('image:probeServer', target).catch(() => null);
    setImgProbe(probe);
    return probe;
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
      const probe = saved ? await probeImgServer(saved) : null;
      setImgMsg(url
        ? probe?.ok
          ? `saved ✓ — ${probe.detail}`
          : `saved, but ${probe?.detail ?? 'not reachable'}; image generation will fall back to API when available`
        : 'cleared — image creation will use an image-capable API backend when available');
    } catch {
      setImgMsg('save failed');
    } finally { setImgBusy(false); }
  }
  async function detectImg() {
    setImgBusy(true); setImgMsg('scanning localhost…');
    try {
      const found = await call<ImgServer | null>('image:detectServer').catch(() => null);
      if (found) {
        setImgUrl(found.url);
        setImgType(found.type);
        const probe = await probeImgServer(found);
        setImgMsg(`found ${found.type === 'auto1111' ? 'Stable Diffusion WebUI' : 'OpenAI-style local API'} at ${found.url} — click Save to use it${probe?.detail ? ` (${probe.detail})` : ''}`);
      } else {
        setImgMsg('no local image server found on 7860/7861, common OpenAI-image ports, or configured local providers');
      }
    } finally { setImgBusy(false); }
  }
  const imageDraftServer: ImgServer | null = imgUrl.trim()
    ? { url: imgUrl.trim().replace(/\/+$/, ''), type: imgType }
    : null;
  const imageSavedStamp = imageServerStamp(imgServer);
  const imageDraftStamp = imageServerStamp(imageDraftServer);
  const imageDraftChanged = !!imageDraftServer && imageDraftStamp !== imageSavedStamp;
  const imageSaveDisabled = imgBusy || !imageDraftServer || !imageDraftChanged;

  async function loadOllama() {
    const r = await call<{ ok: boolean; models: OllamaModel[] }>('ollama:tags').catch(() => ({ ok: false, models: [] as OllamaModel[] }));
    setOllamaModels(r.models ?? []);
    return r.models ?? [];
  }
  async function loadLocalModelCatalog() {
    const rows = await call<LocalCatalogModelEntry[]>('ollama:localCatalog').catch(() => [] as LocalCatalogModelEntry[]);
    setLocalCatalogModels(rows ?? []);
    return rows ?? [];
  }
  async function checkOllamaCatalog(options: { silent?: boolean; models?: OllamaModel[]; localCatalog?: LocalCatalogModelEntry[] } = {}) {
    const models = options.models ?? ollamaModels;
    const localCatalog = options.localCatalog ?? localCatalogModels;
    if (!options.silent) setOllamaCatalogMsg('checking Ollama library…');
    setOllamaCatalogChecking(true);
    try {
      const r = await call<OllamaCatalogCheck>(
        'ollama:catalogCheck',
        models,
        [...LOCAL_MODEL_CATALOG.map((m) => m.id), ...localCatalog.map((m) => m.id)],
      );
      if (r.savedModels) setLocalCatalogModels(r.savedModels);
      setOllamaCatalog(r);
      const msg = r.ok
        ? `${r.installedUpdates.length} update${r.installedUpdates.length === 1 ? '' : 's'} · ${r.savedCount ?? r.newModels.length} added`
        : `catalog check failed${r.error ? `: ${r.error}` : ''}`;
      setOllamaCatalogMsg(r.error && r.ok ? `${msg} · partial check` : msg);
    } catch (e) {
      setOllamaCatalogMsg(`catalog check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOllamaCatalogChecking(false);
    }
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
        void checkOllamaCatalog({ silent: true, models });
        setPullMsg(`downloaded/refreshed ${m} ✓ · Ollama connected`);
      }
    } finally {
      setPulling(false);
    }
  }
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
  function catalogModelMeta(m: OllamaCatalogModel): string {
    return [m.sizeLabel, m.contextLabel ? `${m.contextLabel} ctx` : '', m.inputLabel, m.updatedLabel ? `updated ${m.updatedLabel}` : '']
      .filter(Boolean)
      .join(' · ');
  }
  const bundledModelIds = new Set(LOCAL_MODEL_CATALOG.map((m) => m.id));
  const browsableModelCatalog: LocalModelEntry[] = (() => {
    const byId = new Map<string, LocalModelEntry>();
    for (const m of TOP_LOCAL_MODEL_CATALOG) byId.set(m.id, m);
    for (const m of localCatalogModels) {
      if (!bundledModelIds.has(m.id)) byId.set(m.id, m);
    }
    return [...byId.values()];
  })();
  const discoveredCatalogCount = localCatalogModels.filter((m) => !bundledModelIds.has(m.id)).length;
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
  }
  const filteredModels = browsableModelCatalog.filter((m) => {
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
  const catalogUpdateRows = ollamaCatalog?.installedUpdates.slice(0, 8) ?? [];
  const catalogUpdateCount = ollamaCatalog?.installedUpdates.length ?? 0;
  const ollamaCatalogStatus = ollamaCatalog
    ? `catalog checked ${timeAgo(ollamaCatalog.checkedAt)}`
    : ollamaCatalogChecking
      ? 'checking catalog…'
      : 'catalog unchecked';
  const localBackendConfigured = localProviders.some((p) => p.enabled !== false);
  const localRouteReadyProviders = localProviders.filter(providerRouteReady);
  const installedLocalStackRows = TOP_LOCAL_STACKS
    .map((stack) => {
      const status = stackInstallStatus[stack.id];
      const running = stackClaimedPorts(stack).some((port) => runningPorts.has(port));
      const configured = stackConfiguredProviders(stack).length > 0;
      return { stack, status, running, configured };
    })
    .filter((row) => row.status?.installed);
  const installedLocalStacks = installedLocalStackRows.map((row) => row.stack.name);
  const localBackendReady = localRouteReadyProviders.length > 0;
  const localSyncCandidate = localProviders.find((p) => p.enabled !== false && providerKeyReady(p) && !providerRouteReady(p));
  const localRoutingText = localBackendReady
    ? `routing ready: ${localRouteReadyProviders.map((p) => p.name).join(', ')}`
    : localSyncCandidate
      ? `routing sync needed: ${localSyncCandidate.name}`
      : starterInstalled
        ? 'routing not added'
        : 'starter model needed';
  const localCatalogText = catalogUpdateCount
    ? `${catalogUpdateCount} catalog update${catalogUpdateCount === 1 ? '' : 's'}`
    : discoveredCatalogCount
      ? `${discoveredCatalogCount} catalog tag${discoveredCatalogCount === 1 ? '' : 's'}`
      : 'starter catalog';
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
  function providerInstalledStack(p: ProviderRow): LocalStackEntry | undefined {
    return TOP_LOCAL_STACKS.find((s) => {
      const baseUrl = stackApiBaseForInstallStatus(s, stackInstallStatus[s.id]);
      return !!baseUrl && normUrl(baseUrl) === normUrl(p.baseUrl) && stackInstallStatus[s.id]?.installed;
    });
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
    const liveProbe = probe[p.name];
    if (liveProbe?.status === 'live') return liveProbe.models.length > 0;
    return (p.lastSync?.modelCount ?? 0) > 0 || p.lastSync?.status === 'preset';
  }
  function providerRouteReady(p: ProviderRow): boolean {
    return p.enabled !== false && providerKeyReady(p) && providerModelReady(p);
  }
  function providerDefaultBlockReason(p: ProviderRow): string {
    if (p.enabled === false) return 'The backend is disabled.';
    if (!providerKeyReady(p)) return 'The backend is missing a required API key.';
    if (providerStatus(p) === 'live' && !providerModelReady(p)) return 'The backend answered but returned no models.';
    if (!providerModelReady(p)) return 'The backend has no synced/preset model list yet.';
    return `Current status is ${providerStatus(p) ?? 'not synced'}.`;
  }
  function localProviderStatusHint(p: ProviderRow, stack?: LocalStackEntry): string {
    if (!isLocalProvider(p) || providerRouteReady(p)) return '';
    const label = stack?.name ?? p.name;
    const status = providerStatus(p);
    if (status === 'live' && !providerModelReady(p)) {
      return `${label} answered, but its model list is empty. Load or download a model in ${label}, then re-check models. Agents cannot route here until at least one model is synced.`;
    }
    if (status === 'unreachable') {
      if (stack?.id === 'lm-studio') {
        return 'LM Studio is saved as a backend, but its local API server is off. The app can be open without serving models; start the server, load or download a model if needed, then re-check.';
      }
      if (stack?.id === 'mlx-lm-server') {
        const bg = stackBackgroundStatus[stack.id];
        if (bg?.running) {
          return `MLX is running in the background${bg.pid ? ` (pid ${bg.pid})` : ''}, but ${p.baseUrl} is not answering yet. The first start may download/load the model; wait a moment, then re-check.`;
        }
        return `MLX is installed and saved as a backend, but the API server is not running at ${p.baseUrl}. Use Start background to keep mlx_lm.server running outside this window.`;
      }
      return `${label} is saved as a backend, but no API server is listening at ${p.baseUrl}. Start its local API server, then re-check.`;
    }
    if (status === 'auth-error') {
      return `${label} answered but requires a key or token before models can be listed.`;
    }
    if (p.enabled === false && stack) {
      return `${label} is installed but not enabled for routing. Start the server, then connect it when ready.`;
    }
    if (!providerModelReady(p)) {
      return `${label} has no synced model list yet. Start the server and re-check before assigning agents.`;
    }
    return '';
  }
  function localProviderConnectLabel(p: ProviderRow): string {
    if (!isLocalProvider(p)) return 'Connect & sync';
    const status = providerStatus(p);
    if (status === 'live' && !providerModelReady(p)) return 'Re-check models';
    if (status === 'unreachable') return 'Re-check';
    return 'Connect & sync';
  }
  function normalizeModels(models: string[] | undefined): string[] {
    return Array.from(new Set((models ?? []).map((m) => String(m).trim()).filter(Boolean)));
  }
  function syncedProviderModels(p: ProviderRow): string[] {
    return normalizeModels(p.lastSync?.models);
  }
  function savedProviderModels(p: ProviderRow): string[] {
    const all = syncedProviderModels(p);
    if (p.modelSelection?.mode !== 'selected') return all;
    const allowed = new Set(normalizeModels(p.modelSelection.models));
    const visible = all.filter((m) => allowed.has(m));
    return visible.length ? visible : all;
  }
  function draftProviderModels(p: ProviderRow): string[] {
    return providerModelDrafts[p.name] ?? savedProviderModels(p);
  }
  function providerModelSelectionChanged(p: ProviderRow): boolean {
    return sortedKey(draftProviderModels(p)) !== sortedKey(savedProviderModels(p));
  }
  function providerModelQuery(p: ProviderRow): string {
    return (providerModelSearch[p.name] ?? '').trim().toLowerCase();
  }
  function filteredProviderModels(p: ProviderRow): string[] {
    const q = providerModelQuery(p);
    const all = syncedProviderModels(p);
    return (q ? all.filter((m) => m.toLowerCase().includes(q)) : all).slice(0, 80);
  }
  function updateProviderModelDraft(p: ProviderRow, models: string[]) {
    const allowed = new Set(syncedProviderModels(p));
    const nextModels = normalizeModels(models).filter((m) => allowed.has(m));
    setProviderModelDrafts((prev) => ({ ...prev, [p.name]: nextModels }));
  }
  function toggleProviderModel(p: ProviderRow, model: string) {
    const selected = new Set(draftProviderModels(p));
    if (selected.has(model)) selected.delete(model);
    else selected.add(model);
    updateProviderModelDraft(p, [...selected]);
  }
  async function saveProviderModelsForHealth(p: ProviderRow, mode: 'all' | 'selected') {
    const fresh = await ensureProviderFresh(p.name, 'Save Health models');
    if (!fresh) return;
    const current = fresh.current;
    const all = syncedProviderModels(current);
    const allowed = new Set(all);
    const selected = mode === 'selected'
      ? draftProviderModels(p).filter((m) => allowed.has(m))
      : [];
    if (mode === 'selected' && !selected.length) {
      window.alert('Pick at least one model, or choose Show all.');
      return;
    }
    const selection: ProviderModelSelection = mode === 'selected' && selected.length < all.length
      ? { mode: 'selected', models: selected }
      : { mode: 'all', models: [] };
    setBusy(true);
    try {
      const next = await call<ProviderRow[]>('providers:setModelSelection', current.name, selection, providerStamp(current));
      setProviders(next);
      setProviderModelDrafts((prev) => {
        const out = { ...prev };
        delete out[current.name];
        return out;
      });
      setProviderMsg(selection.mode === 'selected'
        ? `"${current.name}" Health dropdown now shows ${selected.length} selected model${selected.length === 1 ? '' : 's'}`
        : `"${current.name}" Health dropdown now shows all synced models`);
      void call<Record<string, string[]>>('runtime:models').catch(() => null);
      void call('runtime:freshness').catch(() => null);
    } finally {
      setBusy(false);
    }
  }
  function isLocalProvider(p: ProviderRow): boolean {
    return p.kind === 'ollama' || p.kind === 'lmstudio' || (p.baseUrl || '').includes('127.0.0.1') || (p.baseUrl || '').includes('localhost');
  }
  const localBackendModelSources = (() => {
    const rows: Array<{
      key: string;
      label: string;
      detail: string;
      models: string[];
      configured: boolean;
      live: boolean;
      providerName?: string;
    }> = [];
    const discoveredLive = (discovered ?? []).filter((s) => s.status === 'live');
    const seen = new Set<string>();
    for (const p of localProviders) {
      const scan = discoveredLive.find((s) => normUrl(s.baseUrl) === normUrl(p.baseUrl));
      const models = normalizeModels([...(scan?.models ?? []), ...syncedProviderModels(p)]);
      const stack = providerInstalledStack(p);
      const status = providerStatus(p);
      const live = scan?.status === 'live' || status === 'live';
      seen.add(normUrl(p.baseUrl));
      rows.push({
        key: `provider:${p.name}`,
        label: stack?.name ?? p.name,
        detail: `${p.name} · ${live ? 'live' : status ?? 'configured'} · ${p.baseUrl}`,
        models,
        configured: true,
        live,
        providerName: p.name,
      });
    }
    for (const s of discoveredLive) {
      const url = normUrl(s.baseUrl);
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({
        key: `scan:${url}`,
        label: s.name,
        detail: `live scan · add backend to route agents · ${s.baseUrl}`,
        models: normalizeModels(s.models),
        configured: false,
        live: true,
      });
    }
    for (const { stack, running, configured } of installedLocalStackRows) {
      if (stack.id === 'ollama') continue;
      const base = stackApiBase(stack);
      const key = base ? normUrl(base) : stack.id;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key: `stack:${stack.id}`,
        label: stack.name,
        detail: running ? 'running scan found the port, but no model list was returned' : configured ? 'backend configured; connect & sync to list models' : 'installed; start its API server, then scan running',
        models: [],
        configured,
        live: running,
      });
    }
    return rows
      .filter((row) => row.label !== 'Ollama')
      .sort((a, b) => Number(b.models.length > 0) - Number(a.models.length > 0) || Number(b.live) - Number(a.live) || a.label.localeCompare(b.label));
  })();
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
  function stackCommand(command?: string): string {
    return (command ?? '').split('#')[0].trim();
  }
  function browserStackPlatform(): LocalStackEntry['platforms'][number] | null {
    const platform = (navigator.platform || '').toLowerCase();
    const ua = (navigator.userAgent || '').toLowerCase();
    if (platform.includes('mac') || ua.includes('mac os')) return 'macos';
    if (platform.includes('win') || ua.includes('windows')) return 'windows';
    if (platform.includes('linux') || ua.includes('linux')) return 'linux';
    return null;
  }
  function hostStackPlatform(): LocalStackEntry['platforms'][number] | null {
    if (!hardware?.platform) return browserStackPlatform();
    if (hardware.platform === 'darwin') return 'macos';
    if (hardware.platform === 'win32') return 'windows';
    if (hardware.platform === 'linux') return 'linux';
    return browserStackPlatform();
  }
  function stackPlatformSupported(s: LocalStackEntry): boolean {
    const host = hostStackPlatform();
    return !host || s.platforms.includes(host);
  }
  function platformLabel(p: LocalStackEntry['platforms'][number]): string {
    if (p === 'macos') return 'macOS';
    if (p === 'windows') return 'Windows';
    return 'Linux';
  }
  function stackInstallUnavailableReason(s: LocalStackEntry): string | null {
    const command = stackCommand(s.install);
    const host = hostStackPlatform();
    if (host && !s.platforms.includes(host)) {
      return `${s.name} is listed for ${s.platforms.map(platformLabel).join('/')} hosts; this machine is ${platformLabel(host)}. Open the docs or run it on a compatible host, then add its API backend here.`;
    }
    if (!command) return 'No safe one-click install command is registered; open the project docs.';
    if (STACK_PLACEHOLDER_CMD_RE.test(command)) return 'This command is a template and needs values such as a model id before it can run safely; open the docs and add the running API as a backend afterward.';
    if (!STACK_RUNNABLE_CMD_RE.test(command)) return 'No safe one-click install command is registered; open the project docs.';
    return null;
  }
  function stackInstallUnavailableLabel(s: LocalStackEntry): string {
    const command = stackCommand(s.install);
    const host = hostStackPlatform();
    if (host && !s.platforms.includes(host)) return `${s.platforms.map(platformLabel).join('/')} host required`;
    if (command && STACK_PLACEHOLDER_CMD_RE.test(command)) return 'choose model first';
    if (!command || !STACK_RUNNABLE_CMD_RE.test(command)) return 'manual setup';
    return 'setup review required';
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
  function openStackSetup() {
    setStackTag(STACK_BACKEND_PRESET_FILTER);
    requestAnimationFrame(() => document.getElementById('local-llm-stacks')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  function stackPrimaryAction(s: LocalStackEntry): boolean {
    if (!stackInstallCmd(s)) return false;
    return ['start-here', 'easy', 'guided', 'advanced'].includes(s.installEase ?? '');
  }
  function stackInstallLabel(s: LocalStackEntry): string {
    if (stackPrimaryAction(s)) return 'Install';
    return 'Review command';
  }
  function stackInstallManaged(status?: LocalStackInstallStatus): boolean {
    return /homebrew|pip package|docker container/i.test(status?.source ?? '');
  }
  function stackInstallCmd(s: LocalStackEntry): string | null {
    const c = stackCommand(s.install);
    if (!c || stackInstallUnavailableReason(s)) return null;
    return c && STACK_RUNNABLE_CMD_RE.test(c) ? c : null;
  }
  function stackUninstallCmd(s: LocalStackEntry): string | null {
    const c = stackCommand(s.uninstall);
    return c && STACK_RUNNABLE_CMD_RE.test(c) ? c : null;
  }
  function stackStartCmd(s: LocalStackEntry): string | null {
    const c = stackCommand(s.start);
    return c && STACK_RUNNABLE_CMD_RE.test(c) ? c : null;
  }
  function stackCanStartBackground(s: LocalStackEntry): boolean {
    return STACK_BACKGROUND_START_IDS.has(s.id) && !!stackStartCmd(s);
  }
  function stackBackgroundRunning(s: LocalStackEntry): boolean {
    return stackBackgroundStatus[s.id]?.running === true;
  }
  function stackUsesDockerCommand(command?: string | null): boolean {
    return /^docker\b/.test(command ?? '');
  }
  async function ensureDockerReady(s: LocalStackEntry, command: string): Promise<boolean> {
    if (!stackUsesDockerCommand(command)) return true;
    const status = await call<DockerStatus>('stack:dockerStatus').catch((e): DockerStatus => ({
      installed: false,
      serverRunning: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!status.installed) {
      setStackMsg(`${s.name} needs Docker Desktop or Docker Engine before IDACC can run this command.`);
      return false;
    }
    if (!status.serverRunning) {
      setStackMsg(`${s.name} needs Docker running first. Start Docker Desktop, then try again.`);
      return false;
    }
    return true;
  }
  function portFromBaseUrl(u?: string): number | null {
    if (!u) return null;
    try {
      const url = new URL(u);
      if (url.port) return Number(url.port);
      if (url.protocol === 'http:') return 80;
      if (url.protocol === 'https:') return 443;
      return null;
    } catch {
      return null;
    }
  }
  function withBaseUrlPort(baseUrl: string, port: number): string {
    try {
      const url = new URL(baseUrl);
      url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
      url.port = String(port);
      return url.toString().replace(/\/+$/, '');
    } catch {
      return baseUrl;
    }
  }
  function stackPortOverride(s: LocalStackEntry): number | undefined {
    return stackInstallDrafts[s.id]?.port ?? stackPortOverrides[s.id];
  }
  function stackApiBase(s: LocalStackEntry): string | undefined {
    if (!s.apiBase) return undefined;
    const override = stackPortOverride(s);
    return override ? withBaseUrlPort(s.apiBase, override) : s.apiBase;
  }
  function stackInstallEffectiveCmd(s: LocalStackEntry): string | null {
    return stackInstallDrafts[s.id]?.command ?? stackInstallCmd(s);
  }
  function stackProviderId(s: LocalStackEntry): string {
    return Object.entries(LOCAL_PROVIDER_STACK_IDS).find(([, stackId]) => stackId === s.id)?.[0] ?? s.id;
  }
  function stackExtraDiscoveryCandidate(s: LocalStackEntry): LocalServerCandidate | null {
    const port = stackPortOverride(s);
    const apiBase = stackApiBase(s);
    if (!port || !apiBase || !['ollama', 'lmstudio', 'openai-compatible'].includes(s.apiKind)) return null;
    return {
      id: stackProviderId(s),
      name: s.name,
      kind: s.apiKind as ProviderKind,
      baseUrl: apiBase,
      port,
      popularity: 'medium',
      notes: 'Operator-selected alternate port from Local LLM stack install review.',
    };
  }
  function stackExtraDiscoveryCandidates(): LocalServerCandidate[] {
    return TOP_LOCAL_STACKS
      .map(stackExtraDiscoveryCandidate)
      .filter((x): x is LocalServerCandidate => Boolean(x));
  }
  function suggestFreeStackPort(port: number): number | undefined {
    const configuredPorts = providers.map(providerPort).filter((p): p is number => typeof p === 'number');
    const catalogPorts = TOP_LOCAL_STACKS.flatMap((row) => {
      const ports = new Set<number>();
      if (row.defaultPort) ports.add(row.defaultPort);
      const apiPort = portFromBaseUrl(row.apiBase);
      if (apiPort) ports.add(apiPort);
      const cmd = stackCommand(row.install);
      for (const match of cmd.matchAll(/\s-p\s+(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d+):\d+/g)) ports.add(Number(match[1]));
      for (const match of cmd.matchAll(/(?:--port|--tcp)\s+(\d+)/g)) ports.add(Number(match[1]));
      return [...ports];
    });
    const blocked = new Set<number>([...runningPorts, ...configuredPorts, ...catalogPorts, ...Object.values(stackPortOverrides)]);
    for (let next = port + 1; next < Math.min(65535, port + 100); next += 1) {
      if (!blocked.has(next)) return next;
    }
    return undefined;
  }
  function rewriteStackCommandPort(command: string, fromPort: number, toPort: number): { command: string; changed: boolean } {
    const escaped = String(fromPort).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let next = command;
    next = next.replace(new RegExp(`(\\s-p\\s+)((?:(?:\\d{1,3}\\.){3}\\d{1,3}:)?)${escaped}:(\\d+)`, 'g'), `$1$2${toPort}:$3`);
    next = next.replace(new RegExp(`(--port\\s+)${escaped}\\b`, 'g'), `$1${toPort}`);
    next = next.replace(new RegExp(`(--tcp\\s+)${escaped}\\b`, 'g'), `$1${toPort}`);
    return { command: next, changed: next !== command };
  }
  function stackInstallAutoFix(s: LocalStackEntry, port: number): StackInstallDraft | null {
    const command = stackInstallCmd(s);
    const suggested = suggestFreeStackPort(port);
    if (!command || !suggested) return null;
    const rewritten = rewriteStackCommandPort(command, port, suggested);
    if (!rewritten.changed) return null;
    return {
      command: rewritten.command,
      port: suggested,
      originalPort: port,
      baseUrl: s.apiBase ? withBaseUrlPort(s.apiBase, suggested) : undefined,
      autoFixed: true,
      note: `Auto-adjusted ${s.name} from port ${port} to ${suggested}.`,
    };
  }
  function setStackInstallDraft(id: string, draft: StackInstallDraft | null) {
    setStackInstallDrafts((prev) => {
      const next = { ...prev };
      if (draft) next[id] = draft;
      else delete next[id];
      return next;
    });
  }
  function stackConfiguredProviders(s: LocalStackEntry): ProviderRow[] {
    const apiBase = stackApiBase(s) ? normUrl(stackApiBase(s) ?? '') : null;
    return providers.filter((p) => apiBase && normUrl(p.baseUrl) === apiBase);
  }
  function stackClaimedPorts(s: LocalStackEntry): number[] {
    const ports = new Set<number>();
    const addPort = (value: string | number | undefined | null) => {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
    };
    const override = stackPortOverride(s);
    addPort(override ?? s.defaultPort);
    addPort(portFromBaseUrl(stackApiBase(s)));
    if (!override || stackInstallDrafts[s.id]) {
      const install = stackInstallEffectiveCmd(s) ?? stackCommand(s.install);
      for (const match of install.matchAll(/\s-p\s+(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d+):\d+/g)) addPort(match[1]);
      for (const match of install.matchAll(/(?:--port|--tcp)\s+(\d+)/g)) addPort(match[1]);
    }
    return [...ports].sort((a, b) => a - b);
  }
  function stackPortLabel(s: LocalStackEntry): string | null {
    const ports = stackClaimedPorts(s);
    if (!ports.length) return null;
    return ports.length === 1 ? `:${ports[0]}` : `ports ${ports.join('/')}`;
  }
  function stackOwnPorts(s: LocalStackEntry): Set<number> {
    const ports = new Set<number>();
    const apiBase = stackApiBase(s);
    const normalizedApiBase = apiBase ? normUrl(apiBase) : null;
    for (const p of stackConfiguredProviders(s)) {
      const port = providerPort(p);
      if (port) ports.add(port);
    }
    for (const d of discovered ?? []) {
      if (normalizedApiBase && normUrl(d.baseUrl) === normalizedApiBase) ports.add(d.port);
    }
    return ports;
  }
  function stackPortConflicts(s: LocalStackEntry): { live: number[]; configured: { port: number; names: string[] }[] } {
    const ports = stackClaimedPorts(s);
    const ownPorts = stackOwnPorts(s);
    const ownApiBase = stackApiBase(s) ? normUrl(stackApiBase(s) ?? '') : null;
    const live = ports.filter((p) => runningPorts.has(p) && !ownPorts.has(p));
    const configured = ports
      .map((port) => ({
        port,
        names: providers
          .filter((p) => providerPort(p) === port && (!ownApiBase || normUrl(p.baseUrl) !== ownApiBase))
          .map((p) => p.name),
      }))
      .filter((hit) => hit.names.length > 0);
    return { live, configured };
  }
  function reviewStackInstall(s: LocalStackEntry) {
    const command = stackInstallCmd(s);
    if (!command) {
      setStackMsg(stackInstallUnavailableReason(s) ?? `${s.name} does not have a safe one-click install command.`);
      return;
    }
    const conflicts = stackPortConflicts(s);
    const hardPorts = [...new Set([...conflicts.live, ...conflicts.configured.map((hit) => hit.port)])];
    const fixPort = hardPorts[0];
    const fixedDraft = fixPort ? stackInstallAutoFix(s, fixPort) : null;
    const warnings = [
      conflicts.live.length ? `Live server detected on port ${conflicts.live.join(', ')}; stop it or edit the Terminal command to use another port.` : '',
      ...conflicts.configured.map((hit) => `Configured inference backend on port ${hit.port}: ${hit.names.join(', ')}.`),
    ].filter(Boolean);
    const draft = fixedDraft ?? { command };
    const fixLines = fixedDraft ? [
      '',
      `IDACC will use a conflict-safe command: port ${fixedDraft.originalPort} → ${fixedDraft.port}.`,
      fixedDraft.baseUrl ? `Backend URL after scan/add: ${fixedDraft.baseUrl}` : '',
    ].filter(Boolean) : [];
    if (warnings.length && !window.confirm([
      `Review install for ${s.name}?`,
      '',
      ...warnings.map((w) => `- ${w}`),
      ...fixLines,
      '',
      'The command will open visibly in Terminal and can be edited or cancelled there.',
    ].join('\n'))) return;
    setStackInstallDraft(s.id, draft);
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
        const detectedPort = status[s.id]?.port;
        if (detectedPort) setStackPortOverrides((prev) => ({ ...prev, [s.id]: detectedPort }));
        const installed = status[s.id]?.installed === true;
        if (action === 'install' && installed) {
          setStackMsg(`${s.name} installed. ${stackCanStartBackground(s) ? 'Use Start background to run its local API server.' : 'Start its local server, then Scan running to add it as a backend.'}`);
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
  function scheduleStackDiscoverScans(s: LocalStackEntry) {
    if (!stackApiBase(s)) return;
    [8000, 22000, 46000].forEach((delay) => {
      setTimeout(() => void runDiscover({ autoAddKnownStacks: true }), delay);
    });
  }
  async function startStackBackground(s: LocalStackEntry) {
    const cmd = stackStartCmd(s);
    if (!cmd) return;
    setBusy(true);
    try {
      const status = await call<BackgroundStackStatus>('stack:startBackground', s.id, cmd);
      setStackBackgroundStatus((prev) => ({ ...prev, [s.id]: status }));
      setStackMsg(`${s.name} ${status.detail ?? 'started'}${status.pid ? ` · pid ${status.pid}` : ''}${status.logPath ? ` · log ${status.logPath}` : ''}. IDACC will re-check the API and sync models when it answers.`);
      scheduleStackDiscoverScans(s);
      [3000, 10000, 24000].forEach((delay) => {
        setTimeout(() => void checkBackgroundStacks(), delay);
      });
    } catch (e) {
      setStackMsg(`failed to start ${s.name} in background: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function stopStackBackground(s: LocalStackEntry) {
    setBusy(true);
    try {
      const status = await call<BackgroundStackStatus>('stack:stopBackground', s.id);
      setStackBackgroundStatus((prev) => ({ ...prev, [s.id]: status }));
      setStackMsg(`${s.name}: ${status.detail ?? 'stopped'}. Re-check if an external copy is still running on port ${s.defaultPort ?? 'its port'}.`);
      void runDiscover();
    } catch (e) {
      setStackMsg(`failed to stop ${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function runStackCmd(s: LocalStackEntry, action: 'install' | 'uninstall' | 'start' = 'install') {
    if (action === 'start' && stackCanStartBackground(s)) {
      await startStackBackground(s);
      return;
    }
    const draft = action === 'install' ? stackInstallDrafts[s.id] : undefined;
    const cmd = action === 'install'
      ? (draft?.command ?? stackInstallCmd(s))
      : action === 'start'
        ? stackStartCmd(s)
        : stackUninstallCmd(s);
    if (!cmd) return;
    if (!await ensureDockerReady(s, cmd)) return;
    if (action === 'install' && stackUsesDockerCommand(cmd)) {
      const status = await call<Record<string, LocalStackInstallStatus>>('stack:installStatus', [s.id]).catch((): Record<string, LocalStackInstallStatus> => ({}));
      setStackInstallStatus((prev) => ({ ...prev, ...status }));
      const detectedPort = status[s.id]?.port;
      if (detectedPort) setStackPortOverrides((prev) => ({ ...prev, [s.id]: detectedPort }));
      if (status[s.id]?.installed) {
        setStackConfirm(null);
        setStackInstallDraft(s.id, null);
        setStackMsg(`${s.name} already has ${status[s.id]?.source ?? 'a Docker container'}; use Start or Uninstall instead of Install.`);
        return;
      }
    }
    setStackConfirm(null);
    const r = await call<{ ran: boolean }>('app:runInTerminal', cmd).catch(() => ({ ran: false }));
    if (action === 'install') {
      if (draft?.port) setStackPortOverrides((prev) => ({ ...prev, [s.id]: draft.port as number }));
      setStackInstallDraft(s.id, null);
    }
    if (r.ran) {
      setStackMsg(action === 'install'
        ? `opened Terminal to install ${s.name}${draft?.port ? ` on port ${draft.port}` : ''}. IDACC will rescan and add the backend automatically if the server starts.`
        : action === 'start'
          ? `opened Terminal to start ${s.name}. IDACC will rescan and add or refresh the backend when it answers locally.`
          : `opened Terminal to uninstall ${s.name}. Review and stop it there if anything looks wrong.`);
      if (action === 'install' || action === 'start') {
        scheduleStackDiscoverScans(s);
      }
      if (action !== 'start') {
        scheduleStackInstallChecks(s, action);
      }
    } else {
      await copyText(cmd);
      setStackMsg(`Terminal automation was blocked — ${action} command copied to clipboard${draft?.port ? ` with port ${draft.port}` : ''}`);
    }
  }
  /** Port conflict display shows only current-state evidence: live scanned ports or configured backends. */
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
    void loadLocalModelCatalog().then((localCatalog) =>
      loadOllama().then((models) => { void checkOllamaCatalog({ silent: true, models, localCatalog }); }),
    );
    void checkStackInstalls();
    void checkBackgroundStacks();
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
    const refreshLocal = (reason: 'timer' | 'focus' = 'timer') => {
      const now = Date.now();
      if (localRefreshRunningRef.current) return;
      if (reason === 'focus' && now - localRefreshLastAtRef.current < SETTINGS_FOCUS_REFRESH_MIN_MS) return;
      localRefreshRunningRef.current = true;
      localRefreshLastAtRef.current = now;
      void Promise.allSettled([
        loadLocalModelCatalog(),
        loadOllama(),
        checkBackgroundStacks(),
        runDiscover(),
      ]).finally(() => {
        localRefreshRunningRef.current = false;
      });
    };
    const onFocus = () => refreshLocal('focus');
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshLocal('timer');
    }, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const refreshCatalog = () => {
      void loadLocalModelCatalog().then((localCatalog) =>
        loadOllama().then((models) => { void checkOllamaCatalog({ silent: true, models, localCatalog }); }),
      );
    };
    const timer = window.setInterval(refreshCatalog, OLLAMA_CATALOG_REFRESH_MS);
    return () => window.clearInterval(timer);
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
            <button className="btn small" type="button" onClick={() => navigate?.('teams:route')} title="Open HR Manager Manage → Hierarchy & sync to change team coordinators with a fresh hierarchy preview">
              Open HR Manage
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Agent chain RPCs</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          JSON-RPC endpoints agents may use when they hold an active granted key. Public RPCs can leave the key blank; Alchemy/Infura-style URLs can use <span className="mono">{'{API_KEY}'}</span>. Linked keys are encrypted by the desktop app and never shown back here.
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
          {evmRpcs.length === 0 ? <p className="muted small center pad">No agent chain RPCs configured.</p> : null}
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
          <span>auto-download</span>
          <b>
            <input
              type="checkbox"
              checked={upd?.autoUpgrade ?? true}
              onChange={(e) => void saveUpdate({ autoUpgrade: e.target.checked })}
            />{' '}
            <span className="muted small">download updates automatically; restart still requires Restart & update</span>
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
          <h3 style={{ margin: 0 }}>Local models & backends</h3>
          <span className="grow" />
          <span className={catalogUpdateCount ? 'warn-text small' : 'muted small'} title={ollamaCatalogMsg || undefined}>
            {ollamaCatalogStatus}
          </span>
          <button className="btn small" disabled={ollamaCatalogChecking} title="Scan public Ollama tags and add newly discovered entries to the local searchable catalog" onClick={() => void checkOllamaCatalog()}>
            {ollamaCatalogChecking ? 'Checking…' : 'Check catalog'}
          </button>
          <button className="btn small" disabled={discovering} onClick={() => void runDiscover()}>
            {discovering ? 'Scanning…' : 'Scan running'}
          </button>
          <button className="btn small" type="button" onClick={openStackSetup}>
            Stack setup
          </button>
        </div>
        <div className="local-model-status-line">
          <span className={localBackendReady ? 'ok-text' : localBackendConfigured || starterInstalled ? 'warn-text' : 'status-error'}>
            {localRoutingText}
          </span>
          <span>{ollamaModels.length ? `${ollamaModels.length} Ollama model${ollamaModels.length === 1 ? '' : 's'}` : 'no Ollama models'}</span>
          {installedLocalStacks.length ? <span>stacks: {installedLocalStacks.join(', ')}</span> : null}
          <span className={catalogUpdateCount ? 'warn-text' : 'muted'}>{localCatalogText}</span>
          <span className="grow" />
          {!localBackendReady ? (
            <span className="row-actions">
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
            </span>
          ) : null}
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="muted small">Ollama models:</span>
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
                    <>
                      <button title={`Uninstall ${m.name}`} onClick={() => setConfirmRemove(m.name)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)', padding: 0, fontSize: 11, lineHeight: 1 }}>✕</button>
                    </>
                  )}
                </span>
              ))}
            </span>
          )}
          <button className="btn small" title="Refresh installed list" onClick={() => void loadOllama()}>↻</button>
        </div>
        {localBackendModelSources.length ? (
          <div className="local-backend-models">
            <div className="muted small">other local backends</div>
            {localBackendModelSources.map((row) => (
              <div className="local-backend-model-row" key={row.key}>
                <div className="local-backend-model-title">
                  <b>{row.label}</b>
                  <span className={row.live ? 'ok-text small' : row.configured ? 'warn-text small' : 'muted small'}>
                    {row.models.length ? `${row.models.length} model${row.models.length === 1 ? '' : 's'}` : row.live ? 'no models returned' : row.configured ? 'sync needed' : 'not running'}
                  </span>
                </div>
                <div className="chips grow">
                  {row.models.slice(0, 8).map((m) => <span className="chip mono" key={m}>{m}</span>)}
                  {row.models.length > 8 ? <span className="muted small">+{row.models.length - 8} more</span> : null}
                  {!row.models.length ? <span className="muted small">{row.detail}</span> : null}
                </div>
                {row.providerName && !row.models.length ? (
                  <button className="btn small" disabled={busy} onClick={() => void connect(row.providerName!)}>Connect &amp; sync</button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {catalogUpdateRows.length ? (
          <div className="local-driving-strip warn" style={{ marginTop: 8 }}>
            <div className="grow">
              <b>Installed Ollama updates available</b>
              <span>Remote digests changed. Re-pull to pick up rebuilt weights or engine-specific artifacts.</span>
            </div>
            <div className="row-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {catalogUpdateRows.map((m) => (
                <button key={m.name} className="btn small" disabled={pulling} title={`${m.digest ?? ''}${m.updatedLabel ? ` · updated ${m.updatedLabel}` : ''}`} onClick={() => void pull(m.name)}>
                  Update {m.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {ollamaCatalogMsg && /fail/i.test(ollamaCatalogMsg) && !catalogUpdateRows.length ? (
          <p className="small status-error" style={{ margin: '6px 0 0' }}>
            {ollamaCatalogMsg}
          </p>
        ) : null}
        {localConc || concMsg ? (
          <div className="row-actions local-concurrency-row" style={{ marginTop: 10 }}>
            <span className="muted small">Local concurrency</span>
            <select
              className="cell-select"
              value={concInput}
              disabled={concBusy || !localConc}
              onChange={(e) => setConcInput(e.target.value)}
              title="How many local model requests the manager may run at the same time. Cloud and API runtimes are not capped here."
            >
              {LOCAL_CONCURRENCY_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} local model{n === 1 ? '' : 's'}</option>
              ))}
            </select>
            <button className="btn primary" disabled={concBusy || !localConc || concInput === String(localConc?.concurrency)} onClick={() => void saveConc()}>
              {concBusy ? 'Applying…' : 'Set concurrency'}
            </button>
            {localConc ? <span className="muted small">running {localConc.active}{localConc.queued ? ` · ${localConc.queued} queued` : ''}</span> : null}
            {concMsg ? <span className={`small grow ${/fail|1–16/.test(concMsg) ? 'status-error' : 'ok-text'}`}>{concMsg}</span> : null}
          </div>
        ) : pullMsg ? (
          <div className={`small ${/failed/.test(pullMsg) ? 'status-error' : pulling ? 'warn-text' : 'ok-text'}`}>{pullMsg}</div>
        ) : null}

        {/* Browsable model catalog */}
        <div className="model-catalog">
          <div className="row-actions model-catalog-toolbar">
            <input className="catalog-search" placeholder="search Ollama catalog…" value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} />
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
                        <button className="btn small" disabled={pulling} title="Re-pull this model to pick up updated weights or Ollama engine artifacts" onClick={() => void pull(m.id)}>Update</button>
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
          <input className="local-image-url" placeholder="paste URL or scan local providers…" value={imgUrl} disabled={imgBusy} onChange={(e) => setImgUrl(e.target.value)} />
          <select className="local-image-type" value={imgType} disabled={imgBusy} onChange={(e) => setImgType(e.target.value as 'auto1111' | 'openai')} title="Local image API style">
            <option value="auto1111">Stable Diffusion WebUI</option>
            <option value="openai">OpenAI Images API</option>
          </select>
          <button className="btn" disabled={imgBusy} onClick={() => void detectImg()}>Scan local</button>
          <button className="btn primary" disabled={imageSaveDisabled} title={!imageDraftServer ? 'Enter a URL or use Scan local first' : !imageDraftChanged ? 'This preference is already saved' : 'Save this local image generator preference'} onClick={() => void saveImgServer()}>{imgBusy ? '…' : 'Save'}</button>
          {imgServer ? <button className="btn" disabled={imgBusy} title="Clear — use an image-capable API backend when available" onClick={() => void saveImgServer(null)}>Clear</button> : null}
        </div>
        <div className="local-image-status">
          <div>
            <span className="muted small">Local preference</span>{' '}
            {imgServer
              ? <><b className="accent-text">{imgServer.type === 'auto1111' ? 'Stable Diffusion WebUI' : 'OpenAI Images API'}</b> <span className="mono">{imgServer.url}</span></>
              : imageDraftServer
                ? <><b className="warn-text">draft not saved</b> <span className="mono">{imageDraftServer.url}</span></>
                : <span className="muted">not configured</span>}
          </div>
          {imgServer ? (
            <div className="small">
              <span className="muted">Local check</span>{' '}
              {imgProbe && imageServerStamp(imgProbe) === imageSavedStamp
                ? <span className={imgProbe.ok ? 'ok-text' : 'warn-text'}>{imgProbe.detail}</span>
                : <span className="muted">not checked yet</span>}
            </div>
          ) : null}
          {imgServer && imageDraftChanged && imageDraftServer ? (
            <div className="warn-text small">Unsaved draft: {imageDraftServer.type === 'auto1111' ? 'Stable Diffusion WebUI' : 'OpenAI Images API'} <span className="mono">{imageDraftServer.url}</span></div>
          ) : null}
          <div className="muted small">Fallback: image-capable API backend from Inference backends when available.</div>
          {imgMsg ? <div className={`small ${imageMessageClass(imgMsg)}`}>{imgMsg}</div> : null}
        </div>
      </section>

      <section className="card" id="local-llm-stacks">
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
            const installDraft = stackInstallDrafts[s.id];
            const installCommand = installDraft?.command ?? ic;
            const sc = stackStartCmd(s);
            const uc = stackUninstallCmd(s);
            const installStatus = stackInstallStatus[s.id];
            const stackInstalled = installStatus?.installed === true;
            const backgroundRunning = stackBackgroundRunning(s);
            const installUnavailable = !ic && !stackInstalled ? stackInstallUnavailableReason(s) : null;
            const effectiveApiBase = stackApiBase(s);
            const configuredProviders = stackConfiguredProviders(s);
            const configured = configuredProviders.length > 0;
            const stackActive = stackInstalled || running || configured;
            const managedInstall = stackInstallManaged(installStatus);
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
                  {!stackPlatformSupported(s) ? <span className="chip tag" title={installUnavailable ?? undefined}>{s.platforms.map(platformLabel).join('/')}</span> : null}
                  {stackInstalled ? <span className="chip tag" title={installStatus?.detail ?? 'Detected installed package/container'}>installed</span> : null}
                  {running ? (
                    <span className={`small ${discoveryStale ? 'warn-text' : 'ok-text'}`} title={`Detected by scan ${discoveredAt ? timeAgo(discoveredAt) : 'recently'}`}>
                      {discoveryStale ? 'last scan running' : '● running'}
                    </span>
                  ) : null}
                  {backgroundRunning ? (
                    <span className="small ok-text" title={stackBackgroundStatus[s.id]?.logPath ? `IDACC started this process. Log: ${stackBackgroundStatus[s.id]?.logPath}` : 'IDACC started this process'}>
                      ● background
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
                  {confirmInstall && installCommand && !stackActive ? (
                    <>
                      <code className="mono" title={installDraft?.note}>{installCommand}</code>
                      {installDraft?.autoFixed ? <span className="small ok-text">auto-fixed port {installDraft.originalPort} → {installDraft.port}</span> : null}
                      <button className={`btn small${stackPrimaryAction(s) ? ' primary' : ''}`} title="Runs in your Terminal — visible and abortable" onClick={() => void runStackCmd(s, 'install')}>Run install</button>
                      <button className="btn small" onClick={() => { setStackConfirm(null); setStackInstallDraft(s.id, null); }}>Cancel</button>
                    </>
                  ) : confirmUninstall && uc && stackInstalled ? (
                    <>
                      <code className="mono">{uc}</code>
                      <button className="btn small" title="Runs in your Terminal — visible and abortable" onClick={() => void runStackCmd(s, 'uninstall')}>Run uninstall</button>
                      <button className="btn small" onClick={() => setStackConfirm(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      {!stackActive && ic ? (
                        <button className={`btn small${stackPrimaryAction(s) ? ' primary' : ''}`} title={ic} onClick={() => reviewStackInstall(s)}>{stackInstallLabel(s)}</button>
                      ) : !stackActive ? (
                        <a className="btn small" href={s.homepage} target="_blank" rel="noreferrer" title={installUnavailable ?? 'No CLI install — opens the download page'}>Docs ↗</a>
                      ) : null}
                      {installUnavailable ? <span className="muted small" title={installUnavailable}>{stackInstallUnavailableLabel(s)}</span> : null}
                      {running && !configured && effectiveApiBase ? (
                        <button className="btn small primary" title={`Add ${effectiveApiBase} as an inference backend after a fresh scan`} onClick={() => void addStackBackend(s)}>Add backend</button>
                      ) : null}
                      {backgroundRunning ? (
                        <button className="btn small" title="Stop the background process started by IDACC" onClick={() => void stopStackBackground(s)}>Stop</button>
                      ) : stackInstalled && !running && sc ? (
                        <button className="btn small primary" title={sc} onClick={() => void runStackCmd(s, 'start')}>{stackCanStartBackground(s) ? 'Start background' : 'Start'}</button>
                      ) : null}
                      {configuredProviders.length === 1 ? (
                        <button className="btn small" title={`Remove inference backend ${configuredProviders[0].name}; does not uninstall the app/server`} onClick={() => void removeProviderProfile(configuredProviders[0].name)}>Remove backend</button>
                      ) : null}
                      {uc && stackInstalled && managedInstall ? (
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
              const installedStack = providerInstalledStack(p);
              const pendingInstalledStack = !!installedStack && p.enabled === false && !sync && !o;
              const syncedModels = syncedProviderModels(p);
              const offeredModels = savedProviderModels(p);
              const apiModelFilterable = !isLocalProvider(p) && syncedModels.length > 0;
              const localHint = localProviderStatusHint(p, installedStack);
              const backgroundManaged = installedStack ? stackBackgroundRunning(installedStack) : false;
              const startableLocalStack = localHint && installedStack && !backgroundManaged && providerStatus(p) === 'unreachable' && stackStartCmd(installedStack)
                ? installedStack
                : undefined;
              const statusText = pendingInstalledStack
                ? 'installed · start server + connect'
                : o
                ? o.status === 'live'
                  ? o.models.length
                    ? `live · ${o.models.length} models`
                    : 'live · no models'
                  : o.status
                : sync
                  ? `${sync.status === 'live' ? sync.modelCount ? `synced · ${sync.modelCount} models` : 'synced · no models' : sync.status} · ${timeAgo(sync.at)}`
                  : 'not synced';
              const readyForDefault = providerRouteReady(p);
              const statusOk = readyForDefault;
              const statusWarn = (o?.status ?? sync?.status) === 'auth-error' || (providerStatus(p) === 'live' && !providerModelReady(p));
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
                      {apiModelFilterable ? (
                        <span className="chip" title="Models currently offered in the Health model dropdown" style={{ marginLeft: 6 }}>
                          {p.modelSelection?.mode === 'selected' ? `Health ${offeredModels.length}/${syncedModels.length}` : 'Health all'}
                        </span>
                      ) : null}
                      {canExpand ? (
                        <button className="btn small" style={{ marginLeft: 6, padding: '1px 6px' }} onClick={() => setExpanded(expanded === p.name ? null : p.name)}>
                          {expanded === p.name ? 'hide' : 'models'}
                        </button>
                      ) : null}
                      {localHint ? <div className="muted small provider-status-hint">{localHint}</div> : null}
                    </td>
                    <td className="row-actions">
                      {backgroundManaged && installedStack ? (
                        <button className="btn" disabled={busy} onClick={() => void stopStackBackground(installedStack)} title="Stop the background server process started by IDACC">
                          Stop
                        </button>
                      ) : null}
                      {startableLocalStack ? (
                        <button className="btn primary" disabled={busy} onClick={() => void runStackCmd(startableLocalStack, 'start')} title={`Start ${startableLocalStack.name}'s local API server`}>
                          {stackCanStartBackground(startableLocalStack) ? 'Start background' : 'Start server'}
                        </button>
                      ) : null}
                      <button className={startableLocalStack ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void connect(p.name)} title="Validate the key live and sync the model list">
                        {localProviderConnectLabel(p)}
                      </button>
                      {localHint && !startableLocalStack ? (
                        <button className="btn" type="button" onClick={openStackSetup} title="Jump to Local LLM stacks for install/start guidance">
                          Stack setup
                        </button>
                      ) : null}
                      <button className="btn" onClick={() => void removeProviderProfile(p.name)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                  {expanded === p.name && sync?.models?.length ? (
                    <tr>
                      <td colSpan={6}>
                        {apiModelFilterable ? (() => {
                          const selected = new Set(draftProviderModels(p));
                          const shown = filteredProviderModels(p);
                          const q = providerModelQuery(p);
                          const totalFiltered = q ? syncedModels.filter((m) => m.toLowerCase().includes(q)).length : syncedModels.length;
                          const dirty = providerModelSelectionChanged(p);
                          return (
                            <div className="provider-model-picker">
                              <div className="provider-model-picker-head">
                                <div>
                                  <b>Health model dropdown</b>
                                  <span className="muted small"> · {selected.size}/{syncedModels.length} selected from synced API models</span>
                                </div>
                                <span className="grow" />
                                <button className="btn small" disabled={busy || shown.length === 0} onClick={() => updateProviderModelDraft(p, Array.from(new Set([...draftProviderModels(p), ...shown])))}>Select shown</button>
                                <button className="btn small" disabled={busy || selected.size === 0} onClick={() => updateProviderModelDraft(p, [])}>Clear</button>
                                <button className="btn small" disabled={busy} onClick={() => void saveProviderModelsForHealth(p, 'all')}>Show all</button>
                                <button className="btn primary small" disabled={busy || selected.size === 0 || !dirty} onClick={() => void saveProviderModelsForHealth(p, 'selected')}>Save selected</button>
                              </div>
                              <input
                                className="provider-model-search"
                                value={providerModelSearch[p.name] ?? ''}
                                placeholder="search synced models..."
                                onChange={(e) => setProviderModelSearch((prev) => ({ ...prev, [p.name]: e.target.value }))}
                              />
                              <div className="provider-model-list">
                                {shown.map((m) => (
                                  <label className="provider-model-row" key={m} title={m}>
                                    <input type="checkbox" checked={selected.has(m)} onChange={() => toggleProviderModel(p, m)} />
                                    <span className="mono">{m}</span>
                                  </label>
                                ))}
                                {shown.length === 0 ? <span className="muted small">No synced models match this search.</span> : null}
                              </div>
                              {totalFiltered > shown.length ? <div className="muted small">Showing first {shown.length} of {totalFiltered} matches.</div> : null}
                            </div>
                          );
                        })() : (
                          <div className="chips">
                            {sync.models.map((m) => (
                              <span className="chip" key={m}>{m}</span>
                            ))}
                          </div>
                        )}
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
