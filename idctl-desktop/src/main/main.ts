/**
 * Electron main process: creates the window, wires the IPC bridge to the
 * id-agents manager, and loads the React renderer.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, Menu, MenuItem, globalShortcut, screen, safeStorage, clipboard, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import {
  call as bridgeCall,
  configureKeyProvider,
  configureManagedManager,
  configureSettingsSecretCodec,
  migrateSettingsSecrets,
  resumeManagedProviderAgentsAfterRestart,
  resetDraftDispatcherWork,
  startDraftDispatcher,
  startGoalDriver,
  startOrgSync,
  startModelRefreshLoop,
  stopDraftDispatcherWork,
} from './bridge.ts';
import {
  providerRehydrationActionMessage,
  type ProviderRehydrationReport,
} from './providerRuntimeRehydration.ts';
import {
  configureControlWriteScheduler,
  recordControlAction,
} from './controlLog.ts';
import {
  startUpdater,
  stopUpdater,
  beginUpdateCheck,
  checkForUpdate,
  beginUpdateDownload,
  getStatus,
  drainUpdater,
  prepareStagedUpdateInstall,
  installPreparedUpdateAndQuit,
} from './updater.ts';
import { assignmentSubsStatus, cachedSubsStatus, invalidateSubsStatusCache, subsStatus, subsSignin, subsSignout, subsInstall, type SubsStatusOptions, type SubProvider } from './subscriptions.ts';
import { ollamaTags, ollamaPull, ollamaRemove, ollamaCatalogCheck, catalogModelToLocalEntry, type InstalledModelInput } from './ollama.ts';
import {
  backgroundStackStatus,
  dockerStatus,
  getHardware,
  localStackInstallStatus,
  openBackgroundStackAdmission,
  runInTerminal,
  startBackgroundStack,
  stopAllBackgroundStacks,
  stopBackgroundStack,
} from './system.ts';
import { pickProjectFolder, openProjectFolder, projectReadme, projectGit, projectGitRun, githubMeta, cloneGithub, projectDiff, createGithubRepo, linkGithubRepo, forkGithub, commitProject, detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { pickChatFiles, saveChatFiles, savePastedFile } from './chatfiles.ts';
import { listChats, listInflightChats, getChat, saveChat, renameChat, removeChat, genTitle, genReason, unreadChatCount, markChatRead, patchChat, type ChatSession, type ChatPatch } from './chatstore.ts';
import { listPlans, getPlan, savePlan, removePlan, type Plan } from './planstore.ts';
import { listBrainPlans, getBrainPlan, setBrainPlanStatus, createBrainPlan } from './brainplans.ts';
import { listLoops, getLoop, saveLoop, removeLoop, type Loop } from './loopstore.ts';
import { listGoals, getGoal, saveGoal, removeGoal, type Goal } from './goalstore.ts';
import { listDreams, getDream, saveDream, removeDream, type Dream } from './dreamstore.ts';
import { listQuestions, addQuestion, removeQuestion, type BlockerQuestion } from './questionstore.ts';
import { resolveBrainApprovalFromInbox, syncBrainApprovalInbox } from './brainApprovalInbox.ts';
import {
  configureBrainApprovalAutomation,
  runBrainApprovalAutomationOnce,
  startBrainApprovalAutomationLoop,
  type BrainApprovalReviewer,
} from './brainApprovalAutomation.ts';
import { autoCreatePendingLearnTasks, getMaterial, importMaterialFiles, listMaterials, markRecommendation, pickMaterialFiles, pickMaterialFolder, processMaterial, processNextMaterial, recoverStaleMaterials, removeMaterial, routePendingLearnMaterials, saveMaterial, subscribeMaterialChanges, syncUnsyncedMaterialsToBrain, updateMaterialPriority, type CreateMaterialInput, type LearnMaterial, type LearnPriority, type LearnReviewState, type ProcessMaterialContext } from './materialstore.ts';
import { generateImage, readImage, imageModels, getImageServer, detectImageServer, probeImageServer } from './images.ts';
import { listLocalModelCatalog, loadSettings, mergeLocalModelCatalog, removeEvmRpc, saveSettings, setBrainAutomationSettings, setRootIdentitySettings, setUpdateSettings, setImageServer, setWalletConnectSettings, upsertEvmRpc, recordEvmRpcRequest } from '../../../idctl/src/settings/store.ts';
import { configuredRootIdentity, defaultRootIdentitySettings, type BrainAutomationSettings, type EvmRpcKeySource, type EvmRpcProfile, type EvmRpcRequest, type ImageServerConfig, type RootIdentitySettings, type RootIdentityStatus } from '../../../idctl/src/settings/schema.ts';
import { configDir, resolveConfigPath } from '../../../idctl/src/settings/paths.ts';
import {
  type KeyCapabilities,
  type KeyProductionReadiness,
  type KeyReadinessCheck,
} from '../../../idctl/src/keys/types.ts';
import { startBroker, armBroker, disarmBroker, setWatching, setBrokerDisplay, brokerStatus, auditTail, panicBroker, setSupervised, setPaused, confirmAction, pendingActions, setPanicHotkey, mintAgentToken, brokerUrl, stopBroker, legacyAgentTokenReport } from './computeruse/broker.ts';
import { configureComputerUseAuditManager } from './computeruse/audit.ts';
import { getPermissions, openPermissionSettings, type CuPermissionPane } from './computeruse/permissions.ts';
import { driverCapability, getMousePos } from './computeruse/driver.mac.ts';
import { syncDomainsForMethod, type StoreChangeEvent } from '../shared/syncDomains.ts';
import { appProfilePaths, initializeAppProfile, updateManagedManagerProfileUrl } from './appProfile.ts';
import { normalizeAppProfileName } from './appProfileSelection.ts';
import {
  readAppProfilePreference,
  validateRecoveryProfileFolder,
  writeAppProfilePreference,
  type AppProfilePreference,
} from './appProfilePreference.ts';
import {
  freshRecoveryProfileName,
  runStartupRecoveryLoop,
  startupFailureReport,
  type StartupFailureReport,
  type StartupRecoveryDecision,
} from './startupRecovery.ts';
import {
  appendPrivateAppTextFile,
  ensurePrivateAppDirectory,
  readPrivateAppTextFile,
  writePrivateAppTextFileAtomic,
  writePrivateAppTextFileInPlace,
} from './appStatePrivacy.ts';
import {
  configureUnifiedBrainAutomation,
  startUnifiedStack,
  stopUnifiedStack,
  subscribeUnifiedStackServiceReady,
  unifiedStackAdminToken,
  unifiedStackBrainRequestAccess,
  unifiedStackManagerServiceRequestAccess,
  unifiedStackCredentialGuardSelftest,
  unifiedStackPayloadContainsCredential,
  unifiedStackStatus,
} from './unifiedStack.ts';
import {
  BrainDashboardChildWindowRegistry,
  authorizeBrainDashboardRequest,
  brainDashboardNavigationAllowed,
  canonicalBrainDashboardOrigin,
  denyBrainDashboardRequest,
} from './brainDashboardSession.ts';
import {
  configureOnboardingProvider,
  consumerOnboardingStatus,
  deferConsumerOnboarding,
  resumeConsumerOnboarding,
  runStarterFleetOnboarding,
} from './consumerOnboarding.ts';
import { buildLearnProcessContext } from '../shared/learnContext.ts';
import { LEARN_BRAIN_BACKFILL_RUNNER_DELAYS, LEARN_QUEUE_RUNNER_DELAYS } from '../shared/backgroundPolicy.ts';
import { buildPrimaryLeadPlanWork } from '../shared/planWork.ts';
import { planInboxResolutionForOption } from '../shared/planInbox.ts';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { SAFE_MODULE_MANIFEST } from '../../../idctl/src/keys/safeManifest.ts';
import { readSafeRehearsalRecord, SAFE_REHEARSAL_STEPS } from '../../../idctl/src/keys/safeRehearsal.ts';
import { agentSignerVaultStatus, ensureAgentSigner, rotateAgentSigner } from './agentSignerVault.ts';
import { secureStorageStatus } from './secureStoragePolicy.ts';
import { inspectAlchemyAssets } from './alchemyAssetInspector.ts';
import { SafeRolesKeyProvider } from './safeRolesProvider.ts';
import { MockKeyProvider } from '../../../idctl/src/keys/mockProvider.ts';
import { sanitizeSecretPayload } from './secretRedaction.ts';
import { writeStackSelftestResultFile } from './selftestResult.ts';
import {
  ENS_ADDR_SELECTOR,
  ENS_REGISTRY_ADDRESS,
  ENS_RESOLVER_SELECTOR,
  classifyEnsBinding,
  decodeAbiAddress,
  encodeEnsCall,
  hasRuntimeCode,
} from '../shared/identityVerification.ts';
import {
  scheduledDreamArchives,
  type ScheduledDreamNewsItem,
} from '../shared/dreamSchedule.ts';
import type { ScheduleEntry } from '../../../idctl/src/api/client.ts';
import {
  runUnifiedRuntimeContractSelftest,
  type UnifiedRuntimeContractSelftestResult,
} from './unifiedRuntimeContractSelftest.ts';
import {
  cleanupOwnedPrimaryInstance,
  createAppShutdownCoordinator,
  createBoundedWorkDrain,
  shutdownReentryDisposition,
  workSettledWithin,
} from './appShutdown.ts';
import {
  createDelayedBackgroundWork,
  createSingleFlightBackgroundGate,
  createTrackedBackgroundWork,
} from './backgroundActivity.ts';
import {
  focusExistingPrimaryWindow,
  guardActivationWindowCreation,
} from './singleInstance.ts';
import {
  configureMcpProbeRuntime,
  openMcpProbeAdmission,
  stopActiveMcpProbes,
} from './mcpTest.ts';

// Bundled as CommonJS → __dirname is the output dir (out/main/).
declare const __dirname: string;

const unpackedMainRuntimeDirectory = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main')
  : __dirname;
configureMcpProbeRuntime({
  runnerPath: join(unpackedMainRuntimeDirectory, 'mcp-probe-runner.cjs'),
  ...(process.platform === 'win32'
    ? {
        jobHostPath: app.isPackaged
          ? join(
              process.resourcesPath,
              'app.asar.unpacked',
              'out',
              'native',
              'idacc-job-host.exe',
            )
          : join(__dirname, '..', 'native', 'idacc-job-host.exe'),
        bootstrapPath: join(
          unpackedMainRuntimeDirectory,
          'managed-service-bootstrap.cjs',
        ),
      }
    : {}),
});

let win: BrowserWindow | null = null;
let brainDashboardWin: BrowserWindow | null = null;
let brainDashboardSession: Session | null = null;
let brainDashboardSessionBinding = '';
const brainDashboardChildWindows = new BrainDashboardChildWindowRegistry();
type BackgroundStop = () => void | Promise<void>;
let stopGoalDriver: BackgroundStop | null = null;
let stopLearnQueueRunner: BackgroundStop | null = null;
let stopLearnBrainBackfillRunner: BackgroundStop | null = null;
let stopMaterialChangeBridge: BackgroundStop | null = null;
let kickLearnQueueRunner: ((delayMs?: number) => void) | null = null;
let kickLearnBrainBackfillRunner: ((delayMs?: number) => void) | null = null;
let stopDraftDispatcher: BackgroundStop | null = null;
let stopBrainApprovalAutomation: BackgroundStop | null = null;
let stopScheduledDreamArchive: BackgroundStop | null = null;
let stopOrgSyncRunner: BackgroundStop | null = null;
let stopModelRefreshRunner: BackgroundStop | null = null;
let stopProviderRuntimeRehydrationListener: BackgroundStop | null = null;
let providerRuntimeRehydrationWork: Promise<void> | null = null;
let providerRuntimeRehydrationPending = false;
let providerRuntimeRehydrationAbort: AbortController | null = null;
let rendererSafeMode = false;
let rendererRecoveryFirstAt = 0;
let rendererRecoveryAttempts = 0;
let rendererStableTimer: ReturnType<typeof setTimeout> | null = null;
let storeChangeTimer: ReturnType<typeof setTimeout> | null = null;
let keyProviderConfigurationError = '';
let consumerStartupPromise: Promise<void> | null = null;
let shutdownFailureDialog: Promise<void> | null = null;
let shutdownCleanupFailureReport: StartupFailureReport | null = null;
let pendingSecondInstanceFocus = false;
let pendingConsumerActivation = false;
let consumerActivationReady = false;
const pendingStoreChangeDomains = new Set<string>();
const pendingStoreChangeMethods = new Set<string>();
const pendingRendererRecoveryTimers = new Set<ReturnType<typeof setTimeout>>();
const activeBrainApprovalInboxSyncs = new Set<Promise<void>>();
const pendingBackgroundStops: Array<{ promise: Promise<void>; error?: unknown }> = [];
const activeIpcWork = createBoundedWorkDrain(3_000);
let delayedGoalDriverWork = createDelayedBackgroundWork();
let activationWindowWork = createSingleFlightBackgroundGate();
let controlLogBackgroundWork = createTrackedBackgroundWork();
const CONSUMER_SHUTDOWN_DRAIN_TIMEOUT_MS = 45_000;
let ownsSingleInstanceLock = false;

configureControlWriteScheduler((work) => {
  void controlLogBackgroundWork.run(work);
});

const appShutdown = createAppShutdownCoordinator({
  app,
  cleanup: cleanupForThisInstance,
  installPreparedUpdate: installPreparedUpdateAndQuit,
  onError: (error) => {
    const report = startupFailureReport(error);
    logStartupRecoveryFailure('shutdown', report);
    if (appShutdown.status().phase === 'cleanup-failed') {
      showShutdownCleanupFailure(report);
    }
  },
});

// Acquire the process-wide consumer lock before profile selection, migration,
// crash-state persistence, or any startup branch can mutate local state.
ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  void appShutdown.request({ kind: 'quit' });
} else {
  app.on('second-instance', handleSecondInstanceRequest);
  if (process.platform === 'darwin') app.on('activate', handleConsumerAppActivation);
}

type EvmRpcRow = Omit<EvmRpcProfile, 'apiKey' | 'apiKeyEncrypted'> & { keySource: EvmRpcKeySource };
type BrainDashboardTab = 'fleet' | 'health' | 'skills' | 'learning' | 'agents' | 'graph';
type PlanRecoverInput = {
  file?: string;
  option?: string;
  questionId?: string;
  comment?: string;
  status?: string;
};
type TeamLeadDelegationResult = {
  ok: boolean;
  targetCount: number;
  created: Array<{ ok?: boolean; ref?: string; title?: string; team?: string; lead?: string; error?: string; warning?: string }>;
  dispatched: number;
  deferred: number;
  errors?: string[];
};

type FleetAgentGroup = {
  team?: string;
  name?: string;
  agents?: Array<{ name?: string; status?: string; role?: string; metadata?: Record<string, unknown> }>;
};

type RendererCrashState = {
  version?: string;
  rendererCrashCount?: number;
  lastRendererCrashAt?: string;
  safeMode?: boolean;
  safeModeSince?: string;
  lastReason?: string;
  lastExitCode?: number | null;
  previousVersion?: string;
  previousRendererCrashCount?: number;
  resetAt?: string;
  resetReason?: string;
};

const BRAIN_DASHBOARD_TABS: Record<BrainDashboardTab, { title: string; path: string }> = {
  fleet: { title: 'Brain Fleet', path: '/dashboard' },
  health: { title: 'Brain Health', path: '/dashboard/health' },
  skills: { title: 'Brain Skills', path: '/dashboard/skills' },
  learning: { title: 'Brain Learning', path: '/dashboard/learning' },
  agents: { title: 'Brain Agents', path: '/dashboard/agents' },
  graph: { title: 'Brain Graph', path: '/dashboard/graph' },
};
const RENDERER_RECOVERY_WINDOW_MS = 5 * 60 * 1000;
const RENDERER_RECOVERY_MAX_RELOADS = 3;
const RENDERER_STABLE_RESET_MS = 2 * 60 * 1000;
const STORE_CHANGE_FLUSH_MS = 150;

class ConsumerStartupCancelledError extends Error {
  constructor() {
    super('Application shutdown was requested during consumer startup.');
    this.name = 'ConsumerStartupCancelledError';
  }
}

function requireConsumerStartupActive(): void {
  if (appShutdown.isQuiescing()) throw new ConsumerStartupCancelledError();
}

function prepareConsumerBackgroundActivitiesForStartup(): void {
  openMcpProbeAdmission();
  openBackgroundStackAdmission();
  if (delayedGoalDriverWork.isStopped()) {
    if (delayedGoalDriverWork.activeCount() !== 0) {
      throw new Error('Delayed goal-driver work is still draining and cannot be restarted.');
    }
    delayedGoalDriverWork = createDelayedBackgroundWork();
  }
  if (activationWindowWork.isStopped()) {
    activationWindowWork = createSingleFlightBackgroundGate();
  }
  if (controlLogBackgroundWork.isStopped()) {
    if (controlLogBackgroundWork.activeCount() !== 0) {
      throw new Error('Control-log work is still draining and cannot be restarted.');
    }
    controlLogBackgroundWork = createTrackedBackgroundWork();
  }
  resetDraftDispatcherWork();
}

function remainingShutdownDrainMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function drainConsumerStartup(deadlineAt: number): Promise<void> {
  const activeStartup = consumerStartupPromise;
  if (!activeStartup) return;
  const settled = await workSettledWithin(
    activeStartup,
    remainingShutdownDrainMs(deadlineAt),
  );
  if (!settled) {
    throw new Error('Application startup did not stop before the guarded shutdown deadline.');
  }
  try {
    await activeStartup;
  } catch {
    // The startup chain reports genuine failures itself. Shutdown-triggered
    // cancellation is intentionally quiet and still proceeds to cleanup.
  }
}

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function privateUserDataDirectory(): string {
  return ensurePrivateAppDirectory(app.getPath('userData'));
}

function rendererCrashStatePath(): string {
  return join(privateUserDataDirectory(), 'renderer-crash-state.json');
}

function readRendererCrashState(): RendererCrashState | null {
  try {
    return JSON.parse(
      readPrivateAppTextFile(rendererCrashStatePath()),
    ) as RendererCrashState;
  } catch {
    return null;
  }
}

function writeRendererCrashState(state: RendererCrashState): void {
  const path = rendererCrashStatePath();
  writePrivateAppTextFileAtomic(path, JSON.stringify(state, null, 2));
}

function recentRendererCrash(state: RendererCrashState | null): boolean {
  const at = state?.lastRendererCrashAt ? Date.parse(state.lastRendererCrashAt) : 0;
  return Number.isFinite(at) && at > 0 && Date.now() - at < 24 * 60 * 60 * 1000;
}

async function recoverPlanFromInbox(input: PlanRecoverInput): Promise<Record<string, unknown>> {
  const file = String(input?.file || '').trim();
  if (!file) throw new Error('plan file required');
  const option = String(input?.option || input?.status || '').trim();
  const questionId = String(input?.questionId || '').trim();
  const resolution = planInboxResolutionForOption(option);

  if (resolution === 'pause') {
    const status = setBrainPlanStatus(file, 'PAUSED');
    if (questionId) removeQuestion(questionId);
    return { ok: status.ok, action: 'paused', status };
  }

  const listed = listBrainPlans().plans.find((p) => p.file === file);
  const got = getBrainPlan(file);
  if (!listed || !got) throw new Error(`brain plan not found: ${file}`);
  const pending = setBrainPlanStatus(file, 'PENDING');

  const hierarchy = await bridgeCall('coordinator:hierarchy', []) as { primary?: { team?: string; agent?: string } | null };
  const lead = hierarchy.primary?.agent || 'lead';
  const leadTeam = hierarchy.primary?.team || 'default';
  const work = buildPrimaryLeadPlanWork(listed, got.content, lead, leadTeam);
  const existing = getGoal(work.goal.id);
  const savedGoal: Goal = {
    ...(existing ?? work.goal),
    ...work.goal,
    status: 'active',
    priority: existing?.priority ?? work.goal.priority,
    autopilot: false,
    createdAt: existing?.createdAt || work.goal.createdAt,
    updatedAt: Date.now(),
    driver: {
      ...(existing?.driver ?? {}),
      ...(work.goal.driver ?? {}),
      note: input.comment
        ? `${work.goal.driver?.note ?? 'Recovered from Inbox'}; user note: ${String(input.comment).slice(0, 240)}`
        : work.goal.driver?.note,
    },
  };
  saveGoal(savedGoal);

  const delegated = await bridgeCall('work:delegateToTeamLeads', [work.objective, {
    currentTeam: leadTeam,
    primaryLead: lead,
  }]) as TeamLeadDelegationResult;
  const created = (delegated.created ?? []).filter((task) => task.ok);
  if (!delegated.ok || !created.length) {
    const reason = (delegated.errors ?? []).filter(Boolean).join('; ') || 'no live team-lead task was created';
    if (questionId) removeQuestion(questionId);
    addQuestion({
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      question: `Work > Plans recovery for "${listed.title}" still could not create implementation-grade delegated team-lead tasks. ${reason}`,
      options: ['Retry full delegation', 'Review active team leads', 'Pause plan'],
      agent: lead,
      taskRef: `plan:${file}`,
      taskTitle: listed.title,
      team: leadTeam,
      createdAt: Date.now(),
      dedupeKey: `plan:${file}:recovery`,
      source: 'plans',
      metadata: { planFile: file, phase: 'inbox-recovery', goalId: savedGoal.id, reason, targetCount: delegated.targetCount },
    });
    return { ok: false, action: 'recovery-blocked', status: pending, reason, goalId: savedGoal.id };
  }

  if (questionId) removeQuestion(questionId);
  const refs = created.map((task) => task.ref || task.title || `${task.team}/${task.lead}`).filter(Boolean) as string[];
  saveGoal({
    ...savedGoal,
    driver: {
      ...(savedGoal.driver ?? {}),
      taskRefs: [...new Set([...(savedGoal.driver?.taskRefs ?? []), ...refs])],
      lastRunAt: Date.now(),
      note: `Recovered from Inbox and delegated brain plan ${work.source} to ${created.length} team-lead task(s)`,
    },
  });
  const partial = setBrainPlanStatus(file, 'PARTIAL');
  return {
    ok: true,
    action: 'delegated',
    status: partial.ok ? partial : pending,
    goalId: savedGoal.id,
    created: created.length,
    dispatched: delegated.dispatched,
    deferred: delegated.deferred,
    refs,
  };
}

function rendererCrashStateForCurrentVersion(): RendererCrashState | null {
  const state = readRendererCrashState();
  const currentVersion = app.getVersion();
  if (!state) return null;
  if (state.version === currentVersion) return state;

  const next: RendererCrashState = {
    version: currentVersion,
    rendererCrashCount: 0,
    lastRendererCrashAt: state.lastRendererCrashAt,
    safeMode: false,
    lastReason: 'reset-after-version-upgrade',
    lastExitCode: null,
    previousVersion: state.version ?? 'unknown',
    previousRendererCrashCount: state.rendererCrashCount ?? 0,
    resetAt: new Date().toISOString(),
    resetReason: 'app-version-changed',
  };

  try {
    writeRendererCrashState(next);
  } catch (e) {
    console.warn('[renderer-crash] failed to reset stale safe-mode state:', e);
  }
  return next;
}

function shouldUseRendererSafeMode(): boolean {
  if (envFlagEnabled(process.env.IDCTL_DISABLE_RENDERER_SAFE_MODE)) return false;
  if (envFlagEnabled(process.env.IDCTL_RENDERER_SAFE_MODE)) return true;
  const state = rendererCrashStateForCurrentVersion();
  return Boolean(state?.safeMode && state.version === app.getVersion() && recentRendererCrash(state));
}

function configureChromiumStability(): void {
  // Crash reports from macOS 26.5.1 show repeated renderer SIGTRAPs inside
  // Chromium's fontations_ffi path. Electron 33.4.11 exposes this through
  // FontationsFontBackend / FontationsForSelectedFormats, plus CoreText
  // migration gates. Keep the app on the older CoreText path unless explicitly
  // opted back in while Electron/Chromium catches up.
  if (!envFlagEnabled(process.env.IDCTL_ENABLE_FONTATIONS)) {
    const existing = app.commandLine.getSwitchValue('disable-features');
    const features = new Set(existing.split(',').map((item) => item.trim()).filter(Boolean));
    for (const feature of [
      'FontationsFontBackend',
      'FontationsForSelectedFormats',
      'FontFamilyPostscriptMatchingCTMigration',
      'FontFamilyStyleMatchingCTMigration',
    ]) {
      features.add(feature);
    }
    app.commandLine.appendSwitch('disable-features', [...features].join(','));
  }
  rendererSafeMode = shouldUseRendererSafeMode();
  if (rendererSafeMode) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-zero-copy');
    app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  }
}

function logProcessExit(kind: string, detail: Record<string, unknown>): void {
  try {
    const path = join(privateUserDataDirectory(), 'process-exits.jsonl');
    appendPrivateAppTextFile(path, JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      rendererSafeMode,
      ...detail,
    }) + '\n');
  } catch (e) {
    console.warn(`[process-exit] failed to write ${kind} log:`, e);
  }
}

function recordRendererCrash(details: Electron.RenderProcessGoneDetails): RendererCrashState | null {
  try {
    const previous = rendererCrashStateForCurrentVersion();
    const now = new Date().toISOString();
    const next: RendererCrashState = {
      version: app.getVersion(),
      rendererCrashCount: (previous?.rendererCrashCount ?? 0) + 1,
      lastRendererCrashAt: now,
      safeMode: true,
      safeModeSince: previous?.safeMode ? previous.safeModeSince ?? now : now,
      lastReason: details.reason,
      lastExitCode: details.exitCode ?? null,
    };
    writeRendererCrashState(next);
    return next;
  } catch (e) {
    console.warn('[renderer-crash] failed to persist safe-mode state:', e);
    return null;
  }
}

function rendererIndexFile(): string {
  return join(__dirname, '../renderer/index.html');
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(pathToFileURL(rendererIndexFile()).href);
    return actual.protocol === 'file:'
      && actual.host === expected.host
      && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function openExternalHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href);
  } catch {
    // Invalid and privileged schemes are ignored.
  }
}

function requireTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  if (
    !event.senderFrame
    || event.senderFrame !== event.sender.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error('IPC request rejected from an untrusted document.');
  }
}

function loadRendererApp(target: BrowserWindow): Promise<void> {
  const initialView = process.env.IDCTL_VIEW;
  return target.loadFile(rendererIndexFile(), initialView ? { search: `view=${initialView}` } : undefined);
}

function rendererCrashFallbackHtml(state: RendererCrashState | null, details: Electron.RenderProcessGoneDetails): string {
  const lastCrash = state?.lastRendererCrashAt || new Date().toISOString();
  const reason = details.reason || state?.lastReason || 'unknown';
  const exitCode = details.exitCode ?? state?.lastExitCode ?? 'unknown';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ID Agents Control Center - Renderer Recovery</title>
  <style>
    :root { color-scheme: dark; background: #0e1116; color: #d8dee9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(720px, calc(100vw - 48px)); border: 1px solid #2b3340; border-radius: 8px; background: #151a22; padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 20px; line-height: 1.25; }
    p { margin: 8px 0; color: #aeb7c4; line-height: 1.5; }
    code { color: #e5edf7; background: #0f141b; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Renderer recovery paused</h1>
    <p>The app renderer crashed repeatedly, so Control Center paused automatic reloads instead of looping on a blank window.</p>
    <p>Safe mode is enabled. Quit and reopen the app after installing the latest update.</p>
    <p>Last crash: <code>${lastCrash}</code> · reason <code>${reason}</code> · exit <code>${exitCode}</code></p>
  </main>
</body>
</html>`;
}

function scheduleRendererRecovery(target: BrowserWindow, details: Electron.RenderProcessGoneDetails, state: RendererCrashState | null): void {
  if (appShutdown.isQuiescing()) return;
  const now = Date.now();
  if (!rendererRecoveryFirstAt || now - rendererRecoveryFirstAt > RENDERER_RECOVERY_WINDOW_MS) {
    rendererRecoveryFirstAt = now;
    rendererRecoveryAttempts = 0;
  }
  rendererRecoveryAttempts += 1;
  const attempt = rendererRecoveryAttempts;
  const delayMs = Math.min(1000 + attempt * 750, 4000);
  const timer = setTimeout(() => {
    pendingRendererRecoveryTimers.delete(timer);
    if (appShutdown.isQuiescing()) return;
    try {
      if (target.isDestroyed()) return;
      if (attempt <= RENDERER_RECOVERY_MAX_RELOADS) {
        void loadRendererApp(target).catch((error) => {
          logStartupRecoveryFailure('renderer-recovery', startupFailureReport(error));
        });
      } else {
        void target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererCrashFallbackHtml(state, details))}`);
      }
    } catch (e) {
      console.warn('[renderer-crash] recovery failed:', e);
    }
  }, delayMs);
  pendingRendererRecoveryTimers.add(timer);
}

function scheduleRendererStableReset(): void {
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = setTimeout(() => {
    rendererRecoveryFirstAt = 0;
    rendererRecoveryAttempts = 0;
    rendererStableTimer = null;
  }, RENDERER_STABLE_RESET_MS);
  rendererStableTimer.unref?.();
}

// Destroying a partially created window must not trigger the normal
// window-all-closed quit path while the native recovery dialog is active.
let startupRecoveryActive = false;

function logStartupRecoveryFailure(scope: string, report: StartupFailureReport): void {
  // Never log the originating exception: startup errors commonly contain home
  // paths, query-string credentials, or child-process environment fragments.
  console.error(`[${scope}]`, {
    code: report.code,
    diagnosticId: report.diagnosticId,
    ...(report.systemCode ? { systemCode: report.systemCode } : {}),
  });
}

function showShutdownCleanupFailure(report: StartupFailureReport): void {
  shutdownCleanupFailureReport = report;
  if (shutdownFailureDialog) return;
  const prompt = app.whenReady()
    .then(() => dialog.showMessageBox({
      type: 'error',
      title: 'IDACC is still stopping safely',
      message: 'IDACC kept the application open because shutdown cleanup could not be confirmed.',
      detail: `No restart, update, or forced exit was attempted. Retry the guarded cleanup, or keep the application open and try Quit again later.\n\nDiagnostic ID: ${report.diagnosticId}`,
      buttons: ['Retry Shutdown', 'Keep App Open'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }))
    .then((choice) => {
      if (shutdownFailureDialog === prompt) shutdownFailureDialog = null;
      if (choice.response === 0) void appShutdown.retry();
    })
    .catch((error) => {
      if (shutdownFailureDialog === prompt) shutdownFailureDialog = null;
      logStartupRecoveryFailure('shutdown-dialog', startupFailureReport(error));
    });
  shutdownFailureDialog = prompt;
}

function presentShutdownCleanupRecovery(): boolean {
  if (appShutdown.status().phase !== 'cleanup-failed') return false;
  showShutdownCleanupFailure(
    shutdownCleanupFailureReport
      ?? startupFailureReport(new Error('Guarded application cleanup is still incomplete.')),
  );
  return true;
}

function handleSecondInstanceRequest(): void {
  const disposition = shutdownReentryDisposition(appShutdown.status().phase);
  if (disposition === 'recover-cleanup') {
    presentShutdownCleanupRecovery();
    return;
  }
  if (disposition === 'ignore') return;
  pendingSecondInstanceFocus = true;
  focusPrimaryConsumerWindow();
}

function handleConsumerAppActivation(): void {
  const disposition = shutdownReentryDisposition(appShutdown.status().phase);
  if (disposition === 'recover-cleanup') {
    presentShutdownCleanupRecovery();
    return;
  }
  if (disposition === 'ignore') return;
  if (!consumerActivationReady) {
    pendingConsumerActivation = true;
    return;
  }
  if (BrowserWindow.getAllWindows().length !== 0) return;
  void activationWindowWork.run(async () => {
    if (appShutdown.isQuiescing()) return;
    const creation = createWindow();
    const target = win;
    let readyTarget: BrowserWindow | null;
    try {
      readyTarget = await guardActivationWindowCreation(
        creation,
        target,
        () => appShutdown.isQuiescing(),
        (lateTarget) => {
          if (win === lateTarget) win = null;
        },
      );
    } catch (error) {
      // Renderer loading may reject because terminal shutdown destroyed the
      // guarded late window. That expected cancellation has already been
      // contained and must not turn a clean shutdown into cleanup-failed.
      if (appShutdown.isQuiescing()) return;
      throw error;
    }
    if (readyTarget && !readyTarget.isDestroyed()) {
      startUpdaterSafely(readyTarget);
    }
  }).catch((error) => handleUnrecoverableStartupFailure(error));
}

function focusPrimaryConsumerWindow(): void {
  if (appShutdown.isQuiescing()) return;
  try {
    const target = win && !win.isDestroyed()
      ? win
      : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null;
    if (focusExistingPrimaryWindow(target)) pendingSecondInstanceFocus = false;
  } catch (error) {
    logStartupRecoveryFailure('second-instance-focus', startupFailureReport(error));
  }
}

function startUpdaterSafely(target: BrowserWindow): void {
  try {
    startUpdater(target);
  } catch (error) {
    try { stopUpdater(); } catch { /* updater initialization was incomplete */ }
    logStartupRecoveryFailure('updater-start', startupFailureReport(error));
  }
}

