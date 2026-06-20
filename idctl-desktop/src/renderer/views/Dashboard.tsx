import { useEffect, useRef, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { RUNTIMES, offerableRuntimes } from '../../../../idctl/src/settings/runtimeCatalog.ts';

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };

function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}

// Heuristic model↔runtime compatibility. Returns a warning string or null.
function modelFamily(model: string): 'claude' | 'openai' | 'ollama' | 'other' {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'claude';
  if (/gpt|codex|^o\d|davinci/.test(m)) return 'openai';
  if (/:|qwen|llama|mistral|gemma|phi|deepseek|gpt-oss/.test(m)) return 'ollama';
  return 'other';
}
function runtimeAccepts(runtime: string): Set<string> {
  if (runtime.startsWith('claude')) return new Set(['claude']);
  if (runtime === 'codex') return new Set(['openai']);
  if (runtime === 'cursor-cli') return new Set(['claude', 'openai']); // cursor proxies both
  if (runtime === 'ollama') return new Set(['ollama']);
  return new Set(['claude', 'openai', 'ollama', 'other']);
}
function runtimeModelMismatch(runtime?: string, model?: string): string | null {
  if (!runtime || !model) return null;
  const fam = modelFamily(model);
  if (fam === 'other') return null; // unknown — don't cry wolf
  return runtimeAccepts(runtime).has(fam) ? null : `${runtimeLabel(runtime)} runtime expects a ${[...runtimeAccepts(runtime)][0]} model, but "${model}" looks like ${fam}`;
}

function statusClass(s: string): string {
  if (/running|online|ok/i.test(s)) return 'ok';
  if (/start|pending|processing/i.test(s)) return 'warn';
  return 'err';
}
function short(s?: string): string {
  if (!s) return '—';
  return s.replace('claude-code-cli', 'claude').replace(/^claude-/, '').replace(/-cli$/, '');
}
function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function skillsOf(a: Agent): string[] {
  const s = a.metadata?.skills;
  return Array.isArray(s) ? (s as string[]) : [];
}
// Richer, topic-aware activity line. Only ever interpolates string fields.
function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}
function describe(e: { topic: string; subject?: string; actor?: string; data?: Record<string, unknown> }): string {
  const d = e.data ?? {};
  const who = [e.subject, d.from, d.name, d.agent, e.actor].map(str).find(Boolean) ?? '';
  if (e.topic.startsWith('task:')) return [who, str(d.title)].filter(Boolean).join(' — ');
  if (e.topic.startsWith('query:')) return [who, str(d.status)].filter(Boolean).join(' · ');
  if (e.topic.startsWith('checkin')) return [str(d.delegate), str(d.title)].filter(Boolean).join(' ');
  return who;
}
function topicClass(t: string): string {
  if (/online|delivered|done|complete/.test(t)) return 'ok';
  if (/offline|fail|expired|error/.test(t)) return 'err';
  if (/due|pending/.test(t)) return 'warn';
  return 'accent';
}

