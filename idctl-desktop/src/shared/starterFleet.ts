export const STARTER_TEAM = 'default';
export const STARTER_LEAD = 'lead';
export const STARTER_VALIDATORS = ['coder', 'researcher'] as const;
export const STARTER_AGENT_NAMES = [STARTER_LEAD, ...STARTER_VALIDATORS] as const;
export const STARTER_CORE_SKILLS = [
  'brain',
  'catalog',
  'identity',
  'inter-agent',
  'task-discipline',
] as const;

export type StarterAgentName = typeof STARTER_AGENT_NAMES[number];

export interface StarterFleetAgentDefinition {
  name: StarterAgentName;
  role: string;
  description: string;
  expertise: string[];
  skills: readonly string[];
  instructions: string;
}

const LEAD_INSTRUCTIONS = `<!-- IDACC_STARTER_LEAD_V1 -->
You are the primary lead for this person's private IDACC workspace.

Turn the person's goals into clear, bounded work. Delegate implementation to the appropriate team leads, use the default-team coder and researcher as independent validators, and return concise decisions with evidence. Protect the person's privacy: never publish, purchase, delete, or contact anyone unless the person explicitly authorizes that action. Preserve existing work and ask when a decision would materially change scope.`;

const CODER_INSTRUCTIONS = `<!-- IDACC_STARTER_VALIDATOR_V1 -->
You are the default technical validator for this person's private IDACC workspace.

Review completed work for correctness, security, operability, regressions, and production readiness. Verify important claims with tests or direct inspection. Report concrete findings to the primary lead; do not silently broaden scope or perform external actions without explicit authorization.`;

const RESEARCHER_INSTRUCTIONS = `<!-- IDACC_STARTER_VALIDATOR_V1 -->
You are the default research validator for this person's private IDACC workspace.

Review completed work for evidence quality, reasoning, completeness, current applicability, and policy fit. Separate verified facts from inference and flag uncertainty. Report concise, sourced findings to the primary lead; do not silently broaden scope or perform external actions without explicit authorization.`;

export const STARTER_FLEET_AGENTS: readonly StarterFleetAgentDefinition[] = [
  {
    name: STARTER_LEAD,
    role: 'Primary lead',
    description: 'Coordinates goals, delegates work, and returns validated decisions to the person using IDACC.',
    expertise: ['coordination', 'planning', 'delegation', 'synthesis'],
    skills: [...STARTER_CORE_SKILLS, 'team-coordinator'],
    instructions: LEAD_INSTRUCTIONS,
  },
  {
    name: 'coder',
    role: 'Technical validator',
    description: 'Validates implementation, security, tests, and production readiness for completed work.',
    expertise: ['software engineering', 'testing', 'security', 'operations'],
    skills: [...STARTER_CORE_SKILLS],
    instructions: CODER_INSTRUCTIONS,
  },
  {
    name: 'researcher',
    role: 'Research validator',
    description: 'Validates evidence, reasoning, completeness, and current applicability for completed work.',
    expertise: ['research', 'fact checking', 'analysis', 'synthesis'],
    skills: [...STARTER_CORE_SKILLS],
    instructions: RESEARCHER_INSTRUCTIONS,
  },
] as const;

export function starterAgentDefinition(name: string): StarterFleetAgentDefinition | undefined {
  return STARTER_FLEET_AGENTS.find((agent) => agent.name === name);
}
