import { CalendarSchedule } from '../components/CalendarSchedule.tsx';
import { useEffect, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';
import { isDreamSchedule } from '../../shared/dreamSchedule.ts';
import { MAX_LOOP_STEPS } from '../../shared/loopLimits.ts';
import { reconcileScheduleSnapshot } from '../../shared/scheduleSnapshot.ts';
import { dispatchWorkToTeam } from './workDispatch.ts';

/**
 * Loops — recurring objectives the manager runs on a cadence (built on calendar
 * check-ins, so they run on cadence while the unified IDACC runtime is open).
 */

const CADENCES = [
  { label: 'every day', days: 'mon,tue,wed,thu,fri,sat,sun' },
  { label: 'weekdays', days: 'mon,tue,wed,thu,fri' },
  { label: 'weekends', days: 'sat,sun' },
  { label: 'weekly (Mon)', days: 'mon' },
];
const SCHEDULE_REFRESH_MS = 15_000;
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
type LoopField = 'title' | 'goal' | 'steps' | 'updatedAt';
type TeamSchedule = ScheduleEntry & { team?: string };

function scheduleStamp(schedule: ScheduleEntry): string {
  return JSON.stringify({
    active: schedule.active,
    targets: [...(schedule.targets || [])].sort(),
    localTimeSeconds: schedule.localTimeSeconds,
    localDate: schedule.localDate,
    daysOfWeek: schedule.daysOfWeek,
    timezone: schedule.timezone,
    message: schedule.message,
  });
}

function actionConversationId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function readSchedulesForTeam(team: string): Promise<TeamSchedule[]> {
  const [aggregateResult, localResult] = await Promise.allSettled([
    call<TeamSchedule[]>('schedules:allTeams'),
    call<ScheduleEntry[]>('schedules'),
  ]);
  const snapshot = reconcileScheduleSnapshot(
    aggregateResult.status === 'fulfilled' ? aggregateResult.value : null,
    localResult.status === 'fulfilled' ? localResult.value : null,
    team,
  );
  if (!snapshot) throw new Error('both Manager schedule reads failed');
  return snapshot.local;
}

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

function LoopBuilder({ store, onScheduled }: { store: FleetStore; onScheduled?: () => void }) {
  const loopSyncVersion = useSyncVersion(['loops', 'work', 'brain']);
  const team = store.team ?? 'default';
  const names = store.agents.map((a) => a.name);
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? names[0] ?? '';
  const [chains, setChains] = useState<LoopSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Loop | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [draftAgent, setDraftAgent] = useState('');
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [results, setResults] = useState<RunState[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Optional schedule — turns the chain into a Manager-run loop while the
  // unified IDACC runtime is running; its definition survives app restarts.
  const [scheduleOn, setScheduleOn] = useState(false);
  const [days, setDays] = useState('mon,tue,wed,thu,fri');
  const [time, setTime] = useState('09:00');
  const scheduleMutationRef = useRef(false);
  const builderActionRef = useRef(false);
  const reloadEpochRef = useRef(0);
  const designer = draftAgent && names.includes(draftAgent) ? draftAgent : coordinator;
  const locked = drafting || running || busy;

  async function reload() {
    const epoch = ++reloadEpochRef.current;
    try {
      const next = await call<LoopSummary[]>('loops:list', team);
      if (epoch === reloadEpochRef.current) setChains(next);
    } catch (error) {
      if (epoch === reloadEpochRef.current) {
        setMsg(`saved-loop refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  useEffect(() => {
    void reload();
    return () => { reloadEpochRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, loopSyncVersion]);

  function fix(s: LoopStep): LoopStep { return { agent: names.includes(s.agent) ? s.agent : coordinator, task: String(s.task || '').trim() }; }
  function validSteps(): LoopStep[] {
    return steps.map(fix).filter((s) => !!s.agent && !!s.task).slice(0, MAX_LOOP_STEPS);
  }
  const changedText = (before: string | number | undefined, after: string | number | undefined) => `${String(before ?? 'none')} -> ${String(after ?? 'none')}`;
  function stepsStamp(ss: LoopStep[]): string {
    return JSON.stringify(ss.map((s) => ({ agent: s.agent, task: s.task })));
  }
  function loopStamp(l: Loop): Record<LoopField, string | number | undefined> {
    return { title: l.title, goal: l.goal, steps: stepsStamp(l.steps ?? []), updatedAt: l.updatedAt };
  }
  async function ensureLoopFresh(action: string, fields: LoopField[] = ['updatedAt']): Promise<Loop | null> {
    if (!editingId) return null;
    const current = await call<Loop | null>('loops:get', editingId).catch(() => null);
    if (!current) {
      window.alert(`${action} blocked: this saved loop no longer exists.`);
      newChain();
      await reload();
      return null;
    }
    if (!baseline) return current;
    const before = loopStamp(baseline);
    const after = loopStamp(current);
    const changed = fields.filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
    if (changed.length) {
      window.alert([
        `${action} blocked: "${baseline.title}" changed since it was opened.`,
        '',
        ...changed.map((field) => `- ${field}: ${field === 'steps' ? 'changed' : changedText(before[field], after[field])}`),
        '',
        'The loop editor will refresh; review the current chain before applying another change.',
      ].join('\n'));
      setBaseline(current);
      setTitle(current.title);
      setGoal(current.goal);
      setSteps((current.steps || []).slice(0, MAX_LOOP_STEPS));
      setResults((current.lastResults || []).slice(0, MAX_LOOP_STEPS).map((r, i) => ({ idx: i, status: r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : 'skipped', output: r.output, error: r.error })));
      await reload();
      return null;
    }
    return current;
  }

  async function draft() {
    if (!goal.trim()) { setMsg('describe the goal first'); return; }
    if (!designer) { setMsg('no agent available to design the chain'); return; }
    if (builderActionRef.current) return;
    builderActionRef.current = true;
    setDrafting(true); setMsg(`asking ${designer} to design the chain…`); setResults([]);
    try {
      const reply = okText(await dispatchWorkToTeam(
        `/ask ${designer} ${qArg(DRAFT_PROMPT(goal.trim(), names))}`,
        team,
        actionConversationId('loop-draft'),
      ));
      const a = reply.indexOf('['); const b = reply.lastIndexOf(']');
      if (a < 0 || b <= a) { setMsg('AI did not return a step list — edit the steps by hand or retry'); return; }
      const arr = JSON.parse(reply.slice(a, b + 1)) as LoopStep[];
      const next = (Array.isArray(arr) ? arr : []).map(fix).filter((s) => s.task).slice(0, MAX_LOOP_STEPS);
      if (!next.length) { setMsg('AI returned no usable steps — retry or add steps manually'); return; }
      setSteps(next); if (!title.trim()) setTitle(clip(goal, 60));
      setMsg(`drafted ${next.length} step(s) — review, then run`);
    } catch (e) { setMsg(`draft failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally {
      setDrafting(false);
      builderActionRef.current = false;
    }
  }

  function updateStep(i: number, patch: Partial<LoopStep>) { setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s))); }
  function addStep() {
    setSteps((ss) => ss.length >= MAX_LOOP_STEPS ? ss : [...ss, { agent: coordinator, task: '' }]);
  }
  function removeStep(i: number) { setSteps((ss) => ss.filter((_, j) => j !== i)); }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((ss) => { const j = i + dir; if (j < 0 || j >= ss.length) return ss; const n = [...ss]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }
  function newChain() { setEditingId(null); setBaseline(null); setTitle(''); setGoal(''); setSteps([]); setResults([]); setMsg(''); }

  function buildLoop(extra?: Partial<Loop>, base?: Loop | null): Loop {
    const now = Date.now();
    const saved = base ?? baseline;
    return {
      id: editingId ?? saved?.id ?? loopId(),
      title: title.trim() || clip(goal, 60) || 'Untitled loop',
      goal: goal.trim(),
      team,
      steps: steps.slice(0, MAX_LOOP_STEPS),
      createdAt: saved?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: saved?.lastRunAt,
      lastResults: saved?.lastResults,
      ...extra,
    };
  }
  async function save() {
    const valid = validSteps();
    if (!valid.length) { setMsg('add at least one step with a task'); return; }
    if (builderActionRef.current) return;
    builderActionRef.current = true;
    try {
      const current = editingId ? await ensureLoopFresh(`Save loop ${title || editingId}`, ['updatedAt']) : null;
      if (editingId && !current) return;
      setBusy(true); setMsg('saving…');
      const loop = buildLoop({ steps: valid }, current);
      await call('loops:save', loop);
      const saved = await call<Loop | null>('loops:get', loop.id).catch(() => loop);
      setEditingId(loop.id); setBaseline(saved ?? loop); await reload(); setMsg('saved ✓');
    }
    catch (e) { setMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally {
      setBusy(false);
      builderActionRef.current = false;
    }
  }

  async function run() {
    const valid = validSteps();
    if (!valid.length) { setMsg('nothing to run — add steps first'); return; }
    if (builderActionRef.current) return;
    builderActionRef.current = true;
    try {
      const current = editingId ? await ensureLoopFresh(`Run loop ${title || editingId}`, ['updatedAt']) : null;
      if (editingId && !current) return;
      if (!window.confirm(`Run this ${valid.length}-step chain now?\n\nThis sends live /ask requests in sequence and saves the run results.`)) return;
      setRunning(true); setMsg('running the chain…');
      setResults(valid.map((_, i) => ({ idx: i, status: i === 0 ? 'running' : 'skipped' })));
      const out: LoopStepResult[] = [];
      let context = ''; let failed = false;
      for (let i = 0; i < valid.length; i++) {
        const s = valid[i];
        setResults((rs) => rs.map((r) => (r.idx === i ? { ...r, status: 'running' } : r)));
        const prompt = s.task + (context ? `\n\n--- Output from earlier steps (use as context) ---\n${context}` : '');
        try {
          const reply = okText(await dispatchWorkToTeam(
            `/ask ${s.agent} ${qArg(prompt)}`,
            team,
            `${actionConversationId('loop-run')}_${i + 1}`,
          ));
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
      setMsg(failed ? 'chain stopped on a failed step' : 'chain finished ✓');
      // Persist the run (saves the loop if it was unsaved) so it shows under saved chains.
      try {
        const loop = buildLoop({ steps: valid, lastRunAt: Date.now(), lastResults: out }, current);
        await call('loops:save', loop);
        const saved = await call<Loop | null>('loops:get', loop.id).catch(() => loop);
        setEditingId(loop.id); setBaseline(saved ?? loop); await reload();
      } catch (error) {
        setMsg(`${failed ? 'chain stopped on a failed step' : 'chain finished, but saving its results failed'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setRunning(false);
      builderActionRef.current = false;
    }
  }

  async function openSaved(id: string) {
    if (editingId === id) { newChain(); return; }
    const l = await call<Loop | null>('loops:get', id).catch(() => null);
    if (!l) { setMsg('could not load that chain'); return; }
    const openedSteps = (l.steps || []).slice(0, MAX_LOOP_STEPS);
    setEditingId(l.id); setBaseline(l); setTitle(l.title); setGoal(l.goal); setSteps(openedSteps);
    setResults((l.lastResults || []).slice(0, MAX_LOOP_STEPS).map((r, i) => ({ idx: i, status: r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : 'skipped', output: r.output, error: r.error })));
    setMsg((l.steps || []).length > MAX_LOOP_STEPS
      ? `This legacy chain has ${(l.steps || []).length} steps; review the first ${MAX_LOOP_STEPS} before saving.`
      : '');
  }
  async function removeSaved(c: LoopSummary) {
    if (builderActionRef.current) return;
    if (!window.confirm('Delete this saved loop chain?\n\nThis removes the reusable chain definition, but does not remove any scheduled manager check-ins created from it.')) return;
    builderActionRef.current = true;
    try {
      let current: Loop | null;
      try {
        current = await call<Loop | null>('loops:get', c.id);
      } catch (error) {
        setMsg(`delete blocked: could not verify the saved loop (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
      if (!current) {
        setMsg('delete blocked: this saved loop no longer exists; the list was refreshed');
        await reload();
        return;
      }
      if (current.updatedAt !== c.updatedAt) {
        window.alert(`Delete blocked: "${c.title}" changed since the saved-chain list rendered.\n\nThe list will refresh; review the current chain before deleting.`);
        await reload();
        return;
      }
      setBusy(true);
      try {
        const removed = await call<{ ok?: boolean }>('loops:remove', c.id);
        if (!removed?.ok) throw new Error('the profile store did not confirm deletion');
        if (editingId === c.id) newChain();
        await reload();
      } catch (error) {
        setMsg(`delete failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    } finally {
      builderActionRef.current = false;
    }
  }

  /** Compose the chain into one objective the manager can fire on a cadence. A single step is
   *  its own objective; a multi-step chain becomes an ordered checklist the lead runs/delegates. */
  function composeObjective(valid: LoopStep[]): string {
    if (valid.length === 1) return valid[0].task;
    return (
      `Run this ${valid.length}-step sequence in order, passing each step's result into the next:\n` +
      valid.map((s, i) => `${i + 1}. (${s.agent}) ${s.task}`).join('\n') +
      `\n\nDelegate each step to the named agent where you can; then summarize the final result.`
    );
  }
  async function currentTeamSchedules(): Promise<TeamSchedule[] | null> {
    try {
      return await readSchedulesForTeam(team);
    } catch (error) {
      setMsg(`schedule verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  function sameScheduledObjective(schedule: ScheduleEntry, target: string, cadenceDays: string, cadenceTime: string, objective: string): boolean {
    return schedule.kind === 'calendar'
      && schedule.targets.includes(target)
      && (schedule.daysOfWeek || '') === cadenceDays
      && fmtTime(schedule.localTimeSeconds) === cadenceTime
      && schedule.message === objective;
  }
  /** Schedule the chain as a recurring manager loop (calendar check-in). Multi-step chains are
   *  handed to the first step's agent as a composed checklist (precise per-step routing happens
   *  via Run now, in-app). */
  async function createSchedule() {
    const valid = validSteps();
    if (!valid.length) { setMsg('add at least one step first'); return; }
    const d = days.replace(/\s+/g, '');
    if (!/^(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*$/.test(d)) { setMsg('pick a cadence'); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.trim())) { setMsg('time must be HH:MM (24h), e.g. 09:00'); return; }
    if (scheduleMutationRef.current || builderActionRef.current) return;
    scheduleMutationRef.current = true;
    builderActionRef.current = true;
    const target = valid[0].agent;
    const objective = composeObjective(valid);
    try {
      let current = editingId ? await ensureLoopFresh(`Schedule workflow ${title || editingId}`, ['updatedAt']) : null;
      if (editingId && !current) return;
      const before = await currentTeamSchedules();
      if (!before) return;
      const duplicate = before.find((schedule) => sameScheduledObjective(schedule, target, d, time.trim(), objective));
      if (duplicate) {
        window.alert(`This exact scheduled objective already exists for ${team}/${target} (${duplicate.active ? 'active' : 'paused'}).`);
        return;
      }
      if (!window.confirm(
        `Schedule this loop for ${team}/${target} on ${d} at ${time.trim()}?\n\n`
        + 'The unified Manager dispatches it while IDACC is running. The definition persists when IDACC closes and resumes on the next launch until paused or removed.',
      )) return;

      // Recheck both the reusable chain and duplicate set after the confirmation
      // dialog so another window cannot change the approved target or cadence.
      if (editingId) {
        current = await ensureLoopFresh(`Schedule workflow ${title || editingId}`, ['updatedAt']);
        if (!current) return;
      }
      const confirmedSchedules = await currentTeamSchedules();
      if (!confirmedSchedules) return;
      if (confirmedSchedules.some((schedule) => sameScheduledObjective(schedule, target, d, time.trim(), objective))) {
        window.alert('Schedule blocked: an identical recurring objective was created while confirmation was open. The list will refresh.');
        onScheduled?.();
        return;
      }

      setBusy(true);
      setMsg(`saving and scheduling loop for ${target}…`);
      // A scheduled action remains useful without the editor, but the button
      // promises a saved reusable loop too, so failure to persist is blocking.
      const loop = buildLoop({ steps: valid }, current);
      await call('loops:save', loop);
      const saved = await call<Loop | null>('loops:get', loop.id);
      if (!saved) throw new Error('the reusable loop could not be read back after saving');
      setEditingId(loop.id);
      setBaseline(saved);

      const created = await call<{ schedule?: { id?: string } }>(
        'addCalendarCheckin',
        target,
        time.trim(),
        d,
        objective,
        { delivery: 'talk' },
        team,
      );
      const createdId = String(created?.schedule?.id || '');
      const after = await currentTeamSchedules();
      if (!after) {
        throw new Error('the Manager accepted the request, but IDACC could not verify the new schedule; refresh before trying again');
      }
      const verified = createdId
        ? after.some((schedule) => schedule.id === createdId && sameScheduledObjective(schedule, target, d, time.trim(), objective))
        : after.some((schedule) => !confirmedSchedules.some((beforeSchedule) => beforeSchedule.id === schedule.id)
          && sameScheduledObjective(schedule, target, d, time.trim(), objective));
      if (!verified) {
        throw new Error('the Manager did not return a verifiable scheduled objective; refresh before trying again');
      }

      setMsg('scheduled ✓ — runs while IDACC is open and resumes after restart');
      await reload();
      onScheduled?.();
    } catch (e) { setMsg(`schedule failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally {
      setBusy(false);
      scheduleMutationRef.current = false;
      builderActionRef.current = false;
    }
  }

  return (
    <section className="card">
      <div className="row-actions" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <h3 className="grow" style={{ margin: 0 }}>New workflow <span className="muted small">· string one or more agents + tasks into a sequence (AI-drafted) — run now or on a persistent cadence</span></h3>
        {msg ? <span className={`small ${/failed|could not|stopped/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
      </div>

      {chains.length ? (
        <div className="chips" style={{ marginBottom: 8 }}>
          {chains.map((c) => (
            <span key={c.id} className={`chip${editingId === c.id ? ' on' : ''}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <button className="link-btn" disabled={locked} title={`${c.steps} step(s) · last run ${agoMs(c.lastRunAt)}`} onClick={() => void openSaved(c.id)}>{c.title}</button>
              <button className="link-btn" style={{ opacity: 0.6 }} disabled={locked} title="Delete chain" onClick={() => void removeSaved(c)}>✕</button>
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
            <button className="btn" disabled={locked || !goal.trim()} onClick={() => void draft()}>{drafting ? 'Drafting…' : '✦ Draft steps'}</button>
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

      {steps.length ? (
        <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'center', marginTop: 10 }}>
          <span>schedule</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Run this loop automatically while IDACC is running; the cadence resumes after app restart">
              <input type="checkbox" checked={scheduleOn} disabled={locked} onChange={(e) => setScheduleOn(e.target.checked)} /> run on a cadence
            </label>
            {scheduleOn ? (
              <>
                <CalendarSchedule time={time} days={days.split(',').filter(Boolean)} disabled={locked} onTime={setTime} onDays={(value) => setDays(value.join(','))} />
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="row-actions" style={{ marginTop: 10, alignItems: 'center' }}>
        <button
          className="btn small"
          disabled={locked || steps.length >= MAX_LOOP_STEPS}
          title={steps.length >= MAX_LOOP_STEPS ? `A loop can contain up to ${MAX_LOOP_STEPS} steps` : 'Add another step'}
          onClick={addStep}
        >
          + add step
        </button>
        {steps.length >= MAX_LOOP_STEPS ? <span className="muted small">maximum {MAX_LOOP_STEPS} steps</span> : null}
        <span className="grow" />
        {steps.length ? <button className="btn" disabled={locked} onClick={() => void save()}>Save</button> : null}
        {steps.length ? <button className="btn" disabled={locked} title="Run the sequence now, in-app (precise per-step routing; passes each step's output to the next)" onClick={() => void run()}>{running ? 'Running…' : `▶ Run ${steps.length === 1 ? 'now' : `${steps.length}-step chain`}`}</button> : null}
        {steps.length && scheduleOn ? <button className="btn primary" disabled={locked} title="Schedule this loop on the chosen persistent Manager cadence" onClick={() => void createSchedule()}>Schedule workflow</button> : null}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        <b>Run now</b> executes the steps in order in-app via <span className="mono">/ask</span>, passing each step's output to the next as context (precise per-step routing; app must be open).
        <b> Schedule workflow</b> hands it to the unified Manager while IDACC is running; the definition persists and resumes after restart. A single step runs as-is; a multi-step chain is handed to the first agent as an ordered checklist to run &amp; delegate. Saved workflows can be re-run or scheduled anytime.
      </p>
    </section>
  );
}

export function Loops({ store }: { store: FleetStore }) {
  const scheduleSyncVersion = useSyncVersion(['schedules', 'checkins', 'loops', 'work']);
  const team = store.team ?? 'default';
  const [schedules, setSchedules] = useState<TeamSchedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const actionRef = useRef(false);
  const reloadEpochRef = useRef(0);

  async function readTeamSchedules(): Promise<TeamSchedule[]> {
    return readSchedulesForTeam(team);
  }
  async function reload() {
    const epoch = ++reloadEpochRef.current;
    try {
      const next = await readTeamSchedules();
      if (epoch === reloadEpochRef.current) setSchedules(next);
    } catch (error) {
      if (epoch === reloadEpochRef.current) {
        setMsg(`schedule refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, SCHEDULE_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      reloadEpochRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, scheduleSyncVersion]);

  const loops = schedules.filter((s) => s.kind === 'calendar' && !isDreamSchedule(s));

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setMsg(`${label}…`);
    try { await fn(); setMsg(`${label} ✓`); }
    catch (err) { setMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { await reload(); setBusy(false); }
  }
  async function freshSchedule(rendered: TeamSchedule, action: string): Promise<TeamSchedule | null> {
    let current: TeamSchedule[];
    try {
      current = await readTeamSchedules();
    } catch (error) {
      setMsg(`${action} blocked: current schedule state could not be verified (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
    const fresh = current.find((schedule) => schedule.id === rendered.id);
    if (!fresh) {
      setMsg(`${action} blocked: this schedule no longer exists; the list was refreshed`);
      setSchedules(current);
      return null;
    }
    if (scheduleStamp(fresh) !== scheduleStamp(rendered)) {
      setMsg(`${action} blocked: this schedule changed while it was displayed; review the refreshed row`);
      setSchedules(current);
      return null;
    }
    return fresh;
  }
  async function guardedAct(
    schedule: TeamSchedule,
    label: string,
    detail: string,
    op: 'pauseSchedule' | 'resumeSchedule' | 'removeSchedule',
  ) {
    if (actionRef.current) return;
    if (!window.confirm(`${label}?\n\n${detail}`)) return;
    actionRef.current = true;
    try {
      const fresh = await freshSchedule(schedule, label);
      if (!fresh) return;
      await act(label, () => call(op, fresh.id, team));
    } finally {
      actionRef.current = false;
    }
  }

  /** Fire the loop's objective once, right now (doesn't change the schedule). */
  async function runNow(s: TeamSchedule) {
    const targets = Array.isArray(s.targets) ? s.targets : [];
    if (!targets.length) return;
    if (actionRef.current) return;
    if (!window.confirm(`Run scheduled objective now for ${team}/${targets.join(`, ${team}/`)}?\n\nThis sends the loop objective immediately without changing the saved schedule.`)) return;
    actionRef.current = true;
    try {
      const fresh = await freshSchedule(s, 'Run now');
      if (!fresh) return;
      setRunning(s.id); setMsg(`running ${targets.join(', ')}…`);
      for (const t of targets) {
        try {
          await dispatchWorkToTeam(
            `/ask ${t} ${qArg(fresh.message)}`,
            team,
            actionConversationId('scheduled-loop-run'),
          );
        } catch (error) {
          throw new Error(`${team}/${t}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      setMsg('ran once ✓');
    } catch (err) { setMsg(`run failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally {
      setRunning(null);
      actionRef.current = false;
    }
  }

  return (
    <>
      <LoopBuilder store={store} onScheduled={reload} />

      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Scheduled objectives <span className="muted small">· Manager cadence while IDACC is running; definitions resume after restart</span></h3>
          {msg ? <span className={`small ${/failed/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        </div>
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Objective</th><th>Cadence</th><th>Status</th><th>Last run</th><th></th></tr>
          </thead>
          <tbody>
            {loops.map((s) => (
              <tr key={s.id}>
                <td className="b">{(Array.isArray(s.targets) ? s.targets.map((target) => `${team}/${target}`) : []).join(', ') || '—'}</td>
                <td className="small">{s.message}</td>
                <td className="muted small mono">{cadenceLabel(s)}</td>
                <td className={s.lastStatus === 'failed' ? 'status-error small' : s.active ? 'ok-text small' : 'muted small'}>
                  {s.lastStatus === 'failed' ? '⚠ failed' : s.active ? '● looping' : 'paused'}
                </td>
                <td className="muted small">{relTime(s.lastRunAt)}</td>
                <td className="row-actions">
                  <button className="btn" disabled={busy || running !== null} title="Run the objective once now" onClick={() => void runNow(s)}>{running === s.id ? '…' : 'Run now'}</button>
                  <button className="btn" disabled={busy || running === s.id} onClick={() => void guardedAct(s, s.active ? 'pause' : 'resume', `${s.active ? 'Pauses' : 'Resumes'} this recurring loop schedule.`, s.active ? 'pauseSchedule' : 'resumeSchedule')}>{s.active ? 'Pause' : 'Resume'}</button>
                  <button className="btn icon-danger" disabled={busy || running === s.id} title="Delete loop" onClick={() => void guardedAct(s, 'remove', 'Deletes this recurring loop schedule. The saved chain definition stays unless you delete it above.', 'removeSchedule')}>✕</button>
                </td>
              </tr>
            ))}
            {loops.length === 0 ? <tr><td colSpan={6} className="muted center pad">No scheduled workflows yet. Build one above with <b>New workflow</b>, tick <b>run on a cadence</b>, and <b>Schedule workflow</b> — e.g. weekdays 09:00 to “review the launch queue and report blockers”.</td></tr> : null}
          </tbody>
        </table>
        <p className="muted small" style={{ marginTop: 6 }}>
          The unified Manager dispatches scheduled loops while IDACC is running. Definitions persist when the app closes and resume on the next launch. Use <b>Run now</b> to fire one immediately. Status reflects the last scheduled run.
        </p>
      </section>
    </>
  );
}
