// SPDX-License-Identifier: MIT
/**
 * Control-action → brain recorder (main process). Phase 1 of the "drive everything from the
 * Dashboard" refactor: make EVERY operator control action visible to the self-learning brain.
 *
 * Most config/control mutations write only the local settings store (or local fs) and never
 * reach the manager, so the manager→brain event stream never learns them. Even the ones that
 * DO route through the manager (runtime/instructions/spawn/deploy/concurrency) are event-silent
 * server-side. This module mirrors them all to the brain directly — a timeline audit event for
 * every action, plus richer entity/fact/text writes for the ones that deserve them — via the
 * shared BrainClient.
 *
 * It is invoked from ONE choke point: the ipcMain 'idagents:call' handler in main.ts. Because
 * every renderer call funnels there (bridge METHODS, bridge specials, and app-level appCall
 * methods all flow through it), a single registry covers the whole surface without editing any
 * call site. Fire-and-forget + best-effort: it never throws and never delays the IPC reply.
 *
 * Granularity note: this records ALL recognized control actions (the locked "learn everything"
 * decision). The ACTIONS map IS the allow-list — drop an entry to stop learning that action.
 */
import { brain } from '../../../idctl/src/api/brain.ts';
import { createHash } from 'node:crypto';

type Summary = { subject?: string; data?: Record<string, unknown>; tags?: string[] };
type TrackingCandidate = {
  contributionType: string;
  title: string;
  team?: string;
  agent?: string;
  project?: string;
  taskRef?: string;
  tags?: string[];
  data?: Record<string, unknown>;
};
type OpportunitySignal = { type: string; value?: string };
type TrackingEvent = TrackingCandidate & {
  id: string;
  at: string;
  weekKey: string;
  method: string;
  tags: string[];
  opportunity?: OpportunitySignal;
};

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clip = (v: unknown, n: number): string => s(v).replace(/\s+/g, ' ').trim().slice(0, n);
const clean = (v: unknown, n = 160): string => clip(v, n);

function safeJson(value: unknown, n = 3000): string {
  try { return JSON.stringify(value).slice(0, n); } catch { return ''; }
}

function shortHash(value: unknown): string {
  return createHash('sha1').update(typeof value === 'string' ? value : safeJson(value, 12000)).digest('hex').slice(0, 12);
}

function isoWeekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}

function opportunitySignal(text: string): OpportunitySignal | undefined {
  const amount = text.match(/(?:\$|USD\s*|USDC\s*)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|USDC)\b/i)?.[0];
  const checks: Array<[RegExp, string]> = [
    [/\b(paid work|contract|client|customer|sale|deal|invoice|revenue|sponsor|grant|bounty|rfp|proposal)\b/i, 'revenue'],
    [/\b(partner|partnership|integration|collaboration|co-marketing)\b/i, 'partnership'],
    [/\b(referral|intro|introduction|warm handoff)\b/i, 'referral'],
    [/\b(opportunity|prospect|sales lead|business lead|qualified lead)\b/i, 'lead'],
  ];
  const hit = checks.find(([re]) => re.test(text));
  return hit ? { type: hit[1], ...(amount ? { value: amount } : {}) } : undefined;
}

