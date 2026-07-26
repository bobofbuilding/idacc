import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'idacc-command-surface-'));

async function bundle(relativePath, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  return import(`file://${outfile}?v=${Date.now()}-${name}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

const COMPLETE_FEATURES = [
  'observability',
  'manager-controls',
  'runtime-preflight',
  'agent-config',
  'team-config',
  'library',
  'brain-context',
  'brain-control',
  'control-events',
  'control-state',
  'stalled-sweep',
];

try {
  const commandsModule = await bundle('../src/renderer/dashboard/commands.ts', 'commands');
  const runtime = await bundle('../src/renderer/dashboard/commandRuntime.ts', 'runtime');
  const drawerModule = await bundle('../src/renderer/dashboard/drawerCommands.ts', 'drawer-commands');
  const {
    buildCommands,
    commandMetadata,
    filterCommands,
    slashCommandFromQuery,
  } = commandsModule;
  const {
    CommandReceiptStore,
    MAX_COMMAND_RECEIPTS,
    evaluateCommandGate,
    executeGatedCommand,
    recordDeclinedCommand,
    runTrackedOperation,
    validateCommandMetadata,
  } = runtime;

  const commandStore = {
    allAgents: [{ id: 'lead', name: 'lead', team: 'default' }],
    refresh() {},
  };
  const commands = buildCommands(commandStore);
  for (const command of commands) {
    assert.deepEqual(
      validateCommandMetadata(commandMetadata(command)),
      [],
      `${command.id} must have valid command metadata`,
    );
  }
  assert.equal(new Set(commands.map((command) => command.id)).size, commands.length, 'command IDs must be unique');
  for (const [query, id] of [
    ['register project', 'panel.project-driver'],
    ['promote', 'panel.org'],
    ['dispatch', 'panel.work-dispatch'],
  ]) {
    assert.equal(filterCommands(commands, query)[0]?.id, id, `dashboard command search failed for ${query}`);
  }
  assert.deepEqual(
    validateCommandMetadata(commandMetadata(slashCommandFromQuery('/ask lead inspect receipts', commandStore))),
    [],
    'dynamic slash commands must carry complete metadata',
  );

  for (const metadata of Object.values(drawerModule.DRAWER_COMMANDS)) {
    assert.deepEqual(validateCommandMetadata(metadata), [], `${metadata.commandId} metadata must be valid`);
  }
  let releaseDrawerProbe;
  let drawerProbeCalls = 0;
  const drawerProbeResult = new Promise((resolve) => { releaseDrawerProbe = resolve; });
  const drawerProbeOne = drawerModule.runDrawerCommand({
    metadata: drawerModule.DRAWER_COMMANDS.quickProbe,
    environment: { online: true, features: COMPLETE_FEATURES },
    label: 'Probe all agents',
    resourceRefs: ['fleet'],
    operation: () => {
      drawerProbeCalls += 1;
      return drawerProbeResult;
    },
  });
  const drawerProbeTwo = drawerModule.runDrawerCommand({
    metadata: drawerModule.DRAWER_COMMANDS.quickProbe,
    environment: { online: true, features: COMPLETE_FEATURES },
    label: 'Probe all agents',
    resourceRefs: ['fleet'],
    operation: () => {
      drawerProbeCalls += 1;
      return 'duplicate';
    },
  });
  await Promise.resolve();
  assert.equal(drawerProbeCalls, 1, 'matching drawer resource mutations must share one in-flight execution');
  releaseDrawerProbe('probed');
  const [drawerProbeReceiptOne, drawerProbeReceiptTwo] = await Promise.all([drawerProbeOne, drawerProbeTwo]);
  assert.equal(drawerProbeReceiptOne.receipt.idempotencyKey, drawerProbeReceiptTwo.receipt.idempotencyKey);
  assert.equal(drawerProbeReceiptOne.receipt.state, 'succeeded');
  assert.ok(
    validateCommandMetadata({
      commandId: 'bad',
      ownerView: 'somewhere',
      requiredFeatures: ['imaginary-feature'],
      risk: 'high',
      confirmation: 'none',
      receiptKind: 'mutation',
    }).length >= 3,
    'unknown owner/features and missing high-risk confirmation must be rejected',
  );

  const intentModule = await bundle('../src/renderer/dashboard/chatIntents.ts', 'chat-intents');
  const {
    isChatControlIntentCandidate,
    parseChatControlIntent,
  } = intentModule;
  const intentStore = { allAgents: [{ name: 'research-lead', team: 'research' }] };
  const intentCases = [
    ['/dispatch "Audit evidence" to research', 'chat.work.dispatch'],
    ['/project new "Alpha" for engineering-team', 'chat.projects.create'],
    ['/promote-lead research-lead for research', 'chat.org.assign-lead'],
    ['/triage research', 'chat.work.triage'],
  ];
  for (const [input, commandId] of intentCases) {
    const intent = parseChatControlIntent(input, intentStore);
    assert.equal(intent?.commandId, commandId);
    assert.deepEqual(validateCommandMetadata(intent), [], `${commandId} metadata must be valid`);
    assert.ok(intent.resourceRefs.length > 0, `${commandId} must identify affected resources`);
  }
  assert.match(parseChatControlIntent('/dispatch Audit evidence to research', intentStore)?.summary ?? '', /research\/research-lead.*Audit evidence/);
  assert.match(parseChatControlIntent('/project new Alpha for engineering-team', intentStore)?.summary ?? '', /Alpha.*engineering-team/);
  assert.equal(parseChatControlIntent('/ask lead keep chatting normally', intentStore), null);
  assert.equal(isChatControlIntentCandidate('/dispatch badly formed'), true);
  assert.equal(isChatControlIntentCandidate('/project-new malformed'), true);
  assert.equal(isChatControlIntentCandidate('/ask lead keep chatting normally'), false);
  const chatSource = await readFile(new URL('../src/renderer/views/Chat.tsx', import.meta.url), 'utf8');
  const attachmentGuardAt = chatSource.indexOf('reservedControlIntent && attachments.length > 0');
  const dispatchAt = chatSource.indexOf('if (onControlIntent(text))');
  assert.ok(attachmentGuardAt >= 0 && dispatchAt > attachmentGuardAt, 'attachments must be rejected before a control proposal is dispatched');
  assert.match(chatSource, /Control command syntax was not recognized; no command was sent/, 'malformed reserved controls must not fall through to agent chat');

  const mutation = {
    commandId: 'drawer.project.save',
    ownerView: 'projects',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  };
  const compatible = { online: true, features: COMPLETE_FEATURES };
  assert.equal(evaluateCommandGate(mutation, compatible).state, 'confirmation-required');
  assert.equal(evaluateCommandGate(mutation, compatible, true).state, 'allowed');
  assert.equal(
    evaluateCommandGate(mutation, { online: true, features: ['observability'] }, true).state,
    'blocked',
  );
  assert.equal(evaluateCommandGate(mutation, { online: false, features: COMPLETE_FEATURES }, true).state, 'blocked');

  let now = 1_000;
  const durableStorage = memoryStorage();
  const durableStore = new CommandReceiptStore(durableStorage, () => ++now);
  const declined = recordDeclinedCommand({
    metadata: mutation,
    idempotencyKey: 'declined-key',
    resourceRefs: ['project:alpha'],
    store: durableStore,
  });
  assert.equal(declined.state, 'declined');
  assert.deepEqual(declined.resourceRefs, ['project:alpha']);
  const restoredStore = new CommandReceiptStore(durableStorage, () => ++now);
  assert.equal(restoredStore.find('declined-key')?.state, 'declined', 'receipts must survive view/app store recreation');

  let blockedOperationCalls = 0;
  const blocked = await executeGatedCommand({
    metadata: mutation,
    environment: { online: true, features: ['observability'] },
    confirmed: true,
    idempotencyKey: 'blocked-key',
    store: durableStore,
    operation: () => { blockedOperationCalls += 1; },
  });
  assert.equal(blocked.executed, false);
  assert.equal(blocked.receipt.state, 'blocked');
  assert.equal(blockedOperationCalls, 0, 'compatibility gating must prevent execution');

  const trackedMetadata = {
    commandId: 'fleet.refresh',
    ownerView: 'dashboard',
    requiredFeatures: [],
    risk: 'none',
    confirmation: 'none',
    receiptKind: 'refresh',
  };
  let releaseFirst;
  let releaseSecond;
  const firstValue = new Promise((resolve) => { releaseFirst = resolve; });
  const secondValue = new Promise((resolve) => { releaseSecond = resolve; });
  const concurrentStore = new CommandReceiptStore(undefined, () => ++now);
  const firstRun = runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'concurrent-first',
    store: concurrentStore,
    operation: () => firstValue,
  });
  const secondRun = runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'concurrent-second',
    store: concurrentStore,
    operation: () => secondValue,
  });
  releaseSecond('second');
  assert.equal((await secondRun).value, 'second');
  assert.equal(concurrentStore.find('concurrent-first')?.state, 'running');
  releaseFirst('first');
  assert.equal((await firstRun).value, 'first');
  assert.equal(concurrentStore.find('concurrent-first')?.state, 'succeeded');
  assert.equal(concurrentStore.find('concurrent-second')?.state, 'succeeded');

  let duplicateCalls = 0;
  let releaseDuplicate;
  const duplicateValue = new Promise((resolve) => { releaseDuplicate = resolve; });
  const original = runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'same-key',
    store: concurrentStore,
    operation: () => {
      duplicateCalls += 1;
      return duplicateValue;
    },
  });
  await Promise.resolve();
  const duplicate = await runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'same-key',
    store: concurrentStore,
    operation: () => {
      duplicateCalls += 1;
      return 'duplicate';
    },
  });
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.receipt.state, 'running');
  assert.equal(duplicateCalls, 1, 'the same idempotency key must execute only once');
  releaseDuplicate('original');
  await original;

  const deferred = await runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'deferred-key',
    store: concurrentStore,
    resourceRefs: ['plan:42'],
    operation: () => ({ deferred: 2 }),
    classifyOutcome: () => ({
      state: 'deferred',
      resourceRefs: ['task:T-42'],
      recovery: 'Open Work to release the dependency.',
    }),
  });
  assert.equal(deferred.receipt.state, 'deferred');
  assert.deepEqual(deferred.receipt.resourceRefs, ['plan:42', 'task:T-42']);
  assert.match(deferred.receipt.recovery ?? '', /Open Work/);

  let releaseLate;
  const lateValue = new Promise((resolve) => { releaseLate = resolve; });
  const timeoutStore = new CommandReceiptStore(undefined, () => ++now);
  const timedOut = await runTrackedOperation({
    metadata: trackedMetadata,
    idempotencyKey: 'timeout-key',
    store: timeoutStore,
    timeoutMs: 5,
    operation: () => lateValue,
  });
  assert.equal(timedOut.receipt.state, 'timed-out');
  assert.match(timedOut.receipt.recovery ?? '', /do not issue a new command/i);
  timeoutStore.clearTerminal();
  timeoutStore.remove('timeout-key');
  assert.equal(timeoutStore.find('timeout-key')?.state, 'timed-out', 'unknown outcomes must remain available for reconciliation');
  releaseLate('eventual-success');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timeoutStore.find('timeout-key')?.state, 'succeeded', 'late completion must reconcile the original receipt');
  assert.equal(timeoutStore.snapshot().length, 1, 'late reconciliation must not create a second receipt');

  const boundedStorage = memoryStorage();
  const boundedStore = new CommandReceiptStore(boundedStorage, () => ++now);
  for (let index = 0; index < MAX_COMMAND_RECEIPTS + 12; index += 1) {
    const key = `bounded-${index}`;
    boundedStore.start('fleet.refresh', key);
    boundedStore.finish(key, 'succeeded');
  }
  assert.equal(boundedStore.snapshot().length, MAX_COMMAND_RECEIPTS, 'receipt history must be bounded');

  const interruptedStorage = memoryStorage();
  const interrupted = new CommandReceiptStore(interruptedStorage, () => ++now);
  interrupted.start('drawer.project.save', 'interrupted-key', ['project:alpha']);
  const recovered = new CommandReceiptStore(interruptedStorage, () => ++now).find('interrupted-key');
  assert.equal(recovered?.state, 'failed');
  assert.match(recovered?.recovery ?? '', /review/i);

  const progressModule = await bundle('../src/renderer/dashboard/projectProgress.ts', 'project-progress');
  const { summarizeProjectProgress } = progressModule;
  assert.deepEqual(
    summarizeProjectProgress([
      { title: 'active', status: 'doing', workflowState: 'executing', planId: 'plan-a', createdAt: 1 },
      { title: 'waiting', status: 'todo', workflowState: 'queued', planId: 'plan-a', createdAt: 2 },
      { title: 'blocked', status: 'doing', workflowState: 'stalled', planId: 'plan-b', createdAt: 3 },
      { title: 'failed', status: 'failed', workflowState: 'failed', planId: 'plan-b', createdAt: 4 },
      { title: 'done', status: 'done', workflowState: 'validated', planId: 'plan-b', createdAt: 5 },
    ]),
    { working: 1, deferred: 1, blocked: 1, failed: 1, complete: 1, plans: 2, total: 5 },
  );

  const drawerSource = await readFile(new URL('../src/renderer/views/dashboard/ControlDrawer.tsx', import.meta.url), 'utf8');
  assert.match(drawerSource, /aria-modal="true"/, 'control drawer must expose modal semantics');
  assert.match(drawerSource, /event\.key === 'Escape'/, 'control drawer must handle Escape');
  assert.match(drawerSource, /requestClose\(\)/, 'Escape, close button, and backdrop must use the guarded close path');
  assert.match(drawerSource, /guard\.busy \|\| guard\.dirty/, 'guarded close must consider dirty and in-flight work');
  assert.match(drawerSource, /Discard changes/, 'dirty close must require explicit discard');
  assert.match(drawerSource, /Keep working/, 'dirty close must let the user continue editing');
  assert.match(drawerSource, /disabled=\{guard\.busy\}/, 'in-flight work must not be discardable');
  assert.match(drawerSource, /returnFocusRef\.current\?\.focus\(\)/, 'control drawer must restore trigger focus');
  assert.match(drawerSource, /event\.key !== 'Tab'/, 'control drawer must contain keyboard focus');
  assert.match(drawerSource, /onGuardChange=\{reportGuard\}/, 'every mutation panel must report interruption state');

  for (const panel of [
    'ProjectDriverPanel.tsx',
    'OrgPanel.tsx',
    'PlansPanel.tsx',
    'BoardPanel.tsx',
    'ControlCenterPanel.tsx',
  ]) {
    const source = await readFile(new URL(`../src/renderer/views/dashboard/panels/${panel}`, import.meta.url), 'utf8');
    assert.match(source, /useDrawerGuard/, `${panel} must report dirty/in-flight state`);
    assert.match(source, /runDrawerCommand/, `${panel} mutations must use the metadata gate and receipt runtime`);
  }
  const receiptSource = await readFile(new URL('../src/renderer/views/dashboard/CommandReceipts.tsx', import.meta.url), 'utf8');
  assert.match(receiptSource, /useSyncExternalStore/, 'global receipts must react to the shared durable store');
  assert.match(receiptSource, /chat\.projects/, 'chat receipt recovery must resolve to its owner page');
  const styles = await readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.command-receipts\s*\{/, 'global receipts must have production presentation styles');
  assert.match(styles, /\.drawer-close-guard\s*\{/, 'drawer interruption prompt must have production presentation styles');

  console.log('[dashboard-command-surface-smoke] OK');
} finally {
  await rm(dir, { recursive: true, force: true });
}
