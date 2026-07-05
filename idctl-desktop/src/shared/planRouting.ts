export interface PlanRoutingTeamLead {
  team: string;
  lead: string | null;
  activeCount: number;
  totalCount: number;
}

export interface PlanRoutingAgent {
  name: string;
  status?: string;
  team?: string;
}

export type PrimaryLeadReadiness = { ok: true } | { ok: false; reason: string };

export function agentIsLive(status?: string): boolean {
  return !!status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(status);
}

export function primaryLeadReadiness(
  lead: string,
  leadTeam: string,
  teamLeads: PlanRoutingTeamLead[],
  localAgents: PlanRoutingAgent[],
  fallbackTeam = 'default',
): PrimaryLeadReadiness {
  const teamLead = teamLeads.find((row) => row.team === leadTeam);
  if (teamLead?.lead === lead) return { ok: true };

  const local = localAgents.find((agent) => agent.name === lead && (agent.team ?? fallbackTeam) === leadTeam);
  if (local && agentIsLive(local.status)) return { ok: true };

  if (teamLead) {
    if (!teamLead.activeCount) {
      return { ok: false, reason: `${leadTeam}/${lead} is not running (${teamLead.totalCount || 0} agent rows, 0 active)` };
    }
    return { ok: false, reason: `${leadTeam}/${lead} is not the active lead; active lead is ${teamLead.lead || 'unknown'} with ${teamLead.activeCount} active agent(s)` };
  }

  return { ok: false, reason: `${leadTeam}/${lead} could not be resolved from the live manager roster` };
}
