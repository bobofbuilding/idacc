import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupOwnedPrimaryInstance,
  createAppShutdownCoordinator,
  createBoundedWorkDrain,
  shutdownReentryDisposition,
  workSettledWithin,
  type AppShutdownEvent,
  type AppShutdownHost,
} from '../src/main/appShutdown.ts';
import {
  createDelayedBackgroundWork,
  createSingleFlightBackgroundGate,
  createTrackedBackgroundWork,
} from '../src/main/backgroundActivity.ts';
import {
  focusExistingPrimaryWindow,
  guardActivationWindowCreation,
} from '../src/main/singleInstance.ts';
import {
  createDraftDispatchLifecycle,
  resetDraftDispatcherWork,
  runDraftDependencyDispatch,
  stopDraftDispatcherWork,
} from '../src/main/draftDispatcher.ts';
import {
  configureControlWriteScheduler,
  recordControlAction,
} from '../src/main/controlLog.ts';

class FakeApp implements AppShutdownHost {
  readonly calls: string[] = [];
  private readonly beforeQuitListeners: Array<(event: AppShutdownEvent) => void> = [];
  private willQuitListeners: Array<() => void> = [];

  prependListener(
    event: 'before-quit',
    listener: (event: AppShutdownEvent) => void,
  ): this {
    assert.equal(event, 'before-quit');
    this.beforeQuitListeners.unshift(listener);
    return this;
  }

  once(event: 'will-quit', listener: () => void): this {
    assert.equal(event, 'will-quit');
    this.willQuitListeners.push(listener);
    return this;
  }

  emitBeforeQuit(): boolean {
    let prevented = false;
    const event: AppShutdownEvent = {
      preventDefault: () => { prevented = true; },
    };
    for (const listener of [...this.beforeQuitListeners]) listener(event);
    return prevented;
  }

  emitWillQuit(): void {
    const listeners = this.willQuitListeners;
    this.willQuitListeners = [];
    for (const listener of listeners) listener();
  }

  quit(): void {
    this.calls.push('quit');
    if (!this.emitBeforeQuit()) this.emitWillQuit();
  }

  exit(code: number): void {
    this.calls.push(`exit:${code}`);
  }

  relaunch(): void {
    this.calls.push('relaunch');
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

{
  const calls: string[] = [];
  assert.equal(focusExistingPrimaryWindow({
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    restore: () => { calls.push('restore'); },
    show: () => { calls.push('show'); },
    focus: () => { calls.push('focus'); },
  }), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  assert.equal(focusExistingPrimaryWindow(null), false);
}

{
  let primaryCleanupCalls = 0;
  await cleanupOwnedPrimaryInstance(false, () => {
    primaryCleanupCalls += 1;
  });
  assert.equal(
    primaryCleanupCalls,
    0,
    'a losing secondary instance must never call primary service cleanup',
  );
  await cleanupOwnedPrimaryInstance(true, () => {
    primaryCleanupCalls += 1;
  });
  assert.equal(primaryCleanupCalls, 1);
}

{
  assert.equal(shutdownReentryDisposition('running'), 'normal');
  assert.equal(
    shutdownReentryDisposition('cleanup-failed'),
    'recover-cleanup',
    'a headless cleanup failure must remain recoverable on app re-entry',
  );
  assert.equal(shutdownReentryDisposition('quiescing'), 'ignore');
  assert.equal(shutdownReentryDisposition('finalizing'), 'ignore');
}

{
  const fake = new FakeApp();
  let cleanupCount = 0;
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: async () => {
      cleanupCount += 1;
      await cleanupGate;
    },
    installPreparedUpdate: () => assert.fail('normal quit must not install an update'),
  });

  assert.equal(fake.emitBeforeQuit(), true, 'native quit must be held behind cleanup');
  assert.equal(coordinator.isQuiescing(), true);
  assert.deepEqual(fake.calls, [], 'Electron must not be asked to quit before cleanup completes');

  const first = coordinator.request({ kind: 'exit', code: 42 });
  const second = coordinator.request({ kind: 'relaunch' });
  assert.equal(first, second, 'all terminal requests must share one shutdown flight');
  assert.deepEqual(coordinator.intent(), { kind: 'quit' }, 'the first terminal intent must win');
  releaseCleanup();
  await first;
  assert.equal(cleanupCount, 1);
  assert.deepEqual(fake.calls, ['quit']);
}

{
  const events: string[] = [];
  const fake = new FakeApp();
  const ipcWork = createBoundedWorkDrain(50);
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: async () => {
      events.push('drain:start');
      assert.equal(ipcWork.activeCount(), 1);
      assert.equal(await ipcWork.drain(), true);
      events.push('drain:end');
    },
    installPreparedUpdate: () => {
      events.push('install');
      fake.emitWillQuit();
    },
  });
  const finishIpcCall = ipcWork.begin();
  let shutdown: Promise<void> | null = null;
  try {
    events.push('handler:request');
    shutdown = coordinator.request({ kind: 'install-update' });
    await Promise.resolve();
    events.push('handler:return');
  } finally {
    finishIpcCall();
    events.push('handler:finish');
  }
  assert.ok(shutdown);
  await shutdown;
  assert.deepEqual(
    events,
    ['handler:request', 'drain:start', 'handler:return', 'handler:finish', 'drain:end', 'install'],
    'the update IPC that initiates shutdown must release itself before cleanup continues',
  );
}

