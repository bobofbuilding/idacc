// SPDX-License-Identifier: MIT
/**
 * Shared command registry — the single source of truth behind the Dashboard command palette
 * (⌘K) and slide-over control panels. Each command is a small descriptor whose
 * run(ctx) either navigates to a view, opens a drawer panel, or executes an IPC action.
 *
 * Because every IPC mutation flows through the brain-recording choke point in main.ts, any
 * action a command runs is automatically learned by the brain — the palette is a control
 * surface that's brain-aware for free.
 */
import type { FleetStore } from '../store.ts';
import { call } from '../store.ts';
import type {
  CommandConfirmation,
  CommandMetadata,
  CommandOperationContext,
  CommandReceiptKind,
  CommandRisk,
} from './commandRuntime.ts';

export type Navigate = (view: string) => void;
export type OpenDrawer = (panelId: string) => void;

export interface CommandCtx {
  store: FleetStore;
  navigate: Navigate;
  openDrawer: OpenDrawer;
  /** Stable invocation identity shared with the durable command receipt. */
  command: CommandOperationContext;
  /** Transient one-line feedback shown in the palette while/after a command runs. */
  setStatus: (msg: string) => void;
}

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Full-page owner for deeper review, recovery, and receipts. */
  ownerView: string;
  /** Manager capability-manifest features required before execution. */
  requiredFeatures: readonly string[];
  risk: CommandRisk;
  confirmation: CommandConfirmation;
  receiptKind: CommandReceiptKind;
  /** Stable resources shown in receipts and used for operator recovery. */
  resourceRefs?: readonly string[];
  /** Extra search terms (space-separated) so a command is findable by intent, not just label. */
  keywords?: string;
  /** Right-aligned hint (target view, shortcut, …). */
  hint?: string;
  run: (ctx: CommandCtx) => void | Promise<void>;
}

export function commandMetadata(command: Command): CommandMetadata {
  return {
    commandId: command.id,
    ownerView: command.ownerView,
    requiredFeatures: command.requiredFeatures,
    risk: command.risk,
    confirmation: command.confirmation,
    receiptKind: command.receiptKind,
  };
}

const DEFAULT_DASHBOARD_TEAM = 'default';
const DEFAULT_TEAM_LEAD = 'lead';
const DEFAULT_SPEAK_COMMAND_BUFFER = `/ask ${DEFAULT_TEAM_LEAD} `;
const SAFE_AGENT_SPEAK_COMMANDS = new Set(['ask', 'hey']);

export function initialCommandQuery(input: string): string {
  return input === '/' ? DEFAULT_SPEAK_COMMAND_BUFFER : input;
}

function parseSlashCommand(input: string): { name: string; args: string[]; raw: string } | null {
  const raw = input.trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  const name = parts.shift()?.toLowerCase();
  return name ? { name, args: parts, raw } : null;
}

function teamNameOf(agent: FleetStore['allAgents'][number]): string | undefined {
  return agent.team ?? agent.teamName;
}

export function resolveAgentTargetTeam(
  commandName: string,
  targetName: string,
  allAgents: FleetStore['allAgents'],
): { teamName?: string; error?: string } {
  const matches = allAgents.filter((a) => a.name === targetName || a.name.startsWith(`${targetName}.`));
  if (targetName === DEFAULT_TEAM_LEAD) {
    const defaultLead = matches.find((m) => teamNameOf(m) === DEFAULT_DASHBOARD_TEAM);
    if (defaultLead) return { teamName: DEFAULT_DASHBOARD_TEAM };
  }
  const distinctTeams = Array.from(new Set(matches.map(teamNameOf).filter(Boolean) as string[]));
  if (distinctTeams.length === 1) return { teamName: distinctTeams[0] };
  if (distinctTeams.length > 1) {
    return { error: `${commandName}: agent "${targetName}" exists in multiple teams (${distinctTeams.join(', ')}). Use a unique agent name or switch context first.` };
  }
  if (targetName === DEFAULT_TEAM_LEAD) return { teamName: DEFAULT_DASHBOARD_TEAM };
  return { error: `${commandName}: agent "${targetName}" not found in any team.` };
}

