// SPDX-License-Identifier: MIT
/**
 * Reactive "Org Sync" — keeps every agent's goals & instructions file in sync with
 * its place in the lead hierarchy AND with the brain's live team-instruction memories.
 *
 * Hierarchy & relay policy (top → bottom):
 *   primary lead  →  team leads  →  team members (who execute)
 *   …then completed work flows UP through the default-team VALIDATORS (researcher, coder),
 *   who validate + combine it and relay consolidated findings to the primary lead.
 * The primary lead delegates DOWN only to the team leads — never to its own default-team
 * coder/researcher, which are the validation pair on the RETURN path, not delegation targets.
 *
 * Each agent's `.id-instructions.md` sidecar gets a marker-fenced "org block" composed
 * from the hierarchy: it tells the agent who it delegates DOWN to and who it relays UP to,
 * and embeds the current brain team-instructions for its team. The block is upserted between
 * markers so any manual instructions the user added are preserved. The sidecar takes effect
 * on the agent's next rebuild — see the "smart" rebuild policy in syncOrg().
 */
import type { ManagerClient } from '../../../idctl/src/api/client.ts';
import type { Agent, Task } from '../../../idctl/src/api/types.ts';
import { slugName } from '../../../idctl/src/api/teamSpec.ts';
import { loadSettings, type SecondaryLead } from '../../../idctl/src/settings/store.ts';
import { brain } from '../../../idctl/src/api/brain.ts';
import { isActiveStatus } from './work.ts';

const ORG_BEGIN = '<!-- BEGIN id-agents org -->';
const ORG_END = '<!-- END id-agents org -->';
const PRIMARY_TEAM = 'default';
const DEFAULT_PRIMARY_AGENT = 'lead';
const DEFAULT_VALIDATORS = ['coder', 'researcher'];
// Cap rebuilds per pass so a fleet-wide instruction change doesn't restart everyone at once
// (writes are cheap and unbounded; only the disruptive rebuilds are throttled).
const MAX_REBUILDS_PER_PASS = 3;

export interface OrgHierarchy {
  primary: { team: string; agent: string } | null;
  secondaries: SecondaryLead[];
  coordinators: Record<string, string>; // team → team-lead agent name
  teams: string[];
}

export interface OrgSyncResult {
  hierarchy: OrgHierarchy;
  agents: number;
  written: number;     // sidecars whose org block changed and were rewritten
  rebuilt: string[];   // agents rebuilt this pass (idle + changed, rate-limited)
  brain: boolean;      // org structure written back to the brain
  skippedBusy: number; // changed sidecars whose agent was mid-task (rebuild deferred)
}

export interface OrgSyncPreviewAgent {
  team: string;
  agent: string;
  status?: string;
  changed: boolean;
  rebuild: boolean;
  reason?: string;
}

export interface OrgSyncPreview {
  hierarchy: OrgHierarchy;
  agents: number;
  changed: number;
  rebuilt: string[];
  brain: boolean;
  skippedBusy: number;
  autoRebuild: boolean;
  rebuildLimit: number;
  changedAgents: OrgSyncPreviewAgent[];
}

interface OrgSyncCandidate extends OrgSyncPreviewAgent {
  current: string;
  next: string;
}

interface OrgSyncPlan {
  hierarchy: OrgHierarchy;
  agents: number;
  candidates: OrgSyncCandidate[];
  rebuilt: string[];
  skippedBusy: number;
  autoRebuild: boolean;
}

function secondaryDomainTeams(teams: string[]): { research: string[]; coder: string[] } {
  const others = teams.filter((t) => t !== 'default' && t !== 'public').sort((a, b) => a.localeCompare(b));
  const research = others.filter((t) => /research|security|intel|analy|audit/i.test(t));
  const coder = others.filter((t) => !research.includes(t));
  return { research, coder };
}

/** Default secondary leads when none are configured: researcher + coder on `default`,
 *  splitting the other teams by domain (research/security → researcher, the rest → coder). */
function defaultSecondaries(teams: string[]): SecondaryLead[] {
  const { research, coder } = secondaryDomainTeams(teams);
  return [
    { agent: 'researcher', team: 'default', leadsTeams: research },
    { agent: 'coder', team: 'default', leadsTeams: coder },
  ];
}

