#!/usr/bin/env node
/**
 * Bundle the three Electron entry points with esbuild:
 *   main    → out/main/main.cjs        (Node, CommonJS)
 *   preload → out/preload/preload.cjs  (Node, CommonJS)
 *   renderer→ out/renderer/renderer.js (+ .css)  (browser, IIFE)
 * Then copy index.html. The main/preload bundles pull in the idctl ManagerClient
 * (pure TS) from the sibling project; node: builtins stay external.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(ROOT, 'out'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'out/renderer'), { recursive: true });
mkdirSync(resolve(ROOT, 'out/docs'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', loader: { '.ts': 'ts', '.tsx': 'tsx' } };

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
  entryPoints: [resolve(ROOT, 'src/renderer/main.tsx')],
  outfile: resolve(ROOT, 'out/renderer/renderer.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
});

cpSync(resolve(ROOT, 'src/renderer/index.html'), resolve(ROOT, 'out/renderer/index.html'));
cpSync(resolve(ROOT, '../docs/CONTROL_CENTER_WIKI.json'), resolve(ROOT, 'out/docs/CONTROL_CENTER_WIKI.json'));
console.log('built → out/');
