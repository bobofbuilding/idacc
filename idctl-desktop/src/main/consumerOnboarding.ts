import { call as bridgeCall } from './bridge.ts';
import { subsStatus } from './subscriptions.ts';
import { unifiedStackStatus } from './unifiedStack.ts';
import { normalizeProviderBaseUrl } from '../../../idctl/src/settings/providerTransport.ts';
import {
  beginOnboarding,
  completeOnboarding,
  deferOnboarding,
  loadOnboardingState,
  resumeOnboarding,
  setOnboardingAgentProgress,
  updateOnboardingState,
} from './onboardingStore.ts';
import {
  consumerOnboardingPhase,
  evaluateConsumerReadiness,
  orchestrateMissingStarterAgents,
  orchestratePreservedStarterRepairs,
  preservedStarterRepairCandidates,
  type ConsumerOnboardingStatus,
  type OnboardingAgentSnapshot,
  type OnboardingAssignment,
  type OnboardingHierarchySnapshot,
  type OnboardingRuntimeOption,
  type OnboardingSubscriptionOption,
} from '../shared/consumerOnboarding.ts';
import {
  STARTER_AGENT_NAMES,
  STARTER_FLEET_AGENTS,
  STARTER_LEAD,
  STARTER_TEAM,
  STARTER_VALIDATORS,
  type StarterAgentName,
} from '../shared/starterFleet.ts';

type FleetAgent = {
  id?: string;
  name?: string;
  status?: string;
  runtime?: string;
  model?: string;
  metadata?: { runtime?: string; instructions?: string; skills?: string[] };
  brainTools?: {
    skillInstalled?: boolean;
    mcpAttached?: boolean;
    activeToolAccess?: boolean;
  };
};
type FleetGroup = { team?: string; agents?: FleetAgent[] };
type RuntimeFreshnessRow = {
  runtime?: string;
  label?: string;
  models?: string[];
  source?: string;
  provider?: string;
  selectable?: boolean;
  supportsMcp?: boolean;
  mcpModels?: string[];
  mcpEvidence?: 'runtime' | 'ollama-show' | 'none';
  mcpExcludedModels?: string[];
  mcpDetail?: string;
  detail?: string;
};
type RuntimeVerification = {
  ok: boolean;
  rows: Array<{ name: string; ok: boolean; detail?: string }>;
};
type OnboardResult = {
  ok: boolean;
  agentId?: string;
  steps?: Array<{ status?: string; error?: string; detail?: string }>;
};
type ProviderRow = {
  name?: string;
  kind?: string;
  baseUrl?: string;
};
type ProviderConnectResult = {
  outcome?: {
    ok?: boolean;
    status?: string;
    message?: string;
    models?: Array<{ id?: string }>;
  };
};

export interface ConfigureOnboardingProviderInput {
  name: string;
  kind: 'ollama' | 'lmstudio' | 'openai-compatible' | 'anthropic' | 'openai';
  baseUrl: string;
  apiKey?: string;
  needsKey?: boolean;
  replace?: boolean;
}

let statusGeneration = 0;
let statusRequestSequence = 0;
let latestStatusRequestSequence = 0;
let cachedStatus: { at: number; generation: number; value: ConsumerOnboardingStatus } | null = null;
let statusInflight: { generation: number; promise: Promise<ConsumerOnboardingStatus> } | null = null;
let starterRunInflight: Promise<ConsumerOnboardingStatus> | null = null;
const STATUS_CACHE_MS = 4_000;
const MAX_MISSING_SKILL_REPAIRS = 32;

function invalidateStatus(): void {
  statusGeneration += 1;
  cachedStatus = null;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 600);
}

function missingLibrarySkillName(error: unknown): string | null {
  const match = safeError(error).match(/Skill\s+["'“”]([^"'“”]+)["'“”]\s+not found at\b/i);
  const name = String(match?.[1] ?? '').trim();
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) ? name : null;
}