{
  const ipcWork = createBoundedWorkDrain(5);
  const finishIpcCall = ipcWork.begin();
  assert.equal(await ipcWork.drain(), false, 'stuck IPC work must not block shutdown indefinitely');
  finishIpcCall();
  assert.equal(ipcWork.activeCount(), 0);
}

{
  const events: string[] = [];
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => { events.push('cleanup'); },
    installPreparedUpdate: () => assert.fail('relaunch must not install an update'),
  });
  await coordinator.request({ kind: 'relaunch' });
  events.push(...fake.calls);
  assert.deepEqual(events, ['cleanup', 'relaunch', 'quit']);
}

{
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => {},
    installPreparedUpdate: () => assert.fail('exit must not install an update'),
  });
  await coordinator.request({ kind: 'exit', code: 73 });
  assert.deepEqual(fake.calls, ['exit:73'], 'explicit exit status must be preserved');
}

{
  const events: string[] = [];
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => { events.push('cleanup'); },
    installPreparedUpdate: () => {
      events.push('install');
      fake.emitWillQuit();
    },
    updateQuitFallbackMs: 5,
  });
  await coordinator.request({ kind: 'install-update' });
  await delay(15);
  events.push(...fake.calls);
  assert.deepEqual(events, ['cleanup', 'install'], 'the updater must run after cleanup without a spurious fallback quit');
}

{
  const errors: unknown[] = [];
  const events: string[] = [];
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => { events.push('cleanup'); },
    installPreparedUpdate: () => {
      events.push('install');
      throw new Error('updater refused to quit');
    },
    onError: (error) => { errors.push(error); },
    updateQuitFallbackMs: 50,
  });
  await coordinator.request({ kind: 'install-update' });
  events.push(...fake.calls);
  assert.deepEqual(events, ['cleanup', 'install', 'quit']);
  assert.equal(errors.length, 1, 'a synchronous updater failure must be reported');
}

{
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => {},
    installPreparedUpdate: () => {},
    updateQuitFallbackMs: 5,
  });
  await coordinator.request({ kind: 'install-update' });
  await delay(15);
  assert.deepEqual(fake.calls, ['quit'], 'a silent updater failure must fall back to a normal quit');
}

{
  const events: string[] = [];
  let releasePass!: () => void;
  const passGate = new Promise<void>((resolve) => { releasePass = resolve; });
  const background = createSingleFlightBackgroundGate();
  const admitted = background.run(async () => {
    events.push('background:start');
    await passGate;
    events.push('background:mutation');
  });
  await Promise.resolve();
  const stop = background.stop();
  assert.equal(background.isStopped(), true, 'stop must close admission synchronously');
  await background.run(() => { events.push('background:late'); });
  let stopSettled = false;
  void stop.then(() => { stopSettled = true; });
  await Promise.resolve();
  assert.equal(stopSettled, false, 'stop must wait for the admitted pass');
  releasePass();
  await Promise.all([admitted, stop]);
  assert.deepEqual(events, ['background:start', 'background:mutation']);
}

