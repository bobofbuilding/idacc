import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';

/**
 * Goals tab (under Work, left of Plans): capture a goal, let an agent help
 * write it ("AI assist"), save it, edit it, refine it, and track its status.
 * Goals are the "what/why"; Plans are the "how".
 */

type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
interface Goal {
  id: string; title: string; idea: string; agent?: string; team: string;
  status: GoalStatus; autopilot?: boolean; content: string;
  driver?: { lastRunAt?: number; taskRefs?: string[]; note?: string };
  createdAt: number; updatedAt: number;
}
type GoalSummary = { id: string; title: string; status: GoalStatus; agent?: string; team: string; updatedAt: number; autopilot?: boolean };
interface GoalDriverConfig { enabled: boolean; cadenceMs: number; maxOpenTasksPerGoal: number }
interface GoalDriverSummary { enabled: boolean; consideredGoals: number; drivenGoals: number; tasksSpawned: number; teamsSynced: number; errors: string[] }

const STATUSES: GoalStatus[] = ['draft', 'active', 'done', 'archived'];
const STATUS_CLASS: Record<GoalStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };
const DRIVER_DEFAULTS: GoalDriverConfig = { enabled: false, cadenceMs: 30 * 60 * 1000, maxOpenTasksPerGoal: 3 };
const CADENCES = [
  { label: '15m', value: 15 * 60 * 1000 },
  { label: '30m', value: 30 * 60 * 1000 },
  { label: '1h', value: 60 * 60 * 1000 },
];

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function newId(): string { return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
const ASSIST_PROMPT = (idea: string) =>
  `Help write a clear, motivating goal. Return ONLY the goal text in Markdown: a one-line objective statement, then 2–4 bullet points describing what success looks like (measurable where possible). Be specific and outcome-focused; no preamble.\n\nRough idea: ${idea}`;
const REFINE_PROMPT = (content: string, instr: string) =>
  `Here is the current goal (Markdown):\n\n${content}\n\nRefine it according to: ${instr}\n\nReturn ONLY the complete updated goal in Markdown (the full statement, not just the changes).`;

export function Goals({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [detail, setDetail] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);
  const [driverBusy, setDriverBusy] = useState(false);
  const [driverCfg, setDriverCfg] = useState<GoalDriverConfig>(DRIVER_DEFAULTS);
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);
  // new-goal form
  const [idea, setIdea] = useState('');
  const [draft, setDraft] = useState('');     // the editable goal statement
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState('');
  // edit-existing form
  const [refineInstr, setRefineInstr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const aliveRef = useRef(true);          // skip UI updates after unmount
  const genTok = useRef(0);               // bump to abandon an in-flight dispatch
  useEffect(() => () => { aliveRef.current = false; }, []);
  function cancel() { genTok.current++; setBusy(false); setMsg('cancelled'); }

  const genAgent = (agent && store.agents.some((a) => a.name === agent) ? agent : coordinator);
  const okContent = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
  const names = useMemo(() => store.agents.map((a) => a.name), [store.agents]);

  async function reload() { setGoals(await call<GoalSummary[]>('goals:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);
  async function loadDriver() {
    const cfg = await call<GoalDriverConfig>('goalDriver:getConfig').catch(() => DRIVER_DEFAULTS);
    if (aliveRef.current) setDriverCfg({ ...DRIVER_DEFAULTS, ...(cfg ?? {}) });
  }
  useEffect(() => { void loadDriver(); }, []);

  async function open(id: string) {
    if (detail?.id === id) { setDetail(null); return; } // toggle closed
    setConfirmDel(false); setRefineInstr('');
    setDetail(await call<Goal | null>('goals:get', id).catch(() => null));
  }

  /** AI assist: draft the goal statement from the rough idea into the editable field. */
  async function assist() {
    const text = idea.trim();
    if (!text) { setMsg('describe the goal first — then AI assist can help write it'); return; }
    if (!genAgent) { setMsg('no agent available to help write the goal'); return; }
    const tok = ++genTok.current;
    setBusy(true); setMsg(`drafting with ${genAgent}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${genAgent} ${qArg(ASSIST_PROMPT(text))}`));
      if (genTok.current !== tok) return; // cancelled
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty draft — try again'); return; }
      if (!aliveRef.current) return;
      setDraft(content);
      if (!title.trim()) setTitle(clip(text, 60));
      setMsg('draft ready — review & edit, then Save goal');
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`AI assist failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  async function saveNew() {
    const content = draft.trim();
    if (!content) { setMsg('write the goal (or use AI assist) before saving'); return; }
    const now = Date.now();
    const goal: Goal = {
      id: newId(), title: (title.trim() || clip(content, 60)), idea: idea.trim(), agent: genAgent, team,
      status: 'draft', autopilot: false, content, createdAt: now, updatedAt: now,
    };
    await call('goals:save', goal);
    if (!aliveRef.current) return;
    setIdea(''); setDraft(''); setTitle(''); setShowNew(false); setMsg('goal saved ✓');
    await reload();
    setDetail(goal);
  }

  /** Refine an existing goal via AI assist (re-uses the saved agent if present). */
  async function refine() {
    const instr = refineInstr.trim();
    if (!detail || !instr) return;
    const who = detail.agent && store.agents.some((a) => a.name === detail.agent) ? detail.agent : genAgent;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`refining with ${who}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(REFINE_PROMPT(detail.content, instr))}`));
      if (genTok.current !== tok) return; // cancelled
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty revision — kept the current goal'); return; }
      const next: Goal = { ...detail, content, agent: who, updatedAt: Date.now() };
      await call('goals:save', next);
      if (!aliveRef.current) return;
      setDetail(next); setRefineInstr(''); setMsg('goal refined ✓');
      await reload();
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`refine failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  /** Field edit (title/status/content): merge onto the LATEST stored goal so a
   *  concurrent refine can't clobber a freshly-saved field. */
  async function patchGoal(p: Partial<Goal>) {
    if (!detail) return;
    const cur = (await call<Goal | null>('goals:get', detail.id).catch(() => null)) ?? detail;
    const next = { ...cur, ...p, updatedAt: Date.now() };
    setDetail(next);
    await call('goals:save', next).catch(() => {});
    if (aliveRef.current) await reload();
  }
  async function patchDriver(p: Partial<GoalDriverConfig>) {
    setDriverBusy(true);
    try {
      const next = await call<GoalDriverConfig>('goalDriver:setConfig', { ...driverCfg, ...p });
      if (!aliveRef.current) return;
      setDriverCfg({ ...DRIVER_DEFAULTS, ...(next ?? {}) });
      setMsg('goal driver settings saved');
    } catch (err) {
      if (aliveRef.current) setMsg(`goal driver settings failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current) setDriverBusy(false);
    }
  }
  async function runDriverNow() {
    setDriverBusy(true);
    setMsg('running goal driver...');
    try {
      const r = await call<GoalDriverSummary>('goalDriver:runOnce');
      if (!aliveRef.current) return;
      setMsg(r.enabled ? `goal driver ran: ${r.tasksSpawned} task(s), ${r.teamsSynced} team instruction(s)` : 'goal driver is off');
      await reload();
      if (detail) setDetail(await call<Goal | null>('goals:get', detail.id).catch(() => detail));
    } catch (err) {
      if (aliveRef.current) setMsg(`goal driver failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current) setDriverBusy(false);
    }
  }
  async function remove() {
    if (!detail) return;
    await call('goals:remove', detail.id).catch(() => {});
    setDetail(null); setConfirmDel(false); setMsg('goal deleted ✓');
    await reload();
  }

  return (
    <>
      <div className="row-actions" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="muted small">{goals.length} goal{goals.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        {msg ? <span className={`small ${/failed|timed out|expired|cancelled/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        {busy ? <button className="btn" onClick={cancel}>Cancel</button> : null}
        <button className="btn primary" disabled={busy} onClick={() => setShowNew((v) => !v)}>{showNew ? '− Cancel' : '+ New goal'}</button>
      </div>

      <section className="card" style={{ marginBottom: 10 }}>
        <div className="row-actions" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={driverCfg.enabled} disabled={driverBusy} onChange={(e) => void patchDriver({ enabled: e.target.checked })} />
            <b>Autopilot master</b>
          </label>
          <span className="muted small">Runs only for active goals with Autopilot on.</span>
          <span className="grow" />
          <label className="small muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            cadence
            <select className="cell-select small" value={driverCfg.cadenceMs} disabled={driverBusy} onChange={(e) => void patchDriver({ cadenceMs: Number(e.target.value) })}>
              {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="small muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            cap
            <input className="chat-title" style={{ width: 54 }} type="number" min={1} max={12} value={driverCfg.maxOpenTasksPerGoal} disabled={driverBusy} onChange={(e) => void patchDriver({ maxOpenTasksPerGoal: Number(e.target.value) })} />
          </label>
          <button className="btn" disabled={driverBusy} onClick={() => void runDriverNow()}>{driverBusy ? 'Running...' : 'Run now'}</button>
        </div>
      </section>

      {showNew ? (
        <section className="card">
          <h3>New goal</h3>
          <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 12px', alignItems: 'start' }}>
            <span>agent</span>
            <b>
              <select className="cell-select" value={genAgent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </b>
            <span>title</span>
            <b><input className="chat-title" style={{ width: '100%' }} placeholder="short name for this goal (optional — auto-filled)" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} /></b>
            <span>idea</span>
            <b><textarea style={{ width: '100%', minHeight: 56 }} placeholder="describe what you want to achieve, in your own words — e.g. “make the brain learn from its own mistakes each night”" value={idea} disabled={busy} onChange={(e) => setIdea(e.target.value)} /></b>
            <span>goal</span>
            <b><textarea style={{ width: '100%', minHeight: 90 }} placeholder="the goal statement — write it yourself, or click ✦ AI assist to draft it from your idea above" value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10, alignItems: 'center' }}>
            <button className="btn" disabled={busy || !idea.trim()} title="Ask an agent to draft the goal from your idea" onClick={() => void assist()}>{busy ? 'Drafting…' : '✦ AI assist'}</button>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void saveNew()}>Save goal</button>
          </div>
        </section>
      ) : null}

      <div className="skill-catalog">
        {goals.map((g) => {
          const isOpen = detail?.id === g.id;
          return (
            <div className={`skill-card${isOpen ? ' editing' : ''}`} key={g.id}>
              <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(g.id)}>
                <span className={`st-badge ${STATUS_CLASS[g.status]}`}>{g.status}</span>
                <span className="b">{g.title}</span>
                {g.agent ? <span className="muted small">· {g.agent}</span> : null}
                <span className="grow" />
                <span className="muted small">{ago(g.updatedAt)}</span>
                <span className="muted">{isOpen ? '▾' : '▸'}</span>
              </div>

              {isOpen && detail ? (
                <div className="plan-detail">
                  <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                    <input className="chat-title" style={{ flex: '0 1 320px' }} value={detail.title} disabled={busy} onChange={(e) => setDetail({ ...detail, title: e.target.value })} onBlur={(e) => void patchGoal({ title: e.target.value })} />
                    <select className="cell-select small" value={detail.status} disabled={busy} onChange={(e) => void patchGoal({ status: e.target.value as GoalStatus })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={!!detail.autopilot} disabled={busy || detail.status !== 'active'} onChange={(e) => void patchGoal({ autopilot: e.target.checked })} />
                      Autopilot
                    </label>
                    <span className="grow" />
                    {confirmDel ? (
                      <>
                        <button className="btn icon-danger small" disabled={busy} onClick={() => void remove()}>Delete?</button>
                        <button className="btn small" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn icon-danger small" disabled={busy} title="Delete goal" onClick={() => setConfirmDel(true)}>✕</button>
                    )}
                  </div>

                  <textarea className="plan-content" style={{ width: '100%', minHeight: 120 }} value={detail.content} disabled={busy} onChange={(e) => setDetail({ ...detail, content: e.target.value })} onBlur={(e) => void patchGoal({ content: e.target.value })} />

                  {detail.driver ? (
                    <div className="muted small" style={{ marginTop: 6 }}>
                      driver: {detail.driver.note ?? 'no note'}
                      {detail.driver.lastRunAt ? ` · ${ago(detail.driver.lastRunAt)}` : ''}
                      {detail.driver.taskRefs?.length ? ` · ${detail.driver.taskRefs.length} task(s)` : ''}
                    </div>
                  ) : null}

                  <div className="row-actions" style={{ gap: 6, marginTop: 8, alignItems: 'flex-start' }}>
                    <textarea style={{ flex: 1, minHeight: 38 }} placeholder="refine with AI — e.g. “make the success criteria measurable” or “tighten to one sentence”" value={refineInstr} disabled={busy} onChange={(e) => setRefineInstr(e.target.value)} />
                    <button className="btn primary" disabled={busy || !refineInstr.trim()} title="Ask an agent to refine the goal" onClick={() => void refine()}>{busy ? '…' : '✦ AI assist'}</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {goals.length === 0 ? <p className="muted center pad">No goals yet. <b>+ New goal</b> — describe what you want to achieve and let <b>✦ AI assist</b> help write it.</p> : null}
      </div>
    </>
  );
}