async function rebuildStarterAgentRepairingMissingSkills(
  candidate: { name: string; team: string },
): Promise<void> {
  const definition = STARTER_FLEET_AGENTS.find((entry) => entry.name === candidate.name);
  const required = new Set<string>(definition?.skills ?? []);
  const attempted = new Set<string>();

  while (attempted.size < MAX_MISSING_SKILL_REPAIRS) {
    try {
      await bridgeCall('rebuildAgent', [candidate.name, candidate.team]);
      return;
    } catch (error) {
      const skill = missingLibrarySkillName(error);
      if (!skill || attempted.has(skill)) throw error;
      attempted.add(skill);

      // Older app builds could leave removed, app-owned skills in agent
      // metadata after the neutral consumer library replaced them. Repair only
      // the exact skill the Manager reports as unavailable. Required starter
      // skills are restored; unavailable optional/legacy references are
      // detached so they cannot permanently block an otherwise valid rebuild.
      if (required.has(skill)) {
        await bridgeCall('installSkill', [skill, candidate.name, candidate.team]);
        continue;
      }

      // Do not use the public uninstall route here. It deploys immediately,
      // which means a second unavailable legacy reference makes that deploy
      // fail and rolls the first removal back. Replace the metadata list
      // without deploying, then let the next loop iteration discover any
      // remaining stale reference. The successful iteration rebuilds once.
      const groups = await bridgeCall('agents:allTeams', [{ force: true }]) as FleetGroup[];
      const agent = groups
        .find((group) => String(group.team ?? STARTER_TEAM) === candidate.team)
        ?.agents?.find((entry) => String(entry.name ?? '') === candidate.name);
      if (!agent) throw error;
      const currentSkills = (Array.isArray(agent.metadata?.skills) ? agent.metadata.skills : [])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean);
      const nextSkills = currentSkills.filter((entry) => entry !== skill);
      if (nextSkills.length === currentSkills.length) throw error;
      await bridgeCall('setAgentSkills', [agent.id, nextSkills, candidate.team]);
    }
  }

  throw new Error(`Could not rebuild ${candidate.name}: too many unavailable skill references.`);
}

function normalizedRuntimeOptions(rows: RuntimeFreshnessRow[]): OnboardingRuntimeOption[] {
  const byRuntime = new Map<string, OnboardingRuntimeOption>();
  for (const row of rows) {
    const runtime = String(row.runtime ?? '').trim();
    if (!runtime || row.selectable !== true || row.supportsMcp !== true) continue;
    const catalogModels = Array.from(new Set(
      (Array.isArray(row.models) ? row.models : [])
        .map((model) => String(model ?? '').trim())
        .filter(Boolean),
    ));
    const verifiedMcpModels = Array.isArray(row.mcpModels)
      ? new Set(row.mcpModels.map((candidate) => String(candidate ?? '').trim()).filter(Boolean))
      : null;
    const models = verifiedMcpModels
      ? catalogModels.filter((model) => verifiedMcpModels.has(model))
      : catalogModels;
    if (catalogModels.length > 0 && models.length === 0) continue;
    const option: OnboardingRuntimeOption = {
      runtime,
      label: String(row.label ?? runtime).trim() || runtime,
      models,
      source: String(row.source ?? 'verified'),
      ...(row.provider ? { provider: String(row.provider) } : {}),
      ...(row.detail ? { detail: String(row.detail).slice(0, 500) } : {}),
      ...(row.mcpEvidence === 'ollama-show' ? { requiresModel: true } : {}),
    };
    const existing = byRuntime.get(runtime);
    if (!existing || option.models.length > existing.models.length) byRuntime.set(runtime, option);
  }
  return [...byRuntime.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function safeSubscriptions(rows: Record<string, unknown>): OnboardingSubscriptionOption[] {
  return Object.values(rows).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const provider = String(row.provider ?? '').trim();
    const runtime = String(row.runtime ?? '').trim();
    if (!provider || !runtime) return [];
    return [{
      provider,
      runtime,
      label: String(row.label ?? provider),
      loggedIn: Boolean(row.loggedIn),
      ...(typeof row.linked === 'boolean' ? { linked: row.linked } : {}),
      ...(typeof row.installed === 'boolean' ? { installed: row.installed } : {}),
      ...(typeof row.loginSupported === 'boolean' ? { loginSupported: row.loginSupported } : {}),
      ...(typeof row.installSupported === 'boolean' ? { installSupported: row.installSupported } : {}),
      ...(typeof row.account === 'string' && row.account ? { account: row.account.slice(0, 160) } : {}),
      ...(typeof row.detail === 'string' && row.detail ? { detail: row.detail.slice(0, 500) } : {}),
    }];
  }).sort((a, b) => a.label.localeCompare(b.label));
}

