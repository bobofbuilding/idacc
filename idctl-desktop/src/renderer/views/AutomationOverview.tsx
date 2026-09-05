import { useEffect, useState } from 'react';
import { call, useSyncVersion } from '../store.ts';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';
import type { WorkTab } from '../navigation.ts';
type Schedule = ScheduleEntry & { team?: string };
export function AutomationOverview({ open }: { open: (tab: WorkTab) => void }) {
  const sync = useSyncVersion(['schedules', 'loops', 'dreams']);
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [includePaused, setIncludePaused] = useState(false);
  async function refresh() {
    try { setRows(await call<Schedule[]>('schedules:allTeams')); setError(''); }
    catch { setError('Schedules could not be refreshed. Any previous results remain below.'); }
  }
  useEffect(() => { void refresh(); }, [sync]);
  const visible = (rows ?? []).filter((row) => (includePaused || row.active) && `${row.title} ${row.targets.join(' ')} ${row.team ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
  return <section className="card">
    <h3>Schedules &amp; latest activity</h3>
    <p className="muted">See the most recent recorded delivery for each schedule. A sent instruction is not proof that its task finished.</p>
    <div className="row-actions"><input aria-label="Search automations" placeholder="Find a schedule, team, or agent…" value={search} onChange={(event) => setSearch(event.target.value)} /><label><input type="checkbox" checked={includePaused} onChange={(event) => setIncludePaused(event.target.checked)} /> Include paused</label><button className="btn" onClick={() => void refresh()}>Refresh</button><button className="btn primary" onClick={() => open('schedule')}>Add scheduled check</button><button className="btn" onClick={() => open('loops')}>Create workflow</button><button className="btn" onClick={() => open('dream')}>Schedule reflection</button></div>
    {error ? <p role="alert">{error}</p> : rows === null ? <p role="status">Loading schedules…</p> : null}
    {visible.map((row) => <div className="inbox-row" key={`${row.team}:${row.id}`}><strong>{row.title || 'Scheduled check'}</strong><p>{row.team ?? 'Current team'} · {row.targets.join(', ') || 'No agent assigned'} · {row.active ? 'Enabled' : 'Paused'}</p><p className="muted">{row.kind === 'heartbeat' ? `Every ${(row.intervalSeconds ?? 0) / 60} minutes` : `${row.daysOfWeek || row.localDate || 'Daily'} at ${Math.floor((row.localTimeSeconds ?? 0) / 3600).toString().padStart(2, '0')}:${Math.floor((row.localTimeSeconds ?? 0) % 3600 / 60).toString().padStart(2, '0')}`} · {row.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}</p><p>Last delivery: {row.lastRunAt ? new Date(row.lastRunAt * 1000).toLocaleString() : 'Not recorded'} · {row.lastStatus || 'No result recorded'}</p><button className="btn small" onClick={() => open(row.kind === 'heartbeat' ? 'schedule' : /dream/i.test(`${row.sourceType} ${row.title} ${row.message}`) ? 'dream' : 'loops')}>Review schedule</button></div>)}
    {rows && !visible.length ? <p className="muted">No schedules match this view. Include paused schedules or add a scheduled check.</p> : null}
  </section>;
}
