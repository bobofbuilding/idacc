import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpStdioLaunch } from '../src/main/mcpTest.ts';
import { resolveSubscriptionAction } from '../src/shared/subscriptionAction.ts';
import {
  executableCandidatePaths,
  executableExtensions,
  executableRequiresShell,
  installCommandSupported,
  terminalAutomationSupported,
} from '../src/shared/subscriptionPortability.ts';

assert.deepEqual(
  executableExtensions('win32', '.EXE;.CMD'),
  ['.exe', '.cmd'],
  'Windows executable discovery must honor PATHEXT',
);
const executableDirectory = join(tmpdir(), 'idacc-subscription-portability-tools');
const windowsCandidates = executableCandidatePaths(executableDirectory, 'claude', {
  platform: 'win32',
  pathExt: '.EXE;.CMD',
});
assert.deepEqual(
  windowsCandidates,
  [
    join(executableDirectory, 'claude.exe'),
    join(executableDirectory, 'claude.cmd'),
  ],
  'Windows executable discovery must append PATHEXT candidates using host-native filesystem paths',
);
assert.deepEqual(
  executableCandidatePaths(executableDirectory, 'claude', { platform: 'linux' }),
  [join(executableDirectory, 'claude')],
  'non-Windows executable discovery must preserve an extensionless host-native filesystem path',
);
assert.equal(executableRequiresShell('C:\\Tools\\claude.cmd', 'win32'), true);
assert.equal(executableRequiresShell('C:\\Tools\\claude.exe', 'win32'), false);

assert.equal(installCommandSupported('npm install -g @anthropic-ai/claude-code', 'win32'), true);
assert.equal(installCommandSupported('curl https://example.test/install | bash', 'win32'), false);
assert.equal(installCommandSupported('curl https://example.test/install | bash', 'linux'), true);

assert.equal(terminalAutomationSupported('darwin'), true);
assert.equal(terminalAutomationSupported('linux'), false);
assert.equal(terminalAutomationSupported('win32'), false);

const manualSignin = resolveSubscriptionAction('signin', {
  started: false,
  command: 'claude auth login',
  error: 'automatic terminal launch is unavailable',
});
assert.equal(manualSignin.kind, 'manual', 'a returned sign-in command must be a manual handoff, not an error');
assert.equal(manualSignin.kind === 'manual' ? manualSignin.command : '', 'claude auth login');
const manualInstall = resolveSubscriptionAction('install', {
  ran: false,
  command: 'npm install -g @openai/codex',
  error: 'automatic terminal launch is unavailable',
});
assert.equal(manualInstall.kind, 'manual', 'a returned install command must be a manual handoff, not an error');
assert.equal(resolveSubscriptionAction('signin', { started: true }).kind, 'launched');
assert.equal(resolveSubscriptionAction('install', { ran: false, error: 'unsupported installer' }).kind, 'error');

const temporary = mkdtempSync(join(tmpdir(), 'idacc-mcp-portability-'));
try {
  const commandShim = join(temporary, 'example-mcp.cmd');
  writeFileSync(commandShim, '@echo off\r\n');
  const launch = resolveMcpStdioLaunch('example-mcp', {
    BRAIN_TOKEN: 'explicit-mcp-token',
  }, {
    platform: 'win32',
    env: {
      PATH: temporary,
      PATHEXT: '.EXE;.CMD',
      BRAIN_TOKEN: 'ambient-brain-token',
      IDACC_ADMIN_TOKEN: 'ambient-admin-token',
      IDACC_BRAIN_TOKEN: 'ambient-brain-alias',
    },
    home: temporary,
    pathDelimiter: ';',
  });
  assert.equal(launch.command, commandShim, 'MCP launch must resolve a Windows .cmd shim through PATHEXT');
  assert.equal(launch.shell, true, 'Windows .cmd MCP shims must launch through the platform shell');
  assert.ok(launch.env.PATH?.split(';').includes(temporary), 'MCP launch must retain the configured PATH');
  assert.equal(launch.env.IDACC_ADMIN_TOKEN, undefined, 'MCP launch inherited the app Manager bearer');
  assert.equal(launch.env.IDACC_BRAIN_TOKEN, undefined, 'MCP launch inherited an app Brain bearer alias');
  assert.equal(launch.env.BRAIN_TOKEN, 'explicit-mcp-token', 'explicit MCP env must override scrubbed ambient state');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function runIsolatedSpawnRegression(
  label: string,
  source: string,
  timeout = 5_000,
): void {
  const probe = spawnSync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    source,
  ], {
    encoding: 'utf8',
    timeout,
  });
  assert.equal(
    probe.signal,
    null,
    `${label} killed its caller: ${probe.stderr || probe.stdout}`,
  );
  assert.equal(
    probe.status,
    0,
    `${label} did not reject cleanly: ${probe.stderr || probe.stdout}`,
  );
}