function recoveryProfileRoot(): string {
  const userDataRoot = app.getPath('userData');
  const explicitDataDir = String(process.env.IDACC_DATA_DIR || '').trim();
  if (explicitDataDir && isAbsolute(explicitDataDir)) return explicitDataDir;
  let preference: AppProfilePreference | null = null;
  try {
    preference = readAppProfilePreference(userDataRoot);
  } catch {
    // The failure that opened recovery already contains the safe diagnostic.
    // Fall back to the application data root so the user can repair the pointer.
    return userDataRoot;
  }
  if (preference?.dataDir) return preference.dataDir;
  const requestedName = String(process.env.IDACC_PROFILE || preference?.profile || 'default');
  let profileName = 'default';
  try {
    profileName = normalizeAppProfileName(requestedName);
  } catch {
    // An invalid selector is itself recoverable; open the neutral profiles root.
  }
  return join(userDataRoot, 'profiles', profileName);
}

function recoveryFolderToOpen(): string {
  const profileRoot = recoveryProfileRoot();
  if (existsSync(profileRoot)) return profileRoot;
  const parent = dirname(profileRoot);
  if (existsSync(parent)) return parent;
  return app.getPath('userData');
}

async function restartWithRecoveryProfile(
  preference: AppProfilePreference,
): Promise<boolean> {
  const previousDataDir = process.env.IDACC_DATA_DIR;
  const previousProfile = process.env.IDACC_PROFILE;
  if (preference.dataDir) {
    process.env.IDACC_DATA_DIR = preference.dataDir;
    delete process.env.IDACC_PROFILE;
  } else {
    delete process.env.IDACC_DATA_DIR;
    process.env.IDACC_PROFILE = preference.profile;
  }
  try {
    writeAppProfilePreference(app.getPath('userData'), preference);
    void appShutdown.request({ kind: 'relaunch' });
    return true;
  } catch (error) {
    if (previousDataDir === undefined) delete process.env.IDACC_DATA_DIR;
    else process.env.IDACC_DATA_DIR = previousDataDir;
    if (previousProfile === undefined) delete process.env.IDACC_PROFILE;
    else process.env.IDACC_PROFILE = previousProfile;
    const report = startupFailureReport(error);
    logStartupRecoveryFailure('startup-profile-preference', report);
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Profile could not be selected',
      message: 'IDACC could not safely save and restart with that profile.',
      detail: `The current profile remains selected. Repair access to the application-data folder, then try again.\n\nDiagnostic ID: ${report.diagnosticId}`,
      buttons: ['Continue'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
}

function trackBackgroundStop(result: void | Promise<void>): void {
  if (!result || typeof (result as Promise<void>).then !== 'function') return;
  const record: { promise: Promise<void>; error?: unknown } = {
    promise: Promise.resolve(),
  };
  record.promise = Promise.resolve(result).catch((error) => {
    record.error = error;
  });
  pendingBackgroundStops.push(record);
}

async function drainConsumerBackgroundActivities(deadlineAt: number): Promise<void> {
  const errors: unknown[] = [];
  while (pendingBackgroundStops.length > 0) {
    const batch = pendingBackgroundStops.slice();
    const settled = await workSettledWithin(
      Promise.all(batch.map((record) => record.promise)),
      remainingShutdownDrainMs(deadlineAt),
    );
    if (!settled) {
      throw new Error(
        `Shutdown could not confirm ${batch.length} background stop operation(s) before the guarded deadline.`,
      );
    }
    pendingBackgroundStops.splice(0, batch.length);
    errors.push(...batch.flatMap((record) => record.error === undefined ? [] : [record.error]));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more background activities did not stop cleanly.');
  }
}

function quiesceConsumerBackgroundActivities(): void {
  consumerActivationReady = false;
  pendingConsumerActivation = false;
  if (rendererStableTimer) clearTimeout(rendererStableTimer);
  rendererStableTimer = null;
  if (storeChangeTimer) clearTimeout(storeChangeTimer);
  storeChangeTimer = null;
  pendingStoreChangeDomains.clear();
  pendingStoreChangeMethods.clear();
  for (const timer of pendingRendererRecoveryTimers) clearTimeout(timer);
  pendingRendererRecoveryTimers.clear();
  trackBackgroundStop(activationWindowWork.stop());
  trackBackgroundStop(controlLogBackgroundWork.stop());
  trackBackgroundStop(stopDraftDispatcherWork());
  trackBackgroundStop(delayedGoalDriverWork.stop());
  if (activeBrainApprovalInboxSyncs.size > 0) {
    trackBackgroundStop(Promise.all([...activeBrainApprovalInboxSyncs]).then(() => undefined));
  }
  providerRuntimeRehydrationAbort?.abort();
  providerRuntimeRehydrationAbort = null;
  const activeProviderRuntimeRehydration = providerRuntimeRehydrationWork;
  providerRuntimeRehydrationWork = null;
  providerRuntimeRehydrationPending = false;
  if (activeProviderRuntimeRehydration) {
    trackBackgroundStop(activeProviderRuntimeRehydration);
  }

  // Clear references before calling userland stop closures so re-entrant
  // shutdown paths cannot invoke a partially stopped loop twice.
  const stops = [
    stopOrgSyncRunner,
    stopModelRefreshRunner,
    stopProviderRuntimeRehydrationListener,
    stopGoalDriver,
    stopLearnQueueRunner,
    stopLearnBrainBackfillRunner,
    stopMaterialChangeBridge,
    stopBrainApprovalAutomation,
    stopDraftDispatcher,
    stopScheduledDreamArchive,
  ];
  stopOrgSyncRunner = null;
  stopModelRefreshRunner = null;
  stopProviderRuntimeRehydrationListener = null;
  stopGoalDriver = null;
  stopLearnQueueRunner = null;
  stopLearnBrainBackfillRunner = null;
  stopMaterialChangeBridge = null;
  stopBrainApprovalAutomation = null;
  stopDraftDispatcher = null;
  stopScheduledDreamArchive = null;
  kickLearnQueueRunner = null;
  kickLearnBrainBackfillRunner = null;
  for (const stop of stops) {
    try { trackBackgroundStop(stop?.()); } catch (error) {
      trackBackgroundStop(Promise.reject(error));
    }
  }
}

function quiesceConsumerOwnedServices(): void {
  try { stopUpdater(); } catch (error) { trackBackgroundStop(Promise.reject(error)); }
  trackBackgroundStop(drainUpdater());
  try { trackBackgroundStop(stopActiveMcpProbes()); } catch (error) {
    trackBackgroundStop(Promise.reject(error));
  }
  try { trackBackgroundStop(stopAllBackgroundStacks()); } catch (error) {
    trackBackgroundStop(Promise.reject(error));
  }
  try { trackBackgroundStop(stopBroker()); } catch (error) {
    trackBackgroundStop(Promise.reject(error));
  }
  try { globalShortcut.unregisterAll(); } catch { /* shortcuts may be unavailable */ }
  quiesceConsumerBackgroundActivities();
}

function retireBrainDashboardSession(isolatedSession: Session | null): void {
  if (!isolatedSession) return;
  isolatedSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (_details, callback) => callback({ cancel: true }),
  );
  isolatedSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const denied = denyBrainDashboardRequest(details.requestHeaders);
      callback({
        cancel: true,
        requestHeaders: denied.requestHeaders,
      });
    },
  );
  trackBackgroundStop(isolatedSession.clearStorageData().catch(() => {
    // The in-memory session remains deny-all if storage cleanup fails.
  }));
}

