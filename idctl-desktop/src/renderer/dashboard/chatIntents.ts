// SPDX-License-Identifier: MIT
import { call, type FleetStore } from '../store.ts';
import type {
  CommandMetadata,
  CommandOperationContext,
  CommandOutcome,
} from './commandRuntime.ts';

export interface ControlIntentProposal extends CommandMetadata {
  title: string;
  summary: string;
  resourceRefs: string[];
  execute: (context: CommandOperationContext) => Promise<{
    message: string;
    outcome?: CommandOutcome;
  }>;
}

export const CHAT_CONTROL_INTENT_USAGE = [
  '/dispatch "objective" to team',
  '/project new "name" for team',
  '/promote-lead agent for team',
  '/triage team',
].join(' · ');

/** Recognize the reserved Dashboard mutation namespace even when syntax is invalid. */
export function isChatControlIntentCandidate(input: string): boolean {
  return /^\/(?:dispatch|project|promote-lead|triage)\b/i.test(input.trim());
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
    commandId: 'chat.work.dispatch',
    ownerView: 'tasks',
    requiredFeatures: ['control-state'],
    risk: 'high',
    confirmation: 'required',
    receiptKind: 'mutation',
    title: 'Decompose and dispatch work',
    summary: `Ask ${team}/${lead} to decompose “${objective}”, then create and assign the accepted task set.`,
    resourceRefs: [`team:${team}`, `agent:${team}/${lead}`],
    execute: async ({ idempotencyKey }) => {
      const proposal = await call<{ ok?: boolean; subtasks?: unknown[]; error?: string }>('work:decompose', objective, lead, team);
      if (!proposal?.ok || !Array.isArray(proposal.subtasks) || proposal.subtasks.length === 0) {
        throw new Error(proposal?.error || 'the lead did not return a dispatchable task proposal');
      }
      const result = await call<{ created?: Array<{ ok?: boolean }>; dispatched?: number; deferred?: number }>(
        'work:createPlan', objective, proposal.subtasks, {
          dispatch: true,
          team,
          coordinator: lead,
          idempotencyKey,
        },
      );
      const deferred = result.deferred ?? 0;
      return {
        message: `${result.dispatched ?? 0} task(s) dispatched; ${deferred} deferred by capacity or dependencies.`,
        outcome: deferred
          ? {
            state: 'deferred',
            resourceRefs: [`team:${team}`, `dispatch:${idempotencyKey}`],
            recovery: 'Open Work to review deferred capacity or dependency gates.',
          }
          : {
            state: 'succeeded',
            resourceRefs: [`team:${team}`, `dispatch:${idempotencyKey}`],
          },
      };
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
    commandId: 'chat.projects.create',
    ownerView: 'projects',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
    title: 'Register project',
    summary: `Create “${name}” as an active ${team} project in Manager control state.`,
    resourceRefs: [`team:${team}`, `project-name:${name}`],
    execute: async ({ idempotencyKey }) => {
      const now = Date.now();
      const stableAttempt = idempotencyKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(-20);
      const id = `project_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'new'}_${stableAttempt}`;
      await call('projects:save', { id, name, team, status: 'active', policy: 'balanced', createdAt: now, updatedAt: now });
      return {
        message: `Project “${name}” registered for ${team}.`,
        outcome: { state: 'succeeded', resourceRefs: [`project:${id}`, `team:${team}`] },
      };
    },
  };
}

function leadIntent(raw: string): ControlIntentProposal | null {
  const match = raw.match(/^\/promote-lead\s+([a-z0-9_-]+)\s+(?:for|to)\s+([a-z0-9_-]+)$/i);
  if (!match) return null;
  const agent = clean(match[1]);
  const team = clean(match[2]);
  return {
    commandId: 'chat.org.assign-lead',
    ownerView: 'teams',
    requiredFeatures: ['control-state'],
    risk: 'high',
    confirmation: 'required',
    receiptKind: 'mutation',
    title: 'Assign team lead',
    summary: `Set ${team}/${agent} as the accountable team lead and persist the organization through the Manager.`,
    resourceRefs: [`team:${team}`, `agent:${team}/${agent}`],
    execute: async ({ idempotencyKey }) => {
      await call('coordinator:set', team, agent);
      await call('org:sync', { autoRebuild: true, idempotencyKey });
      return {
        message: `${team}/${agent} is now the accountable lead; organization sync was triggered.`,
        outcome: {
          state: 'succeeded',
          resourceRefs: [`team:${team}`, `agent:${team}/${agent}`],
        },
      };
    },
  };
}

function triageIntent(raw: string, store: FleetStore): ControlIntentProposal | null {
  const match = raw.match(/^\/triage(?:\s+([a-z0-9_-]+))?$/i);
  if (!match) return null;
  const team = clean(match[1] || 'default');
  const lead = teamLead(store, team);
  return {
    commandId: 'chat.work.triage',
    ownerView: 'tasks',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
    title: 'Triage unassigned work',
    summary: `Ask ${team}/${lead} to assign eligible unowned tasks without creating new work.`,
    resourceRefs: [`team:${team}`, `agent:${team}/${lead}`],
    execute: async () => {
      const result = await call<{ assigned?: number; skipped?: number }>('work:triage', lead, team);
      return {
        message: `${result.assigned ?? 0} task(s) assigned; ${result.skipped ?? 0} left unchanged.`,
        outcome: { state: 'succeeded', resourceRefs: [`team:${team}`] },
      };
    },
  };
}

export function parseChatControlIntent(input: string, store: FleetStore): ControlIntentProposal | null {
  const raw = input.trim();
  if (!raw.startsWith('/')) return null;
  return dispatchIntent(raw, store) ?? projectIntent(raw) ?? leadIntent(raw) ?? triageIntent(raw, store);
}