if (process.platform !== 'win32') {
  const mcpTestUrl = new URL('../src/main/mcpTest.ts', import.meta.url).href;
  const mcpProbeRunnerPath = fileURLToPath(
    new URL('../src/main/mcp-probe-runner.cjs', import.meta.url),
  );
  const mcpProbeRunnerSha256 = createHash('sha256')
    .update(readFileSync(mcpProbeRunnerPath))
    .digest('hex');
  const missingCommand = join(
    tmpdir(),
    `idacc-missing-mcp-command-${process.pid}`,
  );
  runIsolatedSpawnRegression('missing MCP command', `
    import {
      configureMcpProbeRuntime,
      testMcpServer,
    } from ${JSON.stringify(mcpTestUrl)};
    configureMcpProbeRuntime({
      runnerPath: ${JSON.stringify(mcpProbeRunnerPath)},
      runnerSha256: ${JSON.stringify(mcpProbeRunnerSha256)},
      platform: process.platform,
      timeoutMs: 1_000,
      graceMs: 50,
      forceWaitMs: 1_000,
    });
    let uncaught = '';
    process.on('uncaughtException', (error) => {
      uncaught = error instanceof Error ? error.message : String(error);
    });
    const result = await testMcpServer({
      transport: 'stdio',
      command: ${JSON.stringify(missingCommand)},
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (
      result.ok
      || !String(result.error || '').includes('command not found')
      || uncaught
    ) {
      console.error(JSON.stringify({ result, uncaught }));
      process.exitCode = 2;
    }
  `);
}

