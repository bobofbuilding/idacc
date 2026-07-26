#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const packagedApp = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: scripts/unified-stack-release-smoke.mjs <IDACC.app|win-unpacked|linux-unpacked>');
  process.exit(2);
}

function executable(path) {
  if (basename(path).endsWith('.app')) return join(path, 'Contents', 'MacOS', 'ID Agents Control Center');
  if (process.platform === 'win32') return join(path, 'ID Agents Control Center.exe');
  return join(path, 'idagents-control-center');
}

const binary = executable(packagedApp);
if (!existsSync(binary)) {
  console.error(`packaged executable is missing: ${binary}`);
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), 'idacc-clean-profile-'));
const resultFile = join(profile, 'stack-selftest-result.json');
const offset = process.pid % 1000;
const managerPort = 44000 + offset;
const brainPort = 45000 + offset;

try {
  const useXvfb = process.platform === 'linux';
  const command = useXvfb ? 'xvfb-run' : binary;
  const commandArgs = useXvfb ? ['-a', binary] : [];
  const execution = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      IDACC_DATA_DIR: profile,
      IDACC_STACK_SELFTEST: '1',
      IDACC_STACK_SELFTEST_RESULT_FILE: resultFile,
      MANAGER_URL: `http://127.0.0.1:${managerPort}`,
      BRAIN_URL: `http://127.0.0.1:${brainPort}`,
    },
  });
  const stdout = String(execution.stdout || '');
  const stderr = String(execution.stderr || '');
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith('IDACC_STACK_SELFTEST '));
  let status;
  let resultSource;
  if (existsSync(resultFile)) {
    const resultText = readFileSync(resultFile, 'utf8');
    status = JSON.parse(resultText);
    resultSource = 'private result file';
    if (process.platform !== 'win32' && (statSync(resultFile).mode & 0o777) !== 0o600) {
      throw new Error('packaged app stack result is not permissioned 0600');
    }
    if (/"[^"]*(?:token|bearer|credential|secret|password|private[_-]?key)[^"]*"\s*:/i.test(resultText)) {
      throw new Error('packaged app stack result contains a credential-shaped field');
    }
  } else if (line) {
    // Console parsing is retained for useful diagnostics from an older or
    // interrupted build, but new builds publish the private result file.
    status = JSON.parse(line.slice('IDACC_STACK_SELFTEST '.length));
    resultSource = 'stdout fallback';
  } else {
    throw new Error(
      `packaged app returned no stack result\nstatus=${execution.status} signal=${execution.signal || 'none'}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (execution.error || execution.status !== 0) {
    throw new Error(
      `packaged app stack self-test failed (${resultSource})`
      + `\nstatus=${execution.status} signal=${execution.signal || 'none'}`
      + `\nerror=${execution.error?.message || 'none'}`
      + `\nresult=${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (status.ready !== true || status.services?.length !== 2 || status.services.some((service) => !service.bundled || !service.healthy)) {
    throw new Error(`unified stack did not become ready: ${JSON.stringify(status)}`);
  }
  if (
    status.managerCompatibility?.ready !== true
    || status.runtimeContract?.managerCapabilities !== true
    || status.runtimeContract?.mcpCompareAndSet !== true
    || status.runtimeContract?.controlStateCompareAndSet !== true
    || status.runtimeContract?.controlEventIdempotency !== true
    || status.runtimeContract?.brainLearnedControlEvent !== true
    || status.runtimeContract?.brainListenerCursorAdvanced !== true
    || status.runtimeContract?.localAgentSpawn !== true
    || status.runtimeContract?.localAgentPrivateLog !== true
    || status.runtimeContract?.localAgentStop !== true
  ) {
    throw new Error(`unified runtime behavior contract failed: ${JSON.stringify(status)}`);
  }
  const profileMetadata = JSON.parse(readFileSync(join(profile, 'profile.json'), 'utf8'));
  if (!Number.isInteger(profileMetadata.schemaVersion) || profileMetadata.schemaVersion < 1) {
    throw new Error('clean profile was not initialized');
  }
  console.log(
    `Unified clean-profile stack check passed on ${process.platform}`
    + ` via ${resultSource}: manager :${managerPort}, Brain :${brainPort}`,
  );
} finally {
  rmSync(profile, { recursive: true, force: true });
}
