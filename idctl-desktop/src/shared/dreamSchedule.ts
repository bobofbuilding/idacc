import type { ScheduleEntry } from '../../../idctl/src/api/client.ts';

export const DREAM_SCHEDULE_MARKER = '[IDACC Dream schedule v1]';
export const DREAM_SCHEDULE_PREFIX = 'Scheduled dream:';
export const DREAM_LEGACY_SCHEDULE_PREFIX = 'Nightly dream:';
export const DREAM_DEFAULT_TIME = '03:00';
export const DREAM_DAILY_DAYS = 'mon,tue,wed,thu,fri,sat,sun';

export const DREAM_SCHEDULE_OBJECTIVE =
  `${DREAM_SCHEDULE_MARKER}\n` +
  `${DREAM_SCHEDULE_PREFIX} reflect over your recent work and the shared brain, then post a Dream Report ` +
  '(Consolidation / Insights / Ideas / Simulations). Ideas and Simulations are proposals only — do not act on them.';

export interface ScheduledDreamNewsItem {
  id?: number;
  type: string;
  timestamp: number;
  message?: string;
  query_id?: string;
  data?: Record<string, unknown>;
}

export interface ScheduledDreamArchive {
  id: string;
  title: string;
  agent: string;
  team: string;
  content: string;
  createdAt: number;
  source: {
    kind: 'schedule';
    scheduleId: string;
    queryId: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isDreamSchedule(schedule: Pick<ScheduleEntry, 'kind' | 'message'>): boolean {
  const message = String(schedule.message || '').trim();
  return schedule.kind === 'calendar' && (
    message.startsWith(DREAM_SCHEDULE_MARKER)
    || message.startsWith(DREAM_LEGACY_SCHEDULE_PREFIX)
  );
}

export function dreamScheduleTime(schedule: Pick<ScheduleEntry, 'localTimeSeconds'>): string {
  const seconds = Number(schedule.localTimeSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return DREAM_DEFAULT_TIME;
  const hour = Math.floor(seconds / 3600) % 24;
  const minute = Math.floor((seconds % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function dreamScheduleDays(schedule: Pick<ScheduleEntry, 'daysOfWeek'>): string {
  const days = String(schedule.daysOfWeek || '').trim().toLowerCase();
  return days || DREAM_DAILY_DAYS;
}

export function dreamScheduleDaysLabel(days: string | null | undefined): string {
  const normalized = String(days || '').trim().toLowerCase();
  if (!normalized || normalized === DREAM_DAILY_DAYS) return 'daily';
  if (normalized === 'mon,tue,wed,thu,fri') return 'weekdays';
  if (normalized === 'sat,sun') return 'weekends';
  return normalized.split(',').filter(Boolean).map((day) => day.slice(0, 3)).join(', ');
}

/**
 * Join a scheduled Dream's receipt row to its later completion row using the
 * exact Manager query id. The stable local id makes reconciliation idempotent.
 */
export function scheduledDreamArchives(
  schedules: ScheduleEntry[],
  newsByAgent: Record<string, ScheduledDreamNewsItem[]>,
  team: string,
): ScheduledDreamArchive[] {
  const dreamSchedules = new Map(
    schedules.filter(isDreamSchedule).map((schedule) => [schedule.id, schedule]),
  );
  const out = new Map<string, ScheduledDreamArchive>();

  for (const [agent, items] of Object.entries(newsByAgent)) {
    const receipts = new Map<string, { scheduleId: string; at: number }>();
    const completions = new Map<string, { content: string; at: number }>();

    for (const item of items || []) {
      const data = record(item.data);
      const queryId = text(data.query_id ?? data.queryId ?? item.query_id);
      if (!queryId) continue;
      if (item.type === 'schedule.received') {
        const schedule = record(data.schedule);
        const scheduleId = text(schedule.id);
        const definition = dreamSchedules.get(scheduleId);
        const durableDreamReceipt = isDreamSchedule({
          kind: text(schedule.kind) === 'calendar' ? 'calendar' : 'heartbeat',
          message: text(data.message),
        });
        if ((!definition || !definition.targets.includes(agent)) && !durableDreamReceipt) continue;
        receipts.set(queryId, { scheduleId, at: Number(item.timestamp) || 0 });
        continue;
      }
      if (item.type === 'query.completed') {
        const result = record(data.result);
        const content = text(result.result ?? data.message).trim();
        if (content) completions.set(queryId, { content, at: Number(item.timestamp) || 0 });
      }
    }

    for (const [queryId, receipt] of receipts) {
      const completed = completions.get(queryId);
      if (!completed) continue;
      const occurredAt = Math.max(completed.at, receipt.at);
      const createdAt = occurredAt > 0 ? occurredAt : Date.now();
      const id = `dream_scheduled_${queryId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      if (!id) continue;
      out.set(id, {
        id,
        title: `${agent}'s scheduled dream · ${new Date(createdAt).toLocaleString()}`,
        agent,
        team,
        content: completed.content,
        createdAt,
        source: {
          kind: 'schedule',
          scheduleId: receipt.scheduleId,
          queryId,
        },
      });
    }
  }

  return [...out.values()].sort((a, b) => b.createdAt - a.createdAt);
}
