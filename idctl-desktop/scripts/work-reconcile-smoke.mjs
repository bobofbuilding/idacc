import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/renderer/views/Tasks.tsx'), 'utf8');

assert.match(
  source,
  /call<ReconcileReport>\('remote', '\/task reconcile --all --limit 20 --force'\)/,
  'Reconcile must use the manager-owned deterministic recovery command',
);
assert.match(
  source,
  /const holdingTasks = tasks\.filter/,
  'Reconcile must count the complete Holding Pattern rather than stalled doing tasks only',
);
assert.match(
  source,
  /workflowState === 'failed'\) return colOf\(t\.status\) === 'done' \? 'done' : 'holding'/,
  'Terminal failed outcomes must remain auditable in Done instead of appearing as actionable Holding work',
);
assert.match(
  source,
  /automatically routes Under Review and Holding Pattern tasks through bounded team-lead triage/,
  'The Work page must explain that both waiting lanes are automatically triaged',
);
assert.match(
  source,
  /const waitingRouted = report\.waiting\?\.routed \?\? 0/,
  'Reconcile must report how many waiting tasks were routed',
);
assert.match(
  source,
  /Reconciling \$\{waitingCount\} waiting/,
  'Reconcile progress must include both waiting columns',
);
assert.match(
  source,
  /\(\?:unknown\|unsupported\).*\(\?:command\|subcommand\).*reconcile.*usage:.*\\\/task/is,
  'Older managers need a bounded compatibility fallback',
);

console.log('work reconcile smoke passed');