function mergeConfiguredSecondaries(configured: SecondaryLead[], teams: string[]): SecondaryLead[] {
  const configuredCopy = configured.map((s) => ({
    ...s,
    agent: slugName(s.agent),
    team: PRIMARY_TEAM,
    leadsTeams: Array.from(new Set((s.leadsTeams ?? []).filter((t) => t && t !== PRIMARY_TEAM && t !== 'public'))).sort((a, b) => a.localeCompare(b)),
  })).filter((s) => s.agent && s.agent !== DEFAULT_PRIMARY_AGENT);
  for (const agent of DEFAULT_VALIDATORS) {
    if (!configuredCopy.some((s) => s.agent === agent)) configuredCopy.push({ agent, team: PRIMARY_TEAM, leadsTeams: [] });
  }
  const covered = new Set(configuredCopy.flatMap((s) => s.leadsTeams));
  const uncovered = teams.filter((t) => t !== 'default' && t !== 'public' && !covered.has(t));
  const sortSecondaries = (rows: SecondaryLead[]) => rows.sort((a, b) => {
    const ai = DEFAULT_VALIDATORS.indexOf(a.agent);
    const bi = DEFAULT_VALIDATORS.indexOf(b.agent);
    return (ai === -1 ? DEFAULT_VALIDATORS.length : ai) - (bi === -1 ? DEFAULT_VALIDATORS.length : bi) || a.agent.localeCompare(b.agent);
  });
  if (!uncovered.length) return sortSecondaries(configuredCopy);

  const { research, coder } = secondaryDomainTeams(uncovered);
  const ensureSecondary = (agent: string): SecondaryLead => {
    let sec = configuredCopy.find((s) => s.agent === agent);
    if (!sec) {
      sec = { agent, team: 'default', leadsTeams: [] };
      configuredCopy.push(sec);
    }
    return sec;
  };
  const addTeams = (agent: string, names: string[]) => {
    if (!names.length) return;
    const sec = ensureSecondary(agent);
    sec.leadsTeams = Array.from(new Set([...(sec.leadsTeams ?? []), ...names])).sort((a, b) => a.localeCompare(b));
  };

  addTeams('researcher', research);
  addTeams('coder', coder);
  return sortSecondaries(configuredCopy);
}

export function activeCoordinators(configured: Record<string, string>, teams: string[]): Record<string, string> {
  const activeTeams = new Set(teams.filter((team) => team && team !== 'public'));
  return Object.fromEntries(
    Object.entries(configured).filter(([team, agent]) => activeTeams.has(team) && Boolean(agent)),
  );
}

