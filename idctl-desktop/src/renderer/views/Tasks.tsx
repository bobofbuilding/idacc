import { useEffect, useState } from 'react';
import { call, resolveCoordinator, type FleetStore } from '../store.ts';
import { usePrompt } from '../components/prompt.tsx';
import type { Task } from '../../../../idctl/src/api/types.ts';
import { Schedule } from './Schedule.tsx';
import { Loops } from './Loops.tsx';
import { Plans } from './Plans.tsx';

// Auto-decompose IPC shapes (mirror main/work.ts).
type SubTask = { title: string; description: string; agent: string; dependsOn: number[] };
type DecomposeResult = { ok: boolean; subtasks: SubTask[]; raw: string; error?: string };
type CreatedTask = { idx: number; ref: string; title: string; agent: string; ok: boolean; error?: string; dependsOn: number[]; dispatched: boolean };
type CreatePlanResult = { created: CreatedTask[]; dispatched: number; deferred: number };

type Tab = 'tasks' | 'plans' | 'schedule' | 'loops';
const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'plans', label: 'Plans' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'loops', label: 'Loops' },
];

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
function statusClass(s: string): string {
  if (/done|complete/i.test(s)) return 'ok-text';
  if (/doing|claim|progress|start/i.test(s)) return 'warn-text';
  return 'muted';
}
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

/** Tabbed wrapper: Tasks + Schedule + Loops in one page. */
export function Tasks({ store, initialTab }: { store: FleetStore; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = (initialTab || localStorage.getItem('idctl.tasks.tab') || 'tasks') as Tab;
      return TABS.some((x) => x.id === t) ? t : 'tasks'; // ignore stale/garbage values
    } catch { return 'tasks'; }
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
    </div>
  );
}

