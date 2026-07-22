export type AgentModelProfile = 'frontier' | 'balanced' | 'fast';

export type AgentModelRecommendationInput = {
  runtime?: string;
  models: string[];
  name?: string;
  role?: string;
  description?: string;
  lead?: boolean;
};

const FRONTIER_ROLE = /\b(lead|coordinator|architect(?:ure)?|research(?:er|ing)?|analyst|audit(?:or|ing)?|security|counsel|fact[- ]?check(?:er|ing)?|qa|quality|risk|strateg(?:y|ic|ist)?|planner|validation|verification)\b/i;
const FAST_ROLE = /\b(monitor(?:s|ing)?|maintain(?:er|ing|ance)?|moderat(?:or|ion|ing)|content|writ(?:er|ing)|assistant|support|schedul(?:er|ing)|triage|router|routing)\b/i;

function token(model: string, value: string): boolean {
  return new RegExp(`(^|[-_/.:])${value}($|[-_/.:])`, 'i').test(model);
}

function modelTier(model: string): AgentModelProfile | 'unknown' {
  if (
    token(model, 'sol')
    || token(model, 'opus')
    || token(model, 'pro')
    || token(model, 'max')
    || token(model, 'ultra')
    || token(model, 'large')
  ) return 'frontier';
  if (
    token(model, 'luna')
    || token(model, 'haiku')
    || /flash[-_.:/]?lite/i.test(model)
    || token(model, 'mini')
    || token(model, 'lite')
    || token(model, 'small')
  ) return 'fast';
  if (
    token(model, 'terra')
    || token(model, 'sonnet')
    || token(model, 'flash')
    || token(model, 'standard')
    || token(model, 'medium')
    || token(model, 'composer')
  ) return 'balanced';
  return 'unknown';
}

export function agentModelProfile(input: Omit<AgentModelRecommendationInput, 'runtime' | 'models'>): AgentModelProfile {
  const responsibility = [input.name, input.role, input.description].filter(Boolean).join(' ');
  if (input.lead || FRONTIER_ROLE.test(responsibility)) return 'frontier';
  if (FAST_ROLE.test(responsibility)) return 'fast';
  return 'balanced';
}

/**
 * Select an explicit model from the runtime's live/curated catalog. Catalog order
 * remains the fallback for providers whose model names do not expose a useful tier.
 */
export function recommendAgentModel(input: AgentModelRecommendationInput): string {
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
  if (!models.length) return '';
  const profile = agentModelProfile(input);
  const tierPriority: Record<AgentModelProfile, Record<AgentModelProfile | 'unknown', number>> = {
    frontier: { frontier: 300, balanced: 200, fast: 100, unknown: 0 },
    balanced: { frontier: 220, balanced: 300, fast: 180, unknown: 0 },
    fast: { frontier: 120, balanced: 220, fast: 300, unknown: 0 },
  };
  return models
    .map((model, index) => ({ model, index, score: tierPriority[profile][modelTier(model)] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].model;
}
