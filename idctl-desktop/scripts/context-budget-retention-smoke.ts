import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_BUDGET_RETENTION,
  pruneContextBudgetStorage,
} from '../src/main/contextBudget.ts';

const root = mkdtempSync(join(tmpdir(), 'idacc-context-retention-'));
try {
  process.env.IDACC_DATA_DIR = root;
  const dir = join(root, 'cache', 'context-budget');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const old = join(dir, 'cb_old.json');
  writeFileSync(old, '{}\n');
  const oldDate = new Date(now - (CONTEXT_BUDGET_RETENTION.auditDays + 2) * 24 * 60 * 60 * 1_000);
  utimesSync(old, oldDate, oldDate);
  for (let index = 0; index < CONTEXT_BUDGET_RETENTION.maxAuditRecords + 2; index += 1) {
    const file = join(dir, `cb_fresh_${String(index).padStart(4, '0')}.json`);
    writeFileSync(file, '{}\n');
    const date = new Date(now - index);
    utimesSync(file, date, date);
  }

  const result = pruneContextBudgetStorage(now);
  const remaining = readdirSync(dir).filter((name) => /^cb_.*\.json$/.test(name));
  assert.equal(remaining.includes('cb_old.json'), false);
  assert.equal(remaining.length, CONTEXT_BUDGET_RETENTION.maxAuditRecords);
  assert.equal(result.kept, CONTEXT_BUDGET_RETENTION.maxAuditRecords);
  assert.equal(result.removed, 3);
  process.stdout.write('context budget retention smoke: ok\n');
} finally {
  delete process.env.IDACC_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
}
