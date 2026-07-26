import {
  STARTER_AGENT_NAMES,
  STARTER_FLEET_AGENTS,
  STARTER_LEAD,
  STARTER_TEAM,
  STARTER_VALIDATORS,
  type StarterAgentName,
  type StarterFleetAgentDefinition,
} from './starterFleet.ts';

export type ConsumerOnboardingMode = 'required' | 'in_progress' | 'limited' | 'complete';
export type ConsumerOnboardingPhase = 'preparing' | 'required' | 'in_progress' | 'limited' | 'ready' | 'degraded';
export type StarterAgentSetupStatus = 'pending' | 'running' | 'ok' | 'failed' | 'preserved';

export interface OnboardingAssignment {
  runtime: string;
  model?: string;
}

export interface PersistedStarterAgentState {
  status: StarterAgentSetupStatus;
  agentId?: string;
  error?: string;
  updatedAt: string;
}

export interface ConsumerOnboardingState {
  version: 1;
  mode: ConsumerOnboardingMode;
  selectedAssignment?: OnboardingAssignment;
  agents: Partial<Record<StarterAgentName, PersistedStarterAgentState>>;
  startedAt?: string;
  deferredAt?: string;
  completedAt?: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  lastProbeAt?: string;
  lastError?: string;
}

export interface OnboardingRuntimeOption {
  runtime: string;
  label: string;
  models: string[];
  source: string;
  provider?: string;
  detail?: string;
  /** Local tool readiness was proven for exact model ids, so no implicit default is safe. */
  requiresModel?: boolean;
}

export interface OnboardingSubscriptionOption {
  provider: string;
  runtime: string;
  label: string;
  loggedIn: boolean;
  linked?: boolean;
  installed?: boolean;
  loginSupported?: boolean;
  installSupported?: boolean;
  account?: string;
  detail?: string;
}

export interface OnboardingStackService {
  name: 'manager' | 'brain';
  bundled: boolean;
  running: boolean;
  healthy: boolean;
  error?: string;
}

export interface StarterAgentReadiness {
  name: StarterAgentName;
  role: string;
  present: boolean;
  active: boolean;
  runtime?: string;
  model?: string;
  instructionsReady: boolean;
  skillsReady: boolean;
  brainMcpReady: boolean;
  setupStatus: StarterAgentSetupStatus;
  error?: string;
}

export interface ConsumerReadinessGates {
  stack: boolean;
  assignment: boolean;
  roster: boolean;
  hierarchy: boolean;
  agents: boolean;
  instructions: boolean;
  capabilities: boolean;
}

export interface ConsumerOnboardingStatus {
  phase: ConsumerOnboardingPhase;
  ready: boolean;
  currentReady: boolean;
  needsOnboarding: boolean;
  limitedMode: boolean;
  canDefer: boolean;
  profileRoot?: string;
  state: ConsumerOnboardingState;
  services: OnboardingStackService[];
  gates: ConsumerReadinessGates;
  starterAgents: StarterAgentReadiness[];
  assignments: OnboardingRuntimeOption[];
  subscriptions: OnboardingSubscriptionOption[];
  issues: string[];
}

export interface OnboardingAgentSnapshot {
  id?: string;
  name: string;
  team: string;
  status?: string;
  runtime?: string;
  model?: string;
  instructions?: string;
  skills?: string[];
  brainMcpReady?: boolean;
}

export interface OnboardingHierarchySnapshot {
  primary?: { team?: string; agent?: string } | null;
  coordinators?: Record<string, string>;
  secondaries?: Array<{ team?: string; agent?: string; leadsTeams?: string[] }>;
}

export interface ConsumerReadinessSnapshot {
  stackReady: boolean;
  agents: OnboardingAgentSnapshot[];
  hierarchy?: OnboardingHierarchySnapshot | null;
  assignments: OnboardingRuntimeOption[];
  state: ConsumerOnboardingState;
}

export function isActiveOnboardingAgent(status: string | undefined): boolean {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized === 'running';
}