export function slashCommandFromQuery(query: string, store: FleetStore): Command | null {
  const parsed = parseSlashCommand(query);
  if (!parsed || !SAFE_AGENT_SPEAK_COMMANDS.has(parsed.name)) return null;
  const targetName = parsed.args[0] ?? '';
  const message = parsed.args.slice(1).join(' ').trim();
  if (!targetName || !message) return null;
  const resolved = resolveAgentTargetTeam(parsed.name, targetName, store.allAgents);
  return {
    id: `remote.${parsed.name}`,
    label: `Send /${parsed.name} to ${targetName}`,
    group: 'Agents',
    ownerView: 'dashboard',
    requiredFeatures: [],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'message',
    resourceRefs: resolved.teamName
      ? [`agent:${resolved.teamName}/${targetName}`]
      : [`agent:${targetName}`],
    keywords: 'ask hey lead message chat',
    hint: resolved.teamName ? resolved.teamName : 'route',
    run: async (c) => {
      const route = resolveAgentTargetTeam(parsed.name, targetName, c.store.allAgents);
      if (route.error) throw new Error(route.error);
      c.setStatus(`Sending /${parsed.name} to ${targetName}…`);
      await call('remote', parsed.raw, undefined, route.teamName, undefined, {
        idempotencyKey: c.command.idempotencyKey,
      });
      c.setStatus(`Sent /${parsed.name} to ${targetName}${route.teamName ? ` (${route.teamName})` : ''}`);
      c.store.refresh();
    },
  };
}

/** The full-page views the palette can jump to (kept in sync with App's NAV). */
const VIEWS: { id: string; label: string; kw?: string }[] = [
  { id: 'dashboard', label: 'Dashboard', kw: 'home overview fleet' },
  { id: 'inbox', label: 'Inbox', kw: 'messages questions' },
  { id: 'tasks', label: 'Work · Tasks', kw: 'board kanban plans schedule loops dream' },
  { id: 'projects', label: 'Projects', kw: 'repo git register' },
  { id: 'health', label: 'HR Manager · Health', kw: 'health status roster probe' },
  { id: 'identity', label: 'Identity & Keys', kw: 'wallet safe session' },
  { id: 'teams', label: 'HR Manager', kw: 'create team agent spawn org' },
  { id: 'modules', label: 'Capabilities', kw: 'skills plugins mcp' },
  { id: 'computer', label: 'Computer Use', kw: 'mac control broker' },
  { id: 'settings', label: 'Settings', kw: 'providers models inference managers update' },
];