function closeBrainDashboard(): void {
  const currentWindow = brainDashboardWin;
  brainDashboardWin = null;
  try {
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.destroy();
  } catch { /* shutdown continues through the isolated session cleanup */ }
  brainDashboardChildWindows.destroyAll();
  const isolatedSession = brainDashboardSession;
  brainDashboardSession = null;
  brainDashboardSessionBinding = '';
  retireBrainDashboardSession(isolatedSession);
}

function cleanupForThisInstance(): Promise<void> {
  // A process that lost the single-instance lock never initialized a profile,
  // broker, background driver, or managed service. Its terminal cleanup must
  // therefore remain a strict no-op and must not touch the primary's resources.
  return cleanupOwnedPrimaryInstance(
    ownsSingleInstanceLock,
    cleanupForTerminalShutdown,
  );
}

async function cleanupForTerminalShutdown(): Promise<void> {
  try {
    if (win && !win.isDestroyed()) saveWinState(win);
  } catch { /* geometry persistence must not block service shutdown */ }
  // Close every source of future work before yielding to an in-flight drain.
  closeBrainDashboard();
  quiesceConsumerOwnedServices();
  // Startup and all background stop handles share one aggregate deadline. A
  // timeout fails closed into the guarded Retry Shutdown flow; a retry gets a
  // fresh deadline while preserving the original terminal intent.
  const activityDrainDeadline = Date.now() + CONSUMER_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const ipcDrained = await activeIpcWork.drain();
  if (!ipcDrained) {
    throw new Error(`Shutdown could not drain ${activeIpcWork.activeCount()} active application request(s).`);
  }
  await drainConsumerStartup(activityDrainDeadline);
  // Startup may have crossed an asynchronous boundary before observing
  // quiescence; collect any stop handle it published in that interval.
  quiesceConsumerOwnedServices();
  await drainConsumerBackgroundActivities(activityDrainDeadline);
  await stopUnifiedStack();
}

async function cleanupFailedConsumerStartup(): Promise<void> {
  closeBrainDashboard();
  quiesceConsumerOwnedServices();
  const activityDrainDeadline = Date.now() + CONSUMER_SHUTDOWN_DRAIN_TIMEOUT_MS;
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch { /* recovery dialog does not depend on the renderer window */ }
  win = null;
  try {
    await drainConsumerBackgroundActivities(activityDrainDeadline);
    await stopUnifiedStack();
  } catch (error) {
    logStartupRecoveryFailure('startup-cleanup', startupFailureReport(error));
  }
}

