import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalLoopbackServiceUrl,
  BRAIN_LISTENER_STATUS_MAX_BYTES,
  readBrainListenerStatusFile,
  parseRuntimeManifest,
  restartDelayMs,
  rotateServiceLog,
  shouldOpenCrashFuse,
  validateServiceHealth,
  validateBrainListenerStatus,
  manifestDigestMatches,
  runtimeManifestSha256,
  verifyRuntimePayload,
} from '../src/main/unifiedStackPolicy.ts';
import {
  defaultBrainAutomationSettings,
  normalizeBrainAutomationSettings,
} from '../../idctl/src/settings/schema.ts';
import {
  createManagedProcessLaunchCoordinator,
  killExactSpawnedChild,
  managedProcessTreeTerminationFailed,
  terminateManagedProcessTree,
} from '../src/main/managedProcessTree.ts';
import {
  loadSettings,
  setBrainAutomationSettings,
} from '../../idctl/src/settings/store.ts';
import {
  evaluateRuntimeApplicationVersionContract,
} from '../src/main/runtimeApplicationVersion.ts';
import {
  BrainDashboardChildWindowRegistry,
  authorizeBrainDashboardRequest,
  brainDashboardNavigationAllowed,
  canonicalBrainDashboardOrigin,
  denyBrainDashboardRequest,
} from '../src/main/brainDashboardSession.ts';

