#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANAGER_SOURCE = 'https://github.com/bobofbuilding/id-agents.git';
const APP_NAME = 'ID Agents Control Center.app';
const SERVICE_LABEL = 'io.bittrees.idagents-manager';
const UPDATE_SERVICE_LABEL = 'io.bittrees.idagents-manager-updater';

function usage() {
  console.log(`Usage: node scripts/install-idacc-stack.mjs [options]

Build and install IDACC, install or safely update the compatible manager, and
keep the manager running as a per-user macOS service.

Options:
  --project-dir <dir>     Stack root. Default: parent of this IDACC checkout.
  --manager-source <url>  Manager git source. Default: ${DEFAULT_MANAGER_SOURCE}
  --branch <name>         Manager branch. Default: main.
  --manager-port <port>   Manager port. Default: 4100.
  --app-dir <dir>         App destination. Default: ~/Applications.
  --dry-run               Validate and print the planned work without writing.
  --no-open               Do not open IDACC after installation.
  --no-service            Build/install only; do not change the manager service.
  --help                  Show this help.
`);
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    projectDir: dirname(REPO_ROOT),
    managerSource: DEFAULT_MANAGER_SOURCE,
    branch: 'main',
    managerPort: 4100,
    appDir: join(env.HOME || homedir(), 'Applications'),
    dryRun: false,
    open: true,
    service: true,
  };

  const takeValue = (arg, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...opts, help: true };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--no-service') opts.service = false;
    else if (arg === '--project-dir') opts.projectDir = takeValue(arg, i++);
    else if (arg === '--manager-source') opts.managerSource = takeValue(arg, i++);
    else if (arg === '--branch') opts.branch = takeValue(arg, i++);
    else if (arg === '--manager-port') opts.managerPort = Number(takeValue(arg, i++));
    else if (arg === '--app-dir') opts.appDir = takeValue(arg, i++);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(opts.managerPort) || opts.managerPort < 1 || opts.managerPort > 65535) {
    throw new Error('--manager-port must be an integer between 1 and 65535');
  }
  opts.projectDir = resolve(expandHome(opts.projectDir, env));
  opts.appDir = resolve(expandHome(opts.appDir, env));
  opts.managerDir = join(opts.projectDir, 'id-agents');
  opts.managerUrl = `http://127.0.0.1:${opts.managerPort}`;
  return opts;
}

function expandHome(value, env = process.env) {
  if (value === '~') return env.HOME || homedir();
  if (value.startsWith('~/')) return join(env.HOME || homedir(), value.slice(2));
  return value;
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(`  would run: ${commandLine(command, args)}`);
    return '';
  }
  console.log(`  running: ${commandLine(command, args)}`);
  const output = execFileSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return typeof output === 'string' ? output.trim() : '';
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function requireCommand(command) {
  const probe = tryRun('/usr/bin/env', ['which', command]);
  if (!probe.ok) throw new Error(`${command} is required but was not found on PATH`);
}

function validateRuntime(opts) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
  }
  requireCommand('git');
  requireCommand('npm');
  if (process.platform === 'darwin') requireCommand('open');
  if (opts.service && process.platform !== 'darwin') {
    throw new Error('The managed background service currently requires macOS. Pass --no-service on other platforms.');
  }
  if (opts.service) requireCommand('launchctl');
  for (const path of [join(REPO_ROOT, 'idctl', 'package-lock.json'), join(REPO_ROOT, 'idctl-desktop', 'package-lock.json')]) {
    if (!existsSync(path)) throw new Error(`IDACC checkout is incomplete; missing ${path}`);
  }
}

function installManagerCheckout(opts) {
  const args = [
    join(REPO_ROOT, 'scripts', 'install-id-agents-manager.mjs'),
    '--project-dir', opts.projectDir,
    '--target', opts.managerDir,
    '--source', opts.managerSource,
    '--branch', opts.branch,
  ];
  if (opts.dryRun) args.push('--dry-run');
  run(process.execPath, args, { dryRun: false });
}

