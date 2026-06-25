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
// Reasoning effort only applies to the subscription runtimes that read ID_AGENT_EFFORT:
// codex (-c model_reasoning_effort) and the Claude Code CLI harness (--effort, also serves
// claude-code-local). Local servers (ollama) and cursor-cli have no reasoning-effort knob.
const EFFORT_RUNTIMES = new Set(['codex', 'claude-code-cli', 'claude-code-local']);
function effortSupports(runtime?: string): boolean {
  return EFFORT_RUNTIMES.has(runtime ?? '');
}
function effortOf(a: Agent): string {
  const e = a.metadata?.effort;
  return typeof e === 'string' ? e : '';
}
function skillsOf(a: Agent): string[] {
  const s = a.metadata?.skills;
  return Array.isArray(s) ? (s as string[]) : [];
}

export function AgentTable({ store, onProbe, probeBusy }: { store: FleetStore; onProbe?: (a: TeamAgent) => void; probeBusy?: string | null }) {
  const cols = onProbe ? 8 : 7;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [coords, setCoords] = useState<Record<string, string>>({}); // team → coordinator (lead) name
  const [showStopped, setShowStopped] = useState(false); // by default the grid shows only running agents
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
  const isActive = (a: TeamAgent) => statusClass(a.status) === 'ok';
  const activeCount = shown.filter(isActive).length;
  const stoppedCount = shown.length - activeCount;

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setCatalog).catch(() => setCatalog({}));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
    call<{ coordinators?: Record<string, string> }>('coordinator:hierarchy').then((h) => setCoords(h.coordinators ?? {})).catch(() => {});
  }, [store.lastUpdated]);

  // ★ set an agent as its team's coordinator (lead) — works per-team in the holistic view.
  const teamFor = (a: TeamAgent) => a.team ?? store.team ?? 'default';
  const isLead = (a: TeamAgent) => (coords[teamFor(a)] ?? (teamFor(a) === store.team ? store.coordinator : undefined)) === a.name;
  async function makeLead(a: TeamAgent) {
    const team = teamFor(a);
    try { await call('coordinator:set', team, a.name); setCoords((c) => ({ ...c, [team]: a.name })); store.refresh(); }
    catch (err) { window.alert(`couldn't set lead: ${err instanceof Error ? err.message : String(err)}`); }
  }
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
    if (act === 'Reset session') {
      // Start a fresh conversation — drops the agent's accumulated context. Use this to deflate a
      // bloated codex session (multi-million-token prompts) so its next turns are cheap again.
      void run(`reset session ${a.name}`, `/clear ${a.name}`, team);
      return;
    }
    void run(`${act} ${a.name}`, `/agent ${a.name} ${act.toLowerCase()}`, team);
  }
  async function setEffort(a: TeamAgent, effort: string) {
    if (effort === effortOf(a)) return;
    const team = teamOf(a);
    setBusy(`effort ${a.name}`);
    try {
      await call('setAgentEffort', a.id, effort, team);
      // Rebuild so the agent's harness picks up the new ID_AGENT_EFFORT on its next launch.
      await call('remote', `/agent ${a.name} rebuild`, undefined, team);
      store.refresh(); setBusy(null);
    } catch (err) { setBusy(`effort change failed — ${err instanceof Error ? err.message : String(err)}`); setTimeout(() => setBusy(null), 4000); }
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
        <td className="b">
          <button className={`star${isLead(a) ? ' on' : ''}`} title={isLead(a) ? `${a.name} is ${teamFor(a)}'s lead` : `Make ${a.name} the lead of ${teamFor(a)}`}
            onClick={(e) => { e.stopPropagation(); if (!isLead(a)) void makeLead(a); }} style={{ marginRight: 5 }}>{isLead(a) ? '★' : '☆'}</button>
          {a.name}
        </td>
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
        <td onClick={(e) => e.stopPropagation()}>
          {effortSupports(a.runtime) ? (
            <select className="cell-select" value={effortOf(a)} onChange={(e) => void setEffort(a, e.target.value)}
              title="Reasoning effort — lower spends fewer subscription tokens per turn">
              <option value="">default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          ) : (
            <span className="muted" title="local & cursor runtimes have no reasoning-effort setting">—</span>
          )}
        </td>
        <td className="muted" title="port is assigned by the manager">{a.port || '—'}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className="cell-select" value="" onChange={(e) => { action(a, e.target.value); e.target.value = ''; }}>
            <option value="">⋯</option>
            <option>Start</option>
            <option>Stop</option>
            <option>Rebuild</option>
            <option>Reset session</option>
            <option>Probe</option>
            <option>Delete</option>
          </select>
        </td>
        {onProbe ? (
          <td onClick={(e) => e.stopPropagation()}>
            <button className="btn small" disabled={probeBusy === a.name} onClick={() => onProbe(a)}>{probeBusy === a.name ? '…' : 'Probe'}</button>
          </td>
        ) : null}
      </tr>
    );
  };

  return (
    <>
      <section className="card grow" style={{ minWidth: 0 }}>
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Fleet <span className="muted small">· {activeCount} active{busy ? ` · ${busy}…` : ''}</span></h3>
          <span className="grow" />
          {stoppedCount ? (
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="By default only running agents are shown — reveal stopped ones to start/manage them">
              <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} /> show stopped ({stoppedCount})
            </label>
          ) : null}
          <button className="btn" disabled={!!busy} onClick={() => void probeRuntimes()} title="Probe each runtime's backing inference provider for its available models">Probe runtimes</button>
        </div>
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Status</th><th>Runtime</th><th>Model</th><th title="Reasoning effort — lower spends fewer subscription tokens (codex & Claude CLI only)">Effort</th><th>Port</th><th>Actions</th>{onProbe ? <th>Probe</th> : null}</tr>
          </thead>
          <tbody>
            {groups.flatMap((g) => {
              // The team's actual ★ lead floats to the top of its group (not just a "lead"-named agent).
              const teamLead = coords[g.team] ?? (g.team === store.team ? store.coordinator : undefined);
              const rows = agentsLeadFirst(g.agents, teamLead).filter((a) => showStopped || isActive(a as TeamAgent));
              if (!rows.length) return [];
              return [
                <tr key={`hdr-${g.team}`} className="group-row">
                  <td colSpan={cols} className="muted small b" style={{ background: 'var(--panel, #1b1b1b)', padding: '4px 8px' }}>
                    {g.team} · {g.agents.filter((x) => statusClass(x.status) === 'ok').length}/{g.agents.length} running
                  </td>
                </tr>,
                ...rows.map((a) => renderRow(a as TeamAgent)),
              ];
            })}
            {activeCount === 0 && !showStopped ? (
              <tr><td colSpan={cols} className="muted center pad">{store.connection === 'offline' ? 'manager unreachable' : stoppedCount ? 'no running agents — tick “show stopped” to start one' : 'no agents'}</td></tr>
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