class FakeManagedChild extends EventEmitter {
  constructor(pid, onKill = () => {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = [];
    this.onKill = onKill;
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.onKill(signal, this);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

const managedProcessTreeSource = readFileSync(
  new URL('../src/main/managedProcessTree.ts', import.meta.url),
  'utf8',
);
const unifiedStackSource = readFileSync(
  new URL('../src/main/unifiedStack.ts', import.meta.url),
  'utf8',
);
const desktopMainSource = readFileSync(
  new URL('../src/main/main.ts', import.meta.url),
  'utf8',
);
const dashboardWindowPolicySource = desktopMainSource.slice(
  desktopMainSource.indexOf('function configureBrainDashboardWindow('),
  desktopMainSource.indexOf('function ensureBrainDashboardSession('),
);
const managerPolicySourcePath = process.env.IDACC_MANAGER_SOURCE
  ? join(process.env.IDACC_MANAGER_SOURCE, 'src', 'agent-manager-db.ts')
  : new URL('../../.runtime-sources/manager/src/agent-manager-db.ts', import.meta.url);
const managerSource = existsSync(managerPolicySourcePath)
  ? readFileSync(managerPolicySourcePath, 'utf8')
  : '';
if (process.env.IDACC_REQUIRE_MANAGER_POLICY_SOURCE === '1' && !managerSource) {
  throw new Error(`required pinned Manager policy source is unavailable at ${String(managerPolicySourcePath)}`);
}
const supervisorIntegrationSource = readFileSync(
  new URL('./unified-stack-supervisor-integration.mjs', import.meta.url),
  'utf8',
);
const windowsJobHostSource = readFileSync(
  new URL('../src/native/IdaccJobHost.cs', import.meta.url),
  'utf8',
);
const managedBootstrapSource = readFileSync(
  new URL('../src/main/managed-service-bootstrap.cjs', import.meta.url),
  'utf8',
);
const desktopBuildSource = readFileSync(
  new URL('./build.mjs', import.meta.url),
  'utf8',
);
assert.deepEqual(
  evaluateRuntimeApplicationVersionContract({
    applicationVersion: '1.2.3',
    compiledApplicationVersion: '1.2.3',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.3',
    reviewBuild: false,
  }),
  { ok: true, runtimeVersion: '1.2.3' },
  'production packages must retain exact application/source/runtime equality',
);
assert.equal(
  evaluateRuntimeApplicationVersionContract({
    applicationVersion: '1.2.3',
    compiledApplicationVersion: '1.2.3',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.3',
    reviewBuild: true,
  }).ok,
  true,
  'a review-channel package must retain the stable source version',
);
for (const fixture of [
  {
    applicationVersion: '1.2.3-review.7',
    compiledApplicationVersion: '1.2.3-review.7',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.3',
    reviewBuild: true,
  },
  {
    applicationVersion: '1.2.4',
    compiledApplicationVersion: '1.2.4',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.3',
    reviewBuild: true,
  },
  {
    applicationVersion: '1.2.4',
    compiledApplicationVersion: '1.2.3',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.3',
    reviewBuild: true,
  },
  {
    applicationVersion: '1.2.3',
    compiledApplicationVersion: '1.2.3',
    compiledSourceVersion: '1.2.3',
    manifestVersion: '1.2.4',
    reviewBuild: true,
  },
  {
    applicationVersion: 'not-semver',
    compiledApplicationVersion: 'not-semver',
    compiledSourceVersion: 'not-semver',
    manifestVersion: 'not-semver',
    reviewBuild: true,
  },
]) {
  assert.equal(
    evaluateRuntimeApplicationVersionContract(fixture).ok,
    false,
    `runtime application version contract must reject ${JSON.stringify(fixture)}`,
  );
}
assert.match(
  desktopBuildSource,
  /__IDACC_SOURCE_PACKAGE_VERSION__:\s*JSON\.stringify\(sourcePackageVersion\)/,
  'the packaged supervisor must compile the exact source package version',
);
assert.match(
  desktopBuildSource,
  /__IDACC_PACKAGED_APPLICATION_VERSION__:\s*JSON\.stringify\([\s\S]*reviewVersion \|\| sourcePackageVersion/,
  'the packaged supervisor must compile the exact application identity',
);
assert.match(
  unifiedStackSource,
  /evaluateRuntimeApplicationVersionContract\(\{[\s\S]*manifestVersion:\s*manifest\.application\.version[\s\S]*reviewBuild:\s*COMPILED_REVIEW_BUILD/,
  'runtime admission must enforce the compiled application/source version contract',
);
assert.match(
  unifiedStackSource,
  /const STARTUP_GRACE_MS = 2 \* 60_000/,
  'recovered fleets must receive a bounded two-minute Manager restore window before watchdog restart',
);
assert.match(managedProcessTreeSource, /shell:\s*false/);
assert.match(managedProcessTreeSource, /windowsHide:\s*true/);
assert.match(managedProcessTreeSource, /Get-AuthenticodeSignature/);
assert.match(managedProcessTreeSource, /SignerCertificate\.Subject -cne/);
assert.match(managedProcessTreeSource, /windowsManagedJobs = new WeakMap/);
assert.doesNotMatch(
  managedProcessTreeSource,
  /env:\s*process\.env/,
  'the system process-tree helper must not inherit application credentials',
);
assert.match(
  supervisorIntegrationSource,
  /win32\.join\(systemRoot, 'System32', 'taskkill\.exe'\)/,
  'the Windows test harness must resolve its cleanup helper from System32',
);
assert.match(
  supervisorIntegrationSource,
  /\['\/PID', String\(pid\), '\/T', '\/F'\]/,
  'the Windows test harness must clean only its retained app PID and descendants',
);
assert.doesNotMatch(
  managedProcessTreeSource,
  /\btaskkill(?:\.exe)?\b/i,
  'Windows process-tree cleanup must not escape its retained Job Host',
);
assert.match(windowsJobHostSource, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
assert.match(windowsJobHostSource, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
assert.match(windowsJobHostSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
assert.match(windowsJobHostSource, /ReadBoundedLine\(Console\.In, MAX_CONFIG_CHARS\)/);
assert.match(windowsJobHostSource, /QueryInformationJobObject/);
assert.match(
  windowsJobHostSource,
  /AcknowledgementOutcome\.StopRequested[\s\S]*TerminateAndDrainJob[\s\S]*DRAIN_FAILED_EXIT_CODE/,
  'a pre-STARTED STOP must produce a queried-empty result before launch rejection',
);
assert.match(
  windowsJobHostSource,
  /!managedChildCreated[\s\S]*NO_CHILD_CREATED_EXIT_CODE[\s\S]*managedJobEmptyConfirmed[\s\S]*CREATED_JOB_DRAINED_EXIT_CODE/,
  'pre-READY failures must distinguish no child from a created and queried-empty Job',
);
assert.match(
  managedProcessTreeSource,
  /actualPid === undefined[\s\S]*WINDOWS_JOB_HOST_NO_CHILD_EXIT_CODE/,
  'the no-child proof must be accepted only before a READY runtime identity exists',
);
assert.match(
  managedProcessTreeSource,
  /host\.stderr\?\.pause\(\)[\s\S]*host\.stderr\?\.unshift\(bufferedStderr\)/,
  'runtime stderr racing the STARTED handshake must be buffered and restored',
);
assert.match(managedBootstrapSource, /process\.stdin\.once\('end', requestManagedStop\)/);
assert.match(managedBootstrapSource, /process\.emit\('SIGTERM', 'SIGTERM'\)/);
assert.doesNotMatch(
  unifiedStackSource,
  /\bchild\.kill\(['"]SIG(?:TERM|KILL)['"]\)/,
  'unified services must terminate through the managed process-tree boundary',
);
assert.match(
  unifiedStackSource,
  /stackManagerServiceToken = randomBytes\(32\)\.toString\('base64url'\)/,
  'the supervisor must generate a distinct per-run Manager service bearer',
);
assert.match(
  unifiedStackSource,
  /service\.spec\.name === 'manager' && !stackManagerServiceToken[\s\S]*managed Manager service credential is unavailable/,
  'managed Manager startup must fail closed without its service bearer',
);
assert.match(
  unifiedStackSource,
  /name === 'brain-listener' && stackManagerServiceToken[\s\S]*env\.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken/,
  'only the Brain listener companion may receive the Manager service bearer',
);
assert.match(
  unifiedStackSource,
  /\(service\.spec\.name === 'manager' \|\| service\.spec\.name === 'brain'\)[\s\S]*childEnv\.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken/,
  'only the Manager and Brain services may receive the Manager service bearer',
);
assert.match(
  unifiedStackSource,
  /\[stackBrainToken,\s*stackAdminToken,\s*stackManagerServiceToken\]\.some/,
  'credential leak guards must cover all three runtime bearers',
);
assert.match(
  unifiedStackSource,
  /new Set\(\[[\s\S]*stackBrainToken[\s\S]*stackAdminToken[\s\S]*stackManagerServiceToken[\s\S]*\]\)\.size !== 3/,
  'startup must fail closed unless all three generated runtime bearers are pairwise distinct',
);
assert.match(
  unifiedStackSource,
  /credentials\.length === 3[\s\S]*new Set\(credentials\)\.size === 3/,
  'the credential guard positive control must prove pairwise token distinction',
);
assert.match(
  supervisorIntegrationSource,
  /managerSensitiveReadsProtected[\s\S]*managerBrainServiceReadsSucceeded/,
  'the integration smoke must prove the Manager anonymous and Brain-service read boundaries',
);
assert.equal(
  (unifiedStackSource.match(/spawnManagedProcessTree\(process\.execPath/g) ?? []).length,
  2,
  'service and companion roots must each launch through the managed process boundary',
);
assert.equal(
  (unifiedStackSource.match(/retainedManagedProcessTreeLaunchFailure\(error\)/g) ?? []).length,
  2,
  'service and companion launch failures must retain every unconfirmed Windows Job',
);
assert.equal(
  (unifiedStackSource.match(/replacement is blocked/g) ?? []).length,
  2,
  'an unconfirmed launch cleanup must block service and companion replacement',
);
assert.match(
  managedProcessTreeSource,
  /windowsAbortAfterReadyForTest[\s\S]*fail\('Windows Job Host launch aborted after READY/,
  'the Windows integration seam must fail after CreateProcess and before STARTED',
);
assert.match(
  desktopBuildSource,
  /__IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__:\s*'false'/,
  'packaged builds must compile the post-CreateProcess fault injection inert',
);
assert.doesNotMatch(
  unifiedStackSource,
  /windows(?:AbortAfterReady|ForceLaunchCleanupTimeout)ForTest/,
  'profile, service, companion, and renderer inputs must not activate Job Host fault injection',
);
assert.equal(
  (
    unifiedStackSource.match(
      /process\.platform !== 'win32'\s*&& !is(?:CompanionAlive|ChildAlive)\(/g,
    ) ?? []
  ).length,
  2,
  'Windows shutdown retries must re-evaluate an exact retained host instead of pre-recording a stale failure',
);
assert.equal(
  (managedProcessTreeSource.match(/detached:\s*true/g) ?? []).length,
  1,
  'POSIX managed roots must create one isolated process group at the boundary',
);
assert.match(
  unifiedStackSource,
  /pid:\s*running \? service\.actualPid/,
  'service status must publish the runtime PID rather than the Windows host PID',
);
assert.match(
  unifiedStackSource,
  /if \(shutdownPromise\) return shutdownPromise/,
  'concurrent shutdown calls must share one attempt',
);
if (managerSource) {
  assert.match(
    managerSource,
    /if \(!this\.startupReady\) \{\s*return res\.status\(503\)\.json\(\{\s*status: 'starting'/,
    'the Manager health endpoint must not advertise readiness before its control plane is initialized',
  );
  assert.match(
    managerSource,
    /this\.fleetRestoring = true;\s*try \{\s*await this\.restoreManagerOwnedAgentsAtStartup\('leadership'\);\s*this\.startupReady = true;\s*await this\.restoreManagerOwnedAgentsAtStartup\('workers'\);\s*\} finally \{\s*this\.fleetRestoring = false;\s*\}[\s\S]*this\.schedulerService\.start\(\);[\s\S]*settled = true;/,
    'the Manager must restore its leadership spine before becoming health-ready, finish bounded worker restoration, and keep automatic schedules gated until then',
  );
  assert.match(
    managerSource,
    /restoreManagerOwnedAgentsAtStartup[\s\S]*await this\.restoreManagerOwnedAgentsAfterRestart\(phase\);[\s\S]*await sleep\(graceMs\);[\s\S]*await this\.restoreManagerOwnedAgentsAfterRestart\(phase\);/,
    'managed startup must make a bounded second marker pass after old workers run their parent-death watchdog',
  );
  assert.match(
    managerSource,
    /if \(process\.env\.IDACC_MANAGED_SERVICE !== '1'\) return 0;/,
    'standalone Manager startup must not inherit the managed parent-watchdog grace delay',
  );
  assert.match(
    managerSource,
    /startIdleParkingSweeper\(\): void \{[\s\S]*if \(process\.env\.ID_IDLE_PARK_ENABLED !== 'true'\) return;/,
    'automatic idle parking must remain disabled unless an operator explicitly opts in',
  );
  assert.doesNotMatch(
    managerSource,
    /startIdleParkingSweeper\(\): void \{[\s\S]{0,800}ID_IDLE_PARK_DISABLED/,
    'absence of an opt-out flag must never authorize automatic agent shutdown',
  );
}
assert.match(
  unifiedStackSource,
  /ID_AUTO_ATTACH_BRAIN_MCP:\s*'1'/,
  'managed Manager must pin automatic Brain MCP attachment on',
);
assert.match(
  unifiedStackSource,
  /BRAIN_CONTEXT_DISABLED:\s*'false'/,
  'managed Manager must pin Brain context/control integration on',
);
assert.match(
  unifiedStackSource,
  /stopping = true;[\s\S]*await managedLaunches\.drain\(\);[\s\S]*for \(const companion of companions\.values\(\)\)/,
  'shutdown must drain admitted launches before enumerating owned children',
);
assert.match(
  unifiedStackSource,
  /if \(processTreeError\) \{\s*service\.phase = 'unhealthy';\s*return;\s*\}\s*if \(manualRestart\)/,
  'a service replacement must stay blocked when prior-tree cleanup fails',
);
assert.match(
  unifiedStackSource,
  /if \(processTreeError\) \{\s*companion\.phase = 'unhealthy';\s*return;\s*\}[\s\S]{0,900}companion\.restartAttempts/,
  'a companion replacement must stay blocked when prior-tree cleanup fails',
);

{
  const invalid = new FakeManagedChild(undefined);
  assert.equal(killExactSpawnedChild(invalid, 'SIGKILL', 100), false);
  assert.deepEqual(
    invalid.killCalls,
    [],
    'a failed spawn without a PID must never cross ChildProcess.kill()',
  );

  const self = new FakeManagedChild(100);
  assert.equal(killExactSpawnedChild(self, 'SIGKILL', 100), false);
  assert.deepEqual(
    self.killCalls,
    [],
    'a child handle that resolves to the caller PID must never be signalled',
  );

  const exact = new FakeManagedChild(101);
  assert.equal(killExactSpawnedChild(exact, 'SIGTERM', 100), true);
  assert.deepEqual(exact.killCalls, ['SIGTERM']);
}

{
  // Keep the regression isolated: before the safe-identity boundary, Node can
  // terminate this probe when ChildProcess.kill() is called after ENOENT with
  // an undefined child.pid.
  const managedProcessTreeUrl = new URL(
    '../src/main/managedProcessTree.ts',
    import.meta.url,
  ).href;
  const missingExecutable = join(
    tmpdir(),
    `idacc-managed-process-missing-${process.pid}`,
  );
  const source = `
    import { spawnManagedProcessTree } from ${JSON.stringify(managedProcessTreeUrl)};
    let uncaught = '';
    process.on('uncaughtException', (error) => {
      uncaught = error instanceof Error ? error.message : String(error);
    });
    let rejection = '';
    try {
      await spawnManagedProcessTree(${JSON.stringify(missingExecutable)}, [], {
        cwd: ${JSON.stringify(tmpdir())},
        env: {},
        platform: 'linux',
      });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!rejection || uncaught) {
      console.error(JSON.stringify({ rejection, uncaught }));
      process.exitCode = 2;
    }
  `;
  const probe = spawnSync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    source,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(
    probe.signal,
    null,
    `missing managed executable killed its caller: ${probe.stderr || probe.stdout}`,
  );
  assert.equal(
    probe.status,
    0,
    `missing managed executable was not rejected cleanly: ${probe.stderr || probe.stdout}`,
  );
}

{
  const coordinator = createManagedProcessLaunchCoordinator();
  const owner = {};
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  let installed = false;
  const first = coordinator.run(owner, async () => {
    await launchGate;
    installed = true;
  });
  const duplicate = coordinator.run(owner, async () => {
    throw new Error('a duplicate owner launch must never run');
  });
  assert.equal(first, duplicate, 'managed launches must be single-flight per owner');
  assert.equal(coordinator.activeCount(), 1);
  const drained = coordinator.drain();
  let drainSettled = false;
  void drained.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert.equal(drainSettled, false, 'shutdown drain must wait for an admitted launch');
  releaseLaunch();
  await drained;
  assert.equal(installed, true);
  assert.equal(coordinator.activeCount(), 0);
}

{
  const child = new FakeManagedChild(7272);
  const groupSignals = [];
  let groupAlive = true;
  const result = await terminateManagedProcessTree(
    child,
    () => true,
    {
      platform: 'linux',
      currentPid: 100,
      detachedProcessGroup: true,
      graceMs: 1,
      forceWaitMs: 5,
      killProcess: (pid, signal) => {
        if (signal === 0) return groupAlive;
        groupSignals.push([pid, signal]);
        if (signal === 'SIGTERM') {
          // The root exits gracefully while an inherited descendant remains.
          child.exit(0);
        } else if (signal === 'SIGKILL') {
          groupAlive = false;
        }
        return true;
      },
    },
  );
  assert.deepEqual(groupSignals, [
    [-7272, 'SIGTERM'],
    [-7272, 'SIGKILL'],
  ]);
  assert.deepEqual(child.killCalls, []);
  assert.equal(result.treeKillSucceeded, true);
  assert.equal(result.exited, true);
}

{
  const child = new FakeManagedChild(7373);
  child.exit(0);
  const groupSignals = [];
  const result = await terminateManagedProcessTree(
    child,
    () => true,
    {
      platform: 'linux',
      currentPid: 100,
      detachedProcessGroup: true,
      ownedProcessGroupId: 7374,
      killProcess: (pid, signal) => {
        groupSignals.push([pid, signal]);
        return true;
      },
    },
  );
  assert.equal(result.accepted, false);
  assert.deepEqual(groupSignals, []);
}

if (process.platform !== 'win32') {
  const fixture = mkdtempSync(join(tmpdir(), 'idacc-process-group-'));
  const descendantPidPath = join(fixture, 'descendant.pid');
  let processGroupId;
  try {
    const descendantSource = `
      process.on('SIGTERM', () => {});
      if (process.send) process.send('ready');
      setInterval(() => {}, 1_000);
    `;
    const rootSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      descendant.once('message', () => {
        writeFileSync(process.env.IDACC_TEST_DESCENDANT_PID_FILE, String(descendant.pid), {
          mode: 0o600,
        });
        process.exit(0);
      });
      setTimeout(() => process.exit(2), 5_000).unref();
    `;
    const root = spawn(process.execPath, ['-e', rootSource], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        IDACC_TEST_DESCENDANT_PID_FILE: descendantPidPath,
      },
    });
    processGroupId = Number(root.pid);
    assert.equal(Number.isSafeInteger(processGroupId) && processGroupId > 0, true);
    await new Promise((resolve, reject) => {
      root.once('error', reject);
      root.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`process-group fixture root exited with ${code ?? signal}`));
      });
    });

    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim());
    assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
    assert.doesNotThrow(
      () => process.kill(descendantPid, 0),
      'the fixture descendant must survive its process-group root',
    );

    const result = await terminateManagedProcessTree(
      root,
      () => true,
      {
        platform: process.platform,
        currentPid: process.pid,
        detachedProcessGroup: true,
        ownedProcessGroupId: processGroupId,
        graceMs: 100,
        forceWaitMs: 3_000,
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(result.exited, true);
    assert.equal(result.treeKillAttempted, true);
    assert.equal(result.treeKillSucceeded, true);
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === 'ESRCH',
      'tree termination must remove a descendant after its root has exited',
    );
  } finally {
    if (Number.isSafeInteger(processGroupId) && processGroupId > 0) {
      try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* group is already gone */ }
    }
    rmSync(fixture, { recursive: true, force: true });
  }
}

assert.deepEqual(defaultBrainAutomationSettings(), {
  cycleEnabled: false,
  cycleCadenceHours: 24,
});
assert.deepEqual(normalizeBrainAutomationSettings(), {
  cycleEnabled: false,
  cycleCadenceHours: 24,
});
assert.deepEqual(normalizeBrainAutomationSettings({
  cycleEnabled: false,
  cycleCadenceHours: 72,
}), {
  cycleEnabled: false,
  cycleCadenceHours: 72,
});
assert.deepEqual(normalizeBrainAutomationSettings({
  cycleEnabled: true,
  cycleCadenceHours: 0,
}), {
  cycleEnabled: true,
  cycleCadenceHours: 24,
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (record, path = record.path) => JSON.stringify({
  path,
  type: record.type,
  size: record.size,
  sha256: record.sha256,
  ...(record.type === 'symlink' ? { target: record.target } : {}),
});
const treeHash = (records, prefix = '') => {
  const normalized = prefix ? `${prefix}/` : '';
  const lines = records
    .filter((record) => !normalized || record.path.startsWith(normalized))
    .map((record) => canonical(record, normalized ? record.path.slice(normalized.length) : record.path))
    .join('\n');
  return sha256(lines ? `${lines}\n` : '');
};
const fixtureFiles = [
  { path: 'brain/brain.mjs', type: 'file', size: 0, sha256: sha256('') },
  { path: 'manager/dist/start-agent-manager.js', type: 'file', size: 0, sha256: sha256('') },
];
const manifestValue = {
  schemaVersion: 2,
  generatedAt: '2026-07-25T00:00:00.000Z',
  application: {
    name: 'idagents-control-center',
    version: '1.0.0',
    commit: '7'.repeat(40),
    tree: '8'.repeat(40),
    dirty: false,
  },
  components: {
    manager: {
      repository: 'https://example.com/manager.git',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      version: '1.2.3',
      packageLockSha256: '3'.repeat(64),
      entrypoint: 'dist/start-agent-manager.js',
      serviceId: 'idacc-manager',
    },
    brain: {
      repository: 'https://example.com/brain.git',
      commit: '4'.repeat(40),
      tree: '5'.repeat(40),
      version: '4.5.6',
      packageLockSha256: '6'.repeat(64),
      entrypoint: 'brain.mjs',
      serviceId: 'idacc-brain',
      distributionSource: {
        mode: 'vendored-capsule',
        path: 'release/runtime-sources/brain',
        manifest: 'release/runtime-sources/brain.capsule.json',
        manifestSha256: '9'.repeat(64),
        treeSha256: 'a'.repeat(64),
      },
    },
  },
  trees: {
    manager: treeHash(fixtureFiles, 'manager'),
    brain: treeHash(fixtureFiles, 'brain'),
    runtime: treeHash(fixtureFiles),
  },
  files: fixtureFiles,
};
const manifest = parseRuntimeManifest(manifestValue);
assert.equal(manifest.components.manager.version, '1.2.3');
assert.deepEqual(
  manifest.components.brain.distributionSource,
  manifestValue.components.brain.distributionSource,
  'production manifest parsing must preserve Brain capsule provenance',
);
for (const distributionSource of [
  { ...manifestValue.components.brain.distributionSource, path: '../brain' },
  { ...manifestValue.components.brain.distributionSource, manifest: '/tmp/brain.json' },
  { ...manifestValue.components.brain.distributionSource, manifestSha256: 'invalid' },
  { ...manifestValue.components.brain.distributionSource, extra: 'untrusted' },
]) {
  assert.throws(
    () => parseRuntimeManifest({
      ...manifestValue,
      components: {
        ...manifestValue.components,
        brain: {
          ...manifestValue.components.brain,
          distributionSource,
        },
      },
    }),
    /components\.brain is invalid/,
    'production manifest parsing must reject malformed capsule provenance',
  );
}
const npmBinTarget = '../which/bin/node-which';
const symlinkFixtureFiles = [
  ...fixtureFiles,
  {
    path: 'brain/node_modules/.bin/node-which',
    type: 'symlink',
    size: Buffer.byteLength(npmBinTarget),
    sha256: sha256(`symlink\0${npmBinTarget}`),
    target: npmBinTarget,
  },
].sort((left, right) => left.path.localeCompare(right.path));
const symlinkManifestValue = {
  ...manifestValue,
  trees: {
    manager: treeHash(symlinkFixtureFiles, 'manager'),
    brain: treeHash(symlinkFixtureFiles, 'brain'),
    runtime: treeHash(symlinkFixtureFiles),
  },
  files: symlinkFixtureFiles,
};
assert.equal(
  parseRuntimeManifest(symlinkManifestValue).files
    .find((record) => record.type === 'symlink')?.target,
  npmBinTarget,
  'production manifest parsing must accept npm .bin links that remain inside the runtime root',
);
for (const unsafeTarget of [
  '../../../../outside-runtime',
  '/tmp/outside-runtime',
  'C:/outside-runtime',
  '..\\outside-runtime',
]) {
  assert.throws(
    () => parseRuntimeManifest({
      ...symlinkManifestValue,
      files: symlinkFixtureFiles.map((record) => (
        record.type === 'symlink'
          ? {
              ...record,
              target: unsafeTarget,
              size: Buffer.byteLength(unsafeTarget),
              sha256: sha256(`symlink\0${unsafeTarget}`),
            }
          : record
      )),
    }),
    /files\[\d+\] is invalid/,
    `production manifest parsing must reject unsafe symlink target ${unsafeTarget}`,
  );
}
assert.throws(
  () => parseRuntimeManifest({ schemaVersion: 1, components: {} }),
  /schemaVersion/,
);
assert.throws(
  () => parseRuntimeManifest({ schemaVersion: 2, generatedAt: 'now', components: {} }),
  /components.manager/,
);
const serializedManifest = JSON.stringify(manifestValue);
assert.equal(manifestDigestMatches(serializedManifest, runtimeManifestSha256(serializedManifest)), true);
assert.equal(manifestDigestMatches(`${serializedManifest} `, runtimeManifestSha256(serializedManifest)), false);

const listenerStatusRoot = mkdtempSync(join(tmpdir(), 'idacc-listener-status-'));
try {
  const statusPath = join(listenerStatusRoot, 'brain-listener-status.json');
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const listenerNonce = 'listener-process-nonce';
  const listenerPid = 42_424;
  const validStatus = {
    schemaVersion: 1,
    instanceNonce: listenerNonce,
    pid: listenerPid,
    primaryTeam: { id: 'default', name: 'Default', active: true },
    teamCount: 1,
    lastSuccessfulPollAt: new Date(now - 1_000).toISOString(),
    cursors: [{ id: 'default', name: 'Default', seq: 17 }],
  };
  writeFileSync(statusPath, JSON.stringify(validStatus), { mode: 0o600 });
  assert.deepEqual(
    readBrainListenerStatusFile(statusPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }),
    {
      healthy: true,
      lastSuccessfulPollAt: validStatus.lastSuccessfulPollAt,
      teamCount: 1,
      primaryTeam: { id: 'default', name: 'Default', active: true },
    },
    'a fresh process-bound listener poll must satisfy readiness',
  );
  assert.match(
    validateBrainListenerStatus(
      { ...validStatus, instanceNonce: 'stale-process-nonce' },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /managed process/,
    'a listener status from an earlier spawn must not satisfy readiness',
  );
  const staleStatus = validateBrainListenerStatus(
    {
      ...validStatus,
      lastSuccessfulPollAt: new Date(now - 30_001).toISOString(),
    },
    { instanceNonce: listenerNonce, pid: listenerPid, now },
  );
  assert.equal(staleStatus.healthy, false);
  assert.equal(staleStatus.lastSuccessfulPollAt, new Date(now - 30_001).toISOString());
  assert.match(staleStatus.error || '', /recently/);
  assert.match(
    validateBrainListenerStatus(
      { ...validStatus, pid: listenerPid + 1 },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /managed process/,
  );
  const inactivePrimary = validateBrainListenerStatus({
    ...validStatus,
    primaryTeam: { ...validStatus.primaryTeam, active: false },
    cursors: [{ id: 'research-id', name: 'Research', seq: 3 }],
  }, { instanceNonce: listenerNonce, pid: listenerPid, now });
  assert.equal(inactivePrimary.healthy, true);
  assert.equal(inactivePrimary.primaryTeam?.active, false);
  assert.match(
    validateBrainListenerStatus(
      {
        ...validStatus,
        primaryTeam: { ...validStatus.primaryTeam, active: false },
      },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /activity disagreed/,
  );

  const missingStatusPath = join(listenerStatusRoot, 'never-published.json');
  for (const checkedAt of [now, now + 60_000]) {
    const missing = readBrainListenerStatusFile(missingStatusPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now: checkedAt,
    });
    assert.equal(missing.healthy, false);
    assert.match(missing.error || '', /not present/);
  }

  const malformedPath = join(listenerStatusRoot, 'malformed.json');
  writeFileSync(malformedPath, '{"schemaVersion":', { mode: 0o600 });
  assert.match(
    readBrainListenerStatusFile(malformedPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }).error || '',
    /valid JSON/,
  );

  const oversizedPath = join(listenerStatusRoot, 'oversized.json');
  writeFileSync(oversizedPath, Buffer.alloc(BRAIN_LISTENER_STATUS_MAX_BYTES + 1), { mode: 0o600 });
  assert.match(
    readBrainListenerStatusFile(oversizedPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }).error || '',
    /size limit/,
  );

  if (process.platform !== 'win32') {
    const symlinkPath = join(listenerStatusRoot, 'status-link.json');
    symlinkSync(statusPath, symlinkPath);
    assert.match(
      readBrainListenerStatusFile(symlinkPath, {
        instanceNonce: listenerNonce,
        pid: listenerPid,
        now,
      }).error || '',
      /symbolic link/,
    );
    chmodSync(statusPath, 0o644);
    assert.match(
      readBrainListenerStatusFile(statusPath, {
        instanceNonce: listenerNonce,
        pid: listenerPid,
        now,
      }).error || '',
      /not private/,
    );
  }
} finally {
  rmSync(listenerStatusRoot, { recursive: true, force: true });
}

const integrityRoot = mkdtempSync(join(tmpdir(), 'idacc-runtime-integrity-'));
try {
  mkdirSync(join(integrityRoot, 'manager', 'dist'), { recursive: true });
  mkdirSync(join(integrityRoot, 'brain'), { recursive: true });
  writeFileSync(join(integrityRoot, 'manager', 'dist', 'start-agent-manager.js'), '');
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), '');
  assert.deepEqual(verifyRuntimePayload(integrityRoot, manifest), []);
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), 'tampered');
  assert.match(verifyRuntimePayload(integrityRoot, manifest).join('\n'), /size changed|digest changed/);
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), '');
  writeFileSync(join(integrityRoot, 'brain', 'injected.mjs'), 'injected');
  assert.match(verifyRuntimePayload(integrityRoot, manifest).join('\n'), /unmanifested file/);
} finally {
  rmSync(integrityRoot, { recursive: true, force: true });
}

const nonce = 'test-instance-nonce';
const attested = validateServiceHealth('manager', {
  status: 'ok',
  service: 'idacc-manager',
  runtimeVersion: '1.2.3',
  instanceNonce: nonce,
  protocolVersion: 'idacc.health.v1',
}, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(attested.healthy, true);
assert.equal(attested.identity, 'attested');
assert.equal(attested.identityVerified, true);

const compatibleManager = validateServiceHealth('manager', { status: 'ok', agents: 2 }, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(compatibleManager.identity, 'legacy-compatible');
assert.equal(compatibleManager.healthy, true);

const compatibleBrain = validateServiceHealth('brain', { ok: true, nodes: 0, edges: 0 }, {
  expectedVersion: '4.5.6',
  expectedServiceId: 'idacc-brain',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(compatibleBrain.identity, 'legacy-compatible');
assert.equal(compatibleBrain.healthy, true);

for (const [name, payload, expectedVersion, expectedServiceId] of [
  ['manager', { status: 'ok', agents: 2 }, '1.2.3', 'idacc-manager'],
  ['brain', { ok: true, nodes: 0, edges: 0 }, '4.5.6', 'idacc-brain'],
]) {
  const strict = validateServiceHealth(name, payload, {
    expectedVersion,
    expectedServiceId,
    instanceNonce: nonce,
    ownedProcess: true,
    requireAttestation: true,
  });
  assert.equal(strict.healthy, false);
  assert.equal(strict.identity, 'rejected');
  assert.match(strict.error || '', /missing its exact service, version, or instance nonce attestation/);
}

const foreignLegacy = validateServiceHealth('manager', { status: 'ok' }, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: false,
});
assert.equal(foreignLegacy.healthy, false);
assert.equal(foreignLegacy.identity, 'rejected');

for (const payload of [
  { status: 'ok', service: 'brain', runtimeVersion: '1.2.3', instanceNonce: nonce },
  { status: 'ok', service: 'manager', runtimeVersion: '9.9.9', instanceNonce: nonce },
  { status: 'ok', service: 'manager', runtimeVersion: '1.2.3', instanceNonce: 'wrong' },
]) {
  const result = validateServiceHealth('manager', payload, {
    expectedVersion: '1.2.3',
    expectedServiceId: 'idacc-manager',
    instanceNonce: nonce,
    ownedProcess: true,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.identity, 'rejected');
}

assert.equal(restartDelayMs(1, 0.5), 1_000);
assert.equal(restartDelayMs(2, 0.5), 2_000);
assert.equal(restartDelayMs(20, 0.5), 30_000);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4], 4, { limit: 5, windowMs: 10 }), false);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4, 5], 5, { limit: 5, windowMs: 10 }), true);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4, 100], 100, { limit: 5, windowMs: 10 }), false);

assert.deepEqual(
  canonicalLoopbackServiceUrl('http://localhost:49152'),
  { url: 'http://127.0.0.1:49152', port: 49152 },
);
assert.throws(() => canonicalLoopbackServiceUrl('https://127.0.0.1:49152'), /loopback HTTP origin/);
assert.throws(() => canonicalLoopbackServiceUrl('http://example.com:49152'), /loopback HTTP origin/);
assert.throws(() => canonicalLoopbackServiceUrl('http://127.0.0.1:49152/path'), /loopback HTTP origin/);

const dashboardOrigin = canonicalBrainDashboardOrigin('http://127.0.0.1:49152');
assert.equal(
  brainDashboardNavigationAllowed(
    'http://127.0.0.1:49152/dashboard/graph',
    dashboardOrigin,
  ),
  true,
);
for (const target of [
  'http://127.0.0.1:49153/dashboard/graph',
  'https://127.0.0.1:49152/dashboard/graph',
  'https://example.com/collect?profile=data',
  'javascript:alert(1)',
  'not a URL',
]) {
  assert.equal(
    brainDashboardNavigationAllowed(target, dashboardOrigin),
    false,
    target,
  );
}
const dashboardAuthorized = authorizeBrainDashboardRequest(
  'http://127.0.0.1:49152/dashboard/graph',
  dashboardOrigin,
  `Bearer ${'a'.repeat(43)}`,
  { authorization: 'Bearer stale', Accept: 'text/html' },
);
assert.equal(dashboardAuthorized.allowed, true);
assert.equal(dashboardAuthorized.requestHeaders.Authorization, `Bearer ${'a'.repeat(43)}`);
assert.equal(dashboardAuthorized.requestHeaders.authorization, undefined);
assert.equal(dashboardAuthorized.requestHeaders.Accept, 'text/html');
for (const target of [
  'http://127.0.0.1:49153/dashboard/graph',
  'https://127.0.0.1:49152/dashboard/graph',
  'https://example.com/collect',
  'not a URL',
]) {
  const rejected = authorizeBrainDashboardRequest(
    target,
    dashboardOrigin,
    `Bearer ${'a'.repeat(43)}`,
    { Authorization: 'Bearer stale' },
  );
  assert.equal(rejected.allowed, false, target);
  assert.equal(
    Object.keys(rejected.requestHeaders).some((name) => name.toLowerCase() === 'authorization'),
    false,
  );
}
assert.throws(
  () => canonicalBrainDashboardOrigin('http://localhost:49152'),
  /127\.0\.0\.1 HTTP origin/,
);
assert.throws(
  () => canonicalBrainDashboardOrigin('http://secret@127.0.0.1:49152'),
  /127\.0\.0\.1 HTTP origin/,
);
{
  const destroyed = [];
  const registry = new BrainDashboardChildWindowRegistry();
  const released = {
    isDestroyed: () => false,
    destroy: () => destroyed.push('released'),
  };
  const surviving = {
    isDestroyed: () => false,
    destroy: () => destroyed.push('surviving'),
  };
  const release = registry.track(released);
  registry.track(surviving);
  release();
  assert.equal(registry.size(), 1);
  registry.destroyAll();
  assert.deepEqual(destroyed, ['surviving']);
  assert.equal(registry.size(), 0);

  assert.deepEqual(
    denyBrainDashboardRequest({
      Authorization: 'Bearer stale',
      Accept: 'application/json',
    }),
    {
      allowed: false,
      requestHeaders: { Accept: 'application/json' },
    },
  );
  assert.match(desktopMainSource, /webContents\.on\('did-create-window'/);
  assert.match(
    dashboardWindowPolicySource,
    /brainDashboardNavigationAllowed/,
    'dashboard windows must allow navigation only inside the exact authorized origin',
  );
  assert.doesNotMatch(
    dashboardWindowPolicySource,
    /openExternalHttpUrl|shell\.openExternal/,
    'privileged dashboard navigation must never hand a script-controlled URL to the system browser',
  );
  assert.match(
    desktopMainSource,
    /brainDashboardChildWindows\.destroyAll\(\);[\s\S]{0,300}retireBrainDashboardSession\(/,
    'dashboard close/rotation must destroy every child before session retirement',
  );
  assert.match(
    desktopMainSource,
    /onBeforeRequest\([\s\S]{0,120}callback\(\{ cancel: true \}\)/,
    'retired dashboard sessions must retain a deny-all request guard',
  );
  assert.doesNotMatch(
    desktopMainSource,
    /webRequest\.onBefore(?:Request|SendHeaders)\(null\)/,
    'session retirement must not remove network guards while child WebContents can survive',
  );
}

const folder = mkdtempSync(join(tmpdir(), 'idacc-supervisor-log-'));
try {
  const log = join(folder, 'manager.log');
  writeFileSync(log, 'a'.repeat(12), { mode: 0o600 });
  writeFileSync(`${log}.1`, 'previous', { mode: 0o600 });
  const policy = { maxBytes: 10, keepFiles: 2, maxAgeMs: 1_000 };
  assert.equal(rotateServiceLog(log, policy, 10_000).rotated, true);
  assert.equal(readFileSync(log, 'utf8'), '');
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'a'.repeat(12));
  assert.equal(readFileSync(`${log}.2`, 'utf8'), 'previous');
  if (process.platform !== 'win32') {
    // Windows privacy is enforced by the profile root ACL; POSIX mode bits
    // are not a meaningful ownership boundary there.
    assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
  }

  writeFileSync(log, 'b'.repeat(12), { mode: 0o600 });
  assert.equal(rotateServiceLog(log, policy, 10_100).rotated, true);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'b'.repeat(12));
  assert.equal(readFileSync(`${log}.2`, 'utf8'), 'a'.repeat(12));

  utimesSync(`${log}.2`, new Date(0), new Date(0));
  rotateServiceLog(log, policy, 20_000);
  assert.throws(() => statSync(`${log}.2`), /ENOENT/);
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const settingsFolder = mkdtempSync(join(tmpdir(), 'idacc-brain-automation-settings-'));
try {
  const settingsFile = join(settingsFolder, 'config', 'config.json');
  const saved = setBrainAutomationSettings({
    cycleEnabled: false,
    cycleCadenceHours: 72,
  }, settingsFile);
  assert.deepEqual(saved.brainAutomation, {
    cycleEnabled: false,
    cycleCadenceHours: 72,
  });
  assert.deepEqual(loadSettings(settingsFile).brainAutomation, saved.brainAutomation);
  if (process.platform !== 'win32') {
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
  }
} finally {
  rmSync(settingsFolder, { recursive: true, force: true });
}

console.log('unified stack supervisor smoke: ok');
