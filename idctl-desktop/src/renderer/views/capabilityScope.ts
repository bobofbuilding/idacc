export type CapabilityScope = 'team' | 'all' | 'leads' | 'workers';

type ScopedAgent = { name: string; team?: string };

export function capabilityScopeUsesHierarchy(scope: CapabilityScope): boolean {
  return scope === 'leads' || scope === 'workers';
}

export function agentsForCapabilityScope<T extends ScopedAgent>(
  scope: CapabilityScope,
  allAgents: T[],
  teamAgents: T[],
  coordinators: Record<string, string>,
  defaultTeam = 'default',
): T[] {
  if (scope === 'team') return teamAgents;
  if (scope === 'all') return allAgents;
  if (scope === 'leads') {
    return allAgents.filter((agent) => Boolean(agent.team) && coordinators[agent.team!] === agent.name);
  }
  const normalizedDefault = defaultTeam.trim().toLowerCase();
  return allAgents.filter((agent) => {
    const team = agent.team?.trim();
    if (!team || team.toLowerCase() === normalizedDefault) return false;
    const coordinator = coordinators[team];
    return Boolean(coordinator) && coordinator !== agent.name;
  });
}
