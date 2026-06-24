import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';
import { usePrompt } from '../components/prompt.tsx';
import { useToast } from '../components/toast.tsx';
import type { Task } from '../../../../idctl/src/api/types.ts';
import { Schedule } from './Schedule.tsx';
import { Loops } from './Loops.tsx';
import { Plans } from './Plans.tsx';
import { Dream } from './Dream.tsx';

// Auto-decompose IPC shapes (mirror main/work.ts).
type SubTask = { title: string; description: string; agent: string; dependsOn: number[] };
type DecomposeResult = { ok: boolean; subtasks: SubTask[]; raw: string; error?: string };
type CreatedTask = { idx: number; ref: string; title: string; agent: string; ok: boolean; error?: string; dependsOn: number[]; dispatched: boolean };
type CreatePlanResult = { created: CreatedTask[]; dispatched: number; deferred: number };
type TeamLead = { team: string; lead: string | null; activeCount: number; totalCount: number };
type FanoutResult = { team: string; lead?: string; status: 'dispatched' | 'no-active-agent' | 'failed'; queryId?: string; detail?: string };
type TriageResult = { considered: number; assigned: { ref: string; agent: string }[]; skipped: number; dispatched: number; error?: string };

type Tab = 'tasks' | 'plans' | 'schedule' | 'loops' | 'dream';
const TABS: { id: Tab; label: string }[] = [
  { id: 'plans', label: 'Plans' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'loops', label: 'Loops' },
  { id: 'dream', label: 'Dream' },
];

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
const SURFACE_BLOCKERS_PROMPT = (taskList: string) =>
  'Review the team\'s current open tasks below. For any task BLOCKED on a decision only the USER can make ' +
  '(a genuine fork with 2-4 discrete options — NOT work you can just do), produce a question. Return JSON ONLY ' +
  '(no prose, no fences): [{"task":"<task ref or title>","agent":"<the owner agent>","question":"<the decision ' +
  'needed, one line>","options":["option A","option B", ...]}]. Include ONLY tasks that truly need a user ' +
  'decision; return [] if none.\n\nTASKS:\n' + taskList;

/** Stable reference the manager accepts for a task: #shortid, name, then fallbacks. */
function ref(t: Task): string {
  return t.shortId ?? t.name ?? t.uuid ?? t.title;
}
function isDone(t: Task): boolean {
  return /done|complete/i.test(t.status);
}
function isRoutine(t: Task): boolean {
  return /heartbeat/i.test(t.title) || /heartbeat/i.test(t.name ?? '');
}
// The manager only stores 3 task statuses; the Kanban refines them into lanes with an
// app-side overlay. Each lane maps onto one real status (validStatuses = todo|doing|done).
type Col = 'todo' | 'doing' | 'done';
function colOf(status: string): Col {
  if (/done|complete/i.test(status)) return 'done';
  if (/doing|claim|progress|start|active/i.test(status)) return 'doing';
  return 'todo';
}
type Lane = 'backlog' | 'holding' | 'todo' | 'doing' | 'done' | 'needs-adjustment' | 'under-review' | 'rework';
const LANE_STATUS: Record<Lane, Col> = {
  backlog: 'todo', holding: 'todo', todo: 'todo',
  doing: 'doing', 'needs-adjustment': 'doing', 'under-review': 'doing', rework: 'doing',
  done: 'done',
};
const DEFAULT_LANE: Record<Col, Lane> = { todo: 'todo', doing: 'doing', done: 'done' };
// Lane groups mirror the workflow diagram: waiting → main flow → adjustment loop.
const LANE_GROUPS: { title: string; lanes: { id: Lane; label: string }[] }[] = [
  { title: 'Waiting Areas', lanes: [{ id: 'backlog', label: 'Backlog' }, { id: 'holding', label: 'Holding Pattern' }] },
  { title: 'Main Flow', lanes: [{ id: 'todo', label: 'To Do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done' }] },
  { title: 'Adjustment Loop', lanes: [{ id: 'needs-adjustment', label: 'Needs Adjustment' }, { id: 'under-review', label: 'Under Review' }, { id: 'rework', label: 'Rework' }] },
];
/** Relative age. createdAt comes from the manager in SECONDS; normalize to ms. */
function ago(ts?: number): string {
  if (!ts) return '—';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}
