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

type Summary = { subject?: string; data?: Record<string, unknown>; tags?: string[] };

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clip = (v: unknown, n: number): string => s(v).replace(/\s+/g, ' ').trim().slice(0, n);

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
  'providers:toggle': (a) => ({ subject: `provider toggled: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),
  'providers:connect': (a) => ({ subject: `provider connected: ${s(a[0])}`, data: { name: s(a[0]) }, tags: ['cc-config', 'provider'] }),

  // ── agent/team config writes (manager-routed but event-SILENT → brain didn't learn) ──
  setAgentRuntime: (a) => ({ subject: `agent ${s(a[0])} runtime → ${s(a[1])}`, data: { id: s(a[0]), runtime: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentEffort: (a) => ({ subject: `agent ${s(a[0])} effort → ${s(a[1])}`, data: { id: s(a[0]), effort: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  setAgentSpeed: (a) => ({ subject: `agent ${s(a[0])} speed → ${s(a[1])}`, data: { id: s(a[0]), speed: s(a[1]), team: s(a[2]) }, tags: ['agent-config'] }),
  'agent:setInstructions': (a) => ({ subject: `agent ${s(a[0])} instructions updated`, data: { id: s(a[0]), team: s(a[2]), chars: s(a[1]).length }, tags: ['agent-config'] }),
  'agent:move': (a) => ({ subject: `agent ${s(a[0])} → team ${s(a[1])}`, data: { id: s(a[0]), team: s(a[1]) }, tags: ['agent-config'] }),
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
  'goals:save': (a) => { const g = obj(a[0]); return { subject: `goal saved: ${clip(g.title, 80)}`, data: { id: g.id, status: g.status, team: g.team, agent: g.agent, autopilot: g.autopilot, driver: g.driver }, tags: ['goal'] }; },
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
};

const keyPart = (v: unknown): string => (s(v) || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';

/** Actions that ALSO warrant a richer write (entity upsert / text ingest) beyond the timeline. */
const EXTRAS: Record<string, (args: unknown[], result: unknown) => void> = {
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
    void brain.entity({
      id, type: 'goal', name: title, status,
      tags: ['goal', 'dashboard-state', g.autopilot ? 'autopilot' : 'manual'],
      data: { team, agent: g.agent, autopilot: !!g.autopilot, driver: g.driver },
    });
    void brain.facts([
      { entity_id: id, field: 'team', value: team },
      { entity_id: id, field: 'status', value: status },
      { entity_id: id, field: 'autopilot', value: !!g.autopilot },
      ...(g.agent ? [{ entity_id: id, field: 'agent', value: s(g.agent) }] : []),
    ]);
    void brain.memory('control-center', {
      key: id,
      content: [`# Goal: ${title}`, `Status: ${status}`, `Team: ${team}`, `Autopilot: ${g.autopilot ? 'on' : 'off'}`, g.agent ? `Agent: ${s(g.agent)}` : '', '', s(g.content).slice(0, 12000)].filter(Boolean).join('\n'),
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
    if (summarize) {
      let out: Summary;
      try { out = summarize(args, result) ?? {}; } catch { out = {}; }
      void brain.control(method, out);
    }
    const extra = EXTRAS[method];
    if (extra) { try { extra(args, result); } catch { /* best-effort */ } }
  } catch { /* telemetry must never break the IPC reply */ }
}

/** The set of methods that are recorded (for tests / introspection). */
export const RECORDED_ACTIONS = new Set(Object.keys(ACTIONS));