{
  const delayed = createDelayedBackgroundWork();
  let calls = 0;
  assert.equal(delayed.schedule(20, () => { calls += 1; }), true);
  await delayed.stop();
  await delay(30);
  assert.equal(calls, 0, 'quiescence must synchronously cancel a delayed goal-style kick');
  assert.equal(delayed.schedule(0, () => { calls += 1; }), false);
}

{
  const delayed = createDelayedBackgroundWork();
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const events: string[] = [];
  delayed.schedule(0, async () => {
    events.push('kick:start');
    await runGate;
    events.push('kick:finish');
  });
  await delay(5);
  assert.equal(delayed.activeCount(), 1);
  const stopped = delayed.stop();
  let stopSettled = false;
  void stopped.then(() => { stopSettled = true; });
  await Promise.resolve();
  assert.equal(stopSettled, false, 'a fired delayed kick must be drained');
  releaseRun();
  await stopped;
  assert.equal(delayed.activeCount(), 0);
  assert.deepEqual(events, ['kick:start', 'kick:finish']);
}

{
  const writes = createTrackedBackgroundWork();
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const events: string[] = [];
  const admitted = writes.run(async () => {
    events.push('control-write:start');
    await writeGate;
    events.push('control-write:finish');
  });
  await Promise.resolve();
  const stopped = writes.stop();
  let stoppedSettled = false;
  void stopped.then(() => { stoppedSettled = true; });
  await Promise.resolve();
  assert.equal(stoppedSettled, false, 'shutdown must await an admitted control-log write');
  await writes.run(() => {
    events.push('control-write:late');
  });
  releaseWrite();
  await Promise.all([admitted, stopped]);
  assert.deepEqual(
    events,
    ['control-write:start', 'control-write:finish'],
    'shutdown must suppress later best-effort Manager/Brain writes',
  );
}

{
  let scheduled = 0;
  configureControlWriteScheduler(() => {
    scheduled += 1;
  });
  recordControlAction('goals:remove', ['shutdown-smoke-goal'], { ok: true });
  assert.equal(
    scheduled,
    2,
    'tracking and extra Brain writes must both be handed to the lifecycle scheduler as factories',
  );
  configureControlWriteScheduler(() => {
    throw new Error('scheduler stopped');
  });
  assert.doesNotThrow(
    () => recordControlAction('plans:remove', ['shutdown-smoke-plan'], { ok: true }),
    'a stopped/rejecting scheduler must preserve best-effort control semantics',
  );
  configureControlWriteScheduler(null);
}

{
  let releaseCreation!: () => void;
  const creation = new Promise<void>((resolve) => { releaseCreation = resolve; });
  let quiescing = false;
  let destroyed = false;
  let cleared = false;
  const target = {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
  };
  const guarded = guardActivationWindowCreation(
    creation,
    target,
    () => quiescing,
    () => { cleared = true; },
  );
  quiescing = true;
  releaseCreation();
  assert.equal(await guarded, null);
  assert.equal(destroyed, true, 'a macOS activation window completed during shutdown must be destroyed');
  assert.equal(cleared, true, 'the destroyed late window must be cleared from primary state');
}

{
  const lifecycle = createDraftDispatchLifecycle();
  let releaseDependency!: () => void;
  const dependency = new Promise<void>((resolve) => { releaseDependency = resolve; });
  let asks = 0;
  const chain = lifecycle.track(runDraftDependencyDispatch(
    lifecycle,
    [dependency],
    async () => { asks += 1; },
    async () => {},
  ));
  await Promise.resolve();
  await lifecycle.stop();
  assert.equal(
    asks,
    0,
    'cancelling a draft dependency chain must prevent every later /ask dispatch',
  );
  releaseDependency();
  await chain;
}

