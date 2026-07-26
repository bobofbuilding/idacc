#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(desktop, 'out');

function walk(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

for (const path of [
  'main/main.cjs',
  'preload/preload.cjs',
  'renderer/index.html',
  'renderer/renderer.js',
  'renderer/renderer.css',
  'build-mode.json',
]) {
  assert.ok(existsSync(join(out, path)), `release output is missing ${path}`);
}
const buildMode = JSON.parse(readFileSync(join(out, 'build-mode.json'), 'utf8'));
assert.equal(buildMode.mode, 'production');
assert.match(String(buildMode.runtimeManifestSha256 || ''), /^[0-9a-f]{64}$/, 'release output must bind to its runtime manifest');
const files = walk(out);
assert.equal(files.some((path) => path.endsWith('.map')), false, 'production bundles must not ship source maps');
console.log(`release build output smoke: ok (${files.length} files, no source maps)`);
