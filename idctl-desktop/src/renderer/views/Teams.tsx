import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { call, agentsLeadFirst, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import { buildProviderModelLanes, offerableRuntimes, runtimeDisplayLabel, runtimePickerGroup, type RuntimeModelLane } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import type { ConfigEntry, DeployPreflight, DesignedTeam, LibrarySkillEntry, McpServerSpec, TeamTemplate } from '../../../../idctl/src/api/client.ts';
import type { OnboardPlan, OnboardResult } from '../../../../idctl/src/api/onboard.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';
import { parseTeamSpec, slugName, isReservedName } from '../../../../idctl/src/api/teamSpec.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { TeamGraph, type GraphSelection } from './TeamGraph.tsx';
import { Health } from './Health.tsx';
import {
  getRuntimeCatalogSnapshot,
  loadRuntimeCatalogSnapshot,
  primeRuntimeCatalogSnapshot,
  type ManagedRuntimeStatus,
  type RuntimeCatalogProvider as ProviderRow,
} from '../runtimeCatalogCache.ts';

type RuntimeVerificationRow = {
  name: string;
  runtime: string;
  label: string;
  model?: string;
  ok: boolean;
  detail: string;
  source: 'harness' | 'provider';
  provider?: string;
  modelCount?: number;
};
type RuntimeVerificationReport = {
  ok: boolean;
  checkedAt: number;
  rows: RuntimeVerificationRow[];
  refreshedCatalog: Record<string, string[]>;
  providers: ProviderRow[];
};
type HrBuildSkillCatalogCache = {
  version: number;
  skillCatalog: string[];
};
let hrBuildSkillCatalogCache: HrBuildSkillCatalogCache | null = null;

type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
type GoalPriority = 'primary' | 'secondary' | 'general';
type GoalSummary = { id: string; title: string; status: GoalStatus; priority?: GoalPriority; agent?: string; team: string; updatedAt: number; autopilot?: boolean };
type Goal = GoalSummary & {
  idea: string;
  content: string;
  driver?: { lastRunAt?: number; taskRefs?: string[]; note?: string };
  createdAt: number;
};
type RelayMode = 'permissive' | 'all' | 'select' | 'none';
/** Status of a post-build wiring step (coordinator/relay) in the Team Builder. */
type PostStat = 'running' | 'ok' | 'failed';
type TeamSource =
  | { kind: 'default'; name: 'default' }
  | { kind: 'template'; name: string }
  | { kind: 'config'; name: string };
type TeamAgentsGroup = { team: string; agents: Agent[] };
type TeamSnapshot = { exists: boolean; agents: Agent[]; running: number; total: number; rosterKnown: boolean };
type HrHierarchy = { primary: { team: string; agent: string } | null; coordinators: Record<string, string> };
type OrgCfg = { enabled?: boolean; autoRebuild?: boolean };
type SecLead = { agent: string; team: string; leadsTeams: string[] };
type TeamBlueprint = { id: string; team: string; label: string; description: string; spec: string };
type BlueprintCoverage = TeamBlueprint & { present: number; total: number; missing: string[]; complete: boolean };
type HrFocus = 'route-hierarchy' | 'health';
type LeadershipBackbone = {
  ready: boolean;
  missingAgents: string[];
  primaryOk: boolean;
  coordinatorOk: boolean;
  primaryLabel: string;
  coordinatorLabel: string;
};

const PRIMARY_TEAM = 'default';
const DEFAULT_LEAD = 'lead';
const DEFAULT_VALIDATORS = ['coder', 'researcher'];
const DEFAULT_BACKBONE_AGENTS = [DEFAULT_LEAD, ...DEFAULT_VALIDATORS];
const GOAL_PRIORITIES: GoalPriority[] = ['primary', 'secondary', 'general'];
const GOAL_PRIORITY_LABEL: Record<GoalPriority, string> = { primary: 'Primary', secondary: 'Secondary', general: 'General' };
function goalPriority(input?: GoalPriority): GoalPriority {
  return input === 'primary' || input === 'secondary' || input === 'general' ? input : 'general';
}
function validatorRank(agent: string): number {
  const i = DEFAULT_VALIDATORS.indexOf(slugName(agent));
  return i === -1 ? DEFAULT_VALIDATORS.length : i;
}
function sortSecondaryLeads(list: SecLead[]): SecLead[] {
  return [...list].sort((a, b) => validatorRank(a.agent) - validatorRank(b.agent) || slugName(a.agent).localeCompare(slugName(b.agent)));
}
function normalizeSecondaryRows(list: SecLead[]): SecLead[] {
  const byAgent = new Map<string, SecLead>();
  for (const agent of DEFAULT_VALIDATORS) byAgent.set(agent, { agent, team: PRIMARY_TEAM, leadsTeams: [] });
  for (const row of list) {
    const agent = slugName(row.agent);
    if (!agent || agent === DEFAULT_LEAD) continue;
    const existing = byAgent.get(agent) ?? { agent, team: PRIMARY_TEAM, leadsTeams: [] };
    existing.leadsTeams = Array.from(new Set([
      ...existing.leadsTeams,
      ...(row.leadsTeams ?? []).map((t) => String(t).trim()).filter((t) => t && t !== PRIMARY_TEAM && t !== 'public'),
    ])).sort((a, b) => a.localeCompare(b));
    byAgent.set(agent, existing);
  }
  return sortSecondaryLeads(Array.from(byAgent.values()));
}
function isReservedEmptyPublicTeam(team: { name: string; agentCount?: number }, groups: TeamAgentsGroup[]): boolean {
  if (team.name.trim().toLowerCase() !== 'public') return false;
  const rosterCount = groups.find((g) => g.team.trim().toLowerCase() === 'public')?.agents.length ?? 0;
  return rosterCount === 0 && Number(team.agentCount ?? 0) === 0;
}
function isDefaultBackboneAgent(team: string, agent: string): boolean {
  return team === PRIMARY_TEAM && DEFAULT_BACKBONE_AGENTS.includes(slugName(agent));
}
function isDefaultLead(team: string, agent: string): boolean {
  return team === PRIMARY_TEAM && slugName(agent) === DEFAULT_LEAD;
}
const STANDARD_TEAM_ALIASES: Record<string, string> = {
  operations: 'ops-team',
  engineering: 'engineering-team',
  onchain: 'onchain-execution',
  security: 'technology-security',
};
const RECOMMENDED_TEAM_BLUEPRINTS: TeamBlueprint[] = [
  {
    id: 'default-leadership',
    team: 'default',
    label: 'Default leadership',
    description: 'primary lead plus coder/researcher validators',
    spec: `team: default

- **lead** - Primary lead. Receives operator intent, compresses it into an objective, checks it against the active primary goal first and secondary goals second, routes execution work directly to the appropriate external team lead, and returns only validated summaries. Does not use default/coder or default/researcher as execution workers.
- **coder** - Secondary validation lead only. Validates completed implementation, operations, code quality, reproducibility, build/test evidence, and release readiness before work returns to default/lead.
- **researcher** - Secondary validation lead only. Validates completed evidence, reasoning, sourcing, policy fit, completeness, architecture review, and runbook quality before work returns to default/lead.`,
  },
  {
    id: 'operations-team',
    team: 'ops-team',
    label: 'Operations team',
    description: 'git, release, monitoring, maintenance, wiki/content ops',
    spec: `team: ops-team

- **ops-lead** - Coordinator for operational work. Breaks requests into specialist tasks, delegates in parallel, reports one concise status, and escalates production deploys, deletes, mainnet, or release ambiguity.
- **git-manager** - Owns non-destructive git hygiene for project repositories: status, intentional staging, commits, branch sync, conflict surfacing, and push coordination.
- **deployer** - Runs build/test/release readiness, cuts versioned releases, prepares deploys, and confirms before production changes.
- **monitor** - Watches service and agent health, probes failures, tails logs, and reports incidents with next steps.
- **maintainer** - Handles low-risk dependency updates, cleanup, maintenance scripts, and reversible chores.
- **content-ops** - Keeps IDACC wiki and release documentation current with shipped behavior.
- **content-moderator** - Performs safety, compliance, and policy-fit screening before content is published or routed onward.`,
  },
  {
    id: 'engineering-team',
    team: 'engineering-team',
    label: 'Engineering team',
    description: 'product engineering, testing, architecture, delivery',
    spec: `team: engineering-team

- **engineering-lead** - Coordinator for implementation objectives. Distills product or platform goals into independent work packets, delegates to engineers, collects summaries, and returns accomplishments for default-team validation.
- **frontend-engineer** - Builds and verifies polished UI, stateful controls, accessibility, responsive layout, and browser behavior.
- **backend-engineer** - Owns services, APIs, persistence, migrations, integrations, and runtime reliability.
- **qa-engineer** - Designs focused test coverage, reproduces bugs, validates fixes, and checks release readiness.
- **architect** - Reviews system boundaries, data flow, scaling constraints, and cross-team technical tradeoffs.`,
  },
  {
    id: 'research-team',
    team: 'research',
    label: 'Research team',
    description: 'source gathering, analysis, verification, synthesis',
    spec: `team: research

- **research-lead** - Coordinator for research objectives. Breaks questions into sub-questions, delegates gathering, analysis, verification, and writing, then returns a verified findings packet.
- **web-researcher** - Finds current authoritative sources, extracts facts with dates and URLs, and avoids unsupported analysis.
- **analyst** - Compares evidence, evaluates tradeoffs, identifies gaps, and labels confidence levels.
- **fact-checker** - Independently verifies claims against sources and marks supported, weak, or unsupported statements.
- **writer** - Turns verified findings into a clear report for the intended audience with concise citations.`,
  },
  {
    id: 'onchain-team',
    team: 'onchain-execution',
    label: 'Onchain team',
    description: 'wallets, contracts, protocol research, transaction safety',
    spec: `team: onchain-execution

- **onchain-lead** - Coordinator for wallet, contract, protocol, and transaction-safety objectives. Delegates specialist work and escalates irreversible or value-moving actions.
- **wallet-engineer** - Reviews wallet flows, account abstraction, session keys, signing boundaries, and transaction simulation requirements.
- **contract-auditor** - Reviews smart contracts, upgrade paths, permissions, invariants, and adversarial failure modes.
- **protocol-researcher** - Tracks chain/protocol behavior, standards, infrastructure providers, and ecosystem changes with sourced findings.
- **risk-analyst** - Evaluates operational, custody, MEV, oracle, bridge, and production-risk posture before onchain execution.`,
  },
];

const HB_INTERVALS = [
  { label: '5 min', s: 300 },
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '6 hours', s: 21600 },
  { label: '24 hours', s: 86400 },
];
function runtimeLabel(r: string): string {
  return runtimeDisplayLabel(r);
}
function providerLaneBuildLabel(lane: RuntimeModelLane): string {
  const count = lane.models.length === 1 ? '1 model' : `${lane.models.length} models`;
  return `${lane.label} - ${count}`;
}

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function okAgentDraft(s: string): string {
  const t = (s || '').trim();
  return t && t !== '(empty reply)' && t !== '(no reply)' ? t : '';
}
function clipText(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function newGoalId(): string {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isRunnableAgent(a: Agent): boolean {
  return !!a.status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(a.status);
}

type HrAgentCandidate = Agent & { team?: string };
function sortedKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}

function blueprintAgentNames(bp: TeamBlueprint): string[] {
  return [...bp.spec.matchAll(/-\s+\*\*([^*]+)\*\*/g)].map((m) => slugName(m[1])).filter(Boolean);
}

function blueprintCoverage(agents: HrAgentCandidate[], bp: TeamBlueprint): BlueprintCoverage {
  const existing = new Set(agents.filter((a) => (a.team ?? PRIMARY_TEAM) === bp.team).map((a) => slugName(a.name)));
  const expected = blueprintAgentNames(bp);
  const missing = expected.filter((name) => !existing.has(name));
  return { ...bp, total: expected.length, present: expected.length - missing.length, missing, complete: expected.length > 0 && missing.length === 0 };
}

function assessLeadershipBackbone(agents: HrAgentCandidate[], hierarchy: HrHierarchy): LeadershipBackbone {
  const defaultAgents = new Set(agents.filter((a) => (a.team ?? PRIMARY_TEAM) === PRIMARY_TEAM).map((a) => slugName(a.name)));
  const missingAgents = DEFAULT_BACKBONE_AGENTS.filter((name) => !defaultAgents.has(name));
  const primaryOk = hierarchy.primary?.team === PRIMARY_TEAM && hierarchy.primary.agent === DEFAULT_LEAD;
  const coordinator = hierarchy.coordinators[PRIMARY_TEAM] ?? (hierarchy.primary?.team === PRIMARY_TEAM ? hierarchy.primary.agent : '');
  const coordinatorOk = coordinator === DEFAULT_LEAD;
  return {
    ready: missingAgents.length === 0 && primaryOk && coordinatorOk,
    missingAgents,
    primaryOk,
    coordinatorOk,
    primaryLabel: primaryLabel(hierarchy.primary),
    coordinatorLabel: coordinator ? `${PRIMARY_TEAM}/${coordinator}` : '(none)',
  };
}

function leadershipBackboneIssues(backbone: LeadershipBackbone): string[] {
  return [
    ...backbone.missingAgents.map((name) => `${PRIMARY_TEAM}/${name}`),
    ...(backbone.coordinatorOk ? [] : [`coordinator ${backbone.coordinatorLabel} -> ${PRIMARY_TEAM}/${DEFAULT_LEAD}`]),
    ...(backbone.primaryOk ? [] : [`primary ${backbone.primaryLabel} -> ${PRIMARY_TEAM}/${DEFAULT_LEAD}`]),
  ];
}
function agentNameKey(agents: Agent[]): string {
  return sortedKey(agents.map((a) => slugName(a.name)));
}
function metadataDelegates(a: { metadata?: unknown }): string[] | null {
  const raw = (a.metadata as { delegates_to?: unknown } | undefined)?.delegates_to;
  return Array.isArray(raw) ? raw.map(String) : null;
}
function hrAgentStamp(a: HrAgentCandidate, fallbackTeam = 'default'): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    team: a.team ?? fallbackTeam,
    runtime: a.runtime ?? '',
    model: a.model ?? '',
    status: a.status ?? '',
    health: a.health ?? '',
    delegates: metadataDelegates(a),
  });
}
function hierarchyStamp(h: HrHierarchy): string {
  return JSON.stringify({
    primary: h.primary ? [h.primary.team, h.primary.agent] : null,
    coordinators: Object.entries(h.coordinators ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
}
function orgConfigStamp(c: OrgCfg): string {
  return JSON.stringify({ enabled: c.enabled !== false, autoRebuild: c.autoRebuild !== false });
}
function secondaryStamp(list: { agent: string; team: string; leadsTeams: string[] }[]): string {
  return JSON.stringify(list.map((s) => ({
    agent: s.agent,
    team: s.team,
    leadsTeams: [...new Set(s.leadsTeams ?? [])].sort((a, b) => a.localeCompare(b)),
  })).sort((a, b) => `${a.team}/${a.agent}`.localeCompare(`${b.team}/${b.agent}`)));
}
async function freshHrGroups(): Promise<TeamAgentsGroup[]> {
  return call<TeamAgentsGroup[]>('agents:allTeams').catch(() => []);
}
function agentsForTeam(groups: TeamAgentsGroup[], team: string): Agent[] {
  return groups.find((g) => g.team === team)?.agents ?? [];
}
function teamSnapshotStamp(snap: TeamSnapshot): string {
  return JSON.stringify({
    exists: snap.exists,
    rosterKnown: snap.rosterKnown,
    total: snap.total,
    agents: snap.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status ?? '',
      runtime: a.runtime ?? '',
      model: a.model ?? '',
    })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  });
}
function teamSnapshotSummary(snap: TeamSnapshot): string {
  const sample = snap.agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((a) => `${a.name}${a.status ? ` (${a.status})` : ''}`);
  return sample.length
    ? `${sample.join(', ')}${snap.agents.length > sample.length ? `, ...and ${snap.agents.length - sample.length} more` : ''}`
    : 'none';
}
function findHrAgent(groups: TeamAgentsGroup[], team: string, ref: { id?: string; name: string }): Agent | undefined {
  const agents = agentsForTeam(groups, team);
  return (ref.id ? agents.find((a) => a.id === ref.id) : undefined) ?? agents.find((a) => a.name === ref.name);
}
function resolveHrManagerAgent(store: FleetStore): { name: string; team?: string } | null {
  const candidates: HrAgentCandidate[] = (store.allAgents.length ? store.allAgents : store.agents).filter(isRunnableAgent);
  const exactMatches = candidates.filter((a) => /^hr[-_]?manager$/i.test(a.name));
  const exact = exactMatches.find((a) => a.team === 'legal') ?? exactMatches[0];
  if (exact) return { name: exact.name, team: exact.team ?? store.team };
  const descriptive = candidates.find((a) => /(^|[-_])hr($|[-_])|human[-_]?resources/i.test(a.name));
  if (descriptive) return { name: descriptive.name, team: descriptive.team ?? store.team };
  return null;
}

async function askHrManagerToDraft(store: FleetStore, prompt: string, owner?: { name: string; team?: string } | null): Promise<string> {
  const hr = owner ?? resolveHrManagerAgent(store);
  if (!hr) throw new Error('no active HR manager agent found');
  const activeTeam = store.team ?? 'default';
  const target = hr.team && hr.team !== activeTeam ? `${hr.team}/${hr.name}` : hr.name;
  const draft = okAgentDraft(await call<string>('dispatch', `/ask ${target} ${qArg(prompt)}`));
  if (!draft) throw new Error(`${target} returned an empty draft`);
  return draft;
}

function modeOf(delegates: string[] | null): RelayMode {
  if (delegates === null) return 'permissive';
  if (delegates.includes('*')) return 'all';
  if (delegates.length === 0) return 'none';
  return 'select';
}

// Stable identity for a delegates_to value so we can detect unsaved changes.
function relayKey(d: string[] | null): string {
  if (d === null) return 'permissive';
  if (d.length === 0) return 'none';
  return [...d].sort().join(',');
}
function relayBlocksAll(d: string[] | null): boolean {
  return Array.isArray(d) && !d.includes('*') && d.length === 0;
}

// Human-readable summary of a persisted delegates_to value.
function describeRelay(d: string[] | null): string {
  if (d === null) return 'permissive — any team';
  if (d.includes('*')) return 'all teams';
  if (d.length === 0) return 'blocked — no teams';
  return d.join(', ');
}

function describeAgentRelay(d: string[] | null, teamPolicy: string[] | null): string {
  return d === null ? `inherit team (${describeRelay(teamPolicy)})` : describeRelay(d);
}

function currentAgentDelegates(a: { metadata?: unknown }): string[] | null {
  return metadataDelegates(a);
}

function primaryLabel(primary: { team: string; agent: string } | null): string {
  return primary ? `${primary.team}/${primary.agent}` : '(none)';
}

/**
 * Shared delegation guidance appended to every coordinator directive (the generic preset and
 * the roster-aware one the builder generates).
 *
 * GUARD — PARALLEL-FIRST, DO NOT REVERT TO SEQUENTIAL. An earlier version told the lead to
 * "STRONGLY PREFER synchronous /talk-to" and "prefer a few sequential /talk-to calls over a
 * fragile async fan-out". Because /talk-to BLOCKS until each reply, that serialized the
 * teammates — two subscription agents could never run at the same time through the lead, even
 * though the manager + the harness fully support concurrent subscription processes. The fix is
 * to fan INDEPENDENT work out in parallel (async /news-to --trigger to all owners at once) and
 * reserve /talk-to only for genuinely DEPENDENT chains. Keep it this way.
 */
const COORDINATION_TAIL = `PARALLELISM — fire INDEPENDENT work off at the SAME TIME (this is the default):
- When sub-tasks DON'T depend on each other, dispatch them to their owners IN PARALLEL with async **/news-to <agent> "<task>" (trigger:true)** — send ALL of them first, back-to-back, so the teammates run concurrently on their own processes/subscriptions. Do NOT /talk-to independent tasks one-by-one — that blocks and forces them to run sequentially.
- Then COLLECT: check **/news** on a cadence (every ~20-30s) up to a sensible deadline, summarizing each reply the moment it lands. Attach a tracked task to each async hand-off and mark it done when you collect the reply. If a teammate hasn't answered by the deadline, re-send ONCE or report it blocked — never loop on /news forever.
- Use synchronous **/talk-to** ONLY for a DEPENDENT step (you need one teammate's OUTPUT before the next can start) or a single quick hand-off — it blocks until the reply, which is right for a chain but WRONG for parallel work. For a one-off /talk-to, omit the tracked \`task\` field (the reply is inline).
- For a sub-task in ANOTHER team's domain, hand it to that team's lead with **/ask <team>/<lead>** (subject to your team's relay policy); fire those in parallel too. If a team isn't reachable, say so — don't silently absorb its work.

Compressing, decomposing, delegating INDEPENDENT work IN PARALLEL, and summarizing — NOT doing the work yourself — is your primary job as the lead. Do the work yourself only for trivial one-liners, or when delegation would clearly be slower with no benefit (and say so in one line).`;

const VALIDATION_RETURN_PATH = `RETURN PATH — substantial completed work should flow through the default-team validators before it is treated as final:
- Send a concise completed-work packet to **default/coder** and **default/researcher** with \`/ask default/coder "<completed work + summary>"\` and \`/ask default/researcher "<completed work + summary>"\`.
- Ask coder to validate implementation, operations, code quality, and reproducibility. Ask researcher to validate evidence, reasoning, sourcing, policy fit, and completeness.
- Validators judge the accomplishments against the active primary goal first, then secondary goals, then the original objective.
- If either validator bounces the work back, refine with the responsible teammate or team lead and repeat the validation pass. Do not dump unvalidated raw work straight to **default/lead** unless the operator explicitly asks for an unvalidated fast path.`;

const FIRST_RUN_LEAD_TARGETS = ['engineering-team/engineering-lead', 'ops-team/ops-lead', 'research/research-lead', 'onchain-execution/onchain-lead'];
const OPTIONAL_LEAD_TARGETS = ['legal/general-counsel', 'technology-security/security-router'];

/** Ready-made "act as the team coordinator" directive with generic coder/researcher
 *  teammates — used as the Team Builder fallback when no explicit teammates exist. */
const COORDINATOR_PRESET = `## Team coordination (you are the lead)

You are this team's COORDINATOR. Your job is NOT to do the work yourself — it is to COMPRESS, BREAK UP, DELEGATE, and SUMMARIZE. You have specialist teammates — by default **coder** (implementation, code, file changes, running commands) and **researcher** (research, analysis, documentation, investigation) — and you can hand work to OTHER teams' leads too.

For any NON-TRIVIAL request, work in this order, and narrate each step as you go:

1. **Compress** — distill the request to its essential intent, deliverable, and hard constraints; strip the noise. State it back in 1-2 lines so the scope is unambiguous before any work starts.
2. **Break it up** — decompose the compressed request into the smallest independent sub-tasks. For each, name the ONE owner best suited to it, and keep it self-contained (include only the context that owner needs).
3. **Delegate** — hand each sub-task to its owner: a teammate on your team (implementation/code → **coder**, research/analysis/docs → **researcher**) via the **inter-agent** skill, or another team's lead via **/ask <team>/<lead>** when the work is in that team's domain. **Fan INDEPENDENT sub-tasks out IN PARALLEL** (async /news-to --trigger to each owner at once, so they run concurrently); chain with synchronous /talk-to ONLY the ones that need another's output.
4. **Summarize step by step** — as EACH delegate replies, compress its result to 1-3 lines and post that running update immediately; don't wait for everything to finish. Keep a visible tally of what's done, what's pending, and any blockers.
5. **Close out** — assemble the step summaries into one coherent answer, stating who did what.

${VALIDATION_RETURN_PATH}

${COORDINATION_TAIL}`;

const DEFAULT_PRIMARY_PRESET = `## Default primary lead coordination

You are the PRIMARY LEAD for the whole fleet. The operator talks to you first; your job is to compress intent into an objective, compare it to the active primary goal first and secondary goals second, then route scoped execution work to the correct team lead.

Default-team **coder** and **researcher** are your validation pair — NOT execution workers. Do not hand them implementation or research tasks to perform. Use them only after a team lead returns completed work.

For any NON-TRIVIAL request:

1. **Compress** — restate the objective, success criteria, and hard constraints in 1-2 lines.
2. **Route objectives** — choose an existing corresponding team lead. First-run starter leads are ${FIRST_RUN_LEAD_TARGETS.map((target) => `**${target}**`).join(', ')}. Optional leads such as ${OPTIONAL_LEAD_TARGETS.map((target) => `**${target}**`).join(', ')} are valid only after those teams exist and are current in HR Manager. Hand each lead a scoped objective with \`/ask <team>/<lead> "<objective>"\`.
3. **Decompose at the edge** — each team lead owns breaking its objective into member-owned tasks, delegating independent work in parallel, collecting member summaries, and refining the result.
4. **Validate on return** — when completed work comes back, send the completed-work packet to both default-team validators and wait for their findings before treating it as final.
5. **Bounce or close** — if either validator rejects the work, return the concrete feedback to the responsible team lead for another refinement cycle. If both validate it, consolidate the findings for the operator.

${VALIDATION_RETURN_PATH}

${COORDINATION_TAIL}`;

/** Roster-aware coordinator directive — names the ACTUAL teammates created in the
 *  batch so the lead delegates to agents that exist (falls back to the generic
 *  coder/researcher preset when there are no teammates). */
function coordinatorPresetFor(team: string, teammates: { name: string; role: string }[]): string {
  if (team === PRIMARY_TEAM) return DEFAULT_PRIMARY_PRESET;
  if (!teammates.length) return COORDINATOR_PRESET;
  const inline = teammates.map((t) => `**${t.name}**${t.role ? ` (${t.role})` : ''}`).join(', ');
  const bullets = teammates.map((t) => `   - **${t.name}**${t.role ? ` — ${t.role}` : ''}`).join('\n');
  return `## Team coordination (you are the lead)

You are this team's COORDINATOR. Your job is NOT to do the work yourself — it is to COMPRESS, BREAK UP, DELEGATE, and SUMMARIZE. Your specialist teammates are: ${inline}. You can also hand work to OTHER teams' leads when it belongs to their domain.

For any NON-TRIVIAL request, work in this order, and narrate each step as you go:

1. **Compress** — distill the request to its essential intent, deliverable, and hard constraints; strip the noise. State it back in 1-2 lines so the scope is unambiguous before any work starts.
2. **Break it up** — decompose into the smallest independent sub-tasks; for each, pick the ONE owner best suited to it and keep it self-contained.
3. **Delegate** — hand each sub-task to its owner via the **inter-agent** skill (or **/ask <team>/<lead>** for another team's domain). **Fan INDEPENDENT sub-tasks out IN PARALLEL** (async /news-to --trigger to each at once, so they run concurrently); use synchronous /talk-to only for steps that depend on another's output:
${bullets}
4. **Summarize step by step** — as EACH delegate replies, compress its result to 1-3 lines and post that running update immediately; don't wait for everything to finish. Track what's done, pending, and blocked.
5. **Close out** — assemble the step summaries into one coherent answer, stating who did what.

${VALIDATION_RETURN_PATH}

${COORDINATION_TAIL}`;
}

export function Teams({ store, focus, onFocusHandled, navigate }: { store: FleetStore; focus?: HrFocus; onFocusHandled?: () => void; navigate?: (target: string) => void }) {
  const syncVersion = useSyncVersion(['goals', 'work', 'org', 'agents']);
  const hrStructureVersion = useSyncVersion(['org', 'agents', 'teams']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const hrOwner = useMemo(() => resolveHrManagerAgent(store), [store.allAgents, store.agents, store.team]);

  // HR pillars as tabs + the live structure graph.
  const [tab, setTab] = useState<'structure' | 'health' | 'build' | 'route'>('structure');
  const hrRuntimeCatalogVersion = useSyncVersion(tab === 'build' ? ['runtime-catalog'] : []);
  const hrSkillCatalogVersion = useSyncVersion(tab === 'build' ? ['modules'] : []);
  const [routePane, setRoutePane] = useState<'operations' | 'overview' | 'hierarchy'>('operations');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [graphGroups, setGraphGroups] = useState<{ team: string; agents: Agent[] }[]>([]);
  const [locallyDeletedTeams, setLocallyDeletedTeams] = useState<string[]>([]);
  const activeTeam = store.team ?? 'default';
  useEffect(() => {
    if (!focus) return;
    if (focus === 'route-hierarchy') {
      setTab('route');
      setRoutePane('hierarchy');
    } else if (focus === 'health') {
      setTab('health');
    }
    onFocusHandled?.();
  }, [focus, onFocusHandled]);
  useEffect(() => {
    // Prefer the store's live all-teams poll (holistic view) so the graph reacts in lock-step
    // with the rest of the app; fall back to a direct fetch when that isn't populated.
    if (store.allAgents.length) {
      const byTeam: Record<string, Agent[]> = {};
      for (const a of store.allAgents) (byTeam[a.team ?? '—'] ??= []).push(a);
      setGraphGroups(Object.entries(byTeam).map(([team, agents]) => ({ team, agents })));
      return;
    }
    call<{ team: string; agents: Agent[] }[]>('agents:allTeams').then(setGraphGroups).catch(() => setGraphGroups([]));
  }, [store.allAgents, store.agents, activeTeam, hrStructureVersion]);

  // Cross-team relay policy (delegates_to) for the active team.
  useEffect(() => {
    setLocallyDeletedTeams((prev) => {
      const stillInManagerSnapshot = prev.filter((name) => store.teams.some((t) => t.name === name));
      return stillInManagerSnapshot.length === prev.length ? prev : stillInManagerSnapshot;
    });
  }, [store.teams]);
  const locallyDeletedTeamSet = useMemo(() => new Set(locallyDeletedTeams), [locallyDeletedTeams]);
  const visibleTeams = useMemo(
    () => store.teams.filter((t) => !locallyDeletedTeamSet.has(t.name) && !isReservedEmptyPublicTeam(t, graphGroups)),
    [store.teams, locallyDeletedTeamSet, graphGroups],
  );
  // Teams with at least one RUNNING agent — used to keep team pickers to active teams only.
  const activeTeamNames = useMemo(
    () => visibleTeams.map((t) => t.name).filter((n) => store.allAgents.some((a) => a.team === n && !!a.status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(a.status))),
    [visibleTeams, store.allAgents],
  );
  const allKnownTeamNames = useMemo(() => {
    const authorityNames = visibleTeams.length
      ? visibleTeams.map((t) => t.name).filter(Boolean)
      : graphGroups.map((g) => g.team).filter(Boolean);
    return Array.from(new Set([
      PRIMARY_TEAM,
      ...authorityNames.filter((name) => !locallyDeletedTeamSet.has(name)),
    ])).sort((a, b) => (a === PRIMARY_TEAM ? -1 : b === PRIMARY_TEAM ? 1 : a.localeCompare(b)));
  }, [visibleTeams, graphGroups, locallyDeletedTeamSet]);
  const allKnownTeamSet = useMemo(() => new Set(allKnownTeamNames), [allKnownTeamNames]);
  const visibleGraphGroups = useMemo(
    () => graphGroups.filter((g) => allKnownTeamSet.has(g.team)),
    [graphGroups, allKnownTeamSet],
  );
  // team → its current agent names (live roster) — lets the Build tab skip agents that
  // already exist instead of hard-erroring the whole batch.
  const existingAgentsByTeam = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const a of store.allAgents) {
      const team = a.team ?? '';
      if (team && !allKnownTeamSet.has(team)) continue;
      (m[team] ??= []).push(a.name);
    }
    return m;
  }, [store.allAgents, allKnownTeamSet]);
  // Structure/Routing visualize every known team, even if the roster is empty/offline. Running
  // state is evidence, not the authority for whether a team exists.
  const structureGroups = useMemo(
    () => allKnownTeamNames.map((team) => ({ team, agents: visibleGraphGroups.find((g) => g.team === team)?.agents ?? [] })),
    [allKnownTeamNames, visibleGraphGroups],
  );
  const [delegates, setDelegates] = useState<string[] | null>(null);
  const [savedDelegates, setSavedDelegates] = useState<string[] | null>(null); // last persisted value
  const [mode, setMode] = useState<RelayMode>('permissive');
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayMsg, setRelayMsg] = useState<string>(''); // inline feedback next to Save
  const otherTeams = visibleTeams.map((t) => t.name).filter((n) => n !== activeTeam);

  /** A node (or team title) was clicked in the structure graph: just select it. We do NOT
   *  switch the active team — the side editor loads/saves the selected agent by name+team
   *  directly, so browsing the structure never hijacks your active-team context. */
  function onGraphSelect(sel: GraphSelection) {
    setSelectedKey(sel.kind === 'agent' ? `agent:${sel.team}:${sel.agent.name}` : `team:${sel.team}`);
  }
  // The agent currently selected in the graph (for the structure-tab side panel).
  const selectedAgent = (() => {
    if (!selectedKey?.startsWith('agent:')) return null;
    const rest = selectedKey.slice('agent:'.length);
    const sep = rest.indexOf(':');
    const team = rest.slice(0, sep); const name = rest.slice(sep + 1);
    const a = visibleGraphGroups.find((g) => g.team === team)?.agents.find((x) => x.name === name);
    return a ? { team, agent: a, reassignTargets: allKnownTeamNames.filter((n) => n !== team) } : null;
  })();
  // The team currently selected in the graph (team-title click) — and its agents — resolved
  // from the all-teams roster, so the team panel shows the SELECTED team without switching.
  const selectedTeamName = selectedKey?.startsWith('team:') ? selectedKey.slice('team:'.length) : null;
  useEffect(() => {
    if (!selectedKey) return;
    const team = selectedKey.startsWith('team:')
      ? selectedKey.slice('team:'.length)
      : selectedKey.startsWith('agent:')
        ? selectedKey.slice('agent:'.length).split(':')[0]
        : '';
    if (team && !allKnownTeamSet.has(team)) setSelectedKey(null);
  }, [selectedKey, allKnownTeamSet]);
  const selectedTeamAgents = selectedTeamName ? (visibleGraphGroups.find((g) => g.team === selectedTeamName)?.agents ?? []) : [];
  const selectedAgentLocked = selectedAgent ? isDefaultBackboneAgent(selectedAgent.team, selectedAgent.agent.name) : false;

  async function ensureRenderedAgentFresh(action: string, ref: { id?: string; name: string; team: string; stamp?: string }): Promise<Agent | null> {
    const groups = await freshHrGroups();
    const fresh = findHrAgent(groups, ref.team, ref);
    if (!fresh) {
      setMsg(`${action} blocked: ${ref.team}/${ref.name} is no longer in the current roster. Refreshed; review and try again.`);
      store.refresh();
      return null;
    }
    if (ref.stamp && hrAgentStamp({ ...fresh, team: ref.team }, ref.team) !== ref.stamp) {
      setMsg(`${action} blocked: ${ref.team}/${ref.name} changed since this row loaded. Refreshed; review the current status first.`);
      store.refresh();
      return null;
    }
    return fresh;
  }

  // ── Structure-tab agent editor — isolated from the active team. Loads/saves the SELECTED
  //    agent's persistent instructions + Work goals by name+team directly (no active-team switch). ──
  const [sgInstr, setSgInstr] = useState('');
  const [sgSaved, setSgSaved] = useState('');
  const [sgBusy, setSgBusy] = useState(false);
  const [sgMsg, setSgMsg] = useState('');
  const [sgGoals, setSgGoals] = useState<GoalSummary[]>([]);
  const [sgGoalEditing, setSgGoalEditing] = useState<string | 'new' | null>(null);
  const [sgGoalDetail, setSgGoalDetail] = useState<Goal | null>(null);
  const [sgGoalTitle, setSgGoalTitle] = useState('');
  const [sgGoalContent, setSgGoalContent] = useState('');
  const [sgGoalStatus, setSgGoalStatus] = useState<GoalStatus>('draft');
  const [sgGoalPriority, setSgGoalPriority] = useState<GoalPriority>('general');
  const [sgGoalBusy, setSgGoalBusy] = useState(false);
  const selAgentName = selectedAgent?.agent.name ?? '';
  const selAgentTeam = selectedAgent?.team ?? '';
  useEffect(() => {
    if (!selAgentName) {
      setSgInstr(''); setSgSaved(''); setSgMsg('');
      return;
    }
    let live = true;
    setSgMsg('');
    call<string>('agent:getInstructions', selAgentName, selAgentTeam).then((instructions) => {
      if (!live) return;
      setSgInstr(instructions || '');
      setSgSaved(instructions || '');
    }).catch(() => { if (live) { setSgInstr(''); setSgSaved(''); } });
    return () => { live = false; };
  }, [selAgentName, selAgentTeam]);
  useEffect(() => {
    setSgGoalEditing(null);
    setSgGoalDetail(null);
    setSgGoalTitle('');
    setSgGoalContent('');
    setSgGoalStatus('draft');
    setSgGoalPriority('general');
  }, [selAgentName, selAgentTeam]);
  useEffect(() => {
    if (!selAgentName) { setSgGoals([]); return; }
    let live = true;
    call<GoalSummary[]>('goals:list', selAgentTeam).then((goals) => {
      if (live) setSgGoals(goals.filter((g) => g.agent === selAgentName));
    }).catch(() => { if (live) setSgGoals([]); });
    return () => { live = false; };
  }, [selAgentName, selAgentTeam, syncVersion]);
  async function reloadSelectedAgentGoals(nextOpenId?: string) {
    if (!selAgentName) return;
    const goals = await call<GoalSummary[]>('goals:list', selAgentTeam).catch(() => []);
    const own = goals.filter((g) => g.agent === selAgentName);
    setSgGoals(own);
    if (nextOpenId) {
      const detail = await call<Goal | null>('goals:get', nextOpenId).catch(() => null);
      if (detail && detail.team === selAgentTeam && detail.agent === selAgentName) {
        setSgGoalEditing(detail.id);
        setSgGoalDetail(detail);
        setSgGoalTitle(detail.title);
        setSgGoalContent(detail.content);
        setSgGoalStatus(detail.status);
        setSgGoalPriority(goalPriority(detail.priority));
      }
    }
  }
  async function saveSgInstr() {
    if (!selAgentName) return;
    const rendered = selectedAgent?.agent;
    if (!rendered) return;
    setSgBusy(true); setSgMsg('checking current agent…');
    try {
      const fresh = await ensureRenderedAgentFresh('Save selected agent instructions', {
        id: rendered.id,
        name: selAgentName,
        team: selAgentTeam,
        stamp: hrAgentStamp({ ...rendered, team: selAgentTeam }, selAgentTeam),
      });
      if (!fresh) { setSgMsg('blocked — roster changed; review refreshed state'); return; }
      const current = await call<string>('agent:getInstructions', fresh.name, selAgentTeam).catch(() => '');
      if (current !== sgSaved) {
        setSgInstr(current);
        setSgSaved(current);
        setSgMsg('blocked — instructions changed elsewhere; review refreshed text');
        return;
      }
      if (!window.confirm(`Save instructions and rebuild ${selAgentTeam}/${fresh.name}?\n\nThis writes the selected agent's current system-prompt addendum and rebuilds it immediately.`)) return;
      setSgMsg('saving…');
      await call('agent:setInstructions', fresh.name, sgInstr, selAgentTeam);
      setSgSaved(sgInstr);
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      await call('rebuildAgent', fresh.name, selAgentTeam).catch(() => {});
      setSgMsg(sgInstr.trim() ? `saved ✓ — org synced; ${fresh.name} rebuilt` : `cleared ✓ — org synced; ${fresh.name} rebuilt`);
      store.refresh();
    } catch (e) { setSgMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSgBusy(false); }
  }
  function beginNewAgentGoal() {
    setSgGoalEditing('new');
    setSgGoalDetail(null);
    setSgGoalTitle('');
    setSgGoalContent('');
    setSgGoalStatus('draft');
    setSgGoalPriority('general');
    setSgMsg('');
  }
  async function openAgentGoal(id: string) {
    if (sgGoalEditing === id) {
      setSgGoalEditing(null);
      setSgGoalDetail(null);
      return;
    }
    setSgGoalBusy(true);
    try {
      const g = await call<Goal | null>('goals:get', id).catch(() => null);
      if (!g || g.team !== selAgentTeam || g.agent !== selAgentName) {
        setSgMsg('goal changed elsewhere; refreshed list');
        await reloadSelectedAgentGoals();
        return;
      }
      setSgGoalEditing(g.id);
      setSgGoalDetail(g);
      setSgGoalTitle(g.title);
      setSgGoalContent(g.content);
      setSgGoalStatus(g.status);
      setSgGoalPriority(goalPriority(g.priority));
    } finally { setSgGoalBusy(false); }
  }
  async function saveAgentGoal() {
    if (!selAgentName || !sgGoalContent.trim()) {
      setSgMsg('write a goal before saving');
      return;
    }
    setSgGoalBusy(true);
    try {
      const now = Date.now();
      let base: Goal | null = sgGoalDetail;
      if (sgGoalEditing && sgGoalEditing !== 'new') {
        const fresh = await call<Goal | null>('goals:get', sgGoalEditing).catch(() => null);
        if (!fresh || fresh.team !== selAgentTeam || fresh.agent !== selAgentName) {
          setSgMsg('goal save blocked — it changed or moved elsewhere; refreshed');
          await reloadSelectedAgentGoals();
          return;
        }
        if (base && fresh.updatedAt !== base.updatedAt) {
          setSgGoalDetail(fresh);
          setSgGoalTitle(fresh.title);
          setSgGoalContent(fresh.content);
          setSgGoalStatus(fresh.status);
          setSgGoalPriority(goalPriority(fresh.priority));
          setSgMsg('goal save blocked — review newer Work-page edit first');
          await reloadSelectedAgentGoals();
          return;
        }
        base = fresh;
      }
      const next: Goal = {
        ...(base ?? {
          id: newGoalId(),
          idea: sgGoalTitle.trim(),
          team: selAgentTeam,
          agent: selAgentName,
          autopilot: false,
          createdAt: now,
          updatedAt: now,
        }),
        title: (sgGoalTitle.trim() || clipText(sgGoalContent, 60)).slice(0, 200),
        content: sgGoalContent.trim(),
        status: sgGoalStatus,
        priority: sgGoalPriority,
        team: selAgentTeam,
        agent: selAgentName,
        updatedAt: now,
      };
      await call('goals:save', next);
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      await reloadSelectedAgentGoals(next.id);
      setSgMsg(`goal saved ✓ — Work and HR now share ${selAgentTeam}/${selAgentName}`);
    } catch (e) {
      setSgMsg(`goal save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSgGoalBusy(false); }
  }
  async function removeAgentGoal() {
    if (!sgGoalDetail) return;
    const current = await call<Goal | null>('goals:get', sgGoalDetail.id).catch(() => null);
    if (!current || current.updatedAt !== sgGoalDetail.updatedAt) {
      if (current) {
        setSgGoalDetail(current);
        setSgGoalTitle(current.title);
        setSgGoalContent(current.content);
        setSgGoalStatus(current.status);
        setSgGoalPriority(goalPriority(current.priority));
      }
      setSgMsg('delete blocked — goal changed elsewhere; review refreshed text');
      await reloadSelectedAgentGoals();
      return;
    }
    if (!window.confirm(`Remove goal "${current.title}" from ${selAgentTeam}/${selAgentName}?\n\nThis is the same goal shown on Work.`)) return;
    setSgGoalBusy(true);
    try {
      await call('goals:remove', current.id);
      setSgGoalEditing(null);
      setSgGoalDetail(null);
      setSgGoalTitle('');
      setSgGoalContent('');
      setSgGoalStatus('draft');
      setSgGoalPriority('general');
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      await reloadSelectedAgentGoals();
      setSgMsg('goal removed ✓');
    } finally { setSgGoalBusy(false); }
  }
  async function aiDraftSgInstr() {
    if (!selAgentName) return;
    setSgBusy(true); setSgMsg('asking HR manager to draft…');
    try {
      const meta =
        'Write a concise operating directive (a system-prompt addendum, 2-6 sentences, imperative voice, ' +
        'NO preamble, NO markdown headers, NO code fences) for an AI agent named "' + selAgentName + '"' +
        (sgInstr.trim() ? ' whose goal is: ' + sgInstr.trim() : ' — infer a sensible role from its name') +
        '. Output ONLY the directive text.';
      const txt = await askHrManagerToDraft(store, meta, hrOwner);
      setSgInstr(txt.trim()); setSgMsg('drafted ✓ — review, then Save & rebuild');
    } catch (e) { setSgMsg(`HR manager draft failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSgBusy(false); }
  }
  async function rebuildSelectedStructureAgent(rendered: Agent, team: string) {
    setBusy(true);
    setMsg(`checking ${team}/${rendered.name}…`);
    try {
      const fresh = await ensureRenderedAgentFresh('Rebuild selected agent', {
        id: rendered.id,
        name: rendered.name,
        team,
        stamp: hrAgentStamp({ ...rendered, team }, team),
      });
      if (!fresh) return;
      if (!window.confirm(`Rebuild current ${team}/${fresh.name}?\n\nThis restarts the selected agent so config and instruction changes take effect.`)) return;
      setMsg(`rebuilding ${fresh.name}…`);
      await call('rebuildAgent', fresh.name, team);
      store.refresh();
      setMsg(`rebuild queued for ${team}/${fresh.name} ✓`);
    } catch (e) {
      setMsg(`rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  }

  async function loadRelay() {
    try {
      const cfg = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      setDelegates(cfg.delegates_to);
      setSavedDelegates(cfg.delegates_to);
      setMode(modeOf(cfg.delegates_to));
      setRelayMsg('');
    } catch {
      setDelegates(null);
      setSavedDelegates(null);
      setMode('permissive');
    }
  }
  useEffect(() => {
    void loadRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, visibleTeams.length]);

  // Whole-fleet relay topology — every team's outbound delegate policy, for the Manage overview.
  const [relayMatrix, setRelayMatrix] = useState<{ team: string; delegates: string[] | null }[]>([]);
  useEffect(() => {
    if (tab !== 'route' || routePane !== 'overview') return;
    void call<{ team: string; delegates: string[] | null }[]>('relay:matrix').then(setRelayMatrix).catch(() => setRelayMatrix([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, routePane, activeTeam, savedDelegates, hrStructureVersion, allKnownTeamNames]);
  const visibleRelayMatrix = useMemo(
    () => relayMatrix.filter((row) => allKnownTeamSet.has(row.team)),
    [relayMatrix, allKnownTeamSet],
  );

  function pickMode(m: RelayMode) {
    setRelayMsg('');
    setMode(m);
    if (m === 'permissive') setDelegates(null);
    else if (m === 'all') setDelegates(['*']);
    else if (m === 'none') setDelegates([]);
    else setDelegates((d) => (d && !d.includes('*') ? d : [])); // keep existing selection
  }
  function toggleTeam(name: string) {
    setRelayMsg('');
    setDelegates((d) => {
      const cur = d && !d.includes('*') ? d : [];
      return cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    });
  }
  // The payload that would be persisted for the current selection, and whether it differs from what's saved.
  const relayPayload: string[] | null = mode === 'permissive' ? null : delegates ?? [];
  const relayDirty = relayKey(relayPayload) !== relayKey(savedDelegates);
  const defaultRelayBlocked = activeTeam === PRIMARY_TEAM && relayBlocksAll(relayPayload);
  async function saveRelay() {
    setRelayBusy(true);
    setRelayMsg('checking current policy…');
    try {
      if (defaultRelayBlocked) {
        setRelayMsg(`blocked — ${PRIMARY_TEAM}/${DEFAULT_LEAD} and validators need at least one outbound relay path`);
        return;
      }
      const fresh = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      if (relayKey(fresh.delegates_to) !== relayKey(savedDelegates)) {
        setDelegates(fresh.delegates_to);
        setSavedDelegates(fresh.delegates_to);
        setMode(modeOf(fresh.delegates_to));
        setRelayMsg('blocked — relay policy changed elsewhere; review refreshed policy');
        return;
      }
      const preview = [
        `Save relay policy for ${activeTeam}?`,
        '',
        `Before: ${describeRelay(fresh.delegates_to)}`,
        `After:  ${describeRelay(relayPayload)}`,
        '',
        `This changes which teams ${activeTeam}'s current agents may delegate work to.`,
      ].join('\n');
      if (!window.confirm(preview)) return;
      const afterConfirm = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      if (relayKey(afterConfirm.delegates_to) !== relayKey(fresh.delegates_to)) {
        setDelegates(afterConfirm.delegates_to);
        setSavedDelegates(afterConfirm.delegates_to);
        setMode(modeOf(afterConfirm.delegates_to));
        setRelayMsg('blocked — relay policy changed after review; review refreshed policy before saving');
        return;
      }
      setRelayMsg('saving…');
      const r = await call<{ delegates_to: string[] | null }>('setTeamDelegates', activeTeam, relayPayload);
      setDelegates(r.delegates_to);
      setSavedDelegates(r.delegates_to);
      setMode(modeOf(r.delegates_to));
      setRelayMsg(`saved ✓ (${describeRelay(r.delegates_to)})`);
    } catch (err) {
      setRelayMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRelayBusy(false);
    }
  }
  async function openRelayForTeam(team: string) {
    if (!team) return;
    if (team !== activeTeam && relayDirty) {
      const ok = window.confirm(`Discard unsaved relay changes for ${activeTeam} and edit ${team} instead?`);
      if (!ok) return;
    }
    setRelayMsg('');
    if (team !== activeTeam) await store.setTeam(team);
    setRoutePane('hierarchy');
    setTab('route');
  }

  // Catalogs for the Onboard modal (runtimes/models, library skills, providers).
  const cachedRuntimeCatalog = getRuntimeCatalogSnapshot(hrRuntimeCatalogVersion);
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>(() => cachedRuntimeCatalog?.modelCatalog ?? {});
  const [skillCatalog, setSkillCatalog] = useState<string[]>(() => hrBuildSkillCatalogCache?.skillCatalog ?? []);
  const [providers, setProviders] = useState<ProviderRow[]>(() => cachedRuntimeCatalog?.providers ?? []);
  const [managedRuntimes, setManagedRuntimes] = useState<Record<string, ManagedRuntimeStatus>>(() => cachedRuntimeCatalog?.managedRuntimes ?? {});

  useEffect(() => {
    if (tab !== 'build') return;
    const cached = getRuntimeCatalogSnapshot(hrRuntimeCatalogVersion);
    if (cached) {
      setModelCatalog(cached.modelCatalog);
      setProviders(cached.providers);
      setManagedRuntimes(cached.managedRuntimes);
      return;
    }
    let live = true;
    loadRuntimeCatalogSnapshot(hrRuntimeCatalogVersion).then((nextCache) => {
      if (!live) return;
      setModelCatalog(nextCache.modelCatalog);
      setProviders(nextCache.providers);
      setManagedRuntimes(nextCache.managedRuntimes);
    });
    return () => { live = false; };
  }, [tab, hrRuntimeCatalogVersion]);

  useEffect(() => {
    if (tab !== 'build') return;
    if (hrBuildSkillCatalogCache?.version === hrSkillCatalogVersion) {
      setSkillCatalog(hrBuildSkillCatalogCache.skillCatalog);
      return;
    }
    let live = true;
    call<LibrarySkillEntry[]>('librarySkills')
      .then((s) => s.map((x) => x.name))
      .catch(() => [] as string[])
      .then((nextSkillCatalog) => {
        const nextCache = { version: hrSkillCatalogVersion, skillCatalog: nextSkillCatalog };
        hrBuildSkillCatalogCache = nextCache;
        if (live) setSkillCatalog(nextCache.skillCatalog);
      });
    return () => { live = false; };
  }, [tab, hrSkillCatalogVersion]);


  // Per-agent relay overrides (an individual agent can be granted/denied
  // cross-team delegation independently of its team's policy).
  const [agentEditing, setAgentEditing] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string[]>([]);
  async function applyAgent(a: HrAgentCandidate, delegates: string[] | null, label: string): Promise<boolean> {
    setBusy(true);
    setMsg(`checking ${label}…`);
    try {
      const fresh = await ensureRenderedAgentFresh(`Apply ${label}`, {
        id: a.id,
        name: a.name,
        team: activeTeam,
        stamp: hrAgentStamp({ ...a, team: activeTeam }, activeTeam),
      });
      if (!fresh) return false;
      const freshTeam = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      if (relayKey(freshTeam.delegates_to) !== relayKey(savedDelegates)) {
        setDelegates(freshTeam.delegates_to);
        setSavedDelegates(freshTeam.delegates_to);
        setMode(modeOf(freshTeam.delegates_to));
        setMsg(`blocked: ${activeTeam} relay policy changed; review refreshed policy before overriding ${fresh.name}.`);
        return false;
      }
      const isBackbone = isDefaultBackboneAgent(activeTeam, fresh.name);
      if (isBackbone && relayBlocksAll(delegates)) {
        setMsg(`blocked: ${activeTeam}/${fresh.name} is part of the default leadership backbone and needs at least one outbound relay path.`);
        return false;
      }
      if (isBackbone && delegates === null && relayBlocksAll(freshTeam.delegates_to)) {
        setMsg(`blocked: ${activeTeam}/${fresh.name} cannot inherit a blocked default-team relay policy. Repair the team relay first.`);
        return false;
      }
      const current = currentAgentDelegates(fresh);
      if (relayKey(current) !== relayKey(currentAgentDelegates(a))) {
        setMsg(`blocked: ${activeTeam}/${fresh.name} relay override changed elsewhere. Refreshed; review and try again.`);
        store.refresh();
        return false;
      }
      const preview = [
        `Apply ${label} override?`,
        '',
        `Agent: ${activeTeam}/${fresh.name}`,
        `Before: ${describeAgentRelay(current, freshTeam.delegates_to)}`,
        `After:  ${describeAgentRelay(delegates, freshTeam.delegates_to)}`,
        '',
        "This changes this individual agent's cross-team delegation policy immediately.",
      ].join('\n');
      if (!window.confirm(preview)) return false;
      const [afterTeam, afterGroups] = await Promise.all([
        call<{ delegates_to: string[] | null }>('teamConfig', activeTeam),
        freshHrGroups(),
      ]);
      if (relayKey(afterTeam.delegates_to) !== relayKey(freshTeam.delegates_to)) {
        setDelegates(afterTeam.delegates_to);
        setSavedDelegates(afterTeam.delegates_to);
        setMode(modeOf(afterTeam.delegates_to));
        setMsg(`blocked: ${activeTeam} relay policy changed after review; review refreshed policy before overriding ${fresh.name}.`);
        return false;
      }
      const afterAgent = findHrAgent(afterGroups, activeTeam, { id: a.id, name: a.name });
      if (!afterAgent || hrAgentStamp({ ...afterAgent, team: activeTeam }, activeTeam) !== hrAgentStamp({ ...fresh, team: activeTeam }, activeTeam)) {
        setMsg(`blocked: ${activeTeam}/${fresh.name} changed after review. Refreshed; review the current row before applying relay.`);
        store.refresh();
        return false;
      }
      if (relayKey(currentAgentDelegates(afterAgent)) !== relayKey(current)) {
        setMsg(`blocked: ${activeTeam}/${fresh.name} relay override changed after review. Refreshed; review and try again.`);
        store.refresh();
        return false;
      }
      setMsg(`${label}…`);
      await call('setAgentDelegates', afterAgent.id, delegates);
      store.refresh();
      setMsg(`${label} ✓`);
      return true;
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Reassign a local agent to a different team (manager rebuilds it there).
  async function moveAgentToTeam(agentId: string, agentName: string, fromTeam: string, toTeam: string) {
    if (!toTeam || toTeam === fromTeam) return;
    if (isDefaultBackboneAgent(fromTeam, agentName)) {
      setMsg(`move blocked: ${fromTeam}/${agentName} is part of the locked default leadership backbone. Keep default/lead primary and default/coder + default/researcher as validators.`);
      return;
    }
    setBusy(true);
    setMsg(`checking move ${agentName} → ${toTeam}…`);
    try {
      const [groups, teams] = await Promise.all([
        freshHrGroups(),
        call<{ name: string }[]>('teams').catch(() => []),
      ]);
      if (!teams.some((t) => t.name === toTeam)) {
        setMsg(`move blocked: target team "${toTeam}" no longer exists. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      const fresh = findHrAgent(groups, fromTeam, { id: agentId, name: agentName });
      if (!fresh) {
        setMsg(`move blocked: ${fromTeam}/${agentName} is no longer in that team. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      if (!window.confirm(`Move current agent "${fresh.name}" from "${fromTeam}" to "${toTeam}"?\n\nIt will be rebuilt under the new team and leave ${fromTeam}.`)) return;
      setMsg(`moving ${fresh.name} → ${toTeam}…`);
      const r = await call<{ rebuilt?: boolean; warning?: string }>('agent:move', fresh.id, toTeam, fromTeam, false);
      store.refresh();
      setMsg(r?.warning ? `moved ${fresh.name} → ${toTeam} (⚠ ${r.warning})` : `moved ${fresh.name} → ${toTeam} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Delete an EMPTY team. The manager refuses `default` and any team with agents.
  async function removeTeam(name: string) {
    setBusy(true);
    setMsg(`checking team ${name}…`);
    try {
      const snap = await currentTeamSnapshot(name);
      if (name === 'default' || !snap.exists) {
        setMsg(`delete blocked: team "${name}" is no longer deletable. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      if (!snap.rosterKnown) {
        setMsg(`delete blocked: could not verify that ${name} is empty. Refresh team state before deleting.`);
        store.refresh();
        return;
      }
      if (snap.total > 0 || snap.agents.length) {
        setMsg(`delete blocked: ${name} now has ${snap.total} agent${snap.total === 1 ? '' : 's'}. Stop or move them first.`);
        store.refresh();
        return;
      }
      if (!window.confirm(`Delete current empty team "${name}"?\n\nIt still has no agents. This can't be undone.`)) return;
      const afterConfirm = await currentTeamSnapshot(name);
      if (!afterConfirm.exists) {
        setMsg(`delete blocked: team "${name}" disappeared after confirmation. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      if (!afterConfirm.rosterKnown || teamSnapshotStamp(afterConfirm) !== teamSnapshotStamp(snap)) {
        setMsg(`delete blocked: ${name} roster changed after confirmation. Review refreshed state before deleting.`);
        store.refresh();
        return;
      }
      setMsg(`deleting team ${name}…`);
      await call('team:delete', name);
      setLocallyDeletedTeams((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setGraphGroups((prev) => prev.filter((g) => g.team !== name));
      setRelayMatrix((prev) => prev.filter((row) => row.team !== name));
      if (selectedKey === `team:${name}` || selectedKey?.startsWith(`agent:${name}:`)) setSelectedKey(null);
      if (name === store.team) await store.setTeam('default');
      store.refresh();
      setMsg(`team ${name} deleted ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function pickAgentMode(a: HrAgentCandidate, m: RelayMode) {
    if (isDefaultBackboneAgent(activeTeam, a.name) && m === 'none') {
      setMsg(`blocked: ${activeTeam}/${a.name} is part of the default leadership backbone and needs at least one outbound relay path.`);
      return;
    }
    if (m === 'select') {
      const cur = (a.metadata as { delegates_to?: unknown })?.delegates_to;
      setAgentSel(Array.isArray(cur) && !cur.includes('*') ? (cur as string[]) : []);
      setAgentEditing(a.id);
    } else {
      setAgentEditing(null);
      void applyAgent(a, m === 'permissive' ? null : m === 'all' ? ['*'] : [], `${a.name} relay`);
    }
  }
  function toggleAgentTeam(name: string) {
    setAgentSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }
  // Lead hierarchy (#10): the primary coordinator across teams.
  const [hier, setHier] = useState<HrHierarchy>({ primary: null, coordinators: {} });
  async function loadHier() {
    setHier(await call<typeof hier>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })));
  }
  useEffect(() => { void loadHier(); }, [activeTeam, hrStructureVersion]);
  async function ensureHierarchyFresh(action: string): Promise<HrHierarchy | null> {
    const fresh = await call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} }));
    if (hierarchyStamp(fresh) !== hierarchyStamp(hier)) {
      setHier(fresh);
      setMsg(`${action} blocked: lead hierarchy changed elsewhere. Refreshed; review the current hierarchy first.`);
      return null;
    }
    return fresh;
  }
  async function ensureHierarchyAgent(action: string, team: string, agent: string): Promise<Agent | null> {
    const groups = await freshHrGroups();
    const fresh = findHrAgent(groups, team, { name: agent });
    if (!fresh) {
      setMsg(`${action} blocked: ${team}/${agent} is no longer in the current roster. Refreshed; review and try again.`);
      store.refresh();
      return null;
    }
    if (!isRunnableAgent(fresh)) {
      setMsg(`${action} blocked: ${team}/${agent} is not running (${fresh.status || 'unknown'}). Start or repair it in Manage > Team ops before routing work to it.`);
      store.refresh();
      return null;
    }
    return fresh;
  }
  /** Set (or change) a team's coordinator — the lead the rest of the team reports to. */
  async function setTeamCoordinator(team: string, agent: string) {
    if (!agent) return;
    if (team === PRIMARY_TEAM && !isDefaultLead(team, agent)) {
      setMsg(`Set coordinator blocked: the ${PRIMARY_TEAM} coordinator is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}. Keep ${PRIMARY_TEAM}/${DEFAULT_VALIDATORS.join(` and ${PRIMARY_TEAM}/`)} as validators.`);
      return;
    }
    const freshHier = await ensureHierarchyFresh('Set coordinator');
    if (!freshHier) return;
    const freshAgent = await ensureHierarchyAgent('Set coordinator', team, agent);
    if (!freshAgent) return;
    const before = freshHier.coordinators[team] || (freshHier.primary?.team === team ? freshHier.primary.agent : '(none)');
    const preview = [
      `Make ${team}/${freshAgent.name} the team coordinator?`,
      '',
      `Coordinator for ${team}: ${before} -> ${freshAgent.name}`,
      `Primary lead: ${primaryLabel(freshHier.primary)}`,
      '',
      `This changes the lead that the rest of ${team} reports to.`,
    ].join('\n');
    if (!window.confirm(preview)) return;
    const afterHier = await call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} }));
    if (hierarchyStamp(afterHier) !== hierarchyStamp(freshHier)) {
      setHier(afterHier);
      setMsg('Set coordinator blocked: lead hierarchy changed after review. Review the refreshed hierarchy first.');
      return;
    }
    const afterAgent = await ensureHierarchyAgent('Set coordinator after review', team, freshAgent.name);
    if (!afterAgent) return;
    await call('coordinator:set', team, afterAgent.name).catch(() => {});
    await loadHier();
    store.refresh();
  }
  /** Promote a specific team's coordinator to the primary cross-team lead. */
  async function makePrimaryFor(team: string, agent: string) {
    if (!agent) return;
    if (team !== PRIMARY_TEAM) {
      setMsg(`Promote primary blocked: ${team}/${agent} can be a team coordinator, but the fleet primary is locked to ${PRIMARY_TEAM}.`);
      return;
    }
    if (!isDefaultLead(team, agent)) {
      setMsg(`Promote primary blocked: the fleet primary is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}.`);
      return;
    }
    const freshHier = await ensureHierarchyFresh('Promote primary');
    if (!freshHier) return;
    const freshAgent = await ensureHierarchyAgent('Promote primary', team, agent);
    if (!freshAgent) return;
    const beforeCoord = freshHier.coordinators[team] ?? '(none)';
    const preview = [
      `Promote ${team}/${freshAgent.name} to primary cross-team lead?`,
      '',
      `Primary: ${primaryLabel(freshHier.primary)} -> ${team}/${freshAgent.name}`,
      `Coordinator for ${team}: ${beforeCoord} -> ${freshAgent.name}`,
      '',
      'This changes fleet hierarchy routing. Run Org sync afterward to push the hierarchy into agent goals and the brain.',
    ].join('\n');
    if (!window.confirm(preview)) return;
    const afterHier = await call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} }));
    if (hierarchyStamp(afterHier) !== hierarchyStamp(freshHier)) {
      setHier(afterHier);
      setMsg('Promote primary blocked: lead hierarchy changed after review. Review the refreshed hierarchy first.');
      return;
    }
    const afterAgent = await ensureHierarchyAgent('Promote primary after review', team, freshAgent.name);
    if (!afterAgent) return;
    await call('coordinator:setPrimary', team, afterAgent.name).catch(() => {});
    await loadHier();
    store.refresh();
  }

  // ---- Reactive Org Sync: each agent's goals file composed from the hierarchy + brain ----
  type OrgPreview = {
    agents: number;
    changed: number;
    rebuilt: string[];
    brain: boolean;
    skippedBusy: number;
    autoRebuild: boolean;
    rebuildLimit: number;
    changedAgents: { team: string; agent: string; status?: string; rebuild: boolean; reason?: string }[];
  };
  const [orgCfg, setOrgCfg] = useState<OrgCfg>({ enabled: true, autoRebuild: true });
  const [secondaries, setSecondaries] = useState<SecLead[]>([]);
  const [validatorPick, setValidatorPick] = useState('');
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgResult, setOrgResult] = useState<string | null>(null);
  const validatorRows = useMemo(() => normalizeSecondaryRows(secondaries), [secondaries]);
  const defaultTeamValidatorCandidates = useMemo(() => {
    const names = new Set<string>();
    for (const a of store.allAgents) {
      if ((a.team ?? PRIMARY_TEAM) === PRIMARY_TEAM) names.add(slugName(a.name));
    }
    const graphDefault = structureGroups.find((g) => g.team === PRIMARY_TEAM)?.agents ?? [];
    for (const a of graphDefault) names.add(slugName(a.name));
    const configured = new Set(validatorRows.map((s) => slugName(s.agent)));
    return Array.from(names)
      .filter((name) => name && name !== DEFAULT_LEAD && !configured.has(name))
      .sort((a, b) => a.localeCompare(b));
  }, [store.allAgents, structureGroups, validatorRows]);
  useEffect(() => {
    if (validatorPick && !defaultTeamValidatorCandidates.includes(validatorPick)) setValidatorPick('');
  }, [defaultTeamValidatorCandidates, validatorPick]);
  function formatOrgPreview(p: OrgPreview): string {
    const sample = p.changedAgents.slice(0, 8).map((a) =>
      `- ${a.team}/${a.agent}${a.rebuild ? ' -> rebuild' : a.reason ? ` -> ${a.reason}` : ''}${a.status ? ` (${a.status})` : ''}`,
    );
    const more = p.changedAgents.length > sample.length ? [`- ...and ${p.changedAgents.length - sample.length} more`] : [];
    return [
      'Org sync preview',
      `Agents scanned: ${p.agents}`,
      `Goal files that would change: ${p.changed}`,
      `Brain hierarchy write: ${p.brain ? 'yes' : 'no'}`,
      `Auto-rebuild: ${p.autoRebuild ? `yes, ${p.rebuilt.length}/${p.rebuildLimit} planned` : 'off'}`,
      p.skippedBusy ? `Deferred rebuilds: ${p.skippedBusy}` : 'Deferred rebuilds: 0',
      ...(sample.length ? ['', 'Affected agents:', ...sample, ...more] : []),
    ].join('\n');
  }
  async function loadOrg() {
    setOrgCfg(await call<{ enabled?: boolean; autoRebuild?: boolean }>('org:getConfig').catch(() => ({ enabled: true, autoRebuild: true })));
    setSecondaries(normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => [])));
  }
  useEffect(() => {
    if (tab !== 'route' || routePane !== 'hierarchy') return;
    void loadOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, routePane, activeTeam, hrStructureVersion]);
  async function ensureOrgConfigFresh(action: string): Promise<OrgCfg | null> {
    const fresh = await call<OrgCfg>('org:getConfig').catch(() => ({ enabled: true, autoRebuild: true }));
    if (orgConfigStamp(fresh) !== orgConfigStamp(orgCfg)) {
      setOrgCfg(fresh);
      setOrgResult(`${action} blocked: org-sync settings changed elsewhere. Review refreshed settings and try again.`);
      return null;
    }
    return fresh;
  }
  async function toggleOrg(patch: { enabled?: boolean; autoRebuild?: boolean }) {
    if (!(await ensureOrgConfigFresh('Org config change'))) return;
    const label = patch.enabled !== undefined ? `${patch.enabled ? 'Enable' : 'Disable'} org auto-sync` : `${patch.autoRebuild ? 'Enable' : 'Disable'} org auto-rebuild`;
    if (!window.confirm(`${label}?\n\nOrg sync composes agent goals from the hierarchy and brain; auto-rebuild can restart idle agents after goals change.`)) return;
    if (!(await ensureOrgConfigFresh('Org config change after review'))) return;
    const next = await call<{ enabled?: boolean; autoRebuild?: boolean }>('org:setConfig', patch).catch(() => orgCfg);
    setOrgCfg(next);
  }
  async function syncOrgNow() {
    setOrgBusy(true); setOrgResult('checking current org state…');
    try {
      const freshCfg = await ensureOrgConfigFresh('Org sync');
      if (!freshCfg) return;
      const freshHier = await ensureHierarchyFresh('Org sync');
      if (!freshHier) { setOrgResult('Org sync blocked: lead hierarchy changed elsewhere. Review refreshed hierarchy and try again.'); return; }
      const opts = { autoRebuild: freshCfg.autoRebuild !== false };
      const previewStamp = { hierarchy: hierarchyStamp(freshHier), config: orgConfigStamp(freshCfg) };
      setOrgResult('previewing…');
      const preview = await call<OrgPreview>('org:preview', opts);
      const previewText = formatOrgPreview(preview);
      if (!window.confirm(`${previewText}\n\nApply this org sync now?`)) {
        setOrgResult(`preview only:\n${previewText}`);
        return;
      }
      const [afterHier, afterCfg] = await Promise.all([
        call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })),
        call<OrgCfg>('org:getConfig').catch(() => freshCfg),
      ]);
      if (hierarchyStamp(afterHier) !== previewStamp.hierarchy || orgConfigStamp(afterCfg) !== previewStamp.config) {
        setHier(afterHier);
        setOrgCfg(afterCfg);
        setOrgResult('sync blocked: org state changed after preview. Review the refreshed hierarchy/settings and run Preview & sync again.');
        return;
      }
      setOrgResult('syncing…');
      const r = await call<{ agents: number; written: number; rebuilt: string[]; brain: boolean; skippedBusy: number }>('org:sync', opts);
      const rebuilt = r.rebuilt.length ? ` (${r.rebuilt.slice(0, 5).join(', ')}${r.rebuilt.length > 5 ? ', ...' : ''})` : '';
      setOrgResult(`synced ${r.agents} agents · ${r.written} goals updated · rebuilt ${r.rebuilt.length}${rebuilt}${r.skippedBusy ? ` · ${r.skippedBusy} deferred (busy)` : ''} · brain ${r.brain ? '✓' : '—'}`);
      store.refresh();
    } catch (err) { setOrgResult(`sync failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setOrgBusy(false); }
  }
  async function saveSecondaryCoverage(agent: string, teamName: string, enabled: boolean) {
    const validator = slugName(agent);
    if (!validator || validator === DEFAULT_LEAD) {
      setOrgResult(`secondary update blocked: ${PRIMARY_TEAM}/${DEFAULT_LEAD} is the primary lead, not a validator`);
      return;
    }
    setOrgBusy(true);
    try {
      const freshSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => [] as SecLead[]));
      if (secondaryStamp(freshSecondaries) !== secondaryStamp(validatorRows)) {
        setSecondaries(freshSecondaries);
        setOrgResult('secondary update blocked: validator coverage changed elsewhere. Review refreshed coverage first.');
        return;
      }
      const base = normalizeSecondaryRows(freshSecondaries);
      const next = base.map((s) => ({ ...s, team: PRIMARY_TEAM, leadsTeams: [...new Set(s.leadsTeams ?? [])] }));
      let row = next.find((s) => slugName(s.agent) === validator);
      if (!row) {
        row = { agent: validator, team: PRIMARY_TEAM, leadsTeams: [] };
        next.push(row);
      }
      row.leadsTeams = enabled
        ? [...new Set([...row.leadsTeams, teamName])].sort((a, b) => a.localeCompare(b))
        : row.leadsTeams.filter((t) => t !== teamName);
      const review = [
        `${enabled ? 'Add' : 'Remove'} ${PRIMARY_TEAM}/${validator} validator coverage for ${teamName}?`,
        '',
        `${PRIMARY_TEAM}/${validator}: ${(base.find((s) => slugName(s.agent) === validator)?.leadsTeams ?? []).join(', ') || '—'} -> ${row.leadsTeams.join(', ') || '—'}`,
        '',
        'Org sync will update agent instruction sidecars and the Brain hierarchy memory after saving. Default/coder and default/researcher remain protected validators.',
      ].filter(Boolean).join('\n');
      if (!window.confirm(review)) return;
      const afterSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => freshSecondaries));
      if (secondaryStamp(afterSecondaries) !== secondaryStamp(freshSecondaries)) {
        setSecondaries(afterSecondaries);
        setOrgResult('secondary update blocked: validator coverage changed after review. Review refreshed coverage first.');
        return;
      }
      await call('org:setSecondaryLeads', normalizeSecondaryRows(next));
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      await loadOrg();
      store.refresh();
      setOrgResult(`secondary coverage updated ✓ — ${PRIMARY_TEAM}/${validator} ${enabled ? 'validates' : 'no longer validates'} ${teamName}`);
    } catch (e) {
      setOrgResult(`secondary update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setOrgBusy(false); }
  }
  async function addSecondaryValidator(agent: string) {
    const validator = slugName(agent);
    if (!validator || validator === DEFAULT_LEAD) {
      setOrgResult(`add validator blocked: ${PRIMARY_TEAM}/${DEFAULT_LEAD} is the primary lead`);
      return;
    }
    if (!defaultTeamValidatorCandidates.includes(validator)) {
      setOrgResult(`add validator blocked: choose an available ${PRIMARY_TEAM} team agent that is not already a validator`);
      return;
    }
    setOrgBusy(true);
    try {
      const freshSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => [] as SecLead[]));
      if (secondaryStamp(freshSecondaries) !== secondaryStamp(validatorRows)) {
        setSecondaries(freshSecondaries);
        setOrgResult('add validator blocked: validator roster changed elsewhere. Review refreshed coverage first.');
        return;
      }
      const next = normalizeSecondaryRows([...freshSecondaries, { agent: validator, team: PRIMARY_TEAM, leadsTeams: [] }]);
      if (!window.confirm(`Add ${PRIMARY_TEAM}/${validator} as an additional validator?\n\nThey will appear in the validator coverage matrix with no team coverage until you assign teams. Org sync will update instruction sidecars and the Brain hierarchy memory after saving.`)) return;
      const afterSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => freshSecondaries));
      if (secondaryStamp(afterSecondaries) !== secondaryStamp(freshSecondaries)) {
        setSecondaries(afterSecondaries);
        setOrgResult('add validator blocked: validator roster changed after review. Review refreshed coverage first.');
        return;
      }
      await call('org:setSecondaryLeads', next);
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      setValidatorPick('');
      await loadOrg();
      store.refresh();
      setOrgResult(`validator added ✓ — ${PRIMARY_TEAM}/${validator}`);
    } catch (e) {
      setOrgResult(`add validator failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setOrgBusy(false); }
  }
  async function removeSecondaryValidator(agent: string) {
    const validator = slugName(agent);
    if (DEFAULT_VALIDATORS.includes(validator)) {
      setOrgResult(`remove validator blocked: ${PRIMARY_TEAM}/${validator} is part of the protected default validation pair`);
      return;
    }
    setOrgBusy(true);
    try {
      const freshSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => [] as SecLead[]));
      if (secondaryStamp(freshSecondaries) !== secondaryStamp(validatorRows)) {
        setSecondaries(freshSecondaries);
        setOrgResult('remove validator blocked: validator roster changed elsewhere. Review refreshed coverage first.');
        return;
      }
      const current = freshSecondaries.find((s) => slugName(s.agent) === validator);
      if (!current) {
        setSecondaries(freshSecondaries);
        setOrgResult(`remove validator skipped: ${PRIMARY_TEAM}/${validator} is no longer configured`);
        return;
      }
      const next = normalizeSecondaryRows(freshSecondaries.filter((s) => slugName(s.agent) !== validator));
      const reassigned = current.leadsTeams.length ? `\n\nCurrent coverage: ${current.leadsTeams.join(', ')}\nAny teams left uncovered will be reassigned to the protected default validators by org sync.` : '';
      if (!window.confirm(`Remove ${PRIMARY_TEAM}/${validator} from the validator roster?${reassigned}\n\nDefault/coder and default/researcher will remain in place.`)) return;
      const afterSecondaries = normalizeSecondaryRows(await call<{ secondaries: SecLead[] }>('org:hierarchy').then((h) => h.secondaries ?? []).catch(() => freshSecondaries));
      if (secondaryStamp(afterSecondaries) !== secondaryStamp(freshSecondaries)) {
        setSecondaries(afterSecondaries);
        setOrgResult('remove validator blocked: validator roster changed after review. Review refreshed coverage first.');
        return;
      }
      await call('org:setSecondaryLeads', next);
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      await loadOrg();
      store.refresh();
      setOrgResult(`validator removed ✓ — ${PRIMARY_TEAM}/${validator}`);
    } catch (e) {
      setOrgResult(`remove validator failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setOrgBusy(false); }
  }

  // Whole-team lifecycle (start / stop / probe / rebuild every agent in a team).
  const [teamOpBusy, setTeamOpBusy] = useState(false);
  const [teamOpMsg, setTeamOpMsg] = useState('');
  async function currentTeamSnapshot(team: string): Promise<TeamSnapshot> {
    const [teams, groups] = await Promise.all([
      call<Array<{ name: string; agentCount?: number }>>('teams').catch(() => []),
      call<TeamAgentsGroup[]>('agents:allTeams').catch(() => null),
    ]);
    const row = teams.find((t) => t.name === team);
    const group = groups?.find((g) => g.team === team);
    const agents = group?.agents ?? [];
    const rowCount = Number(row?.agentCount) || 0;
    const rosterKnown = Boolean(group) || (groups !== null && rowCount === 0);
    return {
      exists: Boolean(row),
      agents,
      running: agents.filter(isRunnableAgent).length,
      total: rosterKnown ? agents.length : rowCount,
      rosterKnown,
    };
  }
  async function runTeamOp(team: string, op: 'start' | 'stop' | 'probe' | 'rebuild') {
    setTeamOpBusy(true); setTeamOpMsg(`checking ${team}…`);
    try {
      const snap = await currentTeamSnapshot(team);
      if (!snap.exists) {
        setTeamOpMsg(`${op} blocked: team ${team} no longer exists. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      if (!snap.rosterKnown) {
        setTeamOpMsg(`${op} blocked: could not verify the current ${team} roster. Refresh and try again.`);
        store.refresh();
        return;
      }
      if (snap.total === 0) {
        setTeamOpMsg(`${op} blocked: team ${team} has no current agents.`);
        store.refresh();
        return;
      }
      const verb = op === 'start' ? 'Start' : op === 'stop' ? 'Stop' : op === 'probe' ? 'Probe' : 'Rebuild';
      const note = op === 'rebuild'
        ? 'This restarts every current agent so config and instructions take effect.'
        : op === 'stop'
          ? 'This stops every current agent in the team.'
          : op === 'probe'
            ? 'This probes every current agent in the team and may refresh health status.'
            : 'This starts every current agent in the team.';
      const protectedAgents = snap.agents.filter((a) => isDefaultBackboneAgent(team, a.name)).map((a) => `${team}/${a.name}`);
      const protectedNote = protectedAgents.length && (op === 'stop' || op === 'rebuild')
        ? `\n\nGuardrail: this includes locked default leadership roles (${protectedAgents.join(', ')}). Their roles stay locked, but their running state will change.`
        : '';
      if (!window.confirm(`${verb} all current agents in ${team}?\n\nCurrent state: ${snap.running}/${snap.total} running.\nTargets: ${teamSnapshotSummary(snap)}\n\n${note}${protectedNote}`)) return;
      const afterConfirm = await currentTeamSnapshot(team);
      if (!afterConfirm.exists || !afterConfirm.rosterKnown || teamSnapshotStamp(afterConfirm) !== teamSnapshotStamp(snap)) {
        setTeamOpMsg(`${op} blocked: ${team} roster changed after confirmation. Review refreshed state before retrying.`);
        store.refresh();
        return;
      }
      setTeamOpMsg(`${op} ${team}…`);
      if (op === 'probe') {
        const p = await call<{ team: string; probed: number; passed: number; failed: number }>('team:probe', team);
        setTeamOpMsg(`probe ${team}: ${p.passed}/${p.probed} healthy${p.failed ? ` · ${p.failed} failed` : ''}`);
      } else {
        const r = await call<{ total: number; done: string[]; failed: { name: string; error: string }[] }>('team:lifecycle', team, op);
        setTeamOpMsg(r.failed.length
          ? `${op} ${team}: ${r.done.length}/${r.total} ✓ · ${r.failed.length} failed (${r.failed.map((f) => f.name).join(', ')})`
          : `${op} ${team}: ${r.done.length}/${r.total} agents ✓`);
      }
      store.refresh();
    } catch (e) {
      setTeamOpMsg(`${op} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setTeamOpBusy(false); }
  }

  // Guarded team rename/merge built from the manager primitives IDACC already has:
  // reassign each agent, preserve coordinator/secondary mappings, then delete an empty source.
  const [maintMode, setMaintMode] = useState<'rename' | 'merge'>('rename');
  const [maintFrom, setMaintFrom] = useState('');
  const [maintTo, setMaintTo] = useState('');
  const [maintDeleteSource, setMaintDeleteSource] = useState(true);
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintMsg, setMaintMsg] = useState('');
  const maintTarget = canonicalTeamName(maintTo);
  const maintSourceAgents = maintFrom ? (visibleGraphGroups.find((g) => g.team === maintFrom)?.agents ?? []) : [];
  const maintTargetAgents = maintTarget ? (visibleGraphGroups.find((g) => g.team === maintTarget)?.agents ?? []) : [];
  const maintCollisions = maintFrom && maintTarget && maintFrom !== maintTarget
    ? maintSourceAgents.filter((a) => maintTargetAgents.some((b) => slugName(b.name) === slugName(a.name))).map((a) => a.name)
    : [];
  const maintCanRun = Boolean(maintFrom && maintTarget && maintFrom !== maintTarget)
    && !isReservedName(maintTarget)
    && maintFrom !== PRIMARY_TEAM
    && (maintMode === 'rename' || allKnownTeamNames.includes(maintTarget))
    && maintCollisions.length === 0
    && maintSourceAgents.length > 0;
  const maintWarnings = [
    maintFrom === PRIMARY_TEAM ? `${PRIMARY_TEAM} cannot be renamed or merged away` : '',
    maintTarget && isReservedName(maintTarget) ? `"${maintTarget}" is reserved` : '',
    maintFrom && maintTarget && maintFrom === maintTarget ? 'source and target are the same' : '',
    maintCollisions.length ? `name collision: ${maintCollisions.join(', ')}` : '',
    maintFrom !== maintTarget && maintTarget && maintMode === 'rename' && allKnownTeamNames.includes(maintTarget) && maintTargetAgents.length ? 'target has agents; use Merge' : '',
  ].filter(Boolean);
  const maintSummary = maintFrom
    ? maintFrom === maintTarget
      ? 'No change: choose a different target team.'
      : `${maintSourceAgents.length} agent${maintSourceAgents.length === 1 ? '' : 's'} will move; routing and instructions sync after review.`
    : 'Choose a source team to rename or merge.';
  async function runTeamMaintenance() {
    const source = maintFrom;
    const target = maintTarget;
    if (!source || !target) { setMaintMsg('choose source and target teams first'); return; }
    if (source === PRIMARY_TEAM) { setMaintMsg(`blocked: ${PRIMARY_TEAM} must remain the primary lead team`); return; }
    if (source === target) { setMaintMsg('blocked: source and target are the same'); return; }
    if (isReservedName(target)) { setMaintMsg(`blocked: "${target}" is a reserved team name`); return; }
    setMaintBusy(true); setMaintMsg('checking current rosters…');
    try {
      const [teamsNow, groupsNow, hierNow] = await Promise.all([
        call<Array<{ name: string }>>('teams').catch(() => []),
        freshHrGroups(),
        call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })),
      ]);
      const currentTeams = new Set(teamsNow.map((t) => t.name));
      const sourceAgents = agentsForTeam(groupsNow, source);
      const targetAgents = agentsForTeam(groupsNow, target);
      if (!currentTeams.has(source)) { setMaintMsg(`blocked: source team ${source} no longer exists`); store.refresh(); return; }
      if (maintMode === 'merge' && !currentTeams.has(target)) { setMaintMsg(`blocked: merge target ${target} no longer exists`); store.refresh(); return; }
      if (!sourceAgents.length) { setMaintMsg(`blocked: ${source} has no movable agents`); store.refresh(); return; }
      if (agentNameKey(sourceAgents) !== agentNameKey(maintSourceAgents)) {
        setMaintMsg(`blocked: ${source} roster changed while the maintenance panel was open`);
        store.refresh();
        return;
      }
      const collisions = sourceAgents.filter((a) => targetAgents.some((b) => slugName(b.name) === slugName(a.name))).map((a) => a.name);
      if (collisions.length) {
        setMaintMsg(`blocked: ${target} already has agent name(s): ${collisions.join(', ')}`);
        store.refresh();
        return;
      }
      const targetExists = currentTeams.has(target);
      if (maintMode === 'rename' && targetExists && targetAgents.length) {
        setMaintMsg(`blocked: rename target ${target} already has agents; use Merge instead`);
        return;
      }
      const sourceRelay = await call<{ delegates_to: string[] | null }>('teamConfig', source).then((r) => r.delegates_to).catch(() => null);
      const sourceCoord = (hierNow.coordinators as Record<string, string>)[source] || '';
      const nextSecondaries = secondaries.map((s) => ({
        ...s,
        leadsTeams: Array.from(new Set((s.leadsTeams ?? []).map((t) => t === source ? target : t).filter((t) => t !== source))).sort((a, b) => a.localeCompare(b)),
      }));
      const steps = [
        `${maintMode === 'rename' ? 'Rename' : 'Merge'} ${source} -> ${target}`,
        `Move ${sourceAgents.length} agent(s): ${sourceAgents.map((a) => a.name).join(', ')}`,
        !targetExists && maintMode === 'rename' ? `Create empty target team: ${target}` : `Target team exists: ${target}`,
        sourceCoord ? `Preserve coordinator: ${sourceCoord} on ${target}` : 'No source coordinator to preserve',
        `Preserve source relay on ${target}: ${describeRelay(sourceRelay)}`,
        maintDeleteSource ? `Delete ${source} after it is empty` : `Keep empty ${source}`,
      ];
      if (!window.confirm(`${steps.join('\n')}\n\nThis is a guarded multi-step maintenance action, not an atomic manager transaction. Continue?`)) return;
      const [afterGroups, afterHier] = await Promise.all([
        freshHrGroups(),
        call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })),
      ]);
      if (agentNameKey(agentsForTeam(afterGroups, source)) !== agentNameKey(sourceAgents) || hierarchyStamp(afterHier) !== hierarchyStamp(hierNow)) {
        setMaintMsg('blocked: roster or hierarchy changed after confirmation; review refreshed state first');
        await loadHier();
        store.refresh();
        return;
      }
      setMaintMsg(`moving ${sourceAgents.length} agent(s)…`);
      const moved: string[] = [];
      const createTarget = maintMode === 'rename' && !targetExists;
      for (const agent of sourceAgents) {
        await call('agent:move', agent.id, target, source, createTarget);
        moved.push(agent.name);
      }
      if (sourceCoord && moved.includes(sourceCoord)) await call('coordinator:set', target, sourceCoord).catch(() => {});
      await call('setTeamDelegates', target, sourceRelay).catch(() => {});
      await call('org:setSecondaryLeads', nextSecondaries).catch(() => {});
      if (maintDeleteSource) {
        const remaining = agentsForTeam(await freshHrGroups(), source);
        if (!remaining.length) await call('team:delete', source).catch(() => {});
      }
      await Promise.all([loadHier(), loadOrg()]);
      await call('org:sync', { autoRebuild: false }).catch(() => {});
      store.refresh();
      setMaintMsg(`${maintMode === 'rename' ? 'rename' : 'merge'} complete ✓ — moved ${moved.join(', ')}`);
    } catch (e) {
      setMaintMsg(`maintenance failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setMaintBusy(false); }
  }

  const sgGoalDirty = sgGoalEditing === 'new'
    ? Boolean(sgGoalTitle.trim() || sgGoalContent.trim() || sgGoalStatus !== 'draft' || sgGoalPriority !== 'general')
    : Boolean(sgGoalDetail && (
      sgGoalTitle !== sgGoalDetail.title ||
      sgGoalContent !== sgGoalDetail.content ||
      sgGoalStatus !== sgGoalDetail.status ||
      sgGoalPriority !== goalPriority(sgGoalDetail.priority)
    ));
  const selectedTeamMeta = selectedTeamName ? visibleTeams.find((t) => t.name === selectedTeamName) : undefined;
  const selectedTeamKnownTotal = selectedTeamAgents.length || Number(selectedTeamMeta?.agentCount) || 0;
  const selectedTeamRunning = selectedTeamAgents.filter(isRunnableAgent).length;
  const selectedTeamLead = selectedTeamName ? (hier.coordinators[selectedTeamName] || (hier.primary?.team === selectedTeamName ? hier.primary.agent : '')) : '';
  const selectedTeamSecondaries = selectedTeamName ? secondaries.filter((s) => s.leadsTeams.includes(selectedTeamName)) : [];

  function RelayPolicySection() {
    return (
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border, #2a2a2a)' }}>
        <h4 style={{ margin: 0 }}>Cross-team relay — {activeTeam}</h4>
        <p className="muted small" style={{ marginTop: 4 }}>
          Which teams <b>{activeTeam}</b>'s agents may delegate to (relay work via <span className="mono">/ask &lt;team&gt;/&lt;agent&gt;</span>).
          Unset = permissive (any team).
        </p>
        {activeTeam === PRIMARY_TEAM ? (
          <p className={`small ${defaultRelayBlocked ? 'warn-text' : 'muted'}`} style={{ marginTop: -2 }}>
            Default leadership guard: <b>{PRIMARY_TEAM}/{DEFAULT_LEAD}</b>, <b>{PRIMARY_TEAM}/coder</b>, and <b>{PRIMARY_TEAM}/researcher</b> need at least one outbound relay path for delegation and validator bounce-backs.
          </p>
        ) : null}
        <div className="relay-modes">
          {([
            ['permissive', 'Any team (default)'],
            ['all', 'All teams (*)'],
            ['select', 'Only selected teams'],
            ['none', 'Blocked (none)'],
          ] as [RelayMode, string][]).map(([m, label]) => (
            <label key={m} className={`relay-mode${mode === m ? ' active' : ''}`} title={activeTeam === PRIMARY_TEAM && m === 'none' ? 'Default leadership needs at least one relay path' : undefined}>
              <input type="radio" name="relay-mode" checked={mode === m} disabled={activeTeam === PRIMARY_TEAM && m === 'none'} onChange={() => pickMode(m)} /> {label}
            </label>
          ))}
        </div>
        {mode === 'select' ? (
          <div className="chips" style={{ marginTop: 10 }}>
            {otherTeams.length === 0 ? (
              <span className="muted small">No other teams to relay to yet.</span>
            ) : (
              otherTeams.map((n) => {
                const on = (delegates ?? []).includes(n);
                return (
                  <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleTeam(n)}>
                    {on ? '✓ ' : ''}{n}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <span className="muted small grow">
            saved: <span className="mono">{describeRelay(savedDelegates)}</span>
            {relayDirty ? <span className="warn-text" style={{ marginLeft: 8 }}>● unsaved changes</span> : null}
            {defaultRelayBlocked ? <span className="warn-text" style={{ marginLeft: 8 }}>default leadership would be blocked</span> : null}
          </span>
          {relayMsg ? (
            <span className={`small${relayMsg.startsWith('failed') ? ' status-error' : ' ok-text'}`} style={{ marginRight: 10 }}>
              {relayMsg}
            </span>
          ) : null}
          <button className="btn primary" disabled={relayBusy || !relayDirty || defaultRelayBlocked} onClick={() => void saveRelay()}>
            {relayBusy ? 'Saving…' : 'Save relay policy'}
          </button>
        </div>

        <h4 style={{ marginTop: 18, marginBottom: 0 }}>Per-agent relay overrides</h4>
        <p className="muted small" style={{ marginTop: 4 }}>
          Override the team policy for an individual agent, such as letting one agent relay to other teams when the team is restricted.
        </p>
        {store.agents.length === 0 ? (
          <p className="muted small">No agents in {activeTeam}.</p>
        ) : (
          agentsLeadFirst(store.agents, store.coordinator).map((a) => {
            const pol = (a.metadata as { delegates_to?: unknown })?.delegates_to;
            const roleLocked = isDefaultBackboneAgent(activeTeam, a.name);
            const m = agentEditing === a.id ? 'select' : modeOf(Array.isArray(pol) ? (pol as string[]) : null);
            const label =
              m === 'permissive' ? 'inherits team' : m === 'all' ? 'any team' : m === 'none' ? 'blocked' : Array.isArray(pol) ? pol.join(', ') : '';
            const selectedOverrideWouldBlock = roleLocked && agentEditing === a.id && agentSel.length === 0;
            return (
              <div key={a.id} className="kv" style={{ gridTemplateColumns: '130px 1fr', gap: '4px 12px', marginBottom: 10 }}>
                <span className="b">{a.name}</span>
                <span>
                  <select className="cell-select" disabled={busy} value={m} onChange={(e) => pickAgentMode(a, e.target.value as RelayMode)}>
                    <option value="permissive">Inherit team</option>
                    <option value="all">Any team (*)</option>
                    <option value="select">Selected teams...</option>
                    <option value="none" disabled={roleLocked}>Blocked (none)</option>
                  </select>
                  <span className={roleLocked && m === 'none' ? 'warn-text small' : 'muted small'} style={{ marginLeft: 8 }}>{label}</span>
                  {roleLocked ? <span className="muted small" style={{ marginLeft: 8 }}>default backbone</span> : null}
                  {agentEditing === a.id ? (
                    <div className="chips" style={{ marginTop: 6 }}>
                      {otherTeams.length === 0 ? (
                        <span className="muted small">No other teams.</span>
                      ) : (
                        otherTeams.map((n) => {
                          const on = agentSel.includes(n);
                          return (
                            <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleAgentTeam(n)}>
                              {on ? '✓ ' : ''}{n}
                            </button>
                          );
                        })
                      )}
                      {selectedOverrideWouldBlock ? <span className="warn-text small">choose at least one relay target</span> : null}
                      <button className="btn" disabled={busy || selectedOverrideWouldBlock} onClick={() => { void applyAgent(a, agentSel, `${a.name} relay`).then((ok) => { if (ok) setAgentEditing(null); }); }}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setAgentEditing(null)}>Cancel</button>
                    </div>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>HR Manager</h1>
        <span className="muted small" title="Operational owner for HR Manager staffing and instruction-drafting workflows">
          owner: <b>{hrOwner ? `${hrOwner.team ?? activeTeam}/${hrOwner.name}` : 'unassigned'}</b>
        </span>
      </header>
      <div className="tabs">
        {([['structure', 'Structure'], ['health', 'Health'], ['build', 'Build'], ['route', 'Manage']] as const).map(([k, lbl]) => (
          <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{lbl}</button>
        ))}
      </div>
      {tab === 'structure' ? (
        <section className="card">
          <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Team structure — live</h3>
            <button className="btn" disabled={busy} onClick={() => { setTab('route'); setRoutePane('hierarchy'); }} title="Open Manage > Hierarchy to review primary and coordinator changes">
              Open hierarchy
            </button>
          </div>
          <p className="muted small" style={{ marginTop: -2 }}>
            Structure of every known configured team, including offline or empty teams. The reserved empty public-agent namespace is hidden until it has agents.
            Click an agent or team to inspect goals, instruction markdown, roster, and routing context.
          </p>
          <TeamGraph
            groups={structureGroups}
            hier={hier}
            leadOf={(t, ag) => hier.coordinators[t] ?? resolveCoordinator(ag, undefined) ?? ag[0]?.name}
            selectedKey={selectedKey}
            onSelect={onGraphSelect}
          />
          {selectedAgent ? (
            <div className="card" style={{ marginTop: 10, background: 'var(--bg-2)' }}>
              <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h4 style={{ margin: 0 }}>{selectedAgent.agent.name}{' '}
                  <span className="muted small">· {selectedAgent.team} · {runtimeLabel(selectedAgent.agent.runtime ?? '')} · {selectedAgent.agent.status}</span>
                </h4>
                <span className="row-actions" style={{ gap: 6 }}>
                  {(() => {
                    const isLead = hier.coordinators[selectedAgent.team] === selectedAgent.agent.name;
                    const leadLocked = selectedAgent.team === PRIMARY_TEAM && !isDefaultLead(selectedAgent.team, selectedAgent.agent.name);
                    return (
                      <button className={`star${isLead ? ' on' : ''}`} disabled={busy || isLead || leadLocked}
                        title={leadLocked ? `${PRIMARY_TEAM} coordinator is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}` : isLead ? `${selectedAgent.agent.name} is ${selectedAgent.team}'s lead (coordinator)` : `Open Manage > Hierarchy to set ${selectedAgent.agent.name} as ${selectedAgent.team}'s lead`}
                        onClick={() => { setTab('route'); setRoutePane('hierarchy'); }}>{isLead ? '★ lead' : '☆ set in Manage'}</button>
                    );
                  })()}
                  <select className="cell-select" disabled={busy || selectedAgentLocked || selectedAgent.reassignTargets.length === 0} value="" title={selectedAgentLocked ? 'Locked default leadership roles cannot be moved out of default' : 'Reassign to another team'}
                    onChange={(e) => { const to = e.target.value; e.currentTarget.value = ''; if (to) void moveAgentToTeam(selectedAgent!.agent.id, selectedAgent!.agent.name, selectedAgent!.team, to); }}>
                    <option value="">{selectedAgentLocked ? 'locked role' : selectedAgent.reassignTargets.length === 0 ? 'no other teams' : 'reassign to…'}</option>
                    {selectedAgent.reassignTargets.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button className="btn small" disabled={busy} title="Edit this agent's team relay in Manage > Hierarchy" onClick={() => void openRelayForTeam(selectedAgent!.team)}>⇄ Routing</button>
                  <button className="btn small" disabled={busy} onClick={() => void rebuildSelectedStructureAgent(selectedAgent!.agent, selectedAgent!.team)}>Rebuild</button>
                </span>
              </div>
              <div className="muted small" style={{ margin: '8px 0 4px' }}>instruction markdown — persistent system-prompt addendum</div>
              <div className="row-actions" style={{ gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <button className="btn small" disabled={sgBusy || !hrOwner} title={hrOwner ? `Ask ${hrOwner.team ?? activeTeam}/${hrOwner.name} to draft` : 'No active HR manager agent found'} onClick={() => void aiDraftSgInstr()}>✦ AI draft</button>
                {sgInstr.trim() ? <button className="btn small" disabled={sgBusy} onClick={() => setSgInstr('')}>Clear</button> : null}
                <span className="grow" />
                {sgMsg ? <span className={`small ${/failed/.test(sgMsg) ? 'status-error' : 'ok-text'}`}>{sgMsg}</span> : null}
                <button className="btn primary small" disabled={sgBusy || sgInstr === sgSaved} onClick={() => void saveSgInstr()}>{sgBusy ? '…' : 'Save & rebuild'}</button>
              </div>
              <textarea style={{ width: '100%', minHeight: 140, fontFamily: 'var(--mono)', fontSize: 12 }}
                placeholder={`Instruction markdown for ${selectedAgent.agent.name}. Org Sync preserves manual text while updating its own marker-fenced block.`}
                value={sgInstr} disabled={sgBusy} onChange={(e) => setSgInstr(e.target.value)} />
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border, #2a2a2a)' }}>
                <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <b className="small">Agent goals</b>
                    <span className="muted small"> · shared with Work, scoped to {selectedAgent.team}/{selectedAgent.agent.name}</span>
                  </div>
                  <button className="btn small" disabled={sgGoalBusy} onClick={beginNewAgentGoal}>＋ New goal</button>
                </div>
                <div className="chips" style={{ marginTop: 8 }}>
                  {sgGoals.length ? sgGoals.map((g) => (
                    <button key={g.id} className={`chip${sgGoalEditing === g.id ? ' on' : ''}`} disabled={sgGoalBusy} title={`${GOAL_PRIORITY_LABEL[goalPriority(g.priority)]} · ${g.status}${g.autopilot ? ' · autopilot' : ''} · updated ${ago(g.updatedAt)}`} onClick={() => void openAgentGoal(g.id)}>
                      {GOAL_PRIORITY_LABEL[goalPriority(g.priority)]}: {clipText(g.title, 42)}
                    </button>
                  )) : <span className="muted small">No saved goals for this agent yet.</span>}
                </div>
                {sgGoalEditing ? (
                  <div style={{ marginTop: 10, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '8px 10px' }}>
                    <div className="kv" style={{ gridTemplateColumns: '70px 1fr 70px 140px', gap: 8, alignItems: 'center' }}>
                      <span className="muted small">title</span>
                      <input value={sgGoalTitle} disabled={sgGoalBusy} maxLength={200} placeholder="goal title" onChange={(e) => setSgGoalTitle(e.target.value)} />
                      <span className="muted small">status</span>
                      <select className="cell-select" value={sgGoalStatus} disabled={sgGoalBusy} onChange={(e) => setSgGoalStatus(e.target.value as GoalStatus)}>
                        <option value="draft">draft</option>
                        <option value="active">active</option>
                        <option value="done">done</option>
                        <option value="archived">archived</option>
                      </select>
                      <span className="muted small">tier</span>
                      <select className="cell-select" value={sgGoalPriority} disabled={sgGoalBusy} onChange={(e) => setSgGoalPriority(e.target.value as GoalPriority)}>
                        {GOAL_PRIORITIES.map((p) => <option key={p} value={p}>{GOAL_PRIORITY_LABEL[p]}</option>)}
                      </select>
                    </div>
                    <textarea style={{ width: '100%', minHeight: 120, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}
                      placeholder={`Goal markdown for ${selectedAgent.agent.name}.`}
                      value={sgGoalContent} disabled={sgGoalBusy} onChange={(e) => setSgGoalContent(e.target.value)} />
                    <div className="row-actions" style={{ marginTop: 8 }}>
                      {sgGoalDetail ? <span className="muted small">updated {ago(sgGoalDetail.updatedAt)}</span> : <span className="muted small">new goal</span>}
                      <span className="grow" />
                      {sgGoalDetail ? <button className="btn small danger" disabled={sgGoalBusy} onClick={() => void removeAgentGoal()}>Remove</button> : null}
                      <button className="btn small" disabled={sgGoalBusy} onClick={() => { setSgGoalEditing(null); setSgGoalDetail(null); }}>Cancel</button>
                      <button className="btn primary small" disabled={sgGoalBusy || !sgGoalDirty || !sgGoalContent.trim()} onClick={() => void saveAgentGoal()}>{sgGoalBusy ? 'Saving…' : 'Save goal'}</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : selectedTeamName ? (
            <div className="card" style={{ marginTop: 10, background: 'var(--bg-2)' }}>
              <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0 }}>{hier.primary?.team === selectedTeamName ? '⭑ ' : ''}{selectedTeamName} <span className="muted small">· {selectedTeamRunning}/{selectedTeamKnownTotal} running</span></h4>
                <span className="row-actions" style={{ gap: 6 }}>
                  <button className="btn small primary" onClick={() => setTab('build')}>✦ Build / add agents</button>
                  <button className="btn small" title="Edit this team's relay in Manage > Hierarchy" onClick={() => void openRelayForTeam(selectedTeamName)}>⇄ Routing</button>
                  <button className="btn small" title="Start / stop this team in Manage > Team ops" onClick={() => { setTab('route'); setRoutePane('operations'); }}>⏻ Start / stop</button>
                </span>
              </div>
              <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '4px 12px', marginTop: 8 }}>
                <span className="muted small">coordinator</span>
                <span className={selectedTeamLead && !selectedTeamAgents.some((a) => a.name === selectedTeamLead && isRunnableAgent(a)) ? 'warn-text small' : 'small'}>
                  {selectedTeamLead || '—'}{selectedTeamLead && !selectedTeamAgents.some((a) => a.name === selectedTeamLead && isRunnableAgent(a)) ? ' · not running' : ''}
                </span>
                <span className="muted small">validator path</span>
                <span className="small">{selectedTeamSecondaries.length ? selectedTeamSecondaries.map((s) => `${s.team}/${s.agent}`).join(', ') : selectedTeamName === PRIMARY_TEAM ? DEFAULT_VALIDATORS.map((a) => `${PRIMARY_TEAM}/${a}`).join(', ') : 'default validators by org sync'}</span>
                <span className="muted small">roster</span>
                <span className="small">
                  {selectedTeamAgents.length ? selectedTeamAgents.slice().sort((a, b) => a.name.localeCompare(b.name)).map((a) => `${a.name} (${a.status || 'unknown'})`).join(', ') : 'No live roster rows yet; team config is still visible.'}
                </span>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>Click an agent in the graph to edit its goal records and instruction markdown without switching the active team.</p>
            </div>
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>Select an agent or team in the graph to manage it.</p>
          )}
        </section>
      ) : null}

      {tab === 'health' ? (
        <Health store={store} navigate={navigate} embedded />
      ) : null}

      {tab === 'route' ? (
        <div className="tabs" style={{ marginTop: -4 }}>
          {([['operations', 'Team ops'], ['overview', 'Overview'], ['hierarchy', 'Hierarchy']] as const).map(([k, lbl]) => (
            <button key={k} className={`tab${routePane === k ? ' active' : ''}`} onClick={() => setRoutePane(k)}>{lbl}</button>
          ))}
        </div>
      ) : null}

      {tab === 'route' && routePane === 'operations' ? (
      <section className="card">
        <div className="row-actions" style={{ alignItems: 'baseline', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Team management</h3>
          <span className="muted small">· lifecycle only. Edit selected-agent instructions in Structure; set leads and org sync in Hierarchy.</span>
          <span className="grow" />
          <button className="btn small" disabled={busy} title="Open the live structure graph to select an agent and edit its instruction addendum" onClick={() => setTab('structure')}>Structure</button>
          <button className="btn small" disabled={busy} title="Open hierarchy and org sync" onClick={() => setRoutePane('hierarchy')}>Hierarchy</button>
          {teamOpBusy ? <span className="muted small">working…</span> : teamOpMsg ? <span className={`small ${/fail/.test(teamOpMsg) ? 'status-error' : 'ok-text'}`}>{teamOpMsg}</span> : null}
        </div>
        <table className="grid">
          <thead>
            <tr><th>Team</th><th>Running</th><th>Lifecycle</th><th></th></tr>
          </thead>
          <tbody>
            {visibleTeams.map((t) => {
              const teamAgents = store.allAgents.filter((a) => a.team === t.name);
              const running = teamAgents.filter((a) => !!a.status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(a.status)).length;
              const total = teamAgents.length || Number(t.agentCount) || 0;
              const isPrimary = hier.primary?.team === t.name;
              const canStart = total > 0 && running < total;
              const canStop = running > 0;
              const canProbe = total > 0;
              const canRebuild = total > 0;
              return (
                <tr key={t.id} className={t.name === store.team ? 'sel' : ''}>
                  <td className="b">{isPrimary ? '⭑ ' : ''}{t.name === store.team ? '● ' : ''}{t.name}</td>
                  <td className={running ? 'ok-text' : 'muted'}>{running}/{total}</td>
                  <td className="row-actions">
                    <button className="btn small" disabled={teamOpBusy || !canStart} title={canStart ? `Start stopped agents in ${t.name}` : total ? 'All current agents are already running' : 'No agents to start'} onClick={() => void runTeamOp(t.name, 'start')}>▶ Start all</button>
                    <button className="btn small danger" disabled={teamOpBusy || !canStop} title={canStop ? `Stop running agents in ${t.name}` : 'No running agents to stop'} onClick={() => void runTeamOp(t.name, 'stop')}>■ Stop all</button>
                    <button className="btn small" disabled={teamOpBusy || !canProbe} title={canProbe ? `Health-probe ${t.name}` : 'No agents to probe'} onClick={() => void runTeamOp(t.name, 'probe')}>◇ Probe</button>
                    <button className="btn small" disabled={teamOpBusy || !canRebuild} title={canRebuild ? `Rebuild (restart) every agent in ${t.name}` : 'No agents to rebuild'} onClick={() => void runTeamOp(t.name, 'rebuild')}>↻ Rebuild</button>
                  </td>
                  <td>
                    {t.name !== 'default' && total === 0 ? (
                      <button className="btn small" disabled={busy} style={{ color: 'var(--danger, #e5534b)' }} title={`Delete the empty "${t.name}" team`} onClick={() => void removeTeam(t.name)}>Delete</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      ) : null}

      {tab === 'build' ? (
        // One inline form: pick a team (new or existing) + start from a template/config or
        // describe with AI → review the roster → build. No popouts.
        <>
          <TeamBuilder
            inline
            team=""
            existingTeams={visibleTeams.map((t) => t.name)}
            activeTeams={activeTeamNames}
            existingAgents={existingAgentsByTeam}
            fleetAgents={store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: activeTeam }))}
            hierarchy={hier}
            hrOwner={hrOwner}
            providers={providers}
            managedRuntimes={Object.values(managedRuntimes)}
            modelCatalog={modelCatalog}
            skillCatalog={skillCatalog}
            onRuntimeVerified={(report) => {
              setModelCatalog(report.refreshedCatalog);
              setProviders(report.providers);
              primeRuntimeCatalogSnapshot(hrRuntimeCatalogVersion, {
                modelCatalog: report.refreshedCatalog,
                providers: report.providers,
                managedRuntimes,
              });
            }}
            onClose={() => { /* inline — nothing to close */ }}
            onBusy={setBusy}
            onMessage={setMsg}
            onDone={(createdTeam) => { if (createdTeam) void store.setTeam(createdTeam); store.refresh(); }}
          />
          <section className="card" style={{ marginTop: 12 }}>
            <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Team maintenance</h3>
              {maintMsg ? <span className={`small ${/failed|blocked/.test(maintMsg) ? 'status-error' : 'ok-text'}`}>{maintMsg}</span> : null}
            </div>
            <div className="row-actions" style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select className="cell-select" disabled={maintBusy} value={maintMode} onChange={(e) => { setMaintMode(e.target.value as 'rename' | 'merge'); setMaintTo(''); }}>
                <option value="rename">Rename team</option>
                <option value="merge">Merge into team</option>
              </select>
              <select className="cell-select" disabled={maintBusy} value={maintFrom} onChange={(e) => {
                const next = e.target.value;
                setMaintFrom(next);
                if (next && canonicalTeamName(maintTo) === next) setMaintTo('');
              }}>
                <option value="">source team…</option>
                {allKnownTeamNames.filter((t) => t !== PRIMARY_TEAM).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="muted small">→</span>
              {maintMode === 'rename' ? (
                <input value={maintTo} disabled={maintBusy} placeholder="new-team-name" onChange={(e) => setMaintTo(e.target.value)} onBlur={() => setMaintTo(canonicalTeamName(maintTo))} />
              ) : (
                <select className="cell-select" disabled={maintBusy} value={maintTo} onChange={(e) => setMaintTo(e.target.value)}>
                  <option value="">target team…</option>
                  {allKnownTeamNames.filter((t) => t !== maintFrom).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <label className="muted small" title="After all agents move, remove the source team if it is empty.">
                <input type="checkbox" checked={maintDeleteSource} disabled={maintBusy} onChange={(e) => setMaintDeleteSource(e.target.checked)} /> delete empty source
              </label>
              <span className="grow" />
              <button className="btn primary" disabled={maintBusy || !maintCanRun} onClick={() => void runTeamMaintenance()}>
                {maintBusy ? 'Working…' : maintMode === 'rename' ? 'Rename' : 'Merge'}
              </button>
            </div>
            <div className="row-actions" style={{ marginTop: 8, justifyContent: 'flex-start', alignItems: 'center' }}>
              <span className="muted small grow">
                {maintSummary}
                {maintWarnings.length ? <span className="warn-text"> {maintWarnings.join(' · ')}</span> : null}
              </span>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'route' && routePane === 'overview' ? (
      <section className="card">
        <h3>Routing overview <span className="muted small">· every team's outbound relay, at a glance</span></h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Who each team may delegate work to (via <span className="mono">/ask &lt;team&gt;/&lt;agent&gt;</span>). <b>Edit</b> opens Hierarchy for that team.
        </p>
        <table className="grid">
          <thead>
            <tr><th>Team</th><th>Lead</th><th>Relays to</th><th>Agents</th><th></th></tr>
          </thead>
          <tbody>
            {(visibleRelayMatrix.length ? visibleRelayMatrix : allKnownTeamNames.map((team) => ({ team, delegates: null as string[] | null })))
              .sort((a, b) => (a.team === activeTeam ? -1 : b.team === activeTeam ? 1 : a.team.localeCompare(b.team)))
              .map((row) => {
                const ags = visibleGraphGroups.find((g) => g.team === row.team)?.agents ?? [];
                const lead = hier.coordinators[row.team] || (hier.primary?.team === row.team ? hier.primary.agent : '');
                const leadAgent = lead ? ags.find((a) => a.name === lead) : undefined;
                const staleLead = Boolean(lead && (!leadAgent || !isRunnableAgent(leadAgent)));
                const m = modeOf(row.delegates);
                const cls = m === 'none' ? 'status-error' : m === 'all' || m === 'permissive' ? 'ok-text' : '';
                return (
                  <tr key={row.team} className={row.team === activeTeam ? 'sel' : ''}>
                    <td className="b">{hier.primary?.team === row.team ? '⭑ ' : ''}{row.team === activeTeam ? '● ' : ''}{row.team}</td>
                    <td className={`small ${staleLead ? 'warn-text' : 'muted'}`} title={staleLead ? `${row.team}/${lead} is not a running current agent` : undefined}>{lead || '—'}{staleLead ? ' · not running' : ''}</td>
                    <td className={`small ${cls}`}>{describeRelay(row.delegates)}</td>
                    <td className="muted small">{ags.length}</td>
                    <td>
                      <button className="btn small" disabled={busy} title={`Edit ${row.team}'s relay policy`} onClick={() => void openRelayForTeam(row.team)}>Edit</button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </section>
      ) : null}

      {tab === 'route' && routePane === 'hierarchy' ? (
      <section className="card">
        <h3>Lead hierarchy &amp; coordinators</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Each team has a <b>coordinator</b> (its lead). The fleet <b>primary</b> is locked to the <b>default</b> team;
          it delegates to each other team's coordinator, which delegates to its workers. Pick coordinators here, then sync the org.
        </p>
        <div className="kv" style={{ gridTemplateColumns: 'minmax(120px,1fr) 220px 120px', gap: '6px 12px', alignItems: 'center' }}>
          <span className="muted small">team</span>
          <span className="muted small">coordinator</span>
          <span className="muted small">primary lead</span>
          {visibleTeams.map((t) => {
            const ags = visibleGraphGroups.find((g) => g.team === t.name)?.agents ?? [];
            const coord = hier.coordinators[t.name] || (hier.primary?.team === t.name ? hier.primary.agent : '');
            const isPrimary = !!hier.primary && hier.primary.team === t.name;
            const runningAgents = ags.filter(isRunnableAgent);
            const coordChoices = t.name === PRIMARY_TEAM ? runningAgents.filter((a) => isDefaultLead(t.name, a.name)) : runningAgents;
            const staleCoord = Boolean(coord && !coordChoices.some((a) => a.name === coord));
            const primaryIsLockedLead = isPrimary && isDefaultLead(t.name, hier.primary?.agent ?? '');
            const defaultLeadName = coordChoices[0]?.name ?? DEFAULT_LEAD;
            const canMakePrimary = t.name === PRIMARY_TEAM && coordChoices.length > 0;
            return (
              <Fragment key={t.id}>
                <span className="b">{isPrimary ? '⭑ ' : ''}{t.name} <span className="muted small">· {ags.length}</span>{staleCoord ? <span className="warn-text small" title={`${t.name}/${coord} is not a running current coordinator`}> · coordinator not running</span> : null}</span>
                <select className="cell-select" disabled={busy || coordChoices.length === 0} value={coordChoices.some((a) => a.name === coord) ? coord : ''}
                  onChange={(e) => void setTeamCoordinator(t.name, e.target.value)}>
                  <option value="">{coordChoices.length ? (staleCoord ? `${coord} unavailable — choose running…` : t.name === PRIMARY_TEAM ? 'default/lead only' : 'no coordinator — choose…') : staleCoord ? `${coord} unavailable — start in Manage` : 'no running agents'}</option>
                  {coordChoices.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
                {primaryIsLockedLead ? (
                  <span className="ok-text small">⭑ primary</span>
                ) : t.name !== PRIMARY_TEAM ? (
                  <span className="muted small" title={`${t.name}/${coord || 'lead'} can be a team coordinator; fleet primary stays ${PRIMARY_TEAM}/${DEFAULT_LEAD}`}>
                    default/lead
                  </span>
                ) : (
                  <button className="btn small" disabled={busy || !canMakePrimary}
                    title={canMakePrimary ? `Make ${t.name}/${defaultLeadName} the primary cross-team lead` : `Primary is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}`}
                    onClick={() => void makePrimaryFor(t.name, defaultLeadName)}>make primary</button>
                )}
              </Fragment>
            );
          })}
        </div>
        {!hier.primary ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            No primary lead yet — set the <b>default</b> team coordinator, then make default primary so it delegates across teams.
          </p>
        ) : null}

        <RelayPolicySection />

        {/* Reactive Org Sync — secondary leads + auto-composed goals files */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border, #2a2a2a)' }}>
          <div className="row-actions" style={{ alignItems: 'center', gap: 10 }}>
            <h4 style={{ margin: 0 }}>Reactive goals &amp; org sync</h4>
            <span className="grow" />
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Continuously compose each agent's goals file from the hierarchy + brain team-instructions">
              <input type="checkbox" checked={orgCfg.enabled !== false} onChange={(e) => void toggleOrg({ enabled: e.target.checked })} /> auto-sync
            </label>
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Rebuild an agent when its goals change AND it's idle (so the new file takes effect)">
              <input type="checkbox" checked={orgCfg.autoRebuild !== false} onChange={(e) => void toggleOrg({ autoRebuild: e.target.checked })} /> auto-rebuild
            </label>
            <button className="btn small" disabled={orgBusy} onClick={() => void syncOrgNow()} title="Preview affected agents, then recompose goals from the hierarchy + brain">{orgBusy ? 'working…' : 'Preview & sync'}</button>
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            Each agent's <b>goals &amp; instructions</b> file is composed from its place in the org: <b>primary</b> (<code>{hier.primary?.agent ?? 'unset'}</code>) → team leads → workers, then completed work flows back through the default-team validators before returning to the primary. <b>coder</b> and <b>researcher</b> stay protected; additional default-team validators can be added below. Brain <code>team-instruction</code> memories are embedded, and the hierarchy is written back to the brain.
          </p>
          <div className="kv" style={{ gridTemplateColumns: 'minmax(110px,160px) 1fr', gap: '4px 12px', alignItems: 'center', marginTop: 6 }}>
            <span className="muted small">validator</span>
            <span className="muted small">validates completed work from</span>
            {validatorRows.length ? validatorRows.map((s) => (
              <Fragment key={s.agent}>
                <span className="b">{s.agent} <span className="muted small">· {s.team}{DEFAULT_VALIDATORS.includes(slugName(s.agent)) ? ' · protected' : ''}</span></span>
                <span className="small">{s.leadsTeams.length ? s.leadsTeams.map((t) => `${hier.coordinators[t] ?? '(no lead)'} (${t})`).join(', ') : <span className="muted">— none —</span>}</span>
              </Fragment>
            )) : <><span className="muted small">—</span><span className="muted small">defaults to researcher + coder on default</span></>}
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="row-actions" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <div className="muted small grow">validator coverage matrix</div>
              <select className="cell-select" value={validatorPick} disabled={orgBusy || !defaultTeamValidatorCandidates.length} onChange={(e) => setValidatorPick(e.target.value)} title="Additional validators must be agents on the default team; default/lead is reserved as primary.">
                <option value="">{defaultTeamValidatorCandidates.length ? 'add default-team validator…' : 'no additional default agents'}</option>
                {defaultTeamValidatorCandidates.map((name) => <option key={name} value={name}>{PRIMARY_TEAM}/{name}</option>)}
              </select>
              <button className="btn small" disabled={orgBusy || !validatorPick} onClick={() => void addSecondaryValidator(validatorPick)}>Add validator</button>
            </div>
            {validatorRows.map((s) => {
              const agent = slugName(s.agent);
              const isProtected = DEFAULT_VALIDATORS.includes(agent);
              const covered = new Set(s.leadsTeams ?? []);
              const editableTeams = allKnownTeamNames.filter((t) => t !== PRIMARY_TEAM && t !== 'public');
              return (
                <div key={agent} className="row-actions" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span className="b small" style={{ minWidth: 132 }}>{PRIMARY_TEAM}/{agent}</span>
                  <div className="chips">
                    {editableTeams.length ? editableTeams.map((teamName) => {
                      const on = covered.has(teamName);
                      return (
                        <button key={`${agent}:${teamName}`} className={`chip${on ? ' on' : ''}`} disabled={orgBusy} title={`${on ? 'Remove' : 'Add'} ${PRIMARY_TEAM}/${agent} validator coverage for ${teamName}`} onClick={() => void saveSecondaryCoverage(agent, teamName, !on)}>
                          {on ? '✓ ' : ''}{teamName}
                        </button>
                      );
                    }) : <span className="muted small">No non-default teams yet.</span>}
                  </div>
                  {isProtected ? <span className="muted small" title="Protected default validator">protected</span> : (
                    <button className="btn small" disabled={orgBusy} onClick={() => void removeSecondaryValidator(agent)} title={`Remove ${PRIMARY_TEAM}/${agent} from the validator roster`}>Remove</button>
                  )}
                </div>
              );
            })}
          </div>
          {orgResult ? <p className="muted small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{orgResult}</p> : null}
        </div>
      </section>
      ) : null}

      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}

/**
 * The unified AI Team Builder — one flow that replaces the old "Import from spec"
 * and "Onboard agents" modals. Describe a team in plain English (or paste a spec),
 * let AI (or a deterministic parse) draft the roster with a per-agent runtime,
 * model and skills, review/edit it, then build every agent in one pass via
 * `onboard:run` (which carries each agent's persona). After the agents land it can
 * auto-wire coordination (make the ★ lead the team coordinator + apply the
 * delegate-to-teammates preset) and the new team's cross-team relay policy.
 */
function TeamBuilder({
  team,
  existingTeams,
  activeTeams,
  existingAgents,
  fleetAgents,
  hierarchy,
  hrOwner,
  providers,
  managedRuntimes,
  modelCatalog,
  skillCatalog,
  inline = false,
  onRuntimeVerified,
  onClose,
  onBusy,
  onMessage,
  onDone,
}: {
  team: string;
  existingTeams: string[];
  activeTeams: string[];
  /** team → its current agent names, so the builder can skip agents that already exist
   *  instead of hard-erroring the whole batch. */
  existingAgents: Record<string, string[]>;
  /** Holistic active + inactive fleet roster, across teams, for HR/AI planning context. */
  fleetAgents: HrAgentCandidate[];
  hierarchy: HrHierarchy;
  /** Preferred HR manager helper; may live in another team. */
  hrOwner?: { name: string; team?: string } | null;
  providers: ProviderRow[];
  managedRuntimes: ManagedRuntimeStatus[];
  modelCatalog: Record<string, string[]>;
  skillCatalog: string[];
  inline?: boolean;
  onRuntimeVerified?: (report: RuntimeVerificationReport) => void;
  onClose: () => void;
  onBusy: (b: boolean) => void;
  onMessage: (m: string) => void;
  onDone: (createdTeam?: string) => void;
}) {
  const harnessRuntimes = useMemo(() => offerableRuntimes(providers, undefined, managedRuntimes), [providers, managedRuntimes]);
  const subscriptionRuntimes = useMemo(
    () => harnessRuntimes.filter((rt) => runtimePickerGroup(rt) === 'subscription'),
    [harnessRuntimes],
  );
  const localRuntimes = useMemo(
    () => harnessRuntimes.filter((rt) => runtimePickerGroup(rt) === 'local'),
    [harnessRuntimes],
  );
  const apiProviderLanes = useMemo(
    () => buildProviderModelLanes(providers).filter((lane) => lane.kind === 'api' && lane.selectable),
    [providers],
  );
  const runtimes = useMemo(
    () => Array.from(new Set([...harnessRuntimes, ...apiProviderLanes.map((lane) => lane.id)])),
    [harnessRuntimes, apiProviderLanes],
  );
  const initialRuntime = runtimes[0] ?? '';
  type Row = { name: string; runtime: string; model: string; role: string; description: string; skills: string[]; lead: boolean; open: boolean };
  const blankRow = (): Row => ({ name: '', runtime: initialRuntime, model: '', role: '', description: '', skills: [], lead: false, open: false });
  // Map a parsed/AI-designed agent onto a builder row, sanitizing the AI's runtime/
  // model/skill picks against what's actually available.
  const toRow = (a: { name: string; role: string; description: string; runtime?: string; model?: string; skills?: string[]; lead?: boolean }): Row => {
    const runtime = a.runtime && runtimes.includes(a.runtime) ? a.runtime : initialRuntime;
    return {
      name: a.name,
      runtime,
      model: a.model && (modelCatalog[runtime] ?? []).includes(a.model) ? a.model : '',
      role: a.role,
      description: a.description,
      skills: (a.skills ?? []).filter((s) => skillCatalog.includes(s)),
      lead: Boolean(a.lead),
      open: false,
    };
  };

  // ---- target team (existing or new) ----
  // Existing-team picker lists the full roster of teams, including inactive ones, so HR can add
  // agents to an idle team without recreating or duplicating it. Active teams sort first.
  const teamOptions = useMemo(() => {
    const active = new Set(activeTeams.filter(Boolean));
    return [...existingTeams]
      .filter(Boolean)
      .sort((a, b) => Number(active.has(b)) - Number(active.has(a)) || a.localeCompare(b));
  }, [activeTeams, existingTeams]);
  const [teamSel, setTeamSel] = useState<string>(team && existingTeams.includes(team) ? team : '__new__');
  const [newTeam, setNewTeam] = useState(team && !existingTeams.includes(team) ? canonicalTeamName(team) : '');
  const [teamTouched, setTeamTouched] = useState(false);
  const usingNewTeam = teamSel === '__new__';
  const targetTeam = usingNewTeam ? canonicalTeamName(newTeam) : teamSel;
  const teamExists = existingTeams.includes(targetTeam);

  // ---- spec / AI design ----
  const [spec, setSpec] = useState('');
  // "Start from" sources — prefill the describe box from a library template or saved config.
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all([
      call<TeamTemplate[]>('libraryTeams').catch(() => [] as TeamTemplate[]),
      call<ConfigEntry[]>('configs').catch(() => [] as ConfigEntry[]),
    ]).then(([tpls, cfgs]) => { if (live) { setTemplates(tpls); setConfigs(cfgs.filter((c) => c.name !== 'default')); } });
    return () => { live = false; };
  }, []);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  // Once the roster is hand-edited or AI-designed, stop letting the live spec parse
  // overwrite it (so manual curation isn't silently discarded mid-edit).
  const [rowsDirty, setRowsDirty] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0); // seconds the AI design call has been running
  const [aiSuggestions, setAiSuggestions] = useState<DesignedTeam['suggestions']>();
  const aiRun = useRef(0); // bumps to invalidate a stale/cancelled design wait

  // ---- options applied to every agent ----
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [sharedSkills, setSharedSkills] = useState<string[]>([]);
  const [heartbeat, setHeartbeat] = useState(false);
  const [hbInterval, setHbInterval] = useState(3600);
  const [wallet, setWallet] = useState(false);
  const [probeAfter, setProbeAfter] = useState(true);

  // ---- coordination + relay ----
  const [coordinate, setCoordinate] = useState(false);
  const coordinateTargetRef = useRef(targetTeam);
  const [relayMode, setRelayMode] = useState<RelayMode>('permissive');
  const [relaySel, setRelaySel] = useState<string[]>([]);
  const relayTargets = existingTeams.filter((n) => n !== targetTeam);

  // ---- build progress ----
  type ResultEntry = { name: string; team: string; plan: OnboardPlan; result?: OnboardResult; error?: string; running?: boolean; skipped?: boolean; merged?: boolean };
  const [building, setBuilding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [post, setPost] = useState<{ coord?: PostStat; coordErr?: string; leadName?: string; relay?: PostStat; relayErr?: string }>({});

  const mcpChoices = MCP_CATALOG.filter((entry) => !(entry.inputs ?? []).some((input) => input.required && !input.default));
  const availableMcpChoices = mcpChoices.filter((entry) => !mcpIds.includes(entry.id));
  const availableSharedSkills = skillCatalog.filter((skill) => !sharedSkills.includes(skill));
  const named = rows.map((r) => ({ ...r, slug: slugName(r.name) })).filter((r) => r.slug);
  const reserved = [...new Set(named.filter((r) => isReservedName(r.slug)).map((r) => r.slug))];
  const dupes = [...new Set(named.map((r) => r.slug).filter((s, i, a) => a.indexOf(s) !== i))];
  // Agents already in the target team — skip them on build instead of hard-erroring the batch.
  const existingInTeam = useMemo(() => new Set((existingAgents[targetTeam] ?? []).map((n) => slugName(n))), [existingAgents, targetTeam]);
  const alreadyThere = named.filter((r) => existingInTeam.has(r.slug));
  const toCreate = named.filter((r) => !existingInTeam.has(r.slug));
  const missingRuntime = toCreate.some((r) => !r.runtime || !runtimes.includes(r.runtime));
  const relayPayload: string[] | null =
    relayMode === 'all' ? ['*'] : relayMode === 'none' ? [] : relayMode === 'select' ? relaySel : null;
  const builderRelayBlocksDefault = targetTeam === PRIMARY_TEAM && relayBlocksAll(relayPayload);
  const defaultLeadAvailableForWire = targetTeam !== PRIMARY_TEAM || existingInTeam.has(DEFAULT_LEAD) || named.some((r) => r.slug === DEFAULT_LEAD);
  const defaultLeadMissingForWire = coordinate && targetTeam === PRIMARY_TEAM && !defaultLeadAvailableForWire;
  const locked = building || aiBusy || verifying;
  const canBuild = !locked && Boolean(targetTeam) && !isReservedName(targetTeam) && toCreate.length > 0 && reserved.length === 0 && dupes.length === 0 && !builderRelayBlocksDefault && !defaultLeadMissingForWire && !missingRuntime;
  const leadershipBackbone = useMemo(() => assessLeadershipBackbone(fleetAgents, hierarchy), [fleetAgents, hierarchy]);
  const leadershipIssues = leadershipBackboneIssues(leadershipBackbone);
  const blueprintCoverages = useMemo(() => RECOMMENDED_TEAM_BLUEPRINTS.map((bp) => blueprintCoverage(fleetAgents, bp)), [fleetAgents]);
  const targetNeedsBackbone = Boolean(targetTeam) && targetTeam !== PRIMARY_TEAM && !leadershipBackbone.ready;

  useEffect(() => {
    if (coordinateTargetRef.current === targetTeam) return;
    coordinateTargetRef.current = targetTeam;
    setCoordinate(false);
  }, [targetTeam]);

  function toggleCoordinate(next: boolean) {
    if (!next) { setCoordinate(false); return; }
    const leadRow = named.find((r) => r.lead) ?? named[0];
    const leadName = targetTeam === PRIMARY_TEAM ? DEFAULT_LEAD : leadRow?.slug || 'the starred lead';
    const message = targetTeam === PRIMARY_TEAM
      ? `Enable primary routing wiring for ${PRIMARY_TEAM}?\n\nThis can change the fleet primary route by setting ${PRIMARY_TEAM}/${DEFAULT_LEAD} as primary, writing the default-primary validation preset, and rebuilding ${PRIMARY_TEAM}/${DEFAULT_LEAD} after the build.\n\nUse this only when you are intentionally repairing or installing the default leadership backbone.`
      : `Enable coordinator routing wiring for ${targetTeam || 'this team'}?\n\nThis will make ${targetTeam || 'team'}/${leadName} the team coordinator, write the delegate-to-teammates preset, and rebuild that lead after the build.\n\nUse this only when the lead and roster have been reviewed.`;
    if (!window.confirm(message)) return;
    setCoordinate(true);
  }

  // Live deterministic parse as the user types a spec — until they hand-edit or AI runs.
  useEffect(() => {
    if (rowsDirty) return;
    if (!spec.trim()) { setRows([blankRow()]); return; }
    const parsed = parseTeamSpec(spec);
    setRows(parsed.agents.length ? parsed.agents.map(toRow) : [blankRow()]);
    // Only adopt the spec's team name when we're building a NEW team — never
    // hijack an "add agents to <existing team>" session.
    if (parsed.team && !teamTouched && teamSel === '__new__') {
      const parsedTeam = canonicalTeamName(parsed.team);
      setNewTeam((p) => p || parsedTeam || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  // Tick an elapsed counter while the AI design call is in flight (progress feedback).
  useEffect(() => {
    if (!aiBusy) return;
    const t = setInterval(() => setAiElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [aiBusy]);

  async function aiDesign() {
    if (!spec.trim()) return;
    const runId = ++aiRun.current;
    setAiElapsed(0); setAiBusy(true); setError(''); setAiSuggestions(undefined);
    const helper = hrOwner?.name ? `${hrOwner.team ? `${hrOwner.team}/` : ''}${hrOwner.name}` : undefined;
    const roster = summarizeFleetRoster(fleetAgents, activeTeams);
    onMessage(helper ? `asking ${helper} to design the team…` : 'asking AI to design the team…');
    try {
      const r = await call<DesignedTeam>('team:designAI', spec, { runtimes, models: modelCatalog, skills: skillCatalog, agent: helper, fleetRoster: roster });
      if (aiRun.current !== runId) return; // stopped or superseded — ignore the late reply
      if (r?.agents?.length) {
        const mapped = r.agents.map(toRow);
        if (!mapped.some((m) => m.lead)) mapped[0].lead = true;
        setRows(mapped); setRowsDirty(true);
      }
      if (r?.team && !teamTouched && teamSel === '__new__') {
        const designedTeam = canonicalTeamName(r.team);
        setNewTeam((p) => p || designedTeam || '');
      }
      setAiSuggestions(r?.suggestions);
      const suggestionCount = (r?.suggestions?.agents?.length ?? 0) + (r?.suggestions?.skills?.length ?? 0);
      onMessage(`AI designed ${r?.agents?.length ?? 0} agent(s)${suggestionCount ? ` and suggested ${suggestionCount} fleet improvement(s)` : ''}`);
    } catch (e) {
      if (aiRun.current === runId) setError(`AI design failed: ${e instanceof Error ? e.message : String(e)} — keeping the current roster.`);
    } finally { if (aiRun.current === runId) setAiBusy(false); }
  }
  // Soft-cancel: stop blocking the UI on a slow design. The agent query may still
  // finish server-side, but its now-stale reply is ignored (guarded by aiRun).
  function stopAi() {
    aiRun.current++;
    setAiBusy(false);
    onMessage('stopped waiting for the AI design (it may still finish on the agent).');
  }

  function updateRow(i: number, patch: Partial<Row>) { setRowsDirty(true); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function addRow() { setRowsDirty(true); setRows((rs) => [...rs, blankRow()]); }
  function startSingleAgentAdd() {
    setRowsDirty(true);
    setRows([blankRow()]);
    setSpec('');
    setAiSuggestions(undefined);
    setResults([]);
    setPost({});
    setError('');
  }
  function removeRow(i: number) { setRowsDirty(true); setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i))); }
  function setLead(i: number) { setRowsDirty(true); setRows((rs) => rs.map((r, j) => ({ ...r, lead: j === i }))); }
  function toggleRowSkill(i: number, name: string) {
    setRowsDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, skills: r.skills.includes(name) ? r.skills.filter((x) => x !== name) : [...r.skills, name] } : r)));
  }
  function addMcp(id: string) {
    if (!id) return;
    setMcpIds((ids) => ids.includes(id) ? ids : [...ids, id]);
  }
  function addSharedSkill(name: string) {
    if (!name) return;
    setSharedSkills((skills) => skills.includes(name) ? skills : [...skills, name]);
  }
  function pickTeam(v: string) { setTeamTouched(true); setTeamSel(v); }

  function applyStartSource(value: string) {
    if (!value) return;
    const [kind, ...rest] = value.split(':');
    const name = rest.join(':');
    let nextSpec = '';
    let targetHint = '';
    if (kind === 'bp') {
      const bp = RECOMMENDED_TEAM_BLUEPRINTS.find((x) => x.id === name);
      if (!bp) return;
      nextSpec = bp.spec;
      targetHint = bp.team;
    } else {
      const src = kind === 'tpl' ? templates.find((x) => x.name === name) : configs.find((x) => x.name === name);
      const desc = src && typeof (src as { description?: unknown }).description === 'string' ? (src as { description?: string }).description : '';
      nextSpec = `Base this team on the "${name}" ${kind === 'tpl' ? 'library template' : 'saved config'}${desc ? ` (${desc})` : ''}: recreate its roster — a lead coordinator plus workers — and adjust as needed.`;
      targetHint = canonicalTeamName(name);
    }
    setRowsDirty(false);
    setAiSuggestions(undefined);
    setError('');
    setSpec(nextSpec);
    if (!teamTouched && targetHint) {
      if (existingTeams.includes(targetHint)) {
        setTeamSel(targetHint);
        setNewTeam('');
      } else {
        setTeamSel('__new__');
        setNewTeam(targetHint);
      }
    }
  }

  function planFor(r: Row): OnboardPlan {
    const skills = Array.from(new Set([...sharedSkills, ...r.skills]));
    return {
      name: slugName(r.name),
      team: targetTeam,
      runtime: r.runtime || undefined,
      model: r.model || undefined,
      role: r.role.trim() || undefined,
      description: r.description.trim() || undefined,
      skills: skills.length ? skills : undefined,
      wallet,
      heartbeatSeconds: heartbeat ? hbInterval : undefined,
      mcpServers: mcpFromChoices(mcpIds),
      probeAfter,
    };
  }

  type BuilderPreflight = {
    targetTeam: string;
    teamExists: boolean;
    existingAgentCount: number;
    hierarchy: HrHierarchy;
    hierarchyStamp: string;
    relayStamp: string;
    leadershipBackbone: LeadershipBackbone;
  };
  async function preflightBuildTarget(): Promise<BuilderPreflight | null> {
    setError('');
    onMessage(`checking ${targetTeam} before build…`);
    const [teamsNow, groupsNow, hierarchyNow] = await Promise.all([
      call<Array<{ name: string }>>('teams').catch(() => []),
      freshHrGroups(),
      call<HrHierarchy>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })),
    ]);
    const freshTeamExists = teamsNow.some((t) => t.name === targetTeam);
    const renderedTeamExists = existingTeams.includes(targetTeam);
    if (freshTeamExists !== renderedTeamExists) {
      setError(`Team "${targetTeam}" changed while this builder was open. Refresh and review before building.`);
      onMessage(`build blocked: ${targetTeam} team list changed`);
      onDone();
      return null;
    }
    const freshRoster = agentsForTeam(groupsNow, targetTeam);
    const freshRosterKey = agentNameKey(freshRoster);
    const renderedRosterKey = sortedKey((existingAgents[targetTeam] ?? []).map((n) => slugName(n)));
    if (freshRosterKey !== renderedRosterKey) {
      setError(`The ${targetTeam} roster changed while this builder was open. Refresh and review the current agents before building.`);
      onMessage(`build blocked: ${targetTeam} roster changed`);
      onDone();
      return null;
    }
    let relayBefore: string[] | null = null;
    if (freshTeamExists) {
      relayBefore = await call<{ delegates_to: string[] | null }>('teamConfig', targetTeam)
        .then((r) => r.delegates_to)
        .catch(() => null);
    }
    const freshFleetAgents = groupsNow.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team })));
    return {
      targetTeam,
      teamExists: freshTeamExists,
      existingAgentCount: freshRoster.length,
      hierarchy: hierarchyNow,
      hierarchyStamp: hierarchyStamp(hierarchyNow),
      relayStamp: relayKey(relayBefore),
      leadershipBackbone: assessLeadershipBackbone(freshFleetAgents, hierarchyNow),
    };
  }

  function verificationSummary(report: RuntimeVerificationReport): string {
    const lines = report.rows.slice(0, 8).map((row) => {
      const model = row.model ? ` / ${row.model}` : '';
      return `- ${row.name}: ${row.label}${model}`;
    });
    return [
      'Runtime verification:',
      ...lines,
      report.rows.length > lines.length ? `- +${report.rows.length - lines.length} more` : '',
    ].filter(Boolean).join('\n');
  }

  async function verifyBuildRuntimes(batch: Array<Row & { slug: string }>): Promise<RuntimeVerificationReport | null> {
    setVerifyMsg('verifying runtimes and models...');
    setVerifying(true);
    onBusy(true);
    try {
      const report = await call<RuntimeVerificationReport>('runtime:verifyAssignments', batch.map((r) => ({
        name: r.slug,
        runtime: r.runtime,
        model: r.model,
      })));
      onRuntimeVerified?.(report);
      if (!report.ok) {
        const blocked = report.rows.filter((row) => !row.ok);
        setError([
          'Runtime verification blocked this build:',
          ...blocked.slice(0, 8).map((row) => `- ${row.name}: ${row.detail}`),
          blocked.length > 8 ? `- +${blocked.length - 8} more` : '',
        ].filter(Boolean).join('\n'));
        setVerifyMsg('runtime verification blocked');
        onMessage('build blocked: runtime verification failed');
        return null;
      }
      setVerifyMsg(`verified ${report.rows.length} runtime/model selection${report.rows.length === 1 ? '' : 's'}`);
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Runtime verification failed: ${message}`);
      setVerifyMsg('runtime verification failed');
      onMessage('build blocked: runtime verification failed');
      return null;
    } finally {
      setVerifying(false);
      onBusy(false);
    }
  }

  async function build() {
    if (!targetTeam) { setError('Choose or name a team.'); return; }
    if (isReservedName(targetTeam)) { setError(`“${targetTeam}” is a reserved word — choose another team name.`); return; }
    if (reserved.length) { setError(`Reserved agent name(s): ${reserved.join(', ')} — rename.`); return; }
    if (dupes.length) { setError(`Duplicate agent name(s): ${dupes.join(', ')}.`); return; }
    if (missingRuntime) { setError('Choose an available Settings runtime for every new agent.'); return; }
    if (builderRelayBlocksDefault) { setError(`The ${PRIMARY_TEAM} team needs at least one outbound relay path for ${DEFAULT_LEAD} delegation and validator bounce-backs.`); return; }
    if (defaultLeadMissingForWire) { setError(`Default-team routing is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}. Add a lead row, restore default/lead, or turn off Wire agentic routing for this build.`); return; }
    // Build only the agents that DON'T already exist in the team; the rest are shown as
    // "already in <team>" (informational), not errors. No-op if everything already exists.
    const batch = toCreate;
    if (!batch.length) {
      setError(alreadyThere.length ? `All ${alreadyThere.length} agent${alreadyThere.length === 1 ? '' : 's'} already in ${targetTeam} — use One new agent to add a single agent row.` : 'Add at least one named agent.');
      return;
    }
    const postSteps = [
      coordinate ? (targetTeam === PRIMARY_TEAM
        ? 'wire default/lead as the default primary, write the default-primary validation preset, and rebuild it'
        : "make the starred lead this team's coordinator, write the delegate-to-teammates preset, and rebuild that lead") : '',
      relayMode !== 'permissive' ? `set cross-team relay to ${describeRelay(relayPayload)}` : '',
    ].filter(Boolean);
    const preflight = await preflightBuildTarget();
    if (!preflight) return;
    const verification = await verifyBuildRuntimes(batch);
    if (!verification) return;
    const mergeIntoExisting = preflight.teamExists;
    const backboneWarning = targetTeam !== PRIMARY_TEAM && !preflight.leadershipBackbone.ready
      ? `\n\nDefault leadership return path is incomplete:\n- ${leadershipBackboneIssues(preflight.leadershipBackbone).join('\n- ')}\n\nContinue only if you intend to build this team before wiring the default primary and validators.`
      : '';
    const mergeNote = mergeIntoExisting
      ? `\n\nExisting ${targetTeam} roster stays in place (${preflight.existingAgentCount} current). Duplicate names are skipped before build${alreadyThere.length ? ` (${alreadyThere.length} already there)` : ''}.`
      : '';
    const primaryBefore = preflight.hierarchy.primary ? `${preflight.hierarchy.primary.team}/${preflight.hierarchy.primary.agent}` : 'unset';
    const primaryGuard = coordinate && targetTeam === PRIMARY_TEAM
      ? `\n\nPrimary-route guard:\n- Current primary: ${primaryBefore}\n- Requested primary: ${PRIMARY_TEAM}/${DEFAULT_LEAD}\n- The primary write still rechecks hierarchy and roster after onboarding before it applies.`
      : '';
    if (!window.confirm(`${mergeIntoExisting ? 'Build + merge' : 'Build'} ${batch.length} agent${batch.length === 1 ? '' : 's'} ${mergeIntoExisting ? `into existing ${targetTeam}` : `in ${targetTeam}`}?\n\nThis onboards and starts new agents${heartbeat ? ', adds heartbeats' : ''}${probeAfter ? ', and probes them' : ''}.${mergeNote}\n\n${verificationSummary(verification)}${postSteps.length ? `\n\nAfter build it will also ${postSteps.join('; ')}.` : ''}${primaryGuard}${backboneWarning}`)) return;
    setBuilding(true); onBusy(true); setError(''); setPost({});
    onMessage(`${mergeIntoExisting ? 'merging' : 'adding'} ${batch.length} new agent(s) ${mergeIntoExisting ? 'into' : 'to'} ${targetTeam}${alreadyThere.length ? ` (${alreadyThere.length} already there)` : ''}…`);
    // Freeze a plan per agent so a later "retry" re-runs the exact same spec.
    const plans = batch.map(planFor);
    // Results: existing agents first (skipped, no-op), then the ones we're building. Updates
    // below are keyed by NAME (not index) so the skipped rows don't shift the targets.
    setResults([
      ...alreadyThere.map((r) => ({ name: r.slug, team: targetTeam, plan: planFor(r), skipped: true, merged: mergeIntoExisting })),
      ...batch.map((r, i) => ({ name: r.slug, team: targetTeam, plan: plans[i], merged: mergeIntoExisting })),
    ]);
    let anyOk = false;
    // Sequential — the manager serializes local-model spawns anyway, and it keeps
    // the per-agent status readable as each one lands.
    for (let i = 0; i < batch.length; i++) {
      const nm = batch[i].slug;
      setResults((rs) => rs.map((x) => (x.name === nm ? { ...x, running: true } : x)));
      try {
        const res = await call<OnboardResult>('onboard:run', plans[i]);
        if (res.ok) anyOk = true;
        setResults((rs) => rs.map((x) => (x.name === nm ? { ...x, running: false, result: res } : x)));
      } catch (err) {
        setResults((rs) => rs.map((x) => (x.name === nm ? { ...x, running: false, error: err instanceof Error ? err.message : String(err) } : x)));
      }
    }
    // Auto-coordination: set the ★ lead as this team's coordinator + apply the preset. Resolve
    // the lead from the FULL roster (it may be an agent that already existed).
    const leadRow = named.find((r) => r.lead) ?? named[0];
    const leadName = targetTeam === PRIMARY_TEAM ? DEFAULT_LEAD : leadRow?.slug;
    if (anyOk && coordinate && leadName) {
      // Tell the lead to delegate to ALL its teammates in the roster (existing + newly added).
      const teammates = named.filter((r) => r.slug !== leadName).map((r) => ({ name: r.slug, role: r.role.trim() }));
      const preset = coordinatorPresetFor(targetTeam, teammates);
      setPost((p) => ({ ...p, coord: 'running', leadName }));
      try {
        const [hierNow, groupsNow] = await Promise.all([
          call<HrHierarchy>('coordinator:hierarchy').catch(() => preflight.hierarchy),
          freshHrGroups(),
        ]);
        if (hierarchyStamp(hierNow) !== preflight.hierarchyStamp) {
          throw new Error('lead hierarchy changed after build confirmation; review Manage before auto-wiring');
        }
        if (!findHrAgent(groupsNow, preflight.targetTeam, { name: leadName })) {
          throw new Error(`${preflight.targetTeam}/${leadName} is not in the current roster after build`);
        }
        await call('coordinator:set', targetTeam, leadName);
        if (targetTeam === PRIMARY_TEAM) await call('coordinator:setPrimary', targetTeam, leadName);
        await call('agent:setInstructions', leadName, preset, targetTeam);
        await call('rebuildAgent', leadName, targetTeam).catch(() => {});
        setPost((p) => ({ ...p, coord: 'ok', leadName }));
      } catch (e) { setPost((p) => ({ ...p, coord: 'failed', coordErr: e instanceof Error ? e.message : String(e) })); }
    }
    // Cross-team relay policy — only when the user changed it away from permissive.
    if (anyOk && relayMode !== 'permissive') {
      setPost((p) => ({ ...p, relay: 'running' }));
      try {
        const relayNow = await call<{ delegates_to: string[] | null }>('teamConfig', targetTeam)
          .then((r) => r.delegates_to)
          .catch(() => null);
        if (relayKey(relayNow) !== preflight.relayStamp) {
          throw new Error(`${targetTeam} relay policy changed after build confirmation; review Manage before applying builder relay`);
        }
        await call('setTeamDelegates', targetTeam, relayPayload);
        setPost((p) => ({ ...p, relay: 'ok' }));
      } catch (e) { setPost((p) => ({ ...p, relay: 'failed', relayErr: e instanceof Error ? e.message : String(e) })); }
    }
    setBuilding(false); onBusy(false);
    if (anyOk) { onMessage(`${mergeIntoExisting ? 'merged into' : 'built into'} ${targetTeam} ✓`); onDone(targetTeam); }
    else onMessage(`build failed — no agents created in ${targetTeam}`);
  }

  // Re-run one agent that failed. If it spawned but a later step failed, retry just
  // those steps (onboard:run retry mode); otherwise re-onboard the agent from scratch.
  async function runRetry(i: number, entry: ResultEntry) {
    if (entry.running) return;
    const failedKeys = (entry.result?.steps ?? []).filter((s) => s.status === 'failed').map((s) => s.key);
    const retry = entry.result?.agentId && failedKeys.length ? { agentId: entry.result.agentId, stepKeys: failedKeys } : undefined;
    setBuilding(true); onBusy(true);
    setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: true, error: undefined } : x)));
    try {
      const res = await call<OnboardResult>('onboard:run', { ...entry.plan, retry });
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, result: res, error: undefined } : x)));
      if (res.ok) onDone(targetTeam);
    } catch (err) {
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, error: err instanceof Error ? err.message : String(err) } : x)));
    } finally { setBuilding(false); onBusy(false); }
  }
  const isFailed = (e: ResultEntry) => !e.running && (Boolean(e.error) || Boolean(e.result?.steps.some((s) => s.status === 'failed')));
  async function retryFailed() {
    // Snapshot the failed entries now (their plans are stable) and retry sequentially.
    for (const { e, i } of results.map((e, i) => ({ e, i })).filter(({ e }) => isFailed(e))) await runRetry(i, e);
  }
  const failedCount = results.filter(isFailed).length;

  const postMark = (s?: PostStat) => (s === 'ok' ? '✓' : s === 'failed' ? '✗' : '…');
  const postCls = (s?: PostStat) => (s === 'ok' ? 'ok' : s === 'failed' ? 'failed' : 'running');

  return (
    <div className={inline ? 'card' : 'modal-overlay'} onMouseDown={inline ? undefined : () => (locked ? undefined : onClose())}>
      <div className={inline ? '' : 'modal onboard-modal create-team-modal'} onMouseDown={inline ? undefined : (e) => e.stopPropagation()}>
        <div className="modal-title">{inline ? 'Build a team — or merge agents into an existing one' : 'Build a team'}</div>
        <div className="create-team-layout">
          {/* LEFT: describe + batch options + coordination/relay */}
          <div>
            <div className="preflight-box" style={{ marginTop: 0, marginBottom: 12, padding: '10px 12px' }}>
              <div className="row-actions" style={{ alignItems: 'center', gap: 8 }}>
                <b className="small">Preloaded teams</b>
                <span className="grow" />
                <span className={`small ${leadershipBackbone.ready ? 'ok-text' : 'warn-text'}`}>
                  default leadership: {leadershipBackbone.ready ? 'ready' : 'incomplete'}
                </span>
              </div>
              <div className="chips" style={{ marginTop: 8 }}>
                {blueprintCoverages.map((bp) => (
                  <button key={bp.id} className={`chip${bp.complete ? ' tag' : ''}`} disabled={locked} title={bp.complete ? `${bp.label} is already present` : `Missing: ${bp.missing.join(', ') || 'unknown'}`} onClick={() => applyStartSource(`bp:${bp.id}`)}>
                    {bp.complete ? '✓ ' : '＋ '}{bp.label} {bp.present}/{bp.total}
                  </button>
                ))}
              </div>
              {!leadershipBackbone.ready ? (
                <div className="warn-text small" style={{ marginTop: 6 }}>
                  Missing return-path pieces: {leadershipIssues.join(', ')}
                </div>
              ) : (
                <div className="muted small" style={{ marginTop: 6 }}>
                  primary {leadershipBackbone.primaryLabel} · coordinator {leadershipBackbone.coordinatorLabel}
                </div>
              )}
            </div>
            <div className="row-actions" style={{ gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <span className="muted small">start from</span>
              <select className="cell-select" disabled={locked} value="" onChange={(e) => {
                const v = e.target.value; e.currentTarget.value = '';
                applyStartSource(v);
              }}>
                <option value="">blank — describe below</option>
                <optgroup label="Recommended blueprints">
                  {RECOMMENDED_TEAM_BLUEPRINTS.map((bp) => <option key={`bp:${bp.id}`} value={`bp:${bp.id}`}>{bp.label} — {bp.description}</option>)}
                </optgroup>
                {templates.length ? <optgroup label="Manager templates">{templates.map((t) => <option key={`tpl:${t.name}`} value={`tpl:${t.name}`}>{t.name} — {describeTemplate(t)}</option>)}</optgroup> : null}
                {configs.length ? <optgroup label="Saved configs">{configs.map((c) => <option key={`cfg:${c.name}`} value={`cfg:${c.name}`}>{c.name} — {describeConfig(c)}</option>)}</optgroup> : null}
              </select>
            </div>
            <div className="muted small" style={{ marginBottom: 6 }}>describe the team you want — or paste a spec</div>
            <textarea
              autoFocus
              style={{ width: '100%', minHeight: 150, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
              placeholder={'e.g. A team to build and maintain our Next.js app — a lead coordinator, a coder for implementation, and a researcher for docs & investigation.'}
              value={spec}
              disabled={locked}
              onChange={(e) => { setSpec(e.target.value); setError(''); }}
            />
            <div className="row-actions" style={{ marginTop: 6, justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                <button className="btn small" disabled={!spec.trim() || locked} onClick={() => void aiDesign()}>
                  {aiBusy ? `Designing… ${aiElapsed}s` : '✦ Build with AI'}
                </button>
                {aiBusy ? <button className="btn small" style={{ marginLeft: 6 }} onClick={stopAi}>Stop</button> : null}
              </span>
              <span className="muted small">{named.length} agent{named.length === 1 ? '' : 's'}</span>
            </div>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>applied to every agent</div>
            <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'center' }}>
              <span>MCP</span>
              <span>
                <select className="cell-select" disabled={locked || !availableMcpChoices.length} value="" onChange={(e) => {
                  addMcp(e.target.value);
                  e.currentTarget.value = '';
                }} style={{ maxWidth: 260 }}>
                  <option value="">{availableMcpChoices.length ? 'add MCP server…' : 'all attachable MCP selected'}</option>
                  {availableMcpChoices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
                <span className="chips" style={{ marginLeft: 8 }}>
                  {mcpIds.length ? mcpIds.map((id) => {
                    const entry = mcpChoices.find((item) => item.id === id);
                    return (
                      <button key={id} className="chip on" disabled={locked} title="Remove MCP server" onClick={() => setMcpIds((ids) => ids.filter((x) => x !== id))}>
                        ✓ {entry?.name ?? id} ×
                      </button>
                    );
                  }) : <span className="muted small">none</span>}
                </span>
              </span>
              <span>skills</span>
              <span>
                <select className="cell-select" disabled={locked || !availableSharedSkills.length} value="" onChange={(e) => {
                  addSharedSkill(e.target.value);
                  e.currentTarget.value = '';
                }} style={{ maxWidth: 260 }}>
                  <option value="">{availableSharedSkills.length ? 'add shared skill…' : skillCatalog.length ? 'all skills selected' : 'no library skills'}</option>
                  {availableSharedSkills.map((skill) => <option key={skill} value={skill}>{skill}</option>)}
                </select>
                <span className="chips" style={{ marginLeft: 8 }}>
                  {sharedSkills.length ? sharedSkills.map((skill) => (
                    <button key={skill} className="chip on" disabled={locked} title="Remove shared skill" onClick={() => setSharedSkills((skills) => skills.filter((x) => x !== skill))}>
                      ✓ {skill} ×
                    </button>
                  )) : <span className="muted small">none</span>}
                </span>
              </span>
              <span>heartbeat</span>
              <span>
                <input type="checkbox" checked={heartbeat} disabled={locked} onChange={(e) => setHeartbeat(e.target.checked)} />{' '}
                <select className="cell-select" disabled={locked || !heartbeat} value={hbInterval} onChange={(e) => setHbInterval(Number(e.target.value))}>
                  {HB_INTERVALS.map((iv) => <option key={iv.s} value={iv.s}>{iv.label}</option>)}
                </select>
              </span>
              <span />
              <span className="muted small">
                <label><input type="checkbox" checked={wallet} disabled={locked} onChange={(e) => setWallet(e.target.checked)} /> OWS wallet</label>
                <label style={{ marginLeft: 14 }}><input type="checkbox" checked={probeAfter} disabled={locked} onChange={(e) => setProbeAfter(e.target.checked)} /> probe after</label>
              </span>
            </div>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>coordination &amp; routing</div>
            <label className="muted small" style={{ display: 'block' }}>
              <input type="checkbox" checked={coordinate} disabled={locked} onChange={(e) => toggleCoordinate(e.target.checked)} />{' '}
              Wire agentic routing — {targetTeam === PRIMARY_TEAM ? `make ${PRIMARY_TEAM}/${DEFAULT_LEAD} the default primary` : "make the ★ lead this team's coordinator"} and apply the {targetTeam === PRIMARY_TEAM ? 'default-primary validation preset' : 'delegate-to-teammates preset'}
            </label>
            <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
              Off by default. Turn this on only after reviewing the lead/roster. With it on, new work is handed to the <b>lead</b>, which checks what's already done, decomposes only the
              <b> remaining</b> work, and delegates to its teammates (and other teams via the relay below) — rather than every
              agent acting on its own.
            </p>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>cross-team relay for <span className="mono">{targetTeam || '…'}</span></div>
            <div className="relay-modes">
              {([
                ['permissive', 'Any team'],
                ['all', 'All (*)'],
                ['select', 'Selected'],
                ['none', 'None'],
              ] as [RelayMode, string][]).map(([m, label]) => (
                <label key={m} className={`relay-mode${relayMode === m ? ' active' : ''}`} title={targetTeam === PRIMARY_TEAM && m === 'none' ? 'Default leadership needs at least one relay path' : undefined}>
                  <input type="radio" name="builder-relay" checked={relayMode === m} disabled={locked || (targetTeam === PRIMARY_TEAM && m === 'none')} onChange={() => setRelayMode(m)} /> {label}
                </label>
              ))}
            </div>
            {builderRelayBlocksDefault ? (
              <p className="warn-text small" style={{ marginTop: 6 }}>
                Default leadership needs at least one outbound relay path; choose Any, All, or Selected with at least one team.
              </p>
            ) : null}
            {relayMode === 'select' ? (
              <div className="chips" style={{ marginTop: 8 }}>
                {relayTargets.length === 0 ? <span className="muted small">No other teams.</span> :
                  relayTargets.map((n) => {
                    const on = relaySel.includes(n);
                    return (
                      <button key={n} className={`chip${on ? ' on' : ''}`} disabled={locked} onClick={() => setRelaySel((s) => s.includes(n) ? s.filter((x) => x !== n) : [...s, n])}>
                        {on ? '✓ ' : ''}{n}
                      </button>
                    );
                  })}
              </div>
            ) : null}
          </div>

          {/* RIGHT: target team + editable roster */}
          <div>
            <div className="kv" style={{ gridTemplateColumns: '70px 1fr', gap: '8px 10px', alignItems: 'center' }}>
              <span>team</span>
              <span>
                <select className="cell-select" disabled={locked} value={teamSel} onChange={(e) => pickTeam(e.target.value)}>
                  {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  <option value="__new__">＋ new team…</option>
                </select>
                {usingNewTeam ? (
                  <input
                    style={{ marginLeft: 8, width: 180 }}
                    placeholder="new team name"
                    value={newTeam}
                    disabled={locked}
                    onChange={(e) => { setTeamTouched(true); setNewTeam(e.target.value); }}
                    onBlur={() => setNewTeam(canonicalTeamName(newTeam))}
                  />
                ) : null}
              </span>
            </div>
            {usingNewTeam && newTeam && targetTeam !== newTeam ? <p className="muted small">Will create as <span className="mono">{targetTeam}</span>.</p> : null}
            {usingNewTeam && isReservedName(targetTeam) ? <p className="status-error small"><span className="mono">{targetTeam}</span> is a reserved word — choose another team name.</p> : null}
            {usingNewTeam && teamExists ? <p className="warn-text small">Team <span className="mono">{targetTeam}</span> exists — Build + merge will add only new agent rows and leave existing names as-is.</p> : null}
            {!usingNewTeam && teamExists ? <p className="muted small">Build + merge adds these reviewed agent rows directly into <span className="mono">{targetTeam}</span>; no separate Team maintenance merge is needed.</p> : null}
            {targetNeedsBackbone ? <p className="warn-text small">Default return path incomplete — build will ask before adding <span className="mono">{targetTeam}</span>.</p> : null}
            {defaultLeadMissingForWire ? <p className="warn-text small">Default-team routing is locked to <span className="mono">{PRIMARY_TEAM}/{DEFAULT_LEAD}</span>; add/restore that agent or turn off Wire agentic routing.</p> : null}

            <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 6px' }}>
              <span className="muted small">roster — {targetTeam === PRIMARY_TEAM ? `${PRIMARY_TEAM}/${DEFAULT_LEAD} is the fixed primary; ` : '★ marks the lead; '}▸ for persona &amp; skills</span>
              <span className="row-actions">
                {teamExists ? (
                  <button className="btn small" disabled={locked} title={`Clear this review batch to one blank agent row for ${targetTeam}`} onClick={startSingleAgentAdd}>
                    ＋ one new agent
                  </button>
                ) : null}
                <button className="btn small" disabled={locked} onClick={addRow}>＋ add row</button>
              </span>
            </div>
            {teamExists && named.length > 0 && toCreate.length === 0 ? (
              <p className="muted small" style={{ marginTop: -2 }}>
                This review batch only contains agents already in <span className="mono">{targetTeam}</span>. Choose <b>One new agent</b> to add a single blank row.
              </p>
            ) : null}
            <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((r, i) => {
                const rowSlug = slugName(r.name);
                const rowReserved = isReservedName(rowSlug);
                const rowExists = !!rowSlug && existingInTeam.has(rowSlug);
                const leadLocked = targetTeam === PRIMARY_TEAM && rowSlug !== DEFAULT_LEAD;
                const rowIsEffectiveLead = targetTeam === PRIMARY_TEAM ? rowSlug === DEFAULT_LEAD : r.lead;
                return (
                  <div key={i} style={{ border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '6px 6px 8px' }}>
                    <div className="kv" style={{ gridTemplateColumns: '26px 1.2fr 1fr 1fr 24px 24px', gap: 6, alignItems: 'center' }}>
                      <button className={`chip${rowIsEffectiveLead ? ' on' : ''}`} title={leadLocked ? `${PRIMARY_TEAM} primary is locked to ${PRIMARY_TEAM}/${DEFAULT_LEAD}` : rowIsEffectiveLead ? 'lead' : 'make lead'} disabled={locked || leadLocked} onClick={() => setLead(i)} style={{ padding: '2px 6px' }}>★</button>
                      <input
                        className="mono"
                        style={{ fontSize: 12, ...(rowReserved ? { borderColor: 'var(--danger, #e5484d)' } : {}) }}
                        placeholder="name"
                        value={r.name}
                        disabled={locked}
                        title={rowReserved ? 'reserved word — rename' : undefined}
                        onChange={(e) => updateRow(i, { name: e.target.value })}
                        onBlur={(e) => updateRow(i, { name: slugName(e.target.value) })}
                      />
                      <select
                        className="cell-select"
                        style={{ fontSize: 12 }}
                        disabled={locked || !runtimes.length}
                        value={r.runtime}
                        title="Settings-available subscription CLIs, local model runtimes, and synced API provider lanes are selectable for new agents."
                        onChange={(e) => updateRow(i, { runtime: e.target.value, model: '' })}
                      >
                        <option value="" disabled>{runtimes.length ? 'Choose runtime' : 'No Settings runtime available'}</option>
                        {subscriptionRuntimes.length ? (
                          <optgroup label="Subscription CLI runtimes">
                            {subscriptionRuntimes.map((rt) => <option key={rt} value={rt}>{runtimeLabel(rt)}</option>)}
                          </optgroup>
                        ) : null}
                        {localRuntimes.length ? (
                          <optgroup label="Local model runtimes">
                            {localRuntimes.map((rt) => <option key={rt} value={rt}>{runtimeLabel(rt)}</option>)}
                          </optgroup>
                        ) : null}
                        {apiProviderLanes.length ? (
                          <optgroup label="API provider lanes">
                            {apiProviderLanes.map((lane) => <option key={lane.id} value={lane.id}>{providerLaneBuildLabel(lane)}</option>)}
                          </optgroup>
                        ) : null}
                      </select>
                      <select className="cell-select" style={{ fontSize: 12 }} disabled={locked} value={r.model} onChange={(e) => updateRow(i, { model: e.target.value })}>
                        <option value="">(default model)</option>
                        {(modelCatalog[r.runtime] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <button className="uv-x" title={r.open ? 'collapse' : 'persona & skills'} disabled={locked} onClick={() => updateRow(i, { open: !r.open })}>{r.open ? '▾' : '▸'}</button>
                      <button className="uv-x" title="Remove" disabled={locked || rows.length <= 1} onClick={() => removeRow(i)}>✕</button>
                    </div>
                    <input style={{ fontSize: 12, width: '100%', marginTop: 4 }} placeholder="role (one line)" value={r.role} disabled={locked} maxLength={200} onChange={(e) => updateRow(i, { role: e.target.value })} />
                    {rowExists ? <div className="muted small" style={{ marginTop: 3 }} title={`An agent named ${slugName(r.name)} already exists in ${targetTeam} — it will be left as-is on build.`}>● already in {targetTeam} — will be left as-is</div> : null}
                    {r.open ? (
                      <>
                        <textarea
                          style={{ width: '100%', marginTop: 4, fontSize: 11, minHeight: 46, fontFamily: 'inherit', resize: 'vertical' }}
                          placeholder="description / persona — becomes this agent’s operating instructions"
                          value={r.description}
                          disabled={locked}
                          maxLength={2000}
                          onChange={(e) => updateRow(i, { description: e.target.value })}
                        />
                        <div className="chips" style={{ marginTop: 4 }}>
                          {skillCatalog.length === 0 ? <span className="muted small">no library skills</span> :
                            skillCatalog.map((s) => (
                              <button key={s} className={`chip${r.skills.includes(s) ? ' on' : ''}`} disabled={locked} onClick={() => toggleRowSkill(i, s)}>
                                {r.skills.includes(s) ? '✓ ' : ''}{s}
                              </button>
                            ))}
                        </div>
                      </>
                    ) : (r.skills.length || r.description.trim()) ? (
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {r.skills.length ? `skills: ${r.skills.join(', ')}` : ''}
                        {r.skills.length && r.description.trim() ? ' · ' : ''}
                        {r.description.trim() ? 'persona set' : ''}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {aiSuggestions && (aiSuggestions.agents.length || aiSuggestions.skills.length) ? (
              <div style={{ marginTop: 10, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '8px 10px' }}>
                <div className="b small">HR suggestions for the collective</div>
                <div className="muted small" style={{ marginTop: 2 }}>Advisory only — add an agent row or create a skill separately before anything changes.</div>
                {aiSuggestions.agents.length ? (
                  <div className="small" style={{ marginTop: 6 }}>
                    <span className="muted">agents: </span>{aiSuggestions.agents.join(' · ')}
                  </div>
                ) : null}
                {aiSuggestions.skills.length ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    <span className="muted">skills: </span>{aiSuggestions.skills.join(' · ')}
                  </div>
                ) : null}
              </div>
            ) : null}
            {reserved.length ? <p className="status-error small">Reserved name(s): <span className="mono">{reserved.join(', ')}</span> — rename.</p> : null}
            {dupes.length ? <p className="status-error small">Duplicate name(s): <span className="mono">{dupes.join(', ')}</span>.</p> : null}
            {verifyMsg ? <p className={`small ${/blocked|failed/.test(verifyMsg) ? 'status-error' : 'ok-text'}`}>runtime verification: {verifyMsg}</p> : null}
            {error ? <p className="status-error small">{error}</p> : null}
          </div>
        </div>

        {results.length ? (
          <div className="onboard-checklist" style={{ marginTop: 12 }}>
            {results.map((r, i) => {
              const failed = !r.skipped && (Boolean(r.error) || Boolean(r.result?.steps.some((s) => s.status === 'failed')));
              const mark = r.skipped ? '•' : r.running ? '…' : r.error ? '✗' : r.result?.ok ? '✓' : failed ? '!' : '·';
              const detail = r.skipped ? `already in ${r.team} — left as-is`
                : r.error ? r.error
                : r.result ? (r.result.ok ? `${r.merged ? 'merged into' : 'built into'} ${r.team}` : (r.result.steps.filter((s) => s.status === 'failed').map((s) => `${s.label}: ${s.error || 'failed'}`).join('; ') || 'finished with issues'))
                : (r.running ? 'building…' : 'queued');
              const cls = r.skipped ? 'pending' : failed ? 'failed' : r.result?.ok ? 'ok' : r.running ? 'running' : 'pending';
              return (
                <div key={r.name} className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr) auto' }}>
                  <span className={`step-dot ${cls}`}>{mark}</span>
                  <span className="step-label mono">{r.name}</span>
                  <span className={`small ${failed ? 'status-error' : 'muted'}`}>{detail}</span>
                  {failed ? (
                    <button className="btn small" disabled={building} title="Retry this agent" onClick={() => void runRetry(i, r)}>↻ retry</button>
                  ) : <span />}
                </div>
              );
            })}
            {post.coord ? (
              <div className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr)' }}>
                <span className={`step-dot ${postCls(post.coord)}`}>{postMark(post.coord)}</span>
                <span className="step-label mono">coordinator</span>
                <span className={`small ${post.coord === 'failed' ? 'status-error' : 'muted'}`}>{post.coord === 'failed' ? post.coordErr : targetTeam === PRIMARY_TEAM ? `${post.leadName ?? 'lead'} → default primary + preset` : `${post.leadName ?? 'lead'} → team coordinator + preset`}</span>
              </div>
            ) : null}
            {post.relay ? (
              <div className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr)' }}>
                <span className={`step-dot ${postCls(post.relay)}`}>{postMark(post.relay)}</span>
                <span className="step-label mono">relay</span>
                <span className={`small ${post.relay === 'failed' ? 'status-error' : 'muted'}`}>{post.relay === 'failed' ? post.relayErr : describeRelay(relayPayload)}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={building} onClick={onClose}>Close</button>
          {failedCount > 0 ? (
            <button className="btn" disabled={building} onClick={() => void retryFailed()}>↻ Retry failed ({failedCount})</button>
          ) : null}
          <button className="btn primary" disabled={!canBuild} onClick={() => void build()}>
            {building ? 'Building…'
              : toCreate.length === 0 && named.length > 0 ? `All ${named.length} already in ${targetTeam || '…'}`
              : teamExists ? `Build + merge ${toCreate.length} agent${toCreate.length === 1 ? '' : 's'} into ${targetTeam || '…'}${alreadyThere.length ? ` (${alreadyThere.length} already there)` : ''}`
              : `Build ${targetTeam || 'team'} + ${toCreate.length} agent${toCreate.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function cleanTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function canonicalTeamName(name: string): string {
  const cleaned = cleanTeamName(name);
  return STANDARD_TEAM_ALIASES[cleaned] ?? cleaned;
}

function countAgents(agents?: number | unknown[]): number | undefined {
  return typeof agents === 'number' ? agents : Array.isArray(agents) ? agents.length : undefined;
}

function describeTemplate(template: TeamTemplate): string {
  const count = countAgents(template.agents);
  return template.description ?? `library template${count != null ? ` · ${count} agents` : ''}`;
}

function describeConfig(config: ConfigEntry): string {
  const count = countAgents(config.agents);
  return `${config.description ?? 'server config'}${count != null ? ` · ${count} agents` : ''}`;
}

function summarizeFleetRoster(agents: HrAgentCandidate[], activeTeams: string[]): string {
  const active = new Set(activeTeams);
  const byTeam: Record<string, HrAgentCandidate[]> = {};
  for (const a of agents) (byTeam[a.team ?? 'default'] ??= []).push(a);
  return Object.entries(byTeam)
    .sort(([a], [b]) => Number(active.has(b)) - Number(active.has(a)) || a.localeCompare(b))
    .map(([team, teamAgents]) => {
      const label = active.has(team) ? 'active' : 'inactive';
      const names = teamAgents
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => `${a.name}${isRunnableAgent(a) ? '' : ` (${a.status || 'stopped'})`}`)
        .join(', ');
      return `${team} [${label}]: ${names || '(no agents)'}`;
    })
    .join('\n')
    .slice(0, 6000);
}

function mcpFromChoices(ids: string[]): McpServerSpec[] | undefined {
  const servers = Array.from(new Set(ids)).flatMap((id) => {
    const entry = MCP_CATALOG.find((item) => item.id === id);
    if (!entry || entry.inputs?.some((input) => input.required && !input.default)) return [];
    const profile = buildFromCatalog(entry, entry.id, {});
    const { enabled: _enabled, ...server } = profile;
    return [server];
  });
  return servers.length ? servers : undefined;
}