export function onboardingAssignmentAvailable(
  agent: OnboardingAgentSnapshot,
  options: OnboardingRuntimeOption[],
): boolean {
  const runtime = String(agent.runtime ?? '').trim();
  if (!runtime) return false;
  const option = options.find((row) => row.runtime === runtime);
  if (!option) return false;
  const model = String(agent.model ?? '').trim();
  if (!model) return option.requiresModel !== true;
  return option.models.length === 0 || option.models.includes(model);
}

function persistedStatus(state: ConsumerOnboardingState, name: StarterAgentName, present: boolean): StarterAgentSetupStatus {
  return state.agents[name]?.status ?? (present ? 'preserved' : 'pending');
}

export function evaluateConsumerReadiness(snapshot: ConsumerReadinessSnapshot): {
  ready: boolean;
  gates: ConsumerReadinessGates;
  starterAgents: StarterAgentReadiness[];
  issues: string[];
} {
  const starterAgents = STARTER_FLEET_AGENTS.map((definition): StarterAgentReadiness => {
    const agent = snapshot.agents.find((row) => row.team === STARTER_TEAM && row.name === definition.name);
    const present = Boolean(agent);
    const installedSkills = new Set((agent?.skills ?? []).map((skill) => String(skill).trim()).filter(Boolean));
    return {
      name: definition.name,
      role: definition.role,
      present,
      active: present && isActiveOnboardingAgent(agent?.status),
      runtime: agent?.runtime,
      model: agent?.model,
      instructionsReady: Boolean(agent?.instructions?.trim()),
      skillsReady: definition.skills.every((skill) => installedSkills.has(skill)),
      brainMcpReady: agent?.brainMcpReady === true,
      setupStatus: persistedStatus(snapshot.state, definition.name, present),
      error: snapshot.state.agents[definition.name]?.error,
    };
  });

  const hierarchy = snapshot.hierarchy;
  const secondaries = new Set(
    (hierarchy?.secondaries ?? [])
      .filter((row) => String(row.team ?? '') === STARTER_TEAM)
      .map((row) => String(row.agent ?? '')),
  );
  const hierarchyReady = hierarchy?.primary?.team === STARTER_TEAM
    && hierarchy.primary.agent === STARTER_LEAD
    && hierarchy.coordinators?.[STARTER_TEAM] === STARTER_LEAD
    && STARTER_VALIDATORS.every((agent) => secondaries.has(agent));

  const gates: ConsumerReadinessGates = {
    stack: snapshot.stackReady,
    roster: starterAgents.every((agent) => agent.present),
    hierarchy: Boolean(hierarchyReady),
    agents: starterAgents.every((agent) => agent.active),
    instructions: starterAgents.every((agent) => agent.instructionsReady),
    capabilities: starterAgents.every((agent) => agent.skillsReady && agent.brainMcpReady),
    assignment: STARTER_AGENT_NAMES.every((name) => {
      const agent = snapshot.agents.find((row) => row.team === STARTER_TEAM && row.name === name);
      return Boolean(agent && onboardingAssignmentAvailable(agent, snapshot.assignments));
    }),
  };

  const issues: string[] = [];
  if (!gates.stack) issues.push('The bundled Agent manager and Brain must both be healthy.');
  if (!gates.roster) {
    const missing = starterAgents.filter((agent) => !agent.present).map((agent) => agent.name);
    issues.push(`Starter team is missing ${missing.join(', ')}.`);
  }
  if (gates.roster && !gates.assignment) issues.push('Every starter agent needs a currently verified model route.');
  if (gates.roster && !gates.agents) issues.push('Every starter agent must be running and healthy.');
  if (gates.roster && !gates.instructions) issues.push('Starter responsibilities have not been applied to every starter agent.');
  if (gates.roster && !gates.capabilities) {
    issues.push('Every starter agent needs the neutral core skills and effective Brain MCP access.');
  }
  if (!gates.hierarchy) issues.push('The lead, coder, and researcher are not fully connected in the starter hierarchy.');

  return {
    ready: Object.values(gates).every(Boolean),
    gates,
    starterAgents,
    issues,
  };
}