{
  const lifecycle = createDraftDispatchLifecycle();
  let releaseAsk!: () => void;
  const askGate = new Promise<void>((resolve) => { releaseAsk = resolve; });
  let askStarted = false;
  const chain = lifecycle.track(runDraftDependencyDispatch(
    lifecycle,
    [],
    async () => {
      askStarted = true;
      await askGate;
    },
    async () => assert.fail('task polling must not start after cancellation'),
  ));
  while (!askStarted) await Promise.resolve();
  const stopped = lifecycle.stop();
  let stoppedSettled = false;
  void stopped.then(() => { stoppedSettled = true; });
  await Promise.resolve();
  assert.equal(stoppedSettled, false, 'an already-admitted /ask request must be drained');
  releaseAsk();
  await Promise.all([chain, stopped]);
}

{
  const firstStop = stopDraftDispatcherWork();
  await firstStop;
  resetDraftDispatcherWork();
  const secondStop = stopDraftDispatcherWork();
  assert.notEqual(
    firstStop,
    secondStop,
    'startup recovery must receive a fresh draft-dispatch lifecycle owner',
  );
  await secondStop;
  resetDraftDispatcherWork();
}

{
  const events: string[] = [];
  let releasePass!: () => void;
  const passGate = new Promise<void>((resolve) => { releasePass = resolve; });
  const background = createSingleFlightBackgroundGate();
  void background.run(async () => {
    events.push('pass:start');
    await passGate;
    events.push('pass:mutation');
  });
  await Promise.resolve();
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: async () => {
      events.push('quiesce');
      await background.stop();
      events.push('tree:stop');
    },
    installPreparedUpdate: () => assert.fail('normal quit must not install an update'),
  });
  const shutdown = coordinator.request({ kind: 'quit' });
  await Promise.resolve();
  assert.deepEqual(fake.calls, [], 'terminal action must wait for the admitted background pass');
  releasePass();
  await shutdown;
  events.push(...fake.calls);
  assert.deepEqual(
    events,
    ['pass:start', 'quiesce', 'pass:mutation', 'tree:stop', 'quit'],
    'process-tree stop and terminal action must follow the final admitted mutation',
  );
}

{
  let releaseNeverSettlingPass!: () => void;
  const neverSettlingPass = new Promise<void>((resolve) => {
    releaseNeverSettlingPass = resolve;
  });
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: async () => {
      if (!await workSettledWithin(neverSettlingPass, 5)) {
        throw new Error('background drain deadline elapsed');
      }
    },
    installPreparedUpdate: () => assert.fail('normal quit must not install an update'),
  });
  await coordinator.request({ kind: 'quit' });
  assert.equal(coordinator.status().phase, 'cleanup-failed');
  assert.deepEqual(fake.calls, [], 'a never-settling admitted pass must fail closed');
  releaseNeverSettlingPass();
  await coordinator.retry();
  assert.deepEqual(fake.calls, ['quit'], 'the same guarded cleanup must be retryable after work settles');
}

