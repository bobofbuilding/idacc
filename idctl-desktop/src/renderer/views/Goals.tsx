import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';

/**
 * Goals tab (under Work, left of Plans): capture a goal, let an agent help
 * write it ("AI assist"), save it, edit it, refine it, and track its status.
 * Goals are the "what/why"; Plans are the "how".
 */

type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
type GoalPriority = 'primary' | 'secondary' | 'general';
type GoalOrigin = 'goals' | 'plans' | 'learn';
interface Goal {
  id: string; title: string; idea: string; agent?: string; team: string;
  origin?: GoalOrigin;
  status: GoalStatus; priority?: GoalPriority; autopilot?: boolean; content: string;
  driver?: { lastRunAt?: number; taskRefs?: string[]; note?: string };
  createdAt: number; updatedAt: number;
}
type GoalSummary = { id: string; title: string; status: GoalStatus; priority?: GoalPriority; agent?: string; team: string; origin?: GoalOrigin; updatedAt: number; autopilot?: boolean };
type GoalField = 'title' | 'status' | 'priority' | 'autopilot' | 'content' | 'updatedAt';
interface GoalDriverConfig { enabled: boolean; cadenceMs: number; maxOpenTasksPerGoal: number }
interface GoalDriverSummary { enabled: boolean; consideredGoals: number; drivenGoals: number; tasksSpawned: number; teamsSynced: number; errors: string[] }
type TaskLite = { title: string; description?: string | null; status: string; createdAt?: number; updatedAt?: number };
type GoalProgress = { todo: number; doing: number; stalled: number; done: number };

