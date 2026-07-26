#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract as extractTar } from 'tar';
import {
  collectFileRecords,
  fileTreeHash,
  inspectComponentSource,
  readJson,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from '../../scripts/lib/runtime-provenance.mjs';
import { assertConsumerPayload } from '../../scripts/lib/consumer-payload-policy.mjs';
import { npmInvocation } from './npm-invocation.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const args = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : fallback;
}

const target = resolve(option('--target', join(desktop, 'resources', 'idacc-runtime')));
const lockPath = resolve(option('--lock', join(root, 'release', 'runtime-lock.json')));
const pinnedSources = join(root, '.runtime-sources');
const managerSource = resolve(option(
  '--manager-source',
  process.env.IDACC_MANAGER_SOURCE
    || (existsSync(join(pinnedSources, 'manager')) ? join(pinnedSources, 'manager') : join(root, '..', 'id-agents')),
));
const brainSource = resolve(option(
  '--brain-source',
  process.env.IDACC_BRAIN_SOURCE
    || (existsSync(join(pinnedSources, 'brain')) ? join(pinnedSources, 'brain') : join(root, '..', 'brain')),
));
const targetArch = option('--arch', process.env.IDACC_TARGET_ARCH || process.arch);
const allowDirtyApplication = args.includes('--allow-dirty-application')
  || process.env.IDACC_ALLOW_DIRTY_APPLICATION === '1';

const MANAGER_RUNTIME_ROOTS = [
  'dist/start-agent-manager.js',
  'dist/local-agent-server.js',
];
const MANAGER_CORE_SKILL_NAMES = [
  'brain',
  'catalog',
  'identity',
  'inter-agent',
  'task-discipline',
  'team-coordinator',
  'idagents-admin-control',
  'xmtp',
];
const MANAGER_CORE_SKILL_DOCUMENTS = MANAGER_CORE_SKILL_NAMES
  .map((name) => `skills/${name}/SKILL.md`);
const BRAIN_RUNTIME_ROOTS = [
  'brain.mjs',
  'brain-cycle.mjs',
  'brain-listener.mjs',
  'brain-mcp.mjs',
  'brain-connector-runner.mjs',
  'brain-connector-validate.mjs',
  'brain-eval.mjs',
  'context/service.mjs',
  'cycle/approvals.mjs',
  'dashboard/dashboards.mjs',
  'listener/contract.mjs',
  'mcp/server.mjs',
  'operator-tools/refresh-source-embeddings.mjs',
  'routes/core.mjs',
];
const BRAIN_STATIC_ASSETS = [
  'brain-connector.schema.json',
  'prompts/community-report.json',
  'prompts/edge-description.json',
  'prompts/fact-take-synthesis.json',
  'prompts/follow-up-questions.json',
  'prompts/safety-report.json',
];

function fail(message) {
  throw new Error(message);
}

function requirePath(path, label) {
  if (!existsSync(path)) fail(`${label} not found at ${path}`);
}

function run(command, commandArgs, cwd, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    fail(`${command} ${commandArgs.join(' ')} failed in ${cwd}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function git(cwd, gitArgs, options = {}) {
  return run('git', gitArgs, cwd, { ...options, capture: true });
}

function exportCommit(source, commit, destination, scratch) {
  mkdirSync(destination, { recursive: true });
  const archive = join(scratch, `${commit}.tar`);
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], {
    cwd: source,
    stdio: 'inherit',
  });
  extractTar({
    cwd: destination,
    file: archive,
    preservePaths: false,
    strict: true,
    sync: true,
  });
}

function copyAllowlistedPaths(sourceRoot, destinationRoot, names, { required = false } = {}) {
  for (const name of [...new Set(names)].sort()) {
    const source = join(sourceRoot, name);
    if (!existsSync(source)) {
      if (required) fail(`allowlisted runtime path not found at ${source}`);
      continue;
    }
    const destination = join(destinationRoot, name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function portableRelative(rootPath, path) {
  return relative(rootPath, path).split(sep).join('/');
}

function localModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s+)?["'](\.[^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

function resolveLocalModule(importer, specifier, sourceRoot) {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.mjs`,
    `${unresolved}.cjs`,
    `${unresolved}.json`,
    join(unresolved, 'index.js'),
    join(unresolved, 'index.mjs'),
  ];
  const sourcePrefix = `${resolve(sourceRoot)}${sep}`;
  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate);
    if (!resolvedCandidate.startsWith(sourcePrefix)) {
      fail(`runtime module import escapes its source root: ${portableRelative(sourceRoot, importer)} -> ${specifier}`);
    }
    if (existsSync(resolvedCandidate) && lstatSync(resolvedCandidate).isFile()) return resolvedCandidate;
  }
  return '';
}