function candidateForAction(method: string, args: unknown[], result: unknown, summary: Summary): TrackingCandidate | null {
  const data = summary.data ?? {};
  const subject = clean(summary.subject || method, 180);
  switch (method) {
    case 'work:createPlan':
      return {
        contributionType: 'work-dispatch',
        title: subject,
        team: s(data.team),
        tags: ['work', 'dispatch'],
        data: { objective: data.objective, subtasks: data.subtasks, team: data.team },
      };
    case 'work:fanout':
      return {
        contributionType: 'cross-team-fanout',
        title: subject,
        tags: ['work', 'dispatch'],
        data: { objective: data.objective, teams: data.teams },
      };
    case 'work:triage':
      return {
        contributionType: 'task-triage',
        title: subject,
        team: s(data.team),
        agent: s(data.lead),
        tags: ['work', 'triage'],
        data: { lead: data.lead, team: data.team },
      };
    case 'tasks:setLane': {
      const lane = s(data.lane) || s(args[1]);
      if (!/(done|under-review|needs-adjustment|rework|holding|backlog|validated|published)/i.test(lane)) return null;
      return {
        contributionType: 'task-lane',
        title: subject,
        taskRef: s(data.ref) || s(args[0]),
        tags: ['task', 'weekly-contribution'],
        data: { ref: data.ref ?? args[0], lane },
      };
    }
    case 'tasks:setReview': {
      const state = s(data.state) || s(args[1]);
      if (!state) return null;
      return {
        contributionType: 'task-review',
        title: subject,
        taskRef: s(data.ref) || s(args[0]),
        tags: ['task', 'review'],
        data: { ref: data.ref ?? args[0], state },
      };
    }
    case 'projects:save':
      return {
        contributionType: 'project-registry',
        title: subject,
        project: s(data.id) || s(obj(args[0]).id),
        team: s(data.team),
        agent: s(data.lead),
        tags: ['project', ...arrayText(data.tags)],
        data: {
          id: data.id,
          name: data.name,
          status: data.status,
          team: data.team,
          lead: data.lead,
          tags: data.tags,
          links: obj(args[0]).links,
          notes: clean(obj(args[0]).notes, 500),
          description: clean(obj(args[0]).description, 500),
        },
      };
    case 'plans:save':
      return {
        contributionType: 'draft-plan',
        title: subject,
        team: s(data.team),
        agent: s(data.agent),
        project: s(data.id),
        tags: ['plan', 'draft', ...arrayText(data.tags)],
        data: { id: data.id, status: data.status, team: data.team, agent: data.agent, version: data.version, tags: data.tags },
      };
    case 'brain:createPlan':
      return {
        contributionType: 'brain-plan',
        title: subject,
        project: s(obj(result).file),
        tags: ['plan', 'brain-plan'],
        data: { file: obj(result).file, num: obj(result).num, ok: obj(result).ok },
      };
    case 'brain:setPlanStatus':
      return {
        contributionType: 'plan-status',
        title: subject,
        project: s(data.file) || s(args[0]),
        tags: ['plan', 'brain-plan'],
        data: { file: data.file ?? args[0], status: args[1] },
      };
    case 'dreams:save':
      return {
        contributionType: 'dream-report',
        title: subject,
        team: s(data.team),
        agent: s(data.agent),
        project: s(data.id),
        tags: ['dream', 'report'],
        data: { id: data.id, agent: data.agent, team: data.team, focus: data.focus },
      };
    case 'goals:save':
      return {
        contributionType: 'goal',
        title: subject,
        team: s(data.team),
        agent: s(data.agent),
        project: s(data.id),
        tags: ['goal', s(data.priority)].filter(Boolean),
        data: { id: data.id, status: data.status, priority: data.priority, team: data.team, agent: data.agent, autopilot: data.autopilot },
      };
    case 'goalDriver:runOnce':
      return {
        contributionType: 'goal-driver',
        title: subject,
        tags: ['goal', 'autopilot', 'dispatch'],
        data: obj(result),
      };
    case 'skills:syncBrain':
      return {
        contributionType: 'skill-catalog',
        title: subject,
        project: 'capabilities',
        tags: ['capability', 'catalog', 'brain'],
        data: { count: data.count ?? obj(result).count, total: data.total ?? obj(result).total, generatedAt: obj(result).generatedAt },
      };
    case 'materials:process':
    case 'materials:processNext': {
      const m = obj(result);
      if (!m.id) return null;
      return {
        contributionType: 'learn-material',
        title: subject,
        project: s(m.id),
        tags: ['learn', 'material', s(m.kind)].filter(Boolean),
        data: { id: m.id, kind: m.kind, status: m.status, stage: m.stage, source: m.source, teams: obj(m.classification).routedTeams },
      };
    }
    case 'materials:markRecommendation':
      return {
        contributionType: 'learn-recommendation',
        title: subject,
        project: s(args[0]),
        tags: ['learn', 'review'],
        data: { materialId: args[0], recommendationId: args[1], state: args[2] },
      };
    default:
      return null;
  }
}

function trackingEvent(method: string, args: unknown[], result: unknown, summary: Summary): TrackingEvent | null {
  const candidate = candidateForAction(method, args, result, summary);
  if (!candidate) return null;
  const at = new Date();
  const weekKey = isoWeekKey(at);
  const text = [
    candidate.title,
    method,
    safeJson(candidate.data),
    safeJson({ team: candidate.team, agent: candidate.agent, project: candidate.project, taskRef: candidate.taskRef }),
  ].join(' ');
  const opportunity = opportunitySignal(text);
  const id = `tracking:${opportunity ? 'opportunity' : 'contribution'}:${weekKey}:${shortHash({ method, candidate, opportunity })}`;
  return {
    ...candidate,
    id,
    at: at.toISOString(),
    weekKey,
    method,
    ...(opportunity ? { opportunity } : {}),
    tags: Array.from(new Set(['contribution-tracking', ...(candidate.tags ?? []), ...(opportunity ? ['opportunity-attribution', opportunity.type] : [])])),
  };
}

function trackingEntry(event: TrackingEvent): string {
  const details = [
    event.team ? `team=${event.team}` : '',
    event.agent ? `agent=${event.agent}` : '',
    event.project ? `project=${event.project}` : '',
    event.taskRef ? `task=${event.taskRef}` : '',
  ].filter(Boolean).join(' ');
  return [
    `<!-- ${event.id} -->`,
    `- ${event.at} [${event.contributionType}] ${event.title}`,
    details ? `  - target: ${details}` : '',
    event.opportunity ? `  - opportunity: ${event.opportunity.type}${event.opportunity.value ? ` value=${event.opportunity.value}` : ''}` : '',
    `  - attribution: source=control-center method=${event.method} event=${event.id}`,
  ].filter(Boolean).join('\n');
}

