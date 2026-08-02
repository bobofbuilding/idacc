import type { Agent, Team } from '../../../idctl/src/api/types.ts';

export type FleetAgent = Agent & { team?: string };

export type FleetHierarchy = {
  primary?: { team: string; agent: string } | null;
  coordinators?: Record<string, string>;
  secondaries?: Array<{ team: string; agent: string; leadsTeams?: string[] }>;
  teams?: string[];
};

export type FleetStructureGroup = { team: string; agents: FleetAgent[] };

export type FleetStructureSnapshot = {
  agents: FleetAgent[];
  groups: FleetStructureGroup[];
  teamNames: string[];
};

function cleanTeam(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function orderedTeamNames(values: Iterable<string>, primaryTeam: string): string[] {
  return Array.from(new Set(Array.from(values, cleanTeam).filter(Boolean)))
    .sort((a, b) => (
      a === primaryTeam ? -1 : b === primaryTeam ? 1 : a.localeCompare(b)
    ));
}

/**
 * Build the single roster/topology snapshot used by HR Structure, HR Manage,
 * and Dashboard Live View. Manager team rows, live agent rows, and persisted
 * hierarchy are complementary evidence: no one source is allowed to silently
 * erase a team that remains present in either of the others.
 */
export function buildFleetStructureSnapshot(input: {
  teams: Team[];
  allAgents: FleetAgent[];
  activeAgents?: Agent[];
  activeTeam?: string;
  hierarchy?: FleetHierarchy | null;
  primaryTeam?: string;
}): FleetStructureSnapshot {
  const activeTeam = cleanTeam(input.activeTeam) || 'default';
  const primaryTeam = cleanTeam(input.primaryTeam) || 'default';
  const agentsByIdentity = new Map<string, FleetAgent>();
  const sourceAgents: FleetAgent[] = [
    ...input.allAgents,
    ...(input.activeAgents ?? []).map((agent) => ({ ...agent, team: activeTeam })),
  ];
  for (const source of sourceAgents) {
    const team = cleanTeam(source.team ?? source.teamName) || activeTeam;
    const key = `${team}\u0000${source.id || source.name}`;
    const existing = agentsByIdentity.get(key);
    // The active-team row is normally the freshest view. Merge it over the
    // fleet row without discarding evidence that only the fleet endpoint has.
    agentsByIdentity.set(key, { ...existing, ...source, team });
  }
  const agents = Array.from(agentsByIdentity.values());

  const hierarchy = input.hierarchy ?? {};
  const names = new Set<string>();
  names.add(primaryTeam);
  input.teams.forEach((team) => names.add(cleanTeam(team.name)));
  agents.forEach((agent) => names.add(cleanTeam(agent.team)));
  (hierarchy.teams ?? []).forEach((team) => names.add(cleanTeam(team)));
  if (hierarchy.primary?.team) names.add(cleanTeam(hierarchy.primary.team));
  Object.keys(hierarchy.coordinators ?? {}).forEach((team) => names.add(cleanTeam(team)));
  (hierarchy.secondaries ?? []).forEach((secondary) => {
    names.add(cleanTeam(secondary.team));
    (secondary.leadsTeams ?? []).forEach((team) => names.add(cleanTeam(team)));
  });

  // The Manager seeds an empty reserved public team. Keep it out of the human
  // organization only while it truly has no roster or declared membership.
  const publicHasAgents = agents.some((agent) => cleanTeam(agent.team).toLowerCase() === 'public');
  const publicTeam = input.teams.find((team) => cleanTeam(team.name).toLowerCase() === 'public');
  const hierarchyUsesPublic = cleanTeam(hierarchy.primary?.team).toLowerCase() === 'public'
    || Object.keys(hierarchy.coordinators ?? {}).some((team) => cleanTeam(team).toLowerCase() === 'public')
    || (hierarchy.teams ?? []).some((team) => cleanTeam(team).toLowerCase() === 'public')
    || (hierarchy.secondaries ?? []).some((secondary) => (
      cleanTeam(secondary.team).toLowerCase() === 'public'
      || (secondary.leadsTeams ?? []).some((team) => cleanTeam(team).toLowerCase() === 'public')
    ));
  if (!publicHasAgents && !Number(publicTeam?.agentCount ?? 0) && !hierarchyUsesPublic) {
    for (const name of names) {
      if (name.toLowerCase() === 'public') names.delete(name);
    }
  }

  const teamNames = orderedTeamNames(names, primaryTeam);
  const groups = teamNames.map((team) => ({
    team,
    agents: agents.filter((agent) => agent.team === team),
  }));
  return { agents, groups, teamNames };
}
