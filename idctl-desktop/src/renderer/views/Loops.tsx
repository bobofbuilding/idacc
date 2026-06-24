import { useEffect, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';

/**
 * Loops — recurring objectives the manager runs on a cadence (built on calendar
 * check-ins, so they run 24/7 even when this app is closed). Builder + tracker.
 */

const CADENCES = [
  { label: 'every day', days: 'mon,tue,wed,thu,fri,sat,sun' },
  { label: 'weekdays', days: 'mon,tue,wed,thu,fri' },
  { label: 'weekends', days: 'sat,sun' },
  { label: 'weekly (Mon)', days: 'mon' },
];

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function fmtTime(sec: number | null): string {
  if (sec == null) return '';
  return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
}
function relTime(sec: number | null): string {
  if (!sec) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function cadenceLabel(s: ScheduleEntry): string {
  const days = s.daysOfWeek || s.localDate || '';
  const known = CADENCES.find((c) => c.days === days);
  return `${known ? known.label : days} · ${fmtTime(s.localTimeSeconds)}`;
}

// ---- Agent chains: AI-drafted sequential agent→task loops --------------------
type LoopStep = { agent: string; task: string };
type LoopStepResult = { agent: string; task: string; status: 'ok' | 'failed' | 'skipped'; output?: string; error?: string };
type LoopSummary = { id: string; title: string; team: string; steps: number; updatedAt: number; lastRunAt?: number };
interface Loop { id: string; title: string; goal: string; team: string; steps: LoopStep[]; createdAt: number; updatedAt: number; lastRunAt?: number; lastResults?: LoopStepResult[] }
type RunState = { idx: number; status: 'running' | 'ok' | 'failed' | 'skipped'; output?: string; error?: string };

function loopId(): string { return `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function clip(s: string, n: number): string { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function agoMs(ms?: number): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
const okText = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
const DRAFT_PROMPT = (goal: string, names: string[]) =>
  'Design a SEQUENTIAL multi-agent workflow (a "loop") to accomplish the goal below. ' +
  'Output JSON ONLY — no prose, no fences: an array of 2-6 steps, each ' +
  '{"agent":"<one of the agents>","task":"<what that agent should do at this step>"}. ' +
  'Order matters: each step builds on the previous step\'s output. Use ONLY these agents: ' +
  (names.join(', ') || '(none)') + '.\n\nGOAL: ' + goal;

function ChainBuilder({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const names = store.agents.map((a) => a.name);
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? names[0] ?? '';
  const [chains, setChains] = useState<LoopSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [draftAgent, setDraftAgent] = useState('');
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [results, setResults] = useState<RunState[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const designer = draftAgent && names.includes(draftAgent) ? draftAgent : coordinator;
  const locked = drafting || running || busy;

  async function reload() { setChains(await call<LoopSummary[]>('loops:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);

  function fix(s: LoopStep): LoopStep { return { agent: names.includes(s.agent) ? s.agent : coordinator, task: String(s.task || '').trim() }; }

  async function draft() {
    if (!goal.trim()) { setMsg('describe the goal first'); return; }
    if (!designer) { setMsg('no agent available to design the chain'); return; }
    setDrafting(true); setMsg(`asking ${designer} to design the chain…`); setResults([]);
    try {
      const reply = okText(await call<string>('dispatch', `/ask ${designer} ${qArg(DRAFT_PROMPT(goal.trim(), names))}`));
      const a = reply.indexOf('['); const b = reply.lastIndexOf(']');
      if (a < 0 || b <= a) { setMsg('AI did not return a step list — edit the steps by hand or retry'); return; }
      const arr = JSON.parse(reply.slice(a, b + 1)) as LoopStep[];
      const next = (Array.isArray(arr) ? arr : []).map(fix).filter((s) => s.task).slice(0, 12);
      if (!next.length) { setMsg('AI returned no usable steps — retry or add steps manually'); return; }
      setSteps(next); if (!title.trim()) setTitle(clip(goal, 60));
      setMsg(`drafted ${next.length} step(s) — review, then run`);
    } catch (e) { setMsg(`draft failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDrafting(false); }
  }

  function updateStep(i: number, patch: Partial<LoopStep>) { setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s))); }
  function addStep() { setSteps((ss) => [...ss, { agent: coordinator, task: '' }]); }
  function removeStep(i: number) { setSteps((ss) => ss.filter((_, j) => j !== i)); }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((ss) => { const j = i + dir; if (j < 0 || j >= ss.length) return ss; const n = [...ss]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }
  function newChain() { setEditingId(null); setTitle(''); setGoal(''); setSteps([]); setResults([]); setMsg(''); }

  function buildLoop(extra?: Partial<Loop>): Loop {
    const now = Date.now();
    return { id: editingId ?? loopId(), title: title.trim() || clip(goal, 60) || 'Untitled loop', goal: goal.trim(), team, steps, createdAt: now, updatedAt: now, ...extra };
  }
  async function save() {
    const valid = steps.map(fix).filter((s) => s.task);
    if (!valid.length) { setMsg('add at least one step with a task'); return; }
    setBusy(true); setMsg('saving…');
    try { const loop = buildLoop({ steps: valid }); await call('loops:save', loop); setEditingId(loop.id); await reload(); setMsg('saved ✓'); }
    catch (e) { setMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }

  async function run() {
    const valid = steps.map(fix).filter((s) => s.task);
    if (!valid.length) { setMsg('nothing to run — add steps first'); return; }
    setRunning(true); setMsg('running the chain…');
    setResults(valid.map((_, i) => ({ idx: i, status: i === 0 ? 'running' : 'skipped' })));
    const out: LoopStepResult[] = [];
    let context = ''; let failed = false;
    for (let i = 0; i < valid.length; i++) {
      const s = valid[i];
      setResults((rs) => rs.map((r) => (r.idx === i ? { ...r, status: 'running' } : r)));
      const prompt = s.task + (context ? `\n\n--- Output from earlier steps (use as context) ---\n${context}` : '');
      try {
        const reply = okText(await call<string>('dispatch', `/ask ${s.agent} ${qArg(prompt)}`));
        out.push({ agent: s.agent, task: s.task, status: 'ok', output: reply });
        context += `\n[Step ${i + 1} · ${s.agent}]\n${reply}\n`;
        setResults((rs) => rs.map((r) => (r.idx === i ? { ...r, status: 'ok', output: reply } : r)));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        out.push({ agent: s.agent, task: s.task, status: 'failed', error });
        setResults((rs) => rs.map((r) => (r.idx === i ? { ...r, status: 'failed', error } : r)));
        failed = true; break; // later steps depend on this one
      }
    }
    setRunning(false);
    setMsg(failed ? 'chain stopped on a failed step' : 'chain finished ✓');
    // Persist the run (saves the loop if it was unsaved) so it shows under saved chains.
    try { const loop = buildLoop({ steps: valid, lastRunAt: Date.now(), lastResults: out }); await call('loops:save', loop); setEditingId(loop.id); await reload(); } catch { /* non-fatal */ }
  }

  async function openSaved(id: string) {
    if (editingId === id) { newChain(); return; }
    const l = await call<Loop | null>('loops:get', id).catch(() => null);
    if (!l) { setMsg('could not load that chain'); return; }
    setEditingId(l.id); setTitle(l.title); setGoal(l.goal); setSteps(l.steps || []);
    setResults((l.lastResults || []).map((r, i) => ({ idx: i, status: r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : 'skipped', output: r.output, error: r.error })));
    setMsg('');
  }
  async function removeSaved(id: string) { setBusy(true); try { await call('loops:remove', id); if (editingId === id) newChain(); await reload(); } finally { setBusy(false); } }

  return (
    <section className="card">
      <div className="row-actions" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <h3 className="grow" style={{ margin: 0 }}>Agent chains <span className="muted small">· string agents + tasks into a sequential loop, AI-drafted</span></h3>
        {msg ? <span className={`small ${/failed|could not|stopped/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
      </div>

      {chains.length ? (
        <div className="chips" style={{ marginBottom: 8 }}>
          {chains.map((c) => (
            <span key={c.id} className={`chip${editingId === c.id ? ' on' : ''}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <button className="link-btn" disabled={locked} title={`${c.steps} step(s) · last run ${agoMs(c.lastRunAt)}`} onClick={() => void openSaved(c.id)}>{c.title}</button>
              <button className="link-btn" style={{ opacity: 0.6 }} disabled={locked} title="Delete chain" onClick={() => void removeSaved(c.id)}>✕</button>
            </span>
          ))}
          <button className="btn small" disabled={locked} onClick={newChain}>+ new chain</button>
        </div>
      ) : null}

      <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'start' }}>
        <span>goal</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <textarea style={{ flex: '1 1 320px', minHeight: 44 }} placeholder="what should the chain accomplish? e.g. “research the top 3 competitors, then draft a positioning one-pager, then sanity-check it”" value={goal} disabled={locked} onChange={(e) => setGoal(e.target.value)} />
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select className="cell-select" value={designer} disabled={locked} onChange={(e) => setDraftAgent(e.target.value)} title="agent that designs the chain">
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button className="btn" disabled={locked || !goal.trim()} onClick={() => void draft()}>{drafting ? 'Drafting…' : '✦ Draft chain'}</button>
          </span>
        </span>
        {steps.length ? (<><span>name</span>
          <input style={{ width: '100%' }} placeholder="chain name" value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} /></>) : null}
      </div>

      {steps.length ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {steps.map((s, i) => {
            const r = results.find((x) => x.idx === i);
            const mark = r?.status === 'ok' ? '✓' : r?.status === 'failed' ? '✗' : r?.status === 'running' ? '…' : `${i + 1}`;
            const cls = r?.status === 'ok' ? 'ok' : r?.status === 'failed' ? 'failed' : r?.status === 'running' ? 'running' : 'pending';
            return (
              <div key={i} style={{ border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '6px 8px' }}>
                <div className="row-actions" style={{ gap: 6, alignItems: 'center' }}>
                  <span className={`step-dot ${cls}`} style={{ minWidth: 22, textAlign: 'center' }}>{mark}</span>
                  <select className="cell-select" style={{ fontSize: 12 }} value={names.includes(s.agent) ? s.agent : coordinator} disabled={locked} onChange={(e) => updateStep(i, { agent: e.target.value })}>
                    {names.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <input style={{ flex: 1, fontSize: 12 }} placeholder="task for this agent (uses earlier steps' output as context)" value={s.task} disabled={locked} onChange={(e) => updateStep(i, { task: e.target.value })} />
                  <button className="btn small" disabled={locked || i === 0} title="Move up" onClick={() => moveStep(i, -1)}>↑</button>
                  <button className="btn small" disabled={locked || i === steps.length - 1} title="Move down" onClick={() => moveStep(i, 1)}>↓</button>
                  <button className="btn icon-danger small" disabled={locked} title="Remove step" onClick={() => removeStep(i)}>✕</button>
                </div>
                {r?.output ? <pre className="plan-content" style={{ marginTop: 4, maxHeight: 140 }}>{r.output}</pre> : null}
                {r?.error ? <div className="status-error small" style={{ marginTop: 4 }}>{r.error}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="row-actions" style={{ marginTop: 10, alignItems: 'center' }}>
        <button className="btn small" disabled={locked} onClick={addStep}>+ add step</button>
        <span className="grow" />
        {steps.length ? <button className="btn" disabled={locked} onClick={() => void save()}>Save</button> : null}
        {steps.length ? <button className="btn primary" disabled={locked} onClick={() => void run()}>{running ? 'Running…' : `Run ${steps.length}-step chain`}</button> : null}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        Each step runs in order via <span className="mono">/ask</span>; the output of each step is passed to the next as context. Saved chains can be re-run anytime. (Runs happen while the app is open.)
      </p>
    </section>
  );
}

export function Loops({ store }: { store: FleetStore }) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [agent, setAgent] = useState('');
  const [objective, setObjective] = useState('');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState('mon,tue,wed,thu,fri');

  async function reload() { setSchedules(await call<ScheduleEntry[]>('schedules').catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store.team, store.lastUpdated]);

  const loops = schedules.filter((s) => s.kind === 'calendar');

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setMsg(`${label}…`);
    try { await fn(); await reload(); setMsg(`${label} ✓`); }
    catch (err) { setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(false); }
  }

  async function addLoop() {
    if (!agent || !objective.trim()) { setMsg('pick an agent and write an objective'); return; }
    const d = days.replace(/\s+/g, '');
    if (!/^(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*$/.test(d)) { setMsg('pick a cadence'); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.trim())) { setMsg('time must be HH:MM (24h), e.g. 09:00'); return; }
    await act(`loop for ${agent}`, () => call('addCalendarCheckin', agent, time.trim(), d, objective.trim(), { delivery: 'talk' }));
    setObjective('');
  }

  /** Fire the loop's objective once, right now (doesn't change the schedule). */
  async function runNow(s: ScheduleEntry) {
    const targets = Array.isArray(s.targets) ? s.targets : [];
    if (!targets.length) return;
    setRunning(s.id); setMsg(`running ${targets.join(', ')}…`);
    try {
      for (const t of targets) await call('dispatch', `/ask ${t} ${qArg(s.message)}`);
      setMsg('ran once ✓');
    } catch (err) { setMsg(`run failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setRunning(null); }
  }

  const names = store.agents.map((a) => a.name);

  return (
    <>
      <ChainBuilder store={store} />

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Scheduled objectives <span className="muted small">· a single agent runs an objective on a cadence (24/7, even when this app is closed)</span></h3>
          {msg ? <span className={`small ${/failed/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        </div>
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Objective</th><th>Cadence</th><th>Status</th><th>Last run</th><th></th></tr>
          </thead>
          <tbody>
            {loops.map((s) => (
              <tr key={s.id}>
                <td className="b">{(Array.isArray(s.targets) ? s.targets : []).join(', ') || '—'}</td>
                <td className="small">{s.message}</td>
                <td className="muted small mono">{cadenceLabel(s)}</td>
                <td className={s.lastStatus === 'failed' ? 'status-error small' : s.active ? 'ok-text small' : 'muted small'}>
                  {s.lastStatus === 'failed' ? '⚠ failed' : s.active ? '● looping' : 'paused'}
                </td>
                <td className="muted small">{relTime(s.lastRunAt)}</td>
                <td className="row-actions">
                  <button className="btn" disabled={busy || running !== null} title="Run the objective once now" onClick={() => void runNow(s)}>{running === s.id ? '…' : 'Run now'}</button>
                  <button className="btn" disabled={busy || running === s.id} onClick={() => void act(s.active ? 'pause' : 'resume', () => call(s.active ? 'pauseSchedule' : 'resumeSchedule', s.id))}>{s.active ? 'Pause' : 'Resume'}</button>
                  <button className="btn icon-danger" disabled={busy || running === s.id} title="Delete loop" onClick={() => void act('remove', () => call('removeSchedule', s.id))}>✕</button>
                </td>
              </tr>
            ))}
            {loops.length === 0 ? <tr><td colSpan={6} className="muted center pad">No loops yet. Build one below — e.g. weekdays 09:00 → “review the SkillMesh queue and report blockers”.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>New loop</h3>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px' }}>
          <span>agent</span>
          <b>
            <select className="cell-select" value={agent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
              <option value="">choose an agent…</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </b>
          <span>objective</span>
          <b><textarea style={{ width: '100%', minHeight: 44 }} placeholder="what the agent should do each run, e.g. “check open PRs and summarize what needs review”" value={objective} disabled={busy} onChange={(e) => setObjective(e.target.value)} /></b>
          <span>cadence</span>
          <b style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="cell-select" value={days} disabled={busy} onChange={(e) => setDays(e.target.value)}>
              {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
            </select>
            <span className="muted small">at</span>
            <input style={{ width: 70 }} disabled={busy} value={time} onChange={(e) => setTime(e.target.value)} placeholder="09:00" />
            <span className="muted small">local time</span>
          </b>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="grow" />
          <button className="btn primary" disabled={busy || !agent || !objective.trim()} onClick={() => void addLoop()}>Create loop</button>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          Loops are dispatched by the manager on the cadence (they keep running when this app is closed). Use <b>Run now</b> to fire one immediately. Status reflects the last scheduled run.
        </p>
      </section>
    </>
  );
}
