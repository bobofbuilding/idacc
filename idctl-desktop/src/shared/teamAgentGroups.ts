export const TEAM_AGENT_GROUP_FETCH_CONCURRENCY = 3;

export type TeamAgentGroup<TAgent> = {
  team: string;
  agents: TAgent[];
};

export async function mapTeamAgentGroups<TAgent>(
  teamNames: string[],
  loadAgents: (team: string) => Promise<TAgent[]>,
  concurrency = TEAM_AGENT_GROUP_FETCH_CONCURRENCY,
): Promise<Array<TeamAgentGroup<TAgent>>> {
  const names = [...new Set(teamNames.map((name) => name.trim()).filter(Boolean))];
  const out: Array<TeamAgentGroup<TAgent>> = [];
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, names.length || 1));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const team = names[index];
      if (!team) return;
      out[index] = {
        team,
        agents: await loadAgents(team).catch(() => [] as TAgent[]),
      };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out.filter((group): group is TeamAgentGroup<TAgent> => Boolean(group));
}
