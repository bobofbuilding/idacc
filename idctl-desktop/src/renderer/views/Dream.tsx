import { CalendarSchedule } from '../components/CalendarSchedule.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';
import {
  DREAM_DAILY_DAYS,
  DREAM_DEFAULT_TIME,
  DREAM_SCHEDULE_OBJECTIVE,
  dreamScheduleDays,
  dreamScheduleDaysLabel,
  dreamScheduleTime,
  isDreamSchedule,
} from '../../shared/dreamSchedule.ts';
import { dispatchWorkToTeam } from './workDispatch.ts';

/**
 * Dream tab (under Work). An agent runs an offline "dream" — a reflection pass over
 * its recent work and the shared brain — and returns a Markdown report with four
 * sections: Consolidation, Insights, Ideas, Simulations. Reports are saved here as a
 * morning digest. Ideas/Simulations are PROPOSALS for review, never auto-executed
 * (per the research: agents grade their own dreams too generously).
 */

type DreamSummary = { id: string; title: string; agent: string; team: string; createdAt: number };
interface Dream { id: string; title: string; agent: string; team: string; focus?: string; content: string; createdAt: number }
type TeamSchedule = ScheduleEntry & { team?: string };

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function dreamId(): string { return `dream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
const okText = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };

const DREAM_PROMPT = (focus: string) =>
  'Run a "dream" — an offline reflection pass over your recent work and the team\'s shared ' +
  'brain/memory. Use your memory/brain skills to ground it in what you actually know. Produce a ' +
  'concise **Dream Report** in Markdown with EXACTLY these four headings:\n\n' +
  '## Consolidation\nThe most important facts/learnings from recent work worth remembering (3-7 bullets) — candidates to write into the brain.\n\n' +
  '## Insights\nHigher-level patterns connecting multiple observations (2-5 bullets); note what each is based on.\n\n' +
  '## Ideas\nProposed new tasks or plans worth considering (2-5 bullets). These are PROPOSALS for human review — do NOT act on them.\n\n' +
  '## Simulations\nLikely near-future scenarios, outcomes, or risks for current work (2-4 bullets). Clearly SPECULATIVE.\n\n' +
  'Be specific and grounded. If a section has nothing meaningful, say so in one line.' +
  (focus.trim() ? `\n\nFocus this dream on: ${focus.trim()}` : '');

const SUGGEST_FOCUS_PROMPT =
  'Based on your recent work and the team\'s shared brain/memory, what is the SINGLE most valuable thing to ' +
  'focus a reflection "dream" on right now? Reply with ONE short focus phrase ONLY — no preamble, no quotes, ' +
  'no markdown — e.g. "onchain readiness blockers" or "where the org keeps duplicating work".';

function inlineDreamMarkdown(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      return part;
    });
}

function DreamMarkdown({ content }: { content: string }) {
  return (
    <div className="plan-content dream-markdown">
      {content.split(/\r?\n/).map((line, index) => {
        const heading = /^(#{1,4})\s+(.+)$/.exec(line);
        if (heading) {
          const Heading = heading[1].length <= 2 ? 'h3' : 'h4';
          return <Heading key={index}>{inlineDreamMarkdown(heading[2])}</Heading>;
        }
        const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
        if (bullet) return <div className="dream-markdown-bullet" key={index}><span>•</span><span>{inlineDreamMarkdown(bullet[1])}</span></div>;
        const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
        if (numbered) return <div className="dream-markdown-bullet" key={index}><span>{numbered[1]}.</span><span>{inlineDreamMarkdown(numbered[2])}</span></div>;
        if (!line.trim()) return <div className="dream-markdown-gap" key={index} aria-hidden="true" />;
        return <p key={index}>{inlineDreamMarkdown(line)}</p>;
      })}
    </div>
  );
}

const DREAM_DAY_OPTIONS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
] as const;
const DREAM_REFRESH_MS = 15_000;

function scheduleStamp(schedule: ScheduleEntry): string {
  return JSON.stringify({
    active: schedule.active,
    targets: [...(schedule.targets || [])].sort(),
    localTimeSeconds: schedule.localTimeSeconds,
    daysOfWeek: schedule.daysOfWeek,
    timezone: schedule.timezone,
    message: schedule.message,
  });
}

function dreamConversationId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function Dream({ store }: { store: FleetStore }) {
  const syncVersion = useSyncVersion(['dreams', 'work', 'brain']);
  const team = store.team ?? 'default';
  const names = store.agents.map((a) => a.name);
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? names[0] ?? '';
  const [dreams, setDreams] = useState<DreamSummary[]>([]);
  const [nightlySchedules, setNightlySchedules] = useState<TeamSchedule[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Dream | null>(null);
  const [agentSel, setAgentSel] = useState('');
  const [focus, setFocus] = useState('');
  const [dreaming, setDreaming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [scheduleTime, setScheduleTime] = useState(DREAM_DEFAULT_TIME);
  const [scheduleDays, setScheduleDays] = useState<string[]>(DREAM_DAILY_DAYS.split(','));
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const alive = useRef(true);
  const reloadEpochRef = useRef(0);
  const scheduleMutationRef = useRef(false);
  const reflectionActionRef = useRef(false);
  const reportDeleteRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; reloadEpochRef.current += 1; };
  }, []);

  const agent = agentSel && names.includes(agentSel) ? agentSel : coordinator;

  async function reload() {
    const epoch = ++reloadEpochRef.current;
    const [reports, allSchedules] = await Promise.all([
      call<DreamSummary[]>('dreams:list', team).catch(() => null),
      call<TeamSchedule[]>('schedules:allTeams').catch(() => null),
    ]);
    const archived = await call<{ archived?: number }>('dreams:archiveScheduled', team).catch(() => null);
    const finalReports = archived?.archived
      ? await call<DreamSummary[]>('dreams:list', team).catch(() => reports)
      : reports;
    if (!alive.current || epoch !== reloadEpochRef.current) return;
    // A transient Manager/profile read must not look like every saved report or
    // recurring Dream was deleted. Keep the last verified list for a failed lane.
    if (finalReports) setDreams(finalReports);
    if (allSchedules) {
      setNightlySchedules(allSchedules.filter((schedule) =>
        (schedule.team ?? team) === team && isDreamSchedule(schedule)));
    }
    if (archived?.archived) {
      setMsg(`${archived.archived} scheduled dream report${archived.archived === 1 ? '' : 's'} archived ✓`);
    }
  }
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, DREAM_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      reloadEpochRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, syncVersion]);

  async function open(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    const d = await call<Dream | null>('dreams:get', id).catch(() => null);
    if (alive.current) setDetail(d);
  }

  async function dreamNow() {
    if (!agent) { setMsg('no agent available to dream'); return; }
    if (reflectionActionRef.current) return;
    if (!window.confirm(`Run dream now with ${agent}?\n\nThis sends a live reflection request over recent work and the shared brain, then saves the report.`)) return;
    reflectionActionRef.current = true;
    setDreaming(true); setMsg(`${agent} is dreaming… (reflecting over recent work + the brain)`);
    try {
      const content = okText(await dispatchWorkToTeam(
        `/ask ${agent} ${qArg(DREAM_PROMPT(focus))}`,
        team,
        dreamConversationId('dream-now'),
      ));
      if (!alive.current) return;
      if (!content) { setMsg(`${agent} returned an empty dream — try again`); return; }
      const now = Date.now();
      const dream: Dream = { id: dreamId(), title: `${agent}'s dream · ${new Date(now).toLocaleString()}`, agent, team, focus: focus.trim() || undefined, content, createdAt: now };
      await call('dreams:save', dream);
      if (!alive.current) return;
      setFocus(''); setMsg('dream saved ✓');
      await reload();
      setOpenId(dream.id); setDetail(dream);
    } catch (e) {
      if (alive.current) setMsg(`dream failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setDreaming(false);
      reflectionActionRef.current = false;
    }
  }

  /** AI drafting assist: ask the agent to propose a high-value focus, grounded in its recent
   *  work + the brain, and fill the focus field with it (the user can edit before dreaming). */
  async function suggestFocus() {
    if (!agent) { setMsg('no agent available to suggest a focus'); return; }
    if (reflectionActionRef.current) return;
    reflectionActionRef.current = true;
    setSuggesting(true); setMsg(`${agent} is suggesting a focus…`);
    try {
      const out = okText(await dispatchWorkToTeam(
        `/ask ${agent} ${qArg(SUGGEST_FOCUS_PROMPT)}`,
        team,
        dreamConversationId('dream-focus'),
      ));
      if (!alive.current) return;
      const line = out.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const clean = line.replace(/^["'`]+|["'`]+$/g, '').replace(/^[-*\d.\s]+/, '').slice(0, 160);
      if (!clean) { setMsg('no suggestion returned — try again or type your own'); return; }
      setFocus(clean); setMsg('focus suggested — edit it or ✦ Generate review');
    } catch (e) {
      if (alive.current) setMsg(`suggest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setSuggesting(false);
      reflectionActionRef.current = false;
    }
  }

  function toggleScheduleDay(day: string) {
    setScheduleDays((current) => current.includes(day)
      ? current.filter((item) => item !== day)
      : DREAM_DAY_OPTIONS.map(([id]) => id).filter((id) => current.includes(id) || id === day));
  }

  function editSchedule(schedule: ScheduleEntry) {
    const target = schedule.targets[0];
    if (!target || !names.includes(target)) {
      setMsg('schedule edit blocked: its agent is no longer in the current team');
      return;
    }
    setAgentSel(target);
    setScheduleTime(dreamScheduleTime(schedule));
    setScheduleDays(dreamScheduleDays(schedule).split(',').filter(Boolean));
    setEditingScheduleId(schedule.id);
    setMsg('editing scheduled dream — choose time/days, then save');
  }

  async function currentDreamSchedules(): Promise<TeamSchedule[] | null> {
    try {
      const all = await call<TeamSchedule[]>('schedules:allTeams');
      return all.filter((schedule) => (schedule.team ?? team) === team && isDreamSchedule(schedule));
    } catch (error) {
      setMsg(`schedule verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function sameDreamCadence(schedule: ScheduleEntry, target: string, time: string, days: string): boolean {
    return schedule.targets.includes(target)
      && dreamScheduleTime(schedule) === time
      && dreamScheduleDays(schedule) === days;
  }

  async function scheduleNightly() {
    if (!agent) return;
    const normalizedTime = scheduleTime.trim();
    const normalizedDays = DREAM_DAY_OPTIONS.map(([day]) => day).filter((day) => scheduleDays.includes(day)).join(',');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)) {
      setMsg('schedule time must be HH:MM');
      return;
    }
    if (!normalizedDays) {
      setMsg('pick at least one schedule day');
      return;
    }
    if (scheduleMutationRef.current) return;
    scheduleMutationRef.current = true;
    let createdId = '';
    let replacing: TeamSchedule | undefined;
    let oldRemoved = false;
    try {
      const schedules = await currentDreamSchedules();
      if (!schedules) return;
      const existing = schedules.find((schedule) =>
        schedule.id !== editingScheduleId
        && sameDreamCadence(schedule, agent, normalizedTime, normalizedDays));
      if (existing) {
        window.alert(`That scheduled dream already exists for ${team}/${agent} (${existing.active ? 'active' : 'paused'}).`);
        return;
      }
      replacing = editingScheduleId
        ? schedules.find((schedule) => schedule.id === editingScheduleId)
        : undefined;
      if (editingScheduleId && !replacing) {
        window.alert('Schedule update blocked: the schedule being edited no longer exists. The list will refresh.');
        setEditingScheduleId(null);
        await reload();
        return;
      }
      const cadence = `${normalizedTime} · ${dreamScheduleDaysLabel(normalizedDays)}`;
      if (!window.confirm(`${replacing ? 'Replace' : 'Schedule'} recurring dream for ${team}/${agent}?\n\nCadence: ${cadence}\nCompleted reports will be archived automatically in Dream while IDACC is running.`)) return;

      // Re-read after confirmation: never replace a schedule whose cadence,
      // target, active state, or objective changed while the dialog was open.
      const confirmed = await currentDreamSchedules();
      if (!confirmed) return;
      const confirmedReplacing = replacing
        ? confirmed.find((schedule) => schedule.id === replacing!.id)
        : undefined;
      if (replacing && (!confirmedReplacing || scheduleStamp(confirmedReplacing) !== scheduleStamp(replacing))) {
        window.alert('Schedule update blocked: the schedule changed while confirmation was open. Review the refreshed row before trying again.');
        await reload();
        return;
      }
      const concurrentDuplicate = confirmed.find((schedule) =>
        schedule.id !== replacing?.id
        && sameDreamCadence(schedule, agent, normalizedTime, normalizedDays));
      if (concurrentDuplicate) {
        window.alert('Schedule update blocked: an identical Dream schedule was created while confirmation was open.');
        await reload();
        return;
      }

      setBusy(true);
      setMsg(`${replacing ? 'updating' : 'scheduling'} recurring dream for ${agent}…`);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
      const created = await call<{ schedule?: { id?: string } }>(
        'addCalendarCheckin',
        agent,
        normalizedTime,
        normalizedDays,
        DREAM_SCHEDULE_OBJECTIVE,
        { delivery: 'talk', timezone },
        team,
      );
      createdId = String(created?.schedule?.id || '');
      const afterCreate = await currentDreamSchedules();
      if (!afterCreate) {
        throw new Error('the Manager accepted the request, but IDACC could not verify the new schedule; refresh before trying again');
      }
      const newSchedule = createdId
        ? afterCreate.find((schedule) => schedule.id === createdId)
        : afterCreate.find((schedule) =>
            !confirmed.some((before) => before.id === schedule.id)
            && sameDreamCadence(schedule, agent, normalizedTime, normalizedDays));
      if (!newSchedule || !sameDreamCadence(newSchedule, agent, normalizedTime, normalizedDays)) {
        throw new Error('the Manager did not return a verifiable Dream schedule; no existing schedule was removed');
      }
      createdId = newSchedule.id;
      if (replacing) {
        try {
          await call('dreams:archiveScheduled', team).catch(() => {});
          if (!replacing.active) await call('pauseSchedule', createdId, team);
          await call('removeSchedule', replacing.id, team);
          oldRemoved = true;
        } catch (error) {
          await call('removeSchedule', createdId, team).catch(() => {});
          createdId = '';
          throw error;
        }
      }
      setEditingScheduleId(null);
      setMsg(`scheduled dream saved for ${agent} · ${cadence} ✓`);
      await reload();
    } catch (e) {
      if (createdId && replacing && !oldRemoved) {
        await call('removeSchedule', createdId, team).catch(() => {});
      }
      setMsg(`schedule failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      scheduleMutationRef.current = false;
    }
  }

  async function scheduleAction(schedule: ScheduleEntry, action: 'pause' | 'resume' | 'remove') {
    const label = action === 'remove' ? 'Delete' : action === 'pause' ? 'Pause' : 'Resume';
    if (scheduleMutationRef.current) return;
    if (!window.confirm(`${label} this scheduled dream?\n\n${action === 'remove' ? 'Saved Dream reports are kept.' : 'The recurring schedule will remain available here.'}`)) return;
    scheduleMutationRef.current = true;
    try {
      const schedules = await currentDreamSchedules();
      if (!schedules) return;
      const fresh = schedules.find((candidate) => candidate.id === schedule.id);
      if (!fresh) {
        window.alert(`${label} blocked: this scheduled Dream no longer exists.`);
        await reload();
        return;
      }
      if (scheduleStamp(fresh) !== scheduleStamp(schedule)) {
        window.alert(`${label} blocked: this scheduled Dream changed while confirmation was open. Review the refreshed row before trying again.`);
        await reload();
        return;
      }
      setBusy(true);
      if (action === 'remove') await call('dreams:archiveScheduled', team).catch(() => {});
      await call(action === 'pause' ? 'pauseSchedule' : action === 'resume' ? 'resumeSchedule' : 'removeSchedule', fresh.id, team);
      if (editingScheduleId === schedule.id) setEditingScheduleId(null);
      setMsg(`${action === 'remove' ? 'removed' : action === 'pause' ? 'paused' : 'resumed'} scheduled dream ✓`);
      await reload();
    } catch (error) {
      setMsg(`${label.toLowerCase()} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      scheduleMutationRef.current = false;
    }
  }

  async function remove(d: DreamSummary) {
    if (reportDeleteRef.current) return;
    let current: Dream | null;
    try {
      current = await call<Dream | null>('dreams:get', d.id);
    } catch (error) {
      setMsg(`delete blocked: could not verify the report (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (!current) {
      window.alert('Delete blocked: this dream report no longer exists.');
      await reload();
      return;
    }
    if (current.title !== d.title || current.agent !== d.agent || current.team !== d.team || current.createdAt !== d.createdAt) {
      window.alert('Delete blocked: this dream report changed since the list rendered.\n\nThe dream list will refresh; review the current report before deleting.');
      await reload();
      return;
    }
    if (!window.confirm('Delete this dream report?\n\nThis removes the saved report from the local dream log.')) return;
    reportDeleteRef.current = true;
    setBusy(true);
    try {
      const confirmed = await call<Dream | null>('dreams:get', current.id);
      if (!confirmed || confirmed.title !== current.title || confirmed.agent !== current.agent
        || confirmed.team !== current.team || confirmed.createdAt !== current.createdAt) {
        window.alert('Delete blocked: this dream report changed while confirmation was open. Review the refreshed report before deleting.');
        await reload();
        return;
      }
      const removed = await call<{ ok?: boolean }>('dreams:remove', confirmed.id);
      if (!removed?.ok) throw new Error('the profile store did not confirm deletion');
      if (openId === confirmed.id) { setOpenId(null); setDetail(null); }
      await reload();
      setMsg('dream report deleted ✓');
    } catch (error) {
      setMsg(`delete failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      reportDeleteRef.current = false;
    }
  }

  const locked = dreaming || busy || suggesting;
  return (
    <>
      <section className="card">
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Reflection</h3>
          <span className="muted small">· review recent work and suggest improvements</span>
          <span className="grow" />
          {msg ? <span className={`small ${/failed|empty/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          An agent reflects offline and returns a report: <b>Consolidation</b> (facts worth keeping),
          <b> Insights</b> (patterns), <b>Ideas</b> (proposed tasks/plans), and <b>Simulations</b> (speculative futures).
          Ideas &amp; Simulations are <b>proposals for your review</b> — nothing is auto-executed.
        </p>
        <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'center' }}>
          <span>agent</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="cell-select" value={agent} disabled={locked} onChange={(e) => setAgentSel(e.target.value)}>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input style={{ flex: '1 1 260px' }} placeholder="optional focus — e.g. “onchain launch readiness”, or ✦ Suggest" value={focus} disabled={locked} onChange={(e) => setFocus(e.target.value)} />
            <button className="btn" disabled={locked || !agent} title="Let the agent propose a high-value focus from its recent work + the brain" onClick={() => void suggestFocus()}>{suggesting ? 'Suggesting…' : '✦ Suggest a focus'}</button>
            <button className="btn primary" disabled={locked || !agent} onClick={() => void dreamNow()}>{dreaming ? 'Reviewing…' : '✦ Generate review'}</button>
          </span>
          <span>schedule</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <CalendarSchedule time={scheduleTime} days={scheduleDays} disabled={locked} onTime={setScheduleTime} onDays={setScheduleDays} />
            <button className="btn" disabled={locked || !agent || scheduleDays.length === 0} onClick={() => void scheduleNightly()}>
              {editingScheduleId ? 'Save schedule' : 'Schedule review'}
            </button>
            {editingScheduleId ? (
              <button className="btn" disabled={locked} onClick={() => { setEditingScheduleId(null); setMsg('schedule edit cancelled'); }}>
                Cancel
              </button>
            ) : null}
            <span className="muted small">runs while IDACC is open; resumes after restart</span>
          </span>
        </div>
      </section>

      <div className="skill-catalog">
        {nightlySchedules.map((schedule) => (
          <div className="skill-card dream-schedule-card" key={`schedule:${schedule.id}`}>
            <div className="skill-card-head">
              <span className="b">☾ Scheduled reflection · {schedule.targets.join(', ') || 'unassigned'}</span>
              <span className={`chip ${schedule.active ? 'ok' : 'warn'}`}>{schedule.active ? 'active' : 'paused'}</span>
              <span className="grow" />
              <span className="muted small">
                {dreamScheduleTime(schedule)} · {dreamScheduleDaysLabel(schedule.daysOfWeek)}
                {schedule.timezone ? ` · ${schedule.timezone}` : ''}
                {schedule.lastRunAt ? ` · last ${ago(schedule.lastRunAt * 1000)}` : ' · not run yet'}
                {schedule.lastStatus ? ` · ${schedule.lastStatus}` : ''}
              </span>
              <button className="btn small" disabled={locked} onClick={() => editSchedule(schedule)}>Edit</button>
              <button className="btn small" disabled={locked} onClick={() => void scheduleAction(schedule, schedule.active ? 'pause' : 'resume')}>
                {schedule.active ? 'Pause' : 'Resume'}
              </button>
              <button className="btn icon-danger small" disabled={locked} title="Delete schedule" onClick={() => void scheduleAction(schedule, 'remove')}>✕</button>
            </div>
            <p className="muted small">Persistent Manager schedule. It runs while IDACC is open and resumes after restart; completed reports are reconciled by exact query ID and archived below.</p>
          </div>
        ))}
        {dreams.map((d) => {
          const isOpen = openId === d.id;
          return (
            <div className={`skill-card${isOpen ? ' editing' : ''}`} key={d.id}>
              <div className="skill-card-head" style={{ cursor: 'pointer' }} onClick={() => void open(d.id)}>
                <span className="b">✦ {d.agent}</span>
                <span className="muted small">· {new Date(d.createdAt).toLocaleString()}</span>
                <span className="grow" />
                <span className="muted small">{ago(d.createdAt)}</span>
                <button className="btn icon-danger small" disabled={locked} title="Delete dream" onClick={(e) => { e.stopPropagation(); void remove(d); }}>✕</button>
                <span className="muted">{isOpen ? '▾' : '▸'}</span>
              </div>
              {isOpen ? (
                detail ? <DreamMarkdown content={detail.content} /> : <p className="muted small">loading…</p>
              ) : null}
            </div>
          );
        })}
        {dreams.length === 0 ? <p className="muted center pad">No reflection reports yet. Pick an agent and <b>✦ Generate review</b> — it’ll reflect over recent work and the brain, then post a report here.</p> : null}
      </div>
    </>
  );
}
