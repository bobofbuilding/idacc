const STANDARD_TEAM_ALIASES: Record<string, string> = {
  operations: 'ops-team',
  'operations-team': 'ops-team',
  engineering: 'engineering-team',
  onchain: 'onchain-execution',
  security: 'technology-security',
};

export function cleanTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Stable logical identity used only for matching; it never renames a manager team. */
export function canonicalTeamName(name: string): string {
  const cleaned = cleanTeamName(name);
  return STANDARD_TEAM_ALIASES[cleaned] ?? cleaned;
}

export function sameLogicalTeam(left: string, right: string): boolean {
  return canonicalTeamName(left) === canonicalTeamName(right);
}

/** Prefer the exact manager name, then an existing compatible alias. */
export function matchingExistingTeamName(requested: string, existingTeams: string[]): string | undefined {
  const exact = existingTeams.find((team) => cleanTeamName(team) === cleanTeamName(requested));
  return exact ?? existingTeams.find((team) => sameLogicalTeam(team, requested));
}
