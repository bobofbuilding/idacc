#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeRuntimeSourceCapsule,
  verifyRuntimeSourceCapsule,
} from './lib/runtime-source-capsule.mjs';
import { validateRuntimeLock } from './lib/runtime-provenance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift() || '';

function fail(message) {
  throw new Error(message);
}

function option(name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireContainedRepositoryPath(path, label) {
  const rel = relative(repoRoot, path);
  if (
    !rel
    || rel === '..'
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) {
    fail(`${label} must resolve inside the repository root`);
  }
  let cursor = repoRoot;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      fail(`${label} traverses a symbolic link: ${cursor}`);
    }
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/runtime-source-capsule.mjs verify --lock <path> --component brain [--json]',
    '  node scripts/runtime-source-capsule.mjs materialize --lock <path> --component brain --target <path>',
  ].join('\n');
}

if (!['verify', 'materialize'].includes(command)) {
  fail(usage());
}

const lockPath = resolve(option('--lock', resolve(repoRoot, 'release/runtime-lock.json')));
const componentName = option('--component');
if (!componentName) fail('--component is required');
const lock = readJson(lockPath, 'runtime lock');
const lockErrors = validateRuntimeLock(lock);
if (lockErrors.length) {
  fail(`runtime lock is invalid:\n- ${lockErrors.join('\n- ')}`);
}
const component = lock?.components?.[componentName];
if (!component || typeof component !== 'object' || Array.isArray(component)) {
  fail(`runtime lock has no component named ${componentName}`);
}
const source = component.distributionSource;
if (!source || source.mode !== 'vendored-capsule') {
  fail(`runtime component ${componentName} is not backed by a vendored capsule`);
}
const root = resolve(repoRoot, source.path);
const manifestPath = resolve(repoRoot, source.manifest);
requireContainedRepositoryPath(root, 'capsule path');
requireContainedRepositoryPath(manifestPath, 'capsule manifest path');

if (command === 'verify') {
  const result = verifyRuntimeSourceCapsule({
    root,
    manifestPath,
    component,
    componentName,
    containmentRoot: repoRoot,
  });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      ok: result.errors.length === 0,
      component: componentName,
      root: result.root,
      manifestPath: result.manifestPath,
      manifestSha256: result.manifestSha256,
      treeSha256: result.treeSha256,
      files: result.files.length,
      upstreamMapping: result.upstreamMapping,
      errors: result.errors,
    }, null, 2)}\n`);
  } else if (result.errors.length) {
    process.stderr.write(
      `Runtime source capsule verification failed:\n- ${
        result.errors.join('\n- ')
      }\n`,
    );
  } else {
    process.stdout.write(
      `Verified ${componentName} runtime source capsule: ${
        result.files.length
      } files · ${result.treeSha256}\n`,
    );
  }
  if (result.errors.length) process.exitCode = 1;
} else {
  const target = option('--target');
  if (!target) fail('--target is required');
  const result = materializeRuntimeSourceCapsule({
    root,
    manifestPath,
    component,
    componentName,
    containmentRoot: repoRoot,
    target: resolve(target),
  });
  process.stdout.write(
    `Materialized ${componentName} runtime source capsule: ${
      result.files.length
    } files → ${result.target}\n`,
  );
}