export async function buildOrgHierarchy(client: ManagerClient): Promise<OrgHierarchy> {
  const cfg = loadSettings();
  const teams = (await client.teams().catch(() => [])).map((t) => t.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const coordinators = { ...activeCoordinators(cfg.coordinators ?? {}, teams), [PRIMARY_TEAM]: DEFAULT_PRIMARY_AGENT };
  const primary = { team: PRIMARY_TEAM, agent: DEFAULT_PRIMARY_AGENT };
  const secondaries = cfg.secondaryLeads?.length ? mergeConfiguredSecondaries(cfg.secondaryLeads, teams) : defaultSecondaries(teams);
  return { primary, secondaries, coordinators, teams };
}

type RoleInfo =
  | { role: 'primary' }
  | { role: 'secondary'; sec: SecondaryLead }
  | { role: 'teamlead'; team: string; secondary?: SecondaryLead }
  | { role: 'worker'; team: string; lead?: string };

function classify(agentName: string, team: string, hier: OrgHierarchy): RoleInfo {
  if (hier.primary && team === hier.primary.team && agentName === hier.primary.agent) return { role: 'primary' };
  const sec = hier.secondaries.find((s) => s.team === team && s.agent === agentName);
  if (sec) return { role: 'secondary', sec };
  if (hier.coordinators[team] === agentName) {
    return { role: 'teamlead', team, secondary: hier.secondaries.find((s) => s.leadsTeams.includes(team)) };
  }
  return { role: 'worker', team, lead: hier.coordinators[team] };
}

/** Compose the marker-fenced org block for one agent. Deterministic (no timestamps) so the
 *  change-detection in syncOrg() is stable. */
function composeOrgBlock(
  agentName: string,
  team: string,
  hier: OrgHierarchy,
  rosters: Record<string, string[]>,
  brainLines: string[],
): string {
  const info = classify(agentName, team, hier);
  const primaryName = hier.primary?.agent ?? '(primary lead — unset)';
  const out: string[] = ['## Your place in the org'];

  // Default-team validators: completed work flows UP to them; they validate + combine it and relay
  // findings to the primary lead. They are NOT downward delegators.
  const validatorTargets = hier.secondaries.map((s) => `${s.team}/${s.agent}`);
  const validatorTargetList = validatorTargets.map((v) => `**${v}**`).join(' and ') || '**default/coder** and **default/researcher**';
  const primaryTarget = hier.primary ? `${hier.primary.team}/${hier.primary.agent}` : primaryName;
  const validatorFocus = (name: string): string =>
    name === 'researcher'
      ? 'evidence quality, reasoning, sourcing, policy fit, and completeness'
      : name === 'coder'
        ? 'implementation, technical, operational, and code-quality concerns'
        : 'your specialist domain';
  // The other teams' leads the primary delegates to directly (every team except the primary's own).
  const teamLeads = Object.entries(hier.coordinators)
    .filter(([t, a]) => !!a && t !== hier.primary?.team && t !== 'public')
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (info.role === 'primary') {
    out.push('You are the **PRIMARY LEAD** of the whole fleet.');
    const leadList = teamLeads.map(([t, a]) => `**${a}** (${t})`).join(', ');
    out.push(`You delegate DOWN **only to the other team leads**: ${leadList || '— none yet —'}. Hand each a scoped objective with \`/ask <team>/<lead> "<objective>"\`; their team members execute the work.`);
    out.push(`Your own default-team ${validatorTargetList} are your **validators — NOT delegation targets**. Never hand them work to execute. When the team leads complete work, the completed tasks are relayed to ${validatorTargetList}; they validate it, combine the inputs into one consolidated result, and relay their findings back up to you. Expect consolidated, validated findings from them — not raw per-team chatter.`);
  } else if (info.role === 'secondary') {
    const partner = hier.secondaries.filter((s) => s.agent !== agentName).map((s) => `**${s.agent}**`);
    out.push(`You are a **DEFAULT-TEAM VALIDATOR**${partner.length ? ` (validating alongside ${partner.join(', ')})` : ''}, reporting up to the primary lead **${primaryName}**.`);
    out.push(`You do **NOT** delegate work down the chain — the primary lead hands objectives directly to the team leads, and their members execute. When work is completed, the completed tasks are relayed to you.`);
    out.push(`Your job: **validate** the completed work — focus on ${validatorFocus(agentName)} — then **combine** the inputs from across the teams into one consolidated result and **relay your findings UP** with \`/ask ${primaryTarget} "<validated, consolidated findings>"\`. If the work is unsatisfactory, return it to the applicable team lead with concrete, actionable feedback for another delegation/refinement cycle until it passes or a blocker must be escalated.`);
  } else if (info.role === 'teamlead') {
    out.push(`You are the **LEAD of the ${team} team**.`);
    const mates = (rosters[team] ?? []).filter((n) => n !== agentName);
    out.push(`You receive scoped objectives **directly from the primary lead ${primaryName}**.${mates.length ? ` Break each into tasks for your teammates: ${mates.map((m) => `**${m}**`).join(', ')}; assign and track to completion.` : ''}`);
    out.push(`When the work is complete, relay the completed tasks to the default-team validators — ${validatorTargets.map((v) => `\`/ask ${v} "<completed work + summary>"\``).join(' and ') || validatorTargetList} — who validate and consolidate it before it reaches the primary lead. Surface blockers up the same path; never dump unreviewed work straight to the primary.`);
  } else {
    out.push(`You are a **member of the ${team} team**.`);
    if (info.lead) out.push(`Your team lead is **${info.lead}**. Do your assigned tasks, mark them done when finished, and surface blockers or questions with \`/ask ${info.lead} "..."\` — your lead relays them up the chain.`);
    else out.push('Do your assigned tasks and mark them done when finished.');
  }

  // PARALLEL-delegation guard (concurrency): every coordinator must fan INDEPENDENT work out at
  // once — synchronous /talk-to to multiple teammates serializes them so 2+ subscription agents
  // can never run at the same time through a lead. See Teams.tsx COORDINATION_TAIL (do not revert).
  if (info.role === 'primary' || info.role === 'secondary' || info.role === 'teamlead') {
    out.push(
      'When you delegate INDEPENDENT work to more than one teammate/lead, **fan it out IN PARALLEL** — ' +
      'fire async `/news-to <agent> "<task>" (trigger:true)` to each at once so they run concurrently on ' +
      'their own processes, then collect via `/news` (bounded; re-send once or report blocked if one goes ' +
      "quiet). Use synchronous `/talk-to` ONLY for a step that needs another's output first, or a single " +
      'quick hand-off. Never run independent delegations one-at-a-time.',
    );
  }

  if (brainLines.length) {
    out.push('', '## Current team instructions (synced from the brain)');
    for (const b of brainLines) out.push(`- ${b}`);
  }
  return `${ORG_BEGIN}\n${out.join('\n')}\n${ORG_END}`;
}

