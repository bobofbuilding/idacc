// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { call } from '../../../store.ts';
import type { Task } from '../../../../../../idctl/src/api/types.ts';

const LANES = ['', 'backlog', 'ready', 'blocked', 'under-review', 'rework', 'done'];
function ref(task: Task): string { return task.shortId || task.name || task.uuid || task.title; }

export function BoardPanel({ onOpenWork }: { onOpenWork: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lanes, setLanes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const load = async () => {
    const [rows, overlay] = await Promise.all([
      call<Task[]>('tasks:allTeams').catch(() => []),
      call<Record<string, string>>('tasks:lanes').catch(() => ({})),
    ]);
    setTasks(rows.filter((task) => !/done|complete/i.test(task.status)).slice(0, 30));
    setLanes(overlay);
  };
  useEffect(() => { void load(); }, []);
  const setLane = async (taskRef: string, lane: string) => {
    setLanes((current) => ({ ...current, [taskRef]: lane }));
    try { setLanes(await call<Record<string, string>>('tasks:setLane', taskRef, lane)); setStatus(`Updated ${taskRef}.`); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); await load(); }
  };
  return (
    <div className="driver-panel">
      <div className="driver-heading"><strong>Active board</strong><span className="muted small">{tasks.length} open shown</span><button className="btn" onClick={onOpenWork}>Open Work</button></div>
      <button className="btn" onClick={() => void load()}>Refresh</button>
      {tasks.map((task) => {
        const taskRef = ref(task);
        return <div className="driver-task-row" key={`${task.teamName ?? ''}:${taskRef}`}>
          <span><strong>{task.title}</strong><br /><span className="muted small">{task.teamName ?? 'default'} · {task.ownerName ?? 'needs assignment'} · {task.status}</span></span>
          <select value={lanes[taskRef] ?? ''} onChange={(event) => void setLane(taskRef, event.target.value)}>
            {LANES.map((lane) => <option value={lane} key={lane}>{lane || 'automatic lane'}</option>)}
          </select>
        </div>;
      })}
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
