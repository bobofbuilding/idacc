import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppProfilePaths } from '../src/main/appProfile.ts';
import {
  importHistoricalMemoryPayloads,
  retireVerifiedLegacyStorage,
  storageRecoveryStatus,
} from '../src/main/storageRecovery.ts';

const temp = mkdtempSync(join(tmpdir(), 'idacc-storage-recovery-'));
const root = join(temp, 'profiles', 'default');
const paths: AppProfilePaths = {
  root,
  config: join(root, 'config', 'config.json'),
  brain: join(root, 'brain'),
  manager: join(root, 'manager'),
  workspace: join(root, 'workspace'),
  logs: join(root, 'logs'),
  cache: join(root, 'cache'),
};

function createBrain(path: string, memories: Array<{ agent: string; key: string; content: string }>): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, mem_key TEXT,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'active', durable_metadata TEXT NOT NULL DEFAULT '{}', source_ids TEXT NOT NULL DEFAULT '[]',
      confidence REAL, project TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '', turn_id TEXT NOT NULL DEFAULT '', supersedes INTEGER, superseded_by INTEGER,
      expires_at INTEGER, last_volunteered_at INTEGER, last_used_at INTEGER, ignored_count INTEGER NOT NULL DEFAULT 0,
      volunteered_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, harmful_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      memory_tier TEXT NOT NULL DEFAULT 'long_term'
    );
  `);
  const insert = db.prepare('INSERT INTO agent_memories(agent_id,mem_key,content,created_at,updated_at) VALUES(?,?,?,?,?)');
  for (const [index, memory] of memories.entries()) insert.run(memory.agent, memory.key, memory.content, 100 + index, 100 + index);
  db.close();
}

try {
  for (const path of Object.values(paths)) mkdirSync(path.endsWith('.json') ? join(path, '..') : path, { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, '{}\n', { mode: 0o600 });
  createBrain(join(paths.brain, 'brain.db'), [{ agent: 'manager', key: 'status', content: 'current' }]);
  const manager = new DatabaseSync(join(paths.manager, 'id-agents.db'));
  manager.exec('CREATE TABLE state(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO state(value) VALUES(\'ok\');');
  manager.close();

  const legacy = join(root, 'backups', 'legacy-brain');
  createBrain(join(legacy, 'brain-20260101.db'), [
    { agent: 'manager', key: 'status', content: 'old-one' },
    { agent: 'lead', key: 'learning', content: 'old-two' },
  ]);
  createBrain(join(legacy, 'brain-20260102.db'), [
    { agent: 'manager', key: 'status', content: 'current' },
  ]);
  for (const day of ['20260101', '20260102', '20260103', '20260104']) {
    createBrain(join(root, 'backups', 'brain', `brain-${day}.db`), [{ agent: 'manager', key: 'status', content: `backup-${day}` }]);
  }
  for (const path of [
    join(root, 'migration-archives', 'done'),
    join(root, 'backups', 'pre-v0.1.701'),
    join(root, 'backups', 'legacy-manager'),
    join(paths.brain, '.pre-legacy-brain-import'),
    join(paths.manager, '.pre-legacy-manager-import'),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, 'retired.dat'), 'retired', { mode: 0o600 });
  }

  const before = storageRecoveryStatus(paths);
  assert.equal(before.historicalPayloadsFound, 2);
  assert.equal(before.recoveryComplete, false);
  const imported = importHistoricalMemoryPayloads(paths, { userConfirmed: true, expectedPayloads: 2 });
  assert.equal(imported.importedNow, 2);
  assert.equal(imported.verifiedRows, 2);
  assert.equal(imported.recoveryComplete, true);
  const brain = new DatabaseSync(join(paths.brain, 'brain.db'), { readOnly: true });
  assert.equal((brain.prepare("SELECT COUNT(*) count FROM agent_memories WHERE status='retired'").get() as { count: number }).count, 2);
  assert.equal((brain.prepare("SELECT COUNT(*) count FROM agent_memories WHERE status='active' AND content='current'").get() as { count: number }).count, 1);
  brain.close();

  const cleaned = retireVerifiedLegacyStorage(paths, { userConfirmed: true, expectedImported: 2 });
  assert.ok(cleaned.removedBytes > 0);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(join(root, 'migration-archives')), false);
  assert.equal(readdirSync(join(root, 'backups', 'brain')).filter((name) => /^brain-\d{8}\.db$/.test(name)).length, 3);
  assert.equal(cleaned.historicalPayloadsImported, 2);
  console.log('storage recovery smoke: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// A renderer crash/reload must never turn a prior UI confirmation into a
// storage mutation.  The protected main process owns both confirmation gates;
// the renderer can only request them and displays the result.
const mainSource = readFileSync(join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');
assert.match(mainSource, /buttons: \['Cancel', 'Preserve histories'\][\s\S]*?cancelId: 0/);
assert.match(mainSource, /buttons: \['Cancel', 'Create backup and retire copies'\][\s\S]*?cancelId: 0/);
assert.match(mainSource, /Historical-memory preservation was cancelled\. No data was changed/);
assert.match(mainSource, /Legacy-storage retirement was cancelled\. No data was changed/);
const settingsSource = readFileSync(join(process.cwd(), 'src', 'renderer', 'views', 'Settings.tsx'), 'utf8');
const recoveryActions = settingsSource.slice(
  settingsSource.indexOf('async function importHistoricalMemoryHistory()'),
  settingsSource.indexOf('async function downloadVerifiedUpdate()'),
);
assert.doesNotMatch(recoveryActions, /window\.confirm/);
assert.match(recoveryActions, /Waiting for protected confirmation/);
console.log('storage recovery authorization gate: ok');
