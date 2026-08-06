#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(String(args[index + 1]));
  }
  return values;
}

function fail(message) {
  throw new Error(message);
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function runRsync(source, destination, verify = false) {
  const rsyncArgs = verify
    ? ['-anic', `${source}${sep}`, `${destination}${sep}`]
    : ['-a', `${source}${sep}`, `${destination}${sep}`];
  const result = spawnSync('/usr/bin/rsync', rsyncArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`workspace ${verify ? 'verification' : 'copy'} failed for ${source}: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  const output = String(result.stdout || '').trim();
  if (verify && output) {
    fail(`workspace verification found uncopied changes for ${source}: ${output.split('\n').slice(0, 10).join('; ')}`);
  }
}

const profile = resolve(option('--profile'));
if (!option('--profile')) fail('--profile is required');
const databasePath = resolve(option('--manager-db', resolve(profile, 'manager', 'id-agents.db')));
if (!existsSync(databasePath)) fail(`Manager database not found at ${databasePath}`);
const allowedRoots = options('--allow-root').map((path) => realpathSync(resolve(path)));
if (!allowedRoots.length) fail('at least one --allow-root is required');
const destinationRoot = resolve(profile, 'workspace', 'agents');
mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA busy_timeout = 10000');
const agents = db.prepare(
  'SELECT id, team_id, name, working_directory FROM agents ORDER BY id',
).all();
const copies = [];

for (const agent of agents) {
  const sourceValue = String(agent.working_directory || '').trim();
  if (!sourceValue) fail(`agent ${agent.id} has no working directory`);
  const source = realpathSync(resolve(sourceValue));
  const destination = resolve(destinationRoot, String(agent.id));
  if (!inside(destination, destinationRoot)) fail(`unsafe destination for agent ${agent.id}`);
  if (inside(source, destinationRoot)) {
    copies.push({
      agentId: String(agent.id),
      teamId: String(agent.team_id || ''),
      name: String(agent.name || ''),
      source,
      destination: source,
      copied: false,
      verified: true,
    });
    continue;
  }
  if (!allowedRoots.some((root) => inside(source, root))) {
    fail(`agent ${agent.id} source is outside the approved legacy roots: ${source}`);
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  runRsync(source, destination, false);
  runRsync(source, destination, true);
  copies.push({
    agentId: String(agent.id),
    teamId: String(agent.team_id || ''),
    name: String(agent.name || ''),
    source,
    destination,
    copied: true,
    verified: true,
  });
}

db.exec('BEGIN IMMEDIATE');
try {
  const update = db.prepare('UPDATE agents SET working_directory = ? WHERE id = ?');
  for (const copy of copies) update.run(copy.destination, copy.agentId);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

const receiptPath = resolve(option(
  '--receipt',
  resolve(profile, 'migration-receipts', `agent-workspaces-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`),
));
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(receiptPath, `${JSON.stringify({
  schemaVersion: 1,
  operation: 'relocate-agent-workspaces',
  completedAt: new Date().toISOString(),
  profile,
  databasePath,
  destinationRoot,
  agentCount: copies.length,
  copiedCount: copies.filter((copy) => copy.copied).length,
  copies,
}, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  receipt: receiptPath,
  agentCount: copies.length,
  copiedCount: copies.filter((copy) => copy.copied).length,
  destinationRoot,
}, null, 2));
