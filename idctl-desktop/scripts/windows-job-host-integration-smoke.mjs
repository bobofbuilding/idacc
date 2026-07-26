#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

if (process.platform !== 'win32') {
  console.log('Windows Job Host integration smoke: skipped (non-Windows)');
  process.exit(0);
}

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildModePath = join(desktop, 'out', 'build-mode.json');
const jobHostPath = join(desktop, 'out', 'native', 'idacc-job-host.exe');
const bootstrapPath = join(desktop, 'out', 'main', 'managed-service-bootstrap.cjs');
assert.equal(existsSync(buildModePath), true, 'build the desktop before testing the Windows Job Host');
assert.equal(existsSync(jobHostPath), true, 'the Windows build must contain its Job Host');
assert.equal(existsSync(bootstrapPath), true, 'the Windows build must contain its managed bootstrap');

const buildMode = JSON.parse(readFileSync(buildModePath, 'utf8'));
const expectedSha256 = String(buildMode.windowsJobHost?.executableSha256 || '');
const expectedBootstrapSha256 = String(buildMode.windowsJobHost?.bootstrapSha256 || '');
assert.equal(buildMode.windowsJobHost?.available, true);
assert.match(expectedSha256, /^[0-9a-f]{64}$/);
assert.match(expectedBootstrapSha256, /^[0-9a-f]{64}$/);
assert.equal(buildMode.windowsJobHost?.verificationMode, 'sha256');

const scratch = mkdtempSync(join(tmpdir(), 'idacc windows job host '));
const managedModulePath = join(scratch, 'managed-process-tree.mjs');
const runtimeFixturePath = join(scratch, 'runtime-fixture.cjs');
const activeHosts = new Set();
let parentFixture;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(message);
}

