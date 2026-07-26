import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginOnboarding,
  deferOnboarding,
  loadOnboardingState,
  saveOnboardingState,
  setOnboardingAgentProgress,
} from '../src/main/onboardingStore.ts';
import {
  evaluateConsumerReadiness,
  missingStarterAgentDefinitions,
  onboardingAssignmentAvailable,
  orchestrateMissingStarterAgents,
  orchestratePreservedStarterRepairs,
  preservedStarterRepairCandidates,
} from '../src/shared/consumerOnboarding.ts';
import {
  STARTER_AGENT_NAMES,
  STARTER_CORE_SKILLS,
  STARTER_FLEET_AGENTS,
  STARTER_TEAM,
  type StarterAgentName,
} from '../src/shared/starterFleet.ts';

async function main(): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'idacc-onboarding-'));
  const statePath = join(temporary, 'profile', 'onboarding', 'state.json');
  process.env.IDACC_ONBOARDING_STATE = statePath;

  try {
  assert.equal(loadOnboardingState().mode, 'required', 'a new profile must require onboarding');
  beginOnboarding({ runtime: 'codex', model: 'gpt-test' });
  setOnboardingAgentProgress('lead', 'preserved');
  setOnboardingAgentProgress('coder', 'running');
  const persisted = loadOnboardingState();
  assert.equal(persisted.mode, 'in_progress');
  assert.deepEqual(persisted.selectedAssignment, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(persisted.agents.lead?.status, 'preserved');

  // Unknown fields (including anything credential-shaped) are discarded by
  // normalization and never become part of the profile-backed setup record.
  saveOnboardingState({ ...persisted, apiKey: 'must-not-persist' } as typeof persisted);
  assert.doesNotMatch(readFileSync(statePath, 'utf8'), /must-not-persist|apiKey/);
  if (process.platform !== 'win32') {
    // Windows privacy is enforced by the profile root ACL; POSIX mode bits
    // are not a meaningful ownership boundary there.
    assert.equal(statSync(statePath).mode & 0o777, 0o600, 'onboarding state must be private to the profile owner');
    assert.equal(statSync(join(temporary, 'profile', 'onboarding')).mode & 0o777, 0o700);
  }
  assert.equal(deferOnboarding().mode, 'limited', 'deferral must be explicit and durable');
  assert.equal(loadOnboardingState().mode, 'limited');

  for (const definition of STARTER_FLEET_AGENTS) {
    assert.ok(STARTER_CORE_SKILLS.every((skill) => definition.skills.includes(skill)));
    assert.equal(definition.skills.includes('wallet'), false);
    assert.equal(definition.skills.includes('xmtp'), false);
    assert.equal(definition.skills.includes('idagents-admin-control'), false);
  }
  assert.equal(STARTER_FLEET_AGENTS.find((agent) => agent.name === 'lead')?.skills.includes('team-coordinator'), true);
  assert.equal(STARTER_FLEET_AGENTS.find((agent) => agent.name === 'coder')?.skills.includes('team-coordinator'), false);
  const exactLocalOption = {
    runtime: 'provider:ollama',
    label: 'Local · Ollama',
    models: ['tool-model'],
    source: 'provider',
    requiresModel: true,
  };
  assert.equal(
    onboardingAssignmentAvailable(
      { name: 'lead', team: STARTER_TEAM, runtime: 'provider:ollama' },
      [exactLocalOption],
    ),
    false,
    'an implicit local default must not satisfy model-specific starter evidence',
  );
  assert.equal(
    onboardingAssignmentAvailable(
      { name: 'lead', team: STARTER_TEAM, runtime: 'provider:ollama', model: 'tool-model' },
      [exactLocalOption],
    ),
    true,
  );

  const onlyLead = [{ name: 'lead', team: STARTER_TEAM }];
  assert.deepEqual(
    missingStarterAgentDefinitions(onlyLead).map((row) => row.name),
    ['coder', 'researcher'],
    'existing starter agents must be preserved',
  );

  let failedVerificationOnboards = 0;
  const failedProgress: Array<[StarterAgentName, string]> = [];
  const rejected = await orchestrateMissingStarterAgents({
    listAgents: async () => onlyLead,
    verifyAssignments: async (rows) => ({
      ok: false,
      rows: rows.map((row) => ({ name: row.name, ok: false, detail: 'route unavailable' })),
    }),
    onboardAgent: async () => {
      failedVerificationOnboards += 1;
      return { ok: true };
    },
    onProgress: (name, status) => { failedProgress.push([name, status]); },
  }, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(rejected.ok, false);
  assert.equal(failedVerificationOnboards, 0, 'no creation boundary may be crossed after failed assignment verification');
  assert.ok(failedProgress.some(([name, status]) => name === 'lead' && status === 'preserved'));
  assert.ok(failedProgress.some(([name, status]) => name === 'coder' && status === 'failed'));

  const createdNames: StarterAgentName[] = [];
  const createdSkills = new Map<StarterAgentName, readonly string[]>();
  let verificationRows: string[] = [];
  const created = await orchestrateMissingStarterAgents({
    listAgents: async () => onlyLead,
    verifyAssignments: async (rows) => {
      verificationRows = rows.map((row) => row.name);
      return { ok: true, rows: rows.map((row) => ({ name: row.name, ok: true })) };
    },
    onboardAgent: async (definition) => {
      createdNames.push(definition.name);
      createdSkills.set(definition.name, definition.skills);
      return { ok: true, agentId: `id-${definition.name}` };
    },
  }, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(created.ok, true);
  assert.deepEqual(verificationRows, ['coder', 'researcher']);
  assert.deepEqual(createdNames, ['coder', 'researcher'], 'only missing starter agents may be created');
  assert.deepEqual(createdSkills.get('coder'), [...STARTER_CORE_SKILLS]);
  assert.deepEqual(createdSkills.get('researcher'), [...STARTER_CORE_SKILLS]);

  let idempotentVerificationCalls = 0;
  let idempotentOnboards = 0;
  const idempotent = await orchestrateMissingStarterAgents({
    listAgents: async () => STARTER_AGENT_NAMES.map((name) => ({ name, team: STARTER_TEAM })),
    verifyAssignments: async () => {
      idempotentVerificationCalls += 1;
      return { ok: true, rows: [] };
    },
    onboardAgent: async () => {
      idempotentOnboards += 1;
      return { ok: true };
    },
  }, { runtime: 'codex' });
  assert.equal(idempotent.ok, true);
  assert.equal(idempotentVerificationCalls, 0);
  assert.equal(idempotentOnboards, 0, 'a complete roster must be a no-op');

  const verifiedOptions = [{ runtime: 'codex', label: 'Codex', models: ['gpt-test'], source: 'live' }];
  const validStarterRoster = STARTER_AGENT_NAMES.map((name) => ({
    id: `id-${name}`,
    name,
    team: STARTER_TEAM,
    status: 'running',
    runtime: 'codex',
    model: 'gpt-test',
    skills: [...(STARTER_FLEET_AGENTS.find((definition) => definition.name === name)?.skills ?? [])],
  }));

  const staleRoster = validStarterRoster.map((agent) => (
    agent.name === 'lead'
      ? { ...agent, runtime: 'removed-runtime', model: 'removed-model' }
      : agent
  ));
  const staleCandidates = preservedStarterRepairCandidates(staleRoster, verifiedOptions);
  assert.equal(staleCandidates.find((candidate) => candidate.name === 'lead')?.repairAssignment, true);
  const staleVerified: string[] = [];
  const staleAssignments: string[] = [];
  const staleRebuilds: string[] = [];
  const staleRepair = await orchestratePreservedStarterRepairs({
    verifyAssignments: async (rows) => {
      staleVerified.push(...rows.map((row) => `${row.name}:${row.runtime}:${row.model}`));
      return { ok: true, rows: rows.map((row) => ({ name: row.name, ok: true })) };
    },
    applyAssignment: async (agent, assignment) => {
      staleAssignments.push(`${agent.name}:${assignment.runtime}:${assignment.model}`);
    },
    rebuildAgent: async (agent) => {
      staleRebuilds.push(agent.name);
    },
  }, staleCandidates, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(staleRepair.ok, true);
  assert.deepEqual(staleVerified, ['lead:codex:gpt-test']);
  assert.deepEqual(staleAssignments, ['lead:codex:gpt-test']);
  assert.deepEqual(staleRebuilds, ['lead'], 'a stale preserved starter must rebuild after assignment repair');

  let rejectedRepairWrites = 0;
  const rejectedRepair = await orchestratePreservedStarterRepairs({
    verifyAssignments: async (rows) => ({
      ok: false,
      rows: rows.map((row) => ({ name: row.name, ok: false, detail: 'selected route is unavailable' })),
    }),
    applyAssignment: async () => {
      rejectedRepairWrites += 1;
    },
    rebuildAgent: async () => {
      rejectedRepairWrites += 1;
    },
  }, staleCandidates, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(rejectedRepair.ok, false);
  assert.equal(rejectedRepairWrites, 0, 'failed verification must block assignment and rebuild mutations');

  const inactiveRoster = validStarterRoster.map((agent) => (
    agent.name === 'coder' ? { ...agent, status: 'stopped' } : agent
  ));
  const inactiveCandidates = preservedStarterRepairCandidates(inactiveRoster, verifiedOptions);
  assert.equal(inactiveCandidates.find((candidate) => candidate.name === 'coder')?.inactive, true);
  let inactiveVerificationCalls = 0;
  let inactiveAssignmentWrites = 0;
  const inactiveRebuilds: string[] = [];
  const inactiveRepair = await orchestratePreservedStarterRepairs({
    verifyAssignments: async () => {
      inactiveVerificationCalls += 1;
      return { ok: true, rows: [] };
    },
    applyAssignment: async () => {
      inactiveAssignmentWrites += 1;
    },
    rebuildAgent: async (agent) => {
      inactiveRebuilds.push(agent.name);
    },
  }, inactiveCandidates, { runtime: 'codex', model: 'gpt-test' });
  assert.equal(inactiveRepair.ok, true);
  assert.equal(inactiveVerificationCalls, 0, 'a valid preserved assignment must not be rewritten');
  assert.equal(inactiveAssignmentWrites, 0);
  assert.deepEqual(inactiveRebuilds, ['coder'], 'an inactive preserved starter must be explicitly rebuilt');

  const ready = evaluateConsumerReadiness({
    stackReady: true,
    assignments: verifiedOptions,
    state: loadOnboardingState(),
    agents: STARTER_AGENT_NAMES.map((name) => ({
      id: `id-${name}`,
      name,
      team: STARTER_TEAM,
      status: 'running',
      runtime: 'codex',
      model: 'gpt-test',
      instructions: `instructions for ${name}`,
      skills: [...(STARTER_FLEET_AGENTS.find((definition) => definition.name === name)?.skills ?? [])],
      brainMcpReady: true,
    })),
    hierarchy: {
      primary: { team: STARTER_TEAM, agent: 'lead' },
      coordinators: { [STARTER_TEAM]: 'lead' },
      secondaries: [
        { team: STARTER_TEAM, agent: 'coder', leadsTeams: [] },
        { team: STARTER_TEAM, agent: 'researcher', leadsTeams: [] },
      ],
    },
  });
  assert.equal(ready.ready, true);
  assert.ok(Object.values(ready.gates).every(Boolean));
  assert.ok(ready.starterAgents.every((agent) => agent.skillsReady && agent.brainMcpReady));

  console.log('consumer onboarding smoke: ok');
  } finally {
    delete process.env.IDACC_ONBOARDING_STATE;
    rmSync(temporary, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
