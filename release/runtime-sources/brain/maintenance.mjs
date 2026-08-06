import { auditFactEntityIntegrity, db } from './db.mjs';

// Read-only maintenance check. It deliberately reports orphan facts without
// changing them; existing data remediation remains an explicit operator task.
export function checkFactEntityIntegrity({ limit = 25 } = {}) {
  return auditFactEntityIntegrity({ limit });
}

// ─── Expired memory cleanup (every 10 min) ────────────────────────────────────
setInterval(() => {
  db.prepare(`DELETE FROM agent_memories WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()`).run();
}, 10 * 60 * 1000).unref();

// ─── Timeline retention + maintenance ─────────────────────────────────────────
const TIMELINE_RETENTION_DAYS = Number(process.env.TIMELINE_RETENTION_DAYS ?? 90);
const TIMELINE_RETENTION_POLICY = parseTimelineRetentionPolicy({
  'query:delivered': 14,
  'watchdog:ok': 7,
  'watchdog:alert': 30,
});

export function parseTimelineRetentionPolicy(defaults) {
  const policy = { ...defaults };
  const raw = process.env.TIMELINE_RETENTION_POLICY ?? '';
  for (const entry of raw.split(',')) {
    const [type, days] = entry.split('=').map(s => s?.trim());
    if (!type) continue;
    const n = Number(days);
    if (Number.isFinite(n) && n >= 0) policy[type] = n;
  }
  return policy;
}

function rollupDeliveredTimelineBefore(cutoff) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day, count(*) AS count
    FROM timeline
    WHERE type = 'query:delivered' AND created_at < ?
    GROUP BY day
  `).all(cutoff);

  if (rows.length === 0) return 0;
  const insert = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags,created_at) VALUES (?,?,?,?,?,unixepoch())`);
  for (const row of rows) {
    insert.run(
      'rollup',
      'query:delivered:daily',
      row.day,
      JSON.stringify({ count: row.count }),
      JSON.stringify(['rollup', 'retention'])
    );
  }
  return rows.reduce((sum, row) => sum + row.count, 0);
}

export function pruneTimeline() {
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let rolledUp = 0;

  db.exec('BEGIN');
  try {
    for (const [type, days] of Object.entries(TIMELINE_RETENTION_POLICY)) {
      const cutoff = now - days * 86400;
      if (type === 'query:delivered') rolledUp += rollupDeliveredTimelineBefore(cutoff);
      const r = db.prepare(`DELETE FROM timeline WHERE type = ? AND created_at < ?`).run(type, cutoff);
      deleted += r.changes;
    }

    const policyTypes = Object.keys(TIMELINE_RETENTION_POLICY);
    const cutoff = now - TIMELINE_RETENTION_DAYS * 86400;
    let r;
    if (policyTypes.length > 0) {
      const placeholders = policyTypes.map(() => '?').join(',');
      r = db.prepare(`DELETE FROM timeline WHERE type NOT IN (${placeholders}) AND created_at < ?`).run(...policyTypes, cutoff);
    } else {
      r = db.prepare(`DELETE FROM timeline WHERE created_at < ?`).run(cutoff);
    }
    deleted += r.changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (deleted > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log(`[brain] pruned ${deleted} timeline events (rolled up ${rolledUp} query:delivered rows)`);
  }
  return deleted;
}

export function checkpointAndVacuum() {
  // VACUUM first (its rewritten pages land in the WAL), THEN checkpoint(TRUNCATE)
  // so the WAL the VACUUM produced is flushed back and truncated — otherwise the
  // main DB shrinks but a fat WAL lingers until the next prune checkpoint.
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

setInterval(pruneTimeline, 6 * 60 * 60 * 1000).unref();  // every 6h
setInterval(checkpointAndVacuum, 24 * 60 * 60 * 1000).unref();