function copyRuntimeModuleGraph(sourceRoot, destinationRoot, roots) {
  const queue = [];
  for (const rootModule of roots) {
    const path = join(sourceRoot, rootModule);
    if (existsSync(path)) queue.push(path);
  }
  const copied = new Set();
  while (queue.length) {
    const source = queue.shift();
    const relativePath = portableRelative(sourceRoot, source);
    if (copied.has(relativePath)) continue;
    copied.add(relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    if (!/\.(?:c?m?js)$/i.test(source)) continue;
    const contents = readFileSync(source, 'utf8');
    for (const specifier of localModuleSpecifiers(contents)) {
      const dependency = resolveLocalModule(source, specifier, sourceRoot);
      if (dependency) queue.push(dependency);
    }
  }
  return [...copied].sort();
}

function npmCi(cwd, productionOnly = false) {
  const npmArgs = ['ci'];
  if (productionOnly) npmArgs.push('--omit=dev');
  npmArgs.push('--ignore-scripts=false');
  runNpm(npmArgs, cwd);
}

function runNpm(npmArgs, cwd, options = {}) {
  const invocation = npmInvocation(npmArgs);
  return run(invocation.command, invocation.args, cwd, options);
}

function electronVersion() {
  const installed = join(desktop, 'node_modules', 'electron', 'package.json');
  if (existsSync(installed)) return JSON.parse(readFileSync(installed, 'utf8')).version;
  const packageLock = readJson(join(desktop, 'package-lock.json'), 'desktop package lock');
  const version = packageLock.packages?.['node_modules/electron']?.version;
  if (!version) fail('Electron version is missing from idctl-desktop/package-lock.json');
  return version;
}

function rebuildNativeManagerModule(managerRoot, version) {
  const packageJson = readJson(join(managerRoot, 'package.json'), 'staged manager package');
  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  };
  if (!dependencies['better-sqlite3']) return;
  const rebuildCli = join(desktop, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  requirePath(rebuildCli, '@electron/rebuild CLI');
  run(process.execPath, [
    rebuildCli,
    '--version', version,
    '--module-dir', managerRoot,
    '--only', 'better-sqlite3',
    '--force',
    '--arch', targetArch,
  ], desktop);
}

function applicationMetadata() {
  const packageJson = readJson(join(desktop, 'package.json'), 'desktop package');
  const commit = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const origin = git(root, ['config', '--get', 'remote.origin.url']);
  const dirty = Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const epochInput = process.env.SOURCE_DATE_EPOCH || git(root, ['show', '-s', '--format=%ct', 'HEAD']);
  const epoch = Number(epochInput);
  if (!Number.isFinite(epoch) || epoch <= 0) fail(`invalid SOURCE_DATE_EPOCH: ${epochInput}`);
  return {
    name: packageJson.name,
    version: packageJson.version,
    repository: origin,
    commit,
    tree,
    dirty,
    sourceDateEpoch: Math.trunc(epoch),
    generatedAt: new Date(Math.trunc(epoch) * 1000).toISOString(),
  };
}

function atomicInstall(payload, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const backup = `${destination}.previous-${process.pid}-${Date.now()}`;
  let movedPrevious = false;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedPrevious = true;
    }
    renameSync(payload, destination);
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && movedPrevious && existsSync(backup)) {
      renameSync(backup, destination);
    }
    throw error;
  }
}

requirePath(lockPath, 'runtime lock');
requirePath(managerSource, 'manager source');
requirePath(brainSource, 'Brain source');

const lock = readJson(lockPath, 'runtime lock');
const lockErrors = validateRuntimeLock(lock);
if (lockErrors.length) fail(`runtime lock is invalid:\n- ${lockErrors.join('\n- ')}`);

const inspections = {
  manager: inspectComponentSource('manager', lock.components.manager, managerSource),
  brain: inspectComponentSource('brain', lock.components.brain, brainSource),
};
const sourceErrors = [...inspections.manager.errors, ...inspections.brain.errors];
if (sourceErrors.length) fail(`runtime sources are not releasable:\n- ${sourceErrors.join('\n- ')}`);

const app = applicationMetadata();
if (app.dirty && (process.env.CI === 'true' || !allowDirtyApplication)) {
  fail(
    process.env.CI === 'true'
      ? 'application source is dirty; CI and production staging require an exact clean commit'
      : 'application source is dirty; commit/stash the changes or explicitly pass --allow-dirty-application for a developer-only build',
  );
}

const scratchParent = dirname(target);
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, '.idacc-runtime-stage-'));
const payload = join(scratch, 'payload');
const managerExport = join(scratch, 'manager-source');
const brainExport = join(scratch, 'brain-source');

