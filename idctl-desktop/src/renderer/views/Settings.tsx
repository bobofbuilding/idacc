import { Fragment, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import { defaultBaseUrl, kindNeedsKey, type ProviderKind, type ProviderProfile } from '../../../../idctl/src/settings/schema.ts';
import type { ProbeOutcome } from '../../../../idctl/src/settings/ProviderClient.ts';
import type { DiscoveredServer } from '../../../../idctl/src/settings/localDiscovery.ts';
import { PROVIDER_CATALOG, findProvider } from '../../../../idctl/src/settings/providerCatalog.ts';
import { LOCAL_MODEL_CATALOG, type ModelCapability, type LocalModelEntry } from '../../../../idctl/src/settings/modelCatalog.ts';
import { LOCAL_STACKS, type LocalStackEntry } from '../../../../idctl/src/settings/localStacks.ts';

const MODEL_CAPS: ModelCapability[] = ['general', 'tools', 'reasoning', 'coding', 'vision', 'embedding', 'fast'];

/** Hardware of the machine the control center commands (the manager host; localhost here). */
type HardwareInfo = { platform: string; arch: string; appleSilicon: boolean; cpu: string; cpuCores: number; gpu?: string; gpuCores?: number; totalRamGB: number; freeDiskGB: number | null; totalDiskGB: number | null };

/** A discovered local server enriched by the bridge with whether it's already configured. */
type Discovered = DiscoveredServer & { alreadyAdded: boolean };

const KINDS: ProviderKind[] = ['ollama', 'lmstudio', 'openai-compatible', 'anthropic', 'openai'];

/** Provider profile enriched by the bridge with where its key resolves from. */
type ProviderRow = ProviderProfile & { keySource?: 'config' | 'env' | 'none'; needsKey?: boolean };

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function Settings({ store }: { store: FleetStore }) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [probe, setProbe] = useState<Record<string, ProbeOutcome>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // add-provider form
  const [catalogId, setCatalogId] = useState<string>('groq');
  const [kind, setKind] = useState<ProviderKind>('openai-compatible');
  const [name, setName] = useState('groq');
  const [baseUrl, setBaseUrl] = useState('https://api.groq.com/openai/v1');
  const [apiKey, setApiKey] = useState('');
  // local LLM discovery (scan localhost for running servers)
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  function pickProvider(id: string) {
    setCatalogId(id);
    if (id === 'custom') { setKind('openai-compatible'); setBaseUrl(defaultBaseUrl('openai-compatible')); return; }
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
  // subscriptions (runtime OAuth: Claude / ChatGPT)
  type Sub = { provider: string; loggedIn: boolean; installed?: boolean; plan?: string; email?: string; method?: string; detail?: string };
  type SubKey = 'claude' | 'chatgpt' | 'cursor';
  const [subs, setSubs] = useState<{ claude: Sub; chatgpt: Sub; cursor: Sub } | null>(null);
  const [subBusy, setSubBusy] = useState<string | null>(null);

  async function reload() {
    setProviders(await call<ProviderRow[]>('providers:list').catch(() => []));
    setVersion(await call<string>('app:version').catch(() => ''));
    const u = await call<typeof upd>('update:getSettings').catch(() => null);
    setUpd(u);
    setUpdStatus(await call<typeof updStatus>('update:status').catch(() => null));
    setSubs(await call<{ claude: Sub; chatgpt: Sub; cursor: Sub }>('subs:status').catch(() => null));
  }
  async function recheckSubs() {
    setSubs(await call<{ claude: Sub; chatgpt: Sub; cursor: Sub }>('subs:status').catch(() => null));
  }
  async function signinSub(provider: SubKey) {
    setSubBusy(provider);
    try {
      const r = await call<{ started: boolean; url?: string; error?: string }>('subs:signin', provider);
      if (r.error) window.alert(`sign-in failed: ${r.error}`);
      // The OAuth flow runs in your browser; re-check status shortly after.
      setTimeout(() => void recheckSubs(), 4000);
    } finally {
      setSubBusy(null);
    }
  }
  async function installSub(provider: SubKey) {
    setSubBusy(provider);
    try {
      const r = await call<{ ok: boolean; ran: boolean; command?: string; error?: string }>('subs:install', provider);
      if (r.ran) {
        window.alert('Opened Terminal to install the Cursor CLI. Let it finish, then click “Re-check”.');
        setTimeout(() => void recheckSubs(), 8000);
      } else if (r.command) {
        try { await navigator.clipboard.writeText(r.command); } catch { /* clipboard best-effort */ }
        window.alert(`Couldn't open Terminal automatically — the install command is copied to your clipboard. Paste it into a terminal:\n\n${r.command}`);
      } else {
        window.alert(`install unavailable: ${r.error ?? 'unknown'}`);
      }
    } finally {
      setSubBusy(null);
    }
  }
  async function signoutSub(provider: SubKey) {
    if (!window.confirm(`Sign out of ${provider === 'claude' ? 'Claude' : provider === 'cursor' ? 'Cursor' : 'ChatGPT'}? Agents on that runtime will lose subscription access until you sign back in.`)) return;
    setSubBusy(provider);
    try {
      await call('subs:signout', provider);
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


  async function addProvider() {
    const entry = findProvider(catalogId);
    const p: ProviderProfile = { name: name.trim() || kind, kind, baseUrl: baseUrl.trim() || defaultBaseUrl(kind), apiKey: apiKey.trim() || undefined, enabled: true };
    // Providers with no GET /models endpoint (Perplexity) ship a preset list so
    // their models appear without a (failing) discovery probe.
    if (entry?.models?.length) {
      p.lastSync = { at: Date.now(), status: 'preset', modelCount: entry.models.length, models: entry.models };
    }
    setBusy(true);
    try {
      setProviders(await call<ProviderRow[]>('providers:add', p));
      setName('');
      setApiKey('');
    } finally {
      setBusy(false);
    }
  }
  async function connect(n: string) {
    setBusy(true);
    try {
      const r = await call<{ providers: ProviderRow[]; outcome: ProbeOutcome }>('providers:connect', n);
      setProviders(r.providers);
      setProbe((m) => ({ ...m, [n]: r.outcome }));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(n: string) {
    setProviders(await call<ProviderRow[]>('providers:setDefault', n));
  }
  async function toggle(n: string) {
    setProviders(await call<ProviderRow[]>('providers:toggle', n));
  }

  // Local LLM discovery: scan localhost for running servers, then one-click add.
  async function runDiscover() {
    setDiscovering(true);
    try {
      setDiscovered(await call<Discovered[]>('providers:discover').catch(() => []));
    } finally {
      setDiscovering(false);
    }
  }
  /** Normalize a baseUrl for matching a discovered server against existing providers. */
  function normUrl(u: string): string {
    return u.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
  }
  /** "Already a backend?" recomputed against the LIVE providers (not the frozen scan flag). */
  function isAdded(s: Discovered): boolean {
    return providers.some((p) => normUrl(p.baseUrl) === normUrl(s.baseUrl)) || s.alreadyAdded;
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
  async function addDiscovered(s: Discovered) {
    setBusy(true);
    try {
      const providerName = uniqueProviderName(s.id, new Set(providers.map((p) => p.name)));
      await call('providers:add', discoveredToProfile(s, providerName));
      await reload();
      await runDiscover(); // refresh the alreadyAdded flags
    } finally {
      setBusy(false);
    }
  }
  async function addAllDiscovered() {
    const list = (discovered ?? []).filter((s) => !isAdded(s) && s.status === 'live');
    setBusy(true);
    try {
      const taken = new Set(providers.map((p) => p.name));
      for (const s of list) {
        const providerName = uniqueProviderName(s.id, taken);
        taken.add(providerName);
        await call('providers:add', discoveredToProfile(s, providerName));
      }
      await reload();
      await runDiscover();
    } finally {
      setBusy(false);
    }
  }

  // Local models (Ollama): list installed + download a new one (streamed progress).
  const POPULAR = ['llama3.2:1b', 'llama3.2:3b', 'qwen2.5:3b', 'qwen3:1.7b', 'gemma3:1b', 'gemma2:2b', 'phi3.5', 'deepseek-r1:1.5b', 'smollm2:1.7b', 'mistral'];
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size?: number; parameterSize?: string }[]>([]);
  const [pullName, setPullName] = useState('llama3.2:1b');
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState('');
  // catalog browsers: model filters + stacks filter + copy feedback
  const [modelQuery, setModelQuery] = useState('');
  const [modelCap, setModelCap] = useState<ModelCapability | 'all'>('all');
  const [stackTag, setStackTag] = useState<string>('all');
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [stackConfirm, setStackConfirm] = useState<string | null>(null);

  // Local image generator (preferred over the cloud provider for image creation).
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
  async function saveImgServer() {
    setImgBusy(true); setImgMsg('');
    try {
      const url = imgUrl.trim();
      const saved = await call<ImgServer | null>('image:setServer', url ? { url, type: imgType } : null);
      setImgServer(saved);
      setImgMsg(url ? 'saved ✓ — image creation will use this server first (cloud is the fallback)' : 'cleared — image creation uses the cloud provider');
    } catch {
      setImgMsg('save failed');
    } finally { setImgBusy(false); }
  }
  async function detectImg() {
    setImgBusy(true); setImgMsg('scanning localhost…');
    try {
      const found = await call<ImgServer | null>('image:detectServer').catch(() => null);
      if (found) { setImgUrl(found.url); setImgType(found.type); setImgMsg(`found ${found.type === 'auto1111' ? 'Stable Diffusion (Automatic1111)' : 'an image API'} at ${found.url} — click Save to use it`); }
      else setImgMsg('no local image server found — run Automatic1111 (Stable Diffusion WebUI) on :7860, or LocalAI on :8080');
    } finally { setImgBusy(false); }
  }

  async function loadOllama() {
    const r = await call<{ ok: boolean; models: { name: string; size?: number; parameterSize?: string }[] }>('ollama:tags').catch(() => ({ ok: false, models: [] as { name: string }[] }));
    setOllamaModels(r.models ?? []);
  }
  async function pull(modelId: string) {
    const m = modelId.trim();
    if (!m || pulling) return;
    setPulling(true);
    setPullMsg(`starting ${m}…`);
    try {
      const r = await call<{ ok: boolean; error?: string }>('ollama:pull', m);
      if (!r.ok) setPullMsg(`failed: ${r.error}`);
      else { setPullMsg(`downloaded ${m} ✓`); await loadOllama(); }
    } finally {
      setPulling(false);
    }
  }
  async function pullModel() { await pull(pullName); }
  /** Is a catalog model already pulled? (handles implicit :latest tags) */
  function modelInstalled(id: string): boolean {
    if (ollamaModels.some((m) => m.name === id)) return true;
    return !id.includes(':') && ollamaModels.some((m) => m.name.split(':')[0] === id);
  }
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
  }
  const filteredModels = LOCAL_MODEL_CATALOG.filter((m) => {
    if (modelCap !== 'all' && !m.capabilities.includes(modelCap)) return false;
    const q = modelQuery.trim().toLowerCase();
    return !q || m.id.toLowerCase().includes(q) || m.family.toLowerCase().includes(q) || (m.blurb ?? '').toLowerCase().includes(q);
  });
  const stackTags = Array.from(new Set(LOCAL_STACKS.flatMap((s) => s.tags ?? []))).sort();
  const filteredStacks = stackTag === 'all' ? LOCAL_STACKS : LOCAL_STACKS.filter((s) => (s.tags ?? []).includes(stackTag));
  const runningPorts = new Set((discovered ?? []).map((d) => d.port));

  function providerPort(p: ProviderRow): number | null {
    try { const x = new URL(p.baseUrl).port; return x ? Number(x) : null; } catch { return null; }
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
  // Stack install commands: runnable (open Terminal) vs app-download (link out).
  const RUNNABLE_RE = /^(brew|pip|pipx|uv|cargo|curl|docker|conda|npm|npx)\b/;
  function stackCmd(s: LocalStackEntry): string { return (s.install ?? '').split('#')[0].trim(); }
  function stackInstallCmd(s: LocalStackEntry): string | null { const c = stackCmd(s); return c && RUNNABLE_RE.test(c) ? c : null; }
  function stackUninstallCmd(s: LocalStackEntry): string | null {
    const c = stackCmd(s); let m: RegExpMatchArray | null;
    if ((m = c.match(/^brew install --cask (\S+)/))) return `brew uninstall --cask ${m[1]}`;
    if ((m = c.match(/^brew install (\S+)/))) return `brew uninstall ${m[1]}`;
    if ((m = c.match(/^pipx install (\S+)/))) return `pipx uninstall ${m[1]}`;
    if ((m = c.match(/^pip install (\S+)/))) return `pip uninstall -y ${m[1]}`;
    return null;
  }
  async function runStackCmd(cmd: string) {
    setStackConfirm(null);
    const r = await call<{ ran: boolean }>('app:runInTerminal', cmd).catch(() => ({ ran: false }));
    if (!r.ran) await copyText(cmd); // Terminal automation blocked → silent clipboard fallback
  }
  /** Port-conflict risk for a stack: already-in-use (strong) or shared default (info). */
  function stackPortWarn(s: LocalStackEntry): { level: 'warn' | 'error'; msg: string } | null {
    if (s.defaultPort == null) return null;
    if (runningPorts.has(s.defaultPort) || providers.some((p) => providerPort(p) === s.defaultPort)) {
      return { level: 'error', msg: `port ${s.defaultPort} already in use on this machine` };
    }
    const others = LOCAL_STACKS.filter((x) => x.id !== s.id && x.defaultPort === s.defaultPort).length;
    return others ? { level: 'warn', msg: `port ${s.defaultPort} also default for ${others} other${others > 1 ? 's' : ''}` } : null;
  }
  useEffect(() => {
    void loadOllama();
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
          <b>
            <select
              value={store.coordinator ?? ''}
              onChange={(e) => void store.setCoordinator(e.target.value)}
            >
              <option value="">(auto: lead/first)</option>
              {store.agents.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </b>
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
        <h3>Subscriptions (Claude · ChatGPT · Cursor)</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Sign in with your subscription — these power the <span className="mono">claude-*</span>, <span className="mono">codex</span> and <span className="mono">cursor-cli</span> runtimes via OAuth (no API key, no metering). Separate from the metered API backends below.
        </p>
        {([
          ['claude', 'Claude (Anthropic)', subs?.claude],
          ['chatgpt', 'OpenAI (ChatGPT)', subs?.chatgpt],
          ['cursor', 'Cursor', subs?.cursor],
        ] as [SubKey, string, Sub | undefined][]).map(([key, label, s]) => (
          <div className="kv" key={key} style={{ marginBottom: 8 }}>
            <span>{label}</span>
            <b>
              {s?.loggedIn ? (
                <span className="ok-text">
                  ● signed in
                  {s.plan ? ` · ${s.plan}` : ''}
                  {s.email ? ` · ${s.email}` : ''}
                  {!s.email && s.detail ? ` · ${s.detail}` : ''}
                </span>
              ) : s?.installed === false ? (
                <span className="warn-text" title={s.detail}>○ CLI not installed</span>
              ) : (
                <span className="muted">○ not signed in</span>
              )}
              <span className="row-actions" style={{ display: 'inline-flex', marginLeft: 12 }}>
                <button className="btn" disabled={subBusy === key} onClick={() => void (s?.installed === false ? installSub(key) : signinSub(key))} title={s?.installed === false ? s.detail : undefined}>
                  {s?.loggedIn ? 'Switch account' : s?.installed === false ? 'Install…' : 'Sign in'}
                </button>
                {s?.loggedIn ? (
                  <button className="btn" disabled={subBusy === key} onClick={() => void signoutSub(key)}>
                    Sign out
                  </button>
                ) : null}
              </span>
            </b>
          </div>
        ))}
        <div className="row-actions" style={{ marginTop: 6 }}>
          <span className="muted small grow">Sign-in opens your browser to complete OAuth; status refreshes after.</span>
          <button className="btn" onClick={() => void recheckSubs()}>Re-check</button>
        </div>
      </section>

      <section className="card">
        <h3>Local models (Ollama)</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Download a model to run locally via Ollama (<span className="mono">127.0.0.1:11434</span>) — these power the <span className="mono">ollama</span> runtime with no API key, fully offline. Size warnings are checked against your hardware (shown at the top).
        </p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="muted small">installed:</span>
          {ollamaModels.length === 0 ? (
            <span className="muted small grow">none yet</span>
          ) : (
            <span className="chips grow">
              {ollamaModels.map((m) => (
                <span className="chip" key={m.name} title={m.parameterSize ? `${m.parameterSize}` : undefined}>{m.name}</span>
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
          <div className="catalog-grid">
            {filteredModels.map((m) => {
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
            })}
            {filteredModels.length === 0 ? <p className="muted small center pad">No models match.</p> : null}
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Local image generator</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Image creation in chat uses this <b>first</b> (free, private), falling back to the cloud provider (OpenRouter) only if it’s unset or unreachable. Run a local image server — <a className="ext-link" href="https://github.com/AUTOMATIC1111/stable-diffusion-webui" target="_blank" rel="noreferrer">Automatic1111</a> / Forge (Stable Diffusion WebUI, start with <span className="mono">--api</span>) on <span className="mono">:7860</span>, or a <a className="ext-link" href="https://localai.io" target="_blank" rel="noreferrer">LocalAI</a>-style image API on <span className="mono">:8080</span>. The subscriptions and Ollama models are text/vision-only and can’t generate images.
        </p>
        <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input className="catalog-search" style={{ flex: '1 1 280px' }} placeholder="http://127.0.0.1:7860" value={imgUrl} disabled={imgBusy} onChange={(e) => setImgUrl(e.target.value)} />
          <select className="cell-select" value={imgType} disabled={imgBusy} onChange={(e) => setImgType(e.target.value as 'auto1111' | 'openai')} title="API style">
            <option value="auto1111">Stable Diffusion (Automatic1111)</option>
            <option value="openai">OpenAI images API (LocalAI…)</option>
          </select>
          <button className="btn" disabled={imgBusy} onClick={() => void detectImg()}>Detect</button>
          <button className="btn primary" disabled={imgBusy} onClick={() => void saveImgServer()}>{imgBusy ? '…' : 'Save'}</button>
          {imgServer ? <button className="btn" disabled={imgBusy} title="Clear — use the cloud provider" onClick={() => { setImgUrl(''); void saveImgServer(); }}>Clear</button> : null}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          {imgServer ? <>Active: <b className="accent-text">{imgServer.type === 'auto1111' ? 'Stable Diffusion' : 'image API'}</b> at <span className="mono">{imgServer.url}</span>. </> : <>No local image server — image creation uses the cloud provider. </>}
          {imgMsg ? <span className={/(failed|no local)/.test(imgMsg) ? 'status-error' : 'ok-text'}>{imgMsg}</span> : null}
        </div>
      </section>

      <section className="card">
        <h3>Local LLM stacks</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Self-hostable inference servers you can run <b>next to Ollama</b> — from <a className="ext-link" href="https://github.com/av/awesome-llm-services" target="_blank" rel="noreferrer">awesome-llm-services</a>. <b>Install</b> opens the command in your Terminal (visible and abortable — nothing runs silently); app-only stacks link to their download. Once installed it appears under <b>Discover local servers</b> below and can be added as a backend. ⚠ flags a port already in use on this machine.
        </p>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="chips grow">
            {(['all', ...stackTags]).map((t) => (
              <button key={t} className={`chip${stackTag === t ? ' on' : ''}`} onClick={() => setStackTag(t)}>
                {stackTag === t ? '✓ ' : ''}{t}
              </button>
            ))}
          </span>
          <button className="btn small" disabled={discovering} onClick={() => void runDiscover()}>{discovering ? 'Scanning…' : '⟳ Scan running'}</button>
        </div>
        <div className="stack-list">
          {filteredStacks.map((s) => {
            const running = s.defaultPort != null && runningPorts.has(s.defaultPort);
            const pw = stackPortWarn(s);
            const ic = stackInstallCmd(s);
            const uc = stackUninstallCmd(s);
            return (
              <div className="stack-row" key={s.id}>
                <div className="stack-head">
                  <span className="b">{s.name}</span>
                  {s.defaultPort ? <span className="muted small mono">:{s.defaultPort}</span> : null}
                  <span className="muted small">{s.openaiCompatible ? 'OpenAI-compatible' : s.apiKind}</span>
                  {s.appleSilicon ? <span className="chip tag" title="Apple-Silicon native">Apple Silicon</span> : null}
                  {running ? <span className="ok-text small" title="Detected running by the last scan">● running</span> : null}
                  {pw ? <span className={`small ${pw.level === 'error' ? 'status-error' : 'warn-text'}`} title="Port-conflict risk if you run this on its default port">⚠ {pw.msg}</span> : null}
                  <span className="grow" />
                  <a className="ext-link small" href={s.homepage} target="_blank" rel="noreferrer">docs ↗</a>
                </div>
                <p className="muted small stack-blurb">{s.blurb}</p>
                <div className="stack-install">
                  {ic ? (
                    stackConfirm === `i:${s.id}` ? (
                      <>
                        <code className="mono">{ic}</code>
                        <button className="btn small primary" title="Runs in your Terminal — visible and abortable" onClick={() => void runStackCmd(ic)}>Run in Terminal</button>
                        <button className="btn small" onClick={() => setStackConfirm(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn small primary" title={ic} onClick={() => setStackConfirm(`i:${s.id}`)}>Install</button>
                    )
                  ) : (
                    <a className="btn small" href={s.homepage} target="_blank" rel="noreferrer" title="No CLI install — opens the download page">Get ↗</a>
                  )}
                  {uc ? (
                    stackConfirm === `u:${s.id}` ? (
                      <>
                        <code className="mono">{uc}</code>
                        <button className="btn small icon-danger" title="Runs in your Terminal" onClick={() => void runStackCmd(uc)}>Run in Terminal</button>
                        <button className="btn small" onClick={() => setStackConfirm(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn small" onClick={() => setStackConfirm(`u:${s.id}`)}>Uninstall</button>
                    )
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card grow">
        <h3>Inference backends</h3>

        <div className="discover-local">
          <div className="row-actions" style={{ alignItems: 'baseline' }}>
            <span className="muted small grow">Auto-detect local LLM servers running on this machine (Ollama, LM Studio, llama.cpp, vLLM…) and add them in one click.</span>
            <button className="btn" disabled={discovering} onClick={() => void runDiscover()}>
              {discovering ? 'Scanning…' : '⟳ Discover local servers'}
            </button>
          </div>
          {discovered ? (
            discovered.length === 0 ? (
              <p className="muted small" style={{ marginTop: 6 }}>
                No local servers found on the usual ports. Start one (e.g. <span className="mono">ollama serve</span> or LM Studio's server) and scan again.
              </p>
            ) : (
              <div className="discovered-list">
                {discovered.map((s) => (
                  <div className="discovered-row" key={s.id}>
                    <span className="b">{s.name}</span>
                    <span className="muted small mono grow" title={s.sharesPortWith?.length ? `also possibly: ${s.sharesPortWith.join(', ')}` : undefined}>
                      {s.kind} · {s.baseUrl}
                    </span>
                    {s.status === 'auth-error' ? (
                      <span className="warn-text small" title="Server is up but its API needs a key">up · needs key</span>
                    ) : (
                      <span className="ok-text small">{s.modelCount} model{s.modelCount === 1 ? '' : 's'}</span>
                    )}
                    {isAdded(s) ? (
                      <span className="muted small">added ✓</span>
                    ) : (
                      <button className="btn small primary" disabled={busy} onClick={() => void addDiscovered(s)}>Add</button>
                    )}
                  </div>
                ))}
                {discovered.some((s) => !isAdded(s) && s.status === 'live') ? (
                  <div className="row-actions" style={{ marginTop: 6 }}>
                    <span className="grow" />
                    <button className="btn small" disabled={busy} onClick={() => void addAllDiscovered()}>Add all new</button>
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>

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
              const statusOk = (o?.status ?? sync?.status) === 'live';
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
                      <button className={`star${p.default ? ' on' : ''}`} title="Set as default backend" onClick={() => void setDefault(p.name)}>
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
                      <button className="btn" onClick={() => void call('providers:remove', p.name).then(() => reload())}>
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
                  No backends yet — add one below (e.g. Ollama at http://127.0.0.1:11434), then Connect &amp; sync.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div className="add-provider">
          <select value={catalogId} onChange={(e) => pickProvider(e.target.value)} title="Pick a provider to fill its endpoint">
            <optgroup label="Local">
              {PROVIDER_CATALOG.filter((e) => e.local).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
            <optgroup label="Cloud">
              {PROVIDER_CATALOG.filter((e) => !e.local).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
            <option value="custom">Custom…</option>
          </select>
          {catalogId === 'custom' ? (
            <select value={kind} onChange={(e) => { const k = e.target.value as ProviderKind; setKind(k); setBaseUrl(defaultBaseUrl(k)); }}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          ) : null}
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input
            placeholder={kindNeedsKey(kind) ? 'API key (or leave blank to use env)' : 'API key (not needed)'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
          />
          <button className="btn primary" disabled={busy} onClick={() => void addProvider()}>
            Add
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Cloud backends (OpenAI, Anthropic) authenticate with an API key — paste it above or set <span className="mono">ANTHROPIC_API_KEY</span>/<span className="mono">OPENAI_API_KEY</span> and it's auto-detected. Connect &amp; sync validates it live and pulls the model list. (Neither offers OAuth for API access; the <span className="mono">claude-code-cli</span> runtime uses your logged-in Claude session instead.)
        </p>
      </section>
    </div>
  );
}