async function agentSnapshots(groups: FleetGroup[]): Promise<OnboardingAgentSnapshot[]> {
  const rows = groups.flatMap((group) => (group.agents ?? []).map((agent): OnboardingAgentSnapshot => ({
    id: agent.id,
    name: String(agent.name ?? ''),
    team: String(group.team ?? STARTER_TEAM),
    status: agent.status,
    runtime: agent.runtime ?? agent.metadata?.runtime,
    model: agent.model,
    instructions: agent.metadata?.instructions,
    skills: Array.isArray(agent.metadata?.skills) ? agent.metadata.skills : [],
    brainMcpReady: agent.brainTools?.skillInstalled === true
      && agent.brainTools?.mcpAttached === true
      && agent.brainTools?.activeToolAccess === true,
  }))).filter((agent) => agent.name);

  await Promise.all(rows
    .filter((agent) => agent.team === STARTER_TEAM && STARTER_AGENT_NAMES.includes(agent.name as StarterAgentName))
    .map(async (agent) => {
      try {
        const fetched = String(await bridgeCall('agent:getInstructions', [agent.name, agent.team]) ?? '');
        if (fetched.trim() || !agent.instructions?.trim()) agent.instructions = fetched;
      } catch {
        // A roster-provided instruction field is still useful on transitional managers.
      }
    }));
  return rows;
}