/** Absolute local timestamp for a tooltip. Normalizes seconds → ms like ago(). */
function absTime(ts?: number): string | undefined {
  if (!ts) return undefined;
  return new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString();
}
/** Is an agent running (routable)? Mirrors isActiveStatus() in main/work.ts. */
function liveAgent(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !!s && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}

/** Tabbed wrapper: Tasks + Schedule + Loops in one page. */
export function Tasks({ store, initialTab }: { store: FleetStore; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = (initialTab || localStorage.getItem('idctl.tasks.tab') || 'plans') as Tab;
      return TABS.some((x) => x.id === t) ? t : 'plans'; // ignore stale/garbage values
    } catch { return 'plans'; }
  });
  function pick(t: Tab) { setTab(t); try { localStorage.setItem('idctl.tasks.tab', t); } catch { /* ignore */ } }

  return (
    <div className="view">
      <header className="view-head"><h1>Work</h1></header>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => pick(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'tasks' ? <TasksPanel store={store} /> : null}
      {tab === 'plans' ? <Plans store={store} /> : null}
      {tab === 'schedule' ? <Schedule store={store} /> : null}
      {tab === 'loops' ? <Loops store={store} /> : null}
      {tab === 'dream' ? <Dream store={store} /> : null}
    </div>
  );
}