function TasksPanel({ store }: { store: FleetStore }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'done'>('open');
  const [hideRoutine, setHideRoutine] = useState(true);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Auto-decompose: describe an objective → lead splits it → create + farm out.
  const [showAssign, setShowAssign] = useState(false);
  const [objective, setObjective] = useState('');
  const [lead, setLead] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<SubTask[] | null>(null);
  const [assignNote, setAssignNote] = useState('');
  const prompt = usePrompt();

  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const leadName = lead && store.agents.some((a) => a.name === lead) ? lead : coordinator;

  async function reload() {
    try {
      const t = await call<Task[]>('tasks');
      setTasks([...t].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
    } catch {
      setTasks([]);
    }
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.team, store.lastUpdated]);

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
  function markDone(t: Task) { void run(`/task done ${ref(t)}`, `complete ${ref(t)}`); }
  function reopen(t: Task) { void run(`/task status ${ref(t)} todo`, `reopen ${ref(t)}`); }
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
    try {
      const res = await call<CreatePlanResult>('work:createPlan', objective.trim(), proposal);
      const okCount = res.created.filter((c) => c.ok).length;
      const failed = res.created.length - okCount;
      setAssignNote(`created ${okCount} task${okCount === 1 ? '' : 's'} · dispatched ${res.dispatched} now${res.deferred ? ` · ${res.deferred} queued on deps` : ''}${failed ? ` · ${failed} failed` : ''} ✓`);
      setProposal(null); setObjective(''); setShowAssign(false);
      await reload();
    } catch (err) {
      setAssignNote(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProposing(false);
    }
  }

  const routineCount = tasks.filter(isRoutine).length;
  const openCount = tasks.filter((t) => !isDone(t)).length;
  const doneCount = tasks.filter(isDone).length;
  const filtered = tasks.filter((t) => {
    if (hideRoutine && isRoutine(t)) return false;
    if (statusFilter === 'open' && isDone(t)) return false;
    if (statusFilter === 'done' && !isDone(t)) return false;
    const s = q.trim().toLowerCase();
    return !s || t.title.toLowerCase().includes(s) || (t.ownerName ?? '').toLowerCase().includes(s) || ref(t).toLowerCase().includes(s);
  });

  return (
    <>
      <div className="row-actions" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="muted small">{openCount} open · {doneCount} done</span>
        <span className="grow" />
        {doneCount > 0 ? (
          confirmClear ? (
            <>
              <button className="btn icon-danger" disabled={busy} onClick={() => void clearDone()}>Clear {doneCount} done?</button>
              <button className="btn" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setConfirmClear(true)}>Clear completed</button>
          )
        ) : null}
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
                {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </b>
            <span>objective</span>
            <b><textarea style={{ width: '100%', minHeight: 64 }} placeholder="e.g. “Ship a /status page: API endpoint, React widget, tests, and docs.”" value={objective} disabled={proposing} onChange={(e) => setObjective(e.target.value)} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10, alignItems: 'center' }}>
            {assignNote ? <span className={`small ${/failed|could not|no agent/.test(assignNote) ? 'status-error' : 'muted'}`}>{assignNote}</span> : null}
            <span className="grow" />
            {proposal ? <button className="btn" disabled={proposing} onClick={() => { setProposal(null); setAssignNote(''); }}>Discard</button> : null}
            {!proposal ? (
              <button className="btn primary" disabled={proposing || !objective.trim()} onClick={() => void decompose()}>{proposing ? 'Planning…' : 'Decompose into tasks'}</button>
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
                    {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                  <button className="btn icon-danger small" disabled={proposing} title="Remove this sub-task" onClick={() => removeSub(i)}>✕</button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card grow">
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <input className="catalog-search" placeholder="search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="chips">
            {(['all', 'open', 'done'] as const).map((s) => (
              <button key={s} className={`chip${statusFilter === s ? ' on' : ''}`} onClick={() => setStatusFilter(s)}>{s}</button>
            ))}
          </span>
          <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={hideRoutine} onChange={(e) => setHideRoutine(e.target.checked)} />
            hide routine{routineCount ? ` (${routineCount})` : ''}
          </label>
          <span className="grow" />
          {note ? <span className={`small ${/failed/.test(note) ? 'status-error' : 'muted'}`}>{note}</span> : null}
        </div>

        <table className="grid">
          <thead>
            <tr><th>Task</th><th>Status</th><th>Owner</th><th>Age</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={ref(t)}>
                <td>
                  <div className="b">{t.title}</div>
                  <div className="muted small mono">{t.shortId ?? ref(t)}{isRoutine(t) ? ' · routine' : ''}</div>
                </td>
                <td className={`small ${statusClass(t.status)}`}>{t.status}</td>
                <td>
                  {t.ownerName ? (
                    <span className="muted small">{t.ownerName}</span>
                  ) : isDone(t) ? (
                    <span className="muted small">—</span>
                  ) : (
                    <select className="cell-select" defaultValue="" disabled={busy} onChange={(e) => assign(t, e.target.value)}>
                      <option value="">assign…</option>
                      {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  )}
                </td>
                <td className="muted small" title={t.createdAt ? new Date((t.createdAt < 1e12 ? t.createdAt * 1000 : t.createdAt)).toLocaleString() : undefined}>{ago(t.createdAt)}</td>
                <td className="row-actions">
                  {isDone(t) ? (
                    <button className="btn" disabled={busy} onClick={() => reopen(t)}>Reopen</button>
                  ) : (
                    <button className="btn" disabled={busy} onClick={() => markDone(t)}>Done</button>
                  )}
                  {confirmDel === ref(t) ? (
                    <>
                      <button className="btn icon-danger" disabled={busy} onClick={() => void del(t)}>Delete?</button>
                      <button className="btn" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn icon-danger" disabled={busy} title="Delete task" onClick={() => setConfirmDel(ref(t))}>✕</button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr><td colSpan={5} className="muted center pad">{tasks.length === 0 ? 'No tasks. Create one with “+ New task”.' : 'No tasks match the current filter.'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
