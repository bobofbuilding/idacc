#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(desktop, 'resources', 'idacc-runtime');
const manager = resolve(process.env.IDACC_MANAGER_SOURCE || join(desktop, '..', '..', 'id-agents'));
const brain = resolve(process.env.IDACC_BRAIN_SOURCE || join(manager, 'workspace', 'projects', 'brain'));

function requirePath(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}; set the corresponding IDACC_*_SOURCE variable`);
}

requirePath(join(manager, 'package.json'), 'manager source');
requirePath(join(manager, 'dist', 'start-agent-manager.js'), 'built manager runtime');
requirePath(join(brain, 'brain.mjs'), 'Brain source');
requirePath(join(brain, 'package-lock.json'), 'Brain lockfile');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const managerTarget = join(target, 'manager');
mkdirSync(managerTarget, { recursive: true });
for (const name of ['dist', 'configs', 'skills', 'plugins', 'package.json', 'package-lock.json', 'LICENSE']) {
  const source = join(manager, name);
  if (existsSync(source)) cpSync(source, join(managerTarget, name), { recursive: true });
}

const brainTarget = join(target, 'brain');
mkdirSync(brainTarget, { recursive: true });
// Copy runtime code and static assets from the working source, including new
// runtime modules that have not been committed yet. Explicit allowlists keep
// personal databases, uploads, plans, output, tests, and repository metadata
// out of the consumer artifact.
for (const name of ['listener', 'context', 'cycle', 'mcp', 'dashboard', 'seeds', 'prompts', 'routes']) {
  const source = join(brain, name);
  if (existsSync(source)) cpSync(source, join(brainTarget, name), { recursive: true });
}
for (const name of [
  'package.json', 'package-lock.json', 'LICENSE',
  ...execFileSync('/bin/ls', ['-1', brain], { encoding: 'utf8' })
    .split('\n')
    .filter((name) => name.endsWith('.mjs')),
]) {
  const source = join(brain, name);
  if (existsSync(source)) cpSync(source, join(brainTarget, name));
}

for (const root of [managerTarget, brainTarget]) {
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts=false'], { cwd: root, stdio: 'inherit' });
  // Apply compatible transitive security updates inside the immutable staged
  // runtime without mutating either upstream source checkout.
  spawnSync('npm', ['audit', 'fix', '--omit=dev'], { cwd: root, stdio: 'inherit' });
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(audit.stdout || '{}');
  const vulnerabilities = report.metadata?.vulnerabilities || {};
  if ((vulnerabilities.high || 0) > 0 || (vulnerabilities.critical || 0) > 0) {
    throw new Error(`production runtime audit failed in ${root}: ${vulnerabilities.high || 0} high, ${vulnerabilities.critical || 0} critical`);
  }
}

// The manager is executed by Electron in Node mode in the packaged app.
// Rebuild its SQLite addon for Electron's ABI rather than the release
// workstation's system-Node ABI.
const electronVersion = JSON.parse(readFileSync(join(desktop, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
execFileSync('npm', ['rebuild', 'better-sqlite3', `--target=${electronVersion}`, '--runtime=electron', '--dist-url=https://electronjs.org/headers'], {
  cwd: managerTarget,
  stdio: 'inherit',
});

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  manager: JSON.parse(readFileSync(join(managerTarget, 'package.json'), 'utf8')).version,
  brain: JSON.parse(readFileSync(join(brainTarget, 'package.json'), 'utf8')).version,
};
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`staged unified runtime → ${target}`);
