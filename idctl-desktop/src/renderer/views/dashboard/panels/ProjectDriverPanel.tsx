import { useEffect, useMemo, useState } from 'react';
import type { ProjectEntry, ProjectPolicy } from '../../../../../../idctl/src/settings/schema.ts';
import type { Task } from '../../../../../../idctl/src/api/types.ts';
import { call, type FleetStore } from '../../../store.ts';

type SubTask = { title: string; description: string; agent: string; dependsOn: number[] };
type CreatePlanResult = { created?: Array<{ ok?: boolean; ref?: string; title?: string; agent?: string; error?: string; deferred?: boolean }>; dispatched?: number; deferred?: number };

function teamOf(agent: FleetStore['allAgents'][number]): string {
  return String(agent.team ?? agent.teamName ?? '');
}

function newProject(name: string, team: string): ProjectEntry {
  const now = Date.now();
  return {
    id: `p_${now.toString(36)}`,
    name: name.trim() || 'New project',
    status: 'active',
    team: team || undefined,
    policy: 'balanced',
    createdAt: now,
    updatedAt: now,
  };
}

export function ProjectDriverPanel({ store, onOpenWork }: { store: FleetStore; onOpenWork?: () => void }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState<ProjectEntry>(() => newProject('', store.team || 'default'));
  const [objective, setObjective] = useState('');
  const [proposal, setProposal] = useState<SubTask[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const teamNames = useMemo(() => Array.from(new Set(['default', ...store.teams.map((team) => team.name)])).filter(Boolean), [store.teams]);
  const leads = useMemo(
    () => store.allAgents.filter((agent) => teamOf(agent) === (draft.team || 'default')).map((agent) => agent.name),
    [store.allAgents, draft.team],
  );

  const load = async () => {
    const [projectRows, taskRows] = await Promise.all([
      call<ProjectEntry[]>('projects:list').catch(() => []),
      call<Task[]>('tasks:allTeams').catch(() => []),
    ]);
    setProjects(projectRows);
    setTasks(taskRows);
    if (!projectId && projectRows[0]) {
      setProjectId(projectRows[0].id);
      setDraft(projectRows[0]);
    }
  };
  useEffect(() => { void load(); }, []);

  const selectProject = (id: string) => {
    setProjectId(id);
    const found = projects.find((project) => project.id === id);
    setDraft(found ? { ...found } : newProject('', store.team || 'default'));
    setProposal([]);
    setStatus('');
  };

  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setStatus(`${label}...`);
    try { await action(); } catch (error) { setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };

  const chooseFolder = () => act('Selecting folder', async () => {
    const path = await call<string | null>('project:pickFolder').catch(() => null);
    if (!path) { setStatus('Folder selection cancelled'); return; }
    const readme = await call<{ name?: string; description?: string }>('project:readme', path).catch((): { name?: string; description?: string } => ({}));
    setDraft((current) => ({ ...current, path, name: current.name || readme.name || path.split('/').pop() || 'Project', description: current.description || readme.description }));
    setStatus('Folder loaded; review routing and save');
  });

  const save = () => act('Saving project', async () => {
    if (!draft.name.trim()) throw new Error('Project name is required');
    const row = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
    const list = await call<ProjectEntry[]>('projects:save', row);
    setProjects(list);
    setProjectId(row.id);
    setDraft(row);
    setStatus('Project saved and routed through Manager to Brain');
  });

  const decompose = () => act('Decomposing objective', async () => {
    if (!projectId) throw new Error('Save the project before decomposing work');
    if (!objective.trim()) throw new Error('Objective is required');
    const response = await call<{ ok?: boolean; subtasks?: SubTask[]; error?: string }>('work:decompose', objective.trim(), draft.lead || '', draft.team, projectId);
    const rows = response.subtasks ?? [];
    if (!response.ok || rows.length === 0) throw new Error(response.error || 'No dispatchable tasks were proposed');
    setProposal(rows);
    setStatus(`${rows.length} proposed task${rows.length === 1 ? '' : 's'} ready for review`);
  });

  const dispatch = () => act('Dispatching reviewed work', async () => {
    if (!proposal.length) throw new Error('Decompose and review the proposal first');
    const result = await call<CreatePlanResult>('work:createPlan', objective.trim(), proposal, {
      dispatch: true,
      lane: 'todo',
      team: draft.team,
      projectId,
      planId: `dashboard-${projectId}-${Date.now().toString(36)}`,
      coordinator: draft.lead,
      respectOwners: true,
    });
    await load();
    const failed = (result.created ?? []).filter((row) => !row.ok);
    setStatus(failed.length
      ? `${result.dispatched ?? 0} dispatched; ${failed.length} deferred or blocked - review Work`
      : `${result.dispatched ?? 0} task${result.dispatched === 1 ? '' : 's'} dispatched`);
  });

  const triage = () => act('Triaging project queue', async () => {
    await call('work:triage', draft.lead || '', draft.team, projectId);
    await load();
    setStatus('Project queue triaged');
  });

  const projectTasks = tasks
    .filter((task) => task.projectId === projectId)
    .sort((a, b) => Number(b.updatedAt ?? b.createdAt ?? 0) - Number(a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, 8);

  return (
    <div className="driver-panel">
      <div className="driver-toolbar">
        <select value={projectId} onChange={(event) => selectProject(event.target.value)}>
          <option value="">New project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className="btn" disabled={busy} onClick={() => selectProject('')}>New</button>
        <button className="btn" disabled={busy} onClick={() => void chooseFolder()}>Choose folder</button>
      </div>

      <div className="driver-fields">
        <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Team<select value={draft.team || ''} onChange={(event) => setDraft({ ...draft, team: event.target.value, lead: '' })}>{teamNames.map((team) => <option key={team}>{team}</option>)}</select></label>
        <label>Accountable lead<select value={draft.lead || ''} onChange={(event) => setDraft({ ...draft, lead: event.target.value })}><option value="">Auto-select</option>{leads.map((lead) => <option key={lead}>{lead}</option>)}</select></label>
        <label>Policy<select value={draft.policy || 'balanced'} onChange={(event) => setDraft({ ...draft, policy: event.target.value as ProjectPolicy })}><option value="balanced">Balanced</option><option value="review-first">Review first</option><option value="fast-track">Fast track</option></select></label>
        <label className="driver-wide">Description<textarea value={draft.description || ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => void save()}>Save routing</button>

      <hr />
      <label className="driver-objective">Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Define the outcome this project should deliver" /></label>
      <div className="driver-toolbar">
        <button className="btn primary" disabled={busy || !projectId} onClick={() => void decompose()}>Decompose</button>
        <button className="btn" disabled={busy || !proposal.length} onClick={() => void dispatch()}>Dispatch reviewed work</button>
        <button className="btn" disabled={busy || !projectId} onClick={() => void triage()}>Triage queue</button>
      </div>

      {proposal.length ? <section className="driver-proposal"><h4>Review proposal</h4>{proposal.map((task, index) => <div className="driver-task" key={`${task.title}-${index}`}><input value={task.title} onChange={(event) => setProposal((rows) => rows.map((row, i) => i === index ? { ...row, title: event.target.value } : row))} /><select value={task.agent} onChange={(event) => setProposal((rows) => rows.map((row, i) => i === index ? { ...row, agent: event.target.value } : row))}>{store.allAgents.filter((agent) => teamOf(agent) === (draft.team || 'default')).map((agent) => <option key={agent.id || agent.name}>{agent.name}</option>)}</select><button className="btn icon-danger" title="Remove proposed task" onClick={() => setProposal((rows) => rows.filter((_, i) => i !== index))}>x</button></div>)}</section> : null}

      <section className="driver-watch"><div className="driver-heading"><h4>Project activity</h4>{onOpenWork ? <button className="btn" onClick={onOpenWork}>Open Work</button> : null}</div>{projectTasks.length ? projectTasks.map((task) => <div className="driver-task-row" key={task.uuid || task.shortId || task.name}><span>{task.title}</span><span className="muted">{task.ownerName || 'needs assignment'} · {task.status}</span></div>) : <div className="muted">No team tasks yet.</div>}</section>
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
