import { useEffect, useMemo, useState } from 'react';
import { call, type FleetStore } from '../../../store.ts';

type Hierarchy = { coordinators?: Record<string, string>; teams?: string[]; secondaries?: SecondaryLead[] };
type SecondaryLead = { agent: string; team: string; leadsTeams: string[] };

function teamOf(agent: FleetStore['allAgents'][number]): string {
  return String(agent.team ?? agent.teamName ?? '');
}

export function OrgPanel({ store, onOpenHr }: { store: FleetStore; onOpenHr?: () => void }) {
  const [hierarchy, setHierarchy] = useState<Hierarchy>({});
  const [team, setTeam] = useState('default');
  const [lead, setLead] = useState('lead');
  const [secondaryAgent, setSecondaryAgent] = useState('');
  const [secondaryTeams, setSecondaryTeams] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const row = await call<Hierarchy>('org:hierarchy').catch((): Hierarchy => ({}));
    setHierarchy(row);
    setLead(row.coordinators?.[team] || (team === 'default' ? 'lead' : ''));
  };
  useEffect(() => { void load(); }, []);
  const teams = useMemo(() => Array.from(new Set(['default', ...(hierarchy.teams ?? []), ...store.teams.map((row) => row.name)])).filter(Boolean), [hierarchy.teams, store.teams]);
  const agents = store.allAgents.filter((agent) => teamOf(agent) === team);

  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(true); setStatus(`${label}...`);
    try { await action(); } catch (error) { setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };

  const assign = () => act('Updating accountable lead', async () => {
    if (!lead) throw new Error('Choose a lead');
    await call('coordinator:set', team, lead);
    await call('org:sync', { autoRebuild: false });
    await load();
    setStatus(`${team}/${lead} is accountable and Brain is synchronized`);
  });

  const saveSecondary = () => act('Updating secondary lead scope', async () => {
    if (!secondaryAgent) throw new Error('Choose a secondary lead');
    const existing = await call<SecondaryLead[]>('org:getSecondaryLeads').catch(() => []);
    const row: SecondaryLead = { agent: secondaryAgent, team: teamOf(store.allAgents.find((agent) => agent.name === secondaryAgent)!) || 'default', leadsTeams: secondaryTeams.split(',').map((value) => value.trim()).filter(Boolean) };
    const next = [...existing.filter((item) => item.agent !== row.agent), row];
    await call('org:setSecondaryLeads', next);
    await call('org:sync', { autoRebuild: false });
    await load();
    setStatus(`${secondaryAgent} secondary scope saved`);
  });

  return <div className="driver-panel">
    <div className="driver-fields">
      <label>Team<select value={team} onChange={(event) => { const value = event.target.value; setTeam(value); setLead(hierarchy.coordinators?.[value] || (value === 'default' ? 'lead' : '')); }}>{teams.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Accountable lead<select value={lead} disabled={team === 'default'} onChange={(event) => setLead(event.target.value)}><option value="">Choose lead</option>{agents.map((agent) => <option key={agent.id || agent.name}>{agent.name}</option>)}</select></label>
    </div>
    <div className="driver-toolbar"><button className="btn primary" disabled={busy || team === 'default'} onClick={() => void assign()}>Assign lead</button><button className="btn" disabled={busy} onClick={() => void act('Synchronizing organization', async () => { await call('org:sync', { autoRebuild: false }); await load(); setStatus('Organization synchronized through Manager and Brain'); })}>Sync organization</button></div>
    {team === 'default' ? <div className="muted small">The default team is hardwired to default/lead.</div> : null}
    <hr />
    <h4>Secondary lead scope</h4>
    <div className="driver-fields"><label>Agent<select value={secondaryAgent} onChange={(event) => setSecondaryAgent(event.target.value)}><option value="">Choose agent</option>{store.allAgents.map((agent) => <option key={`${teamOf(agent)}:${agent.name}`} value={agent.name}>{teamOf(agent)}/{agent.name}</option>)}</select></label><label>Teams<input value={secondaryTeams} onChange={(event) => setSecondaryTeams(event.target.value)} placeholder="research, engineering-team" /></label></div>
    <div className="driver-toolbar"><button className="btn" disabled={busy} onClick={() => void saveSecondary()}>Save secondary scope</button>{onOpenHr ? <button className="btn" onClick={onOpenHr}>Open HR Manager</button> : null}</div>
    {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
  </div>;
}