async function promptForStartupRecovery(report: StartupFailureReport): Promise<StartupRecoveryDecision> {
  for (;;) {
    if (appShutdown.isQuiescing()) return 'quit';
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: report.title,
      message: report.title,
      detail: `${report.detail}\n\nChoosing another profile restarts IDACC in a fresh process. “Start Fresh Profile” creates a separate profile and keeps the current profile untouched.\n\nDiagnostic ID: ${report.diagnosticId}`,
      buttons: [
        'Try Again',
        'Open Profile Folder',
        'Choose Another Profile…',
        'Start Fresh Profile',
        'Quit',
      ],
      defaultId: 0,
      cancelId: 4,
      noLink: true,
    });
    if (appShutdown.isQuiescing()) return 'quit';
    if (choice.response === 0) return 'retry';
    if (choice.response === 1) {
      const openError = await shell.openPath(recoveryFolderToOpen());
      if (openError) {
        const openReport = startupFailureReport(new Error(openError));
        logStartupRecoveryFailure('startup-open-profile', openReport);
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Profile folder could not be opened',
          message: 'IDACC could not open the profile folder in the system file browser.',
          detail: `Your data remains untouched. You can still choose another profile or retry.\n\nDiagnostic ID: ${openReport.diagnosticId}`,
          buttons: ['Continue'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
      }
      continue;
    }
    if (choice.response === 2) {
      const selected = await dialog.showOpenDialog({
        title: 'Choose an IDACC profile folder',
        message: 'Choose an existing IDACC profile folder or create an empty folder.',
        buttonLabel: 'Use This Profile',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      const selectedPath = selected.filePaths[0];
      if (!selected.canceled && selectedPath) {
        try {
          const profileFolder = validateRecoveryProfileFolder(
            selectedPath,
            app.getPath('userData'),
            [app.getPath('home')],
            [app.getAppPath(), process.resourcesPath],
          );
          if (await restartWithRecoveryProfile({ dataDir: profileFolder })) {
            return 'quit';
          }
        } catch (error) {
          const folderReport = startupFailureReport(error);
          logStartupRecoveryFailure('startup-profile-folder', folderReport);
          await dialog.showMessageBox({
            type: 'warning',
            title: 'Choose a dedicated IDACC profile folder',
            message: 'That folder cannot safely be used as an IDACC profile.',
            detail: `Choose an empty folder or an existing IDACC profile folder. Broad folders such as your home, application, or app-data folder are not changed.\n\nDiagnostic ID: ${folderReport.diagnosticId}`,
            buttons: ['Choose Again'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
        }
      }
      continue;
    }
    if (choice.response === 3) {
      if (await restartWithRecoveryProfile({ profile: freshRecoveryProfileName() })) {
        return 'quit';
      }
      continue;
    }
    return 'quit';
  }
}

async function handleConsumerStartupFailure(
  report: StartupFailureReport,
): Promise<StartupRecoveryDecision> {
  if (appShutdown.isQuiescing()) {
    startupRecoveryActive = false;
    return 'quit';
  }
  startupRecoveryActive = true;
  logStartupRecoveryFailure('startup', report);
  await cleanupFailedConsumerStartup();
  if (appShutdown.isQuiescing()) {
    startupRecoveryActive = false;
    return 'quit';
  }
  const decision = await promptForStartupRecovery(report);
  if (decision === 'quit') startupRecoveryActive = false;
  return decision;
}

async function handleUnrecoverableStartupFailure(error: unknown): Promise<void> {
  if (appShutdown.isQuiescing()) return;
  startupRecoveryActive = true;
  const report = startupFailureReport(error);
  logStartupRecoveryFailure('startup-recovery', report);
  await cleanupFailedConsumerStartup();
  if (appShutdown.isQuiescing()) return;
  try {
    dialog.showErrorBox(
      'IDACC could not open recovery',
      `IDACC stopped its local services safely and did not reset your profile. Close the app, then reopen it to try again.\n\nDiagnostic ID: ${report.diagnosticId}`,
    );
  } catch {
    // The safe report above is still available in the process log.
  }
  void appShutdown.request({ kind: 'exit', code: 1 });
}

if (ownsSingleInstanceLock) configureChromiumStability();

async function syncGoalInstructionsAfterMutation(action: string): Promise<void> {
  try {
    await bridgeCall('goals:syncInstructions', []);
  } catch (e) {
    console.warn(`[goals] ${action}: saved locally, but instruction sync failed:`, e);
  }
}

function kickGoalDriverAfterMutation(goal: Goal | null | undefined, action: string): void {
  if (
    appShutdown.isQuiescing()
    || !goal
    || goal.status !== 'active'
    || goal.autopilot !== true
  ) {
    return;
  }
  delayedGoalDriverWork.schedule(250, async () => {
    if (appShutdown.isQuiescing()) return;
    try {
      await bridgeCall('goalDriver:runOnce', []);
    } catch (e) {
      console.warn(`[goals] ${action}: saved locally, but immediate Autopilot run failed:`, e);
    }
  });
}

function planHasTag(plan: Plan, tag: string): boolean {
  return Array.isArray(plan.tags) && plan.tags.includes(tag);
}

function isLearnTaskDraftPlan(plan: Plan): boolean {
  return plan.status === 'draft' && planHasTag(plan, 'learn') && (planHasTag(plan, 'draft-task') || planHasTag(plan, 'feature-update'));
}

function learnDraftTaskDescription(plan: Plan): string {
  return [
    plan.content || plan.request || plan.title,
    '',
    'Migrated from a Learn recommendation draft plan because Learn recommendations should create queued Tasks, not persistent plan drafts.',
    Array.isArray(plan.tags) && plan.tags.length ? `Tags: ${plan.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function safeLearnDraftTeam(team: string): string {
  const t = String(team || '').trim();
  return !t || t === 'public' ? 'default' : t;
}

async function convertLearnTaskDraftPlans(): Promise<number> {
  let converted = 0;
  for (const summary of listPlans()) {
    const plan = getPlan(summary.id);
    if (!plan || !isLearnTaskDraftPlan(plan)) continue;
    try {
      const result = await bridgeCall('work:createPlan', [
        plan.title,
        [{
          title: plan.title,
          description: learnDraftTaskDescription(plan),
          agent: plan.agent ?? '',
          dependsOn: [],
        }],
        { dispatch: false, lane: 'todo', team: safeLearnDraftTeam(plan.team), respectOwners: true },
      ]) as { created?: { ok?: boolean; ref?: string; error?: string }[] };
      if ((result.created ?? []).some((row) => row.ok)) {
        removePlan(plan.id);
        converted += 1;
      }
    } catch (e) {
      console.warn(`[plans] Learn draft migration skipped for ${plan.id}:`, e);
    }
  }
  return converted;
}

function normalizeBrainDashboardTab(value: unknown): BrainDashboardTab {
  const tab = String(value || 'fleet').toLowerCase();
  if (tab in BRAIN_DASHBOARD_TABS) return tab as BrainDashboardTab;
  throw new Error(`Unsupported Brain dashboard tab "${tab}"`);
}

function brainDashboardWebPreferences(isolatedSession: Session) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    devTools: false,
    session: isolatedSession,
  };
}

function configureBrainDashboardWindow(
  window: BrowserWindow,
  origin: string,
  isolatedSession: Session,
): void {
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (brainDashboardNavigationAllowed(target, origin)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: brainDashboardWebPreferences(isolatedSession),
        },
      };
    }
    // This bearer-authorized surface cannot prove that an external window was
    // requested by a trusted user gesture rather than stored/scripted content.
    // Keep it fail-closed instead of turning the system browser into an
    // authenticated-data exfiltration channel.
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', (childWindow) => {
    const release = brainDashboardChildWindows.track(childWindow);
    childWindow.on('closed', release);
    configureBrainDashboardWindow(childWindow, origin, isolatedSession);
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (brainDashboardNavigationAllowed(target, origin)) return;
    event.preventDefault();
  });
}

function ensureBrainDashboardSession(
  origin: string,
  authorizationHeader: string,
): Session {
  const canonicalOrigin = canonicalBrainDashboardOrigin(origin);
  const binding = `${canonicalOrigin}\0${authorizationHeader}`;
  if (brainDashboardSession && brainDashboardSessionBinding === binding) {
    return brainDashboardSession;
  }
  closeBrainDashboard();

  const isolatedSession = session.fromPartition(
    `idacc-brain-dashboard-${randomUUID()}`,
    { cache: false },
  );
  const requestDecision = (
    url: string,
    requestHeaders: Record<string, string> = {},
  ) => authorizeBrainDashboardRequest(
    url,
    canonicalOrigin,
    authorizationHeader,
    requestHeaders,
  );
  isolatedSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      callback({ cancel: !requestDecision(details.url).allowed });
    },
  );
  isolatedSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const decision = requestDecision(details.url, details.requestHeaders);
      callback({
        cancel: !decision.allowed,
        requestHeaders: decision.requestHeaders,
      });
    },
  );
  brainDashboardSession = isolatedSession;
  brainDashboardSessionBinding = binding;
  return isolatedSession;
}

async function openBrainDashboard(value: unknown): Promise<{ ok: true; tab: BrainDashboardTab; url: string }> {
  const tab = normalizeBrainDashboardTab(value);
  const cfg = BRAIN_DASHBOARD_TABS[tab];
  const access = unifiedStackBrainRequestAccess();
  const origin = canonicalBrainDashboardOrigin(access.origin);
  const url = `${origin}${cfg.path}`;
  const isolatedSession = ensureBrainDashboardSession(
    origin,
    access.authorizationHeader,
  );
  if (!brainDashboardWin || brainDashboardWin.isDestroyed()) {
    const createdWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      title: cfg.title,
      webPreferences: brainDashboardWebPreferences(isolatedSession),
    });
    brainDashboardWin = createdWindow;
    configureBrainDashboardWindow(createdWindow, origin, isolatedSession);
    createdWindow.on('closed', () => {
      if (brainDashboardWin !== createdWindow) return;
      brainDashboardWin = null;
      brainDashboardChildWindows.destroyAll();
      const retiredSession = brainDashboardSession;
      brainDashboardSession = null;
      brainDashboardSessionBinding = '';
      retireBrainDashboardSession(retiredSession);
    });
  }
  brainDashboardWin.setTitle(cfg.title);
  brainDashboardWin.show();
  brainDashboardWin.focus();
  if (brainDashboardWin.webContents.getURL() !== url) {
    await brainDashboardWin.loadURL(url);
  }
  return { ok: true, tab, url };
}

type BrainDashboardLifecycleSelftestResult = {
  childCreated: boolean;
  childTracked: boolean;
  childUsedIsolatedSession: boolean;
  childDestroyed: boolean;
  retiredRequestCancelled: boolean;
  sessionRotated: boolean;
  allPassed: boolean;
};

async function runBrainDashboardLifecycleSelftest(): Promise<BrainDashboardLifecycleSelftestResult> {
  let child: BrowserWindow | null = null;
  let originalSession: Session | null = null;
  try {
    const opened = await openBrainDashboard('graph');
    const parent = brainDashboardWin;
    originalSession = brainDashboardSession;
    if (!parent || !originalSession) {
      throw new Error('Brain dashboard did not create its isolated window and session');
    }
    const childPromise = new Promise<BrowserWindow>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Brain dashboard window.open child was not created')),
        5_000,
      );
      parent.webContents.once('did-create-window', (createdChild) => {
        clearTimeout(timeout);
        resolve(createdChild);
      });
    });
    await parent.webContents.executeJavaScript(
      `Boolean(window.open(${JSON.stringify(`${opened.url}/child`)}, '_blank'))`,
      true,
    );
    child = await childPromise;
    const childCreated = !child.isDestroyed();
    const childTracked = brainDashboardChildWindows.size() === 1;
    const childUsedIsolatedSession = child.webContents.session === originalSession;

    closeBrainDashboard();
    const childDestroyed = child.isDestroyed();
    let retiredRequestCancelled = false;
    try {
      const response = await originalSession.fetch(
        `${new URL(opened.url).origin}/dashboard-retired-probe`,
        {
          headers: { Authorization: 'Bearer must-be-stripped' },
          signal: AbortSignal.timeout(3_000),
        },
      );
      await response.body?.cancel();
    } catch {
      retiredRequestCancelled = true;
    }

    await openBrainDashboard('graph');
    const sessionRotated = Boolean(
      brainDashboardSession
      && brainDashboardSession !== originalSession,
    );
    closeBrainDashboard();
    const result = {
      childCreated,
      childTracked,
      childUsedIsolatedSession,
      childDestroyed,
      retiredRequestCancelled,
      sessionRotated,
      allPassed: false,
    };
    result.allPassed = Object.entries(result)
      .filter(([key]) => key !== 'allPassed')
      .every(([, value]) => value === true);
    return result;
  } finally {
    closeBrainDashboard();
  }
}

type ComputerUseAttachedAgent = { id?: string; name?: string; team?: string; authority?: string };

function sortedComputerUseKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}

function scopedComputerUseAuthority(agent: ComputerUseAttachedAgent, fallbackTeam: string): string {
  return String(agent.authority ?? `${agent.team ?? fallbackTeam}:${agent.name ?? ''}`).trim();
}

function attachedComputerUseStamp(agents: ComputerUseAttachedAgent[], team: string): string {
  return sortedComputerUseKey(agents.map((a) => `${a.id ?? ''}:${scopedComputerUseAuthority(a, team)}`));
}

async function armComputerUseFromCurrentAttached(teamArg: unknown, expectedAttachedStampArg?: unknown) {
  const team = typeof teamArg === 'string' && teamArg.trim() ? teamArg.trim() : 'default';
  const attached = await bridgeCall('cu:attached', [team]) as ComputerUseAttachedAgent[];
  if (typeof expectedAttachedStampArg !== 'string') {
    throw new Error('Computer Use arming requires a reviewed attachment snapshot. Refresh Who can drive and try again.');
  }
  const expected = expectedAttachedStampArg;
  const actualStamp = attachedComputerUseStamp(attached ?? [], team);
  if (expected !== actualStamp) {
    throw new Error('Computer Use blessed agents changed before arming; refresh and review Who can drive.');
  }
  const status = brokerStatus();
  const next = sortedComputerUseKey([
    ...(status.blessed ?? []).filter((authority: string) => !authority.startsWith(`${team}:`)),
    ...(attached ?? []).map((agent) => scopedComputerUseAuthority(agent, team)),
  ]).split('|').filter(Boolean);
  return { ...armBroker(next), team, attached: attached?.length ?? 0 };
}

function publishStoreChange(method: string): void {
  if (appShutdown.isQuiescing()) return;
  const domains = syncDomainsForMethod(method);
  if (!domains.length) return;
  for (const domain of domains) pendingStoreChangeDomains.add(domain);
  pendingStoreChangeMethods.add(method);
  if (storeChangeTimer) return;
  storeChangeTimer = setTimeout(() => {
    storeChangeTimer = null;
    const flushedDomains = [...pendingStoreChangeDomains];
    const flushedMethods = [...pendingStoreChangeMethods];
    pendingStoreChangeDomains.clear();
    pendingStoreChangeMethods.clear();
    if (!flushedDomains.length) return;
    const methodLabel = flushedMethods.length === 1
      ? flushedMethods[0]
      : `batch:${flushedMethods.slice(0, 6).join(',')}${flushedMethods.length > 6 ? ',...' : ''}`;
    const event: StoreChangeEvent = { method: methodLabel, domains: flushedDomains, at: Date.now() };
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('idagents:sync', event);
    } catch { /* window may be gone */ }
  }, STORE_CHANGE_FLUSH_MS);
  storeChangeTimer.unref?.();
}

function startLearnQueueRunner(): () => Promise<void> {
  const gate = createSingleFlightBackgroundGate();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs = LEARN_QUEUE_RUNNER_DELAYS.idleMs) => {
    if (gate.isStopped()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
    timer.unref?.();
  };

  const tick = (): Promise<void> => gate.run(async () => {
    try {
      recoverStaleMaterials();
      const current = listMaterials();
      const activeProcessing = current.some((m) => m.status === 'processing');
      const hasQueued = current.some((m) => m.status === 'queued');
      if (activeProcessing) {
        schedule(hasQueued ? LEARN_QUEUE_RUNNER_DELAYS.activeProcessingWithQueuedMs : LEARN_QUEUE_RUNNER_DELAYS.activeProcessingMs);
        return;
      }
      if (hasQueued) {
        const material = await processNextMaterial(await learnProcessContext());
        if (material) {
          if (!appShutdown.isQuiescing()) {
            publishStoreChange('materials:processNext');
            recordControlAction('materials:processNext', ['background'], material);
          }
          if (material.status === 'ready' || material.status === 'blocked') kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs);
        }
      }
      const taskBackfill = await autoCreatePendingLearnTasks({ limit: hasQueued ? 2 : 6 });
      if (
        !appShutdown.isQuiescing()
        && (taskBackfill.created || taskBackfill.deferred || taskBackfill.failed)
      ) {
        publishStoreChange('materials:tasks');
        recordControlAction('materials:tasks', ['background'], taskBackfill);
      }
      const routeBackfill = await routePendingLearnMaterials({ limit: hasQueued ? 1 : 3 });
      if (!appShutdown.isQuiescing() && (routeBackfill.dispatched || routeBackfill.failed)) {
        publishStoreChange('materials:tasks');
        recordControlAction('materials:routeLeads', ['background'], routeBackfill);
      }
      const remaining = listMaterials().some((m) => m.status === 'queued');
      schedule(remaining ? LEARN_QUEUE_RUNNER_DELAYS.remainingQueuedMs : LEARN_QUEUE_RUNNER_DELAYS.idleMs);
    } catch (e) {
      console.warn('[learn] auto-process queue failed:', e);
      schedule(LEARN_QUEUE_RUNNER_DELAYS.retryMs);
    }
  });

  kickLearnQueueRunner = schedule;
  schedule(LEARN_QUEUE_RUNNER_DELAYS.bootMs);
  return () => {
    kickLearnQueueRunner = null;
    if (timer) clearTimeout(timer);
    return gate.stop();
  };
}

function approvalReviewerSpecialty(team: string, agent: string): BrainApprovalReviewer['specialty'] {
  if (/skill|capabilit|catalog|tool/i.test(agent)) return 'skill-domain';
  if (/research|fact-check/i.test(agent)) return 'evidence';
  if (/coder|architect|engineer|qa/i.test(agent)) return 'implementation';
  return 'coordination';
}

async function availableBrainApprovalReviewers(): Promise<BrainApprovalReviewer[]> {
  const groups = await bridgeCall('agents:allTeams', []) as FleetAgentGroup[];
  const reviewers: BrainApprovalReviewer[] = [];
  for (const group of groups ?? []) {
    const team = String(group.team || group.name || '').trim();
    if (!team) continue;
    for (const row of group.agents ?? []) {
      const agent = String(row.name || '').trim();
      const status = String(row.status || '').toLowerCase();
      if (!agent || !['running', 'active', 'working', 'idle'].includes(status)) continue;
      const candidate = (team === 'default' && ['coder', 'researcher', 'lead'].includes(agent))
        || /(?:research|engineering|security|skills?|capabilities|catalog)-lead$/i.test(agent);
      if (!candidate) continue;
      reviewers.push({ team, agent, specialty: approvalReviewerSpecialty(team, agent) });
    }
  }
  return reviewers;
}

function configureAutomaticBrainApprovalReview(): void {
  configureBrainApprovalAutomation({
    reviewers: availableBrainApprovalReviewers,
    start: async (reviewer, prompt, sessionId) => bridgeCall('dispatch:start', [
      `/ask ${reviewer.agent} ${JSON.stringify(prompt)}`,
      sessionId,
      reviewer.team,
    ]) as Promise<{ queryId?: string; inline?: string }>,
    poll: async (reviewer, queryId) => bridgeCall('query:poll', [queryId, 0, reviewer.team]) as Promise<{ status?: string; text?: string; error?: string }>,
  });
}

async function learnProcessContext(): Promise<ProcessMaterialContext> {
  const settings = loadSettings();
  let liveTeams: string[] = [];
  try {
    const teams = await bridgeCall('teams', []) as Array<{ name?: string }>;
    liveTeams = teams.map((team) => String(team.name || '').trim()).filter(Boolean);
  } catch {
    liveTeams = [];
  }
  return buildLearnProcessContext({
    defaultTeam: settings.defaultTeam,
    knownTeams: settings.knownTeams,
  }, liveTeams);
}

function startLearnBrainBackfillRunner(): () => Promise<void> {
  const gate = createSingleFlightBackgroundGate();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs = LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.idleMs) => {
    if (gate.isStopped()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
    timer.unref?.();
  };

  const tick = (): Promise<void> => gate.run(async () => {
    try {
      const result = await syncUnsyncedMaterialsToBrain({ limit: 2 });
      if (!appShutdown.isQuiescing() && result.attempted > 0) {
        publishStoreChange('materials:brainSync');
      }
      schedule(result.remaining > 0 ? LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.activeMs : LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.idleMs);
    } catch (e) {
      console.warn('[learn] brain backfill failed:', e);
      schedule(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.retryMs);
    }
  });

  kickLearnBrainBackfillRunner = schedule;
  schedule(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.bootMs);
  return () => {
    kickLearnBrainBackfillRunner = null;
    if (timer) clearTimeout(timer);
    return gate.stop();
  };
}

function evmEnvKeyName(id: string): string {
  return `IDCTL_EVM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function secureCredentialStorageAvailable(): boolean {
  return secureStorageStatus(safeStorage).available;
}

function encryptSecret(secret: string): string {
  if (!secureCredentialStorageAvailable()) {
    throw new Error('Secure operating-system credential storage is unavailable. Unlock or configure your system credential store and retry.');
  }
  return safeStorage.encryptString(secret).toString('base64');
}

function decryptSecret(encrypted?: string): string | undefined {
  if (!encrypted || !secureCredentialStorageAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

function configureSecureSettings(): void {
  configureSettingsSecretCodec({ encrypt: encryptSecret, decrypt: decryptSecret });
  try {
    const migrated = migrateSettingsSecrets();
    if (migrated.providers || migrated.mcpServers) {
      console.info(`[settings] encrypted ${migrated.providers} provider and ${migrated.mcpServers} MCP connection secret set(s)`);
    }
  } catch (error) {
    // Linux keyrings can be temporarily unavailable before the desktop session
    // unlocks. Existing data remains untouched and migration retries next boot.
    console.warn('[settings] secure secret migration deferred:', error);
  }
}

function presentProviderRehydrationStatus(report: ProviderRehydrationReport): void {
  const detail = providerRehydrationActionMessage(report);
  if (!detail) return;

  // Deliberately log only aggregate counts and stable reason codes. Provider
  // credentials and Manager exception text never enter startup diagnostics.
  console.warn('[provider-runtime] managed restart left provider agents safely paused', {
    attempted: report.attempted,
    resumed: report.resumed,
    issues: report.issues.map((issue) => issue.reason),
  });

  const options = {
    type: 'warning' as const,
    title: 'Some agents are paused',
    message: 'IDACC kept API-connected agents paused until their provider access can be restored safely.',
    detail,
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  };
  const prompt = win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options);
  void prompt.catch((error) => {
    logStartupRecoveryFailure('provider-runtime-status', startupFailureReport(error));
  });
}

function rehydrateProviderAgentsForReadyManager(): Promise<void> {
  if (providerRuntimeRehydrationWork) {
    providerRuntimeRehydrationPending = true;
    return providerRuntimeRehydrationWork;
  }
  providerRuntimeRehydrationPending = false;
  const abort = new AbortController();
  providerRuntimeRehydrationAbort = abort;
  const work = resumeManagedProviderAgentsAfterRestart(abort.signal)
    .then((report) => {
      if (!appShutdown.isQuiescing()) presentProviderRehydrationStatus(report);
    })
    .catch(() => {
      if (appShutdown.isQuiescing()) return;
      presentProviderRehydrationStatus({
        attempted: 0,
        resumed: 0,
        issues: [{
          team: 'all teams',
          reason: 'fleet_inventory_unavailable',
        }],
      });
    })
    .finally(() => {
      if (providerRuntimeRehydrationWork === work) {
        providerRuntimeRehydrationWork = null;
      }
      if (providerRuntimeRehydrationAbort === abort) {
        providerRuntimeRehydrationAbort = null;
      }
      if (providerRuntimeRehydrationPending && !appShutdown.isQuiescing()) {
        providerRuntimeRehydrationPending = false;
        void rehydrateProviderAgentsForReadyManager();
      }
    });
  providerRuntimeRehydrationWork = work;
  return work;
}

function evmKeySourceOf(rpc: EvmRpcProfile): EvmRpcKeySource {
  if (rpc.apiKeyEncrypted) return 'encrypted';
  if (rpc.apiKey || extractEmbeddedRpcKey(rpc.httpsUrl)) return 'config';
  if (process.env[evmEnvKeyName(rpc.id)]) return 'env';
  return 'none';
}

function resolveEvmRpcKey(rpc: EvmRpcProfile): string | undefined {
  return decryptSecret(rpc.apiKeyEncrypted) || rpc.apiKey || process.env[evmEnvKeyName(rpc.id)] || undefined;
}

function redactEvmRpc(rpc: EvmRpcProfile): EvmRpcRow {
  const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safe } = rpc;
  return { ...safe, httpsUrl: sanitizeRpcUrlForDisplay(rpc.httpsUrl), keySource: evmKeySourceOf(rpc) };
}

function normalizeRpcUrlForStorage(httpsUrl: string, apiKey?: string): string {
  let url = httpsUrl.trim();
  const key = apiKey?.trim();
  if (!key) return url;
  const encoded = encodeURIComponent(key);
  url = url.split(key).join('{API_KEY}');
  if (encoded !== key) url = url.split(encoded).join('{API_KEY}');
  return url;
}

function isSecretLikeRpcValue(value: string | undefined): value is string {
  if (!value) return false;
  if (/^\{API_KEY\}$|^\$API_KEY$|^placeholder$/i.test(value)) return false;
  return /^[A-Za-z0-9._~:-]{12,}$/.test(value);
}

function extractEmbeddedRpcKey(httpsUrl: string | undefined): string | undefined {
  if (!httpsUrl) return undefined;
  try {
    const parsed = new URL(httpsUrl.replace(/\{API_KEY\}|\$API_KEY/g, 'placeholder'));
    const queryNames = ['apikey', 'api_key', 'key', 'token', 'access_token', 'auth', 'x-api-key'];
    for (const [name, value] of new URLSearchParams(parsed.searchParams)) {
      if (queryNames.includes(name.toLowerCase()) && isSecretLikeRpcValue(value)) return value;
    }
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    for (let i = 1; i < parts.length; i++) {
      if (/^v[23]$/i.test(parts[i - 1]) && isSecretLikeRpcValue(parts[i])) return parts[i];
    }
    if (/quicknode|quiknode/i.test(parsed.hostname)) {
      const candidate = parts.find(isSecretLikeRpcValue);
      if (candidate) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeRpcForStorage(httpsUrl: string, explicitApiKey?: string): { httpsUrl: string; apiKey?: string } {
  const explicit = explicitApiKey?.trim() || undefined;
  const embedded = extractEmbeddedRpcKey(httpsUrl);
  let normalized = normalizeRpcUrlForStorage(httpsUrl, explicit || embedded);
  if (explicit && embedded && embedded !== explicit) {
    normalized = normalizeRpcUrlForStorage(normalized, embedded);
  }
  return { httpsUrl: normalized, apiKey: explicit || embedded };
}

function sanitizeRpcUrlForDisplay(httpsUrl: string): string {
  const embedded = extractEmbeddedRpcKey(httpsUrl);
  return embedded ? normalizeRpcUrlForStorage(httpsUrl, embedded) : httpsUrl;
}

function redactRpcSecretText(text: string | undefined, rpc: EvmRpcProfile, apiKey?: string): string | undefined {
  if (!text) return text;
  const keys = [apiKey, rpc.apiKey, extractEmbeddedRpcKey(rpc.httpsUrl)].filter((k): k is string => Boolean(k));
  let out = text;
  for (const key of keys) {
    const encoded = encodeURIComponent(key);
    out = out.split(key).join('{API_KEY}');
    if (encoded !== key) out = out.split(encoded).join('{API_KEY}');
  }
  return out;
}

function loadEvmRpcsMigratingSecrets(): EvmRpcProfile[] {
  const cfg = loadSettings();
  const rpcs = cfg.evmRpcs ?? [];
  let changed = false;
  for (const rpc of rpcs) {
    const legacyKey = rpc.apiKey?.trim();
    const embeddedKey = extractEmbeddedRpcKey(rpc.httpsUrl);
    const keyToEncrypt = legacyKey || (!rpc.apiKeyEncrypted ? embeddedKey : undefined);
    if (keyToEncrypt && !rpc.apiKeyEncrypted) {
      rpc.apiKeyEncrypted = encryptSecret(keyToEncrypt);
      changed = true;
    }
    if (rpc.apiKey) {
      delete rpc.apiKey;
      changed = true;
    }
    if (embeddedKey) {
      rpc.httpsUrl = normalizeRpcUrlForStorage(rpc.httpsUrl, embeddedKey);
      changed = true;
    }
  }
  if (changed) {
    cfg.evmRpcs = rpcs;
    saveSettings(cfg);
  }
  return rpcs;
}

function rpcUrlForRequest(httpsUrl: string, apiKey?: string): string {
  const key = apiKey?.trim();
  let url = httpsUrl.trim();
  if (key) {
    url = url.replace(/\{API_KEY\}|\$API_KEY/g, encodeURIComponent(key));
    if (!/\{API_KEY\}|\$API_KEY/.test(httpsUrl) && /\/v[23]\/?$/.test(url)) {
      url = `${url.replace(/\/?$/, '/')}${encodeURIComponent(key)}`;
    }
  }
  return url;
}

function validateEvmRpcInput(input: EvmRpcProfile): void {
  if (!input.network?.trim()) throw new Error('network is required');
  const url = input.httpsUrl?.trim();
  if (!url) throw new Error('HTTPS URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{API_KEY\}|\$API_KEY/g, 'placeholder'));
  } catch {
    throw new Error('HTTPS URL must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('EVM RPC URL must use https');
}

async function probeEvmRpc(id: string): Promise<{ rpcs: EvmRpcRow[]; outcome: EvmRpcRequest }> {
  const rpc = loadEvmRpcsMigratingSecrets().find((x) => x.id === id);
  if (!rpc) throw new Error('EVM RPC endpoint not found');
  const key = resolveEvmRpcKey(rpc);
  const started = Date.now();
  const outcome: EvmRpcRequest = { at: started, method: 'eth_blockNumber', status: 'unknown', keySource: evmKeySourceOf(rpc) };
  try {
    const res = await fetch(rpcUrlForRequest(rpc.httpsUrl, key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    outcome.httpStatus = res.status;
    const body = await res.json().catch(() => null) as { result?: string; error?: { message?: string; code?: number } } | null;
    outcome.latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403 || body?.error?.code === 401) {
      outcome.status = 'auth-error';
      outcome.error = redactRpcSecretText(body?.error?.message ?? `HTTP ${res.status}`, rpc, key);
    } else if (!res.ok) {
      outcome.status = 'unreachable';
      outcome.error = redactRpcSecretText(body?.error?.message ?? `HTTP ${res.status}`, rpc, key);
    } else if (typeof body?.result === 'string') {
      outcome.status = 'available';
      outcome.blockNumber = Number.parseInt(body.result, 16);
    } else {
      outcome.status = 'error';
      outcome.error = redactRpcSecretText(body?.error?.message ?? 'missing eth_blockNumber result', rpc, key);
    }
  } catch (err) {
    outcome.latencyMs = Date.now() - started;
    outcome.status = 'unreachable';
    outcome.error = redactRpcSecretText(err instanceof Error ? err.message : String(err), rpc, key);
  }
  recordEvmRpcRequest(id, outcome);
  return { rpcs: loadEvmRpcsMigratingSecrets().map(redactEvmRpc), outcome };
}

type JsonRpcResponse = { result?: unknown; error?: { code?: number; message?: string } };

async function evmJsonRpcValue(rpc: EvmRpcProfile, method: string, params: unknown[]): Promise<unknown> {
  const key = resolveEvmRpcKey(rpc);
  const response = await fetch(rpcUrlForRequest(rpc.httpsUrl, key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as JsonRpcResponse | null;
  if (!response.ok || body?.error || body?.result === undefined) {
    const reason = redactRpcSecretText(body?.error?.message ?? `HTTP ${response.status}`, rpc, key) ?? 'invalid JSON-RPC response';
    throw new Error(reason);
  }
  return body.result;
}

async function evmJsonRpc(rpc: EvmRpcProfile, method: string, params: unknown[]): Promise<string> {
  const result = await evmJsonRpcValue(rpc, method, params);
  if (typeof result !== 'string') throw new Error(`${method} returned a non-string JSON-RPC result`);
  return result;
}

function decodeAbiUint(data: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(data) || data.length < 66) throw new Error('invalid uint256 response');
  return BigInt(`0x${data.slice(2, 66)}`);
}

function decodeAbiAddressArray(data: string): string[] {
  if (!/^0x[0-9a-f]+$/i.test(data) || data.length < 130) throw new Error('invalid address[] response');
  const hex = data.slice(2);
  const offsetBytes = Number(BigInt(`0x${hex.slice(0, 64)}`));
  const offset = offsetBytes * 2;
  const count = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  if (!Number.isSafeInteger(count) || count < 0 || count > 64 || hex.length < offset + 64 + count * 64) {
    throw new Error('invalid address[] length');
  }
  return Array.from({ length: count }, (_, index) => {
    const word = hex.slice(offset + 64 + index * 64, offset + 128 + index * 64);
    return `0x${word.slice(24)}`;
  });
}

function ethereumMainnetRpc(): EvmRpcProfile | undefined {
  return loadEvmRpcsMigratingSecrets().find((rpc) => {
    const label = `${rpc.id} ${rpc.network}`.toLowerCase();
    return rpc.enabled !== false && /ethereum|eth-mainnet|mainnet-eth/.test(label) && !/sepolia|testnet|holesky/.test(label);
  });
}

function ethereumSepoliaRpc(): EvmRpcProfile | undefined {
  return loadEvmRpcsMigratingSecrets().find((rpc) => {
    const label = `${rpc.id} ${rpc.network}`.toLowerCase();
    return rpc.enabled !== false && /sepolia/.test(label) && !/base|optimism|rootstock/.test(label);
  });
}

function evmRpcForChain(chainId: number): EvmRpcProfile | undefined {
  if (chainId === 1) return ethereumMainnetRpc();
  if (chainId === 11155111) return ethereumSepoliaRpc();
  const patterns: Record<number, RegExp> = {
    8453: /(?:^|\b)base(?:\s+|-)?mainnet(?:\b|$)|^base$/,
    84532: /(?:^|\b)base(?:\s+|-)?sepolia(?:\b|$)/,
  };
  const pattern = patterns[chainId];
  if (!pattern) return undefined;
  return loadEvmRpcsMigratingSecrets().find((rpc) => (
    rpc.enabled !== false && pattern.test(`${rpc.id} ${rpc.network}`.toLowerCase())
  ));
}

const GUARDED_EVM_READ_METHODS = new Set(['eth_call', 'eth_getCode', 'eth_getTransactionReceipt']);

async function guardedEvmRead(chainId: number, method: string, params: unknown[]): Promise<string> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('A valid EVM chain id is required.');
  if (!GUARDED_EVM_READ_METHODS.has(method)) throw new Error(`EVM read method is not allowed: ${method}`);
  const rpc = evmRpcForChain(chainId);
  if (!rpc) throw new Error(`No enabled RPC is configured for chain ${chainId}.`);
  const actualChainId = Number(BigInt(await evmJsonRpc(rpc, 'eth_chainId', [])));
  if (actualChainId !== chainId) {
    throw new Error(`Configured ${rpc.network} endpoint returned chain ${actualChainId}, expected ${chainId}.`);
  }
  const result = await evmJsonRpcValue(rpc, method, params);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

type IdentityVerificationRequest = {
  domain?: string;
  controllerWallet?: string;
  smartAccount?: string;
  chainId?: number;
  contractAddresses?: string[];
};

async function verifyIdentityEvidence(input: IdentityVerificationRequest) {
  const domain = String(input?.domain ?? '').trim().replace(/\.$/, '').toLowerCase();
  const controllerWallet = String(input?.controllerWallet ?? '').trim().toLowerCase();
  const smartAccount = String(input?.smartAccount ?? '').trim().toLowerCase();
  const expectedAddresses = new Set([controllerWallet, smartAccount].filter((value) => /^0x[0-9a-f]{40}$/.test(value)));
  const chainId = Number(input?.chainId ?? 1);
  const contracts = [...new Set((input?.contractAddresses ?? [])
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value)))]
    .slice(0, 8);

  const resolver = {
    state: 'unavailable' as 'verified' | 'mismatch' | 'unbound' | 'missing' | 'unavailable',
    address: '',
    resolvedAddress: '',
    detail: domain ? 'Resolver check has not completed.' : 'No public ENS identity is registered.',
  };
  if (domain && domain.endsWith('.eth')) {
    try {
      const resolverResult = await guardedEvmRead(1, 'eth_call', [{
        to: ENS_REGISTRY_ADDRESS,
        data: encodeEnsCall(ENS_RESOLVER_SELECTOR, domain),
      }, 'latest']);
      const resolverAddress = decodeAbiAddress(resolverResult);
      if (!resolverAddress) {
        resolver.state = 'missing';
        resolver.detail = `${domain} has no resolver in the Ethereum ENS registry.`;
      } else {
        resolver.address = resolverAddress;
        const resolverCode = await guardedEvmRead(1, 'eth_getCode', [resolverAddress, 'latest']);
        if (!hasRuntimeCode(resolverCode)) {
          resolver.state = 'missing';
          resolver.detail = `ENS returned ${resolverAddress}, but no resolver bytecode was found.`;
        } else {
          const addrResult = await guardedEvmRead(1, 'eth_call', [{
            to: resolverAddress,
            data: encodeEnsCall(ENS_ADDR_SELECTOR, domain),
          }, 'latest']);
          const resolvedAddress = decodeAbiAddress(addrResult);
          resolver.resolvedAddress = resolvedAddress ?? '';
          const binding = classifyEnsBinding(resolvedAddress, expectedAddresses);
          if (binding === 'missing') {
            resolver.state = 'missing';
            resolver.detail = `Resolver ${resolverAddress} is deployed, but ${domain} has no EVM address record.`;
          } else if (binding === 'mismatch') {
            resolver.state = 'mismatch';
            resolver.detail = `${domain} resolves to ${resolvedAddress}, which does not match the selected controller or Agent Safe.`;
          } else if (binding === 'unbound') {
            resolver.state = 'unbound';
            resolver.detail = `${domain} resolves to ${resolvedAddress}, but no selected controller or Agent Safe address is available to verify that binding.`;
          } else {
            resolver.state = 'verified';
            resolver.detail = `${domain} resolves through deployed resolver ${resolverAddress} to ${resolvedAddress}.`;
          }
        }
      }
    } catch (error) {
      resolver.state = 'unavailable';
      resolver.detail = `Live ENS verification unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (domain) {
    resolver.detail = `${domain} is not an Ethereum .eth name; no compatible live resolver contract is configured.`;
  }

  const contractEvidence = await Promise.all(contracts.map(async (address) => {
    try {
      const code = await guardedEvmRead(chainId, 'eth_getCode', [address, 'latest']);
      const deployed = hasRuntimeCode(code);
      return {
        address,
        state: deployed ? 'verified' as const : 'missing' as const,
        deployed,
        detail: deployed ? `Deployed runtime bytecode verified on chain ${chainId}.` : `No runtime bytecode on chain ${chainId}.`,
      };
    } catch (error) {
      return {
        address,
        state: 'unavailable' as const,
        deployed: false,
        detail: `Contract check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }));

  return { checkedAt: Date.now(), chainId, resolver, contracts: contractEvidence };
}

function configureKeyProviderFromSettings(settings = loadSettings().rootIdentity ?? defaultRootIdentitySettings()): void {
  const rootIdentity = configuredRootIdentity(settings);
  keyProviderConfigurationError = '';
  if (!rootIdentity) {
    configureKeyProvider(new MockKeyProvider());
    return;
  }
  try {
    configureKeyProvider(new SafeRolesKeyProvider({
      rootIdentity,
      statePath: () => join(configDir(resolveConfigPath()), 'safe-roles-state.json'),
      rpcRead: guardedEvmRead,
      ensureSigner: ensureAgentSigner,
      rotateSigner: rotateAgentSigner,
      inspectAssets: async (chainId, safeAddress) => {
        const rpc = evmRpcForChain(chainId);
        if (!rpc) throw new Error(`No enabled RPC is configured for chain ${chainId}.`);
        return inspectAlchemyAssets({
          rpcUrl: rpcUrlForRequest(rpc.httpsUrl, resolveEvmRpcKey(rpc)),
          safeAddress,
          chainId,
        });
      },
    }));
  } catch (error) {
    keyProviderConfigurationError = error instanceof Error ? error.message : String(error);
    configureKeyProvider(new MockKeyProvider());
    console.error(`[root-identity] live provider disabled: ${keyProviderConfigurationError}`);
  }
}

function currentRootIdentityStatus(): RootIdentityStatus {
  const settings = loadSettings().rootIdentity ?? defaultRootIdentitySettings();
  const configured = configuredRootIdentity(settings);
  return {
    settings,
    activeProvider: configured && !keyProviderConfigurationError ? 'safe-roles' : 'local',
    ...(keyProviderConfigurationError ? { error: keyProviderConfigurationError } : {}),
  };
}

function runtimeCodeHash(code: string): string {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('contract has no runtime bytecode');
  return `0x${Buffer.from(keccak_256(Buffer.from(code.slice(2), 'hex'))).toString('hex')}`;
}

async function verifySafeModuleManifest(rpc: EvmRpcProfile, chainId: number): Promise<{ ok: boolean; detail: string }> {
  const failures: string[] = [];
  for (const artifact of SAFE_MODULE_MANIFEST.artifacts) {
    const expected = artifact.runtimeCodeHashByChain[chainId];
    if (!expected) {
      failures.push(`${artifact.name}: no pinned chain ${chainId} hash`);
      continue;
    }
    try {
      const actual = runtimeCodeHash(await evmJsonRpc(rpc, 'eth_getCode', [artifact.address, 'latest']));
      if (actual.toLowerCase() !== expected.toLowerCase()) failures.push(`${artifact.name}: runtime hash mismatch`);
    } catch (error) {
      failures.push(`${artifact.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures.length
    ? { ok: false, detail: failures.join('; ') }
    : { ok: true, detail: `${SAFE_MODULE_MANIFEST.id}: ${SAFE_MODULE_MANIFEST.artifacts.length} runtime hashes match chain ${chainId}.` };
}

async function verifySafeRehearsal(): Promise<{ ok: boolean; detail: string }> {
  const loaded = readSafeRehearsalRecord();
  if (!loaded.record) return { ok: false, detail: loaded.error ?? 'No lifecycle evidence was found.' };
  if (loaded.record.moduleManifestId !== SAFE_MODULE_MANIFEST.id) {
    return { ok: false, detail: `Lifecycle evidence used ${loaded.record.moduleManifestId}, expected ${SAFE_MODULE_MANIFEST.id}.` };
  }
  const rpc = ethereumSepoliaRpc();
  if (!rpc) return { ok: false, detail: 'No enabled Ethereum Sepolia RPC is configured.' };
  try {
    const chainId = Number(BigInt(await evmJsonRpc(rpc, 'eth_chainId', [])));
    if (chainId !== loaded.record.chainId) throw new Error(`configured endpoint returned chain ${chainId}`);
    const moduleEvidence = await verifySafeModuleManifest(rpc, chainId);
    if (!moduleEvidence.ok) throw new Error(moduleEvidence.detail);
    for (const step of SAFE_REHEARSAL_STEPS) {
      const evidence = loaded.record.steps[step];
      if (evidence.kind !== 'transaction') continue;
      const result = await fetch(rpcUrlForRequest(rpc.httpsUrl, resolveEvmRpcKey(rpc)), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [evidence.txHash] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await result.json().catch(() => null) as { result?: { status?: string; blockHash?: string } | null; error?: { message?: string } } | null;
      if (!result.ok || body?.error || body?.result?.status !== '0x1' || !/^0x[0-9a-f]{64}$/i.test(body.result.blockHash ?? '')) {
        throw new Error(`${step} receipt is missing or unsuccessful`);
      }
    }
    return {
      ok: true,
      detail: `Verified ${SAFE_REHEARSAL_STEPS.length} Sepolia lifecycle steps for provider revision ${loaded.record.providerRevision}.`,
    };
  } catch (error) {
    return { ok: false, detail: `Sepolia lifecycle verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function keyProductionReadiness(): Promise<KeyProductionReadiness> {
  const checkedAt = Date.now();
  const caps = await bridgeCall('keys:caps', []) as KeyCapabilities;
  const settings = loadSettings();
  const rootStatus = currentRootIdentityStatus();
  const rootIdentity = configuredRootIdentity(settings.rootIdentity);
  const checks: KeyReadinessCheck[] = [];
  const rootIdentityActive = Boolean(rootIdentity && rootStatus.activeProvider === 'safe-roles');
  checks.push({
    id: 'root-identity',
    label: 'Profile root identity',
    status: rootIdentityActive ? 'pass' : 'block',
    detail: rootIdentityActive
      ? `${rootIdentity!.ensRoot} is explicitly bound to ${rootIdentity!.safeAddress} on chain ${rootIdentity!.chainId}.`
      : rootStatus.error || 'This profile is local/mock; no live ENS root or Safe address is enabled.',
    remediation: rootIdentityActive
      ? undefined
      : 'In Settings, manually enter and enable the ENS root and Safe address owned by this profile. No bundled identity is imported automatically.',
  });
  checks.push({
    id: 'live-provider',
    label: 'Live Safe provider',
    status: caps.live && caps.provider === 'safe-roles' && caps.authorityModel === 'zodiac-roles-v2' ? 'pass' : 'block',
    detail: caps.live
      ? `${caps.provider} is active on ${caps.chainLabel}.`
      : `${caps.provider} is simulation-only; it cannot deploy Safes or change authority.`,
    remediation: caps.live ? undefined : 'Install and configure the Safe 1.4.1 + Zodiac Roles live provider before provisioning.',
  });
  const signerVault = agentSignerVaultStatus();
  checks.push({
    id: 'signer-custody',
    label: 'Agent signer custody',
    status: signerVault.available ? 'pass' : 'block',
    detail: signerVault.available
      ? `${signerVault.backend} is available; ${signerVault.signerCount} encrypted agent signer(s) are present.`
      : signerVault.error ?? 'Agent signer encryption is unavailable.',
    remediation: signerVault.available ? undefined : 'Unlock or configure secure operating-system credential storage and retry. IDACC will not store plaintext agent keys.',
  });
  const walletConnect = settings.walletConnect ?? { enabled: false, projectId: '' };
  const connectorReady = walletConnect.enabled && /^[a-f0-9]{32}$/i.test(walletConnect.projectId);
  checks.push({
    id: 'root-connector',
    label: 'Root Safe connector',
    status: connectorReady ? 'pass' : 'block',
    detail: connectorReady ? 'WalletConnect is enabled with a valid public Reown project ID.' : 'Root Safe WalletConnect is not configured.',
    remediation: connectorReady ? undefined : 'Enable the root Safe connector in Settings and save a valid Reown project ID.',
  });

  const rpc = rootIdentity ? ethereumMainnetRpc() : undefined;
  if (!rpc || !rootIdentity) {
    checks.push({
      id: 'asset-inspection',
      label: 'Asset revocation guard',
      status: 'block',
      detail: rootIdentity
        ? 'Full asset inspection requires an enabled Ethereum mainnet Alchemy RPC.'
        : 'Asset inspection is unavailable until a profile root identity is explicitly enabled.',
      remediation: rootIdentity ? 'Configure the encrypted Alchemy RPC used for native, ERC-20, ERC-721, and ERC-1155 inspection.' : 'Configure the profile root identity first.',
    });
    checks.push({
      id: 'ethereum-rpc',
      label: 'Ethereum mainnet RPC',
      status: 'block',
      detail: rootIdentity ? 'No enabled Ethereum mainnet RPC is configured.' : 'No live root identity is enabled for an Ethereum RPC preflight.',
      remediation: rootIdentity ? 'Add and successfully check an Ethereum mainnet RPC in Settings.' : 'Configure the profile root identity first.',
    });
    checks.push({
      id: 'module-attestation',
      label: 'Pinned module bytecode',
      status: 'block',
      detail: 'Module runtime bytecode cannot be verified without Ethereum mainnet RPC access.',
      remediation: 'Add and successfully check an Ethereum mainnet RPC in Settings.',
    });
    checks.push({
      id: 'root-safe-contract',
      label: 'Root Safe contract',
      status: 'block',
      detail: 'Root Safe bytecode, owners, and threshold cannot be verified without Ethereum mainnet RPC access.',
    });
  } else {
    try {
      const chainId = Number(BigInt(await evmJsonRpc(rpc, 'eth_chainId', [])));
      if (chainId !== 1) throw new Error(`configured endpoint returned chain ${chainId}, expected Ethereum mainnet (1)`);
      checks.push({ id: 'ethereum-rpc', label: 'Ethereum mainnet RPC', status: 'pass', detail: `${rpc.network} returned chain 1.` });
    } catch (error) {
      checks.push({
        id: 'ethereum-rpc',
        label: 'Ethereum mainnet RPC',
        status: 'block',
        detail: `Production preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        remediation: 'Check the Ethereum mainnet endpoint and retry production readiness.',
      });
    }
    if (checks.at(-1)?.id === 'ethereum-rpc' && checks.at(-1)?.status === 'pass') {
      const assets = await inspectAlchemyAssets({
        rpcUrl: rpcUrlForRequest(rpc.httpsUrl, resolveEvmRpcKey(rpc)),
        safeAddress: rootIdentity.safeAddress,
        chainId: rootIdentity.chainId,
      });
      checks.push({
        id: 'asset-inspection',
        label: 'Asset revocation guard',
        status: assets.status === 'unknown' ? 'block' : 'pass',
        detail: assets.message,
        remediation: assets.status === 'unknown' ? 'Fix the configured Alchemy Token/NFT API access; revocation remains fail-closed.' : undefined,
      });
      const moduleEvidence = await verifySafeModuleManifest(rpc, 1);
      checks.push({
        id: 'module-attestation',
        label: 'Pinned module bytecode',
        status: moduleEvidence.ok ? 'pass' : 'block',
        detail: moduleEvidence.detail,
        remediation: moduleEvidence.ok ? undefined : 'Do not use the module stack until every deployed runtime matches the pinned manifest.',
      });
      try {
        const code = await evmJsonRpc(rpc, 'eth_getCode', [rootIdentity.safeAddress, 'latest']);
        if (!/^0x[0-9a-f]{40,}$/i.test(code)) throw new Error('root address has no verified contract bytecode');
        const owners = decodeAbiAddressArray(await evmJsonRpc(rpc, 'eth_call', [{ to: rootIdentity.safeAddress, data: '0xa0e67e2b' }, 'latest']));
        const threshold = Number(decodeAbiUint(await evmJsonRpc(rpc, 'eth_call', [{ to: rootIdentity.safeAddress, data: '0xe75235b8' }, 'latest'])));
        const hardened = owners.length >= 2 && threshold >= 2;
        checks.push({
          id: 'root-safe-contract',
          label: 'Root Safe contract',
          status: hardened ? 'pass' : 'block',
          detail: `Verified Safe proxy at ${rootIdentity.safeAddress}: ${owners.length} owners, threshold ${threshold}.`,
          remediation: hardened ? undefined : 'Raise the root Safe threshold to at least 2 before it can authorize independent agent Safes.',
        });
      } catch (error) {
        checks.push({
          id: 'root-safe-contract',
          label: 'Root Safe contract',
          status: 'block',
          detail: `Root Safe verification failed: ${error instanceof Error ? error.message : String(error)}`,
          remediation: 'Verify the configured root Safe address and retry production readiness.',
        });
      }
    } else {
      checks.push({
        id: 'asset-inspection',
        label: 'Asset revocation guard',
        status: 'block',
        detail: 'Full asset inspection was not attempted because Ethereum RPC preflight failed.',
        remediation: 'Fix the configured Ethereum mainnet Alchemy RPC and retry.',
      });
      checks.push({
        id: 'module-attestation',
        label: 'Pinned module bytecode',
        status: 'block',
        detail: 'Module runtime bytecode was not verified because Ethereum RPC preflight failed.',
      });
      checks.push({
        id: 'root-safe-contract',
        label: 'Root Safe contract',
        status: 'block',
        detail: 'Root Safe bytecode, owners, and threshold were not verified because Ethereum RPC preflight failed.',
      });
    }
  }

  const authorityStable = SAFE_MODULE_MANIFEST.stability === 'stable';
  checks.push({
    id: 'authority-module-stability',
    label: 'Authority module production status',
    status: authorityStable ? 'pass' : 'block',
    detail: `${SAFE_MODULE_MANIFEST.authority.package} ${SAFE_MODULE_MANIFEST.authority.sdkVersion} / Roles ${SAFE_MODULE_MANIFEST.authority.contractVersion} is pinned to the audited ${SAFE_MODULE_MANIFEST.architecture} profile.`,
    remediation: authorityStable ? undefined : 'Keep live autonomous authority disabled until an independently audited stable authority module is active.',
  });

  const rehearsal = await verifySafeRehearsal();
  checks.push({
    id: 'testnet-rehearsal',
    label: 'Testnet rehearsal',
    status: rehearsal.ok ? 'pass' : 'block',
    detail: rehearsal.detail,
    remediation: rehearsal.ok ? undefined : 'Complete create, scoped action, rotation, asset inspection, and revoke on Sepolia; save the public evidence record and retry.',
  });
  return {
    ready: checks.every((check) => check.status !== 'block'),
    checkedAt,
    chainId: rootIdentity?.chainId ?? 1,
    rootSafe: rootIdentity?.safeAddress ?? '',
    provider: caps.provider,
    checks,
  };
}

// --- window state: reopen the app where/how the user left it ---
interface WinState { x?: number; y?: number; width: number; height: number; fullScreen?: boolean }
function winStatePath(): string {
  return join(privateUserDataDirectory(), 'window-state.json');
}
function loadWinState(): WinState {
  try {
    const s = JSON.parse(readPrivateAppTextFile(winStatePath())) as WinState;
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch { /* first run / corrupt → defaults */ }
  return { width: 1180, height: 780 };
}
function saveWinState(w: BrowserWindow): void {
  try {
    if (w.isDestroyed()) return;
    // Persist the ACTUAL on-screen bounds so the window reopens exactly where/how it was —
    // including when it was zoomed/"maximized" (those bounds already fill the work area). The
    // old approach saved getNormalBounds() + an isMaximized() flag and re-ran maximize() on
    // launch, but on macOS isMaximized()≈zoom false-positives on a big manually-sized window,
    // so the app kept reopening zoomed instead of at the user's real position. For true
    // macOS fullscreen we save the pre-fullscreen bounds and re-enter fullscreen on restore.
    const fullScreen = w.isFullScreen();
    const b = fullScreen ? w.getNormalBounds() : w.getBounds();
    const path = winStatePath();
    writePrivateAppTextFileInPlace(
      path,
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, fullScreen }),
    );
  } catch { /* best-effort */ }
}
/** Only restore a saved position if a usable chunk of the titlebar lands on some
 *  display — otherwise (display unplugged / resolution changed) center via defaults. */
function isOnScreen(s: WinState): boolean {
  if (typeof s.x !== 'number' || typeof s.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x! + Math.min(s.width, 200) > a.x && s.x! < a.x + a.width && s.y! + 30 > a.y && s.y! < a.y + a.height;
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const st = loadWinState();
  const placeAt = isOnScreen(st) && typeof st.x === 'number' && typeof st.y === 'number';
  const target = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(placeAt ? { x: st.x, y: st.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'ID Agents Control Center',
    backgroundColor: '#0e1116',
    // hiddenInset is a macOS-only frame treatment. Windows and Linux keep
    // their native title bar so minimize, maximize, and close remain present.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: !rendererSafeMode, // safe mode favors stability over text-service integrations
    },
  });
  win = target;

  if (st.fullScreen) win.setFullScreen(true);
  // Persist geometry (debounced on move/resize; immediate on close + before-quit) so the next
  // launch — including after a self-update relaunch — reopens at the same size/position.
  let saveT: ReturnType<typeof setTimeout> | null = null;
  const saveNow = () => {
    if (saveT) { clearTimeout(saveT); saveT = null; }
    if (!appShutdown.isQuiescing() && win) saveWinState(win);
  };
  const scheduleSave = () => {
    if (appShutdown.isQuiescing()) return;
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(saveNow, 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', saveNow);
  win.webContents.on('render-process-gone', (_event, details) => {
    logProcessExit('renderer', details as unknown as Record<string, unknown>);
    let crashState: RendererCrashState | null = null;
    if (details.reason === 'crashed' || details.reason === 'oom') {
      crashState = recordRendererCrash(details);
      if (!rendererSafeMode) {
        void appShutdown.request({ kind: 'relaunch' });
        return;
      }
    }
    if (win && !win.isDestroyed()) scheduleRendererRecovery(win, details, crashState);
  });
  win.webContents.on('did-finish-load', () => scheduleRendererStableReset());

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    openExternalHttpUrl(url);
  });

  // Right-click menu: spelling corrections for a misspelled word, plus the
  // standard edit actions — so highlighted chat text (output included) can be
  // copied and the composer's flagged words can be fixed.
  win.webContents.on('context-menu', (_e, params) => {
    const wc = win?.webContents;
    if (!wc) return;
    const menu = new Menu();
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      for (const s of suggestions) menu.append(new MenuItem({ label: s, click: () => wc.replaceMisspelling(s) }));
      if (suggestions.length === 0) menu.append(new MenuItem({ label: 'No suggestions', enabled: false }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    const editable = params.isEditable;
    const hasSelection = params.selectionText.trim().length > 0;
    if (editable) menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
    if (editable || hasSelection) menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
    if (editable) menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
    if (editable || hasSelection) menu.append(new MenuItem({ role: 'selectAll' }));
    if (menu.items.length > 0) menu.popup({ window: win ?? undefined });
  });

  const initialRendererLoad = loadRendererApp(win);

  // Verification hook: with IDCTL_SHOT=<path>, capture the rendered window once
  // data has loaded, write a PNG, and quit. Lets the build be proven headlessly.
  const shot = process.env.IDCTL_SHOT;
  if (shot) {
    // Optional: scroll before capturing so sections below the fold can be
    // verified headlessly. 'bottom' or a CSS selector / text fragment.
    const shotScroll = process.env.IDCTL_SHOT_SCROLL;
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (shotScroll) {
            const js = shotScroll === 'bottom'
              ? 'window.scrollTo(0, document.body.scrollHeight)'
              : `(${((sel: string) => {
                  const bySel = document.querySelector(sel);
                  if (bySel) { bySel.scrollIntoView({ block: 'start' }); return; }
                  const el = [...document.querySelectorAll('h2,h3,section,.card')]
                    .find((n) => (n.textContent || '').toLowerCase().includes(sel.toLowerCase()));
                  el?.scrollIntoView({ block: 'start' });
                }).toString()})(${JSON.stringify(shotScroll)})`;
            await win!.webContents.executeJavaScript(js);
            await new Promise((r) => setTimeout(r, 350));
          }
          // Optional: click a control (by CSS selector or button text) and wait,
          // so async UI (e.g. a discovery scan) can be captured headlessly.
          const shotClick = process.env.IDCTL_SHOT_CLICK;
          if (shotClick) {
            // Pipe-separated sequence: click each (by CSS selector or button text)
            // with a gap between — lets navigation flows be exercised headlessly.
            for (const sel of shotClick.split('|')) {
              const clickJs = `(${((s: string) => {
                let bySel: Element | null = null;
                try { bySel = document.querySelector(s); } catch { /* treat as button text */ }
                const el = bySel || [...document.querySelectorAll('button')]
                  .find((b) => (b.textContent || '').toLowerCase().includes(s.toLowerCase()));
                if (el instanceof HTMLElement) el.click();
                return !!el;
              }).toString()})(${JSON.stringify(sel)})`;
              await win!.webContents.executeJavaScript(clickJs);
              await new Promise((r) => setTimeout(r, 500));
            }
            await new Promise((r) => setTimeout(r, Number(process.env.IDCTL_SHOT_CLICK_WAIT) || 2000));
          }
          const img = await win!.webContents.capturePage();
          await import('node:fs').then((fs) => fs.writeFileSync(shot, img.toPNG()));
        } catch (err) {
          console.error('screenshot failed:', err);
        }
        void appShutdown.request({ kind: 'quit' });
      }, 3500);
    });
  }
  await initialRendererLoad;
  if (pendingSecondInstanceFocus) focusPrimaryConsumerWindow();
  return target;
}

async function archiveScheduledDreams(team: string): Promise<{ archived: number; discovered: number }> {
  const feed = await bridgeCall('dreams:scheduledRuns', [team]) as {
    schedules?: ScheduleEntry[];
    newsByAgent?: Record<string, ScheduledDreamNewsItem[]>;
  };
  const candidates = scheduledDreamArchives(
    Array.isArray(feed?.schedules) ? feed.schedules : [],
    feed?.newsByAgent && typeof feed.newsByAgent === 'object' ? feed.newsByAgent : {},
    team,
  );
  let archived = 0;
  for (const candidate of candidates) {
    if (getDream(candidate.id)) continue;
    saveDream(candidate);
    archived++;
  }
  return { archived, discovered: candidates.length };
}

async function archiveAllScheduledDreams(): Promise<number> {
  const teams = await bridgeCall('teams', []).catch(() => []) as Array<{ name?: string }>;
  const names = [...new Set((teams.length ? teams : [{ name: 'default' }])
    .map((team) => String(team.name || '').trim())
    .filter(Boolean))];
  let archived = 0;
  for (const team of names) {
    archived += (await archiveScheduledDreams(team).catch(() => ({ archived: 0, discovered: 0 }))).archived;
  }
  if (archived > 0) publishStoreChange('dreams:archiveScheduled');
  return archived;
}

function startScheduledDreamArchiveLoop(): () => Promise<void> {
  const gate = createSingleFlightBackgroundGate();
  const run = (): Promise<void> => gate.run(async () => {
    await archiveAllScheduledDreams();
  });
  const initial = setTimeout(() => void run(), 5_000);
  const interval = setInterval(() => void run(), 5 * 60 * 1000);
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
    return gate.stop();
  };
}

// App-level (main-process) methods that don't go through the manager bridge.
async function appCall(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'app:version':
      return app.getVersion();
    case 'update:status':
      return getStatus();
    case 'update:check':
      return beginUpdateCheck();
    case 'update:download':
      return beginUpdateDownload();
    case 'update:applyNow':
      {
        const applying = prepareStagedUpdateInstall();
        if (applying) void appShutdown.request({ kind: 'install-update' });
        return { applying };
      }
    case 'update:getSettings':
      return loadSettings().update ?? null;
    case 'update:setSettings':
      return setUpdateSettings((args[0] as Record<string, unknown>) ?? {}).update ?? null;
    case 'brainAutomation:getSettings':
      return loadSettings().brainAutomation ?? null;
    case 'brainAutomation:setSettings':
      {
        const next = setBrainAutomationSettings(
          (args[0] as Partial<BrainAutomationSettings>) ?? {},
        ).brainAutomation;
        if (next) await configureUnifiedBrainAutomation(next);
        return next ?? null;
      }
    case 'evmRpc:list':
      return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
    case 'evmRpc:save':
      {
        const input = (args[0] as EvmRpcProfile) ?? {};
        const apiKeyInput = typeof (input as any).apiKey === 'string' ? (input as any).apiKey.trim() : '';
        const normalized = normalizeRpcForStorage(input.httpsUrl ?? '', apiKeyInput);
        const apiKeyEncrypted = normalized.apiKey ? encryptSecret(normalized.apiKey) : input.apiKeyEncrypted;
        const rpc: EvmRpcProfile = {
          ...input,
          httpsUrl: normalized.httpsUrl,
          apiKey: undefined,
          apiKeyEncrypted,
        };
        validateEvmRpcInput(rpc);
        upsertEvmRpc(rpc);
        return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
      }
    case 'evmRpc:remove':
      removeEvmRpc(String(args[0] ?? ''));
      return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
    case 'evmRpc:probe':
      return probeEvmRpc(String(args[0] ?? ''));
    case 'evmRpc:read':
      return guardedEvmRead(Number(args[0]), String(args[1] ?? ''), Array.isArray(args[2]) ? args[2] : []);
    case 'identity:verifyEvidence':
      return verifyIdentityEvidence((args[0] as IdentityVerificationRequest) ?? {});
    case 'rootIdentity:get':
      return currentRootIdentityStatus();
    case 'rootIdentity:set': {
      const cfg = setRootIdentitySettings((args[0] as Partial<RootIdentitySettings>) ?? {});
      configureKeyProviderFromSettings(cfg.rootIdentity);
      return currentRootIdentityStatus();
    }
    case 'walletConnect:get':
      return loadSettings().walletConnect ?? { enabled: false, projectId: '' };
    case 'walletConnect:set':
      return setWalletConnectSettings((args[0] as Record<string, unknown>) ?? {}).walletConnect;
    case 'keys:productionReadiness':
      return keyProductionReadiness();
    case 'subs:status':
      return subsStatus(
        args[0] && typeof args[0] === 'object'
          ? args[0] as SubsStatusOptions
          : { force: Boolean(args[0]) },
      );
    case 'subs:assignmentStatus':
      return assignmentSubsStatus(
        args[0] && typeof args[0] === 'object'
          ? args[0] as SubsStatusOptions
          : { force: Boolean(args[0]) },
      );
    case 'subs:cachedStatus':
      return cachedSubsStatus() ?? {};
    case 'subs:signin':
      invalidateSubsStatusCache();
      return subsSignin(args[0] as SubProvider);
    case 'subs:signout':
      invalidateSubsStatusCache();
      return subsSignout(args[0] as SubProvider).finally(() => invalidateSubsStatusCache());
    case 'subs:install':
      invalidateSubsStatusCache();
      return subsInstall(args[0] as SubProvider);
    case 'ollama:tags':
      return ollamaTags();
    case 'ollama:pull':
      return ollamaPull(args[0] as string);
    case 'ollama:remove':
      return ollamaRemove(args[0] as string);
    case 'ollama:catalogCheck':
      {
        const result = await ollamaCatalogCheck(Array.isArray(args[0]) ? args[0] as InstalledModelInput[] : [], Array.isArray(args[1]) ? args[1] as string[] : []);
        let savedModels = listLocalModelCatalog();
        if (result.newModels.length) {
          const now = Date.now();
          savedModels = mergeLocalModelCatalog(result.newModels.map((m) => catalogModelToLocalEntry(m, now))).localModelCatalog ?? [];
        }
        return { ...result, savedModels, savedCount: result.newModels.length };
      }
    case 'ollama:localCatalog':
      return listLocalModelCatalog();
    case 'app:hardware':
      return getHardware();
    case 'stack:installStatus':
      return localStackInstallStatus(Array.isArray(args[0]) ? args[0] as string[] : [], { force: Boolean(args[1]) });
    case 'stack:backgroundStatus':
      return backgroundStackStatus(Array.isArray(args[0]) ? args[0] as string[] : []);
    case 'stack:startBackground':
      return startBackgroundStack(args[0], args[1], appProfilePaths().logs);
    case 'stack:stopBackground':
      return stopBackgroundStack(args[0]);
    case 'stack:dockerStatus':
      return dockerStatus();
    case 'unifiedStack:status':
      return unifiedStackStatus();
    case 'onboarding:status':
      return consumerOnboardingStatus((args[0] as { force?: boolean } | undefined) ?? {});
    case 'onboarding:configureProvider':
      return configureOnboardingProvider(args[0] as Parameters<typeof configureOnboardingProvider>[0]);
    case 'onboarding:runStarterFleet':
      return runStarterFleetOnboarding(args[0]);
    case 'onboarding:defer':
      return deferConsumerOnboarding();
    case 'onboarding:resume':
      return resumeConsumerOnboarding();
    case 'brain:openDashboard':
      return openBrainDashboard(args[0]);
    case 'brain:openGraph':
      return openBrainDashboard('graph');
    case 'project:pickFolder':
      return pickProjectFolder(args[0] as string | undefined);
    case 'project:openFolder':
      return openProjectFolder(args[0] as string);
    case 'project:readme':
      return projectReadme(args[0] as string);
    case 'project:git':
      return projectGit(args[0] as string);
    case 'project:gitRun':
      return projectGitRun(args[0] as string, args[1] as string);
    case 'project:githubMeta':
      return githubMeta(args[0] as string);
    case 'project:cloneGithub':
      return cloneGithub(args[0] as string, args[1] as string);
    case 'project:diff':
      return projectDiff(args[0] as string);
    case 'project:createRepo':
      return createGithubRepo(args[0] as string, (args[1] as { name?: string; description?: string; private?: boolean }) ?? {});
    case 'project:linkRepo':
      return linkGithubRepo(args[0] as string, args[1] as string);
    case 'project:commit':
      return commitProject(args[0] as string, args[1] as string);
    case 'project:fork':
      return forkGithub(args[0] as string, args[1] as string);
    case 'project:detectRoot':
      return detectProjectsRoot(args[0] as string | undefined);
    case 'project:scanRoot':
      return scanProjectsRoot(args[0] as string);
    case 'chat:pickFiles':
      return pickChatFiles();
    case 'chat:saveFiles':
      return saveChatFiles(args[0] as string, args[1] as string[]);
    case 'chat:savePasted':
      return savePastedFile(args[0] as string, args[1] as string);
    case 'chats:list':
      return listChats(args[0] as string | undefined);
    case 'chats:inflight':
      return listInflightChats(args[0] as string | undefined);
    case 'chats:get':
      return getChat(args[0] as string);
    case 'chats:save':
      return saveChat(args[0] as ChatSession);
    case 'chats:rename':
      return renameChat(args[0] as string, args[1] as string);
    case 'chats:remove':
      return removeChat(args[0] as string);
    case 'chats:unreadCount':
      return unreadChatCount(args[0] as string | undefined);
    case 'chats:markRead':
      return markChatRead(args[0] as string);
    case 'chats:patch':
      return patchChat(args[0] as string, (args[1] as ChatPatch) ?? {});
    case 'chat:genTitle':
      return genTitle(args[0] as string);
    case 'chat:genReason':
      return genReason(args[0] as string);
    case 'plans:list':
      await convertLearnTaskDraftPlans();
      return listPlans(args[0] as string | undefined);
    case 'plans:get':
      return getPlan(args[0] as string);
    case 'plans:save':
      return savePlan(args[0] as Plan);
    case 'plans:remove':
      return removePlan(args[0] as string);
    case 'plans:recover':
      return recoverPlanFromInbox((args[0] as PlanRecoverInput | undefined) ?? {});
    // Goals: saved per-project goals (goalstore).
    case 'goals:list':
      return listGoals(args[0] as string | undefined, (args[1] as { includePlanObjectives?: boolean } | undefined) ?? {});
    case 'goals:get':
      return getGoal(args[0] as string);
    case 'goals:save': {
      const goal = args[0] as Goal;
      const result = saveGoal(goal);
      await syncGoalInstructionsAfterMutation('save');
      kickGoalDriverAfterMutation(goal, 'save');
      return result;
    }
    case 'goals:remove': {
      const result = removeGoal(args[0] as string);
      await syncGoalInstructionsAfterMutation('remove');
      return result;
    }
    // Brain Plans live in the active app profile. A legacy project checkout is
    // consulted only by the one-time, read-only import in brainplans.ts.
    case 'brain:plans':
      return listBrainPlans(args[0] as string | undefined);
    case 'brain:plan':
      return getBrainPlan(args[0] as string, args[1] as string | undefined);
    case 'brain:setPlanStatus':
      return setBrainPlanStatus(
        args[0] as string,
        args[1] as string,
        args[2] == null ? undefined : String(args[2]),
        args[3] as { status?: string; mtime?: number } | undefined,
      );
    case 'brain:createPlan':
      return createBrainPlan(args[0] as string, args[1] as string, args[2] as string | undefined);
    // Loops: saved sequential agent→task chains (definition + last-run results).
    case 'loops:list':
      return listLoops(args[0] as string | undefined);
    case 'loops:get':
      return getLoop(args[0] as string);
    case 'loops:save':
      return saveLoop(args[0] as Loop);
    case 'loops:remove':
      return removeLoop(args[0] as string);
    // Dreams: saved offline-reflection reports (consolidation/insights/ideas/simulations).
    case 'dreams:list':
      return listDreams(args[0] as string | undefined);
    case 'dreams:archiveScheduled': {
      const team = String(args[0] || 'default');
      const result = await archiveScheduledDreams(team);
      if (result.archived > 0) publishStoreChange('dreams:archiveScheduled');
      return result;
    }
    case 'dreams:get':
      return getDream(args[0] as string);
    case 'dreams:save':
      return saveDream(args[0] as Dream);
    case 'dreams:remove':
      return removeDream(args[0] as string);
    // Blocker-question queue (app-side; shown in the Inbox with options).
    case 'questions:list':
      await syncBrainApprovalInbox();
      return listQuestions(args[0] as string | undefined);
    case 'questions:add':
      return addQuestion(args[0] as BlockerQuestion);
    case 'questions:remove':
      return removeQuestion(args[0] as string);
    case 'brainApprovals:syncInbox':
      return syncBrainApprovalInbox({ force: true, limit: Number(args[0] ?? 100) });
    case 'brainApproval:resolve':
      return resolveBrainApprovalFromInbox(args[0], args[1], args[2]);
    // Learn materials: Work > Learn queue, guarded extraction, active-goal comparison, review gates.
    case 'materials:list':
      return listMaterials();
    case 'materials:get':
      return getMaterial(args[0] as string);
    case 'materials:save': {
      const result = saveMaterial(args[0] as CreateMaterialInput | LearnMaterial);
      kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
      return result;
    }
    case 'materials:remove':
      return removeMaterial(args[0] as string);
    case 'materials:pickFiles':
      return pickMaterialFiles();
    case 'materials:pickFolder':
      return pickMaterialFolder();
    case 'materials:importFiles': {
      const result = importMaterialFiles(
        Array.isArray(args[0]) ? args[0].map(String) : [],
        (args[1] as { priority?: LearnPriority; prioritized?: boolean } | undefined) ?? {},
      );
      kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
      return result;
    }
    case 'materials:priority': {
      const result = updateMaterialPriority(args[0] as string, args[1] as LearnPriority, args[2] as boolean | undefined);
      if (result.status === 'queued') kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.queuedWriteKickMs);
      if (result.status === 'ready' || result.status === 'blocked') kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs);
      return result;
    }
    case 'materials:processNext': {
      const result = await processNextMaterial((args[0] as ProcessMaterialContext | undefined) ?? {});
      if (result && (result.status === 'ready' || result.status === 'blocked')) kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs);
      kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
      return result;
    }
    case 'materials:process': {
      const result = await processMaterial(args[0] as string, (args[1] as ProcessMaterialContext | undefined) ?? {});
      if (result.status === 'ready' || result.status === 'blocked') kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs);
      kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
      return result;
    }
    case 'materials:recoverStale': {
      const result = recoverStaleMaterials();
      kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
      return result;
    }
    case 'materials:syncBrain':
      return syncUnsyncedMaterialsToBrain({
        limit: Number(args[0] ?? 2),
        retryMs: Number(args[1] ?? undefined),
      });
    case 'materials:autoCreateTasks':
      return autoCreatePendingLearnTasks({ limit: Number(args[0] ?? 6) });
    case 'materials:routeLeads':
      return routePendingLearnMaterials({ limit: Number(args[0] ?? 3), retryMs: Number(args[1] ?? undefined) });
    case 'materials:markRecommendation': {
      const result = await markRecommendation(args[0] as string, args[1] as string, args[2] as LearnReviewState);
      kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialReadyKickMs);
      return result;
    }
    case 'image:generate':
      return generateImage(args[0] as string, args[1] as string | undefined);
    case 'image:read':
      return readImage(args[0] as string);
    case 'image:models':
      return imageModels();
    case 'image:getServer':
      return getImageServer();
    case 'image:setServer':
      return setImageServer((args[0] as ImageServerConfig | null) ?? null).imageServer ?? null;
    case 'image:detectServer':
      return detectImageServer();
    case 'image:probeServer':
      return probeImageServer((args[0] as ImageServerConfig | null | undefined) ?? undefined);
    case 'app:runInTerminal':
      return runInTerminal(args[0] as string);
    // Computer Use (broker + macOS permissions live in the Electron main process)
    case 'cu:status':
      return brokerStatus();
    case 'cu:arm':
      return armComputerUseFromCurrentAttached(args[0], args[1]);
    case 'cu:disarm':
      return disarmBroker();
    case 'cu:watch':
      return setWatching(Boolean(args[0]));
    case 'cu:setDisplay':
      return setBrokerDisplay(Number(args[0]));
    case 'cu:audit':
      return auditTail(args[0] as number | undefined);
    case 'cu:panic':
      return panicBroker();
    case 'cu:setSupervised':
      return setSupervised(Boolean(args[0]));
    case 'cu:pause':
      return setPaused(Boolean(args[0]));
    case 'cu:confirm':
      return confirmAction(args[0] as string, Boolean(args[1]));
    case 'cu:pending':
      return pendingActions();
    case 'cu:permissions':
      return getPermissions();
    case 'cu:legacyAuthority':
      return legacyAgentTokenReport((args[0] as { name: string; team?: string }[] | undefined) ?? []);
    case 'cu:openPermission':
      return openPermissionSettings(args[0] as CuPermissionPane);
    case 'cu:relaunch':
      void appShutdown.request({ kind: 'relaunch' });
      return { ok: true };
    default:
      return bridgeCall(method, args);
  }
}

if (ownsSingleInstanceLock) {
  // Single IPC entry point → app methods + allowlisted bridge methods.
  ipcMain.handle('idagents:call', async (event, method: string, args: unknown[]) => {
    try {
      requireTrustedIpcSender(event);
      if (appShutdown.isQuiescing()) {
        throw new Error('IDACC is shutting down and cannot accept new requests.');
      }
      const finishIpcCall = activeIpcWork.begin();
      try {
        const result = await appCall(method, args);
        const safeResult = sanitizeSecretPayload(result);
        if (!appShutdown.isQuiescing()) {
          // Mirror successful control actions to the self-learning brain (best-effort,
          // fire-and-forget). Once shutdown starts, do not create fresh learning,
          // audit, or renderer-sync work behind the cleanup barrier.
          const safeArgs = sanitizeSecretPayload(Array.isArray(args) ? args : []);
          recordControlAction(method, safeArgs, safeResult);
          publishStoreChange(method);
        }
        return { ok: true, result: safeResult };
      } finally {
        finishIpcCall();
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Write-only clipboard channel for user-invoked copy actions. Keep this separate
  // from idagents:call so copied communication text never enters the control log.
  ipcMain.handle('idagents:clipboardWrite', (event, value: unknown) => {
    requireTrustedIpcSender(event);
    if (appShutdown.isQuiescing()) {
      throw new Error('IDACC is shutting down and cannot accept new requests.');
    }
    clipboard.writeText(String(value ?? ''));
    return true;
  });
}

// Headless self-test of the update flow (no window). IDCTL_UPDATE_SELFTEST=
//   check → run a manifest check, print status, quit.
//   apply → check, then swap the staged bundle in place (IDCTL_UPDATE_NOOPEN
//           skips the relaunch) so the swap can be verified.
// Headless self-test of the Computer Use broker (no real window interaction):
// arm the broker, hit its loopback /action screenshot endpoint with the token,
// print whether a real frame came back, then quit. Verifies capture + auth + arm.
// Dev-only (never in the packaged app) so the shipped build can't be coaxed into
// serving screenshots headlessly via an env var.
const cuSelftest = !app.isPackaged && process.env.IDCTL_CU_SELFTEST;
if (ownsSingleInstanceLock && cuSelftest) {
  setTimeout(() => {
    console.log('CU_SELFTEST_TIMEOUT');
    void appShutdown.request({ kind: 'exit', code: 1 });
  }, 15000).unref?.();
  app.whenReady().then(async () => {
    await startBroker(() => {});
    setWatching(true);
    armBroker(['selftest']);
    setSupervised(false); // headless: no UI to approve, so test the raw input path
    const st = brokerStatus();
    try {
      const tok = mintAgentToken('selftest'); // per-agent token (the broker now authenticates by token)
      const url = brokerUrl();
      const post = (b: Record<string, unknown>) => fetch(`${url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(b) }).then((r) => r.json());
      const shot = await post({ type: 'screenshot' }) as { ok?: boolean; image?: string; width?: number; height?: number; reason?: string };
      // Then exercise the INPUT path (mouse_move). If Accessibility is granted it
      // executes (real move); otherwise it's correctly blocked — both prove the gate.
      const mv = await post({ type: 'mouse_move', x: Math.round((shot.width || 100) / 2), y: Math.round((shot.height || 100) / 2) }) as { ok?: boolean; detail?: string; reason?: string };
      // Supervised round-trip: re-enable supervised, fire an action (held), approve it, confirm it executes.
      setSupervised(true);
      const held = post({ type: 'left_click', x: 10, y: 10 }) as Promise<{ ok?: boolean; reason?: string }>;
      await new Promise((r) => setTimeout(r, 500));
      const pend = pendingActions();
      if (pend.length) confirmAction(pend[0].id, true);
      const heldRes = await held;
      // Classifier: in AUTONOMOUS mode a normal move auto-executes, but a dangerous
      // typed command is HELD. Deny the risky one (never executes).
      setSupervised(false);
      const normal = await post({ type: 'mouse_move', x: 20, y: 20 }) as { ok?: boolean };
      const risky = post({ type: 'type', text: 'sudo rm -rf /tmp/x' }) as Promise<{ ok?: boolean; reason?: string }>;
      await new Promise((r) => setTimeout(r, 400));
      const riskyPend = pendingActions();
      if (riskyPend.length) confirmAction(riskyPend[0].id, false);
      const riskyRes = await risky;
      console.log('CU_SELFTEST ' + JSON.stringify({ port: st.port, shotOk: shot.ok, imageBytes: shot.image ? Buffer.from(shot.image, 'base64').length : 0, width: shot.width, height: shot.height, driverOk: st.driverOk, accessibility: st.accessibility, moveOk: mv.ok, moveDetail: mv.detail, moveReason: mv.reason, supervisedHeld: pend.length, supervisedApprovedOk: heldRes.ok, autoNormalOk: normal.ok, autoRiskyHeld: riskyPend.length, autoRiskyDenied: riskyRes.reason === 'declined' }));
    } catch (e) {
      console.log('CU_SELFTEST_ERR ' + (e instanceof Error ? e.message : String(e)));
    }
    void appShutdown.request({ kind: 'quit' });
  });
}

// Read-only driver probe (safe in packaged builds): report whether the native
// input addon loads + the current mouse position, then quit. No synthetic input.
const driverProbe = process.env.IDCTL_CU_DRIVERPROBE;
const selftest = process.env.IDCTL_UPDATE_SELFTEST;
const stackSelftest = process.env.IDACC_STACK_SELFTEST;
if (!ownsSingleInstanceLock) {
  // The shutdown request was issued immediately after the lock attempt. The
  // secondary process deliberately performs no ready/startup/profile work.
} else if (cuSelftest) { /* handled above */ } else if (driverProbe) {
  app.whenReady().then(() => {
    console.log('CU_DRIVER ' + JSON.stringify({ cap: driverCapability(), mouse: getMousePos() }));
    void appShutdown.request({ kind: 'exit', code: 0 });
  });
} else if (selftest) {
  app.whenReady().then(async () => {
    await checkForUpdate();
    // Automatic downloads are deliberately detached from the metadata check
    // so renderer IPC never stays open for a large transfer. The self-test,
    // however, must wait for all updater-owned work before inspecting whether
    // the verified artifact is staged and eligible to install.
    await drainUpdater();
    const st = getStatus();
    console.log('SELFTEST_STATUS ' + JSON.stringify(st));
    if (selftest === 'apply' && st.staged) {
      const applied = prepareStagedUpdateInstall();
      console.log('SELFTEST_APPLY ' + applied);
      if (applied) void appShutdown.request({ kind: 'install-update' });
    } else {
      void appShutdown.request({ kind: 'quit' });
    }
  });
} else if (stackSelftest) {
  app.whenReady().then(async () => {
    const profile = initializeAppProfile();
    let status: Awaited<ReturnType<typeof unifiedStackStatus>> = {
      managed: false,
      services: [],
      companions: [],
      brainCatalog: {
        healthy: false,
        profileOwned: false,
        skillCount: 0,
        error: 'stack has not started',
      },
      managerCompatibility: {
        ready: false,
        apiVersion: 0,
        missingFeatures: [],
        missingRoutes: [],
        unexpectedFeatures: [],
        unexpectedRoutes: [],
        issues: ['stack:not-started'],
        error: 'stack has not started',
      },
      brainAutomation: loadSettings().brainAutomation ?? {
        cycleEnabled: false,
        cycleCadenceHours: 24,
      },
      ready: false,
    };
    let authPassed = true;
    let adminToken: string | null = null;
    let selftestError: string | undefined;
    let brainCycleOptIn: {
      initiallyDisabled: boolean;
      initiallyRunning: boolean;
      listenerRunningBeforeOptIn: boolean;
      stateAbsentBeforeOptIn: boolean;
      enabledAt: number;
      persisted: boolean;
    } | undefined;
    let runtimeContract: UnifiedRuntimeContractSelftestResult | undefined;
    let brainDashboardLifecycle: BrainDashboardLifecycleSelftestResult | undefined;
    try {
      const startedStack = await startUnifiedStack(profile);
      const managerUrl = startedStack.services.find((service) => service.name === 'manager')?.url;
      if (managerUrl) updateManagedManagerProfileUrl(profile.config, managerUrl);
      const activeManagerUrl = managerUrl || process.env.MANAGER_URL || 'http://127.0.0.1:4110';
      adminToken = unifiedStackAdminToken();
      configureManagedManager(activeManagerUrl, adminToken);
      configureComputerUseAuditManager(activeManagerUrl, adminToken);
      const readinessTimeoutInput = Number(
        process.env.IDACC_STACK_SELFTEST_READY_TIMEOUT_MS || 25_000,
      );
      const readinessTimeoutMs = Number.isFinite(readinessTimeoutInput)
        ? Math.min(120_000, Math.max(1_000, Math.floor(readinessTimeoutInput)))
        : 25_000;
      const deadline = Date.now() + readinessTimeoutMs;
      status = await unifiedStackStatus();
      while (!status.ready && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = await unifiedStackStatus();
      }
      if (!status.ready) {
        throw new Error(status.managerCompatibility.error || 'Unified runtime did not become ready');
      }
      // Test fixtures may opt out only in an unpackaged development build.
      // A production artifact always executes the full behavioral contract.
      if (app.isPackaged || process.env.IDACC_STACK_CONTRACT_SELFTEST !== '0') {
        runtimeContract = await runUnifiedRuntimeContractSelftest(activeManagerUrl, adminToken);
      }
      if (process.env.IDACC_STACK_SELFTEST_ENABLE_BRAIN_CYCLE === '1') {
        const initialCycle = status.companions.find((companion) => companion.name === 'brain-cycle');
        const initialListener = status.companions.find((companion) => companion.name === 'brain-listener');
        const stateAbsentBeforeOptIn = !existsSync(join(profile.brain, 'brain-cycle-state.json'));
        const enabledAt = Date.now();
        const saved = setBrainAutomationSettings({
          cycleEnabled: true,
          cycleCadenceHours: status.brainAutomation.cycleCadenceHours,
        }, profile.config).brainAutomation;
        if (!saved) throw new Error('Brain cycle opt-in did not persist');
        await configureUnifiedBrainAutomation(saved);
        const observeInput = Number(process.env.IDACC_STACK_SELFTEST_CYCLE_OBSERVE_MS || 1_200);
        const observeMs = Number.isFinite(observeInput)
          ? Math.min(5_000, Math.max(0, Math.floor(observeInput)))
          : 1_200;
        if (observeMs) await new Promise((resolve) => setTimeout(resolve, observeMs));
        status = await unifiedStackStatus();
        brainCycleOptIn = {
          initiallyDisabled: initialCycle?.enabled === false && initialCycle.phase === 'disabled',
          initiallyRunning: initialCycle?.running === true,
          listenerRunningBeforeOptIn: initialListener?.running === true,
          stateAbsentBeforeOptIn,
          enabledAt,
          persisted: loadSettings(profile.config).brainAutomation?.cycleEnabled === true,
        };
      }
      if (process.env.IDACC_STACK_AUTH_SELFTEST === '1') {
        let forgedStatus = 0;
        let desktopAuthenticated = false;
        let brainAnonymousHealthMinimal = false;
        const brainAnonymousStatuses: Record<string, number> = {};
        const brainAuthenticatedStatuses: Record<string, number> = {};
        const managerAnonymousStatuses: Record<string, number> = {};
        const managerBrainServiceStatuses: Record<string, number> = {};
        try {
          const forged = await fetch(new URL('/control/brain', activeManagerUrl), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-id-admin': '1',
            },
            body: JSON.stringify({ method: 'GET', path: '/health' }),
          });
          forgedStatus = forged.status;
          await forged.body?.cancel();
          desktopAuthenticated = Boolean(await bridgeCall('brain:coreHealth', []));
          const brainAccess = unifiedStackBrainRequestAccess();
          const sensitiveReads = [
            '/memory/shared',
            '/timeline',
            '/facts/export',
            '/approvals?status=pending&limit=1',
            '/learning-tasks?limit=1',
            '/dashboard',
            '/graph/app/data?limit=1',
          ];
          const anonymousHealth = await fetch(`${brainAccess.origin}/health`, {
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
            headers: { accept: 'application/json' },
          });
          const anonymousHealthPayload = await anonymousHealth.json() as Record<string, unknown>;
          const sensitiveHealthKeys = [
            'nodes',
            'edges',
            'memories',
            'entities',
            'timelineEvents',
            'facts',
            'factStatus',
            'factEntityIntegrity',
            'routeInventory',
          ];
          brainAnonymousHealthMinimal = anonymousHealth.status === 200
            && anonymousHealthPayload.ok === true
            && sensitiveHealthKeys.every((key) => !(key in anonymousHealthPayload));
          for (const path of sensitiveReads) {
            const anonymous = await fetch(`${brainAccess.origin}${path}`, {
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
              headers: { accept: 'application/json' },
            });
            brainAnonymousStatuses[path] = anonymous.status;
            await anonymous.body?.cancel();
            const authenticated = await fetch(`${brainAccess.origin}${path}`, {
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
              headers: {
                accept: 'application/json',
                authorization: brainAccess.authorizationHeader,
              },
            });
            brainAuthenticatedStatuses[path] = authenticated.status;
            await authenticated.body?.cancel();
          }
          const managerAccess = unifiedStackManagerServiceRequestAccess();
          const managerSensitiveReads = [
            '/teams',
            '/agents?team=default',
            '/events?since=0&limit=1',
          ];
          for (const path of managerSensitiveReads) {
            const anonymous = await fetch(`${managerAccess.origin}${path}`, {
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
              headers: {
                accept: 'application/json',
                'x-id-team': 'default',
              },
            });
            managerAnonymousStatuses[path] = anonymous.status;
            await anonymous.body?.cancel();
            const brainService = await fetch(`${managerAccess.origin}${path}`, {
              redirect: 'error',
              signal: AbortSignal.timeout(5_000),
              headers: {
                accept: 'application/json',
                authorization: managerAccess.authorizationHeader,
                'x-id-service': managerAccess.serviceHeader,
                'x-id-team': 'default',
              },
            });
            managerBrainServiceStatuses[path] = brainService.status;
            await brainService.body?.cancel();
          }
        } catch {
          desktopAuthenticated = false;
        }
        const brainSensitiveReadsProtected = Object.values(brainAnonymousStatuses)
          .every((status) => status === 401)
          && Object.keys(brainAnonymousStatuses).length === 7;
        const brainAuthenticatedReadsSucceeded = Object.values(brainAuthenticatedStatuses)
          .every((status) => status === 200)
          && Object.keys(brainAuthenticatedStatuses).length === 7;
        const managerSensitiveReadsProtected = Object.values(managerAnonymousStatuses)
          .every((status) => status === 401)
          && Object.keys(managerAnonymousStatuses).length === 3;
        const managerBrainServiceReadsSucceeded = Object.values(managerBrainServiceStatuses)
          .every((status) => status === 200)
          && Object.keys(managerBrainServiceStatuses).length === 3;
        // The managed Manager rejects a missing bearer in its authentication
        // middleware with 401. A compatible route-level implementation may
        // reject the same forged legacy admin header with 403. Both are
        // explicit authentication failures; no other status is accepted.
        const forgedAdminRejected = forgedStatus === 401 || forgedStatus === 403;
        authPassed = forgedAdminRejected
          && desktopAuthenticated
          && brainAnonymousHealthMinimal
          && brainSensitiveReadsProtected
          && brainAuthenticatedReadsSucceeded
          && managerSensitiveReadsProtected
          && managerBrainServiceReadsSucceeded;
        console.log('IDACC_STACK_AUTH_SELFTEST ' + JSON.stringify({
          forgedStatus,
          forgedAdminRejected,
          desktopAuthenticated,
          brainAnonymousHealthMinimal,
          brainSensitiveReadsProtected,
          brainAuthenticatedReadsSucceeded,
          managerSensitiveReadsProtected,
          managerBrainServiceReadsSucceeded,
          brainAnonymousStatuses,
          brainAuthenticatedStatuses,
          managerAnonymousStatuses,
          managerBrainServiceStatuses,
        }));
      }
      if (process.env.IDACC_STACK_DASHBOARD_SELFTEST === '1') {
        brainDashboardLifecycle = await runBrainDashboardLifecycleSelftest();
        authPassed = authPassed && brainDashboardLifecycle.allPassed;
      }
    } catch (error) {
      authPassed = false;
      selftestError = error instanceof Error ? error.message : String(error);
    }

    let resultPublished = true;
    const result = sanitizeSecretPayload({
      ...status,
      authPassed,
      ...(runtimeContract ? { runtimeContract } : {}),
      ...(brainCycleOptIn ? { brainCycleOptIn } : {}),
      ...(brainDashboardLifecycle ? { brainDashboardLifecycle } : {}),
      ...(selftestError ? { selftestError } : {}),
    });
    try {
      const serialized = JSON.stringify(result);
      if (
        !unifiedStackCredentialGuardSelftest()
        || unifiedStackPayloadContainsCredential(serialized)
      ) {
        throw new Error('stack self-test result contained a generated runtime credential');
      }
      const secretCandidates = [
        adminToken,
        process.env.BRAIN_TOKEN,
        process.env.IDACC_ADMIN_TOKEN,
        process.env.IDACC_MANAGER_SERVICE_TOKEN,
      ].filter((value): value is string => Boolean(value && value.length >= 8));
      if (secretCandidates.some((secret) => serialized.includes(secret))) {
        throw new Error('stack self-test result contained a runtime credential');
      }
      const requestedResultFile = process.env.IDACC_STACK_SELFTEST_RESULT_FILE;
      if (requestedResultFile) {
        writeStackSelftestResultFile(requestedResultFile, profile.root, result);
      }
      console.log('IDACC_STACK_SELFTEST ' + serialized);
    } catch (error) {
      resultPublished = false;
      console.error('IDACC_STACK_SELFTEST_RESULT_ERROR ' + (
        error instanceof Error ? error.message : String(error)
      ));
    }

    try {
      const firstStop = stopUnifiedStack();
      const concurrentStop = stopUnifiedStack();
      if (firstStop !== concurrentStop) {
        throw new Error('unified stack shutdown was not single-flight');
      }
      await firstStop;
    } catch (error) {
      resultPublished = false;
      console.error('IDACC_STACK_SELFTEST_STOP_ERROR ' + (
        error instanceof Error ? error.message : String(error)
      ));
    }
    void appShutdown.request({
      kind: 'exit',
      code: status.ready && authPassed && !selftestError && resultPublished ? 0 : 1,
    });
  });
} else {
  const startup = app.whenReady()
    .then(() => runStartupRecoveryLoop(async () => {
      requireConsumerStartupActive();
      prepareConsumerBackgroundActivitiesForStartup();
      startupRecoveryActive = true;
      const profile = initializeAppProfile();
      configureSecureSettings();
      const startedStack = await startUnifiedStack(profile);
      requireConsumerStartupActive();
      const managerUrl = startedStack.services.find((service) => service.name === 'manager')?.url;
      if (managerUrl) updateManagedManagerProfileUrl(profile.config, managerUrl);
      const activeManagerUrl = managerUrl || process.env.MANAGER_URL || 'http://127.0.0.1:4110';
      const adminToken = unifiedStackAdminToken();
      configureManagedManager(activeManagerUrl, adminToken);
      configureComputerUseAuditManager(activeManagerUrl, adminToken);
      configureKeyProviderFromSettings();
      stopProviderRuntimeRehydrationListener = subscribeUnifiedStackServiceReady((event) => {
        if (event.name !== 'manager' || appShutdown.isQuiescing()) return;
        return rehydrateProviderAgentsForReadyManager();
      });
      await createWindow();
      requireConsumerStartupActive();
      // Treat the app-owned Computer Use controller as part of startup. If its
      // private loopback listener cannot bind, recovery closes the new window
      // and stops the unified stack before any long-lived handlers are added.
      await startBroker(
        (frame) => { try { win?.webContents.send('computeruse:frame', frame); } catch { /* window gone */ } },
        (evt) => { try { win?.webContents.send('computeruse:pending', evt); } catch { /* window gone */ } },
      );
      requireConsumerStartupActive();
      // Reactive org-sync: keep every agent's goals & instructions file composed from the lead
      // hierarchy + brain team-instructions (first pass ~15s after boot, then every 5 min).
      try { stopOrgSyncRunner = startOrgSync(); } catch (e) { console.warn('[org-sync] failed to start:', e); }
      // Keep model lanes current and notify mounted pickers after each bounded refresh pass.
      try {
        stopModelRefreshRunner = startModelRefreshLoop(() => publishStoreChange('runtime:probe'));
      } catch (e) {
        console.warn('[model-refresh] failed to start:', e);
      }
      // Globally available by default, but only active goals whose own Autopilot
      // switch is enabled can gap-fill fleet tasks.
      try { stopGoalDriver = startGoalDriver(); } catch (e) { console.warn('[goaldriver] failed to start:', e); }
      // Medium-risk, non-authority Brain skill proposals are reviewed by two
      // independent fleet agents. Only genuine disagreement or privileged/sensitive
      // scope is allowed to reach the operator Inbox; unavailable reviewers wait.
      try {
        configureAutomaticBrainApprovalReview();
        stopBrainApprovalAutomation = startBrainApprovalAutomationLoop((result) => {
          if (appShutdown.isQuiescing()) return;
          const publish = () => {
            if (!appShutdown.isQuiescing()) {
              publishStoreChange('brainApproval:autoReview');
              recordControlAction('brainApproval:autoReview', ['background'], result);
            }
          };
          const sync = syncBrainApprovalInbox({ force: true })
            .then(publish, publish)
            .then(() => undefined);
          activeBrainApprovalInboxSyncs.add(sync);
          void sync.then(() => { activeBrainApprovalInboxSyncs.delete(sync); });
        });
        void runBrainApprovalAutomationOnce();
      } catch (e) { console.warn('[brain-approval-review] failed to start:', e); }
      // Work > Learn queue: process newly-added materials even when the Learn tab is not mounted.
      try {
        stopMaterialChangeBridge = subscribeMaterialChanges((reason, material) => {
          if (appShutdown.isQuiescing()) return;
          publishStoreChange(reason === 'tasks' ? 'materials:tasks' : 'materials:changed');
          if (reason === 'write' && 'status' in material && material.status === 'queued') {
            kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.queuedWriteKickMs);
          }
          if (reason === 'write' && 'status' in material && (material.status === 'ready' || material.status === 'blocked' || material.status === 'failed')) {
            kickLearnQueueRunner?.(LEARN_QUEUE_RUNNER_DELAYS.terminalWriteKickMs);
          }
          if (reason === 'write' && 'status' in material && (material.status === 'ready' || material.status === 'blocked')) {
            kickLearnBrainBackfillRunner?.(LEARN_BRAIN_BACKFILL_RUNNER_DELAYS.materialWriteKickMs);
          }
        });
      } catch (e) { console.warn('[learn] failed to start material change bridge:', e); }
      try { stopLearnQueueRunner = startLearnQueueRunner(); } catch (e) { console.warn('[learn] failed to start queue runner:', e); }
      try { stopLearnBrainBackfillRunner = startLearnBrainBackfillRunner(); } catch (e) { console.warn('[learn] failed to start brain backfill runner:', e); }
      // Draft dispatcher: opt-in only. Draft/proposal rows are review-only unless
      // the operator explicitly enables this bridge in settings.
      try { stopDraftDispatcher = startDraftDispatcher(); } catch (e) { console.warn('[draft-dispatcher] failed to start:', e); }
      // Reconcile completed scheduled Dream queries into the profile-owned Dream
      // archive. Agent news is durable, so runs completed while IDACC was closed
      // are imported idempotently after the unified stack comes back.
      try { stopScheduledDreamArchive = startScheduledDreamArchiveLoop(); } catch (e) { console.warn('[dream-archive] failed to start:', e); }
      // Global PANIC hotkey: instant stop from anywhere, even when the app isn't focused.
      try {
        const ok = globalShortcut.register('CommandOrControl+Alt+Shift+P', () => {
          panicBroker();
          try { win?.webContents.send('computeruse:panic', { ts: Date.now() }); } catch { /* */ }
        });
        setPanicHotkey(ok);
        if (!ok) console.warn('[cu] PANIC hotkey not registered (already taken); use the on-screen button');
      } catch { /* the on-screen PANIC button is the fallback */ }
      consumerActivationReady = true;
      if (pendingConsumerActivation) {
        pendingConsumerActivation = false;
        handleConsumerAppActivation();
      }
      if (win && !win.isDestroyed()) startUpdaterSafely(win);
      startupRecoveryActive = false;
    }, handleConsumerStartupFailure))
    .then((started) => {
      if (!started) void appShutdown.request({ kind: 'quit' });
    })
    .catch((error) => handleUnrecoverableStartupFailure(error));
  consumerStartupPromise = startup;
  const clearStartupPromise = () => {
    if (consumerStartupPromise === startup) consumerStartupPromise = null;
  };
  void startup.then(clearStartupPromise, clearStartupPromise);
}

if (ownsSingleInstanceLock) {
  app.on('child-process-gone', (_event, details) => {
    logProcessExit('child-process', details as unknown as Record<string, unknown>);
  });

  app.on('window-all-closed', () => {
    // The headless stack self-test deliberately creates and destroys an
    // isolated Brain dashboard window. On Linux and Windows, closing that
    // fixture must not terminate Electron before the result is published and
    // the supervised Manager/Brain shutdown has completed.
    if (stackSelftest) return;
    if (startupRecoveryActive || BrowserWindow.getAllWindows().length > 0) return;
    if (process.platform !== 'darwin') void appShutdown.request({ kind: 'quit' });
  });
}