async function buildStatus(force = false): Promise<ConsumerOnboardingStatus> {
  let state = loadOnboardingState();
  const stack = await unifiedStackStatus();
  const services = stack.services.map((service) => ({
    name: service.name,
    bundled: service.bundled,
    running: service.running,
    healthy: service.healthy && (service.name !== 'manager' || stack.managerCompatibility.ready),
    ...(service.name === 'manager' && !stack.managerCompatibility.ready
      ? { error: stack.managerCompatibility.error || `Manager contract mismatch: ${stack.managerCompatibility.issues.join(', ')}` }
      : service.error ? { error: service.error } : {}),
  }));

  let groups: FleetGroup[] = [];
  let hierarchy: OnboardingHierarchySnapshot | null = null;
  let assignments: OnboardingRuntimeOption[] = [];
  let subscriptions: OnboardingSubscriptionOption[] = [];
  const diagnostics: string[] = [];
  const notices: string[] = [];
  if (!stack.managerCompatibility.ready) {
    diagnostics.push(
      stack.managerCompatibility.error
      || `Bundled Agent manager is incompatible with this IDACC build: ${stack.managerCompatibility.issues.join(', ')}`,
    );
  }

  if (stack.ready) {
    const [groupsResult, hierarchyResult, runtimeResult, subscriptionResult] = await Promise.all([
      bridgeCall('agents:allTeams', []).catch((error) => {
        diagnostics.push(`Could not read the agent roster: ${safeError(error)}`);
        return [] as FleetGroup[];
      }),
      bridgeCall('org:hierarchy', []).catch((error) => {
        diagnostics.push(`Could not read the team hierarchy: ${safeError(error)}`);
        return null;
      }),
      bridgeCall('runtime:freshness', force ? [{ force: true }] : []).catch((error) => {
        diagnostics.push(`Could not verify model routes: ${safeError(error)}`);
        return [] as RuntimeFreshnessRow[];
      }),
      subsStatus(force ? { force: true } : { staleOk: true }).catch(() => ({})),
    ]);
    groups = Array.isArray(groupsResult) ? groupsResult as FleetGroup[] : [];
    hierarchy = hierarchyResult && typeof hierarchyResult === 'object'
      ? hierarchyResult as OnboardingHierarchySnapshot
      : null;
    const runtimeRows = Array.isArray(runtimeResult) ? runtimeResult as RuntimeFreshnessRow[] : [];
    assignments = normalizedRuntimeOptions(runtimeRows);
    const incompatibleStarterRoutes = runtimeRows.filter(
      (row) => row.selectable === true && row.supportsMcp !== true,
    );
    for (const row of incompatibleStarterRoutes) {
      const label = String(row.label ?? row.runtime ?? 'Model route').trim() || 'Model route';
      notices.push(
        `${label} is connected for general agent work but not offered for the starter workspace because it does not have authoritative Brain tool-call capability.${
          row.mcpDetail ? ` ${String(row.mcpDetail).slice(0, 500)}` : ''
        }`,
      );
    }
    for (const row of runtimeRows.filter((candidate) => (
      candidate.selectable === true
      && candidate.supportsMcp === true
      && Array.isArray(candidate.mcpModels)
    ))) {
      const catalog = Array.from(new Set(
        (row.models ?? []).map((model) => String(model ?? '').trim()).filter(Boolean),
      ));
      const allowed = new Set((row.mcpModels ?? []).map((model) => String(model ?? '').trim()).filter(Boolean));
      const excluded = catalog.filter((model) => !allowed.has(model));
      if (!excluded.length) continue;
      const shown = excluded.slice(0, 5);
      notices.push(
        `${String(row.label ?? row.runtime ?? 'Model route')} remains available for general agents, but starter setup excludes ${
          shown.join(', ')
        }${excluded.length > shown.length ? ` and ${excluded.length - shown.length} more` : ''} because ${
          excluded.length === 1 ? 'that model lacks' : 'those models lack'
        } authoritative Brain tool-call capability.${row.mcpDetail ? ` ${String(row.mcpDetail).slice(0, 500)}` : ''}`,
      );
    }
    if (assignments.length === 0) {
      diagnostics.push(
        'No currently connected model route has authoritative Brain tool-call capability for the starter workspace. You can connect a Claude/Codex route, use a tool-capable Ollama model, or continue in Limited mode.',
      );
    }
    subscriptions = safeSubscriptions(subscriptionResult as unknown as Record<string, unknown>);
  }

  const agents = await agentSnapshots(groups);
  let readiness = evaluateConsumerReadiness({
    stackReady: stack.ready,
    agents,
    hierarchy,
    assignments,
    state,
  });

  // Existing production-ready profiles are adopted once rather than being
  // forced through a cosmetic wizard after an application upgrade.
  if (readiness.ready && state.mode !== 'complete' && state.mode !== 'in_progress') {
    state = completeOnboarding();
    readiness = evaluateConsumerReadiness({
      stackReady: stack.ready,
      agents,
      hierarchy,
      assignments,
      state,
    });
  }

  const phase = consumerOnboardingPhase(stack.ready, state.mode);

  return {
    phase,
    ready: phase === 'ready',
    currentReady: readiness.ready,
    needsOnboarding: state.mode !== 'complete' && state.mode !== 'limited',
    limitedMode: state.mode === 'limited',
    // Limited mode is also the recovery path when a bundled service cannot
    // start. Never trap a new user behind an uncloseable setup screen.
    canDefer: true,
    profileRoot: stack.profileRoot,
    state,
    services,
    gates: readiness.gates,
    starterAgents: readiness.starterAgents,
    assignments,
    subscriptions,
    notices,
    issues: [...diagnostics, ...readiness.issues, ...(state.lastError ? [state.lastError] : [])],
  };
}

export async function consumerOnboardingStatus(options: { force?: boolean } = {}): Promise<ConsumerOnboardingStatus> {
  const generation = statusGeneration;
  if (!options.force && cachedStatus?.generation === generation && Date.now() - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.value;
  }
  if (!options.force && statusInflight?.generation === generation) return statusInflight.promise;
  if (options.force) cachedStatus = null;
  const requestSequence = ++statusRequestSequence;
  latestStatusRequestSequence = requestSequence;
  const promise = buildStatus(Boolean(options.force))
    .then((value) => {
      if (
        statusGeneration === generation
        && latestStatusRequestSequence === requestSequence
      ) {
        cachedStatus = { at: Date.now(), generation, value };
      }
      return value;
    })
    .finally(() => {
      if (statusInflight?.promise === promise) statusInflight = null;
    });
  statusInflight = { generation, promise };
  return promise;
}

function validateAssignment(input: unknown, options: OnboardingRuntimeOption[]): OnboardingAssignment {
  if (!input || typeof input !== 'object') throw new Error('Choose a verified model route.');
  const raw = input as Partial<OnboardingAssignment>;
  const runtime = String(raw.runtime ?? '').trim();
  const model = String(raw.model ?? '').trim();
  const option = options.find((row) => row.runtime === runtime);
  if (!option) throw new Error('The selected model route is no longer available. Refresh and choose another route.');
  if (option.requiresModel && !model) {
    throw new Error('Choose an Ollama model whose tool capability was verified for the starter workspace.');
  }
  if (model && option.models.length && !option.models.includes(model)) {
    throw new Error('The selected model is not in the latest verified catalog.');
  }
  return { runtime, ...(model ? { model } : {}) };
}

