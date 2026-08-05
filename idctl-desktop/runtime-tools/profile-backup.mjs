#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = resolve(process.env.BRAIN_DB_PATH || '');
const backupRoot = resolve(process.env.IDACC_BRAIN_BACKUP_DIR || '');
const keepDays = Math.max(1, Number(process.env.IDACC_BRAIN_BACKUP_KEEP_DAYS || 14));
const targetHour = Math.min(23, Math.max(0, Number(process.env.IDACC_BRAIN_BACKUP_HOUR || 3)));
const targetMinute = Math.min(59, Math.max(0, Number(process.env.IDACC_BRAIN_BACKUP_MINUTE || 30)));

if (!process.env.BRAIN_DB_PATH || !existsSync(databasePath)) {
  throw new Error(`profile Brain database not found at ${databasePath}`);
}
if (!process.env.IDACC_BRAIN_BACKUP_DIR) throw new Error('IDACC_BRAIN_BACKUP_DIR is required');
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

function dayStamp(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value) => String(value).padStart(2, '0'))
    .join('');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function verified(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return String(db.prepare('PRAGMA quick_check').get().quick_check) === 'ok';
  } finally {
    db.close();
  }
}

function prune() {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(backupRoot)) {
    if (!/^brain-\d{8}\.db$/.test(name)) continue;
    const path = join(backupRoot, name);
    if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
  }
}

function createBackup() {
  const destination = join(backupRoot, `brain-${dayStamp()}.db`);
  if (existsSync(destination)) {
    if (!verified(destination)) throw new Error(`existing daily backup failed verification: ${destination}`);
    prune();
    console.log(`[profile-backup] verified existing ${destination}`);
    return;
  }
  const temporary = join(backupRoot, `.brain-${process.pid}-${randomBytes(8).toString('hex')}.db`);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlString(temporary)}`);
  } finally {
    source.close();
  }
  try {
    if (!verified(temporary)) throw new Error('backup quick_check did not return ok');
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    prune();
    console.log(`[profile-backup] created ${destination} (${statSync(destination).size} bytes)`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function nextDelay() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

let timer;
let stopping = false;
function schedule() {
  if (stopping) return;
  timer = setTimeout(() => {
    try {
      createBackup();
    } catch (error) {
      console.error(`[profile-backup] ${error instanceof Error ? error.message : String(error)}`);
    }
    schedule();
  }, nextDelay());
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  });
}

createBackup();
schedule();