export function missingStarterAgentDefinitions(agents: Array<{ name: string; team: string }>): StarterFleetAgentDefinition[] {
  const existing = new Set(
    agents
      .filter((agent) => agent.team === STARTER_TEAM)
      .map((agent) => agent.name),
  );
  return STARTER_FLEET_AGENTS.filter((definition) => !existing.has(definition.name));
}

export interface StarterFleetOrchestrationDeps {
  listAgents: () => Promise<Array<{ id?: string; name: string; team: string }>>;
  verifyAssignments: (rows: Array<{ name: string; runtime: string; model?: string }>) => Promise<{
    ok: boolean;
    rows: Array<{ name: string; ok: boolean; detail?: string }>;
  }>;
  onboardAgent: (
    definition: StarterFleetAgentDefinition,
    assignment: OnboardingAssignment,
  ) => Promise<{ ok: boolean; agentId?: string; error?: string }>;
  onProgress?: (
    name: StarterAgentName,
    status: StarterAgentSetupStatus,
    detail?: { agentId?: string; error?: string },
  ) => Promise<void> | void;
}

export interface StarterFleetOrchestrationResult {
  ok: boolean;
  missing: StarterAgentName[];
  preserved: StarterAgentName[];
  created: StarterAgentName[];
  error?: string;
}

/**
 * Verify the whole creation batch before crossing the first creation boundary,
 * then create only names that are still missing. This is exported for a
 * deterministic smoke test and used by the Electron orchestration wrapper.
 */
export async function orchestrateMissingStarterAgents(
  deps: StarterFleetOrchestrationDeps,
  assignment: OnboardingAssignment,
): Promise<StarterFleetOrchestrationResult> {
  const before = await deps.listAgents();
  const missing = missingStarterAgentDefinitions(before);
  const missingNames = missing.map((definition) => definition.name);
  const preserved = STARTER_AGENT_NAMES.filter((name) => !missingNames.includes(name));
  for (const name of preserved) await deps.onProgress?.(name, 'preserved');
  if (!missing.length) return { ok: true, missing: [], preserved: [...preserved], created: [] };

  const verification = await deps.verifyAssignments(missing.map((definition) => ({
    name: definition.name,
    runtime: assignment.runtime,
    ...(assignment.model ? { model: assignment.model } : {}),
  })));
  if (!verification.ok) {
    const detail = verification.rows.filter((row) => !row.ok).map((row) => row.detail).filter(Boolean).join('; ')
      || 'The selected model route could not be verified.';
    for (const definition of missing) await deps.onProgress?.(definition.name, 'failed', { error: detail });
    return { ok: false, missing: missingNames, preserved: [...preserved], created: [], error: detail };
  }

  const created: StarterAgentName[] = [];
  for (const definition of missing) {
    await deps.onProgress?.(definition.name, 'running');
    const result = await deps.onboardAgent(definition, assignment);
    if (!result.ok) {
      const error = result.error || `Could not create ${definition.name}.`;
      await deps.onProgress?.(definition.name, 'failed', { error });
      return { ok: false, missing: missingNames, preserved: [...preserved], created, error };
    }
    created.push(definition.name);
    await deps.onProgress?.(definition.name, 'ok', { agentId: result.agentId });
  }

  return { ok: true, missing: missingNames, preserved: [...preserved], created };
}

export interface PreservedStarterRepairCandidate {
  id?: string;
  name: StarterAgentName;
  team: string;
  repairAssignment: boolean;
  inactive: boolean;
}

export function preservedStarterRepairCandidates(
  agents: OnboardingAgentSnapshot[],
  options: OnboardingRuntimeOption[],
): PreservedStarterRepairCandidate[] {
  return STARTER_AGENT_NAMES.flatMap((name) => {
    const agent = agents.find((row) => row.team === STARTER_TEAM && row.name === name);
    if (!agent) return [];
    return [{
      id: agent.id,
      name,
      team: agent.team,
      repairAssignment: !onboardingAssignmentAvailable(agent, options),
      inactive: !isActiveOnboardingAgent(agent.status),
    }];
  });
}

