#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionBuilderArgs } from './release-signing-policy.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(desktop, 'package.json'));
const args = process.argv.slice(2);
const platformIndex = args.indexOf('--platform');
const separator = args.indexOf('--');
if (
  platformIndex < 0
  || !args[platformIndex + 1]
  || separator < 0
  || separator <= platformIndex + 1
) {
  console.error('usage: node scripts/run-production-builder.mjs --platform mac|win|linux -- <electron-builder arguments>');
  process.exit(2);
}
const platform = args[platformIndex + 1];
const rawBuilderArgs = args.slice(separator + 1);
let builderArgs;
try {
  builderArgs = productionBuilderArgs(platform, rawBuilderArgs);
} catch (error) {
  console.error(`production builder policy failed: ${error.message}`);
  process.exit(1);
}
const builderCli = requireFromDesktop.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [builderCli, ...builderArgs], {
  cwd: desktop,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`production builder failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
