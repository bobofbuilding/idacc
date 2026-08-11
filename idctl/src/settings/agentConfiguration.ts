import type { Agent } from '../api/types.ts';
import { normalizeSpeedPreference } from './runtimeCatalog.ts';

type ConfigurationAgent = Pick<Agent, 'runtime' | 'metadata'>;

/**
 * Return the exact durable speed value used by Manager compare-and-set checks.
 * An absent value is stored as an empty string even though the UI presents it
 * as Standard/default.
 */
export function storedAgentSpeed(agent: Pick<Agent, 'metadata'>): string {
  const speed = agent.metadata?.speed;
  return typeof speed === 'string' ? speed : '';
}

/** Bind the durable value to the safe two-option UI representation. */
export function effectiveAgentSpeed(agent: Pick<Agent, 'metadata'>): 'default' | 'fast' {
  return normalizeSpeedPreference(storedAgentSpeed(agent));
}

/**
 * Provider-backed agents persist their operator-facing lane in metadata while
 * the runtime column contains the internal provider-api harness. Mirror the
 * Manager's configuration snapshot so stale-write checks compare like values.
 */
export function agentConfigurationRuntime(agent: ConfigurationAgent): string | undefined {
  const metadataRuntime = typeof agent.metadata?.runtime === 'string'
    ? agent.metadata.runtime
    : undefined;
  return metadataRuntime?.startsWith('provider:')
    ? metadataRuntime
    : agent.runtime ?? metadataRuntime;
}
