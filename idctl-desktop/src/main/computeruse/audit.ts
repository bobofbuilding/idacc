/**
 * Append-only audit of every Computer Use action — the record of what an agent
 * did (or was blocked from doing) on the Mac. Three sinks:
 *  1. an in-memory ring the Computer Use view tails live,
 *  2. a retained 0600 JSONL history in the active IDACC profile,
 *  3. a best-effort mirror to the manager's /activity ring so it ALSO shows in Chat.
 * Keystrokes are recorded as a length, never the literal text, so secrets typed
 * into a field aren't written to disk.
 */
import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AuditEntry {
  ts: number;
  agent: string;
  action: string;
  detail: string;
  decision: 'executed' | 'blocked';
  reason?: string;
}

const RING: AuditEntry[] = [];
const RING_MAX = 600;

function auditDir(): string {
  const root = process.env.IDACC_DATA_DIR?.trim() || join(homedir(), '.config', 'idctl');
  const computerUse = join(root, 'computeruse');
  mkdirSync(computerUse, { recursive: true, mode: 0o700 });
  try { chmodSync(computerUse, 0o700); } catch { /* best effort */ }
  const d = join(computerUse, 'audit');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch { /* best effort */ }
  return d;
}
function dayFile(ts: number): string {
  // One file per UTC day; cheap rotation, no unbounded single file.
  const d = new Date(ts);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(auditDir(), `${stamp}.jsonl`);
}

const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_FILES = 90;
const AUDIT_MAX_BYTES = 64 * 1024 * 1024;
let lastPruneAt = 0;
let managerMirrorUrl = '';
let managerMirrorToken = '';

export function configureComputerUseAuditManager(url: string, adminToken = ''): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Computer Use audit manager URL is invalid.');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('Computer Use audit mirroring requires an explicit 127.0.0.1 manager URL.');
  }
  managerMirrorUrl = parsed.origin;
  managerMirrorToken = String(adminToken);
}

/** Drop every profile-derived in-memory sink before a startup retry or exit. */
export function resetComputerUseAuditProfileState(): void {
  RING.splice(0, RING.length);
  lastPruneAt = 0;
  managerMirrorUrl = '';
  managerMirrorToken = '';
}

export function pruneComputerUseAudit(now = Date.now()): number {
  const dir = auditDir();
  const rows = readdirSync(dir)
    .filter((name) => /^\d{8}\.jsonl$/.test(name))
    .flatMap((name) => {
      try {
        const stat = statSync(join(dir, name));
        return [{ name, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  let keptBytes = 0;
  let keptFiles = 0;
  let removed = 0;
  for (const row of rows) {
    const expired = now - row.mtimeMs > AUDIT_MAX_AGE_MS;
    const overCount = keptFiles >= AUDIT_MAX_FILES;
    const overBytes = keptBytes + row.size > AUDIT_MAX_BYTES;
    if (!expired && !overCount && !overBytes) {
      keptFiles += 1;
      keptBytes += row.size;
      continue;
    }
    try {
      rmSync(join(dir, row.name), { force: true });
      removed += 1;
    } catch { /* retry on the next audit write */ }
  }
  lastPruneAt = now;
  return removed;
}

/** Best-effort mirror to the manager so computer-use actions appear in Chat. */
function mirrorToManager(e: AuditEntry, team: string): void {
  if (!team || !managerMirrorUrl) return;
  try {
    void fetch(`${managerMirrorUrl}/activity/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Admin': '1',
        ...(managerMirrorToken ? { Authorization: `Bearer ${managerMirrorToken}` } : {}),
      },
      body: JSON.stringify({ agent: e.agent, team, kind: e.decision === 'blocked' ? 'error' : 'tool', tool: 'mac-control', summary: `${e.action}: ${e.detail}${e.decision === 'blocked' ? ` (blocked: ${e.reason})` : ''}` }),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});
  } catch { /* never let auditing throw */ }
}

export function audit(e: AuditEntry, team = ''): void {
  RING.push(e);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  try {
    if (e.ts - lastPruneAt > 24 * 60 * 60 * 1000) pruneComputerUseAudit(e.ts);
    const file = dayFile(e.ts);
    appendFileSync(file, JSON.stringify(e) + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch { /* */ }
  mirrorToManager(e, team);
}

export function recentAudit(n = 120): AuditEntry[] {
  return RING.slice(-Math.max(1, Math.min(n, RING_MAX)));
}
