// SPDX-License-Identifier: MIT
import { call, type FleetStore } from '../store.ts';

export interface ControlIntentProposal {
  commandId: string;
  title: string;
  summary: string;
  execute: () => Promise<string>;
}

function clean(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function teamLead(store: FleetStore, team: string): string {
  const roster = store.allAgents.filter((agent) => (agent.team ?? agent.teamName) === team);
  const preferred = roster.find((agent) => agent.name === `${team.replace(/-team$/, '')}-lead`)
    ?? roster.find((agent) => agent.name === 'lead')
    ?? roster.find((agent) => /(?:^|-)lead$/.test(agent.name));
  return preferred?.name ?? (team === 'default' ? 'lead' : `${team.replace(/-team$/, '')}-lead`);
}

function dispatchIntent(raw: string, store: FleetStore): ControlIntentProposal | null {
  const match = raw.match(/^\/dispatch\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+to\s+([a-z0-9_-]+))?$/i);
  if (!match) return null;
  let objective = clean(match[1] || match[2] || match[3] || '');
  let team = clean(match[4] || 'default');
  if (!match[1] && !match[2] && !match[4]) {
    const trailingTeam = objective.match(/^(.*?)\s+to\s+([a-z0-9_-]+)$/i);
    if (trailingTeam) {
      objective = clean(trailingTeam[1]);
      team = clean(trailingTeam[2]);
    }
  }
  if (!objective) return null;
  const lead = teamLead(store, team);
  return {
    commandId: 'work.dispatch',
    title: 'Decompose and dispatch work',
    summary: `Ask ${team}/${lead} to decompose “${objective}”, then create and assign the accepted task set.`,
    execute: async () => {
      const proposal = await call<{ ok?: boolean; subtasks?: unknown[]; error?: string }>('work:decompose', objective, lead, team);
      if (!proposal?.ok || !Array.isArray(proposal.subtasks) || proposal.subtasks.length === 0) {
        throw new Error(proposal?.error || 'the lead did not return a dispatchable task proposal');
      }
      const result = await call<{ created?: Array<{ ok?: boolean }>; dispatched?: number; deferred?: number }>(
        'work:createPlan', objective, proposal.subtasks, { dispatch: true, team, coordinator: lead },
      );
      return `${result.dispatched ?? 0} task(s) dispatched; ${result.deferred ?? 0} deferred by capacity or dependencies.`;
    },
  };
}

function projectIntent(raw: string): ControlIntentProposal | null {
  const match = raw.match(/^\/project\s+new\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+for\s+([a-z0-9_-]+))?$/i);
  if (!match) return null;
  let name = clean(match[1] || match[2] || match[3] || '');
  let team = clean(match[4] || 'default');
  if (!match[1] && !match[2] && !match[4]) {
    const trailingTeam = name.match(/^(.*?)\s+for\s+([a-z0-9_-]+)$/i);
    if (trailingTeam) {
      name = clean(trailingTeam[1]);
      team = clean(trailingTeam[2]);
    }
  }
  if (!name) return null;
  return {
    commandId: 'projects.sync',
    title: 'Register project',
    summary: `Create “${name}” as an active ${team} project in Manager control state.`,
    execute: async () => {
      const now = Date.now();
      const id = `project_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || now.toString(36)}_${now.toString(36)}`;
      await call('projects:save', { id, name, team, status: 'active', policy: 'balanced', createdAt: now, updatedAt: now });
      return `Project “${name}” registered for ${team}.`;
    },
  };
}

function leadIntent(raw: string): ControlIntentProposal | null {
  const match = raw.match(/^\/promote-lead\s+([a-z0-9_-]+)\s+(?:for|to)\s+([a-z0-9_-]+)$/i);
  if (!match) return null;
  const agent = clean(match[1]);
  const team = clean(match[2]);
  return {
    commandId: 'org.sync',
    title: 'Assign team lead',
    summary: `Set ${team}/${agent} as the accountable team lead and persist the organization through the Manager.`,
    execute: async () => {
      await call('coordinator:set', team, agent);
      await call('org:sync', { autoRebuild: true });
      return `${team}/${agent} is now the accountable lead; organization sync was triggered.`;
    },
  };
}

function triageIntent(raw: string, store: FleetStore): ControlIntentProposal | null {
  const match = raw.match(/^\/triage(?:\s+([a-z0-9_-]+))?$/i);
  if (!match) return null;
  const team = clean(match[1] || 'default');
  const lead = teamLead(store, team);
  return {
    commandId: 'work.dispatch',
    title: 'Triage unassigned work',
    summary: `Ask ${team}/${lead} to assign eligible unowned tasks without creating new work.`,
    execute: async () => {
      const result = await call<{ assigned?: number; skipped?: number }>('work:triage', lead, team);
      return `${result.assigned ?? 0} task(s) assigned; ${result.skipped ?? 0} left unchanged.`;
    },
  };
}

export function parseChatControlIntent(input: string, store: FleetStore): ControlIntentProposal | null {
  const raw = input.trim();
  if (!raw.startsWith('/')) return null;
  return dispatchIntent(raw, store) ?? projectIntent(raw) ?? leadIntent(raw) ?? triageIntent(raw, store);
}