export async function configureOnboardingProvider(
  raw: ConfigureOnboardingProviderInput,
): Promise<{ ok: true; provider: { name: string; kind: string; baseUrl: string; modelCount: number }; status: ConsumerOnboardingStatus }> {
  const input = raw ?? {} as ConfigureOnboardingProviderInput;
  const name = String(input.name ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Provider name must use letters, numbers, dots, dashes, or underscores.');
  }
  const kinds = new Set(['ollama', 'lmstudio', 'openai-compatible', 'anthropic', 'openai']);
  const kind = String(input.kind ?? '');
  if (!kinds.has(kind)) throw new Error('Choose a supported provider type.');
  const baseUrl = normalizeProviderBaseUrl(String(input.baseUrl ?? ''));
  const apiKey = String(input.apiKey ?? '').trim();
  const providers = await bridgeCall('providers:list', []) as ProviderRow[];
  const existing = providers.find((provider) => provider.name === name);
  if (existing && input.replace !== true) {
    const existingMatches = String(existing.kind ?? '') === kind
      && normalizeProviderBaseUrl(String(existing.baseUrl ?? '')) === baseUrl;
    if (!existingMatches) {
      throw new Error(`A different provider named "${name}" already exists. Choose another name or edit it in Settings.`);
    }
  }

  if (!existing || apiKey || input.replace === true) {
    await bridgeCall('providers:add', [{
      name,
      kind,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      needsKey: typeof input.needsKey === 'boolean'
        ? input.needsKey
        : kind === 'openai' || kind === 'anthropic' || Boolean(apiKey),
      enabled: true,
      // Promote only after the live catalog probe succeeds. A typo or an
      // unavailable endpoint must not displace a working default provider.
      default: false,
    }]);
    invalidateStatus();
  }
  const connected = await bridgeCall('providers:connect', [name]) as ProviderConnectResult;
  invalidateStatus();
  const outcome = connected?.outcome;
  const modelCount = Array.isArray(outcome?.models) ? outcome.models.length : 0;
  if (outcome?.status !== 'live' || !outcome.ok || modelCount < 1) {
    throw new Error(outcome?.message || 'The provider responded but did not expose any assignable models.');
  }
  await bridgeCall('providers:setDefault', [name]);
  invalidateStatus();
  const status = await consumerOnboardingStatus({ force: true });
  return { ok: true, provider: { name, kind, baseUrl, modelCount }, status };
}

function onboardFailure(result: OnboardResult, fallback: string): string {
  return result.steps?.find((step) => step.status === 'failed')?.error
    || result.steps?.find((step) => step.status === 'failed')?.detail
    || fallback;
}

async function probeStarterWithGrace(name: StarterAgentName, graceMs = 15_000): Promise<void> {
  const deadline = Date.now() + graceMs;
  let lastError = '';
  do {
    try {
      const probe = await bridgeCall('probeOne', [name, STARTER_TEAM]) as {
        probed?: number;
        passed?: number;
        failed?: number;
        results?: Array<{ status?: string; error?: string }>;
      };
      const failed = Number(probe.failed ?? 0);
      const passed = Number(probe.passed ?? 0);
      if (failed === 0 && passed > 0) return;
      lastError = probe.results?.find((row) => row.status !== 'ok')?.error
        || (Number(probe.probed ?? 0) < 1 ? 'the manager returned no health result' : `${failed} health check(s) failed`);
    } catch (error) {
      lastError = safeError(error);
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1_500));
  } while (Date.now() < deadline);
  throw new Error(`${name} did not become healthy: ${lastError || 'health probe timed out'}`);
}

async function markFailure(error: unknown): Promise<ConsumerOnboardingStatus> {
  updateOnboardingState({
    mode: 'in_progress',
    lastError: safeError(error),
  });
  invalidateStatus();
  return consumerOnboardingStatus();
}

