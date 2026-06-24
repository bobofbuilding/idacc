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
  const [depsOverlay, setDepsOverlay] = useState<Record<string, string[]>>({}); // ref → prerequisite refs (app-side; manager has no deps)
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Auto-decompose: describe an objective → lead splits it → create + farm out.
  const [showAssign, setShowAssign] = useState(false);
  const [objective, setObjective] = useState('');
  const [lead, setLead] = useState('');
  const [workTeam, setWorkTeam] = useState(''); // team this Assign/Triage panel acts on (decoupled from the global team)
  // The fold-out creates several kinds of work, not just an auto-decomposed plan.
  const [mode, setMode] = useState<'plan' | 'assign' | 'schedule' | 'loop' | 'dream'>('plan');
  const [schedTarget, setSchedTarget] = useState('');       // single-agent target (schedule/loop/dream)
  const [assignTo, setAssignTo] = useState<Set<string>>(new Set()); // multi-agent target (assignment)
  const [taskDesc, setTaskDesc] = useState('');             // assignment description / details
  const [schedKind, setSchedKind] = useState<'interval' | 'calendar'>('interval');
  const [everyMin, setEveryMin] = useState(30);             // interval cadence (minutes)
  const [calTime, setCalTime] = useState('09:00');
  const [calDays, setCalDays] = useState('mon,tue,wed,thu,fri');
  const [delivery, setDelivery] = useState<'internal' | 'talk'>('talk');
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

  // Teams with ≥1 running agent (idle teams hidden from the work-team picker).
  const ACTIVE_RE = /stop|offline|dead|exit|error|crash|down|disabled|sleep/i;
  const activeTeams = store.teams.map((t) => t.name).filter((n) => n && store.allAgents.some((a) => a.team === n && !!a.status && !ACTIVE_RE.test(a.status)));
  // The Assign/Triage panel acts on a CHOSEN team — independent of the global active team.
  useEffect(() => {
    setWorkTeam((cur) => {
      if (cur && activeTeams.includes(cur)) return cur;
      if (store.team && activeTeams.includes(store.team)) return store.team;
      return activeTeams[0] ?? store.team ?? 'default';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeams.join(','), store.team]);
  const activeTeam = workTeam || store.team || 'default';
  const teamAgents = store.allAgents.filter((a) => a.team === activeTeam);
  const coordinator = resolveCoordinator(teamAgents, activeTeam === store.team ? store.coordinator : undefined) ?? teamAgents[0]?.name ?? '';
  const leadName = lead && teamAgents.some((a) => a.name === lead) ? lead : coordinator;
  const otherTeams = store.teams.map((t) => t.name).filter((n) => n && n !== activeTeam);
  const activeTeamAgents = teamAgents.filter((a) => liveAgent(a.status)); // routable members of the chosen team
  // Keep the single-agent target (schedule/loop/dream) valid as the team changes.
  useEffect(() => {
    setSchedTarget((cur) => (cur && teamAgents.some((a) => a.name === cur) ? cur : (leadName || teamAgents[0]?.name || '')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, teamAgents.length, leadName]);

  // When the panel opens, fetch which other teams have an active lead (who can take work now).
  useEffect(() => {
    if (!showAssign || !otherTeams.length) { setTeamInfo([]); return; }
    let live = true;
    call<TeamLead[]>('work:teamLeads', otherTeams).then((r) => { if (live) setTeamInfo(r); }).catch(() => { if (live) setTeamInfo([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAssign, activeTeam, store.teams.length]);

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
      // Holistic "All teams" → every team's tasks (tagged with teamName); else the active team.
      const t = await call<Task[]>(store.viewAll ? 'tasks:allTeams' : 'tasks');
      setTasks([...t].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
    } catch {
      setTasks([]);
    }
    setLaneOverlay(await call<Record<string, string>>('tasks:lanes').catch(() => ({})));
    setDepsOverlay(await call<Record<string, string[]>>('tasks:deps').catch(() => ({})));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.viewAll, store.lastUpdated]);
  // Auto-refresh the board so it stays live as agents claim/complete work.
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.viewAll]);
  // In holistic mode each per-task action must hit the task's OWN team.
  const taskTeam = (t: Task): string | undefined => (store.viewAll ? t.teamName : undefined);

  // A task's effective lane: its overlay lane if that still matches the manager status,
  // else the default lane for the real status (so an agent's status change wins).
  function laneOf(t: Task): Lane {
    const ov = laneOverlay[ref(t)] as Lane | undefined;
    if (ov && LANE_STATUS[ov] === colOf(t.status)) return ov;
    return DEFAULT_LANE[colOf(t.status)];
  }
  // Resolve a task's prerequisites from the app-side deps overlay (the manager has none).
  // A missing prereq (removed task) counts as satisfied so nothing blocks forever.
  const taskIndex = new Map(tasks.map((t) => [ref(t), t] as const));
  function prereqsOf(t: Task): { ref: string; task?: Task; done: boolean }[] {
    return (depsOverlay[ref(t)] ?? []).map((r) => { const d = taskIndex.get(r); return { ref: r, task: d, done: d ? isDone(d) : true }; });
  }
  // How many (live) tasks list THIS task as a prerequisite.
  function blocksCount(t: Task): number {
    const r = ref(t);
    return Object.keys(depsOverlay).filter((k) => depsOverlay[k]?.includes(r) && taskIndex.has(k)).length;
  }
  // Drag a card to a lane → save the lane overlay + set the mapped manager status if it changed.
  async function moveToLane(t: Task, lane: Lane) {
    if (laneOf(t) === lane) return;
    const targetStatus = LANE_STATUS[lane];
    setBusy(true); setNote(`move ${ref(t)} → ${lane.replace(/-/g, ' ')}…`);
    try {
      await call('tasks:setLane', ref(t), lane);
      if (colOf(t.status) !== targetStatus) await call('remote', `/task status ${ref(t)} ${targetStatus}`, undefined, taskTeam(t));
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
    const pending = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo' && (!store.viewAll || t.teamName === activeTeam));
    if (!pending.length) { if (!silent) setNote(`no unassigned To Do tasks in ${activeTeam}`); return; }
    setTriaging(true);
    lastTriageRef.current = Date.now();
    const t = toast({ kind: 'progress', text: `${leadName} is triaging ${pending.length} unassigned To Do task${pending.length === 1 ? '' : 's'}…` });
    try {
      const res = await call<TriageResult>('work:triage', leadName, activeTeam);
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
    const pending = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo' && (!store.viewAll || t.teamName === activeTeam)).length;
    if (!pending || Date.now() - lastTriageRef.current < 90_000) return;
    void triage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriage, tasks, triaging]);

  // Re-send a stalled task to its owner (reassigning to an active agent first if the owner is
  // stopped) so a stuck "doing" task gets picked back up. Returns false if nothing's active.
  // A stalled task isn't progressing on its current owner — and the owner can be WEDGED even
  // while it still reports "running". So re-dispatch hands the task to a DIFFERENT active agent
  // whenever one exists (load-balanced via `load`), only falling back to the same owner if it's
  // the lone active agent. Returns false if no agent in the team is active.
  function pickRedispatchTarget(t: Task, load: Record<string, number>): string | null {
    const pool = store.viewAll ? store.allAgents.filter((a) => a.team === t.teamName) : store.agents;
    const active = pool.filter((a) => liveAgent(a.status));
    if (!active.length) return null;
    const others = active.filter((a) => a.name !== t.ownerName);
    const cands = others.length ? others : active; // prefer someone other than the stuck owner
    const target = cands.reduce((a, b) => ((load[b.name] ?? 0) < (load[a.name] ?? 0) ? b : a), cands[0]);
    load[target.name] = (load[target.name] ?? 0) + 1;
    return target.name;
  }
  async function redispatchCore(t: Task, load: Record<string, number>): Promise<boolean> {
    const tteam = taskTeam(t);
    const target = pickRedispatchTarget(t, load);
    if (!target) return false;
    if (target !== t.ownerName) await call('remote', `/task assign ${ref(t)} ${target}`, undefined, tteam);
    const msg = `Resume and complete task ${ref(t)}: ${t.title}. ${t.description ?? ''} When finished: /task done ${ref(t)}. If you're blocked, mark it done with a brief note.`;
    await call('remote', `/ask ${target} ${qArg(msg)}`, undefined, tteam); // returns once accepted (queryId); agent runs in background
    return true;
  }
  async function redispatch(t: Task) {
    const tt = toast({ kind: 'progress', text: `Re-dispatching ${ref(t)}…` });
    try {
      const ok = await redispatchCore(t, {});
      tt.update(ok ? { kind: 'success', text: `re-dispatched ${ref(t)} ✓` } : { kind: 'error', text: 'no active agent to take this task' });
      if (ok) await reload();
    } catch (e) { tt.update({ kind: 'error', text: `re-dispatch failed: ${e instanceof Error ? e.message : String(e)}` }); }
  }
  async function redispatchAll() {
    if (!stalledTasks.length) return;
    const tt = toast({ kind: 'progress', text: `Re-dispatching ${stalledTasks.length} stalled task${stalledTasks.length === 1 ? '' : 's'}…` });
    let ok = 0;
    const load: Record<string, number> = {}; // shared so the batch spreads across active agents
    for (const t of stalledTasks) { try { if (await redispatchCore(t, load)) ok++; } catch { /* keep going */ } }
    tt.update({ kind: ok ? 'success' : 'error', text: `re-dispatched ${ok}/${stalledTasks.length} stalled ✓` });
    await reload();
  }

  async function run(cmd: string, label: string, team?: string) {
    setBusy(true);
    setNote(`${label}…`);
    try {
      await call('remote', cmd, undefined, team);
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
    if (agent) void run(`/task assign ${ref(t)} ${agent}`, `assign ${ref(t)} → ${agent}`, taskTeam(t));
  }
  async function del(t: Task) { setConfirmDel(null); await run(`/task remove ${ref(t)}`, `delete ${ref(t)}`, taskTeam(t)); }
  async function clearDone() {
    const done = tasks.filter(isDone);
    setConfirmClear(false);
    setBusy(true);
    setNote(`clearing ${done.length} completed…`);
    try {
      for (const t of done) await call('remote', `/task remove ${ref(t)}`, undefined, taskTeam(t));
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
      const res = await call<DecomposeResult>('work:decompose', obj, leadName, activeTeam);
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
      const res = await call<CreatePlanResult>('work:createPlan', objective.trim(), proposal, { team: activeTeam });
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

  // ── Direct assignment: create the task(s) owned by the chosen agent(s) + dispatch now
  //    (no decomposition; respectOwners keeps the exact owners). ──────────────────────
  async function createAssignment() {
    const title = objective.trim();
    const agents = [...assignTo].filter(Boolean);
    if (!title || !agents.length) { setAssignNote('enter a task and pick at least one agent'); return; }
    setProposing(true);
    const t = toast({ kind: 'progress', text: `Assigning “${title.slice(0, 40)}” to ${agents.join(', ')}…` });
    try {
      const subtasks = agents.map((a) => ({ title, description: taskDesc.trim(), agent: a, dependsOn: [] as number[] }));
      const res = await call<CreatePlanResult>('work:createPlan', title, subtasks, { team: activeTeam, dispatch: true, respectOwners: true });
      const ok = res.created.filter((c) => c.ok).length;
      t.update({ kind: ok ? 'success' : 'error', text: `${activeTeam}: assigned ${ok}/${agents.length} · dispatched ${res.dispatched}` });
      setAssignNote(`assigned to ${agents.join(', ')} ✓`);
      setObjective(''); setTaskDesc(''); setAssignTo(new Set()); setShowAssign(false);
      await reload();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.update({ kind: 'error', text: `Assign failed: ${m}` }); setAssignNote(`assign failed: ${m}`);
    } finally { setProposing(false); }
  }

  // ── Schedule / Loop / Dream: all ride the manager's /schedule heartbeat+calendar
  //    surface. Loop = recurring objective continuation; Dream = slow idle aspiration;
  //    both wake the agent internally (self-directed), a plain Schedule pings/talks. ──
  function intervalLabel(min: number): string {
    if (min < 60) return `${min}m`;
    if (min % 60 === 0) return `${min / 60}h`;
    return `${Math.floor(min / 60)}h${min % 60}m`;
  }
  async function createSchedule() {
    const msg = objective.trim();
    if (!schedTarget || !msg) { setAssignNote('pick an agent and enter the check-in message'); return; }
    setProposing(true);
    const cadence = schedKind === 'interval' ? `every ${intervalLabel(everyMin)}` : `${calDays} @ ${calTime}`;
    const t = toast({ kind: 'progress', text: `Scheduling ${schedTarget} (${cadence})…` });
    try {
      if (schedKind === 'interval') await call('addHeartbeat', schedTarget, everyMin * 60, msg, delivery, activeTeam);
      else await call('addCalendarCheckin', schedTarget, calTime, calDays, msg, { delivery }, activeTeam);
      t.update({ kind: 'success', text: `Scheduled ${schedTarget} · ${cadence} → see the Schedule tab` });
      setAssignNote(`scheduled ${schedTarget} ${cadence} ✓`); setObjective(''); setShowAssign(false);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.update({ kind: 'error', text: `Schedule failed: ${m}` }); setAssignNote(`schedule failed: ${m}`);
    } finally { setProposing(false); }
  }
  async function createLoop() {
    const obj = objective.trim();
    if (!schedTarget || !obj) { setAssignNote('pick an agent and describe the loop objective'); return; }
    setProposing(true);
    const t = toast({ kind: 'progress', text: `Starting loop on ${schedTarget} (every ${intervalLabel(everyMin)})…` });
    try {
      const msg = `Loop cycle (repeats every ${intervalLabel(everyMin)}). Continue this standing objective: ${obj}. Review what's already done, do the next concrete increment, update any related tasks, and briefly report progress. If it's fully complete, say so.`;
      await call('addHeartbeat', schedTarget, everyMin * 60, msg, 'internal', activeTeam);
      t.update({ kind: 'success', text: `Loop running on ${schedTarget} every ${intervalLabel(everyMin)} → Schedule tab` });
      setAssignNote(`loop started on ${schedTarget} ✓`); setObjective(''); setShowAssign(false);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.update({ kind: 'error', text: `Loop failed: ${m}` }); setAssignNote(`loop failed: ${m}`);
    } finally { setProposing(false); }
  }
  async function createDream() {
    const vision = objective.trim();
    if (!schedTarget || !vision) { setAssignNote('pick an agent and describe the aspiration'); return; }
    setProposing(true);
    const t = toast({ kind: 'progress', text: `Setting a dream for ${schedTarget}…` });
    try {
      const msg = `Dream — a standing background aspiration, no deadline (revisited every ${intervalLabel(everyMin)}): ${vision}. When you have spare capacity between assigned tasks, take ONE small concrete step toward it and note what you did. Never let this preempt assigned work.`;
      await call('addHeartbeat', schedTarget, everyMin * 60, msg, 'internal', activeTeam);
      t.update({ kind: 'success', text: `Dream set for ${schedTarget} (revisited every ${intervalLabel(everyMin)}) → Schedule tab` });
      setAssignNote(`dream set for ${schedTarget} ✓`); setObjective(''); setShowAssign(false);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.update({ kind: 'error', text: `Dream failed: ${m}` }); setAssignNote(`dream failed: ${m}`);
    } finally { setProposing(false); }
  }

  const routineCount = tasks.filter(isRoutine).length;
  const openCount = tasks.filter((t) => !isDone(t)).length;
  const doneCount = tasks.filter(isDone).length;
  // Unassigned To-Do tasks the lead can triage/assign. Triage runs on the ACTIVE team's lead,
  // so in holistic view the count is scoped to the active team (avoids a misleading total).
  const unassignedTodo = tasks.filter((t) => !t.ownerName && laneOf(t) === 'todo' && (!store.viewAll || t.teamName === activeTeam)).length;
  // Owned "doing" tasks with no status change in 30m+ → stalled (re-dispatchable).
  const stalledTasks = tasks.filter((t) => {
    if (colOf(t.status) !== 'doing' || !t.ownerName) return false;
    const up = t.updatedAt ? (t.updatedAt < 1e12 ? t.updatedAt * 1000 : t.updatedAt) : 0;
    return up > 0 && Date.now() - up > 30 * 60 * 1000;
  });
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
        {stalledTasks.length ? <button className="btn" disabled={busy} title={`Re-dispatch the ${stalledTasks.length} stalled task${stalledTasks.length === 1 ? '' : 's'} (no update in 30m+) to active agents`} onClick={() => void redispatchAll()}>↻ Re-dispatch stalled ({stalledTasks.length})</button> : null}
        <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Keep the lead auto-assigning new unassigned To Do tasks (checked every poll, throttled ~90s)">
          <input type="checkbox" checked={autoTriage} onChange={(e) => setAutoTriage(e.target.checked)} />
          auto
        </label>
        <button className="btn" disabled={busy} title="Ask the lead to surface task blockers that need YOUR decision → they appear as option-questions in the Inbox" onClick={() => void surfaceBlockers()}>⚠ Surface blockers</button>
        <button className="btn" disabled={busy || proposing} title="Create work: auto-plan, direct assignment, schedule, loop, or dream" onClick={() => { setShowAssign((v) => !v); setAssignNote(''); setProposal(null); }}>{showAssign ? '− Close' : '⚡ Create work'}</button>
        <button className="btn primary" disabled={busy} onClick={() => void newTask()}>+ New task</button>
      </div>

      {showAssign ? (
        <section className="card" style={{ marginBottom: 10 }}>
          {(() => {
            const META: Record<string, { title: string; hint: string }> = {
              plan: { title: 'Plan — auto-decompose an objective', hint: `Describe an objective. ${leadName || 'The lead'} breaks it into sub-tasks, each owned by the best-suited active agent — independents run in parallel, dependents follow their prerequisites.` },
              assign: { title: 'Assignment — hand a task to specific agent(s)', hint: 'Create one task per chosen agent and dispatch it now — no decomposition, the owner you pick is kept exactly.' },
              schedule: { title: 'Schedule — recurring check-in', hint: 'Wake an agent on a cadence (interval or calendar days/time) with a message. Use “talk” to ping you, “internal” for a self-directed nudge. Appears in the Schedule tab.' },
              loop: { title: 'Loop — repeat an objective on a cadence', hint: 'The agent re-runs a standing objective every interval (internal wake): review → next increment → report. Pause/stop it anytime in the Schedule tab.' },
              dream: { title: 'Dream — a slow background aspiration', hint: 'A no-deadline goal the agent advances in spare cycles between assigned work. Revisited on a slow cadence; never preempts real tasks.' },
            };
            const m = META[mode];
            return (<>
              <h3 style={{ marginTop: 0 }}>{m.title}</h3>
              <div className="row-actions" style={{ gap: 6, marginBottom: 8 }}>
                {(['plan', 'assign', 'schedule', 'loop', 'dream'] as const).map((id) => (
                  <button key={id} className={`btn small${mode === id ? ' primary' : ''}`} disabled={proposing}
                    onClick={() => { setMode(id); setProposal(null); setAssignNote(''); if (id === 'dream' && everyMin < 120) setEveryMin(360); if (id === 'loop' && everyMin > 120) setEveryMin(30); if (id === 'schedule') setDelivery('talk'); }}>
                    {id === 'plan' ? '◳ Plan' : id === 'assign' ? '☑ Assign' : id === 'schedule' ? '🕑 Schedule' : id === 'loop' ? '↻ Loop' : '✸ Dream'}
                  </button>
                ))}
              </div>
              <p className="muted small" style={{ marginTop: -2 }}>{m.hint}</p>
            </>);
          })()}
          <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 12px', alignItems: 'start' }}>
            <span>team</span>
            <b>
              <select className="cell-select" value={activeTeam} disabled={proposing} onChange={(e) => { setWorkTeam(e.target.value); setLead(''); setAssignTo(new Set()); }}>
                {(activeTeams.length ? activeTeams : [activeTeam]).map((t) => <option key={t} value={t}>{t}{t === store.team ? ' (active)' : ''}</option>)}
              </select>
            </b>

            {mode === 'plan' ? (<>
              <span>lead</span>
              <b>
                <select className="cell-select" value={leadName} disabled={proposing} onChange={(e) => setLead(e.target.value)}>
                  {teamAgents.map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
                </select>
              </b>
            </>) : null}

            {mode === 'assign' ? (<>
              <span>agents</span>
              <b style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(activeTeamAgents.length ? activeTeamAgents : teamAgents).map((a) => (
                  <label key={a.id} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '2px 8px', opacity: liveAgent(a.status) ? 1 : 0.5, cursor: proposing ? 'default' : 'pointer' }}>
                    <input type="checkbox" disabled={proposing || !liveAgent(a.status)} checked={assignTo.has(a.name)}
                      onChange={(e) => setAssignTo((prev) => { const n = new Set(prev); if (e.target.checked) n.add(a.name); else n.delete(a.name); return n; })} />
                    {a.name}{liveAgent(a.status) ? '' : ' · stopped'}
                  </label>
                ))}
                {activeTeamAgents.length ? <button className="btn small" disabled={proposing} onClick={() => setAssignTo(new Set(activeTeamAgents.map((a) => a.name)))}>all active</button> : null}
              </b>
            </>) : null}

            {mode === 'schedule' || mode === 'loop' || mode === 'dream' ? (<>
              <span>agent</span>
              <b>
                <select className="cell-select" value={schedTarget} disabled={proposing} onChange={(e) => setSchedTarget(e.target.value)}>
                  {teamAgents.map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
                </select>
              </b>
            </>) : null}

            {/* cadence: interval for loop/dream + schedule-interval; calendar option for schedule */}
            {mode === 'schedule' ? (<>
              <span>cadence</span>
              <b className="row-actions" style={{ gap: 6 }}>
                <button className={`btn small${schedKind === 'interval' ? ' primary' : ''}`} disabled={proposing} onClick={() => setSchedKind('interval')}>interval</button>
                <button className={`btn small${schedKind === 'calendar' ? ' primary' : ''}`} disabled={proposing} onClick={() => setSchedKind('calendar')}>calendar</button>
              </b>
            </>) : null}

            {(mode === 'loop' || mode === 'dream' || (mode === 'schedule' && schedKind === 'interval')) ? (<>
              <span>every</span>
              <b style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <input type="number" min={1} value={everyMin} disabled={proposing} onChange={(e) => setEveryMin(Math.max(1, Number(e.target.value) || 1))} style={{ width: 72 }} /> min
                {[15, 30, 60, 120, 360, 720, 1440].map((mm) => <button key={mm} className="btn small" disabled={proposing} onClick={() => setEveryMin(mm)}>{intervalLabel(mm)}</button>)}
              </b>
            </>) : null}

            {mode === 'schedule' && schedKind === 'calendar' ? (<>
              <span>when</span>
              <b style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input type="time" value={calTime} disabled={proposing} onChange={(e) => setCalTime(e.target.value)} />
                <input type="text" value={calDays} disabled={proposing} placeholder="mon,tue,… or YYYY-MM-DD" onChange={(e) => setCalDays(e.target.value)} style={{ width: 200 }} />
              </b>
            </>) : null}

            {mode === 'schedule' ? (<>
              <span>delivery</span>
              <b className="row-actions" style={{ gap: 6 }}>
                <button className={`btn small${delivery === 'talk' ? ' primary' : ''}`} disabled={proposing} onClick={() => setDelivery('talk')} title="ping you / external message">talk</button>
                <button className={`btn small${delivery === 'internal' ? ' primary' : ''}`} disabled={proposing} onClick={() => setDelivery('internal')} title="self-directed wake-up (no message to you)">internal</button>
              </b>
            </>) : null}

            <span>{mode === 'assign' ? 'task' : mode === 'schedule' ? 'message' : mode === 'dream' ? 'aspiration' : 'objective'}</span>
            <b><textarea style={{ width: '100%', minHeight: 60 }} disabled={proposing}
              placeholder={mode === 'assign' ? 'e.g. “Add a /healthz endpoint with a test.”' : mode === 'schedule' ? 'e.g. “Post a 1-line status of open PRs.”' : mode === 'loop' ? 'e.g. “Keep the docs in sync with the API.”' : mode === 'dream' ? 'e.g. “Make our test suite the fastest in the org.”' : 'e.g. “Ship a /status page: API endpoint, React widget, tests, and docs.”'}
              value={objective} onChange={(e) => setObjective(e.target.value)} /></b>

            {mode === 'assign' ? (<>
              <span>details</span>
              <b><textarea style={{ width: '100%', minHeight: 44 }} disabled={proposing} placeholder="optional — extra context / acceptance criteria" value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} /></b>
            </>) : null}
          </div>

          {mode === 'plan' && !proposal && otherTeams.length ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 5 }}>⇄ Or fan this objective out to other teams — each team's <b>active lead</b> runs it independently (◷ teams with no running agent can't take work):</div>
              <div className="row-actions" style={{ gap: 6, marginBottom: 6 }}>
                <button className="btn small" disabled={proposing} title="Select every team that has a running lead (fan out to all team leads at once)" onClick={() => setFanTeams(new Set(teamInfo.filter((t) => t.activeCount > 0 && t.lead).map((t) => t.team)))}>★ All team leads</button>
                {fanTeams.size ? <button className="btn small" disabled={proposing} onClick={() => setFanTeams(new Set())}>clear</button> : null}
              </div>
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
            {mode === 'plan' ? (<>
              {proposal ? <button className="btn" disabled={proposing} onClick={() => { setProposal(null); setAssignNote(''); }}>Discard</button> : null}
              {!proposal && fanTeams.size ? (
                <button className="btn primary" disabled={proposing || !objective.trim()} onClick={() => void fanOut()}>{proposing ? 'Fanning out…' : `⇄ Fan out to ${fanTeams.size} team${fanTeams.size > 1 ? 's' : ''}`}</button>
              ) : null}
              {!proposal ? (
                <button className="btn primary" disabled={proposing || !objective.trim()} onClick={() => void decompose()}>{proposing ? 'Planning…' : `Decompose for ${activeTeam}`}</button>
              ) : (
                <button className="btn primary" disabled={proposing} onClick={() => void createPlan()}>{proposing ? 'Dispatching…' : `Create ${proposal.length} & dispatch`}</button>
              )}
            </>) : mode === 'assign' ? (
              <button className="btn primary" disabled={proposing || !objective.trim() || !assignTo.size} onClick={() => void createAssignment()}>{proposing ? 'Assigning…' : `☑ Assign to ${assignTo.size || ''} ${assignTo.size === 1 ? 'agent' : 'agents'} & dispatch`}</button>
            ) : mode === 'schedule' ? (
              <button className="btn primary" disabled={proposing || !objective.trim() || !schedTarget} onClick={() => void createSchedule()}>{proposing ? 'Scheduling…' : '🕑 Schedule'}</button>
            ) : mode === 'loop' ? (
              <button className="btn primary" disabled={proposing || !objective.trim() || !schedTarget} onClick={() => void createLoop()}>{proposing ? 'Starting…' : `↻ Start loop (every ${intervalLabel(everyMin)})`}</button>
            ) : (
              <button className="btn primary" disabled={proposing || !objective.trim() || !schedTarget} onClick={() => void createDream()}>{proposing ? 'Setting…' : '✸ Set dream'}</button>
            )}
          </div>

          {mode === 'plan' && proposal ? (
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
            const owned = phase === 'doing' && !!t.ownerName;    // assigned + in the doing state
            // updatedAt only changes on a status change, so "long in doing with no update" is a
            // strong stall signal — don't claim "working" when a task has sat untouched for 30m+.
            const upMs = t.updatedAt ? (t.updatedAt < 1e12 ? t.updatedAt * 1000 : t.updatedAt) : 0;
            const stale = owned && upMs > 0 && Date.now() - upMs > 30 * 60 * 1000;
            const working = owned && !stale;                     // recently moved to doing → plausibly active
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
              style={{ border: `1px solid ${working ? 'rgba(60,203,120,0.55)' : stale ? 'rgba(224,163,60,0.55)' : 'var(--border, #2a2a2a)'}`, borderRadius: 6, padding: '6px 8px', background: 'var(--bg, #141414)', cursor: busy ? 'default' : 'grab' }}
            >
              <div className="b" style={{ fontSize: 13 }}>{t.title}</div>
              <div className="muted small mono">{t.shortId ?? ref(t)}{isRoutine(t) ? ' · routine' : ''}{store.viewAll && t.teamName ? ` · ${t.teamName}` : ''}{(() => { const n = blocksCount(t); return n ? ` · blocks ${n}` : ''; })()}</div>
              {(() => {
                const pre = prereqsOf(t);
                if (!pre.length) return null;
                const blocked = !isDone(t) && pre.some((p) => !p.done);
                return (
                  <div className="small" style={{ marginTop: 2, color: blocked ? '#e0a33c' : 'var(--muted, #8a8a8a)' }}
                    title={`Depends on:\n${pre.map((p) => `${p.ref}${p.task ? ` · ${p.task.title}` : ' (removed)'} — ${p.done ? 'done' : 'pending'}`).join('\n')}${blocked ? '\n\nBlocked until the pending prerequisite(s) finish.' : ''}`}>
                    <span style={{ fontWeight: blocked ? 600 : 400 }}>{blocked ? '🔒 blocked · after ' : '⇢ after '}</span>
                    {pre.map((p, i) => (
                      <span key={p.ref}>{i ? ', ' : ''}<span className="mono">{p.ref}</span>{p.done ? ' ✓' : ' ⏳'}</span>
                    ))}
                  </div>
                );
              })()}
              <div className="row-actions" style={{ marginTop: 4, alignItems: 'center', gap: 6 }}>
                {working ? (
                  <span className="small" title={`${t.ownerName} recently picked this up${uAbs ? ` — moved to Doing ${uAbs}` : ''}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#3ccb78', background: 'rgba(60,203,120,0.13)', borderRadius: 10, padding: '1px 7px', fontWeight: 600 }}>
                    <span className="idctl-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: '#3ccb78', display: 'inline-block' }} />
                    {t.ownerName} · working
                  </span>
                ) : stale ? (
                  <span className="small" title={`${t.ownerName} has held this in Doing for ${ago(t.updatedAt)} with no status change — it may be stalled. Re-assign it, or drag it to Rework/To Do to re-dispatch.`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#e0a33c', background: 'rgba(224,163,60,0.13)', borderRadius: 10, padding: '1px 7px', fontWeight: 600 }}>
                    ⏳ {t.ownerName} · stalled {ago(t.updatedAt)}
                  </span>
                ) : t.ownerName ? (
                  <span className="muted small" title={phase === 'done' ? 'completed by this agent' : 'assigned, not yet started'}>{phase === 'done' ? '✓' : '◴'} {t.ownerName}</span>
                ) : !isDone(t) ? (
                  <select className="cell-select" style={{ fontSize: 11 }} defaultValue="" disabled={busy} onChange={(e) => assign(t, e.target.value)}>
                    <option value="">assign…</option>
                    {(store.viewAll ? store.allAgents.filter((a) => a.team === t.teamName) : store.agents).map((a) => <option key={a.id} value={a.name}>{a.name}{liveAgent(a.status) ? '' : ' · stopped'}</option>)}
                  </select>
                ) : <span className="muted small">—</span>}
                <span className="grow" />
                {stale ? <button className="btn small" disabled={busy} title={`Re-dispatch ${ref(t)} to ${t.ownerName} (it's stalled)`} onClick={(e) => { e.stopPropagation(); void redispatch(t); }}>↻</button> : null}
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
                {working && t.updatedAt ? <span style={{ color: '#3ccb78' }} title={uAbs ? `moved to Doing ${uAbs}` : undefined}>▶ in Doing {ago(t.updatedAt)}</span> : null}
                {stale ? <span style={{ color: '#e0a33c' }} title={uAbs ? `no status change since ${uAbs} — may be stalled` : undefined}>⏳ no update {ago(t.updatedAt)}</span> : null}
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
        {tasks.length === 0 ? <p className="muted center pad">No tasks. Create one with “+ New task”, or “⚡ Create work” (plan · assign · schedule · loop · dream).</p> : null}
      </section>
    </>
  );
}
