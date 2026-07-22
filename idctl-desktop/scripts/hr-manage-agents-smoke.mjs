import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const teams = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
const client = await readFile(new URL('../../idctl/src/api/client.ts', import.meta.url), 'utf8');

assert.ok(
  teams.includes("[['overview', 'Overview'], ['agents', 'Agents'], ['operations', 'Team ops'], ['hierarchy', 'Hierarchy']]")
    && teams.includes("routePane === 'agents'")
    && teams.includes('Teams &amp; agents'),
  'Manage should separate overview, agent records, lifecycle operations, and hierarchy',
);
assert.ok(
  client.includes('`/teams/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`'),
  'team deletion should carry the exact manager confirmation token',
);
assert.ok(
  teams.includes('Structure is read-only.')
    && teams.includes('Manage selection')
    && !teams.includes('Edit selected-agent instructions in Structure'),
  'Structure should hand mutations to Manage > Agents',
);
assert.ok(
  teams.includes('function ManagedAgentEditor()')
    && teams.includes('instruction markdown · persistent system-prompt addendum')
    && teams.includes('className="hr-agent-instructions"')
    && styles.includes('height: clamp(320px, 44vh, 520px)')
    && teams.includes('Agent goals')
    && teams.includes('move to team…'),
  'Manage > Agents should own instruction, goal, and reassignment controls',
);
assert.ok(
  teams.includes("await ensureRenderedAgentFresh('Delete agent'")
    && teams.includes("await call('agent:delete', fresh.name, team)")
    && teams.includes('isDefaultBackboneAgent(team, agent.name)'),
  'agent deletion should re-check current manager state and protect default leadership',
);
assert.ok(
  bridge.includes("'agent:delete': (agent: string, team?: string)")
    && bridge.includes('remote(`/delete ${JSON.stringify(String(agent))}`)'),
  'the renderer should delete through a team-scoped manager command',
);
assert.ok(
  teams.includes('guarded rename or merge')
    && teams.includes('runTeamMaintenance()')
    && teams.includes('openAgentDirectory(row.team)')
    && teams.includes('[maintDeleteSource, setMaintDeleteSource] = useState(false)')
    && teams.includes("await call('team:delete', source);")
    && !teams.includes("await call('team:delete', source).catch(() => {});"),
  'team administration and overview drill-down should stay inside Manage',
);
assert.ok(
  teams.includes('activeTeam !== PRIMARY_TEAM ? <RelayPolicySection /> : null')
    && teams.includes('selectedAgent.team !== PRIMARY_TEAM ? ('),
  'default-team hierarchy and agent records should not expose editable cross-team relay controls',
);

console.log('HR manage agents smoke: ok');
