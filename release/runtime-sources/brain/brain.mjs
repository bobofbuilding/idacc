#!/usr/bin/env node
/**
 * Brain — agent knowledge graph + memory server.
 *
 * Thin entrypoint for the persistent skill knowledge graph and agent memory store.
 * The HTTP API, database layer, dashboards, and maintenance jobs live in focused
 * ESM modules; this file preserves `node brain.mjs` and `node brain.mjs seed ...`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { CORS_ALLOWED_ORIGINS, DB_PATH, PORT } from './config.mjs';
import { db, STMT, ftsAvailable, sqliteVecStatus, upsertNode } from './db.mjs';
import { checkpointAndVacuum, pruneTimeline } from './maintenance.mjs';
import { createBrainServer, routeInventoryReport } from './routes.mjs';
import { startParentDeathWatchdog } from './parent-watchdog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function launchStartupOnchainSync() {
  if (String(process.env.BRAIN_SYNC_ONCHAIN ?? '').toLowerCase() !== 'true') return;
  try {
    const { execFile } = await import('node:child_process');
    const script = resolve(HERE, process.env.BRAIN_SYNC_ONCHAIN_SCRIPT || 'sync-onchain.mjs');
    const env = {
      ...process.env,
      BRAIN_SYNC_TRIGGER: 'startup',
      BRAIN_URL: process.env.BRAIN_URL || `http://127.0.0.1:${PORT}`,
    };
    console.log('[brain] startup sync launched');
    const child = execFile(process.execPath, [script, '--startup'], { cwd: HERE, env }, (error, stdout, stderr) => {
      if (error) {
        console.warn(`[brain] startup sync error: ${error.message}`);
        if (stderr?.trim()) console.warn(stderr.trim());
        return;
      }
      console.log('[brain] startup sync complete');
      if (stdout?.trim()) console.log(stdout.trim());
      if (stderr?.trim()) console.warn(stderr.trim());
    });
    console.log(`[brain] startup sync child pid=${child.pid ?? 'unknown'}`);
  } catch (error) {
    console.warn(`[brain] startup sync error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Seed CLI ─────────────────────────────────────────────────────────────────

if (process.argv[2] === 'seed') {
  const file = process.argv[3];
  if (!file) { console.error('Usage: node brain.mjs seed <skills.json>'); process.exit(1); }
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const skills = Array.isArray(raw) ? raw : (raw.skills ?? []);
  let count = 0;
  for (const s of skills) { upsertNode(s); count++; }
  console.log(`[Brain] Seeded ${count} skills into ${DB_PATH}`);
  process.exit(0);
}

// ─── Start ────────────────────────────────────────────────────────────────────

if (pruneTimeline() > 0) checkpointAndVacuum();

const server = createBrainServer({ corsAllowedOrigins: CORS_ALLOWED_ORIGINS });
let shuttingDown = false;
let stopParentWatchdog = () => {};

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopParentWatchdog();
  console.log(`[Brain] Shutting down (${reason})`);
  await new Promise((resolveShutdown) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveShutdown();
    };
    const timeout = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch {}
      finish();
    }, 3_000);
    timeout.unref?.();
    try { server.close(finish); } catch { finish(); }
  });
  try { db.close(); } catch {}
  process.exit(0);
}

server.listen(PORT, '127.0.0.1', () => {
  const nodeCount = STMT.nodeCount.get().c;
  const routes = routeInventoryReport();
  console.log(`[Brain] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[Brain] DB: ${DB_PATH} (${nodeCount} nodes, FTS5: ${ftsAvailable})`);
  console.log(`[Brain] sqlite-vec: ${sqliteVecStatus().available ? 'available' : 'disabled'}`);
  console.log(`[Brain] Routes: ${routes.count} registered, critical learning skew: ${routes.skew ? `yes (${routes.missing.join(', ')})` : 'no'}`);
  void launchStartupOnchainSync();
});

stopParentWatchdog = startParentDeathWatchdog(() => shutdown('parent-exit'));
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('exit', () => stopParentWatchdog());