/** Pull the brain's current team-instruction memories for a team (best-effort, short timeout). */
async function brainInstructions(team: string): Promise<string[]> {
  const memories = await brain.sharedMemory({ tag: 'team-instruction', project: team, limit: 8 });
  return memories
    .filter((m) => m.agent_id === 'team-instructions' && m.content && m.mem_key !== 'org:hierarchy')
    .map((m) => `${String(m.content).trim()}${m.id ? ` [memory:${m.id}]` : ''}`);
}

function renderOrgSummary(hier: OrgHierarchy): string {
  const primaryName = hier.primary?.agent ?? '(unset)';
  const validatorTargets = hier.secondaries.map((s) => `${s.team}/${s.agent}`);
  const teamLeads = Object.entries(hier.coordinators)
    .filter(([t, a]) => !!a && t !== hier.primary?.team && t !== 'public')
    .sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [
    'Fleet leadership & relay policy (org chart):',
    `- Primary lead: ${primaryName} (${hier.primary?.team ?? '?'}) — delegates ONLY to the team leads below; never hands execution work to its own default-team ${validatorTargets.join(', ') || 'validators'}. Receives consolidated, validated findings from the validators.`,
    `- Default-team validators: ${validatorTargets.join(', ') || '—'} — receive every completed task from the team leads, validate + combine it, and relay findings up to ${primaryName} (coder: implementation/technical/operational/code-quality; researcher: evidence/reasoning/sourcing/policy/completeness; additional validators: specialist domain review).`,
    `- Team leads (delegated to directly by ${primaryName}; execute via their own members; relay completed work to ${validatorTargets.join(' & ') || 'the validators'}):`,
  ];
  for (const [t, a] of teamLeads) lines.push(`    - ${t}: ${a}`);
  return lines.join('\n');
}

/** Write the hierarchy back to the brain as a keyed shared memory so the brain holds the
 *  org structure as a source of truth (and the manager can inject it per-dispatch). Uses the
 *  shared BrainClient: visibility='public' (shared:true) so GET /memory/shared returns it;
 *  mem_key upserts by (agent_id, key) so no duplicates. */
async function writeOrgToBrain(client: ManagerClient, hier: OrgHierarchy): Promise<boolean> {
  return client.controlMemory('team-instructions', {
    content: renderOrgSummary(hier),
    key: 'org:hierarchy',
    tags: ['team-instruction', 'org-structure'],
    shared: true,
  });
}

