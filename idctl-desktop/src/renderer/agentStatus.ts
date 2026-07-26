import type { Agent } from '../../../idctl/src/api/types.ts';
import { classifyAgentAvailability } from '../shared/healthClassification.ts';

export type AgentStatusClass = 'ok' | 'warn' | 'err';

type AgentStatusEvidence = Partial<Pick<Agent, 'status' | 'health' | 'pid' | 'deploymentShape' | 'last_seen' | 'consecutive_failures'>>;

export function statusClass(statusOrAgent?: string | AgentStatusEvidence): AgentStatusClass {
  const evidence = typeof statusOrAgent === 'string' ? { status: statusOrAgent } : statusOrAgent ?? {};
  const state = classifyAgentAvailability(evidence);
  if (state === 'running') return 'ok';
  if (state === 'stopped') return 'err';
  // Transitional and unknown states are deliberately review-colored. Only an
  // explicit stopped lifecycle state should be rendered as a hard failure.
  return 'warn';
}

export function isAgentLive(statusOrAgent?: string | AgentStatusEvidence): boolean {
  return statusClass(statusOrAgent) === 'ok';
}