try {
  mkdirSync(payload, { recursive: true });
  exportCommit(managerSource, lock.components.manager.commit, managerExport, scratch);
  exportCommit(brainSource, lock.components.brain.commit, brainExport, scratch);

  npmCi(managerExport);
  runNpm(['run', 'build'], managerExport);
  requirePath(join(managerExport, lock.components.manager.entrypoint), 'built manager entrypoint');

  const managerTarget = join(payload, 'manager');
  mkdirSync(managerTarget, { recursive: true });
  copyRuntimeModuleGraph(managerExport, managerTarget, [
    ...MANAGER_RUNTIME_ROOTS,
    lock.components.manager.entrypoint,
  ]);
  copyAllowlistedPaths(managerExport, managerTarget, [
    'configs/default.yaml',
    'package.json',
    'package-lock.json',
    'LICENSE',
  ], { required: true });
  copyAllowlistedPaths(managerExport, managerTarget, [
    'NOTICE',
    // Consumer releases ship the declarative skill instructions, not helper
    // executables from a development checkout. Runtime behavior stays inside
    // the signed Manager/Brain code and the desktop supervisor.
    ...MANAGER_CORE_SKILL_DOCUMENTS,
  ], { required: false });
  npmCi(managerTarget, true);

  const brainTarget = join(payload, 'brain');
  mkdirSync(brainTarget, { recursive: true });
  copyRuntimeModuleGraph(brainExport, brainTarget, [
    ...BRAIN_RUNTIME_ROOTS,
    lock.components.brain.entrypoint,
  ]);
  copyAllowlistedPaths(brainExport, brainTarget, [
    'package.json',
    'package-lock.json',
    'LICENSE',
  ], { required: true });
  copyAllowlistedPaths(brainExport, brainTarget, BRAIN_STATIC_ASSETS, { required: false });
  npmCi(brainTarget, true);

  requirePath(join(managerTarget, lock.components.manager.entrypoint), 'staged manager entrypoint');
  requirePath(join(managerTarget, 'configs', 'default.yaml'), 'staged manager default configuration');
  requirePath(join(brainTarget, lock.components.brain.entrypoint), 'staged Brain entrypoint');
  for (const path of [
    'brain-cycle.mjs',
    'brain-listener.mjs',
    'brain-mcp.mjs',
    'brain-connector-validate.mjs',
    'brain-connector.schema.json',
    'context/service.mjs',
    'cycle/approvals.mjs',
    'dashboard/dashboards.mjs',
    'listener/contract.mjs',
    'mcp/server.mjs',
    'operator-tools/refresh-source-embeddings.mjs',
    'prompts/community-report.json',
    'routes/core.mjs',
  ]) {
    requirePath(join(brainTarget, path), `staged Brain framework file ${path}`);
  }

  const electron = electronVersion();
  rebuildNativeManagerModule(managerTarget, electron);
  assertConsumerPayload(payload, 'staged unified runtime');

  const files = collectFileRecords(payload);
  const manifest = {
    schemaVersion: 2,
    generatedAt: app.generatedAt,
    sourceDateEpoch: app.sourceDateEpoch,
    application: {
      name: app.name,
      version: app.version,
      repository: app.repository,
      commit: app.commit,
      tree: app.tree,
      dirty: app.dirty,
    },
    build: {
      platform: process.platform,
      arch: targetArch,
      node: process.version.replace(/^v/, ''),
      npm: runNpm(['--version'], root, { capture: true }),
      electron,
    },
    components: {
      manager: { ...lock.components.manager },
      brain: { ...lock.components.brain },
    },
    trees: {
      manager: fileTreeHash(files, 'manager'),
      brain: fileTreeHash(files, 'brain'),
      runtime: fileTreeHash(files),
    },
    files,
  };
  writeFileSync(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestErrors = verifyRuntimeManifest(payload, manifest, lock);
  if (manifestErrors.length) fail(`generated runtime manifest failed verification:\n- ${manifestErrors.join('\n- ')}`);
  run(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--experimental-strip-types',
    join(desktop, 'scripts', 'runtime-manifest-policy-check.ts'),
    join(payload, 'manifest.json'),
  ], desktop);

  atomicInstall(payload, target);
  console.log(`Staged exact unified runtime → ${target}`);
  console.log(`  manager ${lock.components.manager.version} @ ${lock.components.manager.commit}`);
  console.log(`  brain   ${lock.components.brain.version} @ ${lock.components.brain.commit}`);
  console.log(`  files   ${files.length} · sha256-tree ${manifest.trees.runtime}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