function buildStack(opts) {
  console.log('\n1/5 Preparing the compatible manager');
  installManagerCheckout(opts);
  console.log('\n2/5 Building IDACC and the manager');
  run('npm', ['ci'], { cwd: join(REPO_ROOT, 'idctl'), dryRun: opts.dryRun });
  run('npm', ['ci'], { cwd: join(REPO_ROOT, 'idctl-desktop'), dryRun: opts.dryRun });
  run('npm', ['run', 'dist'], { cwd: join(REPO_ROOT, 'idctl-desktop'), dryRun: opts.dryRun });
  run('npm', ['ci'], { cwd: opts.managerDir, dryRun: opts.dryRun });
  run('npm', ['run', 'build'], { cwd: opts.managerDir, dryRun: opts.dryRun });
}

function findAppBundle(root) {
  if (!existsSync(root)) return undefined;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === APP_NAME) return path;
      if (!entry.name.endsWith('.app')) pending.push(path);
    }
  }
  return undefined;
}

function assertAppBundle(path) {
  const asar = join(path, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(asar)) throw new Error(`Built app is incomplete; missing ${asar}`);
}

export function installAppBundle(source, appDir, options = {}) {
  const destination = join(appDir, APP_NAME);
  if (options.dryRun) {
    console.log(`  would install: ${source} -> ${destination}`);
    return destination;
  }
  assertAppBundle(source);
  mkdirSync(appDir, { recursive: true });
  const staging = join(appDir, `.idacc-install-${process.pid}.app`);
  const backup = join(appDir, `.idacc-backup-${process.pid}.app`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });

  try {
    if (process.platform === 'darwin' && existsSync('/usr/bin/ditto')) {
      execFileSync('/usr/bin/ditto', [source, staging], { stdio: 'inherit' });
    } else {
      cpSync(source, staging, { recursive: true, force: true, preserveTimestamps: true });
    }
    assertAppBundle(staging);
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return destination;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function mergeManagerConfig(current, managerUrl) {
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('IDACC config must contain a JSON object');
  }
  if (current.managers !== undefined && !Array.isArray(current.managers)) {
    throw new Error('IDACC config has an invalid managers field; refusing to overwrite it');
  }
  const managers = [...(current.managers || [])];
  const index = managers.findIndex((manager) => manager?.name === 'local');
  const existing = index >= 0 && managers[index] && typeof managers[index] === 'object' ? managers[index] : {};
  const profile = { ...existing, name: 'local', url: managerUrl, team: existing.team || 'default' };
  if (index >= 0) managers[index] = profile;
  else managers.push(profile);
  return {
    ...current,
    version: 1,
    managers,
    defaultManager: 'local',
    defaultTeam: current.defaultTeam || 'default',
  };
}

