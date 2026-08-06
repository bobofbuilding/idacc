// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { call } from '../../../store.ts';
import type { Task } from '../../../../../../idctl/src/api/types.ts';
import type { CommandEnvironment } from '../../../dashboard/commandRuntime.ts';
import {
  DRAWER_COMMANDS,
  drawerCommandStatus,
  runDrawerCommand,
} from '../../../dashboard/drawerCommands.ts';
import { useDrawerGuard, type DrawerGuardReporter } from '../drawerGuard.ts';

const LANES = ['', 'backlog', 'ready', 'blocked', 'under-review', 'rework', 'done'];
function ref(task: Task): string { return task.shortId || task.name || task.uuid || task.title; }

export function BoardPanel({
  onOpenWork,
  commandEnvironment,
  onGuardChange,
}: {
  onOpenWork: () => void;
  commandEnvironment: CommandEnvironment;
  onGuardChange?: DrawerGuardReporter;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lanes, setLanes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busyCount, setBusyCount] = useState(0);
  const load = async () => {
    const [rows, overlay] = await Promise.all([
      call<Task[]>('tasks:allTeams').catch(() => []),
      call<Record<string, string>>('tasks:lanes').catch(() => ({})),
    ]);
    setTasks(rows.filter((task) => !/done|complete/i.test(task.status)).slice(0, 30));
    setLanes(overlay);
  };
  useEffect(() => { void load(); }, []);
  useDrawerGuard(
    onGuardChange,
    false,
    busyCount > 0,
    busyCount > 0 ? 'A task lane update is still running.' : undefined,
  );
  const setLane = async (taskRef: string, lane: string) => {
    setBusyCount((count) => count + 1);
    setLanes((current) => ({ ...current, [taskRef]: lane }));
    const result = await runDrawerCommand({
      metadata: DRAWER_COMMANDS.boardLane,
      environment: commandEnvironment,
      label: 'Update task lane',
      resourceRefs: [`task:${taskRef}`, `lane:${lane || 'automatic'}`],
      operation: () => call<Record<string, string>>('tasks:setLane', taskRef, lane),
    });
    if (result.receipt.state === 'succeeded' && result.value) {
      setLanes(result.value);
      setStatus(`Updated ${taskRef}.`);
    } else {
      setStatus(drawerCommandStatus('Update task lane', result));
      await load();
    }
    setBusyCount((count) => Math.max(0, count - 1));
  };
  return (
    <div className="driver-panel">
      <div className="driver-heading"><strong>Active board</strong><span className="muted small">{tasks.length} open shown</span><button className="btn" onClick={onOpenWork}>Open Work</button></div>
      <button className="btn" onClick={() => void load()}>Refresh</button>
      {tasks.map((task) => {
        const taskRef = ref(task);
        return <div className="driver-task-row" key={`${task.teamName ?? ''}:${taskRef}`}>
          <span><strong>{task.title}</strong><br /><span className="muted small">{task.teamName ?? 'default'} · {task.ownerName ?? 'needs assignment'} · {task.status}</span></span>
          <select disabled={busyCount > 0} value={lanes[taskRef] ?? ''} onChange={(event) => void setLane(taskRef, event.target.value)}>
            {LANES.map((lane) => <option value={lane} key={lane}>{lane || 'automatic lane'}</option>)}
          </select>
        </div>;
      })}
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
