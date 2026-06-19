import { Fragment, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import { defaultBaseUrl, kindNeedsKey, type ProviderKind, type ProviderProfile } from '../../../../idctl/src/settings/schema.ts';
import type { ProbeOutcome } from '../../../../idctl/src/settings/ProviderClient.ts';
import { PROVIDER_CATALOG, findProvider } from '../../../../idctl/src/settings/providerCatalog.ts';

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
  function pickProvider(id: string) {
    setCatalogId(id);
    if (id === 'custom') { setKind('openai-compatible'); setBaseUrl(defaultBaseUrl('openai-compatible')); return; }
    const e = findProvider(id);
    if (!e) return;
    setKind(e.kind);
    setBaseUrl(e.baseUrl);
    setName(e.id);
  }
  // lead hierarchy (#10)
  const [hier, setHier] = useState<{ primary: { team: string; agent: string } | null; coordinators: Record<string, string> }>({ primary: null, coordinators: {} });
  // self-update
  const [version, setVersion] = useState('');
  const [upd, setUpd] = useState<{ autoUpgrade?: boolean; updateManifestUrl?: string; updateRepo?: string } | null>(null);
  const [updStatus, setUpdStatus] = useState<{ latest?: string; available?: boolean; staged?: boolean; checking?: boolean; error?: string; lastChecked?: number } | null>(null);
  const [manifestUrl, setManifestUrl] = useState('');
  // subscriptions (runtime OAuth: Claude / ChatGPT)
  type Sub = { provider: string; loggedIn: boolean; installed?: boolean; plan?: string; email?: string; method?: string; detail?: string };
  type SubKey = 'claude' | 'chatgpt' | 'cursor';
  const [subs, setSubs] = useState<{ claude: Sub; chatgpt: Sub; cursor: Sub } | null>(null);
  const [subBusy, setSubBusy] = useState<string | null>(null);

  async function reload() {
    setProviders(await call<ProviderRow[]>('providers:list').catch(() => []));
    setHier(await call<typeof hier>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })));
    setVersion(await call<string>('app:version').catch(() => ''));
    const u = await call<typeof upd>('update:getSettings').catch(() => null);
    setUpd(u);
    setManifestUrl(u?.updateManifestUrl ?? '');
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

  async function makePrimary() {
    const agent = store.coordinator ?? store.agents.find((a) => /^(lead|manager)$/i.test(a.name))?.name;
    if (!agent) return;
    await call('coordinator:setPrimary', store.team ?? 'default', agent);
    reload();
  }

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

  // Local models (Ollama): list installed + download a new one (streamed progress).
  const POPULAR = ['llama3.2:1b', 'llama3.2:3b', 'qwen2.5:3b', 'qwen3:1.7b', 'gemma3:1b', 'gemma2:2b', 'phi3.5', 'deepseek-r1:1.5b', 'smollm2:1.7b', 'mistral'];
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size?: number; parameterSize?: string }[]>([]);
  const [pullName, setPullName] = useState('llama3.2:1b');
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState('');
  async function loadOllama() {
    const r = await call<{ ok: boolean; models: { name: string; size?: number; parameterSize?: string }[] }>('ollama:tags').catch(() => ({ ok: false, models: [] as { name: string }[] }));
    setOllamaModels(r.models ?? []);
  }
  async function pullModel() {
    const m = pullName.trim();
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
  useEffect(() => {
    void loadOllama();
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
          <span>manifest URL</span>
          <b>
            <input
              style={{ width: '100%' }}
              placeholder="https://… or file:///… update.json"
              value={manifestUrl}
              onChange={(e) => setManifestUrl(e.target.value)}
              onBlur={() => void saveUpdate({ updateManifestUrl: manifestUrl.trim() || undefined })}
            />
          </b>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="muted small grow">{upd?.updateRepo ? `repo: ${upd.updateRepo}` : ''}</span>
          <button className="btn" onClick={() => void checkUpdate()}>Check now</button>
        </div>
      </section>

      <section className="card">
        <h3>Lead hierarchy</h3>
        <div className="hierarchy">
          {hier.primary ? (
            <>
              <div className="hier-node primary">
                ⭑ {hier.primary.team}/{hier.primary.agent} <span className="muted">— primary lead</span>
              </div>
              {Object.entries(hier.coordinators)
                .filter(([t, ag]) => !(t === hier.primary!.team && ag === hier.primary!.agent))
                .map(([t, ag]) => (
                  <div className="hier-node child" key={t}>
                    └ {t}/{ag} <span className="muted">— reports to primary</span>
                  </div>
                ))}
            </>
          ) : (
            <div className="muted">
              No primary lead set. With several team leads, designate one as the top of the hierarchy — it delegates
              across teams to the per-team coordinators (via <code>/ask &lt;team&gt;/&lt;agent&gt;</code>).
            </div>
          )}
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void makePrimary()}>
            Make “{store.team ?? 'default'}” coordinator the primary lead
          </button>
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
                <button className="btn" disabled={subBusy === key} onClick={() => void signinSub(key)} title={s?.installed === false ? s.detail : undefined}>
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
          Download a model to run locally via Ollama (<span className="mono">127.0.0.1:11434</span>) — these power the <span className="mono">ollama</span> runtime with no API key, fully offline.
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
      </section>

      <section className="card grow">
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