for (const test of [
  { intent: { kind: 'quit' } as const, expected: ['quit'] },
  { intent: { kind: 'exit', code: 9 } as const, expected: ['exit:9'] },
  { intent: { kind: 'relaunch' } as const, expected: ['relaunch', 'quit'] },
  { intent: { kind: 'install-update' } as const, expected: [] },
]) {
  const errors: unknown[] = [];
  let cleanupFails = true;
  let installCalls = 0;
  const fake = new FakeApp();
  const coordinator = createAppShutdownCoordinator({
    app: fake,
    cleanup: () => {
      if (cleanupFails) throw new Error('managed process-tree cleanup is unconfirmed');
    },
    installPreparedUpdate: () => {
      installCalls += 1;
      fake.emitWillQuit();
    },
    onError: (error) => { errors.push(error); },
  });
  await coordinator.request(test.intent);
  assert.deepEqual(
    fake.calls,
    [],
    `${test.intent.kind} must fail closed without a terminal action`,
  );
  assert.equal(installCalls, 0, 'cleanup failure must never hand control to the updater');
  assert.equal(errors.length, 1, 'cleanup failure must be reported');
  assert.deepEqual(coordinator.status(), {
    phase: 'cleanup-failed',
    intent: test.intent,
    cleanupAttempts: 1,
  });
  assert.equal(coordinator.isQuiescing(), true, 'cleanup failure must preserve quiescence');
  assert.equal(fake.emitBeforeQuit(), true, 'native quit must remain blocked after cleanup failure');
  await coordinator.request({ kind: 'quit' });
  assert.deepEqual(fake.calls, [], 'a new terminal request must not bypass failed cleanup');
  assert.equal(errors.length, 2, 'a repeated native request must retry guarded cleanup');
  assert.equal(coordinator.status().cleanupAttempts, 2);

  cleanupFails = false;
  await coordinator.request({ kind: 'exit', code: 99 });
  assert.deepEqual(fake.calls, test.expected, 'retry may finalize only the original intent after cleanup succeeds');
  assert.equal(installCalls, test.intent.kind === 'install-update' ? 1 : 0);
  assert.equal(coordinator.status().cleanupAttempts, 3);
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = readFileSync(join(desktopRoot, 'src/main/main.ts'), 'utf8');
const permissionsSource = readFileSync(
  join(desktopRoot, 'src/main/computeruse/permissions.ts'),
  'utf8',
);
const updaterSource = readFileSync(join(desktopRoot, 'src/main/updater.ts'), 'utf8');
const controlLogSource = readFileSync(join(desktopRoot, 'src/main/controlLog.ts'), 'utf8');
const draftDispatcherSource = readFileSync(
  join(desktopRoot, 'src/main/draftDispatcher.ts'),
  'utf8',
);
const directTerminalCall = /\bapp\.(?:quit|exit|relaunch)\s*\(/g;

assert.equal(
  [...mainSource.matchAll(directTerminalCall)].length,
  0,
  'main process terminal paths must all use the shutdown coordinator',
);
assert.equal(
  [...permissionsSource.matchAll(directTerminalCall)].length,
  0,
  'Computer Use permissions must not bypass coordinated relaunch',
);
assert.equal(
  [...updaterSource.matchAll(directTerminalCall)].length,
  0,
  'the updater must not directly terminate Electron',
);
assert.equal(
  [...updaterSource.matchAll(/\bautoUpdater\.quitAndInstall\s*\(/g)].length,
  1,
  'exactly one post-cleanup updater install handoff is allowed',
);
assert.match(mainSource, /const appShutdown = createAppShutdownCoordinator\(\{/);
const singleInstanceLockIndex = mainSource.indexOf(
  'ownsSingleInstanceLock = app.requestSingleInstanceLock();',
);
assert.ok(singleInstanceLockIndex >= 0, 'the consumer app must acquire a single-instance lock');
assert.ok(
  singleInstanceLockIndex < mainSource.indexOf('if (ownsSingleInstanceLock) configureChromiumStability();')
    && singleInstanceLockIndex < mainSource.indexOf('const profile = initializeAppProfile();'),
  'the instance lock must precede crash-state/profile migration and startup mutation',
);
assert.match(
  mainSource,
  /if \(!ownsSingleInstanceLock\) \{[\s\S]*appShutdown\.request\(\{ kind: 'quit' \}\);[\s\S]*\} else \{[\s\S]*app\.on\('second-instance', handleSecondInstanceRequest\)/,
  'a secondary process must quit through the coordinator while the primary owns focus handling',
);
assert.match(
  mainSource,
  /function cleanupForThisInstance\(\)[\s\S]*cleanupOwnedPrimaryInstance\([\s\S]*ownsSingleInstanceLock,[\s\S]*cleanupForTerminalShutdown/,
  'a losing secondary instance must select the strict no-op cleanup path',
);
assert.match(
  mainSource,
  /function handleSecondInstanceRequest\(\)[\s\S]*shutdownReentryDisposition\(appShutdown\.status\(\)\.phase\)[\s\S]*recover-cleanup[\s\S]*presentShutdownCleanupRecovery\(\)[\s\S]*ignore[\s\S]*focusPrimaryConsumerWindow\(\);/,
  'second-instance re-entry must restore cleanup recovery while other shutdown phases stay closed',
);
assert.match(
  mainSource,
  /process\.platform === 'darwin'[\s\S]*app\.on\('activate', handleConsumerAppActivation\)/,
  'macOS activation must use the guarded application activation handler',
);
assert.match(
  mainSource,
  /function handleConsumerAppActivation\(\)[\s\S]*recover-cleanup[\s\S]*presentShutdownCleanupRecovery\(\)[\s\S]*activationWindowWork\.run[\s\S]*guardActivationWindowCreation/,
  'macOS activation must re-present cleanup recovery and lifecycle-own window creation',
);
assert.match(
  mainSource,
  /function showShutdownCleanupFailure[\s\S]*Retry Shutdown[\s\S]*Keep App Open/,
  'cleanup failure must have a bounded, user-visible guarded retry surface',
);
assert.doesNotMatch(
  mainSource.slice(
    mainSource.indexOf('function showShutdownCleanupFailure'),
    mainSource.indexOf('function startUpdaterSafely'),
  ),
  /Force Quit|Force Restart|Install Anyway/,
  'cleanup failure UI must not offer a containment bypass',
);
assert.ok(
  mainSource.indexOf('const appShutdown = createAppShutdownCoordinator({')
    < mainSource.indexOf('app.whenReady()'),
  'the shutdown gate must be installed before Electron startup work begins',
);
assert.match(mainSource, /stopOrgSyncRunner = startOrgSync\(\)/);
assert.match(mainSource, /stopModelRefreshRunner = startModelRefreshLoop\(/);
assert.match(mainSource, /if \(appShutdown\.isQuiescing\(\)\)/);
assert.match(
  mainSource,
  /configureControlWriteScheduler\([\s\S]*controlLogBackgroundWork\.run\(work\)/,
  'control-log Manager/Brain writes must be admitted through shutdown-owned tracking',
);
assert.match(
  mainSource,
  /trackBackgroundStop\(activationWindowWork\.stop\(\)\);[\s\S]*trackBackgroundStop\(controlLogBackgroundWork\.stop\(\)\);/,
  'shutdown must drain activation window work and control-log writes',
);
assert.match(
  mainSource,
  /function prepareConsumerBackgroundActivitiesForStartup\(\)[\s\S]*activationWindowWork = createSingleFlightBackgroundGate\(\)[\s\S]*controlLogBackgroundWork = createTrackedBackgroundWork\(\)[\s\S]*resetDraftDispatcherWork\(\)/,
  'a guarded startup retry must recreate lifecycle owners stopped by failed-startup cleanup',
);
assert.match(
  mainSource,
  /delayedGoalDriverWork\.isStopped\(\)[\s\S]*delayedGoalDriverWork\.activeCount\(\) !== 0[\s\S]*still draining[\s\S]*delayedGoalDriverWork = createDelayedBackgroundWork\(\)/,
  'startup retry must fail closed while an old delayed goal-driver pass is still active',
);
assert.match(
  controlLogSource,
  /runBestEffortControlWrite\(\(\) => emitControlEvent![\s\S]*runBestEffortControlWrite\(\(\) => recordTrackingHooks[\s\S]*runBestEffortControlWrite\(\(\) => extra/,
  'all control-log Manager, tracking, and extra Brain writes must use the owned scheduler',
);
assert.doesNotMatch(
  controlLogSource.slice(controlLogSource.indexOf('const EXTRAS'), controlLogSource.indexOf('export function recordControlAction')),
  /\bvoid\s+brain\./,
  'control-log extra Brain writes must not escape the owned scheduler',
);
assert.match(
  draftDispatcherSource,
  /runDraftDependencyDispatch\([\s\S]*if \(lifecycle\.isStopped\(\)\) return;[\s\S]*\/ask/,
  'draft dependency chains must perform a synchronous cancellation check before /ask',
);
assert.match(
  draftDispatcherSource,
  /applicationDraftDispatchLifecycle\.stop\(\)/,
  'the draft dispatcher stop handle must cancel and drain detached dependency/poll work',
);
assert.match(mainSource, /quiesceConsumerOwnedServices\(\);[\s\S]*await activeIpcWork\.drain\(\);/);
assert.match(
  mainSource,
  /const activityDrainDeadline = Date\.now\(\) \+ CONSUMER_SHUTDOWN_DRAIN_TIMEOUT_MS;[\s\S]*drainConsumerStartup\(activityDrainDeadline\)[\s\S]*drainConsumerBackgroundActivities\(activityDrainDeadline\)/,
  'startup and background work must share one aggregate guarded deadline',
);
assert.match(mainSource, /const finishIpcCall = activeIpcWork\.begin\(\);[\s\S]*finishIpcCall\(\);/);
const ipcHandlerSource = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('idagents:call'"),
  mainSource.indexOf("ipcMain.handle('idagents:clipboardWrite'"),
);
assert.match(
  ipcHandlerSource,
  /if \(!appShutdown\.isQuiescing\(\)\) \{[\s\S]*recordControlAction\(method,[\s\S]*publishStoreChange\(method\);/,
  'post-call learning, audit, and store publication must stop at quiescence',
);
const consumerStartupSource = mainSource.slice(
  mainSource.indexOf('.then(() => runStartupRecoveryLoop'),
  mainSource.indexOf('}, handleConsumerStartupFailure))'),
);
assert.match(
  consumerStartupSource,
  /requireConsumerStartupActive\(\);[\s\S]*await startUnifiedStack\(profile\);[\s\S]*requireConsumerStartupActive\(\);/,
);
assert.match(
  consumerStartupSource,
  /await createWindow\(\);[\s\S]*requireConsumerStartupActive\(\);[\s\S]*await startBroker\([\s\S]*requireConsumerStartupActive\(\);/,
  'shutdown during startup must prevent every later window, broker, and loop phase',
);
assert.match(mainSource, /consumerStartupPromise = startup;/);
const terminalCleanupSource = mainSource.slice(
  mainSource.indexOf('async function cleanupForTerminalShutdown'),
  mainSource.indexOf('async function cleanupFailedConsumerStartup'),
);
assert.ok(
  terminalCleanupSource.indexOf('quiesceConsumerOwnedServices()')
    < terminalCleanupSource.indexOf('await activeIpcWork.drain()')
    && terminalCleanupSource.indexOf('await activeIpcWork.drain()')
    < terminalCleanupSource.indexOf('await drainConsumerStartup(activityDrainDeadline)')
    && terminalCleanupSource.indexOf('await drainConsumerStartup(activityDrainDeadline)')
      < terminalCleanupSource.lastIndexOf('quiesceConsumerOwnedServices()')
    && terminalCleanupSource.lastIndexOf('quiesceConsumerOwnedServices()')
      < terminalCleanupSource.indexOf('await drainConsumerBackgroundActivities(activityDrainDeadline)')
    && terminalCleanupSource.indexOf('await drainConsumerBackgroundActivities(activityDrainDeadline)')
      < terminalCleanupSource.indexOf('await stopUnifiedStack()'),
  'shutdown must close admission first and drain all accepted work before process-tree stop',
);
const startupFailureSource = mainSource.slice(
  mainSource.indexOf('async function handleConsumerStartupFailure'),
  mainSource.indexOf('async function handleUnrecoverableStartupFailure'),
);
assert.match(
  startupFailureSource,
  /if \(appShutdown\.isQuiescing\(\)\)[\s\S]*return 'quit';[\s\S]*await cleanupFailedConsumerStartup\(\);[\s\S]*if \(appShutdown\.isQuiescing\(\)\)/,
  'shutdown cancellation must bypass both pre-cleanup and post-cleanup recovery prompts',
);
assert.doesNotMatch(mainSource, /app\.on\(['"]will-quit['"]/);
assert.doesNotMatch(permissionsSource, /export function relaunchApp/);

process.stdout.write('application shutdown coordinator smoke: ok\n');