async function forceStopTestChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already stopped */ }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolveExit) => {
      let timeout;
      const finish = () => {
        clearTimeout(timeout);
        child.removeListener('exit', finish);
        child.removeListener('error', finish);
        resolveExit();
      };
      child.once('exit', finish);
      child.once('error', finish);
      timeout = setTimeout(finish, 5_000);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function expectLaunchFailure(
  module,
  overrides,
  pattern,
  executable = process.execPath,
) {
  const secret = 'IDACC_JOB_HOST_TEST_SECRET_MUST_NOT_LEAK';
  let failure;
  try {
    await module.spawnManagedProcessTree(executable, [runtimeFixturePath], {
      cwd: scratch,
      env: {
        ...process.env,
        IDACC_MANAGED_SERVICE: '1',
        IDACC_TEST_SECRET: secret,
      },
      graceMs: 1_000,
      jobHostPath,
      bootstrapPath,
      ...overrides,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the invalid Windows Job Host launch must fail closed');
  assert.match(String(failure?.message || failure), pattern);
  assert.doesNotMatch(String(failure?.message || failure), new RegExp(secret));
  return failure;
}

try {
  await build({
    entryPoints: [join(desktop, 'src', 'main', 'managedProcessTree.ts')],
    outfile: managedModulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    logLevel: 'silent',
    define: {
      __IDACC_WINDOWS_JOB_HOST_AVAILABLE__: 'true',
      __IDACC_WINDOWS_JOB_HOST_SHA256__: JSON.stringify(expectedSha256),
      __IDACC_WINDOWS_JOB_HOST_EXPECTED_PUBLISHER__: '""',
      __IDACC_MANAGED_SERVICE_BOOTSTRAP_SHA256__: JSON.stringify(
        expectedBootstrapSha256,
      ),
      __IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__: 'true',
    },
  });
  const managed = await import(`${pathToFileURL(managedModulePath).href}?${Date.now()}`);

  // This log intentionally happens before any asynchronous initialization. It
  // catches a STARTED/runtime-output race in the shared stdout transport.
  writeFileSync(runtimeFixturePath, String.raw`'use strict';
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.stderr.write('FIXTURE_IMMEDIATE_ERROR\n');
process.stdout.write('FIXTURE_IMMEDIATE_LOG\n');
const descendant = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], {
  stdio: 'ignore',
  windowsHide: true,
});
writeFileSync(process.env.IDACC_TEST_ROOT_PID_FILE, String(process.pid));
writeFileSync(process.env.IDACC_TEST_DESCENDANT_PID_FILE, String(descendant.pid));
process.on('SIGTERM', () => {
  writeFileSync(process.env.IDACC_TEST_GRACEFUL_FILE, 'graceful');
  setTimeout(() => process.exit(0), 50);
});
if (process.env.IDACC_TEST_ROOT_EXIT_MS) {
  setTimeout(
    () => process.exit(Number(process.env.IDACC_TEST_ROOT_EXIT_CODE || 23)),
    Number(process.env.IDACC_TEST_ROOT_EXIT_MS),
  );
}
setInterval(() => {}, 1000);
`, { mode: 0o600 });

  const rootPidPath = join(scratch, 'root.pid');
  const descendantPidPath = join(scratch, 'descendant.pid');
  const gracefulPath = join(scratch, 'graceful.txt');
  const abortedRootPidPath = join(scratch, 'aborted-root.pid');
  const abortedDescendantPidPath = join(scratch, 'aborted-descendant.pid');
  let abortedLaunchError;
  try {
    await managed.spawnManagedProcessTree(
      process.execPath,
      [runtimeFixturePath],
      {
        cwd: scratch,
        env: {
          ...process.env,
          IDACC_MANAGED_SERVICE: '1',
          IDACC_TEST_ROOT_PID_FILE: abortedRootPidPath,
          IDACC_TEST_DESCENDANT_PID_FILE: abortedDescendantPidPath,
          IDACC_TEST_GRACEFUL_FILE: join(scratch, 'aborted-graceful.txt'),
        },
        graceMs: 1_000,
        jobHostPath,
        bootstrapPath,
        windowsAbortAfterReadyForTest: true,
      },
    );
  } catch (error) {
    abortedLaunchError = error;
  }
  assert.ok(
    abortedLaunchError instanceof managed.ManagedProcessTreeLaunchError,
    'a forced post-CreateProcess launch abort must return its containment result',
  );
  assert.match(
    abortedLaunchError.message,
    /aborted after READY/,
  );
  assert.equal(
    managed.retainedManagedProcessTreeLaunchFailure(abortedLaunchError),
    undefined,
    'the forced launch abort must not leave an unconfirmed retained Job',
  );
  assert.ok(
    Number.isSafeInteger(abortedLaunchError.cleanedActualPid)
      && abortedLaunchError.cleanedActualPid > 0,
    'the abort result must identify the suspended runtime that was drained',
  );
  assert.equal(
    pidAlive(abortedLaunchError.cleanedActualPid),
    false,
    'launch rejection must wait until the post-CreateProcess runtime is gone',
  );
  assert.equal(existsSync(abortedRootPidPath), false);
  assert.equal(existsSync(abortedDescendantPidPath), false);

  const retainedSecret = 'IDACC_RETAINED_LAUNCH_SECRET_MUST_NOT_LEAK';
  let retainedLaunchError;
  try {
    await managed.spawnManagedProcessTree(
      process.execPath,
      [runtimeFixturePath],
      {
        cwd: scratch,
        env: {
          ...process.env,
          IDACC_MANAGED_SERVICE: '1',
          IDACC_TEST_SECRET: retainedSecret,
          IDACC_TEST_ROOT_PID_FILE: join(scratch, 'retained-root.pid'),
          IDACC_TEST_DESCENDANT_PID_FILE: join(scratch, 'retained-descendant.pid'),
          IDACC_TEST_GRACEFUL_FILE: join(scratch, 'retained-graceful.txt'),
        },
        graceMs: 1_000,
        jobHostPath,
        bootstrapPath,
        windowsAbortAfterReadyForTest: true,
        windowsForceLaunchCleanupTimeoutForTest: true,
      },
    );
  } catch (error) {
    retainedLaunchError = error;
  }
  assert.ok(
    retainedLaunchError instanceof managed.ManagedProcessTreeLaunchError,
    'a simulated launch-cleanup timeout must preserve a typed cleanup obligation',
  );
  assert.ok(
    managed.retainedManagedProcessTreeLaunchFailure(retainedLaunchError),
    'the timed-out launch cleanup must retain the exact Job Host',
  );
  assert.equal(
    'retained' in retainedLaunchError,
    false,
    'the retained host handle must not be carried by the Error object',
  );
  const serializedRetainedError = JSON.stringify(retainedLaunchError);
  assert.doesNotMatch(serializedRetainedError, new RegExp(retainedSecret));
  assert.equal(serializedRetainedError.includes(scratch), false);
  assert.equal(serializedRetainedError.includes(jobHostPath), false);
  const retainedLaunch =
    managed.retainedManagedProcessTreeLaunchFailure(retainedLaunchError);
  activeHosts.add(retainedLaunch.child);
  // The test-only branch deliberately hands the exact host back immediately,
  // simulating an expired launch-cleanup deadline. Exercise the supervisor's
  // required retry now instead of racing the host's independent ACK deadline.
  const retainedRetry = await managed.terminateManagedProcessTree(
    retainedLaunch.child,
    () => true,
    { platform: 'win32', forceWaitMs: 1_000 },
  );
  assert.equal(retainedRetry.accepted, true);
  assert.equal(
    retainedRetry.treeKillSucceeded,
    true,
    'a shutdown retry must re-evaluate and clear the exact retained host',
  );
  assert.equal(retainedRetry.exited, true);
  assert.equal(
    retainedLaunch.child.exitCode,
    0,
    'the retained cleanup retry must preserve the queried-empty proof',
  );
  assert.equal(pidAlive(retainedLaunch.actualPid), false);
  activeHosts.delete(retainedLaunch.child);

  const missingRuntimeFailure = await expectLaunchFailure(
    managed,
    {},
    /exited before the managed process started/,
    join(scratch, 'missing-runtime.exe'),
  );
  assert.ok(missingRuntimeFailure instanceof managed.ManagedProcessTreeLaunchError);
  assert.equal(
    managed.retainedManagedProcessTreeLaunchFailure(missingRuntimeFailure),
    undefined,
    'a nonexistent runtime that never created a child must not retain cleanup',
  );
  assert.equal(missingRuntimeFailure.cleanedActualPid, undefined);

  const unstartableRuntimePath = join(scratch, 'unstartable-runtime.exe');
  writeFileSync(unstartableRuntimePath, 'not a Windows executable', { mode: 0o600 });
  const unstartableRuntimeFailure = await expectLaunchFailure(
    managed,
    {},
    /exited before the managed process started/,
    unstartableRuntimePath,
  );
  assert.ok(unstartableRuntimeFailure instanceof managed.ManagedProcessTreeLaunchError);
  assert.equal(
    managed.retainedManagedProcessTreeLaunchFailure(unstartableRuntimeFailure),
    undefined,
    'an unstartable runtime with no created child must not retain cleanup',
  );
  assert.equal(unstartableRuntimeFailure.cleanedActualPid, undefined);

  // Starting the ordinary fixture only after the clean abort has rejected
  // and the no-child failures have settled proves a valid replacement remains
  // launchable without a stale cleanup obligation.
  const launched = await managed.spawnManagedProcessTree(
    process.execPath,
    [runtimeFixturePath],
    {
      cwd: scratch,
      env: {
        ...process.env,
        IDACC_MANAGED_SERVICE: '1',
        IDACC_TEST_ROOT_PID_FILE: rootPidPath,
        IDACC_TEST_DESCENDANT_PID_FILE: descendantPidPath,
        IDACC_TEST_GRACEFUL_FILE: gracefulPath,
      },
      graceMs: 1_000,
      jobHostPath,
      bootstrapPath,
    },
  );
  activeHosts.add(launched.child);
  assert.notEqual(launched.actualPid, launched.hostPid);
  assert.equal(launched.hostPid, launched.child.pid);
  assert.equal(managed.managedProcessActualPid(launched.child), launched.actualPid);
  assert.equal(managed.managedProcessHostPid(launched.child), launched.hostPid);
  assert.ok(
    (launched.child.stdin?.listenerCount('error') || 0) >= 1,
    'the retained control pipe must consume late EPIPE events',
  );

  let runtimeOutput = '';
  let runtimeErrorOutput = '';
  launched.child.stdout?.setEncoding('utf8');
  launched.child.stdout?.on('data', (chunk) => {
    if (runtimeOutput.length < 4_096) runtimeOutput += String(chunk);
  });
  launched.child.stderr?.setEncoding('utf8');
  launched.child.stderr?.on('data', (chunk) => {
    if (runtimeErrorOutput.length < 4_096) runtimeErrorOutput += String(chunk);
  });
  await waitFor(
    () => existsSync(rootPidPath)
      && existsSync(descendantPidPath)
      && runtimeOutput.includes('FIXTURE_IMMEDIATE_LOG')
      && runtimeErrorOutput.includes('FIXTURE_IMMEDIATE_ERROR'),
    10_000,
    'the managed runtime did not publish its immediate stdout/stderr and descendants',
  );
  assert.equal(
    runtimeOutput.split('FIXTURE_IMMEDIATE_LOG').length - 1,
    1,
    'immediate runtime stdout must cross the handshake exactly once',
  );
  assert.equal(
    runtimeErrorOutput.split('FIXTURE_IMMEDIATE_ERROR').length - 1,
    1,
    'immediate runtime stderr must cross the handshake exactly once',
  );
  const rootPid = Number(readFileSync(rootPidPath, 'utf8').trim());
  const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim());
  assert.equal(rootPid, launched.actualPid);
  assert.equal(pidAlive(rootPid), true);
  assert.equal(pidAlive(descendantPid), true);

  const firstStop = managed.terminateManagedProcessTree(
    launched.child,
    () => true,
    { platform: 'win32', forceWaitMs: 2_000 },
  );
  const secondStop = managed.terminateManagedProcessTree(
    launched.child,
    () => true,
    { platform: 'win32', forceWaitMs: 2_000 },
  );
  assert.equal(firstStop, secondStop, 'concurrent Job shutdown must be single-flight');
  const stopped = await firstStop;
  assert.equal(stopped.accepted, true);
  assert.equal(stopped.treeKillAttempted, true);
  assert.equal(stopped.treeKillSucceeded, true);
  assert.equal(stopped.fallbackDirectKill, false);
  assert.equal(stopped.exited, true);
  assert.equal(launched.child.exitCode, 0, 'STOP must exit 0 only after the Job is empty');
  assert.equal(existsSync(gracefulPath), true, 'STOP must reach the runtime gracefully first');
  await waitFor(
    () => !pidAlive(rootPid) && !pidAlive(descendantPid),
    5_000,
    'the queried-empty Job left a runtime descendant alive',
  );
  activeHosts.delete(launched.child);

  const naturalRootPidPath = join(scratch, 'natural-root.pid');
  const naturalDescendantPidPath = join(scratch, 'natural-descendant.pid');
  const naturalGracefulPath = join(scratch, 'natural-graceful.txt');
  const naturalExit = await managed.spawnManagedProcessTree(
    process.execPath,
    [runtimeFixturePath],
    {
      cwd: scratch,
      env: {
        ...process.env,
        IDACC_MANAGED_SERVICE: '1',
        IDACC_TEST_ROOT_PID_FILE: naturalRootPidPath,
        IDACC_TEST_DESCENDANT_PID_FILE: naturalDescendantPidPath,
        IDACC_TEST_GRACEFUL_FILE: naturalGracefulPath,
        IDACC_TEST_ROOT_EXIT_MS: '250',
        IDACC_TEST_ROOT_EXIT_CODE: '23',
      },
      graceMs: 1_000,
      jobHostPath,
      bootstrapPath,
    },
  );
  activeHosts.add(naturalExit.child);
  await waitFor(
    () => existsSync(naturalRootPidPath) && existsSync(naturalDescendantPidPath),
    5_000,
    'the natural-root-exit fixture did not start',
  );
  const naturalRootPid = Number(readFileSync(naturalRootPidPath, 'utf8').trim());
  const naturalDescendantPid = Number(
    readFileSync(naturalDescendantPidPath, 'utf8').trim(),
  );
  await waitFor(
    () => naturalExit.child.exitCode !== null || naturalExit.child.signalCode !== null,
    10_000,
    'the Job Host did not observe its runtime root exit',
  );
  assert.equal(naturalExit.child.exitCode, 23);
  const naturalDrain = await managed.terminateManagedProcessTree(
    naturalExit.child,
    () => true,
    { platform: 'win32', forceWaitMs: 1_000 },
  );
  assert.equal(naturalDrain.treeKillSucceeded, true);
  await waitFor(
    () => !pidAlive(naturalRootPid) && !pidAlive(naturalDescendantPid),
    5_000,
    'runtime-root exit left a Job descendant alive',
  );
  assert.equal(existsSync(naturalGracefulPath), false);
  activeHosts.delete(naturalExit.child);

  const hostCrashRootPidPath = join(scratch, 'host-crash-root.pid');
  const hostCrashDescendantPidPath = join(scratch, 'host-crash-descendant.pid');
  const hostCrashGracefulPath = join(scratch, 'host-crash-graceful.txt');
  const hostCrash = await managed.spawnManagedProcessTree(
    process.execPath,
    [runtimeFixturePath],
    {
      cwd: scratch,
      env: {
        ...process.env,
        IDACC_MANAGED_SERVICE: '1',
        IDACC_TEST_ROOT_PID_FILE: hostCrashRootPidPath,
        IDACC_TEST_DESCENDANT_PID_FILE: hostCrashDescendantPidPath,
        IDACC_TEST_GRACEFUL_FILE: hostCrashGracefulPath,
      },
      graceMs: 1_000,
      jobHostPath,
      bootstrapPath,
    },
  );
  activeHosts.add(hostCrash.child);
  await waitFor(
    () => existsSync(hostCrashRootPidPath) && existsSync(hostCrashDescendantPidPath),
    5_000,
    'the abrupt-host-exit fixture did not start',
  );
  const hostCrashRootPid = Number(readFileSync(hostCrashRootPidPath, 'utf8').trim());
  const hostCrashDescendantPid = Number(
    readFileSync(hostCrashDescendantPidPath, 'utf8').trim(),
  );
  assert.equal(hostCrash.child.kill('SIGKILL'), true);
  await waitFor(
    () => hostCrash.child.exitCode !== null || hostCrash.child.signalCode !== null,
    5_000,
    'the exact Job Host did not terminate',
  );
  await waitFor(
    () => !pidAlive(hostCrashRootPid) && !pidAlive(hostCrashDescendantPid),
    10_000,
    'KILL_ON_JOB_CLOSE left a runtime or descendant alive after host failure',
  );
  assert.equal(existsSync(hostCrashGracefulPath), false);
  const hostCrashProof = await managed.terminateManagedProcessTree(
    hostCrash.child,
    () => true,
    { platform: 'win32', forceWaitMs: 1_000 },
  );
  assert.equal(
    hostCrashProof.treeKillSucceeded,
    false,
    'an abrupt host exit must not be misreported as queried-empty shutdown',
  );
  assert.equal(hostCrashProof.exited, true);
  activeHosts.delete(hostCrash.child);

  await expectLaunchFailure(
    managed,
    { jobHostPath: join(scratch, 'missing-job-host.exe') },
    /Job Host is not present/,
  );
  await expectLaunchFailure(
    managed,
    { bootstrapPath: join(scratch, 'missing-bootstrap.cjs') },
    /bootstrap is not present/,
  );
  const corruptBootstrapPath = join(scratch, 'corrupt-bootstrap.cjs');
  copyFileSync(bootstrapPath, corruptBootstrapPath);
  writeFileSync(
    corruptBootstrapPath,
    `${readFileSync(corruptBootstrapPath, 'utf8')}\n// corrupted\n`,
  );
  await expectLaunchFailure(
    managed,
    { bootstrapPath: corruptBootstrapPath },
    /bootstrap integrity verification failed/,
  );

  const corruptHostPath = join(scratch, 'corrupt-job-host.exe');
  copyFileSync(jobHostPath, corruptHostPath);
  const corrupt = readFileSync(corruptHostPath);
  corrupt[Math.floor(corrupt.length / 2)] ^= 0x01;
  writeFileSync(corruptHostPath, corrupt);
  await expectLaunchFailure(
    managed,
    { jobHostPath: corruptHostPath },
    /integrity verification failed/,
  );
  await expectLaunchFailure(
    managed,
    {
      windowsExpectedPublisher: 'CN=Definitely Wrong IDACC Test Publisher, O=Wrong Publisher',
    },
    /signature verification failed/,
  );

  // A stable parent-process handle—not a reusable PID—must make an abrupt
  // supervisor exit close the sole Job handle and kill every descendant.
  const crashRootPidPath = join(scratch, 'crash-root.pid');
  const crashDescendantPidPath = join(scratch, 'crash-descendant.pid');
  const crashGracefulPath = join(scratch, 'crash-graceful.txt');
  const parentRunnerPath = join(scratch, 'parent-runner.mjs');
  writeFileSync(parentRunnerPath, `
const managed = await import(${JSON.stringify(pathToFileURL(managedModulePath).href)});
const { existsSync, readFileSync } = await import('node:fs');
const launched = await managed.spawnManagedProcessTree(
  process.execPath,
  [${JSON.stringify(runtimeFixturePath)}],
  {
    cwd: ${JSON.stringify(scratch)},
    env: {
      ...process.env,
      IDACC_MANAGED_SERVICE: '1',
      IDACC_TEST_ROOT_PID_FILE: ${JSON.stringify(crashRootPidPath)},
      IDACC_TEST_DESCENDANT_PID_FILE: ${JSON.stringify(crashDescendantPidPath)},
      IDACC_TEST_GRACEFUL_FILE: ${JSON.stringify(crashGracefulPath)},
    },
    graceMs: 1000,
    jobHostPath: ${JSON.stringify(jobHostPath)},
    bootstrapPath: ${JSON.stringify(bootstrapPath)},
  },
);
const deadline = Date.now() + 10000;
while (
  Date.now() < deadline
  && (!existsSync(${JSON.stringify(crashRootPidPath)})
    || !existsSync(${JSON.stringify(crashDescendantPidPath)}))
) {
  await new Promise(resolve => setTimeout(resolve, 25));
}
if (
  !existsSync(${JSON.stringify(crashRootPidPath)})
  || !existsSync(${JSON.stringify(crashDescendantPidPath)})
) process.exit(2);
process.stdout.write('PARENT_READY\\t' + JSON.stringify({
  hostPid: launched.hostPid,
  actualPid: launched.actualPid,
  descendantPid: Number(readFileSync(${JSON.stringify(crashDescendantPidPath)}, 'utf8').trim()),
}) + '\\n');
process.exit(0);
`, { mode: 0o600 });
  parentFixture = spawn(process.execPath, [parentRunnerPath], {
    cwd: scratch,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let parentOutput = '';
  let parentError = '';
  parentFixture.stdout?.on('data', (chunk) => { parentOutput += String(chunk); });
  parentFixture.stderr?.on('data', (chunk) => {
    if (parentError.length < 4_096) parentError += String(chunk);
  });
  const parentExit = await new Promise((resolveExit, rejectExit) => {
    parentFixture.once('error', rejectExit);
    parentFixture.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(parentExit, { code: 0, signal: null }, parentError);
  const readyLine = parentOutput
    .split(/\r?\n/)
    .find((line) => line.startsWith('PARENT_READY\t'));
  assert.ok(readyLine, `the parent crash fixture did not publish identities: ${parentOutput}`);
  const crashIdentity = JSON.parse(readyLine.slice('PARENT_READY\t'.length));
  assert.notEqual(crashIdentity.hostPid, crashIdentity.actualPid);
  await waitFor(
    () => (
      !pidAlive(crashIdentity.hostPid)
      && !pidAlive(crashIdentity.actualPid)
      && !pidAlive(crashIdentity.descendantPid)
    ),
    15_000,
    'supervisor death left a Job Host, runtime, or descendant alive',
  );
  assert.equal(
    existsSync(crashGracefulPath),
    false,
    'supervisor death must use containment rather than impersonating a graceful STOP',
  );

  console.log('Windows Job Host integration smoke: ok');
} finally {
  await forceStopTestChild(parentFixture);
  for (const host of activeHosts) {
    await forceStopTestChild(host);
  }
  // Windows can keep a just-exited process's cwd or a newly written fixture
  // under a short-lived scanner/stdio handle. fs.rm's bounded EBUSY retry is
  // the platform-supported teardown path; a persistent lock still fails.
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
