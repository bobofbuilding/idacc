#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'idacc-dashboard-events-'));
try {
  const outfile = join(dir, 'dashboard-events.mjs');
  await build({
    entryPoints: [new URL('../src/shared/dashboardEvents.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const { isDashboardRelevantEvent } = await import(`file://${outfile}?v=${Date.now()}`);

  assert.equal(isDashboardRelevantEvent({ topic: 'task:claimed' }), true);
  assert.equal(isDashboardRelevantEvent({ topic: 'query:failed' }), true);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:state-updated' }), false);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:brain-write:requested' }), false);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:brain-write:delivered' }), false);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:work' }), false);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:brain-write:failed' }), true);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:work', data: { error: 'delivery failed' } }), true);
  assert.equal(isDashboardRelevantEvent({ topic: 'control:action', data: { ok: false } }), true);
  console.log('[dashboard-activity-filter-smoke] OK');
} finally {
  await rm(dir, { recursive: true, force: true });
}
