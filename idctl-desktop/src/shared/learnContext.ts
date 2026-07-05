export interface LearnContextSettings {
  defaultTeam?: string;
  knownTeams?: string[];
}

export interface LearnProcessContext {
  knownTeams: string[];
  defaultTeam: string;
}

function cleanTeamName(value: unknown): string {
  return String(value || '').trim();
}

export function buildLearnProcessContext(
  settings: LearnContextSettings = {},
  liveTeams: string[] = [],
): LearnProcessContext {
  const defaultTeam = cleanTeamName(settings.defaultTeam) || 'default';
  const knownTeams = [
    defaultTeam,
    ...(Array.isArray(settings.knownTeams) ? settings.knownTeams : []),
    ...liveTeams,
  ].map(cleanTeamName).filter(Boolean);
  return {
    defaultTeam,
    knownTeams: [...new Set(knownTeams)],
  };
}
