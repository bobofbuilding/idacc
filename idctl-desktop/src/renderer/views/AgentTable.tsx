import { useEffect, useRef, useState } from 'react';
import { call, agentsLeadFirst, type FleetStore, type TeamAgent } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { RUNTIMES, offerableRuntimes } from '../../../../idctl/src/settings/runtimeCatalog.ts';

/**
 * The fleet agent grid — per-agent runtime/model switching + lifecycle actions, with a
 * detail panel for the selected agent. Holistic by default: when the app is in "All teams"
 * view it lists every team's agents grouped by team and routes each action to that agent's
 * own team. Extracted from the Dashboard so it can live in HR Manager.
 */

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };

function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}
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
  if (runtime === 'cursor-cli') return new Set(['claude', 'openai']);
  if (runtime === 'ollama') return new Set(['ollama']);
  return new Set(['claude', 'openai', 'ollama', 'other']);
}
function runtimeModelMismatch(runtime?: string, model?: string): string | null {
  if (!runtime || !model) return null;
  const fam = modelFamily(model);
  if (fam === 'other') return null;
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
function skillsOf(a: Agent): string[] {
  const s = a.metadata?.skills;
  return Array.isArray(s) ? (s as string[]) : [];
}

export function AgentTable({ store }: { store: FleetStore }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const modelRefs = useRef<Record<string, HTMLSelectElement | null>>({});
  const viewAll = store.viewAll;
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);
  const shown: TeamAgent[] = viewAll ? store.allAgents : orderedAgents;
  const sel: TeamAgent | undefined = shown.find((a) => a.id === selected) ?? shown[0];
  const teamOf = (a: TeamAgent): string | undefined => (viewAll ? a.team : undefined);
  const groups = viewAll
    ? Object.values(
        store.allAgents.reduce<Record<string, { team: string; agents: TeamAgent[] }>>((acc, a) => {
          const t = a.team ?? '—';
          (acc[t] ??= { team: t, agents: [] }).agents.push(a);
          return acc;
        }, {}),
      ).sort((x, y) => {
        const xa = x.agents.some((a) => statusClass(a.status) === 'ok');
        const ya = y.agents.some((a) => statusClass(a.status) === 'ok');
        return xa !== ya ? (xa ? -1 : 1) : x.team.localeCompare(y.team);
      })
    : [];

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setCatalog).catch(() => setCatalog({}));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
  }, [store.lastUpdated]);
  useEffect(() => {
    call<Record<string, string[]>>('runtime:probe').then(setCatalog).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function probeRuntimes() {
    setBusy('probe runtimes');
    try { setCatalog(await call<Record<string, string[]>>('runtime:probe')); }
    catch (err) { window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function run(label: string, cmd: string, team?: string) {
    setBusy(label);
    try { await call('remote', cmd, undefined, team); store.refresh(); }
    catch (err) { window.alert(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function setModel(a: TeamAgent, model: string) {
    if (!model || model === a.model) return;
    const team = teamOf(a);
    setBusy(`model ${a.name}`);
    try {
      await call('remote', `/model ${a.name} ${model}`, undefined, team);
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`model change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }
  function action(a: TeamAgent, act: string) {
    if (!act) return;
    const team = teamOf(a);
    if (act === 'Delete') {
      if (window.confirm(`Delete agent "${a.name}"? Working files are left in place.`)) void run(`delete ${a.name}`, `/delete ${a.name}`, team);
      return;
    }
    void run(`${act} ${a.name}`, `/agent ${a.name} ${act.toLowerCase()}`, team);
  }
  async function setRuntime(a: TeamAgent, runtime: string) {
    if (!runtime || runtime === a.runtime) return;
    const team = teamOf(a);
    setBusy(`runtime ${a.name}`);
    try {
      await call('setAgentRuntime', a.id, runtime, team);
      const models = catalog[runtime] ?? [];
      const model = !a.model || runtimeModelMismatch(runtime, a.model) ? models[0] ?? a.model : a.model;
      if (model && model !== a.model) await call('remote', `/model ${a.name} ${model}`, undefined, team);
      store.refresh();
      setTimeout(() => { try { modelRefs.current[a.id]?.showPicker?.(); } catch { /* no activation */ } }, 250);
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`runtime change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
  }

  const renderRow = (a: TeamAgent) => {
    const runtimeModels = catalog[a.runtime ?? ''] ?? [];
    const modelOpts = Array.from(new Set([a.model, ...runtimeModels].filter(Boolean))) as string[];
    const isLocal = (a.type ?? '') === 'claude' || RUNTIMES.includes(a.runtime ?? '');
    const runtimeOpts = Array.from(new Set([a.runtime, ...offerableRuntimes(providers, a.runtime ?? undefined)].filter(Boolean))) as string[];
    const mismatch = runtimeModelMismatch(a.runtime, a.model);
    return (
      <tr key={`${a.team ?? ''}-${a.id}`} className={sel?.id === a.id ? 'sel' : ''} onClick={() => setSelected(a.id)}>
        <td className="b">{a.name}</td>
        <td><span className={`dot ${statusClass(a.status)}`} /> {a.status}</td>
        <td onClick={(e) => e.stopPropagation()}>
          {isLocal ? (
            <select className="cell-select" value={a.runtime ?? ''} onChange={(e) => void setRuntime(a, e.target.value)}>
              {runtimeOpts.map((r) => <option key={r} value={r}>{runtimeLabel(r)}</option>)}
            </select>
          ) : (
            <span className="muted" title="remote agents have no switchable runtime">{short(a.runtime ?? a.type)}</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <select ref={(el) => { modelRefs.current[a.id] = el; }} className={`cell-select${mismatch ? ' mismatch' : ''}`} value={a.model ?? ''} onChange={(e) => void setModel(a, e.target.value)} title={mismatch ?? undefined}>
            {modelOpts.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          {mismatch ? <span className="warn-text" title={mismatch} style={{ marginLeft: 4, cursor: 'help' }}>⚠</span> : null}
        </td>
        <td className="muted" title="port is assigned by the manager">{a.port || '—'}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className="cell-select" value="" onChange={(e) => { action(a, e.target.value); e.target.value = ''; }}>
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
  };

  return (
    <>
      <section className="card grow" style={{ minWidth: 0 }}>
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Fleet <span className="muted small">· {shown.length} agents · {viewAll ? 'all teams' : (store.team ?? 'default')}{busy ? ` · ${busy}…` : ''}</span></h3>
          <span className="grow" />
          <button className="btn" disabled={!!busy} onClick={() => void probeRuntimes()} title="Probe each runtime's backing inference provider for its available models">Probe runtimes</button>
        </div>
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Status</th><th>Runtime</th><th>Model</th><th>Port</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {viewAll
              ? groups.flatMap((g) => [
                  <tr key={`hdr-${g.team}`} className="group-row">
                    <td colSpan={6} className="muted small b" style={{ background: 'var(--panel, #1b1b1b)', padding: '4px 8px' }}>
                      {g.team} · {g.agents.filter((x) => statusClass(x.status) === 'ok').length}/{g.agents.length} running
                    </td>
                  </tr>,
                  ...agentsLeadFirst(g.agents).map((a) => renderRow(a as TeamAgent)),
                ])
              : orderedAgents.map((a) => renderRow(a))}
            {shown.length === 0 ? (
              <tr><td colSpan={6} className="muted center pad">{store.connection === 'offline' ? 'manager unreachable' : viewAll ? 'no agents in any team' : 'no agents in this team'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {sel ? (
        <section className="card detail">
          <h3>{sel.name}</h3>
          <div className="kv">
            <span>status</span><b><span className={`dot ${statusClass(sel.status)}`} /> {sel.status}</b>
            {viewAll ? (<><span>team</span><b>{sel.team ?? '—'}</b></>) : null}
            <span>runtime</span><b>{sel.runtime ?? sel.type ?? '—'}</b>
            <span>model</span><b>{sel.model ?? '—'}</b>
            <span>port</span><b>{sel.port || '—'}</b>
            <span>skills</span>
            <b>{skillsOf(sel).length ? <span className="chips">{skillsOf(sel).map((s) => <span className="chip" key={s}>{s}</span>)}</span> : <span className="muted">none</span>}</b>
            <span>workdir</span><b className="mono small">{sel.workingDirectory ?? '—'}</b>
          </div>
        </section>
      ) : null}
    </>
  );
}