/** Build the live command list used by the Dashboard palette and control drawer. */
export function buildCommands(store: FleetStore): Command[] {
  const cmds: Command[] = [];

  // ── Navigate ──
  for (const v of VIEWS) {
    cmds.push({
      id: `go.${v.id}`,
      label: `Go to ${v.label}`,
      group: 'Navigate',
      ownerView: v.id,
      requiredFeatures: [],
      risk: 'none',
      confirmation: 'none',
      receiptKind: 'navigation',
      keywords: v.kw,
      hint: 'view',
      run: (c) => c.navigate(v.id),
    });
  }

  // ── Control panels (slide-over) ──
  cmds.push({
    id: 'panel.quick', label: 'Open quick controls', group: 'Control', ownerView: 'dashboard',
    requiredFeatures: [], risk: 'none', confirmation: 'none', receiptKind: 'drawer',
    keywords: 'drawer panel actions', hint: 'drawer', run: (c) => c.openDrawer('quick'),
  });
  cmds.push({
    id: 'panel.plans', label: 'Manage plans', group: 'Work', ownerView: 'tasks',
    requiredFeatures: [], risk: 'none', confirmation: 'none', receiptKind: 'drawer',
    keywords: 'brain plan objective status pause work', hint: 'drawer', run: (c) => c.openDrawer('plans'),
  });
  cmds.push({
    id: 'panel.board', label: 'Manage task board', group: 'Work', ownerView: 'tasks',
    requiredFeatures: [], risk: 'none', confirmation: 'none', receiptKind: 'drawer',
    keywords: 'kanban lane dependency review backlog todo doing', hint: 'drawer', run: (c) => c.openDrawer('board'),
  });
  cmds.push({
    id: 'panel.control-center', label: 'Configure runtimes and capabilities', group: 'Control', ownerView: 'settings',
    requiredFeatures: [], risk: 'none', confirmation: 'none', receiptKind: 'drawer',
    keywords: 'provider model mcp concurrency settings', hint: 'drawer', run: (c) => c.openDrawer('control-center'),
  });

  // ── Owner-page handoffs for high-impact actions ──
  // Dashboard stays observe/talk first. The owner pages hold the richer previews for
  // project tracker writes and org hierarchy/goal rewrites; the drawer still exposes
  // advanced direct shortcuts for operators who explicitly open it.
  cmds.push({
    id: 'panel.project-driver',
    label: 'Register or sync a project',
    group: 'Projects',
    ownerView: 'projects',
    requiredFeatures: [],
    risk: 'none',
    confirmation: 'none',
    receiptKind: 'drawer',
    keywords: 'workspace import scan folder root project',
    hint: 'drawer',
    run: (c) => c.openDrawer('project-driver'),
  });
  cmds.push({
    id: 'panel.org',
    label: 'Promote or assign a team lead',
    group: 'Org',
    ownerView: 'teams',
    requiredFeatures: [],
    risk: 'none',
    confirmation: 'none',
    receiptKind: 'drawer',
    keywords: 'coordinator hierarchy lead org instructions rebuild brain',
    hint: 'drawer',
    run: (c) => c.openDrawer('org'),
  });
  cmds.push({
    id: 'panel.work-dispatch',
    label: 'Decompose and dispatch work',
    group: 'Work',
    ownerView: 'tasks',
    requiredFeatures: [],
    risk: 'none',
    confirmation: 'none',
    receiptKind: 'drawer',
    keywords: 'objective plan delegate fanout task create assignment',
    hint: 'drawer',
    run: (c) => c.openDrawer('project-driver'),
  });
  cmds.push({
    id: 'fleet.probe',
    label: 'Probe all agents (health check)',
    group: 'Fleet',
    ownerView: 'teams',
    requiredFeatures: ['observability'],
    risk: 'low',
    confirmation: 'none',
    receiptKind: 'mutation',
    resourceRefs: ['fleet'],
    keywords: 'health status ping liveness',
    run: async (c) => {
      c.setStatus('Probing every agent…');
      await call('probeAll');
      c.setStatus('Probe dispatched to all agents');
    },
  });
  cmds.push({
    id: 'fleet.refresh',
    label: 'Refresh fleet snapshot',
    group: 'Fleet',
    ownerView: 'dashboard',
    requiredFeatures: [],
    risk: 'none',
    confirmation: 'none',
    receiptKind: 'refresh',
    resourceRefs: ['fleet'],
    keywords: 'reload update poll',
    run: (c) => { c.store.refresh(); c.setStatus('Refreshed'); },
  });

  return cmds;
}

/** Cheap subsequence-aware fuzzy filter + rank over label/group/keywords. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  const scored: { c: Command; score: number }[] = [];
  for (const c of cmds) {
    const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
    let score = -1;
    if (hay.includes(q)) score = 100 - hay.indexOf(q); // contiguous match, earlier = better
    else if (subsequence(q, hay)) score = 10;          // fuzzy subsequence fallback
    if (score >= 0) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}
