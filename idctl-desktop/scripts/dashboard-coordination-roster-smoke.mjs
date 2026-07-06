import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dashboard = await readFile(new URL('../src/renderer/views/Dashboard.tsx', import.meta.url), 'utf8');

assert.match(
  dashboard,
  /coordinationTeams\s*=\s*useMemo/,
  'Dashboard should keep a separate HR-roster team list for Live Coordination',
);
assert.match(
  dashboard,
  /\.\.\.hier\.teams[\s\S]*\.\.\.store\.allAgents\.map\(\(a\) => a\.team \?\? ''\)[\s\S]*\.\.\.Object\.keys\(hier\.coordinators\)[\s\S]*\.\.\.hier\.secondaries\.flatMap/,
  'Live Coordination teams should include hierarchy teams, all-agent team tags, configured coordinators, and secondary coverage',
);
assert.match(
  dashboard,
  /<CoordinationTree[^>]+coordinationTeams=\{coordinationTeams\}/,
  'Dashboard should pass the full HR-roster team list into the coordination tree',
);
assert.doesNotMatch(
  dashboard,
  /<CoordinationTree[^>]+activeTeams=\{activeTeams\}/,
  'Dashboard must not filter the coordination tree down to currently active teams',
);
