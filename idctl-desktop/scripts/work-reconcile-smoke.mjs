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
  /automatically recovers exhausted validation, triages stalled owners, and assigns unowned work/,
  'The Work page must explain that manager reconciliation is automatic',
);
assert.match(
  source,
  /\(\?:unknown\|unsupported\).*\(\?:command\|subcommand\).*reconcile.*usage:.*\\\/task/is,
  'Older managers need a bounded compatibility fallback',
);

console.log('work reconcile smoke passed');