export function Dashboard({ store }: { store: FleetStore }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const modelRefs = useRef<Record<string, HTMLSelectElement | null>>({});
  const sel: Agent | undefined = store.agents.find((a) => a.id === selected) ?? store.agents[0];

  // Per-runtime model catalog (synced providers + curated). Refreshed when the
  // fleet snapshot updates so provider syncs from Settings flow through.
  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setCatalog).catch(() => setCatalog({}));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
  }, [store.lastUpdated]);

  // On entry, actively probe every backing provider so the model dropdowns offer
  // the FULL live model list — no manual "custom" entry needed. Best-effort; the
  // cached runtime:models above renders instantly while this refreshes it.
  useEffect(() => {
    call<Record<string, string[]>>('runtime:probe').then(setCatalog).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function probeRuntimes() {
    setBusy('probe runtimes');
    try {
      setCatalog(await call<Record<string, string[]>>('runtime:probe'));
    } catch (err) {
      window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function run(label: string, cmd: string) {
    setBusy(label);
    try {
      await call('remote', cmd);
      store.refresh();
    } catch (err) {
      window.alert(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }
  async function setModel(a: Agent, model: string) {
    if (!model || model === a.model) return;
    setBusy(`model ${a.name}`);
    try {
      await call('remote', `/model ${a.name} ${model}`);
      await call('remote', `/agent ${a.name} rebuild`); // apply immediately — no confirm
      store.refresh();
      setBusy(null);
    } catch (err) {
      setBusy(`model change failed — ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setBusy(null), 4000);
    }
  }
  function action(a: Agent, act: string) {
    if (!act) return;
    if (act === 'Delete') {
      if (window.confirm(`Delete agent "${a.name}"? Working files are left in place.`)) void run(`delete ${a.name}`, `/delete ${a.name}`);
      return;
    }
    void run(`${act} ${a.name}`, `/agent ${a.name} ${act.toLowerCase()}`);
  }
  // Switching runtime: set it, pick a model the new runtime can actually serve,
  // drop the model dropdown open for fine-tuning, and rebuild — all without any
  // confirmation/alert popup.
  async function setRuntime(a: Agent, runtime: string) {
    if (!runtime || runtime === a.runtime) return;
    setBusy(`runtime ${a.name}`);
    try {
      await call('setAgentRuntime', a.id, runtime);
      // A model from the OLD runtime usually won't run on the new one → default
      // to the first model the new runtime offers when the current one mismatches.
      const models = catalog[runtime] ?? [];
      const model = !a.model || runtimeModelMismatch(runtime, a.model) ? models[0] ?? a.model : a.model;
      if (model && model !== a.model) await call('remote', `/model ${a.name} ${model}`);
      store.refresh();
      // Auto-open the model dropdown so the pick is one click away. Native
      // showPicker() needs recent user activation — the change event provides it,
      // and we fire well inside the window. Best-effort; harmless if unavailable.
      setTimeout(() => { try { modelRefs.current[a.id]?.showPicker?.(); } catch { /* no activation */ } }, 250);
      // Rebuild to apply the new runtime + model — no confirmation.
      await call('remote', `/agent ${a.name} rebuild`);
      store.refresh();
      setBusy(null);
    } catch (err) {
      setBusy(`runtime change failed — ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setBusy(null), 4000);
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Dashboard</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="muted">
            {store.agents.length} agents · {store.team ?? 'default'}
            {busy ? ` · ${busy}…` : ''}
          </span>
          <button className="btn" disabled={!!busy} onClick={() => void probeRuntimes()} title="Probe each runtime's backing inference provider for its available models">
            Probe runtimes
          </button>
        </div>
      </header>

      <div className="cols dash-top">
        <section className="card grow">
          <table className="grid">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Runtime</th>
                <th>Model</th>
                <th>Port</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {store.agents.map((a) => {
                // Only models available for this agent's runtime, plus its current one.
                const runtimeModels = catalog[a.runtime ?? ''] ?? [];
                const modelOpts = Array.from(new Set([a.model, ...runtimeModels].filter(Boolean))) as string[];
                const isLocal = (a.type ?? '') === 'claude' || RUNTIMES.includes(a.runtime ?? '');
                const runtimeOpts = Array.from(new Set([a.runtime, ...offerableRuntimes(providers, a.runtime ?? undefined)].filter(Boolean))) as string[];
                const mismatch = runtimeModelMismatch(a.runtime, a.model);
                return (
                  <tr key={a.id} className={sel?.id === a.id ? 'sel' : ''} onClick={() => setSelected(a.id)}>
                    <td className="b">{a.name}</td>
                    <td>
                      <span className={`dot ${statusClass(a.status)}`} /> {a.status}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {isLocal ? (
                        <select className="cell-select" value={a.runtime ?? ''} onChange={(e) => void setRuntime(a, e.target.value)}>
                          {runtimeOpts.map((r) => (
                            <option key={r} value={r}>
                              {runtimeLabel(r)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted" title="remote agents have no switchable runtime">{short(a.runtime ?? a.type)}</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        ref={(el) => { modelRefs.current[a.id] = el; }}
                        className={`cell-select${mismatch ? ' mismatch' : ''}`}
                        value={a.model ?? ''}
                        onChange={(e) => void setModel(a, e.target.value)}
                        title={mismatch ?? undefined}
                      >
                        {modelOpts.map((m) => (
                          <option key={m} value={m}>
                            {short(m)}
                          </option>
                        ))}
                      </select>
                      {mismatch ? <span className="warn-text" title={mismatch} style={{ marginLeft: 4, cursor: 'help' }}>⚠</span> : null}
                    </td>
                    <td className="muted" title="port is assigned by the manager">
                      {a.port || '—'}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="cell-select"
                        value=""
                        onChange={(e) => {
                          action(a, e.target.value);
                          e.target.value = '';
                        }}
                      >
                        <option value="">⋯</option>
                        <option>Start</option>
                        <option>Stop</option>
                        <option>Rebuild</option>
                        <option>Probe</option>
                        <option>Delete</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
              {store.agents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted center pad">
                    {store.connection === 'offline' ? 'manager unreachable' : 'no agents in this team'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <aside className="card feed grow">
          <h3>Activity</h3>
          <div className="feed-list">
            {store.events.slice(-60).reverse().map((e) => (
              <div className="feed-row" key={e.seq}>
                <span className={`topic ${topicClass(e.topic)}`}>{e.topic}</span>
                <span className="desc">{describe(e)}</span>
                <span className="muted t">{ago(e.timestamp)}</span>
              </div>
            ))}
            {store.events.length === 0 ? <div className="muted">waiting for events…</div> : null}
          </div>
        </aside>
      </div>

      {sel ? (
        <section className="card detail">
          <h3>{sel.name}</h3>
          <div className="kv">
            <span>status</span>
            <b>
              <span className={`dot ${statusClass(sel.status)}`} /> {sel.status}
            </b>
            <span>runtime</span>
            <b>{sel.runtime ?? sel.type ?? '—'}</b>
            <span>model</span>
            <b>{sel.model ?? '—'}</b>
            <span>port</span>
            <b>{sel.port || '—'}</b>
            <span>skills</span>
            <b>
              {skillsOf(sel).length ? (
                <span className="chips">
                  {skillsOf(sel).map((s) => (
                    <span className="chip" key={s}>
                      {s}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="muted">none</span>
              )}
            </b>
            <span>workdir</span>
            <b className="mono small">{sel.workingDirectory ?? '—'}</b>
          </div>
        </section>
      ) : null}
    </div>
  );
}
