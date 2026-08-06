#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from './lib/runtime-provenance.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : fallback;
}

const runtimeRoot = resolve(option('--runtime-root', join(root, 'idctl-desktop', 'resources', 'idacc-runtime')));
const lockPath = resolve(option('--lock', join(root, 'release', 'runtime-lock.json')));
const manifestPath = join(runtimeRoot, 'manifest.json');
const json = args.includes('--json');

for (const [label, path] of [['runtime root', runtimeRoot], ['runtime manifest', manifestPath], ['runtime lock', lockPath]]) {
  if (!existsSync(path)) {
    console.error(`runtime manifest verification failed: ${label} not found at ${path}`);
    process.exit(1);
  }
}

const lock = readJson(lockPath, 'runtime lock');
const lockErrors = validateRuntimeLock(lock);
const manifest = readJson(manifestPath, 'runtime manifest');
const errors = [...lockErrors, ...verifyRuntimeManifest(runtimeRoot, manifest, lock)];

if (errors.length) {
  if (json) console.error(JSON.stringify({ ok: false, runtimeRoot, errors }, null, 2));
  else {
    console.error('runtime manifest verification failed:');
    for (const error of errors.slice(0, 80)) console.error(`- ${error}`);
    if (errors.length > 80) console.error(`- ... ${errors.length - 80} more`);
  }
  process.exit(1);
}

console.log(json
  ? JSON.stringify({ ok: true, runtimeRoot, manifest }, null, 2)
  : `Runtime manifest verified: ${manifest.files.length} files, ${manifest.trees.runtime}`);