async function runStarterFleetOnboardingOnce(input: unknown): Promise<ConsumerOnboardingStatus> {
  const before = await consumerOnboardingStatus({ force: true });
  if (!before.gates.stack) throw new Error('The bundled Agent manager and Brain are still starting.');
  const assignment = validateAssignment(input, before.assignments);
  beginOnboarding(assignment);
  invalidateStatus();

  try {
    const orchestration = await orchestrateMissingStarterAgents({
      listAgents: async () => {
        const groups = await bridgeCall('agents:allTeams', []) as FleetGroup[];
        return groups.flatMap((group) => (group.agents ?? []).map((agent) => ({
          id: agent.id,
          name: String(agent.name ?? ''),
          team: String(group.team ?? STARTER_TEAM),
        }))).filter((agent) => agent.name);
      },
      verifyAssignments: async (rows) => bridgeCall('runtime:verifyAssignments', [rows]) as Promise<RuntimeVerification>,
      onboardAgent: async (definition, selected) => {
        const result = await bridgeCall('onboard:run', [{
          name: definition.name,
          team: STARTER_TEAM,
          runtime: selected.runtime,
          ...(selected.model ? { model: selected.model } : {}),
          role: definition.role,
          description: definition.description,
          expertise: definition.expertise,
          skills: [...definition.skills],
          probeAfter: true,
        }]) as OnboardResult;
        return result.ok
          ? { ok: true, agentId: result.agentId }
          : { ok: false, agentId: result.agentId, error: onboardFailure(result, `Could not create ${definition.name}.`) };
      },
      onProgress: async (name, status, detail) => {
        setOnboardingAgentProgress(name, status, detail);
        invalidateStatus();
      },
    }, assignment);
    if (!orchestration.ok) return markFailure(orchestration.error || 'Starter agent creation did not finish.');

    // Creation and assignment writes invalidate the roster, but force this
    // post-mutation read as a fail-safe against any transitional bridge that
    // does not publish the expected cache-invalidation domain.
    const groups = await bridgeCall('agents:allTeams', [{ force: true }]) as FleetGroup[];
    const roster: OnboardingAgentSnapshot[] = groups.flatMap((group) => (group.agents ?? []).map((agent) => ({
      id: agent.id,
      name: String(agent.name ?? ''),
      team: String(group.team ?? STARTER_TEAM),
      status: agent.status,
      runtime: agent.runtime ?? agent.metadata?.runtime,
      model: agent.model,
    })));
    const missing = STARTER_AGENT_NAMES.filter((name) => !roster.some((agent) => agent.team === STARTER_TEAM && agent.name === name));
    if (missing.length) throw new Error(`The manager did not retain ${missing.join(', ')} after creation.`);

    // Re-running setup is an explicit user confirmation boundary. At that
    // boundary, preserve every existing starter but repair unavailable routes
    // with the freshly selected/verified assignment and restart stopped agents.
    const repairs = await orchestratePreservedStarterRepairs({
      verifyAssignments: async (rows) => bridgeCall('runtime:verifyAssignments', [rows]) as Promise<RuntimeVerification>,
      applyAssignment: async (candidate, selected) => {
        await bridgeCall('setAgentRuntime', [candidate.id, selected.runtime, candidate.team]);
        if (selected.model) {
          await bridgeCall('setAgentModel', [candidate.id, selected.model, candidate.team]);
        }
      },
      rebuildAgent: async (candidate) => {
        await rebuildStarterAgentRepairingMissingSkills(candidate);
      },
      onProgress: async (name, status, detail) => {
        setOnboardingAgentProgress(name, status, detail);
        invalidateStatus();
      },
    }, preservedStarterRepairCandidates(roster, before.assignments), assignment);
    if (!repairs.ok) return markFailure(repairs.error || 'Existing starter agent repair did not finish.');

    // Preserve existing starter agents, but reconcile the minimum neutral
    // capability set so an upgraded profile cannot be marked ready without
    // Brain MCP, catalog, identity, coordination, and task lifecycle support.
    for (const definition of STARTER_FLEET_AGENTS) {
      const agent = groups
        .find((group) => String(group.team ?? STARTER_TEAM) === STARTER_TEAM)
        ?.agents?.find((candidate) => candidate.name === definition.name);
      if (!agent) continue;
      const installed = new Set(
        (Array.isArray(agent.metadata?.skills) ? agent.metadata.skills : [])
          .map((skill) => String(skill).trim())
          .filter(Boolean),
      );
      const brainMcpReady = agent.brainTools?.skillInstalled === true
        && agent.brainTools?.mcpAttached === true
        && agent.brainTools?.activeToolAccess === true;
      let changed = false;
      let installedBrainThisPass = false;
      for (const skill of definition.skills) {
        if (installed.has(skill)) continue;
        await bridgeCall('installSkill', [skill, definition.name, STARTER_TEAM]);
        installed.add(skill);
        if (skill === 'brain') installedBrainThisPass = true;
        changed = true;
      }
      // Metadata can retain the Brain skill name while an upgraded or repaired
      // agent has lost the effective MCP attachment. Re-applying the idempotent
      // library install repairs the live skill files; rebuild then regenerates
      // the runtime MCP configuration. A subsequent healthy pass remains a
      // mutation-free no-op.
      if (!brainMcpReady && !installedBrainThisPass) {
        await bridgeCall('installSkill', ['brain', definition.name, STARTER_TEAM]);
        changed = true;
      }
      if (changed) {
        await rebuildStarterAgentRepairingMissingSkills({ name: definition.name, team: STARTER_TEAM });
      }
    }

    await bridgeCall('coordinator:set', [STARTER_TEAM, STARTER_LEAD]);
    await bridgeCall('coordinator:setPrimary', [STARTER_TEAM, STARTER_LEAD]);
    const currentSecondaries = await bridgeCall('org:getSecondaryLeads', []) as Array<{
      agent?: string;
      team?: string;
      leadsTeams?: string[];
    }>;
    const secondaryByName = new Map(currentSecondaries
      .filter((row) => String(row.agent ?? '').trim() && row.agent !== STARTER_LEAD)
      .map((row) => [String(row.agent), {
        agent: String(row.agent),
        team: String(row.team ?? STARTER_TEAM),
        leadsTeams: Array.from(new Set((row.leadsTeams ?? []).map(String).filter(Boolean))),
      }]));
    for (const agent of STARTER_VALIDATORS) {
      const current = secondaryByName.get(agent);
      secondaryByName.set(agent, {
        agent,
        team: STARTER_TEAM,
        leadsTeams: current?.leadsTeams ?? [],
      });
    }
    await bridgeCall('org:setSecondaryLeads', [[...secondaryByName.values()]]);

    for (const definition of STARTER_FLEET_AGENTS) {
      const existing = String(await bridgeCall('agent:getInstructions', [definition.name, STARTER_TEAM]) ?? '').trim();
      if (existing) continue;
      await bridgeCall('agent:setInstructions', [definition.name, definition.instructions, STARTER_TEAM]);
      await rebuildStarterAgentRepairingMissingSkills({ name: definition.name, team: STARTER_TEAM });
    }
    await bridgeCall('org:sync', [{ autoRebuild: false }]);

    for (const name of STARTER_AGENT_NAMES) {
      await probeStarterWithGrace(name);
    }

    updateOnboardingState({
      mode: 'in_progress',
      lastProbeAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      lastError: undefined,
    });
    invalidateStatus();
    const verified = await consumerOnboardingStatus({ force: true });
    if (!verified.currentReady) {
      updateOnboardingState({
        mode: 'in_progress',
        lastError: verified.issues[0] || 'The starter workspace still needs attention.',
      });
      invalidateStatus();
      return consumerOnboardingStatus({ force: true });
    }
    completeOnboarding();
    invalidateStatus();
    return consumerOnboardingStatus({ force: true });
  } catch (error) {
    return markFailure(error);
  }
}

export function runStarterFleetOnboarding(input: unknown): Promise<ConsumerOnboardingStatus> {
  if (starterRunInflight) return starterRunInflight;
  starterRunInflight = runStarterFleetOnboardingOnce(input)
    .finally(() => { starterRunInflight = null; });
  return starterRunInflight;
}

export async function deferConsumerOnboarding(): Promise<ConsumerOnboardingStatus> {
  if (starterRunInflight) throw new Error('Starter workspace setup is still running.');
  deferOnboarding();
  invalidateStatus();
  return consumerOnboardingStatus();
}

export async function resumeConsumerOnboarding(): Promise<ConsumerOnboardingStatus> {
  resumeOnboarding();
  invalidateStatus();
  return consumerOnboardingStatus();
}