export function persistManagerConfig(configFile, managerUrl, options = {}) {
  if (options.dryRun) {
    console.log(`  would set manager profile "local" to ${managerUrl} in ${configFile}`);
    return;
  }
  let current = {};
  if (existsSync(configFile)) {
    const raw = readFileSync(configFile, 'utf8');
    if (raw.trim()) {
      try {
        current = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Refusing to overwrite unparseable IDACC config at ${configFile}: ${error.message}`);
      }
    }
  }
  const next = mergeManagerConfig(current, managerUrl);
  const configDir = dirname(configFile);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const temporary = `${configFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configFile);
  chmodSync(configFile, 0o600);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderLaunchAgent({ managerDir, managerPort, logDir, home, path, nodePath = process.execPath }) {
  const values = {
    nodePath,
    entry: join(managerDir, 'dist', 'start-agent-manager.js'),
    managerDir,
    managerPort: String(managerPort),
    workDir: join(managerDir, 'workspace'),
    stdout: join(logDir, 'id-agents-manager.log'),
    stderr: join(logDir, 'id-agents-manager-error.log'),
    home,
    path,
  };
  for (const key of Object.keys(values)) values[key] = escapeXml(values[key]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.nodePath}</string>
    <string>${values.entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${values.managerDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${values.home}</string>
    <key>PATH</key><string>${values.path}</string>
    <key>AGENT_MANAGER_PORT</key><string>${values.managerPort}</string>
    <key>AGENT_MANAGER_WORKDIR</key><string>${values.workDir}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${values.stdout}</string>
  <key>StandardErrorPath</key><string>${values.stderr}</string>
</dict>
</plist>
`;
}

export function renderManagerUpdateLaunchAgent({
  managerDir,
  managerPort,
  managerSource = DEFAULT_MANAGER_SOURCE,
  branch = 'main',
  logDir,
  home,
  path,
  nodePath = process.execPath,
}) {
  const values = {
    nodePath,
    updater: join(managerDir, 'scripts', 'manager-auto-update.mjs'),
    managerDir,
    managerUrl: `http://127.0.0.1:${managerPort}`,
    managerSource,
    branch,
    state: join(home, '.id-agents', 'manager-update.json'),
    lock: join(home, '.id-agents', 'manager-update.lock'),
    stdout: join(logDir, 'id-agents-manager-update.log'),
    stderr: join(logDir, 'id-agents-manager-update-error.log'),
    home,
    path,
  };
  for (const key of Object.keys(values)) values[key] = escapeXml(values[key]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UPDATE_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.nodePath}</string>
    <string>${values.updater}</string>
    <string>--target</string><string>${values.managerDir}</string>
    <string>--manager-url</string><string>${values.managerUrl}</string>
    <string>--source</string><string>${values.managerSource}</string>
    <string>--branch</string><string>${values.branch}</string>
    <string>--state</string><string>${values.state}</string>
    <string>--lock</string><string>${values.lock}</string>
  </array>
  <key>WorkingDirectory</key><string>${values.managerDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${values.home}</string>
    <key>PATH</key><string>${values.path}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${values.stdout}</string>
  <key>StandardErrorPath</key><string>${values.stderr}</string>
</dict>
</plist>
`;
}

async function managerHealthy(managerUrl) {
  try {
    const response = await fetch(`${managerUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return body.status === 'ok' || body.ok === true || response.status === 200;
  } catch {
    return false;
  }
}

async function waitForManager(managerUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await managerHealthy(managerUrl)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Manager did not become healthy at ${managerUrl}`);
}

function writeAtomic(file, body, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode });
  renameSync(temporary, file);
  chmodSync(file, mode);
}

async function installManagerService(opts) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new Error('Could not determine the current user id for launchd');
  const home = process.env.HOME || homedir();
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const plist = join(launchAgentsDir, `${SERVICE_LABEL}.plist`);
  const domain = `gui/${uid}`;
  const service = `${domain}/${SERVICE_LABEL}`;
  const loaded = tryRun('launchctl', ['print', service]).ok;
  const managerEntry = join(opts.managerDir, 'dist', 'start-agent-manager.js');

  if (loaded && existsSync(plist) && !readFileSync(plist, 'utf8').includes(escapeXml(managerEntry))) {
    throw new Error(
      `${SERVICE_LABEL} already manages a different checkout. ` +
      `Remove ${plist} only after confirming the old stack is no longer needed.`
    );
  }

  if (!loaded && await managerHealthy(opts.managerUrl)) {
    throw new Error(
      `A manager is already running at ${opts.managerUrl}, but it is not owned by ${SERVICE_LABEL}. ` +
      'Stop that process and rerun so IDACC does not replace an unknown service.'
    );
  }

  if (opts.dryRun) {
    console.log(`  would install per-user service: ${plist}`);
    console.log(`  would install manager release updater: ${join(launchAgentsDir, `${UPDATE_SERVICE_LABEL}.plist`)}`);
    console.log(`  would restart: ${service}`);
    return;
  }

  mkdirSync(opts.projectDir, { recursive: true });
  const nodeProbe = tryRun('/usr/bin/env', ['which', 'node']);
  if (!nodeProbe.ok || !nodeProbe.stdout) throw new Error('Could not resolve the Node.js executable for launchd');
  const body = renderLaunchAgent({
    managerDir: opts.managerDir,
    managerPort: opts.managerPort,
    logDir: opts.projectDir,
    home,
    path: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    nodePath: nodeProbe.stdout,
  });
  if (loaded) {
    const stopped = tryRun('launchctl', ['bootout', service]);
    if (!stopped.ok) throw new Error(`Could not stop existing manager service: ${stopped.stderr || stopped.stdout}`);
  }
  writeAtomic(plist, body);
  run('launchctl', ['bootstrap', domain, plist]);
  run('launchctl', ['kickstart', '-k', service]);
  await waitForManager(opts.managerUrl);
  await installManagerUpdateService(opts, {
    domain,
    home,
    launchAgentsDir,
    nodePath: nodeProbe.stdout,
  });
}

async function installManagerUpdateService(opts, context) {
  const plist = join(context.launchAgentsDir, `${UPDATE_SERVICE_LABEL}.plist`);
  const service = `${context.domain}/${UPDATE_SERVICE_LABEL}`;
  const updaterEntry = join(opts.managerDir, 'scripts', 'manager-auto-update.mjs');
  if (!existsSync(updaterEntry)) {
    throw new Error(`Compatible manager is missing its updater: ${updaterEntry}`);
  }
  const loaded = tryRun('launchctl', ['print', service]).ok;
  if (loaded && existsSync(plist) && !readFileSync(plist, 'utf8').includes(escapeXml(updaterEntry))) {
    throw new Error(
      `${UPDATE_SERVICE_LABEL} already manages a different checkout. ` +
      `Remove ${plist} only after confirming the old stack is no longer needed.`
    );
  }
  const body = renderManagerUpdateLaunchAgent({
    managerDir: opts.managerDir,
    managerPort: opts.managerPort,
    managerSource: opts.managerSource,
    branch: opts.branch,
    logDir: opts.projectDir,
    home: context.home,
    path: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    nodePath: context.nodePath,
  });
  if (loaded) {
    const stopped = tryRun('launchctl', ['bootout', service]);
    if (!stopped.ok) throw new Error(`Could not stop existing manager updater: ${stopped.stderr || stopped.stdout}`);
  }
  writeAtomic(plist, body);
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: opts.managerDir, capture: true });
  const version = JSON.parse(readFileSync(join(opts.managerDir, 'package.json'), 'utf8')).version;
  writeAtomic(join(context.home, '.id-agents', 'manager-update.json'), `${JSON.stringify({
    status: 'current',
    version,
    commit,
    activatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 0o600);
  run('launchctl', ['bootstrap', context.domain, plist]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  validateRuntime(opts);

  console.log('IDACC stack installer');
  console.log(`  IDACC:   ${REPO_ROOT}`);
  console.log(`  Manager: ${opts.managerDir}`);
  console.log(`  App:     ${join(opts.appDir, APP_NAME)}`);
  console.log(`  Service: ${opts.service ? SERVICE_LABEL : 'unchanged'}`);
  if (opts.dryRun) console.log('  Mode:    dry run');

  buildStack(opts);

  console.log('\n3/5 Installing the desktop app');
  const releaseDir = join(REPO_ROOT, 'idctl-desktop', 'release');
  const sourceApp = opts.dryRun ? join(releaseDir, 'mac-arm64', APP_NAME) : findAppBundle(releaseDir);
  if (!sourceApp) throw new Error(`Desktop build was not found below ${releaseDir}`);
  const installedApp = installAppBundle(sourceApp, opts.appDir, { dryRun: opts.dryRun });

  console.log('\n4/5 Configuring IDACC');
  const configFile = process.env.IDCTL_CONFIG || join(process.env.HOME || homedir(), '.config', 'idctl', 'config.json');
  persistManagerConfig(configFile, opts.managerUrl, { dryRun: opts.dryRun });

  console.log('\n5/5 Starting the manager');
  if (opts.service) {
    await installManagerService(opts);
    if (!opts.dryRun) {
      run('npm', ['run', 'status'], {
        cwd: join(REPO_ROOT, 'idctl'),
        env: { MANAGER_URL: opts.managerUrl },
      });
    }
  } else {
    console.log('  manager service left unchanged (--no-service)');
  }

  if (opts.open && process.platform === 'darwin') {
    run('open', [installedApp], { dryRun: opts.dryRun });
  }
  console.log(`\n${opts.dryRun ? 'Dry run complete.' : 'IDACC is ready.'} Open HR Manager to create or load a team.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`install-idacc-stack: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