/** Upsert the org block into the sidecar text, preserving anything outside the markers. */
function upsertOrgBlock(existing: string, block: string): string {
  const b = existing.indexOf(ORG_BEGIN);
  const e = existing.indexOf(ORG_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = existing.slice(0, b);
    const afterRaw = existing.slice(e + ORG_END.length);
    const after = afterRaw.startsWith('\n') ? afterRaw.slice(1) : afterRaw;
    return `${before}${block}${after}`;
  }
  if (!existing.trim()) return `${block}\n`;
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

/** An agent is "idle" (safe to rebuild) when it doesn't currently own a task that's being worked. */
function isAgentIdle(agentName: string, team: string, tasks: Task[]): boolean {
  return !tasks.some((t) =>
    t.ownerName === agentName &&
    (!t.teamName || t.teamName === team) &&
    /doing|progress|active|start|claim/i.test(t.status),
  );
}

async function openTasksForTeams(client: ManagerClient, teams: string[]): Promise<Task[]> {
  const rows = await Promise.all(
    teams.map(async (team) => {
      const tc = client.withTeam(team);
      const [todo, doing] = await Promise.all([
        tc.tasksByStatus('todo').catch(() => [] as Task[]),
        tc.tasksByStatus('doing').catch(() => [] as Task[]),
      ]);
      return [...todo, ...doing].map((task) => ({ ...task, teamName: task.teamName ?? team }));
    }),
  );
  return rows.flat();
}

// A query event whose latest status is one of these is FINISHED; anything else (dispatched /
// received / processing / queued) means the agent is mid-query.
const QUERY_DONE_RE = /deliver|done|complete|fail|cancel|expire|timeout/i;
/**
 * Agents with an IN-FLIGHT query (a chat /ask, not a tracked task) — they must NOT be rebuilt:
 * a rebuild stops the agent, which cancels its pending query, so the user's chat reply is lost
 * ("the query was lost. Please resend."). isAgentIdle() only looks at TASKS and is blind to this,
 * so we read each team's recent event tail and flag any agent whose latest `query:*` event hasn't
 * reached a terminal status. Best-effort (bounded event window); a miss only risks the pre-existing
 * behavior, a false-positive just defers a rebuild one pass (harmless).
 */
async function collectQueryBusy(client: ManagerClient, teams: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  await Promise.all(
    teams.map(async (team) => {
      const tc = client.withTeam(team);
      try {
        const head = await tc.events(0, { wait: 0, limit: 1 });
        const next = Number((head as { next_seq?: number }).next_seq) || 0;
        const r = await tc.events(Math.max(0, next - 150), { wait: 0, limit: 150 });
        const latest = new Map<string, { seq: number; status: string }>(); // agent → its newest query-event status
        for (const e of (r.events ?? []) as { topic?: string; seq?: number; actor?: string; data?: Record<string, unknown> }[]) {
          const topic = String(e.topic ?? '');
          if (!topic.startsWith('query:')) continue;
          const d = e.data ?? {};
          const agent = String(d.agent ?? e.actor ?? d.target ?? d.name ?? '');
          if (!agent) continue;
          const seq = Number(e.seq) || 0;
          const prev = latest.get(agent);
          if (!prev || seq >= prev.seq) latest.set(agent, { seq, status: topic.slice('query:'.length) });
        }
        for (const [agent, { status }] of latest) if (!QUERY_DONE_RE.test(status)) busy.add(`${team}/${agent}`);
      } catch { /* best-effort */ }
    }),
  );
  return busy;
}

async function buildOrgSyncPlan(client: ManagerClient, opts: { autoRebuild?: boolean } = {}): Promise<OrgSyncPlan> {
  const autoRebuild = opts.autoRebuild !== false;
  const hierarchy = await buildOrgHierarchy(client);

  const rosters: Record<string, string[]> = {};
  const all: { agent: Agent; team: string }[] = [];
  for (const team of hierarchy.teams) {
    const ags = await client.withTeam(team).agents().catch(() => [] as Agent[]);
    rosters[team] = ags.filter((a) => isActiveStatus(a.status)).map((a) => a.name);
    for (const a of ags) all.push({ agent: a, team });
  }

  const brainByTeam: Record<string, string[]> = {};
  for (const team of hierarchy.teams) brainByTeam[team] = await brainInstructions(team);
  const tasks = await openTasksForTeams(client, hierarchy.teams);
  const queryBusy = autoRebuild ? await collectQueryBusy(client, hierarchy.teams) : new Set<string>();

  let skippedBusy = 0;
  const rebuilt: string[] = [];
  const candidates: OrgSyncCandidate[] = [];
  for (const { agent, team } of all) {
    const block = composeOrgBlock(agent.name, team, hierarchy, rosters, brainByTeam[team] ?? []);
    const tc = client.withTeam(team);
    const current = await tc.agentInstructions(agent.name).catch(() => '');
    const next = upsertOrgBlock(current, block);
    const changed = next.trim() !== current.trim();
    let rebuild = false;
    let reason: string | undefined;

    if (changed) {
      if (!autoRebuild) reason = 'auto-rebuild off';
      else if (!isActiveStatus(agent.status)) reason = 'not running';
      else if (!isAgentIdle(agent.name, team, tasks)) { reason = 'task busy'; skippedBusy++; }
      else if (queryBusy.has(`${team}/${agent.name}`)) { reason = 'query busy'; skippedBusy++; }
      else if (rebuilt.length >= MAX_REBUILDS_PER_PASS) { reason = 'rebuild cap'; skippedBusy++; }
      else {
        rebuild = true;
        rebuilt.push(`${team}/${agent.name}`);
      }
    }

    candidates.push({ team, agent: agent.name, status: agent.status, current, next, changed, rebuild, reason });
  }

  return { hierarchy, agents: all.length, candidates, rebuilt, skippedBusy, autoRebuild };
}

export async function previewOrgSync(client: ManagerClient, opts: { autoRebuild?: boolean } = {}): Promise<OrgSyncPreview> {
  const plan = await buildOrgSyncPlan(client, opts);
  const changedAgents = plan.candidates
    .filter((c) => c.changed)
    .map(({ team, agent, status, changed, rebuild, reason }) => ({ team, agent, status, changed, rebuild, reason }));
  return {
    hierarchy: plan.hierarchy,
    agents: plan.agents,
    changed: changedAgents.length,
    rebuilt: plan.rebuilt,
    brain: true,
    skippedBusy: plan.skippedBusy,
    autoRebuild: plan.autoRebuild,
    rebuildLimit: MAX_REBUILDS_PER_PASS,
    changedAgents,
  };
}

/**
 * One reconcile pass: recompose every agent's org block, write the ones that changed, and
 * (smart policy) rebuild a changed agent only if it's idle — rate-limited per pass.
 */
export async function syncOrg(client: ManagerClient, opts: { autoRebuild?: boolean } = {}): Promise<OrgSyncResult> {
  const plan = await buildOrgSyncPlan(client, opts);
  const brain = await writeOrgToBrain(client, plan.hierarchy);

  let written = 0;
  const rebuilt: string[] = [];
  for (const candidate of plan.candidates) {
    if (!candidate.changed) continue;
    const tc = client.withTeam(candidate.team);
    await tc.setAgentInstructions(candidate.agent, candidate.next).catch(() => {});
    written++;
    if (!candidate.rebuild) continue;
    await tc.remote(`/agent ${candidate.agent} rebuild`).catch(() => {});
    rebuilt.push(`${candidate.team}/${candidate.agent}`);
  }
  return { hierarchy: plan.hierarchy, agents: plan.agents, written, rebuilt, brain, skippedBusy: plan.skippedBusy };
}

/**
 * Start the reactive loop: one pass shortly after boot, then every `intervalMs`. Single-flight.
 * Returns a stop function. Honors the `orgSync.enabled` config flag (default on). Takes a getter
 * so it always uses the live client even if it's reassigned (manager/team switch).
 */
export function startOrgSyncLoop(getClient: () => ManagerClient, intervalMs = 5 * 60_000): () => void {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    const cfg = loadSettings();
    if (cfg.orgSync?.enabled === false) return; // explicitly disabled
    running = true;
    try {
      const r = await syncOrg(getClient(), { autoRebuild: cfg.orgSync?.autoRebuild !== false });
      if (r.written || r.rebuilt.length) {
        console.log(`[org-sync] ${r.written} goals updated · rebuilt ${r.rebuilt.length} (${r.rebuilt.join(', ') || '—'}) · ${r.skippedBusy} deferred (busy) · brain=${r.brain}`);
      }
    } catch (e) {
      console.error('[org-sync] pass failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  const startTimer = setTimeout(() => void tick(), 15_000); // let the app settle first
  (startTimer as { unref?: () => void }).unref?.();
  const h = setInterval(() => void tick(), intervalMs);
  (h as { unref?: () => void }).unref?.();
  return () => { stopped = true; clearTimeout(startTimer); clearInterval(h); };
}
