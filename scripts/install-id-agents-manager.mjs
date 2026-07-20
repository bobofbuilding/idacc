#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const DEFAULT_SOURCE = 'https://github.com/bobofbuilding/id-agents.git';
const DEFAULT_BRANCH = 'main';

function usage() {
  console.log(`Usage: node scripts/install-id-agents-manager.mjs [options]

Clone or fast-forward update the id-agents manager source into a project folder.
The script is non-destructive by default: it refuses tracked changes, foreign
remotes, non-empty non-git targets, and non-fast-forward updates. Untracked local
files are preserved; Git still refuses an update that would overwrite one.

Options:
  --project-dir <dir>   Parent project folder. Default: current directory.
  --target <dir>        Exact checkout path. Default: <project-dir>/id-agents.
  --source <url>        Git source URL. Default: ${DEFAULT_SOURCE}
  --branch <name>       Branch to track. Default: ${DEFAULT_BRANCH}
  --dry-run             Print planned actions without writing.
  --allow-foreign       Permit updating an existing git repo whose origin differs.
  --help                Show this help.

Examples:
  node scripts/install-id-agents-manager.mjs --project-dir ~/Projects/idacc-stack
  node scripts/install-id-agents-manager.mjs --target ~/Projects/idacc-stack/id-agents --dry-run
`);
}

function parseArgs(argv) {
  const opts = {
    projectDir: process.cwd(),
    target: '',
    source: DEFAULT_SOURCE,
    branch: DEFAULT_BRANCH,
    dryRun: false,
    allowForeign: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--allow-foreign') {
      opts.allowForeign = true;
      continue;
    }
    if (arg === '--project-dir') {
      opts.projectDir = argv[++i];
      continue;
    }
    if (arg === '--target') {
      opts.target = argv[++i];
      continue;
    }
    if (arg === '--source') {
      opts.source = argv[++i];
      continue;
    }
    if (arg === '--branch') {
      opts.branch = argv[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.projectDir) throw new Error('--project-dir requires a value');
  if (!opts.source) throw new Error('--source requires a value');
  if (!opts.branch) throw new Error('--branch requires a value');
  opts.projectDir = resolve(expandHome(opts.projectDir));
  opts.target = resolve(expandHome(opts.target || `${opts.projectDir}/id-agents`));
  return opts;
}

function expandHome(value) {
  if (!value || !value.startsWith('~')) return value;
  return `${process.env.HOME || ''}${value.slice(1)}`;
}

function run(cmd, args, options = {}) {
  if (options.dryRun) {
    console.log(`dry-run: ${cmd} ${args.map(shellQuote).join(' ')}`);
    return '';
  }
  const output = execFileSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function tryRun(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    status: result.status,
  };
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isGitRepo(dir) {
  return existsSync(`${dir}/.git`);
}

function isEmptyDir(dir) {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).filter((name) => name !== '.DS_Store').length === 0;
}

function normalizeRemote(url) {
  return String(url || '')
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function assertCleanGitWorktree(target) {
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: target });
  if (status) {
    throw new Error(`Refusing to update tracked changes in manager checkout at ${target}. Commit/stash them first.\n${status}`);
  }
}

function updateExisting(opts) {
  console.log(`Updating manager checkout: ${opts.target}`);
  assertCleanGitWorktree(opts.target);

  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: opts.target });
  if (!opts.allowForeign && normalizeRemote(origin) !== normalizeRemote(opts.source)) {
    throw new Error(`Refusing to update ${opts.target}: origin is ${origin}, expected ${opts.source}. Pass --allow-foreign only if this is intentional.`);
  }

  const currentBranch = run('git', ['branch', '--show-current'], { cwd: opts.target });
  if (currentBranch !== opts.branch) {
    run('git', ['checkout', opts.branch], { cwd: opts.target, dryRun: opts.dryRun, capture: false });
  }
  run('git', ['fetch', 'origin', opts.branch, '--tags'], { cwd: opts.target, dryRun: opts.dryRun, capture: false });

  if (!opts.dryRun) {
    const mergeBase = run('git', ['merge-base', 'HEAD', `origin/${opts.branch}`], { cwd: opts.target });
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: opts.target });
    if (mergeBase !== head) {
      throw new Error(`Refusing non-fast-forward update at ${opts.target}. Pull/rebase manually, then rerun.`);
    }
  }

  run('git', ['merge', '--ff-only', `origin/${opts.branch}`], { cwd: opts.target, dryRun: opts.dryRun, capture: false });
  const rev = opts.dryRun ? '(dry-run)' : run('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.target });
  console.log(`Manager checkout ready at ${opts.target} (${rev})`);
}

function cloneFresh(opts) {
  console.log(`Installing manager checkout: ${opts.target}`);
  const parent = dirname(opts.target);
  if (!existsSync(parent)) {
    if (opts.dryRun) console.log(`dry-run: mkdir -p ${shellQuote(parent)}`);
    else mkdirSync(parent, { recursive: true });
  }
  if (existsSync(opts.target) && !isEmptyDir(opts.target)) {
    throw new Error(`Refusing to overwrite non-empty non-git target: ${opts.target}`);
  }

  const tmp = resolve(tmpdir(), `id-agents-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    run('git', ['clone', '--branch', opts.branch, '--single-branch', opts.source, tmp], {
      dryRun: opts.dryRun,
      capture: false,
    });
    if (opts.dryRun) {
      console.log(`dry-run: rename ${shellQuote(tmp)} ${shellQuote(opts.target)}`);
      return;
    }
    if (existsSync(opts.target) && isEmptyDir(opts.target)) rmSync(opts.target, { recursive: true, force: true });
    renameSync(tmp, opts.target);
    const rev = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: opts.target });
    console.log(`Manager checkout ready at ${opts.target} (${rev})`);
  } finally {
    if (!opts.dryRun && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const git = tryRun('git', ['--version']);
  if (!git.ok) throw new Error('git is required but was not found on PATH');

  console.log(`Source: ${opts.source}`);
  console.log(`Branch: ${opts.branch}`);
  console.log(`Project: ${opts.projectDir}`);
  console.log(`Target: ${opts.target}`);

  if (existsSync(opts.target) && isGitRepo(opts.target)) updateExisting(opts);
  else cloneFresh(opts);
}

try {
  main();
} catch (err) {
  console.error(`install-id-agents-manager: ${err?.message || err}`);
  process.exit(1);
}
