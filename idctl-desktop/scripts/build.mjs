#!/usr/bin/env node
/**
 * Bundle the three Electron entry points with esbuild:
 *   main    → out/main/main.cjs        (Node, CommonJS)
 *   preload → out/preload/preload.cjs  (Node, CommonJS)
 *   renderer→ out/renderer/renderer.js (+ lazy ESM chunks + .css)
 * Then copy index.html. The main/preload bundles pull in the idctl ManagerClient
 * (pure TS) from the sibling project; node: builtins stay external.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from '../../scripts/lib/runtime-provenance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(ROOT, '..');
const runtimeManifestPath = resolve(ROOT, 'resources/idacc-runtime/manifest.json');
const runtimeLockPath = resolve(SOURCE_ROOT, 'release/runtime-lock.json');
const requireRuntime = process.argv.includes('--require-runtime');
const releaseBuild = requireRuntime || process.argv.includes('--release');
if (requireRuntime && !existsSync(runtimeManifestPath)) {
  throw new Error(`release build requires a staged runtime manifest at ${runtimeManifestPath}`);
}
if (requireRuntime && !existsSync(runtimeLockPath)) {
  throw new Error(`release build requires a runtime lock at ${runtimeLockPath}`);
}
if (requireRuntime) {
  const runtimeManifest = readJson(runtimeManifestPath, 'runtime manifest');
  const runtimeLock = readJson(runtimeLockPath, 'runtime lock');
  const applicationPackage = readJson(resolve(ROOT, 'package.json'), 'desktop package');
  const errors = [
    ...validateRuntimeLock(runtimeLock),
    ...verifyRuntimeManifest(resolve(ROOT, 'resources/idacc-runtime'), runtimeManifest, runtimeLock),
  ];
  const git = (args) => execFileSync('git', args, {
    cwd: SOURCE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (runtimeManifest.application?.name !== applicationPackage.name) {
    errors.push('runtime manifest application name does not match the desktop package');
  }
  if (runtimeManifest.application?.dirty !== false) {
    errors.push('runtime manifest was staged from a dirty application checkout');
  }
  if (runtimeManifest.application?.version !== applicationPackage.version) {
    errors.push(`runtime manifest application version does not match ${applicationPackage.version}`);
  }
  if (runtimeManifest.application?.commit !== git(['rev-parse', 'HEAD'])) {
    errors.push('runtime manifest application commit does not match the release checkout');
  }
  if (runtimeManifest.application?.tree !== git(['rev-parse', 'HEAD^{tree}'])) {
    errors.push('runtime manifest application tree does not match the release checkout');
  }
  if (runtimeManifest.build?.platform !== process.platform) {
    errors.push(`runtime manifest platform ${runtimeManifest.build?.platform || '(missing)'} does not match ${process.platform}`);
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
    errors.push('release build requires a clean application checkout');
  }
  if (errors.length) {
    throw new Error(`release runtime validation failed:\n- ${[...new Set(errors)].join('\n- ')}`);
  }
}
const runtimeManifestSha256 = existsSync(runtimeManifestPath)
  ? createHash('sha256').update(readFileSync(runtimeManifestPath)).digest('hex')
  : '';
rmSync(resolve(ROOT, 'out'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'out/renderer'), { recursive: true });

const common = {
  bundle: true,
  sourcemap: !releaseBuild,
  minify: releaseBuild,
  legalComments: releaseBuild ? 'none' : 'inline',
  logLevel: 'info',
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  define: releaseBuild ? { 'process.env.NODE_ENV': '"production"' } : {},
};

await build({
  ...common,
  entryPoints: [resolve(ROOT, 'src/main/main.ts')],
  outfile: resolve(ROOT, 'out/main/main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Native input binding (Computer Use mouse/keyboard) stays external — it's a
  // .node addon required at runtime from the shipped node_modules, not bundled.
  external: ['electron', '@nut-tree-fork/libnut-darwin', 'bindings'],
  define: {
    ...common.define,
    __IDACC_RUNTIME_MANIFEST_SHA256__: JSON.stringify(runtimeManifestSha256),
  },
});

await build({
  ...common,
  entryPoints: [resolve(ROOT, 'src/preload/preload.ts')],
  outfile: resolve(ROOT, 'out/preload/preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: { renderer: resolve(ROOT, 'src/renderer/main.tsx') },
  outdir: resolve(ROOT, 'out/renderer'),
  platform: 'browser',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'chrome120',
  jsx: 'automatic',
});

cpSync(resolve(ROOT, 'src/renderer/index.html'), resolve(ROOT, 'out/renderer/index.html'));
writeFileSync(resolve(ROOT, 'out/build-mode.json'), JSON.stringify({
  mode: releaseBuild ? 'production' : 'development',
  runtimeManifestSha256: runtimeManifestSha256 || null,
}) + '\n');
console.log(`built ${releaseBuild ? 'production' : 'development'} bundle → out/`);
