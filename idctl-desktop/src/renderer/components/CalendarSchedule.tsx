/** Shared calendar controls; the owning flow still verifies and saves its schedule. */
export const CALENDAR_DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']] as const;
export function CalendarSchedule({ time, days, disabled, onTime, onDays }: {
  time: string; days: string[]; disabled?: boolean; onTime: (value: string) => void; onDays: (value: string[]) => void;
}) {
  return <span className="row-actions" role="group" aria-label="Schedule time and days">
    <label>Time <input type="time" value={time} disabled={disabled} onChange={(event) => onTime(event.target.value)} /></label>
    {CALENDAR_DAYS.map(([day, label]) => <button type="button" key={day} className={`btn small${days.includes(day) ? ' primary' : ''}`} disabled={disabled} aria-pressed={days.includes(day)} onClick={() => onDays(CALENDAR_DAYS.map(([id]) => id).filter((id) => id === day ? !days.includes(day) : days.includes(id)))}>{label}</button>)}
    <span className="muted small">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
  </span>;
}
