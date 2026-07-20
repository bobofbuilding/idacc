#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function usage() {
  console.error('usage: node scripts/cleanup-release-artifacts.mjs [--apply] [idctl-desktop-dir]');
}

async function sizeOf(target) {
  const entry = await lstat(target).catch(() => null);
  if (!entry) return 0;
  if (!entry.isDirectory()) return entry.size;

  const children = await readdir(target, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const child of children) total += await sizeOf(path.join(target, child.name));
  return total;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

async function validateDesktopDir(input) {
  const desktopDir = path.resolve(input);
  if (path.basename(desktopDir) !== 'idctl-desktop') {
    throw new Error(`refusing cleanup outside an idctl-desktop directory: ${desktopDir}`);
  }

  const manifest = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'));
  if (manifest.name !== 'idagents-control-center') {
    throw new Error(`refusing cleanup for unexpected package ${JSON.stringify(manifest.name)}`);
  }
  return desktopDir;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((arg) => arg !== '--apply');
  if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--apply')) {
    usage();
    process.exitCode = 2;
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const desktopDir = await validateDesktopDir(positional[0] ?? path.resolve(scriptDir, '..', 'idctl-desktop'));
  const releaseDir = path.join(desktopDir, 'release');
  const releaseEntry = await lstat(releaseDir).catch(() => null);
  if (!releaseEntry) {
    console.log('No local release artifacts to clean.');
    return;
  }
  if (releaseEntry.isSymbolicLink() || !releaseEntry.isDirectory()) {
    throw new Error(`refusing unexpected release path: ${releaseDir}`);
  }

  const bytes = await sizeOf(releaseDir);
  if (!apply) {
    console.log(`Would remove ${releaseDir} (${formatBytes(bytes)}). Re-run with --apply.`);
    return;
  }

  await rm(releaseDir, { recursive: true, force: false });
  console.log(`Cleaned local release artifacts and reclaimed approximately ${formatBytes(bytes)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
