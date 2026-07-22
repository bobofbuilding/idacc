import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const graph = await readFile(new URL('../src/renderer/views/TeamGraph.tsx', import.meta.url), 'utf8');
const teams = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');

assert.ok(
  graph.includes('Responsive top-down organization chart')
    && graph.includes('new ResizeObserver(update)')
    && graph.includes('Math.min(4'),
  'Structure should use a responsive, bounded top-down team layout',
);
assert.ok(
  graph.includes('configuredCoordinator(hier, group.team)')
    && graph.includes('secondary.leadsTeams.includes(group.team)')
    && graph.includes("kind: 'validation'"),
  'Structure should derive primary, coordinator, and validator layers from the configured hierarchy',
);
assert.ok(
  graph.includes('export interface RelayPolicy')
    && graph.includes("policy.delegates === null || policy.delegates.includes('*')")
    && graph.includes("kind: 'relay'")
    && graph.includes('relay routes')
    && graph.includes("relays.filter((entry) => entry.team === selectedTeam)"),
  'Structure should summarize fleet relay routes and trace only the selected team to avoid path noise',
);
assert.ok(
  graph.includes("const reset = () => frame.scrollTo({ top: 0, left: 0 })")
    && graph.includes('window.requestAnimationFrame(reset)')
    && graph.includes("overflowAnchor: 'none'")
    && graph.includes('const topologyKey = useMemo'),
  'Structure should return to the hierarchy root when team membership or lead topology changes',
);
assert.ok(
  teams.includes("if (tab !== 'structure' && (tab !== 'route' || routePane !== 'overview')) return;")
    && teams.includes('relays={visibleRelayMatrix}'),
  'Structure should refresh and pass the persisted fleet relay matrix',
);

console.log('team structure chart smoke: ok');