const STATUSES: GoalStatus[] = ['draft', 'active', 'done', 'archived'];
const PRIORITIES: GoalPriority[] = ['primary', 'secondary', 'general'];
const STATUS_CLASS: Record<GoalStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };
const PRIORITY_LABEL: Record<GoalPriority, string> = { primary: 'Primary', secondary: 'Secondary', general: 'General' };
const DRIVER_DEFAULTS: GoalDriverConfig = { enabled: true, cadenceMs: 15 * 60 * 1000, maxOpenTasksPerGoal: 3 };
const CADENCES = [
  { label: '15m', value: 15 * 60 * 1000 },
  { label: '30m', value: 30 * 60 * 1000 },
  { label: '1h', value: 60 * 60 * 1000 },
];

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function cadenceLabel(ms: number): string { return CADENCES.find((c) => c.value === ms)?.label ?? `${Math.max(1, Math.round(ms / 60000))}m`; }
function newId(): string { return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function goalPriority(p?: GoalPriority): GoalPriority { return p === 'primary' || p === 'secondary' || p === 'general' ? p : 'general'; }
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
  const syncVersion = useSyncVersion(['goals', 'work', 'tasks', 'brain']);
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
  const [priority, setPriority] = useState<GoalPriority>('general');
  const [agent, setAgent] = useState('');
  // edit-existing form
  const [refineInstr, setRefineInstr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [goalProgress, setGoalProgress] = useState<Record<string, GoalProgress>>({});
  const aliveRef = useRef(true);          // skip UI updates after unmount
  const genTok = useRef(0);               // bump to abandon an in-flight dispatch
  useEffect(() => () => { aliveRef.current = false; }, []);
  function cancel() { genTok.current++; setBusy(false); setMsg('cancelled'); }

  const genAgent = (agent && store.agents.some((a) => a.name === agent) ? agent : coordinator);
  const okContent = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
  const names = useMemo(() => store.agents.map((a) => a.name), [store.agents]);
  const changedText = (before: string | number | boolean | undefined, after: string | number | boolean | undefined) => `${String(before ?? 'none')} -> ${String(after ?? 'none')}`;
  function goalStamp(g: Goal): Record<GoalField, string | number | boolean | undefined> {
    return { title: g.title, status: g.status, priority: goalPriority(g.priority), autopilot: !!g.autopilot, content: g.content, updatedAt: g.updatedAt };
  }
  async function ensureGoalFresh(g: Goal, action: string, fields: GoalField[] = ['updatedAt']): Promise<Goal | null> {
    const current = await call<Goal | null>('goals:get', g.id).catch(() => null);
    if (!current) {
      window.alert(`${action} blocked: this goal no longer exists.`);
      setDetail(null);
      await reload();
      return null;
    }
    const before = goalStamp(g);
    const after = goalStamp(current);
    const changed = fields.filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
    if (changed.length) {
      window.alert([
        `${action} blocked: "${g.title}" changed since this editor was opened.`,
        '',
        ...changed.map((field) => `- ${field}: ${field === 'content' ? 'changed' : changedText(before[field], after[field])}`),
        '',
        'The goal will refresh; review the current goal before applying another change.',
      ].join('\n'));
      setDetail(current);
      await reload();
      return null;
    }
    return current;
  }

  async function reload() { setGoals(await call<GoalSummary[]>('goals:list', team).catch(() => [])); }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated, syncVersion]);
  async function loadDriver() {
    const cfg = await call<GoalDriverConfig>('goalDriver:getConfig').catch(() => DRIVER_DEFAULTS);
    if (aliveRef.current) setDriverCfg({ ...DRIVER_DEFAULTS, ...(cfg ?? {}) });
  }
  useEffect(() => { void loadDriver(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [syncVersion]);
  useEffect(() => {
    let stopped = false;
    const reloadProgress = async () => {
      const [currentGoals, tasks] = await Promise.all([
        call<GoalSummary[]>('goals:list', team).catch(() => [] as GoalSummary[]),
        call<TaskLite[]>('tasks:allTeams').catch(() => [] as TaskLite[]),
      ]);
      if (stopped) return;
      const next: Record<string, GoalProgress> = {};
      for (const goal of currentGoals) {
        const id = goal.id.toLowerCase();
        const related = tasks.filter((task) => [task.title, task.description]
          .some((text) => String(text || '').toLowerCase().includes(id)));
        const todo = related.filter((task) => /todo|queued|pending/i.test(task.status || '')).length;
        const stalled = related.filter((task) => {
          if (/block|stall|pause/i.test(task.status || '')) return true;
          if (!/doing|claim|progress|start|active/i.test(task.status || '')) return false;
          const activityAt = Number(task.updatedAt || task.createdAt || 0);
          return activityAt > 0 && Date.now() - activityAt >= 45 * 60 * 1000;
        }).length;
        const done = related.filter((task) => /done|complete/i.test(task.status || '')).length;
        const open = related.filter((task) => !/done|complete|cancel|archive|reject/i.test(task.status || '')).length;
        next[goal.id] = { todo, stalled, done, doing: Math.max(0, open - todo - stalled) };
      }
      setGoalProgress(next);
    };
    void reloadProgress();
    const id = setInterval(() => { void reloadProgress(); }, 30_000);
    return () => { stopped = true; clearInterval(id); };
  }, [team]);

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
      origin: 'goals', status: 'draft', priority, autopilot: false, content, createdAt: now, updatedAt: now,
    };
    await call('goals:save', goal);
    if (!aliveRef.current) return;
    const saved = await call<Goal | null>('goals:get', goal.id).catch(() => goal);
    setIdea(''); setDraft(''); setTitle(''); setPriority('general'); setShowNew(false); setMsg('goal saved ✓');
    await reload();
    setDetail(saved ?? goal);
  }

  /** Refine an existing goal via AI assist (re-uses the saved agent if present). */
  async function refine() {
    const instr = refineInstr.trim();
    if (!detail || !instr) return;
    const base = await ensureGoalFresh(detail, `Refine goal ${detail.title}`, ['updatedAt']);
    if (!base) return;
    const who = base.agent && store.agents.some((a) => a.name === base.agent) ? base.agent : genAgent;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`refining with ${who}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(REFINE_PROMPT(base.content, instr))}`));
      if (genTok.current !== tok) return; // cancelled
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty revision — kept the current goal'); return; }
      const current = await ensureGoalFresh(base, `Refine goal ${base.title}`, ['updatedAt']);
      if (!current) return;
      const next: Goal = { ...current, content, agent: who, updatedAt: Date.now() };
      await call('goals:save', next);
      if (!aliveRef.current) return;
      const saved = await call<Goal | null>('goals:get', next.id).catch(() => next);
      setDetail(saved ?? next); setRefineInstr(''); setMsg('goal refined ✓');
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
    if (p.status && p.status !== detail.status && !window.confirm(`Change goal "${detail.title}" status to ${p.status}?\n\nThis writes the saved goal lifecycle state.`)) return;
    if (p.autopilot === true && !detail.autopilot && !window.confirm(`Enable Autopilot for "${detail.title}"?\n\nThis goal can sync Brain instructions and top up bounded team-lead work immediately and on the driver cadence.`)) return;
    const cur = await ensureGoalFresh(detail, `Update goal ${detail.title}`, ['updatedAt']);
    if (!cur) return;
    const next = { ...cur, ...p, updatedAt: Date.now() };
    await call('goals:save', next).catch(() => {});
    const saved = await call<Goal | null>('goals:get', next.id).catch(() => next);
    setDetail(saved ?? next);
    if ((saved ?? next).status === 'active' && (saved ?? next).autopilot) {
      setMsg('Autopilot queued: syncing Brain instructions and checking bounded task fanout...');
    }
    if (aliveRef.current) await reload();
  }
  async function driverPreflight(): Promise<{ cfg: GoalDriverConfig; activeGoals: GoalSummary[] }> {
    const cfg = { ...DRIVER_DEFAULTS, ...(await call<GoalDriverConfig>('goalDriver:getConfig').catch(() => driverCfg)) };
    const allGoals = await call<GoalSummary[]>('goals:list').catch(() => goals);
    return {
      cfg,
      activeGoals: allGoals.filter((g) => g.status === 'active' && g.autopilot),
    };
  }
  function goalSummaryStamp(list: GoalSummary[]): string {
    return [...list].map((g) => `${g.team}:${g.id}:${g.updatedAt}:${g.status}:${goalPriority(g.priority)}:${g.autopilot ? 1 : 0}`).sort().join('|');
  }
  function driverConfigStamp(cfg: GoalDriverConfig): string {
    return `${cfg.enabled ? 1 : 0}:${cfg.cadenceMs}:${cfg.maxOpenTasksPerGoal}`;
  }
  function activeGoalPreview(list: GoalSummary[]): string {
    if (!list.length) return '- none';
    const rows = list.slice(0, 8).map((g) => `- ${PRIORITY_LABEL[goalPriority(g.priority)]}: ${g.team || 'default'} / ${g.title}`);
    const rest = list.length - rows.length;
    return rest > 0 ? `${rows.join('\n')}\n- ... ${rest} more` : rows.join('\n');
  }
  function driverChangeReview(current: GoalDriverConfig, next: GoalDriverConfig, activeGoals: GoalSummary[]): string | null {
    const changes: string[] = [];
    if (next.enabled !== current.enabled) changes.push(`Master: ${current.enabled ? 'enabled' : 'disabled'} -> ${next.enabled ? 'enabled' : 'disabled'}`);
    if (next.cadenceMs !== current.cadenceMs) changes.push(`Cadence: ${cadenceLabel(current.cadenceMs)} -> ${cadenceLabel(next.cadenceMs)}`);
    if (next.maxOpenTasksPerGoal !== current.maxOpenTasksPerGoal) changes.push(`Manager tasks requested per pass: ${current.maxOpenTasksPerGoal} -> ${next.maxOpenTasksPerGoal}`);
    const increasesActivity = (next.enabled && !current.enabled)
      || (current.enabled && activeGoals.length > 0 && next.cadenceMs < current.cadenceMs)
      || (current.enabled && activeGoals.length > 0 && next.maxOpenTasksPerGoal > current.maxOpenTasksPerGoal);
    if (!increasesActivity) return null;
    return [
      'Apply goal Autopilot driver change?',
      '',
      ...changes,
      '',
      `Active Autopilot goals across all teams: ${activeGoals.length}`,
      activeGoalPreview(activeGoals),
      '',
      'This can spawn tasks or sync Brain team instructions on the next driver run.',
    ].join('\n');
  }
  async function patchDriver(p: Partial<GoalDriverConfig>) {
    setDriverBusy(true);
    try {
      const pre = await driverPreflight();
      const target = { ...pre.cfg, ...p };
      const review = driverChangeReview(pre.cfg, target, pre.activeGoals);
      let base = pre.cfg;
      if (review) {
        if (!window.confirm(review)) return;
        const fresh = await driverPreflight();
        if (driverConfigStamp(fresh.cfg) !== driverConfigStamp(pre.cfg) || goalSummaryStamp(fresh.activeGoals) !== goalSummaryStamp(pre.activeGoals)) {
          setDriverCfg(fresh.cfg);
          setMsg('goal driver change blocked: driver settings or active Autopilot goals changed during review');
          return;
        }
        base = fresh.cfg;
      }
      const next = await call<GoalDriverConfig>('goalDriver:setConfig', { ...base, ...p });
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
    const pre = await driverPreflight();
    if (!window.confirm([
      'Run the goal driver now?',
      '',
      `Current master: ${pre.cfg.enabled ? 'enabled' : 'disabled'}`,
      `Cadence: ${cadenceLabel(pre.cfg.cadenceMs)}`,
      `Manager tasks requested per pass: ${pre.cfg.maxOpenTasksPerGoal}`,
      `Active Autopilot goals across all teams: ${pre.activeGoals.length}`,
      activeGoalPreview(pre.activeGoals),
      '',
      'This can spawn task work and sync Brain team instructions for active Autopilot goals.',
    ].join('\n'))) return;
    const fresh = await driverPreflight();
    if (driverConfigStamp(fresh.cfg) !== driverConfigStamp(pre.cfg) || goalSummaryStamp(fresh.activeGoals) !== goalSummaryStamp(pre.activeGoals)) {
      setDriverCfg(fresh.cfg);
      setMsg('goal driver run blocked: driver settings or active Autopilot goals changed during review');
      return;
    }
    setDriverBusy(true);
    setMsg('goal driver triggered: syncing Brain instructions and checking bounded task fanout...');
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
    const current = await ensureGoalFresh(detail, `Delete goal ${detail.title}`, ['updatedAt']);
    if (!current) return;
    await call('goals:remove', current.id).catch(() => {});
    setDetail(null); setConfirmDel(false); setMsg('goal deleted ✓');
    await reload();
  }

  const goalGroups = useMemo(() => ([
    { priority: 'primary' as GoalPriority, label: 'Primary goals', empty: 'No primary goal set.' },
    { priority: 'secondary' as GoalPriority, label: 'Secondary goals', empty: 'No secondary goals set.' },
    { priority: 'general' as GoalPriority, label: 'General goals', empty: 'No general goals set.' },
  ].map((group) => ({
    ...group,
    goals: goals.filter((g) => goalPriority(g.priority) === group.priority),
  }))), [goals]);

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
          <span className="muted small">Runs only for active goals with Autopilot on; IDACC syncs Brain instructions and asks the manager to create bounded work.</span>
          <span className="grow" />
          <label className="small muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            cadence
            <select className="cell-select small" value={driverCfg.cadenceMs} disabled={driverBusy} onChange={(e) => void patchDriver({ cadenceMs: Number(e.target.value) })}>
              {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="small muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            tasks/run
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
            <span>tier</span>
            <b>
              <select className="cell-select" value={priority} disabled={busy} onChange={(e) => setPriority(e.target.value as GoalPriority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </b>
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
        {goalGroups.map((group) => (
          <div key={group.priority} style={{ marginBottom: 12 }}>
            <div className="row-actions" style={{ alignItems: 'center', gap: 8, margin: '8px 0 6px' }}>
              <b>{group.label}</b>
              <span className="muted small">{group.goals.length}</span>
            </div>
            {group.goals.map((g) => {
              const isOpen = detail?.id === g.id;
              const progress = goalProgress[g.id];
              const progressText = progress && (progress.todo || progress.doing || progress.stalled || progress.done)
                ? `${progress.doing} doing${progress.todo ? ` · ${progress.todo} todo` : ''}${progress.stalled ? ` · ${progress.stalled} stalled` : ''}${progress.done ? ` · ${progress.done} recently done` : ''}`
                : '';
              return (
                <div className={`skill-card${isOpen ? ' editing' : ''}`} key={g.id}>
                  <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(g.id)}>
                    <span className={`st-badge ${STATUS_CLASS[g.status]}`}>{g.status}</span>
                    <span className="muted small">{PRIORITY_LABEL[goalPriority(g.priority)]}</span>
                    <span className="b">{g.title}</span>
                    {g.agent ? <span className="muted small">· {g.agent}</span> : null}
                    {progressText ? <span className="muted small" title="Live manager task progress for this goal">· {progressText}</span> : null}
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
                        <select className="cell-select small" value={goalPriority(detail.priority)} disabled={busy} onChange={(e) => void patchGoal({ priority: e.target.value as GoalPriority })}>
                          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
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
            {!group.goals.length ? <p className="muted pad" style={{ margin: 0 }}>{group.empty}</p> : null}
          </div>
        ))}
      </div>
    </>
  );
}