export interface PreservedStarterRepairDeps {
  verifyAssignments: StarterFleetOrchestrationDeps['verifyAssignments'];
  applyAssignment: (
    agent: PreservedStarterRepairCandidate,
    assignment: OnboardingAssignment,
  ) => Promise<void>;
  rebuildAgent: (agent: PreservedStarterRepairCandidate) => Promise<void>;
  onProgress?: StarterFleetOrchestrationDeps['onProgress'];
}

export interface PreservedStarterRepairResult {
  ok: boolean;
  assignmentRepaired: StarterAgentName[];
  restarted: StarterAgentName[];
  error?: string;
}

/**
 * Repair only preserved starter agents that have a stale model route or are not
 * running. The selected replacement route is verified for the complete repair
 * batch before the first assignment mutation. Rebuild is also the manager's
 * supported recovery operation for a stopped local agent, so every repaired or
 * inactive starter is explicitly started again before the caller's final probe.
 */
export async function orchestratePreservedStarterRepairs(
  deps: PreservedStarterRepairDeps,
  candidates: PreservedStarterRepairCandidate[],
  assignment: OnboardingAssignment,
): Promise<PreservedStarterRepairResult> {
  const repairTargets = candidates.filter((candidate) => candidate.repairAssignment);
  const restartTargets = candidates.filter((candidate) => candidate.repairAssignment || candidate.inactive);
  if (!restartTargets.length) return { ok: true, assignmentRepaired: [], restarted: [] };

  const missingId = repairTargets.find((candidate) => !String(candidate.id ?? '').trim());
  if (missingId) {
    const error = `Could not repair ${missingId.name}: the manager did not return its agent ID.`;
    await deps.onProgress?.(missingId.name, 'failed', { error });
    return { ok: false, assignmentRepaired: [], restarted: [], error };
  }

  if (repairTargets.length) {
    const verification = await deps.verifyAssignments(repairTargets.map((candidate) => ({
      name: candidate.name,
      runtime: assignment.runtime,
      ...(assignment.model ? { model: assignment.model } : {}),
    })));
    const verified = new Set(
      verification.rows
        .filter((row) => row.ok)
        .map((row) => row.name),
    );
    const unverified = repairTargets.filter((candidate) => !verified.has(candidate.name));
    if (!verification.ok || unverified.length) {
      const affected = (unverified.length ? unverified : repairTargets)
        .map((candidate) => candidate.name)
        .join(', ');
      const detail = verification.rows
        .filter((row) => !row.ok)
        .map((row) => row.detail)
        .filter(Boolean)
        .join('; ')
        || `The selected model route could not be verified for ${affected}.`;
      for (const candidate of repairTargets) {
        await deps.onProgress?.(candidate.name, 'failed', { error: detail });
      }
      return { ok: false, assignmentRepaired: [], restarted: [], error: detail };
    }
  }

  const assignmentRepaired: StarterAgentName[] = [];
  const restarted: StarterAgentName[] = [];
  for (const candidate of restartTargets) {
    await deps.onProgress?.(candidate.name, 'running');
    try {
      if (candidate.repairAssignment) {
        await deps.applyAssignment(candidate, assignment);
        assignmentRepaired.push(candidate.name);
      }
      await deps.rebuildAgent(candidate);
      restarted.push(candidate.name);
      await deps.onProgress?.(candidate.name, 'preserved', { agentId: candidate.id });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = `Could not repair ${candidate.name}: ${detail}`;
      await deps.onProgress?.(candidate.name, 'failed', { agentId: candidate.id, error });
      return { ok: false, assignmentRepaired, restarted, error };
    }
  }

  return { ok: true, assignmentRepaired, restarted };
}