function TasksPanel({ store }: { store: FleetStore }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [hideRoutine, setHideRoutine] = useState(true);
  const [showArchived, setShowArchived] = useState(false); // done tasks auto-archive (hidden) until revealed
  const [dragRef, setDragRef] = useState<string | null>(null); // task being dragged across lanes
  const [laneOverlay, setLaneOverlay] = useState<Record<string, string>>({}); // ref → fine-grained lane
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Auto-decompose: describe an objective → lead splits it → create + farm out.
  const [showAssign, setShowAssign] = useState(false);
  const [objective, setObjective] = useState('');
  const [lead, setLead] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<SubTask[] | null>(null);
  const [assignNote, setAssignNote] = useState('');
  const [fanTeams, setFanTeams] = useState<Set<string>>(new Set()); // other teams to fan the objective out to
  const [teamInfo, setTeamInfo] = useState<TeamLead[]>([]);          // active-lead + running counts per team
  const [autoTriage, setAutoTriage] = useState(false);              // lead keeps auto-assigning unassigned To-Do tasks
  const [triaging, setTriaging] = useState(false);                  // a triage pass is in flight (guards re-entry)
  const lastTriageRef = useRef(0);                                  // cooldown clock for auto-triage
  const prompt = usePrompt();
  const toast = useToast();

  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const leadName = lead && store.agents.some((a) => a.name === lead) ? lead : coordinator;
  const activeTeam = store.team ?? 'default';
  const otherTeams = store.teams.map((t) => t.name).filter((n) => n && n !== activeTeam);

  // When the panel opens, fetch which other teams have an active lead (who can take work now).
  useEffect(() => {
    if (!showAssign || !otherTeams.length) { setTeamInfo([]); return; }
    let live = true;
    call<TeamLead[]>('work:teamLeads', otherTeams).then((r) => { if (live) setTeamInfo(r); }).catch(() => { if (live) setTeamInfo([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAssign, store.team, store.teams.length]);

  async function fanOut() {
    const obj = objective.trim();
    const teams = [...fanTeams];
    if (!obj || !teams.length) return;
    setProposing(true); setAssignNote(`fanning out to ${teams.length} team${teams.length > 1 ? 's' : ''}…`);
    // Global toast: survives leaving this page; the dispatch runs in the main process.
    const t = toast({ kind: 'progress', text: `Fanning work out to ${teams.length} team${teams.length > 1 ? 's' : ''}…` });
    try {
      const res = await call<FanoutResult[]>('work:fanout', obj, teams);
      const ok = res.filter((r) => r.status === 'dispatched');
      const bad = res.filter((r) => r.status !== 'dispatched');
      const parts = [
        ok.length ? `dispatched to ${ok.map((r) => `${r.team}/${r.lead}`).join(', ')}` : '',
        bad.length ? `skipped ${bad.map((r) => `${r.team} (${r.status === 'no-active-agent' ? 'no active agent' : 'failed'})`).join(', ')}` : '',
      ].filter(Boolean);
      const summary = parts.join(' · ') || 'nothing dispatched';
      t.update({ kind: ok.length ? 'success' : 'error', text: `Fan-out — ${summary}` });
      setAssignNote(summary);
      if (ok.length) { setFanTeams(new Set()); store.refresh(); }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      t.update({ kind: 'error', text: `Fan-out failed: ${m}` });
      setAssignNote(`fan-out failed: ${m}`);
    } finally { setProposing(false); }
  }

  async function reload() {
    try {
      const t = await call<Task[]>('tasks');
      setTasks([...t].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
    } catch {
      setTasks([]);
    }
    setLaneOverlay(await call<Record<string, string>>('tasks:lanes').catch(() => ({})));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.lastUpdated]);
  // Auto-refresh the board so it stays live as agents claim/complete work.
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team]);

  // A task's effective lane: its overlay lane if that still matches the manager status,
  // else the default lane for the real status (so an agent's status change wins).
  function laneOf(t: Task): Lane {
    const ov = laneOverlay[ref(t)] as Lane | undefined;
    if (ov && LANE_STATUS[ov] === colOf(t.status)) return ov;
    return DEFAULT_LANE[colOf(t.status)];
  }
  // Drag a card to a lane → save the lane overlay + set the mapped manager status if it changed.
  async function moveToLane(t: Task, lane: Lane) {
    if (laneOf(t) === lane) return;
    const targetStatus = LANE_STATUS[lane];
    setBusy(true); setNote(`move ${ref(t)} → ${lane.replace(/-/g, ' ')}…`);
    try {
      await call('tasks:setLane', ref(t), lane);
      if (colOf(t.status) !== targetStatus) await call('remote', `/task status ${ref(t)} ${targetStatus}`);
      setNote('');
      await reload();
    } catch (err) {
      setNote(`move failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Surface blocker DECISIONS (forks needing the user) as option-questions in the Inbox.
  async function surfaceBlockers() {
    const open = tasks.filter((t) => !isDone(t) && !isRoutine(t));
    if (!open.length) { setNote('no open tasks to check'); return; }
    if (!leadName) { setNote('no agent available to scan'); return; }
    setBusy(true); setNote(`${leadName} is scanning open tasks for blocker decisions…`);
    try {
      const list = open.map((t) => `- ${ref(t)} [${t.ownerName ?? 'unassigned'}] ${t.title}`).join('\n');
      const reply = await call<string>('dispatch', `/ask ${leadName} ${qArg(SURFACE_BLOCKERS_PROMPT(list))}`);
      const a = reply.indexOf('['); const b = reply.lastIndexOf(']');
      const arr = a >= 0 && b > a ? (() => { try { return JSON.parse(reply.slice(a, b + 1)); } catch { return []; } })() : [];
      const agentNames = new Set(store.agents.map((x) => x.name));
      let added = 0;
      for (const it of (Array.isArray(arr) ? arr : [])) {
        const question = String(it?.question ?? '').trim();
        const options = (Array.isArray(it?.options) ? it.options : []).map((o: unknown) => String(o)).filter(Boolean);
        if (!question || options.length < 2) continue;
        const agent = agentNames.has(it?.agent) ? String(it.agent) : leadName;
        const taskTitle = it?.task ? String(it.task) : undefined;
        await call('questions:add', { question, options, agent, taskRef: taskTitle, taskTitle, team: store.team ?? 'default' });
        added++;
      }
      setNote(added ? `added ${added} blocker question${added === 1 ? '' : 's'} to the Inbox ✓` : 'no blocker decisions found');
    } catch (err) {
      setNote(`blocker scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Lead triages unassigned To-Do tasks: assign each to the best active agent + dispatch.
  async function triage(silent = false) {
    if (triaging) return;
    if (!leadName) { if (!silent) setNote('no lead available to triage'); return; }
    const pending = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo');
    if (!pending.length) { if (!silent) setNote('no unassigned To Do tasks'); return; }
    setTriaging(true);
    lastTriageRef.current = Date.now();
    const t = toast({ kind: 'progress', text: `${leadName} is triaging ${pending.length} unassigned To Do task${pending.length === 1 ? '' : 's'}…` });
    try {
      const res = await call<TriageResult>('work:triage', leadName);
      if (res.error) { t.update({ kind: 'error', text: `Triage: ${res.error}` }); setNote(`triage: ${res.error}`); }
      else {
        const summary = res.assigned.length
          ? `assigned ${res.assigned.length}${res.dispatched ? ` · dispatched ${res.dispatched}` : ''}${res.skipped ? ` · ${res.skipped} skipped` : ''}`
          : 'nothing to assign';
        t.update({ kind: res.assigned.length ? 'success' : 'info', text: `${leadName} triaged To Do — ${summary}` });
        setNote(res.assigned.length ? `${summary} ✓` : summary);
        await reload();
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      t.update({ kind: 'error', text: `Triage failed: ${m}` });
      setNote(`triage failed: ${m}`);
    } finally { setTriaging(false); }
  }

  // Auto-triage: when enabled, the lead keeps assigning unassigned To-Do tasks as they
  // appear (on the 5s poll), throttled by a 90s cooldown so it never hammers the lead.
  useEffect(() => {
    if (!autoTriage || triaging) return;
    const pending = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo').length;
    if (!pending || Date.now() - lastTriageRef.current < 90_000) return;
    void triage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriage, tasks, triaging]);

  async function run(cmd: string, label: string) {
    setBusy(true);
    setNote(`${label}…`);
    try {
      await call('remote', cmd);
      setNote('');
      await reload();
    } catch (err) {
      setNote(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function newTask() {
    const title = await prompt({ title: 'New task title:', placeholder: 'what needs doing', okLabel: 'Add task' });
    const clean = title?.trim().replace(/"/g, "'");
    if (clean) void run(`/task create "${clean}"`, `create “${clean}”`);
  }
  function assign(t: Task, agent: string) {
    if (agent) void run(`/task assign ${ref(t)} ${agent}`, `assign ${ref(t)} → ${agent}`);
  }
  async function del(t: Task) { setConfirmDel(null); await run(`/task remove ${ref(t)}`, `delete ${ref(t)}`); }
  async function clearDone() {
    const done = tasks.filter(isDone);
    setConfirmClear(false);
    setBusy(true);
    setNote(`clearing ${done.length} completed…`);
    try {
      for (const t of done) await call('remote', `/task remove ${ref(t)}`);
      setNote(`cleared ${done.length} completed ✓`);
      await reload();
    } catch (err) {
      setNote(`clear failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // ---- Auto-decompose on assign -------------------------------------------
  async function decompose() {
    const obj = objective.trim();
    if (!obj) { setAssignNote('describe the work first'); return; }
    if (!leadName) { setAssignNote('no agent available to plan the work'); return; }
    setProposing(true); setProposal(null); setAssignNote(`asking ${leadName} to break this down…`);
    try {
      const res = await call<DecomposeResult>('work:decompose', obj, leadName);
      if (!res.ok || !res.subtasks.length) { setAssignNote(res.error || 'could not split this into tasks — rephrase and retry'); return; }
      setProposal(res.subtasks);
      const par = res.subtasks.filter((s) => !s.dependsOn.length).length;
      setAssignNote(`${res.subtasks.length} sub-tasks · ${par} can start in parallel — review owners, then create & dispatch`);
    } catch (err) {
      setAssignNote(`planning failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProposing(false);
    }
  }
  function editSubAgent(i: number, agent: string) {
    setProposal((p) => (p ? p.map((s, j) => (j === i ? { ...s, agent } : s)) : p));
  }
  function removeSub(i: number) {
    setProposal((p) => {
      if (!p) return p;
      const kept = p.filter((_, j) => j !== i);
      // Re-base dependency indices around the removed task.
      return kept.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== i).map((d) => (d > i ? d - 1 : d)) }));
    });
  }
  async function createPlan() {
    if (!proposal || !proposal.length) return;
    setProposing(true); setAssignNote('creating tasks & dispatching to the fleet…');
    const n = proposal.length;
    // Global toast: persists after the panel closes / you switch pages.
    const t = toast({ kind: 'progress', text: `Creating ${n} task${n === 1 ? '' : 's'} & dispatching to ${activeTeam}…` });
    try {
      const res = await call<CreatePlanResult>('work:createPlan', objective.trim(), proposal);
      const okCount = res.created.filter((c) => c.ok).length;
      const failed = res.created.length - okCount;
      const summary = `created ${okCount} task${okCount === 1 ? '' : 's'} · dispatched ${res.dispatched} now${res.deferred ? ` · ${res.deferred} queued on deps` : ''}${failed ? ` · ${failed} failed` : ''}`;
      t.update({ kind: failed && !okCount ? 'error' : 'success', text: `${activeTeam}: ${summary}` });
      setAssignNote(`${summary} ✓`);
      setProposal(null); setObjective(''); setShowAssign(false);
      await reload();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.update({ kind: 'error', text: `Dispatch failed: ${m}` });
      setAssignNote(`dispatch failed: ${m}`);
    } finally {
      setProposing(false);
    }
  }

  const routineCount = tasks.filter(isRoutine).length;
  const openCount = tasks.filter((t) => !isDone(t)).length;
  const doneCount = tasks.filter(isDone).length;
  // Unassigned tasks sitting in the To-Do lane — what the lead can triage/assign.
  const unassignedTodo = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo').length;
  // Done tasks auto-archive: hidden from the board by default, revealed by the "show archived" toggle.
  const archivedCount = tasks.filter((t) => isDone(t) && (!hideRoutine || !isRoutine(t))).length;
  const filtered = tasks.filter((t) => {
    if (hideRoutine && isRoutine(t)) return false;
    if (!showArchived && isDone(t)) return false;
    const s = q.trim().toLowerCase();
    return !s || t.title.toLowerCase().includes(s) || (t.ownerName ?? '').toLowerCase().includes(s) || ref(t).toLowerCase().includes(s);
  });

  return (
    <>
      <style>{`@keyframes idctlPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}.idctl-pulse{animation:idctlPulse 1.2s ease-in-out infinite}`}</style>
      <div className="row-actions" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="muted small">{openCount} open · {doneCount} done</span>
        <span className="grow" />
        {doneCount > 0 ? (
          confirmClear ? (
            <>
              <button className="btn icon-danger" disabled={busy} onClick={() => void clearDone()}>Delete {doneCount} archived?</button>
              <button className="btn" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn" disabled={busy} title="Permanently delete completed (archived) tasks from the manager" onClick={() => setConfirmClear(true)}>Clear archived</button>
          )
        ) : null}
        <button className="btn" disabled={busy || triaging || !unassignedTodo} title={unassignedTodo ? `Have ${leadName || 'the lead'} assign the ${unassignedTodo} unassigned To Do task${unassignedTodo === 1 ? '' : 's'} to the best active agents and start them` : 'no unassigned To Do tasks'} onClick={() => void triage()}>{triaging ? '⚖ Triaging…' : `⚖ Triage To Do${unassignedTodo ? ` (${unassignedTodo})` : ''}`}</button>
        <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Keep the lead auto-assigning new unassigned To Do tasks (checked every poll, throttled ~90s)">
          <input type="checkbox" checked={autoTriage} onChange={(e) => setAutoTriage(e.target.checked)} />
          auto
        </label>
        <button className="btn" disabled={busy} title="Ask the lead to surface task blockers that need YOUR decision → they appear as option-questions in the Inbox" onClick={() => void surfaceBlockers()}>⚠ Surface blockers</button>
        <button className="btn" disabled={busy || proposing} onClick={() => { setShowAssign((v) => !v); setAssignNote(''); setProposal(null); }}>{showAssign ? '− Close' : '⚡ Assign work to fleet'}</button>
        <button className="btn primary" disabled={busy} onClick={() => void newTask()}>+ New task</button>
      </div>

      {showAssign ? (
        <section className="card" style={{ marginBottom: 10 }}>
          <h3 style={{ marginTop: 0 }}>Assign work to the fleet</h3>
          <p className="muted small" style={{ marginTop: -4 }}>Describe an objective. {leadName || 'The lead'} breaks it into sub-tasks, each owned by the best-suited agent — independent ones run in parallel, dependents follow their prerequisites.</p>
          <div className="kv" style={{ gridTemplateColumns: '70px 1fr', gap: '8px 12px', alignItems: 'start' }}>
            <span>lead</span>
            <b>
              <select className="cell-select" value={leadName} disabled={proposing} onChange={(e) => setLead(e.target.value)}>
                {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
              </select>
            </b>
            <span>objective</span>
            <b><textarea style={{ width: '100%', minHeight: 64 }} placeholder="e.g. “Ship a /status page: API endpoint, React widget, tests, and docs.”" value={objective} disabled={proposing} onChange={(e) => setObjective(e.target.value)} /></b>
          </div>

          {!proposal && otherTeams.length ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 5 }}>⇄ Or fan this objective out to other teams — each team's <b>active lead</b> runs it independently (◷ teams with no running agent can't take work):</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {otherTeams.map((name) => {
                  const info = teamInfo.find((t) => t.team === name);
                  const loaded = !!info;
                  const canTake = (info?.activeCount ?? 0) > 0 && !!info?.lead;
                  return (
                    <label key={name} className="small"
                      title={!loaded ? 'checking…' : canTake ? `lead: ${info!.lead} · ${info!.activeCount}/${info!.totalCount} running` : `${info!.totalCount} agent(s), none running — cannot take work`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '2px 8px', opacity: canTake ? 1 : 0.5, cursor: canTake && !proposing ? 'pointer' : 'not-allowed' }}>
                      <input type="checkbox" disabled={!canTake || proposing} checked={fanTeams.has(name)}
                        onChange={(e) => setFanTeams((prev) => { const n = new Set(prev); if (e.target.checked) n.add(name); else n.delete(name); return n; })} />
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: canTake ? '#3ccb78' : '#888', display: 'inline-block' }} />
                      {name} <span className="muted">{loaded ? `${info!.activeCount}/${info!.totalCount}` : '…'}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="row-actions" style={{ marginTop: 10, alignItems: 'center' }}>
            {assignNote ? <span className={`small ${/failed|could not|no agent/.test(assignNote) ? 'status-error' : 'muted'}`}>{assignNote}</span> : null}
            <span className="grow" />
            {proposal ? <button className="btn" disabled={proposing} onClick={() => { setProposal(null); setAssignNote(''); }}>Discard</button> : null}
            {!proposal && fanTeams.size ? (
              <button className="btn primary" disabled={proposing || !objective.trim()} onClick={() => void fanOut()}>{proposing ? 'Fanning out…' : `⇄ Fan out to ${fanTeams.size} team${fanTeams.size > 1 ? 's' : ''}`}</button>
            ) : null}
            {!proposal ? (
              <button className="btn primary" disabled={proposing || !objective.trim()} onClick={() => void decompose()}>{proposing ? 'Planning…' : `Decompose for ${activeTeam}`}</button>
            ) : (
              <button className="btn primary" disabled={proposing} onClick={() => void createPlan()}>{proposing ? 'Dispatching…' : `Create ${proposal.length} & dispatch`}</button>
            )}
          </div>

          {proposal ? (
            <div className="decomp-list" style={{ marginTop: 10 }}>
              {proposal.map((s, i) => (
                <div className="decomp-row" key={i}>
                  <span className="decomp-num mono small">{i + 1}</span>
                  <div className="decomp-main">
                    <div className="b">{s.title}</div>
                    {s.description ? <div className="muted small">{s.description}</div> : null}
                    {s.dependsOn.length ? <div className="small warn-text">⇢ after {s.dependsOn.map((d) => `#${d + 1}`).join(', ')}</div> : <div className="small ok-text">▶ starts immediately</div>}
                  </div>
                  <select className="cell-select" value={s.agent} disabled={proposing} onChange={(e) => editSubAgent(i, e.target.value)} title="owner">
                    {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
                  </select>
                  <button className="btn icon-danger small" disabled={proposing} title="Remove this sub-task" onClick={() => removeSub(i)}>✕</button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card grow" style={{ minWidth: 0 }}>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <input className="catalog-search" placeholder="search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={hideRoutine} onChange={(e) => setHideRoutine(e.target.checked)} />
            hide routine{routineCount ? ` (${routineCount})` : ''}
          </label>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Completed tasks auto-archive (hidden) to keep the board clean — toggle to see them in the Done lane">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            show archived{archivedCount ? ` (${archivedCount})` : ''}
          </label>
          <span className="muted small" title="The board re-fetches every 5s; drag a card between lanes">⟳ live · drag between lanes</span>
          <span className="grow" />
          {note ? <span className={`small ${/failed/.test(note) ? 'status-error' : 'muted'}`}>{note}</span> : null}
        </div>

        {(() => {
          const card = (t: Task) => {
            const phase = colOf(t.status);                       // todo | doing | done
            const working = phase === 'doing' && !!t.ownerName;  // an agent has claimed it and is on it
            const cAbs = absTime(t.createdAt);
            const uAbs = absTime(t.updatedAt);
            const dAbs = absTime(t.completedAt ?? t.updatedAt);
            return (
            <div
              key={ref(t)}
              draggable={!busy}
              onDragStart={(e) => { setDragRef(ref(t)); e.dataTransfer.setData('text/plain', ref(t)); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => setDragRef(null)}
              className="kanban-card"
              style={{ border: `1px solid ${working ? 'rgba(60,203,120,0.55)' : 'var(--border, #2a2a2a)'}`, borderRadius: 6, padding: '6px 8px', background: 'var(--bg, #141414)', cursor: busy ? 'default' : 'grab' }}
            >
              <div className="b" style={{ fontSize: 13 }}>{t.title}</div>
              <div className="muted small mono">{t.shortId ?? ref(t)}{isRoutine(t) ? ' · routine' : ''}</div>
              <div className="row-actions" style={{ marginTop: 4, alignItems: 'center', gap: 6 }}>
                {working ? (
                  <span className="small" title={`${t.ownerName} is actively working on this${uAbs ? ` — active since ${uAbs}` : ''}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#3ccb78', background: 'rgba(60,203,120,0.13)', borderRadius: 10, padding: '1px 7px', fontWeight: 600 }}>
                    <span className="idctl-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: '#3ccb78', display: 'inline-block' }} />
                    {t.ownerName} · working
                  </span>
                ) : t.ownerName ? (
                  <span className="muted small" title={phase === 'done' ? 'completed by this agent' : 'assigned, not yet started'}>{phase === 'done' ? '✓' : '◴'} {t.ownerName}</span>
                ) : !isDone(t) ? (
                  <select className="cell-select" style={{ fontSize: 11 }} defaultValue="" disabled={busy} onChange={(e) => assign(t, e.target.value)}>
                    <option value="">assign…</option>
                    {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
                  </select>
                ) : <span className="muted small">—</span>}
                <span className="grow" />
                {confirmDel === ref(t) ? (
                  <>
                    <button className="btn icon-danger small" disabled={busy} onClick={() => void del(t)}>Delete?</button>
                    <button className="btn small" disabled={busy} onClick={() => setConfirmDel(null)}>×</button>
                  </>
                ) : (
                  <button className="btn icon-danger small" disabled={busy} title="Delete task" onClick={() => setConfirmDel(ref(t))}>✕</button>
                )}
              </div>
              <div className="muted" style={{ marginTop: 3, display: 'flex', gap: 9, flexWrap: 'wrap', fontSize: 10.5, opacity: 0.85 }}>
                <span title={cAbs ? `created ${cAbs}` : undefined}>⊕ created {ago(t.createdAt)} ago</span>
                {working && t.updatedAt ? <span style={{ color: '#3ccb78' }} title={uAbs ? `active since ${uAbs}` : undefined}>▶ working {ago(t.updatedAt)}</span> : null}
                {phase === 'done' && (t.completedAt || t.updatedAt) ? <span title={dAbs ? `completed ${dAbs}` : undefined}>✓ done {ago(t.completedAt ?? t.updatedAt)} ago</span> : null}
                {phase === 'todo' && t.ownerName ? <span title="assigned but not started yet">◴ queued</span> : null}
              </div>
            </div>
            );
          };
          const laneCol = (lane: { id: Lane; label: string }) => {
            const items = filtered.filter((t) => laneOf(t) === lane.id);
            return (
              <div
                key={lane.id}
                className="kanban-col"
                style={{ flex: '1 1 0', minWidth: 124, background: 'var(--bg, #141414)', border: `1px solid ${dragRef ? 'var(--accent, #6aa8ff)' : 'var(--border, #2a2a2a)'}`, borderRadius: 6, padding: 6 }}
                onDragOver={(e) => { if (dragRef) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); const r = dragRef || e.dataTransfer.getData('text/plain'); const t = tasks.find((x) => ref(x) === r); if (t) void moveToLane(t, lane.id); setDragRef(null); }}
              >
                <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <b className="small">{lane.label}</b>
                  <span className="muted small">{items.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 40 }}>
                  {items.map(card)}
                  {items.length === 0 ? (
                    lane.id === 'done' && !showArchived && archivedCount > 0
                      ? <button className="btn small" style={{ width: '100%' }} title="Completed tasks auto-archive to keep the board clean — click to reveal them" onClick={() => setShowArchived(true)}>🗄 {archivedCount} archived · show</button>
                      : <div className="muted small center" style={{ padding: '8px 0' }}>—</div>
                  ) : null}
                </div>
              </div>
            );
          };
          // full → width:100% (the Adjustment band); grow → flex weight so the bottom
          // row sizes Waiting:Main = 1:2 (i.e. ⅓ and ⅔ of the Adjustment band's width).
          const groupBox = (g: { title: string; lanes: { id: Lane; label: string }[] }, opts: { full?: boolean; grow?: number } = {}) => {
            const sizing: CSSProperties = opts.full
              ? { width: '100%' }
              : opts.grow
                ? { flex: `${opts.grow} 1 0`, minWidth: 0 }
                : { flexShrink: 0 };
            return (
              <div key={g.title} className="kanban-group" style={{ border: '1px solid var(--border, #2a2a2a)', borderRadius: 8, padding: 8, background: 'var(--panel, #1b1b1b)', ...sizing }}>
                <div className="muted small b" style={{ marginBottom: 6 }}>{g.title}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  {g.lanes.map(laneCol)}
                </div>
              </div>
            );
          };
          // Adjustment Loop is a full-width band on top; below it Waiting (⅓) + Main Flow (⅔).
          const adjust = LANE_GROUPS.find((g) => g.title === 'Adjustment Loop');
          const flow = LANE_GROUPS.filter((g) => g.title !== 'Adjustment Loop');
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {adjust ? (
                <div className="kanban-groups" style={{ display: 'flex', overflowX: 'auto' }}>
                  {groupBox(adjust, { full: true })}
                </div>
              ) : null}
              <div className="kanban-groups" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto' }}>
                {flow.map((g) => groupBox(g, { grow: g.title === 'Main Flow' ? 2 : 1 }))}
              </div>
            </div>
          );
        })()}
        {tasks.length === 0 ? <p className="muted center pad">No tasks. Create one with “+ New task”, or “⚡ Assign work to fleet”.</p> : null}
      </section>
    </>
  );
}
