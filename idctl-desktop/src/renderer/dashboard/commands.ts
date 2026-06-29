// SPDX-License-Identifier: MIT
/**
 * Shared command registry — the single source of truth behind the Dashboard command palette
 * (⌘K) and, later, the slide-over control panels. Each command is a small descriptor whose
 * run(ctx) either navigates to a view, opens a drawer panel, or executes an IPC action.
 *
 * Because every IPC mutation flows through the brain-recording choke point in main.ts, any
 * action a command runs is automatically learned by the brain — the palette is a control
 * surface that's brain-aware for free.
 */
import type { FleetStore } from '../store.ts';
import { call } from '../store.ts';

export type Navigate = (view: string) => void;
export type OpenDrawer = (panelId: string) => void;

export interface CommandCtx {
  store: FleetStore;
  navigate: Navigate;
  openDrawer: OpenDrawer;
  /** Transient one-line feedback shown in the palette while/after a command runs. */
  setStatus: (msg: string) => void;
}

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra search terms (space-separated) so a command is findable by intent, not just label. */
  keywords?: string;
  /** Right-aligned hint (target view, shortcut, …). */
  hint?: string;
  run: (ctx: CommandCtx) => void | Promise<void>;
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
    keywords: 'ask hey lead message chat',
    hint: resolved.teamName ? resolved.teamName : 'route',
    run: async (c) => {
      const route = resolveAgentTargetTeam(parsed.name, targetName, c.store.allAgents);
      if (route.error) throw new Error(route.error);
      c.setStatus(`Sending /${parsed.name} to ${targetName}…`);
      await call('remote', parsed.raw, undefined, route.teamName);
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
  { id: 'health', label: 'Health', kw: 'status roster probe' },
  { id: 'identity', label: 'Identity & Keys', kw: 'wallet safe session' },
  { id: 'teams', label: 'HR Manager', kw: 'create team agent spawn org' },
  { id: 'modules', label: 'Capabilities', kw: 'skills plugins mcp' },
  { id: 'computer', label: 'Computer Use', kw: 'mac control broker' },
  { id: 'settings', label: 'Settings', kw: 'providers models inference managers update' },
];

/**
 * Build the live command list. Static today; later this composes per-agent / per-team /
 * per-project actions from the store so the palette covers "drive anything" end to end.
 */
export function buildCommands(store: FleetStore): Command[] {
  const cmds: Command[] = [];

  // ── Navigate ──
  for (const v of VIEWS) {
    cmds.push({ id: `go.${v.id}`, label: `Go to ${v.label}`, group: 'Navigate', keywords: v.kw, hint: 'view', run: (c) => c.navigate(v.id) });
  }

  // ── Control panels (slide-over) ──
  cmds.push({ id: 'panel.quick', label: 'Open quick controls', group: 'Control', keywords: 'drawer panel actions', hint: 'drawer', run: (c) => c.openDrawer('quick') });

  // ── Owner-page handoffs for high-impact actions ──
  // Dashboard stays observe/talk first. The owner pages hold the richer previews for
  // project tracker writes and org hierarchy/goal rewrites; the drawer still exposes
  // advanced direct shortcuts for operators who explicitly open it.
  cmds.push({
    id: 'projects.sync',
    label: 'Open Projects to sync workspace',
    group: 'Projects',
    keywords: 'register import scan folder root',
    hint: 'review',
    run: (c) => c.navigate('projects'),
  });
  cmds.push({
    id: 'org.sync',
    label: 'Open HR Manager to preview org sync',
    group: 'Org',
    keywords: 'hierarchy leads instructions rebuild brain',
    hint: 'preview',
    run: (c) => c.navigate('teams:route'),
  });
  cmds.push({
    id: 'fleet.probe',
    label: 'Probe all agents (health check)',
    group: 'Fleet',
    keywords: 'health status ping liveness',
    run: async (c) => {
      c.setStatus('Probing every agent…');
      try { await call('probeAll'); c.setStatus('Probe dispatched to all agents'); }
      catch (e) { c.setStatus(`Probe failed: ${e instanceof Error ? e.message : String(e)}`); }
    },
  });
  cmds.push({
    id: 'fleet.refresh',
    label: 'Refresh fleet snapshot',
    group: 'Fleet',
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