async function appendTrackingMemory(key: string, heading: string, event: TrackingEvent, tags: string[]): Promise<void> {
  const marker = `<!-- ${event.id} -->`;
  const existing = await brain.getMemory('control-center', key);
  if (existing?.includes(marker)) return;
  const body = trackingEntry(event);
  const content = existing?.trim()
    ? `${existing.trim()}\n${body}\n`
    : [`# ${heading}`, '', `Week: ${event.weekKey}`, '', body, ''].join('\n');
  await brain.memory('control-center', {
    key,
    content,
    tags,
    shared: true,
    project: 'bittrees',
  });
}

async function recordTrackingHooks(method: string, args: unknown[], result: unknown, summary: Summary): Promise<void> {
  const event = trackingEvent(method, args, result, summary);
  if (!event) return;
  await Promise.all([
    brain.timeline({
      type: event.opportunity ? 'tracking:opportunity-attributed' : 'tracking:weekly-contribution',
      subject: event.title,
      data: {
        id: event.id,
        weekKey: event.weekKey,
        method: event.method,
        contributionType: event.contributionType,
        team: event.team,
        agent: event.agent,
        project: event.project,
        taskRef: event.taskRef,
        opportunity: event.opportunity,
        data: event.data ?? {},
      },
      tags: ['control-center', 'tracking', ...event.tags],
    }),
    brain.entity({
      id: event.id,
      type: event.opportunity ? 'opportunity' : 'weekly-contribution',
      name: event.title,
      status: 'recorded',
      tags: ['dashboard-state', 'tracking', ...event.tags],
      data: {
        weekKey: event.weekKey,
        method: event.method,
        contributionType: event.contributionType,
        team: event.team,
        agent: event.agent,
        project: event.project,
        taskRef: event.taskRef,
        opportunity: event.opportunity,
        data: event.data ?? {},
      },
    }),
    appendTrackingMemory(
      `weekly-contributions:${event.weekKey}`,
      'Weekly contribution tracker',
      event,
      ['dashboard-state', 'tracking', 'weekly-contributions', 'bittrees'],
    ),
    ...(event.opportunity ? [
      appendTrackingMemory(
        `opportunity-attribution:${event.weekKey}`,
        'Opportunity attribution tracker',
        event,
        ['dashboard-state', 'tracking', 'opportunity-attribution', 'bittrees', event.opportunity.type],
      ),
    ] : []),
  ]);
}

/**
 * method → summarizer. Presence here = "record this action to the brain." Each summarizer is
 * cheap, synchronous, and secret-free (BrainClient.control redacts secret-named fields again as
 * defense-in-depth). args/result are exactly what the IPC method received/returned.
 */
