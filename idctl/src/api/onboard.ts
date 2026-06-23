import type { ManagerClient, McpServerSpec } from './client.ts';
import type { ProbeResult } from './types.ts';

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface StepState {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  error?: string;
}

export interface OnboardPlan {
  name: string;
  team?: string;
  runtime?: string;
  model?: string;
  role?: string;
  expertise?: string[];
  skills?: string[];
  wallet?: boolean;
  mcpServers?: McpServerSpec[];
  probeAfter?: boolean;
  /**
   * Retry mode for post-spawn failures. Spawn is intentionally not retried
   * because it is the creation boundary.
   */
  retry?: {
    agentId: string;
    stepKeys: string[];
  };
}

export interface OnboardHooks {
  onStep?: (step: StepState, steps: StepState[]) => void;
}

export interface OnboardResult {
  agentId?: string;
  name: string;
  steps: StepState[];
  ok: boolean;
}

type StepKey = 'preflight' | 'spawn' | 'mcp' | 'rebuild' | 'probe';

export async function runOnboarding(
  baseClient: ManagerClient,
  plan: OnboardPlan,
  hooks: OnboardHooks = {},
): Promise<OnboardResult> {
  const client = plan.team ? baseClient.withTeam(plan.team) : baseClient;
  const retrying = plan.retry != null;
  const retryKeys = new Set<StepKey>((plan.retry?.stepKeys ?? []).filter(isStepKey));
  const steps: StepState[] = [];
  let agentId = plan.retry?.agentId;
  let needsRebuild = false;

  const emit = (step: StepState) => hooks.onStep?.({ ...step }, steps.map((s) => ({ ...s })));

  const run = async (
    key: StepKey,
    label: string,
    fn: () => Promise<string | void>,
    opts: { failSoft?: boolean; skip?: boolean; skipDetail?: string } = {},
  ): Promise<StepState> => {
    const step: StepState = {
      key,
      label,
      status: opts.skip ? 'skipped' : 'running',
      ...(opts.skipDetail ? { detail: opts.skipDetail } : {}),
    };
    steps.push(step);
    emit(step);
    if (opts.skip) return step;

    try {
      const detail = await fn();
      step.status = 'ok';
      if (detail) step.detail = detail;
    } catch (err) {
      step.status = 'failed';
      step.error = err instanceof Error ? err.message : String(err);
      if (!opts.failSoft) {
        emit(step);
        return step;
      }
    }
    emit(step);
    return step;
  };

  if (!retrying) {
    const preflight = await run('preflight', 'Validate name + team', async () => {
      const name = plan.name.trim();
      if (!name) throw new Error('Agent name is required.');
      const taken = (await client.agents()).some((a) => a.name === name);
      if (taken) throw new Error(`An agent named "${name}" already exists in this team.`);
    });
    if (preflight.status === 'failed') return finish();

    const spawn = await run('spawn', `Spawn ${plan.name}`, async () => {
      const res = await client.spawnAgent({
        name: plan.name.trim(),
        runtime: emptyToUndefined(plan.runtime),
        model: emptyToUndefined(plan.model),
        role: emptyToUndefined(plan.role),
        expertise: nonEmpty(plan.expertise),
        skills: nonEmpty(plan.skills),
        wallet: plan.wallet,
      });
      agentId = res.id;
      return `id ${res.id}${res.port ? ` :${res.port}` : ''}`;
    });
    if (spawn.status === 'failed' || !agentId) return finish();
  } else {
    await run('preflight', 'Validate name + team', async () => {}, {
      skip: true,
      skipDetail: 'retry mode',
    });
    await run('spawn', `Spawn ${plan.name}`, async () => {}, {
      skip: true,
      skipDetail: `already spawned (${agentId})`,
    });
  }

  if (plan.mcpServers?.length) {
    const shouldRunMcp = !retrying || retryKeys.has('mcp');
    const mcp = await run(
      'mcp',
      'Attach MCP servers',
      async () => {
        const res = await client.setAgentMcp(agentId!, plan.mcpServers!);
        needsRebuild = Boolean(res.needsRebuild);
        return `${res.mcpServers.length} server${res.mcpServers.length === 1 ? '' : 's'}`;
      },
      shouldRunMcp
        ? { failSoft: true }
        : { skip: true, skipDetail: 'not selected for retry' },
    );
    if (mcp.status === 'failed') needsRebuild = false;
  } else if (!retrying) {
    await run('mcp', 'Attach MCP servers', async () => {}, { skip: true, skipDetail: 'none selected' });
  }

  const shouldRunRebuild = needsRebuild || (retrying && retryKeys.has('rebuild'));
  if (shouldRunRebuild) {
    await run('rebuild', 'Rebuild to apply MCP', () => client.restartAgent(plan.name), { failSoft: true });
  } else if (!retrying || retryKeys.has('mcp')) {
    await run('rebuild', 'Rebuild to apply MCP', async () => {}, {
      skip: true,
      skipDetail: needsRebuild ? undefined : 'not needed',
    });
  }

  const shouldProbe = plan.probeAfter !== false && (!retrying || retryKeys.has('probe'));
  if (shouldProbe) {
    await run('probe', 'Health probe', async () => summarizeProbe(await client.probeOne(plan.name)), {
      failSoft: true,
    });
  } else if (!retrying && plan.probeAfter === false) {
    await run('probe', 'Health probe', async () => {}, { skip: true, skipDetail: 'disabled' });
  }

  return finish();

  function finish(): OnboardResult {
    return {
      agentId,
      name: plan.name,
      steps,
      ok: steps.every((s) => s.status === 'ok' || s.status === 'skipped'),
    };
  }
}

function summarizeProbe(probe: ProbeResult): string {
  const firstFailed = probe.results.find((r) => r.status !== 'ok');
  if (probe.failed > 0) throw new Error(firstFailed?.error ?? `${probe.failed} probe(s) failed`);
  return `${probe.passed}/${probe.probed} passed`;
}

function nonEmpty(values: string[] | undefined): string[] | undefined {
  const filtered = (values ?? []).map((v) => v.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isStepKey(key: string): key is StepKey {
  return key === 'preflight' || key === 'spawn' || key === 'mcp' || key === 'rebuild' || key === 'probe';
}
