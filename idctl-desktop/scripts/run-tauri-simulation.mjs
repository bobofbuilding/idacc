#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const result = spawnSync(process.execPath, [cli, 'dev'], {
  cwd: root,
  env: {
    ...process.env,
    IDACC_TAURI_SIMULATION: 'developer-only',
  },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`Could not start the developer-only Tauri simulation: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
