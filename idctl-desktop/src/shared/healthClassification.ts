import type { Agent } from '../../../idctl/src/api/types.ts';

export type AgentAvailability = 'running' | 'transitional' | 'stopped' | 'unknown';

const RUNNING_STATES = new Set([
  'active',
  'busy',
  'healthy',
  'idle',
  'ok',
  'online',
  'ready',
  'running',
  'up',
  'working',
]);
const TRANSITIONAL_STATES = new Set([
  'pending',
  'processing',
  'rebuilding',
  'restarting',
  'starting',
  'stopping',
]);
const STOPPED_STATES = new Set([
  'crashed',
  'dead',
  'disabled',
  'down',
  'error',
  'exited',
  'failed',
  'offline',
  'sleeping',
  'stopped',
]);

function normalizedState(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
}

/**
 * Classify Manager agent availability without treating an unfamiliar status
 * string or a stale PID as proof that the process is running. Explicit
 * negative health wins; a remote fallback requires two fresh probe timestamps.
 */
export function classifyAgentAvailability(
  agent: Partial<Pick<Agent, 'status' | 'health' | 'pid' | 'deploymentShape' | 'last_seen' | 'last_probed_at' | 'consecutive_failures'>>,
  now = Date.now(),
): AgentAvailability {
  const status = normalizedState(agent.status);
  const health = normalizedState(agent.health);
  // Explicit negative structured evidence always wins over an optimistic
  // lifecycle label. This prevents `status=running, health=offline` from being
  // presented or probed as healthy.
  if (STOPPED_STATES.has(status) || STOPPED_STATES.has(health)) return 'stopped';
  if (TRANSITIONAL_STATES.has(status) || TRANSITIONAL_STATES.has(health)) return 'transitional';
  if (RUNNING_STATES.has(status) || RUNNING_STATES.has(health)) return 'running';

  const lastSeen = Number(agent.last_seen ?? 0);
  const lastSeenMs = lastSeen < 10_000_000_000 ? lastSeen * 1000 : lastSeen;
  const lastProbed = Number(agent.last_probed_at ?? 0);
  const lastProbedMs = lastProbed < 10_000_000_000 ? lastProbed * 1000 : lastProbed;
  if (
    agent.deploymentShape === 'remote-endpoint'
    && Number(agent.consecutive_failures ?? 0) === 0
    && Number.isFinite(lastSeen)
    && Number.isFinite(lastProbed)
    && lastSeen > 0
    && lastProbed > 0
    && lastSeenMs <= now
    && lastProbedMs <= now
    && now - lastSeenMs <= 15 * 60_000
    && now - lastProbedMs <= 15 * 60_000
  ) {
    return 'running';
  }

  return 'unknown';
}

export function isAgentProbeEligible(
  agent: Partial<Pick<Agent, 'status' | 'health' | 'pid' | 'deploymentShape' | 'last_seen' | 'last_probed_at' | 'consecutive_failures'>>,
  now = Date.now(),
): boolean {
  return classifyAgentAvailability(agent, now) === 'running';
}

export type ThroughputClassification = 'fresh-harness-sample' | 'harness-24h-average' | 'no-harness-telemetry';

export function classifyThroughputSample(
  recentTps: number | null | undefined,
  recentAt: number | null | undefined,
  dayCount: number,
  now = Date.now(),
  freshMs = 15 * 60_000,
): ThroughputClassification {
  if (
    recentTps != null
    && Number.isFinite(recentTps)
    && recentTps >= 0
    && recentAt != null
    && Number.isFinite(recentAt)
    && recentAt > 0
    && recentAt <= now
    && now - recentAt <= freshMs
  ) {
    return 'fresh-harness-sample';
  }
  return dayCount > 0 ? 'harness-24h-average' : 'no-harness-telemetry';
}
