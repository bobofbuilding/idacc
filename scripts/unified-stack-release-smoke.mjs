#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: scripts/unified-stack-release-smoke.mjs <IDACC.app>');
  process.exit(2);
}

const binary = join(app, 'Contents', 'MacOS', 'ID Agents Control Center');
const profile = mkdtempSync(join(tmpdir(), 'idacc-clean-profile-'));
const offset = process.pid % 1000;
const managerPort = 44000 + offset;
const brainPort = 45000 + offset;

try {
  const output = execFileSync(binary, [], {
    encoding: 'utf8',
    timeout: 35_000,
    env: {
      ...process.env,
      IDACC_DATA_DIR: profile,
      IDACC_STACK_SELFTEST: '1',
      MANAGER_URL: `http://127.0.0.1:${managerPort}`,
      BRAIN_URL: `http://127.0.0.1:${brainPort}`,
    },
  });
  const line = output.split(/\r?\n/).find((value) => value.startsWith('IDACC_STACK_SELFTEST '));
  if (!line) throw new Error(`packaged app returned no stack result:\n${output}`);
  const status = JSON.parse(line.slice('IDACC_STACK_SELFTEST '.length));
  if (status.ready !== true || status.services?.length !== 2 || status.services.some((service) => !service.bundled || !service.healthy)) {
    throw new Error(`unified stack did not become ready: ${JSON.stringify(status)}`);
  }
  const profileMetadata = JSON.parse(readFileSync(join(profile, 'profile.json'), 'utf8'));
  if (profileMetadata.schemaVersion !== 1) throw new Error('clean profile was not initialized');
  console.log(`Unified clean-profile stack check passed: manager :${managerPort}, Brain :${brainPort}`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