// Background MLX launch is an Apple Silicon-only feature. Exercising a
// simulated detached POSIX shell spawn on a Windows host leaves Node's failed
// process handle alive until the outer timeout, even though production rejects
// Windows before reaching this launch boundary.
if (process.platform !== 'win32') {
  const systemUrl = new URL('../src/main/system.ts', import.meta.url).href;
  const userData = mkdtempSync(join(tmpdir(), 'idacc-background-spawn-'));
  const missingShell = join(userData, 'missing-zsh');
  const profileALogs = join(userData, 'profiles', 'alpha', 'logs');
  const profileBLogs = join(userData, 'profiles', 'beta', 'logs');
  try {
    runIsolatedSpawnRegression('missing background shell', `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { startBackgroundStack } from ${JSON.stringify(systemUrl)};
      let uncaught = '';
      process.on('uncaughtException', (error) => {
        uncaught = error instanceof Error ? error.message : String(error);
      });
      const rejections = [];
      for (const logs of [
        ${JSON.stringify(profileALogs)},
        ${JSON.stringify(profileBLogs)},
      ]) {
        try {
          await startBackgroundStack(
            'mlx-lm-server',
            undefined,
            logs,
            {
              platform: 'darwin',
              arch: 'arm64',
              shellPath: ${JSON.stringify(missingShell)},
            },
          );
        } catch (error) {
          rejections.push(error instanceof Error ? error.message : String(error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      const alphaLog = join(
        ${JSON.stringify(profileALogs)},
        'local-stack-logs',
        'mlx-lm-server.log',
      );
      const betaLog = join(
        ${JSON.stringify(profileBLogs)},
        'local-stack-logs',
        'mlx-lm-server.log',
      );
      const leakedGlobalLog = join(
        ${JSON.stringify(userData)},
        'local-stack-logs',
        'mlx-lm-server.log',
      );
      if (
        rejections.length !== 2
        || uncaught
        || !existsSync(alphaLog)
        || !existsSync(betaLog)
        || existsSync(leakedGlobalLog)
      ) {
        console.error(JSON.stringify({
          rejections,
          uncaught,
          alphaLog: existsSync(alphaLog),
          betaLog: existsSync(betaLog),
          leakedGlobalLog: existsSync(leakedGlobalLog),
        }));
        process.exitCode = 2;
      }
    `);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  const systemUrl = new URL('../src/main/system.ts', import.meta.url).href;
  const temporary = mkdtempSync(join(tmpdir(), 'idacc-background-shutdown-'));
  try {
    runIsolatedSpawnRegression('background shutdown admission and serialization', `
      import {
        backgroundStackStatus,
        openBackgroundStackAdmission,
        startBackgroundStack,
        stopAllBackgroundStacks,
      } from ${JSON.stringify(systemUrl)};
      const quote = (value) => "'" + String(value).replaceAll("'", "'\\\\''") + "'";
      const command = 'exec ' + quote(process.execPath)
        + ' -e '
        + quote("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
      const alive = (pid) => {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== 'ESRCH';
        }
      };
      let firstPid = 0;
      let secondPid = 0;
      try {
        const admittedStart = startBackgroundStack(
          'mlx-lm-server',
          command,
          ${JSON.stringify(join(temporary, 'profile-logs'))},
          {
            platform: 'darwin',
            arch: 'arm64',
            shellPath: '/bin/sh',
            graceMs: 50,
            forceWaitMs: 2_000,
          },
        );
        const firstShutdown = stopAllBackgroundStacks();
        const concurrentShutdown = stopAllBackgroundStacks();
        if (firstShutdown !== concurrentShutdown) {
          throw new Error('background-stack shutdown was not single-flight');
        }
        let lateStartError = '';
        try {
          await startBackgroundStack(
            'mlx-lm-server',
            command,
            ${JSON.stringify(join(temporary, 'profile-logs'))},
            {
              platform: 'darwin',
              arch: 'arm64',
              shellPath: '/bin/sh',
            },
          );
        } catch (error) {
          lateStartError = error instanceof Error ? error.message : String(error);
        }
        const started = await admittedStart;
        firstPid = Number(started.pid || 0);
        await firstShutdown;
        const stopped = backgroundStackStatus(['mlx-lm-server'])['mlx-lm-server'];
        if (
          !lateStartError.includes('shutting down')
          || stopped.running
          || alive(firstPid)
        ) {
          throw new Error(JSON.stringify({ lateStartError, started, stopped, firstPid }));
        }

        openBackgroundStackAdmission();
        const restarted = await startBackgroundStack(
          'mlx-lm-server',
          command,
          ${JSON.stringify(join(temporary, 'profile-logs'))},
          {
            platform: 'darwin',
            arch: 'arm64',
            shellPath: '/bin/sh',
            graceMs: 50,
            forceWaitMs: 2_000,
          },
        );
        secondPid = Number(restarted.pid || 0);
        await stopAllBackgroundStacks();
        if (
          backgroundStackStatus(['mlx-lm-server'])['mlx-lm-server'].running
          || alive(secondPid)
        ) {
          throw new Error(JSON.stringify({ restarted, secondPid }));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      } finally {
        for (const pid of [firstPid, secondPid]) {
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
            try { process.kill(-pid, 'SIGKILL'); } catch {}
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      }
    `, 10_000);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  const systemUrl = new URL('../src/main/system.ts', import.meta.url).href;
  const temporary = mkdtempSync(join(tmpdir(), 'idacc-background-tree-'));
  const fixture = join(temporary, 'background-root.cjs');
  const identities = join(temporary, 'background-identities.json');
  const overlapMarker = join(temporary, 'overlap.txt');
  writeFileSync(fixture, `
    'use strict';
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const identities = process.argv[2];
    const descendant = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: 'ignore' });
    descendant.unref();
    writeFileSync(identities, JSON.stringify({
      group: process.ppid,
      root: process.pid,
      descendant: descendant.pid,
    }));
    setTimeout(() => process.exit(0), 50);
  `);
  try {
    runIsolatedSpawnRegression('retained background process group', `
      import { existsSync, readFileSync } from 'node:fs';
      import {
        backgroundStackStatus,
        startBackgroundStack,
        stopAllBackgroundStacks,
      } from ${JSON.stringify(systemUrl)};
      const quote = (value) => "'" + String(value).replaceAll("'", "'\\\\''") + "'";
      const command = quote(process.execPath)
        + ' ' + quote(${JSON.stringify(fixture)})
        + ' ' + quote(${JSON.stringify(identities)})
        + '; exit $?';
      let groupPid = 0;
      let identity = null;
      const alive = (pid) => {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== 'ESRCH';
        }
      };
      try {
        const started = await startBackgroundStack(
          'mlx-lm-server',
          command,
          ${JSON.stringify(join(temporary, 'profile-logs'))},
          {
            platform: 'darwin',
            arch: 'arm64',
            shellPath: '/bin/sh',
            graceMs: 50,
            forceWaitMs: 2_000,
          },
        );
        groupPid = Number(started.pid || 0);
        const deadline = Date.now() + 2_000;
        while ((!existsSync(${JSON.stringify(identities)})
          || backgroundStackStatus(['mlx-lm-server'])['mlx-lm-server']?.exitCode === null)
          && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        identity = JSON.parse(readFileSync(${JSON.stringify(identities)}, 'utf8'));
        const retained = backgroundStackStatus(['mlx-lm-server'])['mlx-lm-server'];
        const duplicate = await startBackgroundStack(
          'mlx-lm-server',
          quote(process.execPath)
            + ' -e '
            + quote("require('node:fs').writeFileSync("
              + JSON.stringify(${JSON.stringify(overlapMarker)})
              + ", 'overlap')"),
          ${JSON.stringify(join(temporary, 'profile-logs'))},
          {
            platform: 'darwin',
            arch: 'arm64',
            shellPath: '/bin/sh',
            graceMs: 50,
            forceWaitMs: 2_000,
          },
        );
        if (
          !retained.running
          || retained.exitCode === null
          || !String(retained.detail || '').includes('retained background process tree')
          || !duplicate.running
          || duplicate.detail !== 'already running'
          || existsSync(${JSON.stringify(overlapMarker)})
          || identity.group !== groupPid
          || !alive(identity.descendant)
        ) {
          throw new Error(JSON.stringify({ retained, duplicate, identity, groupPid }));
        }
        await stopAllBackgroundStacks();
        const finalStatus = backgroundStackStatus(['mlx-lm-server'])['mlx-lm-server'];
        const cleanupDeadline = Date.now() + 2_000;
        while (alive(identity.descendant) && Date.now() < cleanupDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (finalStatus.running || alive(identity.descendant)) {
          throw new Error(JSON.stringify({ finalStatus, identity }));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      } finally {
        if (Number.isSafeInteger(groupPid) && groupPid > 0 && groupPid !== process.pid) {
          try { process.kill(-groupPid, 'SIGKILL'); } catch {}
        }
        for (const pid of [identity?.root, identity?.descendant]) {
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      }
    `, 10_000);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  const mcpTestUrl = new URL('../src/main/mcpTest.ts', import.meta.url).href;
  const mcpProbeRunnerPath = fileURLToPath(
    new URL('../src/main/mcp-probe-runner.cjs', import.meta.url),
  );
  const mcpProbeRunnerSha256 = createHash('sha256')
    .update(readFileSync(mcpProbeRunnerPath))
    .digest('hex');
  const temporary = mkdtempSync(join(tmpdir(), 'idacc-mcp-tree-'));
  const fixture = join(temporary, 'stubborn-mcp.cjs');
  const identities = join(temporary, 'mcp-identities.json');
  const failedIdentities = join(temporary, 'mcp-failed-identities.json');
  const blockedIdentities = join(temporary, 'mcp-blocked-identities.json');
  const blockedConcurrentIdentities = join(
    temporary,
    'mcp-blocked-concurrent-identities.json',
  );
  const retriedIdentities = join(temporary, 'mcp-retried-identities.json');
  const shutdownIdentities = join(temporary, 'mcp-shutdown-identities.json');
  const shutdownBlockedIdentities = join(
    temporary,
    'mcp-shutdown-blocked-identities.json',
  );
  const reopenedIdentities = join(temporary, 'mcp-reopened-identities.json');
  writeFileSync(fixture, `
    'use strict';
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: 'ignore' });
    descendant.unref();
    writeFileSync(process.env.IDACC_MCP_PID_FILE, JSON.stringify({
      runner: process.ppid,
      root: process.pid,
      descendant: descendant.pid,
    }));
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'stubborn-fixture', version: '1' },
            },
          }) + '\\n');
        } else if (message.id === 2) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'fixture-tool' }] },
          }) + '\\n');
        }
      }
    });
    setInterval(() => {}, 1000);
  `);
  try {
    runIsolatedSpawnRegression('managed MCP process tree cleanup', `
      import { existsSync, readFileSync } from 'node:fs';
      import {
        configureMcpProbeRuntime,
        openMcpProbeAdmission,
        stopActiveMcpProbes,
        testMcpServer,
      } from ${JSON.stringify(mcpTestUrl)};
      configureMcpProbeRuntime({
        runnerPath: ${JSON.stringify(mcpProbeRunnerPath)},
        runnerSha256: ${JSON.stringify(mcpProbeRunnerSha256)},
        platform: process.platform,
        timeoutMs: 2_000,
        graceMs: 50,
        forceWaitMs: 1_000,
      });
      let identity = null;
      let failedIdentity = null;
      let retriedIdentity = null;
      let shutdownIdentity = null;
      let reopenedIdentity = null;
      let managedShutdownLaunch = null;
      const originalKill = process.kill;
      const alive = (pid) => {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== 'ESRCH';
        }
      };
      try {
        const result = await testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: { IDACC_MCP_PID_FILE: ${JSON.stringify(identities)} },
        });
        if (!existsSync(${JSON.stringify(identities)})) {
          throw new Error('the MCP fixture did not publish its process identities');
        }
        identity = JSON.parse(readFileSync(${JSON.stringify(identities)}, 'utf8'));
        const deadline = Date.now() + 2_000;
        while (
          [identity.runner, identity.root, identity.descendant].some(alive)
          && Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (
          !result.ok
          || result.tools?.[0] !== 'fixture-tool'
          || [identity.runner, identity.root, identity.descendant].some(alive)
        ) {
          throw new Error(JSON.stringify({ result, identity }));
        }

        process.kill = (pid, signal) => (
          pid < 0 ? true : originalKill.call(process, pid, signal)
        );
        const cleanupFailure = await testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: { IDACC_MCP_PID_FILE: ${JSON.stringify(failedIdentities)} },
        });
        if (!existsSync(${JSON.stringify(failedIdentities)})) {
          throw new Error('the cleanup-failure fixture did not publish its identities');
        }
        failedIdentity = JSON.parse(
          readFileSync(${JSON.stringify(failedIdentities)}, 'utf8'),
        );
        if (
          cleanupFailure.ok
          || !String(cleanupFailure.error || '').startsWith('MCP probe cleanup failed:')
          || ![failedIdentity.runner, failedIdentity.root, failedIdentity.descendant].some(alive)
        ) {
          throw new Error(JSON.stringify({ cleanupFailure, failedIdentity }));
        }

        const [
          blockedByRetainedCleanup,
          concurrentlyBlockedByRetainedCleanup,
        ] = await Promise.all([
          testMcpServer({
            transport: 'stdio',
            command: process.execPath,
            args: [${JSON.stringify(fixture)}],
            env: { IDACC_MCP_PID_FILE: ${JSON.stringify(blockedIdentities)} },
          }),
          testMcpServer({
            transport: 'stdio',
            command: process.execPath,
            args: [${JSON.stringify(fixture)}],
            env: {
              IDACC_MCP_PID_FILE: ${JSON.stringify(blockedConcurrentIdentities)},
            },
          }),
        ]);
        if (
          blockedByRetainedCleanup.ok
          || !String(blockedByRetainedCleanup.error || '')
            .includes('prior cleanup remains unconfirmed')
          || existsSync(${JSON.stringify(blockedIdentities)})
          || concurrentlyBlockedByRetainedCleanup.ok
          || !String(concurrentlyBlockedByRetainedCleanup.error || '')
            .includes('prior cleanup remains unconfirmed')
          || existsSync(${JSON.stringify(blockedConcurrentIdentities)})
        ) {
          throw new Error(JSON.stringify({
            blockedByRetainedCleanup,
            concurrentlyBlockedByRetainedCleanup,
          }));
        }
        process.kill = originalKill;

        const retried = await testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: { IDACC_MCP_PID_FILE: ${JSON.stringify(retriedIdentities)} },
        });
        if (!existsSync(${JSON.stringify(retriedIdentities)})) {
          throw new Error('the post-cleanup retry fixture did not launch');
        }
        retriedIdentity = JSON.parse(
          readFileSync(${JSON.stringify(retriedIdentities)}, 'utf8'),
        );
        const retryDeadline = Date.now() + 2_000;
        while (
          [
            failedIdentity.runner,
            failedIdentity.root,
            failedIdentity.descendant,
            retriedIdentity.runner,
            retriedIdentity.root,
            retriedIdentity.descendant,
          ].some(alive)
          && Date.now() < retryDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (
          !retried.ok
          || retried.tools?.[0] !== 'fixture-tool'
          || [
            failedIdentity.runner,
            failedIdentity.root,
            failedIdentity.descendant,
            retriedIdentity.runner,
            retriedIdentity.root,
            retriedIdentity.descendant,
          ].some(alive)
        ) {
          throw new Error(JSON.stringify({ retried, failedIdentity, retriedIdentity }));
        }

        let releasePostLaunch;
        let publishPostLaunch;
        const postLaunchGate = new Promise((resolve) => {
          releasePostLaunch = resolve;
        });
        const postLaunchEntered = new Promise((resolve) => {
          publishPostLaunch = resolve;
        });
        configureMcpProbeRuntime({
          runnerPath: ${JSON.stringify(mcpProbeRunnerPath)},
          runnerSha256: ${JSON.stringify(mcpProbeRunnerSha256)},
          platform: process.platform,
          timeoutMs: 2_000,
          graceMs: 50,
          forceWaitMs: 1_000,
          afterManagedLaunchForTest: async (launch) => {
            managedShutdownLaunch = launch;
            publishPostLaunch();
            await postLaunchGate;
          },
        });
        const racingProbe = testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: { IDACC_MCP_PID_FILE: ${JSON.stringify(shutdownIdentities)} },
        });
        await postLaunchEntered;
        const stopping = stopActiveMcpProbes();
        const concurrentStopping = stopActiveMcpProbes();
        if (concurrentStopping !== stopping) {
          throw new Error('concurrent MCP shutdown callers did not share one drain');
        }
        const blockedDuringShutdown = await testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: {
            IDACC_MCP_PID_FILE: ${JSON.stringify(shutdownBlockedIdentities)},
          },
        });
        if (
          blockedDuringShutdown.ok
          || !String(blockedDuringShutdown.error || '').includes('closed admission')
          || existsSync(${JSON.stringify(shutdownBlockedIdentities)})
        ) {
          throw new Error(JSON.stringify({ blockedDuringShutdown }));
        }
        let stopSettled = false;
        void stopping.then(
          () => { stopSettled = true; },
          () => { stopSettled = true; },
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (stopSettled) {
          throw new Error('MCP shutdown did not drain its admitted post-spawn launch');
        }
        releasePostLaunch();
        const [racingResult] = await Promise.all([racingProbe, stopping]);
        const raceCleanupDeadline = Date.now() + 2_000;
        while (
          alive(managedShutdownLaunch?.actualPid)
          && Date.now() < raceCleanupDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (existsSync(${JSON.stringify(shutdownIdentities)})) {
          shutdownIdentity = JSON.parse(
            readFileSync(${JSON.stringify(shutdownIdentities)}, 'utf8'),
          );
        }
        if (
          racingResult.ok
          || !String(racingResult.error || '').includes('closed admission')
          || alive(managedShutdownLaunch?.actualPid)
          || (
            shutdownIdentity
            && [
              shutdownIdentity.runner,
              shutdownIdentity.root,
              shutdownIdentity.descendant,
            ].some(alive)
          )
        ) {
          throw new Error(JSON.stringify({
            racingResult,
            managedShutdownLaunch: managedShutdownLaunch
              ? {
                  actualPid: managedShutdownLaunch.actualPid,
                  hostPid: managedShutdownLaunch.hostPid,
                  processGroupId: managedShutdownLaunch.processGroupId,
                }
              : null,
            shutdownIdentity,
          }));
        }

        configureMcpProbeRuntime({
          runnerPath: ${JSON.stringify(mcpProbeRunnerPath)},
          runnerSha256: ${JSON.stringify(mcpProbeRunnerSha256)},
          platform: process.platform,
          timeoutMs: 2_000,
          graceMs: 50,
          forceWaitMs: 1_000,
        });
        openMcpProbeAdmission();
        const reopened = await testMcpServer({
          transport: 'stdio',
          command: process.execPath,
          args: [${JSON.stringify(fixture)}],
          env: { IDACC_MCP_PID_FILE: ${JSON.stringify(reopenedIdentities)} },
        });
        if (!existsSync(${JSON.stringify(reopenedIdentities)})) {
          throw new Error('MCP admission did not reopen after confirmed cleanup');
        }
        reopenedIdentity = JSON.parse(
          readFileSync(${JSON.stringify(reopenedIdentities)}, 'utf8'),
        );
        const reopenedDeadline = Date.now() + 2_000;
        while (
          [reopenedIdentity.runner, reopenedIdentity.root, reopenedIdentity.descendant]
            .some(alive)
          && Date.now() < reopenedDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (
          !reopened.ok
          || reopened.tools?.[0] !== 'fixture-tool'
          || [reopenedIdentity.runner, reopenedIdentity.root, reopenedIdentity.descendant]
            .some(alive)
        ) {
          throw new Error(JSON.stringify({ reopened, reopenedIdentity }));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      } finally {
        process.kill = originalKill;
        for (const row of [
          identity,
          failedIdentity,
          retriedIdentity,
          shutdownIdentity,
          reopenedIdentity,
        ]) {
          const runner = Number(row?.runner || 0);
          if (Number.isSafeInteger(runner) && runner > 0 && runner !== process.pid) {
            try { process.kill(-runner, 'SIGKILL'); } catch {}
          }
        }
        for (const pid of [
          identity?.root,
          identity?.descendant,
          failedIdentity?.root,
          failedIdentity?.descendant,
          retriedIdentity?.root,
          retriedIdentity?.descendant,
          shutdownIdentity?.root,
          shutdownIdentity?.descendant,
          reopenedIdentity?.root,
          reopenedIdentity?.descendant,
        ]) {
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
        const managedGroup = Number(
          managedShutdownLaunch?.processGroupId
          || managedShutdownLaunch?.hostPid
          || 0,
        );
        if (
          Number.isSafeInteger(managedGroup)
          && managedGroup > 0
          && managedGroup !== process.pid
        ) {
          try { process.kill(-managedGroup, 'SIGKILL'); } catch {}
        }
      }
    `, 15_000);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const subscriptions = readFileSync(new URL('../src/main/subscriptions.ts', import.meta.url), 'utf8');
assert.ok(subscriptions.includes('env.PATH.split(delimiter)'), 'PATH parsing must use the host path delimiter');
assert.ok(subscriptions.includes('cliDirs().join(delimiter)'), 'augmented PATH assembly must use the host path delimiter');
assert.ok(subscriptions.includes('pathExt: process.env.PATHEXT'), 'Windows CLI discovery must use PATHEXT');
assert.ok(subscriptions.includes('executableCandidatePaths(directory, bin'), 'subscription probes must test executable suffix candidates');
assert.ok(
  subscriptions.includes('export function subscriptionRuntimeEnvironment()')
    && subscriptions.includes('CLAUDE_PATH: claude')
    && subscriptions.includes('ID_AGENT_CODEX_BIN: codex'),
  'desktop subscription detection must expose its augmented PATH and resolved core CLI paths to Manager',
);

const system = readFileSync(new URL('../src/main/system.ts', import.meta.url), 'utf8');
const platformGuard = system.indexOf('if (!terminalAutomationSupported(process.platform))');
const osascriptCall = system.indexOf("execFileP('osascript'");
assert.ok(platformGuard >= 0 && osascriptCall > platformGuard, 'non-macOS terminal actions must return before osascript');
assert.ok(system.includes('process.env.PATH.split(delimiter)'), 'system CLI PATH parsing must use the host delimiter');
assert.ok(system.includes('Set(dirs)).join(delimiter)'), 'system CLI PATH assembly must use the host delimiter');

const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
assert.ok(bridge.includes('process.env.PATH.split(delimiter)'), 'runtime model discovery must use the host PATH delimiter');
assert.ok(bridge.includes('Set(dirs)).join(delimiter)'), 'runtime model PATH assembly must use the host delimiter');

const wizard = readFileSync(new URL('../src/renderer/components/FirstRunWizard.tsx', import.meta.url), 'utf8');
assert.ok(
  wizard.includes('navigator.clipboard.writeText(resolution.command)'),
  'first-run subscription actions must copy a returned manual command',
);
assert.ok(
  wizard.includes("resolution.kind === 'manual'"),
  'first-run subscription actions must handle a manual command before surfacing an error',
);
assert.ok(
  wizard.includes('${resolution.command}'),
  'first-run subscription actions must keep the manual command visible when clipboard access is unavailable',
);
assert.ok(
  wizard.includes('REFRESH_UI_TIMEOUT_MS')
    && wizard.includes('withUiDeadline('),
  'first-run provider refresh must have a bounded renderer wait',
);
assert.ok(
  wizard.includes('const interactionLocked = working || refreshing')
    && /disabled=\{working\} onClick=\{\(\) => void resume\(\)\}>Continue setup<\/button>/.test(wizard),
  'a route refresh must not share the mutation lock that disables Continue setup',
);

const unifiedStack = readFileSync(new URL('../src/main/unifiedStack.ts', import.meta.url), 'utf8');
assert.ok(
  unifiedStack.includes("service.spec.name === 'manager'")
    && unifiedStack.includes('? subscriptionRuntimeEnvironment()')
    && unifiedStack.includes(': externalChildEnvironment()'),
  'the bundled Manager must inherit the desktop subscription runtime environment',
);
assert.ok(
  !unifiedStack.includes('process.env.BRAIN_TOKEN ='),
  'the generated Brain bearer must never be written to the Electron process environment',
);

const mcpTest = readFileSync(new URL('../src/main/mcpTest.ts', import.meta.url), 'utf8');
const mcpProbeRunner = readFileSync(new URL('../src/main/mcp-probe-runner.cjs', import.meta.url), 'utf8');
assert.ok(mcpTest.includes('pathExt: env.PATHEXT'), 'MCP command resolution must honor PATHEXT');
assert.ok(mcpProbeRunner.includes('crossSpawn(command, args'), 'the contained MCP runner must safely escape Windows command-shim arguments');
assert.ok(mcpTest.includes('spawnManagedProcessTree('), 'MCP tests must launch in an app-owned managed process tree');
assert.ok(mcpTest.includes('MCP probe cleanup failed'), 'MCP tests must explicitly report an unconfirmed process-tree cleanup');
assert.ok(
  mcpTest.includes('mcpProbeAdmissionClosed = true')
    && mcpTest.includes('await drainMcpProbeLaunches()'),
  'MCP shutdown must close admission and drain in-flight launches before its ownership snapshot',
);
assert.ok(
  mcpTest.includes('retryFailedMcpProbeCleanup()')
    && mcpTest.includes('the new probe was blocked')
    && mcpTest.includes('if (probe.cleanup) return probe.cleanup'),
  'new MCP probes must serialize retry and block on prior unconfirmed cleanup obligations',
);
assert.ok(!mcpTest.includes('shell: launch.shell'), 'MCP launch must not interpolate configured arguments into a raw shell command');

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
assert.ok(
  main.includes("startBackgroundStack(args[0], args[1], appProfilePaths().logs)"),
  'background stack logs must be rooted in the selected application profile',
);
assert.ok(
  main.includes('trackBackgroundStop(stopActiveMcpProbes())'),
  'application shutdown must drain every still-owned MCP probe tree',
);
assert.ok(
  main.includes('trackBackgroundStop(stopAllBackgroundStacks())')
    && main.includes('openBackgroundStackAdmission()'),
  'application shutdown must drain every IDACC-owned background stack and recoverable startup must reopen admission only after cleanup',
);
assert.ok(
  main.includes('openMcpProbeAdmission()'),
  'a recoverable consumer startup must reopen MCP admission only after cleanup',
);

console.log('subscription portability smoke: ok');
// On Windows, tsx retains a loader IPC handle after this synchronous policy
// script has completed. All Windows process-tree behavior is covered by the
// dedicated native Job Host integration gate, so return success explicitly
// after every assertion above has run.
if (process.platform === 'win32') process.exit(0);
