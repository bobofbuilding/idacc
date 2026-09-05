import { learningSummary, type LearningMaterialState } from '../../shared/usability.ts';
import { useEffect, useState } from 'react';
import type { ScheduleEntry } from '../../../../idctl/src/api/client.ts';
import { call, useSyncVersion } from '../store.ts';

type GoalDriverConfig = {
  enabled: boolean;
  cadenceMs: number;
  maxOpenTasksPerGoal: number;
};

type GoalDriverStatus = {
  config: GoalDriverConfig;
  managerConfig: GoalDriverConfig | null;
  synced: boolean;
  runtime: {
    lastError?: string | null;
    lastResult?: {
      tasksSpawned?: number;
      errorCount?: number;
    };
  } | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

type UnifiedStackStatus = {
  companions?: Array<{
    name: 'brain-listener' | 'brain-cycle';
    enabled: boolean;
    running: boolean;
    healthy?: boolean;
    phase: string;
    nextStartAt?: string;
    lastSuccessfulPollAt?: string;
    error?: string;
  }>;
  brainAutomation?: {
    cycleEnabled: boolean;
    cycleCadenceHours: number;
  };
  brainCatalog?: {
    healthy: boolean;
    skillCount: number;
    error?: string;
  };
};


type WorkLearningSnapshot = {
  driver: GoalDriverStatus | null;
  stack: UnifiedStackStatus | null;
  materials: LearningMaterialState[] | null;
  schedules: ScheduleEntry[] | null;
};

const EMPTY: WorkLearningSnapshot = { driver: null, stack: null, materials: null, schedules: [] };

function timeAgo(value: number | string | null | undefined): string {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function dueText(value: number | null | undefined): string {
  if (!value) return 'next manager tick';
  const seconds = Math.round((value - Date.now()) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.ceil(seconds / 3600)}h`;
  return new Date(value).toLocaleString();
}

function cadenceText(hours: number | undefined): string {
  if (!hours) return 'scheduled';
  if (hours === 24) return 'daily';
  if (hours % 24 === 0) return `every ${hours / 24}d`;
  return `every ${hours}h`;
}

export function WorkLearningStatus() {
  const syncVersion = useSyncVersion(['goals', 'tasks', 'work', 'brain', 'materials', 'schedules', 'loops', 'dreams']);
  const [snapshot, setSnapshot] = useState<WorkLearningSnapshot>(EMPTY);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const reload = async () => {
      const [driver, stack, materials, schedules] = await Promise.all([
        call<GoalDriverStatus>('goalDriver:getStatus').catch(() => null),
        call<UnifiedStackStatus>('unifiedStack:status').catch(() => null),
        call<LearningMaterialState[]>('materials:list').catch(() => null),
        call<ScheduleEntry[]>('schedules:allTeams').catch(() => null),
      ]);
      if (!live) return;
      setSnapshot({ driver, stack, materials, schedules });
      timer = window.setTimeout(() => void reload(), 15_000);
    };
    void reload();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [syncVersion]);

  const listener = snapshot.stack?.companions?.find((item) => item.name === 'brain-listener');
  const cycle = snapshot.stack?.companions?.find((item) => item.name === 'brain-cycle');
  const automation = snapshot.stack?.brainAutomation;
  const catalog = snapshot.stack?.brainCatalog;
  const driver = snapshot.driver;
  const learning = learningSummary(snapshot.materials);
  const activeSchedules = (snapshot.schedules ?? []).filter((schedule) => schedule.active).length;
  const goalErrors = Number(driver?.runtime?.lastResult?.errorCount || 0);

  return (
    <section className="card work-learning-status" aria-label="Work and Brain automation status">
      <div className="work-learning-head">
        <div>
          <b>Active learning</b>
          <span className={`work-learning-state ${listener?.healthy ? 'ok-text' : 'warn-text'}`}>
            {listener?.healthy
              ? `running · last checked ${timeAgo(listener.lastSuccessfulPollAt)}`
              : listener?.error || listener?.phase || 'checking…'}
          </span>
          <span className={`work-learning-state ${catalog?.healthy ? 'ok-text' : 'warn-text'}`}>
            {catalog?.healthy ? `${catalog.skillCount} Brain skills` : catalog?.error || 'catalog checking…'}
          </span>
        </div>
        <span className="muted small">Work, Knowledge, and Automations share this private workspace.</span>
        <button className="btn small" onClick={() => void call('brain:openDashboard', 'learning')}>Open Brain ↗</button>
      </div>

      <div className="work-learning-grid">
        <div>
          <span className="muted small">Goal autopilot</span>
          <b className={driver?.synced === false ? 'warn-text' : ''}>
            {!driver ? 'checking…' : !driver.config.enabled ? 'off' : driver.synced ? dueText(driver.nextRunAt) : 'syncing Manager settings'}
          </b>
          <span className="muted small">
            {driver?.lastRunAt ? `last cycle ${timeAgo(driver.lastRunAt)}` : 'no completed cycle yet'}
            {driver ? ` · up to ${driver.config.maxOpenTasksPerGoal} starts/cycle` : ''}
            {goalErrors ? ` · ${goalErrors} warning${goalErrors === 1 ? '' : 's'}` : ''}
          </span>
          <span className="muted small">Goal starts may delegate child tasks afterward</span>
        </div>
        <div>
          <span className="muted small">Learn queue</span>
          <b>{learning.label}</b>
          <span className="muted small">{learning.detail}</span>
        </div>
        <div>
          <span className="muted small">Recurring work</span>
          <b>{snapshot.schedules === null ? "Schedule status unavailable" : `${activeSchedules} active schedule${activeSchedules === 1 ? "" : "s"}`}</b>
          <span className="muted small">Review checks, workflows, and reflections in Automations</span>
        </div>
        <div>
          <span className="muted small">Brain maintenance</span>
          <b>{!automation?.cycleEnabled ? 'off' : cycle?.running ? 'running now' : cadenceText(automation.cycleCadenceHours)}</b>
          <span className="muted small">
            {!automation?.cycleEnabled ? 'event learning stays on' : cycle?.nextStartAt ? `next ${new Date(cycle.nextStartAt).toLocaleString()}` : cycle?.phase || 'scheduling…'}
          </span>
        </div>
      </div>
    </section>
  );
}
