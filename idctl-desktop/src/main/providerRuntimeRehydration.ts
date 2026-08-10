// SPDX-License-Identifier: MIT

/**
 * Securely reconnect Settings-owned provider lanes after the bundled Manager
 * restarts. Provider credentials stay in the desktop's encrypted settings
 * store and cross the loopback admin boundary only for this process-local
 * handoff; this report deliberately contains names and reason codes only.
 */

export interface ProviderRehydrationAgent {
  id: string;
  name: string;
  runtime?: string;
  model?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderRehydrationAssignment {
  providerName: string;
  /** Fresh, provider-reported model ids when the lane supports discovery. */
  availableModels?: string[];
  provider: {
    name: string;
    kind?: string;
    baseUrl: string;
    apiKey?: string;
  };
}

export type ProviderRehydrationReason =
  | 'provider_settings_unavailable'
  | 'provider_model_unavailable'
  | 'manager_rebind_failed'
  | 'fleet_inventory_unavailable';

export interface ProviderRehydrationIssue {
  team: string;
  agent?: string;
  provider?: string;
  model?: string;
  reason: ProviderRehydrationReason;
}

export interface ProviderRehydrationReport {
  attempted: number;
  resumed: number;
  issues: ProviderRehydrationIssue[];
}

export interface ProviderRehydrationDependencies {
  listTeams(signal?: AbortSignal): Promise<string[]>;
  listAgents(team: string, signal?: AbortSignal): Promise<ProviderRehydrationAgent[]>;
  resolveAssignment(runtime: string): ProviderRehydrationAssignment | null;
  rebindAndResume(
    team: string,
    agentId: string,
    runtime: string,
    provider: ProviderRehydrationAssignment['provider'],
    signal?: AbortSignal,
  ): Promise<{ resumed?: boolean }>;
}

export interface ProviderRehydrationSettlingDependencies {
  resume(attempt: number): Promise<ProviderRehydrationReport>;
  wait(delayMs: number): Promise<void>;
}

function abortProviderRehydration(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Provider runtime restoration was cancelled');
  error.name = 'AbortError';
  throw error;
}

function providerLaneForAgent(agent: ProviderRehydrationAgent): string | null {
  const displayRuntime = typeof agent.runtime === 'string' ? agent.runtime : '';
  if (displayRuntime.startsWith('provider:')) return displayRuntime;
  const metadataRuntime = typeof agent.metadata?.runtime === 'string'
    ? agent.metadata.runtime
    : '';
  return metadataRuntime.startsWith('provider:') ? metadataRuntime : null;
}

function providerNameFromLane(runtime: string): string {
  const encoded = runtime.slice('provider:'.length);
  try {
    return decodeURIComponent(encoded) || 'provider';
  } catch {
    return encoded || 'provider';
  }
}

export async function rehydrateManagedProviderAgents(
  deps: ProviderRehydrationDependencies,
  signal?: AbortSignal,
): Promise<ProviderRehydrationReport> {
  const report: ProviderRehydrationReport = {
    attempted: 0,
    resumed: 0,
    issues: [],
  };

  let teams: string[];
  try {
    abortProviderRehydration(signal);
    teams = [...new Set(
      (await deps.listTeams(signal))
        .map((team) => String(team || '').trim())
        .filter(Boolean),
    )];
  } catch {
    abortProviderRehydration(signal);
    report.issues.push({
      team: 'all teams',
      reason: 'fleet_inventory_unavailable',
    });
    return report;
  }

  for (const team of teams) {
    abortProviderRehydration(signal);
    let agents: ProviderRehydrationAgent[];
    try {
      agents = await deps.listAgents(team, signal);
    } catch {
      abortProviderRehydration(signal);
      report.issues.push({
        team,
        reason: 'fleet_inventory_unavailable',
      });
      continue;
    }

    for (const agent of agents) {
      abortProviderRehydration(signal);
      if (agent.metadata?.managerRestartRequested !== true) continue;
      const runtime = providerLaneForAgent(agent);
      if (!runtime) continue;

      const provider = providerNameFromLane(runtime);
      let assignment: ProviderRehydrationAssignment | null;
      try {
        assignment = deps.resolveAssignment(runtime);
      } catch {
        assignment = null;
      }
      if (!assignment) {
        report.issues.push({
          team,
          agent: agent.name,
          provider,
          reason: 'provider_settings_unavailable',
        });
        continue;
      }

      report.attempted += 1;
      const model = String(agent.model ?? '').trim();
      const availableModels = Array.isArray(assignment.availableModels)
        ? new Set(assignment.availableModels.map((candidate) => String(candidate).trim()).filter(Boolean))
        : null;
      if (model && availableModels && !availableModels.has(model)) {
        report.issues.push({
          team,
          agent: agent.name,
          provider: assignment.providerName || provider,
          model,
          reason: 'provider_model_unavailable',
        });
        continue;
      }
      try {
        const result = await deps.rebindAndResume(
          team,
          agent.id,
          runtime,
          assignment.provider,
          signal,
        );
        if (result.resumed === true) {
          report.resumed += 1;
          continue;
        }
      } catch {
        abortProviderRehydration(signal);
        // Manager/network exceptions are intentionally reduced to a stable,
        // secret-free reason code before they reach logs or the renderer.
      }
      report.issues.push({
        team,
        agent: agent.name,
        provider: assignment.providerName || provider,
        reason: 'manager_rebind_failed',
      });
    }
  }

  return report;
}

/**
 * Manager intentionally reports HTTP readiness before its bounded worker
 * restoration finishes. Poll that settling window until a provider restore
 * marker is observed; an empty early inventory is not a terminal result.
 */
export async function settleProviderRuntimeRehydration(
  deps: ProviderRehydrationSettlingDependencies,
  maxAttempts = 5,
): Promise<ProviderRehydrationReport> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let report: ProviderRehydrationReport = { attempted: 0, resumed: 0, issues: [] };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    report = await deps.resume(attempt);
    const retryable = report.issues.some((issue) => (
      issue.reason === 'manager_rebind_failed'
      || issue.reason === 'fleet_inventory_unavailable'
    ));
    const markerObserved = report.attempted > 0
      || report.issues.some((issue) => issue.agent);
    if ((markerObserved && !retryable) || attempt === attempts - 1) return report;
    await deps.wait(500 * (attempt + 1));
  }
  return report;
}

export function providerRehydrationActionMessage(report: ProviderRehydrationReport): string | null {
  if (report.issues.length === 0) return null;
  const missingModels = report.issues.filter((issue) => issue.reason === 'provider_model_unavailable');
  const affected = report.issues
    .filter((issue) => issue.agent)
    .map((issue) => `${issue.team}/${issue.agent}${issue.provider ? ` (${issue.provider})` : ''}${issue.model ? ` needs ${issue.model}` : ''}`)
    .slice(0, 8);
  const extra = report.issues.filter((issue) => issue.agent).length - affected.length;
  const affectedText = affected.length
    ? `\n\nPaused agents: ${affected.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}.`
    : '';
  return [
    'One or more API-connected agents stayed safely paused because IDACC could not restore their provider access.',
    missingModels.length
      ? 'Open Settings, reconnect and sync the affected provider, choose one of its currently installed models, then rebuild the paused agent.'
      : 'Open Settings, reconnect the affected provider, then restart or rebuild the paused agent.',
    affectedText,
  ].join(' ').trim();
}