const ACTIONS: Record<string, (args: unknown[], result: unknown) => Summary> = {
  // ── org / coordination (was client-side-only → brain blind) ──
  'coordinator:set': (a) => ({ subject: `team ${s(a[0])} lead → ${s(a[1])}`, data: { team: s(a[0]), agent: s(a[1]) }, tags: ['org'] }),
  'coordinator:setPrimary': (a) => ({ subject: `primary lead → ${s(a[1])} (${s(a[0])})`, data: { team: s(a[0]), agent: s(a[1]) }, tags: ['org'] }),
  'org:setSecondaryLeads': (a) => ({ subject: 'secondary leads updated', data: { leads: a[0] }, tags: ['org'] }),
  'org:setConfig': (a) => ({ subject: 'org-sync config changed', data: obj(a[0]), tags: ['org', 'cc-config'] }),

  // ── projects registry (was client-side-only) ──
  'projects:save': (a) => { const p = obj(a[0]); return { subject: `project saved: ${s(p.name) || s(p.id)}`, data: { id: p.id, name: p.name, status: p.status, team: p.team, autoCommit: p.autoCommit, tags: p.tags, path: p.path, lead: p.lead, policy: p.policy }, tags: ['project'] }; },
  'projects:remove': (a) => ({ subject: `project removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['project'] }),
  'projects:syncRoot': (a, r) => ({ subject: 'workspace projects synced', data: { root: a[0], ...obj(r) }, tags: ['project'] }),

  // ── task overlays (was client-side-only; the manager has no lane/deps/review field) ──
  'tasks:setLane': (a) => ({ subject: `task ${s(a[0])} → lane ${s(a[1])}`, data: { ref: s(a[0]), lane: s(a[1]) }, tags: ['task'] }),
  'tasks:setDeps': (a) => ({ subject: `task ${s(a[0])} deps set`, data: { ref: s(a[0]), deps: a[1] }, tags: ['task'] }),
  'tasks:setReview': (a) => ({ subject: `task ${s(a[0])} review → ${s(a[1])}`, data: { ref: s(a[0]), state: s(a[1]) }, tags: ['task'] }),

  // ── capability registries (was client-side-only) ──
  'mcp:add': (a) => ({ subject: `mcp server added: ${s(obj(a[0]).name)}`, data: obj(a[0]), tags: ['cc-config', 'mcp'] }),
  'mcp:remove': (a) => ({ subject: `mcp server removed: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'mcp'] }),
  'providers:add': (a) => ({ subject: `provider added: ${s(obj(a[0]).name)}`, data: obj(a[0]), tags: ['cc-config', 'provider'] }),
  'providers:remove': (a) => ({ subject: `provider removed: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:setDefault': (a) => ({ subject: `default provider → ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:setModelSelection': (a) => ({ subject: `provider Health models updated: ${s(a[0])}`, data: { name: s(a[0]), selection: obj(a[1]) }, tags: ['cc-config', 'provider'] }),
  'providers:toggle': (a) => ({ subject: `provider toggled: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:connect': (a) => ({ subject: `provider connected: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),

  // ── agent/team config writes (manager-routed but event-SILENT → brain didn't learn) ──
  setAgentRuntime: (a) => ({ subject: `agent ${s(a[0])} runtime → ${s(a[1])}`, data: { id: s(a[0]), runtime: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentEffort: (a) => ({ subject: `agent ${s(a[0])} effort → ${s(a[1])}`, data: { id: s(a[0]), effort: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentSpeed: (a) => ({ subject: `agent ${s(a[0])} speed → ${s(a[1])}`, data: { id: s(a[0]), speed: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  'agent:setInstructions': (a) => ({ subject: `agent ${s(a[0])} instructions updated`, data: { id: s(a[0]), team: s(a[2]), chars: s(a[1]).length }, tags: ['agent-config'] }),
  'agent:move': (a) => ({ subject: `agent ${s(a[0])} ${s(a[2]) ? `${s(a[2])} → ` : '→ team '}${s(a[1])}`, data: { id: s(a[0]), team: s(a[1]), sourceTeam: s(a[2]), createTarget: Boolean(a[3]) }, tags: ['agent-config'] }),
  setAgentMcp: (a) => ({ subject: `agent ${s(a[0])} mcp updated`, data: { id: s(a[0]) }, tags: ['agent-config', 'mcp'] }),
  setAgentDelegates: (a) => ({ subject: `agent ${s(a[0])} delegates set`, data: { id: s(a[0]), delegates: a[1] }, tags: ['agent-config'] }),
  setTeamDelegates: (a) => ({ subject: `team ${s(a[0])} delegates set`, data: { team: s(a[0]), delegates: a[1] }, tags: ['team-config'] }),
  spawnAgent: (a) => { const sp = obj(a[0]); return { subject: `agent spawned: ${s(sp.name)}`, data: { name: sp.name, runtime: sp.runtime, model: sp.model, role: sp.role }, tags: ['agent-config', 'lifecycle'] }; },
  deployTeam: (a) => ({ subject: `team deployed: ${s(a[0])}`, data: { team: s(a[0]) }, tags: ['team-config', 'lifecycle'] }),
  'team:lifecycle': (a) => ({ subject: `team ${s(a[0])} ${s(a[1])}`, data: { team: s(a[0]), op: s(a[1]) }, tags: ['team-config', 'lifecycle'] }),
  'team:delete': (a) => ({ subject: `team deleted: ${s(a[0])}`, data: { team: s(a[0]) }, tags: ['team-config', 'lifecycle'] }),
  'team:install': (a) => ({ subject: `team installed: ${s(a[1])} (from ${s(a[0])})`, data: { template: s(a[0]), to: s(a[1]) }, tags: ['team-config'] }),
  rebuildAgent: (a) => ({ subject: `agent rebuilt: ${s(a[0])}`, data: { agent: s(a[0]), team: s(a[1]) }, tags: ['lifecycle'] }),
  'manager:setLocalConcurrency': (a) => ({ subject: `local concurrency → ${Number(a[0])}`, data: { n: Number(a[0]) }, tags: ['cc-config'] }),

  // ── capabilities (skills + computer-use) ──
  installSkill: (a) => ({ subject: `skill installed: ${s(a[0])} → ${s(a[1])}`, data: { skill: s(a[0]), agent: s(a[1]), team: s(a[2]) }, tags: ['capability'] }),
  uninstallSkill: (a) => ({ subject: `skill removed: ${s(a[0])} ✗ ${s(a[1])}`, data: { skill: s(a[0]), agent: s(a[1]), team: s(a[2]) }, tags: ['capability'] }),
  createSkill: (a) => ({ subject: 'skill created', data: obj(a[0]), tags: ['capability'] }),
  projectPluginSkill: (a, r) => ({ subject: `plugin digested as skill: ${s(a[0])}`, data: obj(r), tags: ['capability'] }),
  deleteSkill: (a) => ({ subject: `skill deleted: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['capability'] }),
  'skills:syncBrain': (_a, r) => ({ subject: 'skill catalog synced to brain', data: obj(r), tags: ['capability', 'brain'] }),
  'cu:attach': (a) => ({ subject: `computer-use attached: ${s(a[1]) || s(a[0])}`, data: { agent: s(a[1]) || s(a[0]) }, tags: ['capability', 'computer-use'] }),
  'cu:detach': (a) => ({ subject: `computer-use detached: ${s(a[1]) || s(a[0])}`, data: { agent: s(a[1]) || s(a[0]) }, tags: ['capability', 'computer-use'] }),

  // ── project work orchestration (project-framed decisions) ──
  'work:createPlan': (a) => ({ subject: `plan dispatched: ${clip(a[0], 80)}`, data: { objective: clip(a[0], 400), subtasks: Array.isArray(a[1]) ? a[1].length : 0, team: s(obj(a[2]).team) }, tags: ['project', 'dispatch'] }),
  'work:fanout': (a) => ({ subject: `fan-out: ${clip(a[0], 80)}`, data: { objective: clip(a[0], 400), teams: a[1] }, tags: ['project', 'dispatch'] }),
  'work:triage': (a) => ({ subject: `triage by ${s(a[0])}`, data: { lead: s(a[0]), team: s(a[1]) }, tags: ['project', 'dispatch'] }),

  // ── operator work state (local fs + manager schedules; otherwise brain learned it only incidentally) ──
  'plans:save': (a) => { const p = obj(a[0]); return { subject: `draft plan saved: ${clip(p.title, 80)}`, data: { id: p.id, status: p.status, team: p.team, agent: p.agent, version: p.version, tags: p.tags }, tags: ['plan', 'draft'] }; },
  'plans:remove': (a) => ({ subject: `draft plan removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['plan', 'draft'] }),
  'goals:save': (a) => { const g = obj(a[0]); return { subject: `goal saved: ${clip(g.title, 80)}`, data: { id: g.id, status: g.status, priority: g.priority, team: g.team, agent: g.agent, autopilot: g.autopilot, driver: g.driver }, tags: ['goal'] }; },
  'goals:remove': (a) => ({ subject: `goal removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['goal'] }),
  'loops:save': (a) => { const l = obj(a[0]); return { subject: `loop saved: ${clip(l.title, 80)}`, data: { id: l.id, team: l.team, steps: Array.isArray(l.steps) ? l.steps.length : 0, lastRunAt: l.lastRunAt }, tags: ['loop'] }; },
  'loops:remove': (a) => ({ subject: `loop removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['loop'] }),
  'goalDriver:setConfig': (a) => ({ subject: 'goal driver config changed', data: obj(a[0]), tags: ['goal', 'autopilot', 'cc-config'] }),
  'goalDriver:runOnce': (_a, r) => ({ subject: 'goal driver ran', data: obj(r), tags: ['goal', 'autopilot', 'dispatch'] }),
  addHeartbeat: (a) => ({ subject: `heartbeat scheduled: ${s(a[0])}`, data: { agent: s(a[0]), seconds: a[1], delivery: a[3], team: s(a[4]) }, tags: ['schedule', 'heartbeat'] }),
  addCalendarCheckin: (a) => ({ subject: `calendar objective scheduled: ${s(a[0])}`, data: { agent: s(a[0]), time: s(a[1]), when: s(a[2]), delivery: obj(a[4]).delivery, team: s(a[5]) }, tags: ['schedule', 'loop'] }),
  pauseSchedule: (a) => ({ subject: `schedule paused: ${s(a[0])}`, data: { id: s(a[0]), team: s(a[1]) }, tags: ['schedule'] }),
  resumeSchedule: (a) => ({ subject: `schedule resumed: ${s(a[0])}`, data: { id: s(a[0]), team: s(a[1]) }, tags: ['schedule'] }),
  removeSchedule: (a) => ({ subject: `schedule removed: ${s(a[0])}`, data: { id: s(a[0]), team: s(a[1]) }, tags: ['schedule'] }),
  'checkins:close': (a) => ({ subject: `check-in closed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['schedule', 'checkin'] }),

  // ── brain plans + dreams + questions (out-of-band fs/git; brain learned only incidentally) ──
  'brain:createPlan': (a, r) => ({ subject: `brain plan created: ${clip(a[0], 80)}`, data: obj(r), tags: ['brain-plan'] }),
  'brain:setPlanStatus': (a, r) => ({ subject: `plan ${s(a[0])} → ${s(a[1])}`, data: { file: s(a[0]), ...obj(r) }, tags: ['brain-plan'] }),
  'dreams:save': (a) => { const d = obj(a[0]); return { subject: `dream saved: ${clip(d.title, 80)}`, data: { id: d.id, agent: d.agent, team: d.team, focus: d.focus }, tags: ['dream'] }; },
  'questions:add': (a) => { const q = obj(a[0]); return { subject: `blocker question: ${clip(q.question, 80)}`, data: { id: q.id, agent: q.agent, taskRef: q.taskRef, options: q.options, team: q.team }, tags: ['decision'] }; },
  'materials:save': (_a, r) => { const m = obj(r); return { subject: `learn material saved: ${clip(m.title, 80)}`, data: { id: m.id, kind: m.kind, priority: m.priority, status: m.status, stage: m.stage, source: m.source }, tags: ['learn', 'material'] }; },
  'materials:importFiles': (_a, r) => ({ subject: 'learn material files imported', data: { count: Array.isArray(r) ? r.length : 0 }, tags: ['learn', 'material'] }),
  'materials:priority': (_a, r) => { const m = obj(r); return { subject: `learn material priority: ${clip(m.title, 80)}`, data: { id: m.id, priority: m.priority, prioritized: m.prioritized }, tags: ['learn', 'material'] }; },
  'materials:process': (_a, r) => { const m = obj(r); return { subject: `learn material processed: ${clip(m.title, 80)}`, data: { id: m.id, kind: m.kind, status: m.status, stage: m.stage, teams: obj(m.classification).routedTeams }, tags: ['learn', 'material'] }; },
  'materials:processNext': (_a, r) => { const m = obj(r); return { subject: m.id ? `learn material processed: ${clip(m.title, 80)}` : 'learn processor found no queued material', data: { id: m.id, kind: m.kind, status: m.status, stage: m.stage, teams: obj(m.classification).routedTeams }, tags: ['learn', 'material'] }; },
  'materials:markRecommendation': (a, r) => { const m = obj(r); return { subject: `learn recommendation ${s(a[2])}: ${clip(m.title, 80)}`, data: { materialId: s(a[0]), recommendationId: s(a[1]), state: s(a[2]) }, tags: ['learn', 'review'] }; },
  'materials:remove': (a) => ({ subject: `learn material removed: ${s(a[0])}`, data: { id: s(a[0]) }, tags: ['learn', 'material'] }),
};

const keyPart = (v: unknown): string => (s(v) || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';

export async function recordLearnMaterial(value: unknown): Promise<void> {
  try {
    const m = obj(value);
    if (!m.id) return;
    const id = `learn:${s(m.id)}`;
    const title = s(m.title) || s(m.id);
    const status = s(m.status) || 'queued';
    const classification = obj(m.classification);
    const routedTeams = Array.isArray(classification.routedTeams) ? classification.routedTeams.map(String) : [];
    const topics = Array.isArray(classification.topics) ? classification.topics.map(String) : [];
    const activeGoalMatches = Array.isArray(m.activeGoalMatches)
      ? m.activeGoalMatches.map((goal) => {
          const g = obj(goal);
          return { id: s(g.id), team: s(g.team), score: Number(g.score ?? 0) || 0 };
        }).filter((goal) => goal.id)
      : [];
    const recommendations = Array.isArray(m.recommendations) ? m.recommendations : [];
    const brainSync = obj(m.brainSync);
    const hasDigestOutput = Boolean(s(m.summary).trim() || s(m.comparison).trim() || brainSync.status);
    const canPublishDigestMemory = (status === 'ready' || status === 'blocked') && hasDigestOutput;
    const writes: Array<Promise<unknown>> = [
      brain.entity({
        id,
        type: 'learn-material',
        name: title,
        status,
        tags: ['learn', 'material', 'dashboard-state', s(m.kind) || 'unknown'],
        exactId: true,
        mergeAliases: false,
        data: {
          kind: m.kind,
          priority: m.priority,
          prioritized: !!m.prioritized,
          stage: m.stage,
          source: m.source,
          status,
          trusted_source: false,
          review_required: true,
          teams: routedTeams,
          topics,
          activeGoalMatches,
          recommendations: recommendations.length,
          blockingRecommendations: recommendations.filter((rec) => obj(rec).blocking === true && s(obj(rec).reviewState) === 'draft').length,
          brainSync: brainSync.status ? {
            status: brainSync.status,
            sourceId: brainSync.sourceId,
            at: brainSync.at,
            schemaVersion: brainSync.schemaVersion,
            exactEntity: brainSync.exactEntity,
            entity: brainSync.entity,
            sourceEntity: brainSync.sourceEntity,
            facts: brainSync.facts,
            edges: brainSync.edges,
            edgeCount: brainSync.edgeCount,
            expectedEdgeCount: brainSync.expectedEdgeCount,
            text: brainSync.text,
            memory: brainSync.memory,
            timeline: brainSync.timeline,
          } : null,
          packetReady: canPublishDigestMemory,
        },
      }),
    ];
    if (canPublishDigestMemory) {
      writes.push(brain.memory('control-center', {
        key: id,
        content: [
          `# Learn material: ${title}`,
          `Status: ${status}`,
          `Stage: ${s(m.stage) || 'submitted'}`,
          `Priority: ${s(m.priority) || 'normal'}${m.prioritized ? ' (pinned)' : ''}`,
          s(m.source) ? `Source: ${s(m.source)}` : '',
          routedTeams.length ? `Teams: ${routedTeams.join(', ')}` : '',
          '',
          s(m.summary).slice(0, 12000),
          '',
          s(m.comparison).slice(0, 8000),
        ].filter(Boolean).join('\n'),
        tags: ['dashboard-state', 'learn', 'material'],
        shared: true,
        project: routedTeams[0] ?? 'default',
      }));
    }
    await Promise.allSettled(writes);
  } catch {
    /* Brain mirroring must never break control actions or Learn processing. */
  }
}

/** Actions that ALSO warrant a richer write (entity upsert / text ingest) beyond the timeline. */
const EXTRAS: Record<string, (args: unknown[], result: unknown) => void> = {
  'materials:save': (_a, r) => { void recordLearnMaterial(r); },
  'materials:priority': (_a, r) => { void recordLearnMaterial(r); },
  'materials:process': (_a, r) => { void recordLearnMaterial(r); },
  'materials:processNext': (_a, r) => { void recordLearnMaterial(r); },
  'materials:markRecommendation': (_a, r) => { void recordLearnMaterial(r); },
  'materials:importFiles': (_a, r) => {
    if (Array.isArray(r)) for (const material of r) void recordLearnMaterial(material);
  },
  'materials:remove': (a) => {
    const id = s(a[0]);
    if (!id) return;
    void brain.entity({ id: `learn:${id}`, type: 'learn-material', name: id, status: 'removed', tags: ['learn', 'removed', 'dashboard-state'] });
  },
  'plans:save': (a) => {
    const p = obj(a[0]);
    if (!p.id) return;
    const id = `plan:${s(p.id)}`;
    const team = s(p.team) || 'default';
    const title = s(p.title) || s(p.id);
    const status = s(p.status) || 'draft';
    void brain.entity({
      id, type: 'plan', name: title, status,
      tags: ['plan', 'dashboard-state', ...(Array.isArray(p.tags) ? p.tags.map(String) : [])],
      data: { team, agent: p.agent, version: p.version, promoted: Array.isArray(p.tags) ? p.tags.some((t) => /^→ plan /.test(String(t))) : false },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: team },
      { entity_id: id, field: 'status', value: status },
      ...(p.agent ? [{ entity_id: id, field: 'agent', value: s(p.agent) }] : []),
      ...(p.version ? [{ entity_id: id, field: 'version', value: Number(p.version) }] : []),
    ]);
    void brain.memory('control-center', {
      key: id,
      content: [`# Draft plan: ${title}`, `Status: ${status}`, `Team: ${team}`, p.agent ? `Agent: ${s(p.agent)}` : '', '', s(p.content).slice(0, 24000)].filter(Boolean).join('\n'),
      tags: ['dashboard-state', 'plan', 'draft'],
      shared: true,
      project: team,
    });
  },
  'plans:remove': (a) => {
    const id = s(a[0]);
    if (!id) return;
    void brain.entity({ id: `plan:${id}`, type: 'plan', name: id, status: 'removed', tags: ['plan', 'removed', 'dashboard-state'] });
  },
  'goals:save': (a) => {
    const g = obj(a[0]);
    if (!g.id) return;
    const id = `goal:${s(g.id)}`;
    const team = s(g.team) || 'default';
    const title = s(g.title) || s(g.id);
    const status = s(g.status) || 'draft';
    const priority = s(g.priority) || 'general';
    void brain.entity({
      id, type: 'goal', name: title, status,
      tags: ['goal', priority, 'dashboard-state', g.autopilot ? 'autopilot' : 'manual'],
      data: { team, priority, agent: g.agent, autopilot: !!g.autopilot, driver: g.driver },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: team },
      { entity_id: id, field: 'status', value: status },
      { entity_id: id, field: 'priority', value: priority },
      { entity_id: id, field: 'autopilot', value: !!g.autopilot },
      ...(g.agent ? [{ entity_id: id, field: 'agent', value: s(g.agent) }] : []),
    ]);
    void brain.memory('control-center', {
      key: id,
      content: [`# Goal: ${title}`, `Status: ${status}`, `Tier: ${priority}`, `Team: ${team}`, `Autopilot: ${g.autopilot ? 'on' : 'off'}`, g.agent ? `Agent: ${s(g.agent)}` : '', '', s(g.content).slice(0, 12000)].filter(Boolean).join('\n'),
      tags: ['dashboard-state', 'goal'],
      shared: true,
      project: team,
    });
  },
  'goals:remove': (a) => {
    const id = s(a[0]);
    if (!id) return;
    void brain.entity({ id: `goal:${id}`, type: 'goal', name: id, status: 'removed', tags: ['goal', 'removed', 'dashboard-state'] });
  },
  'loops:save': (a) => {
    const l = obj(a[0]);
    if (!l.id) return;
    const id = `loop:${s(l.id)}`;
    const team = s(l.team) || 'default';
    const title = s(l.title) || s(l.id);
    const steps = Array.isArray(l.steps) ? l.steps.map(obj) : [];
    void brain.entity({
      id, type: 'loop', name: title, status: l.lastRunAt ? 'ran' : 'saved',
      tags: ['loop', 'dashboard-state'],
      data: { team, steps: steps.length, lastRunAt: l.lastRunAt },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: team },
      { entity_id: id, field: 'steps', value: steps.length },
      ...(l.lastRunAt ? [{ entity_id: id, field: 'lastRunAt', value: Number(l.lastRunAt) }] : []),
    ]);
    void brain.memory('control-center', {
      key: id,
      content: [
        `# Loop: ${title}`,
        `Team: ${team}`,
        s(l.goal) ? `Goal: ${s(l.goal)}` : '',
        '',
        ...steps.map((step, i) => `${i + 1}. ${s(step.agent)}: ${s(step.task)}`),
      ].filter(Boolean).join('\n'),
      tags: ['dashboard-state', 'loop'],
      shared: true,
      project: team,
    });
  },
  'loops:remove': (a) => {
    const id = s(a[0]);
    if (!id) return;
    void brain.entity({ id: `loop:${id}`, type: 'loop', name: id, status: 'removed', tags: ['loop', 'removed', 'dashboard-state'] });
  },
  'goalDriver:setConfig': (a) => {
    void brain.memory('control-center', {
      key: 'goalDriver:config',
      content: JSON.stringify(obj(a[0]), null, 2),
      tags: ['dashboard-state', 'goal', 'autopilot', 'cc-config'],
      shared: true,
    });
  },
  addHeartbeat: (a) => {
    const team = s(a[4]) || 'default';
    const agent = s(a[0]);
    if (!agent) return;
    const id = `schedule:heartbeat:${keyPart(team)}:${keyPart(agent)}`;
    void brain.entity({ id, type: 'schedule', name: `Heartbeat: ${agent}`, status: 'active', tags: ['schedule', 'heartbeat', 'dashboard-state'], data: { team, agent, seconds: a[1], delivery: a[3] } });
    void brain.memory('control-center', {
      key: id,
      content: [`# Heartbeat: ${agent}`, `Team: ${team}`, `Every: ${a[1]} seconds`, `Delivery: ${s(a[3]) || 'internal'}`, '', s(a[2])].filter(Boolean).join('\n'),
      tags: ['dashboard-state', 'schedule', 'heartbeat'],
      shared: true,
      project: team,
    });
  },
  addCalendarCheckin: (a) => {
    const team = s(a[5]) || 'default';
    const agent = s(a[0]);
    if (!agent) return;
    const id = `schedule:calendar:${keyPart(team)}:${keyPart(agent)}:${keyPart(a[1])}:${keyPart(a[2])}:${keyPart(clip(a[3], 40))}`;
    void brain.entity({ id, type: 'schedule', name: `Calendar objective: ${agent}`, status: 'active', tags: ['schedule', 'calendar', 'loop', 'dashboard-state'], data: { team, agent, time: a[1], when: a[2], delivery: obj(a[4]).delivery } });
    void brain.memory('control-center', {
      key: id,
      content: [`# Calendar objective: ${agent}`, `Team: ${team}`, `When: ${s(a[2])} at ${s(a[1])}`, `Delivery: ${s(obj(a[4]).delivery) || 'talk'}`, '', s(a[3]).slice(0, 12000)].filter(Boolean).join('\n'),
      tags: ['dashboard-state', 'schedule', 'calendar', 'loop'],
      shared: true,
      project: team,
    });
  },
  pauseSchedule: (a) => { if (s(a[0])) void brain.entity({ id: `schedule:${s(a[0])}`, type: 'schedule', name: s(a[0]), status: 'paused', tags: ['schedule', 'dashboard-state'] }); },
  resumeSchedule: (a) => { if (s(a[0])) void brain.entity({ id: `schedule:${s(a[0])}`, type: 'schedule', name: s(a[0]), status: 'active', tags: ['schedule', 'dashboard-state'] }); },
  removeSchedule: (a) => { if (s(a[0])) void brain.entity({ id: `schedule:${s(a[0])}`, type: 'schedule', name: s(a[0]), status: 'removed', tags: ['schedule', 'removed', 'dashboard-state'] }); },
  'projects:save': (a) => {
    const p = obj(a[0]);
    if (!p.id) return;
    const id = `project:${s(p.id)}`;
    void brain.entity({
      id, type: 'project', name: s(p.name) || s(p.id), status: s(p.status) || 'active',
      tags: ['project', ...(Array.isArray(p.tags) ? p.tags.map(String) : [])],
      data: { team: p.team, autoCommit: p.autoCommit, path: p.path, links: p.links, lead: p.lead, policy: p.policy },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: s(p.team) },
      { entity_id: id, field: 'status', value: s(p.status) },
      ...(p.lead ? [{ entity_id: id, field: 'lead', value: s(p.lead) }] : []),
    ]);
  },
  'brain:createPlan': (a, r) => {
    const res = obj(r);
    if (!res.ok) return;
    void brain.ingestText({ sourceKind: 'idagents-brain-plan', sourceId: `brain-plan:${s(res.file)}`, title: s(a[0]), content: s(a[1]), metadata: { num: res.num, file: res.file } });
  },
  'dreams:save': (a) => {
    const d = obj(a[0]);
    if (!d.id || !s(d.content).trim()) return;
    void brain.ingestText({ sourceKind: 'idagents-dream', sourceId: `dream:${s(d.id)}`, title: s(d.title) || 'dream', content: s(d.content), metadata: { agent: d.agent, team: d.team, focus: d.focus } });
  },
};

/** Mirror a successful control action to the brain. Best-effort, never throws, never awaited. */
export function recordControlAction(method: string, args: unknown[], result: unknown): void {
  try {
    const summarize = ACTIONS[method];
    let out: Summary | undefined;
    if (summarize) {
      try { out = summarize(args, result) ?? {}; } catch { out = {}; }
      void brain.control(method, out);
      void recordTrackingHooks(method, args, result, out).catch(() => {});
    }
    const extra = EXTRAS[method];
    if (extra) { try { extra(args, result); } catch { /* best-effort */ } }
  } catch { /* telemetry must never break the IPC reply */ }
}

/** The set of methods that are recorded (for tests / introspection). */
export const RECORDED_ACTIONS = new Set(Object.keys(ACTIONS));
