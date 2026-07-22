import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');

for (const label of ['▶ Start all', '■ Stop all', '◇ Probe all', '↻ Rebuild all']) {
  assert.ok(source.includes(label), `fleet Team ops should render ${label}`);
}

assert.ok(
  source.includes('async function runFleetOp(op: TeamLifecycleOp)')
    && source.includes('currentFleetSnapshots(targets)'),
  'fleet lifecycle actions should re-check current rosters after operator confirmation',
);
assert.ok(
  source.includes('Teams are processed sequentially to protect manager capacity.')
    && source.includes('for (let index = 0; index < targets.length; index += 1)'),
  'fleet lifecycle actions should use bounded sequential team dispatch',
);
assert.ok(
  source.includes("protectedAgents.length && (op === 'stop' || op === 'rebuild')"),
  'fleet stop and rebuild should surface the locked leadership guardrail',
);

console.log('team ops fleet smoke: ok');
