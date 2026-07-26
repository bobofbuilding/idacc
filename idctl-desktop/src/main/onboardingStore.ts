import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  STARTER_AGENT_NAMES,
  type StarterAgentName,
} from '../shared/starterFleet.ts';
import type {
  ConsumerOnboardingMode,
  ConsumerOnboardingState,
  OnboardingAssignment,
  PersistedStarterAgentState,
  StarterAgentSetupStatus,
} from '../shared/consumerOnboarding.ts';

const ONBOARDING_STATE_VERSION = 1 as const;
const MODES = new Set<ConsumerOnboardingMode>(['required', 'in_progress', 'limited', 'complete']);
const AGENT_STATUSES = new Set<StarterAgentSetupStatus>(['pending', 'running', 'ok', 'failed', 'preserved']);

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: unknown, length = 600): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, length) : undefined;
}

export function onboardingStatePath(): string {
  const explicit = process.env.IDACC_ONBOARDING_STATE?.trim();
  if (explicit) return explicit;
  const profileRoot = process.env.IDACC_DATA_DIR?.trim() || join(homedir(), '.config', 'idctl');
  return join(profileRoot, 'onboarding', 'state.json');
}

export function defaultOnboardingState(): ConsumerOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    mode: 'required',
    agents: {},
    updatedAt: nowIso(),
  };
}

function normalizeAssignment(raw: unknown): OnboardingAssignment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Partial<OnboardingAssignment>;
  const runtime = clip(row.runtime, 180);
  const model = clip(row.model, 256);
  return runtime ? { runtime, ...(model ? { model } : {}) } : undefined;
}

function normalizeAgentState(raw: unknown): PersistedStarterAgentState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Partial<PersistedStarterAgentState>;
  const status = AGENT_STATUSES.has(row.status as StarterAgentSetupStatus)
    ? row.status as StarterAgentSetupStatus
    : 'pending';
  return {
    status,
    ...(clip(row.agentId, 180) ? { agentId: clip(row.agentId, 180) } : {}),
    ...(clip(row.error) ? { error: clip(row.error) } : {}),
    updatedAt: clip(row.updatedAt, 80) || nowIso(),
  };
}

function normalizeState(raw: unknown): ConsumerOnboardingState {
  if (!raw || typeof raw !== 'object') return defaultOnboardingState();
  const input = raw as Partial<ConsumerOnboardingState>;
  const agents: ConsumerOnboardingState['agents'] = {};
  for (const name of STARTER_AGENT_NAMES) {
    const normalized = normalizeAgentState(input.agents?.[name]);
    if (normalized) agents[name] = normalized;
  }
  const mode = MODES.has(input.mode as ConsumerOnboardingMode)
    ? input.mode as ConsumerOnboardingMode
    : 'required';
  const selectedAssignment = normalizeAssignment(input.selectedAssignment);
  return {
    version: ONBOARDING_STATE_VERSION,
    mode,
    ...(selectedAssignment ? { selectedAssignment } : {}),
    agents,
    ...(clip(input.startedAt, 80) ? { startedAt: clip(input.startedAt, 80) } : {}),
    ...(clip(input.deferredAt, 80) ? { deferredAt: clip(input.deferredAt, 80) } : {}),
    ...(clip(input.completedAt, 80) ? { completedAt: clip(input.completedAt, 80) } : {}),
    updatedAt: clip(input.updatedAt, 80) || nowIso(),
    ...(clip(input.lastVerifiedAt, 80) ? { lastVerifiedAt: clip(input.lastVerifiedAt, 80) } : {}),
    ...(clip(input.lastProbeAt, 80) ? { lastProbeAt: clip(input.lastProbeAt, 80) } : {}),
    ...(clip(input.lastError) ? { lastError: clip(input.lastError) } : {}),
  };
}

function atomicWrite(state: ConsumerOnboardingState): ConsumerOnboardingState {
  const path = onboardingStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* best effort */ }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return state;
}

export function loadOnboardingState(): ConsumerOnboardingState {
  const path = onboardingStatePath();
  if (!existsSync(path)) return defaultOnboardingState();
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // A malformed state file must never brick IDACC. Leave it untouched until
    // the next successful, atomic setup mutation replaces it.
    return defaultOnboardingState();
  }
}

export function saveOnboardingState(state: ConsumerOnboardingState): ConsumerOnboardingState {
  return atomicWrite(normalizeState({ ...state, updatedAt: nowIso() }));
}

export function updateOnboardingState(
  patch: Partial<Omit<ConsumerOnboardingState, 'version' | 'updatedAt'>>,
): ConsumerOnboardingState {
  const current = loadOnboardingState();
  return saveOnboardingState({
    ...current,
    ...patch,
    agents: patch.agents ? { ...current.agents, ...patch.agents } : current.agents,
    version: ONBOARDING_STATE_VERSION,
    updatedAt: nowIso(),
  });
}

export function setOnboardingAgentProgress(
  name: StarterAgentName,
  status: StarterAgentSetupStatus,
  detail: { agentId?: string; error?: string } = {},
): ConsumerOnboardingState {
  const current = loadOnboardingState();
  return updateOnboardingState({
    agents: {
      ...current.agents,
      [name]: {
        status,
        ...(clip(detail.agentId, 180) ? { agentId: clip(detail.agentId, 180) } : {}),
        ...(clip(detail.error) ? { error: clip(detail.error) } : {}),
        updatedAt: nowIso(),
      },
    },
  });
}

export function beginOnboarding(assignment: OnboardingAssignment): ConsumerOnboardingState {
  const current = loadOnboardingState();
  const agents = { ...current.agents };
  for (const name of STARTER_AGENT_NAMES) {
    if (agents[name]?.status === 'running' || agents[name]?.status === 'failed') {
      agents[name] = { status: 'pending', updatedAt: nowIso() };
    }
  }
  return updateOnboardingState({
    mode: 'in_progress',
    selectedAssignment: assignment,
    agents,
    startedAt: current.startedAt || nowIso(),
    deferredAt: undefined,
    completedAt: undefined,
    lastError: undefined,
  });
}

export function deferOnboarding(): ConsumerOnboardingState {
  return updateOnboardingState({
    mode: 'limited',
    deferredAt: nowIso(),
    lastError: undefined,
  });
}

export function resumeOnboarding(): ConsumerOnboardingState {
  return updateOnboardingState({
    mode: 'required',
    deferredAt: undefined,
    lastError: undefined,
  });
}

export function completeOnboarding(): ConsumerOnboardingState {
  const completedAt = nowIso();
  return updateOnboardingState({
    mode: 'complete',
    completedAt,
    deferredAt: undefined,
    lastVerifiedAt: completedAt,
    lastError: undefined,
  });
}
