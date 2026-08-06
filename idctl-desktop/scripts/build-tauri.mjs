#!/usr/bin/env node
/** Bundle the Tauri frontend (shares the renderer; Tauri entry + adapter). */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.IDACC_TAURI_SIMULATION !== 'developer-only') {
  throw new Error(
    'The Tauri frontend is a developer-only interface simulation. '
    + 'It cannot build a unified production application; use the Electron release workflow.',
  );
}
rmSync(resolve(ROOT, 'dist-tauri'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'dist-tauri'), { recursive: true });

await build({
  entryPoints: { renderer: resolve(ROOT, 'src/tauri/main.tsx') },
  outdir: resolve(ROOT, 'dist-tauri'),
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: 'safari16',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  logLevel: 'info',
});

cpSync(resolve(ROOT, 'src/tauri/index.html'), resolve(ROOT, 'dist-tauri/index.html'));
console.log('built → dist-tauri/');
