import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useAppCtx } from '../app/context.ts';
import { Wizard, type WizardStep } from '../components/Wizard.tsx';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme } from '../app/theme.ts';
import { runOnboarding, type OnboardPlan, type OnboardResult, type StepState } from '../api/onboard.ts';
import type { McpServerSpec } from '../api/client.ts';
import { RUNTIMES, buildRuntimeCatalog } from '../settings/runtimeCatalog.ts';
import { loadSettings } from '../settings/store.ts';
import { resolveConfigPath } from '../settings/paths.ts';
import { MCP_CATALOG, buildFromCatalog } from '../settings/mcpCatalog.ts';

type Mode = 'wizard' | 'review' | 'running' | 'done';

export function OnboardView() {
  const { store, setCapture, flash, goto } = useAppCtx();
  const [mode, setMode] = useState<Mode>('wizard');
  const [plan, setPlan] = useState<OnboardPlan | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [runSeq, setRunSeq] = useState(0);
  const [retryStepKeys, setRetryStepKeys] = useState<string[] | null>(null);
  const ranSeq = useRef<number | null>(null);

  const settings = useMemo(() => loadSettings(resolveConfigPath()), []);
  const models = useMemo(() => buildRuntimeCatalog(settings.providers ?? []), [settings.providers]);
  const currentTeam = store.team;

  const wizardSteps = useMemo<WizardStep[]>(() => {
    const runtimeChoices = RUNTIMES.map((runtime) => ({ label: runtime, value: runtime }));
    const runtime = runtimeChoices[0]?.value ?? 'codex';
    const attachableMcp = MCP_CATALOG.filter((entry) => !(entry.inputs ?? []).some((input) => input.required && !input.default));
    const modelChoices = Array.from(new Set(Object.values(models).flat()))
      .slice(0, 40)
      .map((model) => ({ label: model, value: model }));
    const teamChoices = [
      { label: currentTeam ? `${currentTeam} (current)` : 'current team', value: currentTeam ?? '' },
      ...store.teams.filter((t) => t.name !== currentTeam).map((t) => ({ label: t.name, value: t.name })),
    ];
    return [
      { key: 'name', label: 'Agent name', type: 'text', placeholder: 'builder-1' },
      { key: 'team', label: 'Team', type: 'choice', choices: teamChoices },
      { key: 'runtime', label: 'Runtime', type: 'choice', choices: runtimeChoices, initial: runtime },
      {
        key: 'model',
        label: 'Model',
        type: modelChoices.length ? 'choice' : 'text',
        choices: modelChoices,
        placeholder: 'model id',
        optional: true,
      },
      { key: 'role', label: 'Role', type: 'text', placeholder: 'building agent', optional: true },
      { key: 'expertise', label: 'Expertise (comma-separated)', type: 'text', optional: true },
      { key: 'skills', label: 'Skills (comma-separated)', type: 'text', optional: true },
      {
        key: 'mcp',
        label: 'MCP server',
        type: 'choice',
        choices: [
          { label: 'none', value: '' },
          ...attachableMcp.map((entry) => ({ label: entry.name, value: entry.id, hint: entry.description })),
        ],
      },
      {
        key: 'wallet',
        label: 'Provision OWS wallet',
        type: 'choice',
        choices: [
          { label: 'no', value: 'no' },
          { label: 'yes', value: 'yes' },
        ],
      },
    ];
  }, [currentTeam, models, store.teams]);

  useEffect(() => {
    setCapture(mode === 'wizard' || mode === 'review' || mode === 'running');
    return () => setCapture(false);
  }, [mode, setCapture]);

  useEffect(() => {
    if (mode !== 'running' || !plan || ranSeq.current === runSeq) return;
    ranSeq.current = runSeq;
    let alive = true;
    const retry =
      retryStepKeys && result?.agentId
        ? { agentId: result.agentId, stepKeys: retryStepKeys }
        : undefined;

    setSteps([]);
    setResult(null);
    runOnboarding(
      store.client,
      { ...plan, retry },
      {
        onStep: (_step, all) => {
          if (alive) setSteps(all);
        },
      },
    )
      .then((res) => {
        if (!alive) return;
        setResult(res);
        setSteps(res.steps);
        setMode('done');
        store.refresh();
        flash(res.ok ? `onboarded ${res.name}` : `onboarding finished with failed steps`, res.ok ? 'ok' : 'err');
      })
      .catch((err) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setResult({ name: plan.name, steps, ok: false });
        setMode('done');
        flash(`onboarding failed: ${message}`, 'err');
      });
    return () => {
      alive = false;
    };
    // steps is intentionally omitted; this effect owns the current run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, plan, retryStepKeys, runSeq, store.client]);

  useInput(
    (input, key) => {
      if (mode === 'review') {
        if (key.escape) setMode('wizard');
        else if (key.return || input === 'r') startRun(null);
      } else if (mode === 'done') {
        if (input === 'n') reset();
        else if (input === 'h') goto('health');
        else if (input === 'r') {
          const failed = (result?.steps ?? []).filter((s) => s.status === 'failed').map((s) => s.key);
          if (failed.length && result?.agentId) startRun(failed);
        }
      }
    },
    { isActive: mode !== 'wizard' && mode !== 'running' },
  );

  if (mode === 'wizard') {
    return (
      <Wizard
        title="Onboard agent"
        steps={wizardSteps}
        onCancel={reset}
        onSubmit={(values) => {
          setPlan(planFromValues(values));
          setMode('review');
        }}
      />
    );
  }

  if (!plan) return <Text color={theme.dim}>No onboarding plan.</Text>;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Onboard agent
      </Text>
      <PlanSummary plan={plan} />
      {mode === 'review' ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.dim}>Enter run · r run · Esc edit</Text>
        </Box>
      ) : null}
      {mode === 'running' || mode === 'done' ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.accentAlt}>
            Progress
          </Text>
          <Checklist steps={steps} />
          {mode === 'running' ? <Text color={theme.dim}><Spinner type="dots" /> running onboarding…</Text> : null}
          {mode === 'done' ? (
            <DoneActions
              result={result}
              onAction={(action) => {
                if (action === 'new') reset();
                else if (action === 'health') goto('health');
                else if (action === 'retry') {
                  const failed = (result?.steps ?? []).filter((s) => s.status === 'failed').map((s) => s.key);
                  if (failed.length && result?.agentId) startRun(failed);
                }
              }}
            />
          ) : null}
        </Box>
      ) : null}
    </Box>
  );

  function planFromValues(values: Record<string, string>): OnboardPlan {
    const mcpServers = mcpFromChoice(values.mcp);
    return {
      name: values.name.trim(),
      team: values.team || undefined,
      runtime: values.runtime || undefined,
      model: values.model || undefined,
      role: values.role || undefined,
      expertise: splitList(values.expertise),
      skills: splitList(values.skills),
      wallet: values.wallet === 'yes',
      mcpServers,
      probeAfter: true,
    };
  }

  function startRun(failedKeys: string[] | null) {
    setRetryStepKeys(failedKeys);
    setRunSeq((n) => n + 1);
    setMode('running');
  }

  function reset() {
    setMode('wizard');
    setPlan(null);
    setSteps([]);
    setResult(null);
    setRetryStepKeys(null);
  }
}

function PlanSummary({ plan }: { plan: OnboardPlan }) {
  const mcp = plan.mcpServers?.map((s) => s.name).join(', ') || 'none';
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{plan.name || '(unnamed)'}</Text>
        <Text color={theme.dim}> · team {plan.team ?? 'current'} · {plan.runtime ?? 'default'} · {plan.model ?? 'default'}</Text>
      </Text>
      <Text color={theme.dim}>
        role {plan.role || 'none'} · expertise {plan.expertise?.join(', ') || 'none'} · skills {plan.skills?.join(', ') || 'none'}
      </Text>
      <Text color={theme.dim}>MCP {mcp} · wallet {plan.wallet ? 'yes' : 'no'} · health probe yes</Text>
    </Box>
  );
}

function Checklist({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return <Text color={theme.dim}>(waiting to start)</Text>;
  return (
    <Box flexDirection="column">
      {steps.map((step) => (
        <Text key={step.key}>
          <Text color={statusColor(step.status)}>{statusMark(step.status)}</Text> {step.label}
          {step.detail ? <Text color={theme.dim}> · {step.detail}</Text> : null}
          {step.error ? <Text color={theme.err}> · {step.error}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function DoneActions({ result, onAction }: { result: OnboardResult | null; onAction: (action: string) => void }) {
  const failed = result?.steps.filter((s) => s.status === 'failed') ?? [];
  const canRetry = failed.length > 0 && Boolean(result?.agentId);
  const items: SelectItem<string>[] = [
    ...(canRetry ? [{ key: 'retry', label: 'Retry failed steps', value: 'retry' }] : []),
    { key: 'new', label: 'Onboard another agent', value: 'new' },
    { key: 'health', label: 'Open Health', value: 'health' },
  ];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={result?.ok ? theme.ok : theme.warn}>
        {result?.ok ? 'Onboarding complete.' : 'Onboarding finished with failed steps.'}
      </Text>
      <Text color={theme.dim}>
        Enter select · {canRetry ? 'r retry failed · ' : ''}n new · h health
      </Text>
      <Select items={items} onSelect={(item) => onAction(item.value)} />
    </Box>
  );
}

function mcpFromChoice(id: string | undefined): McpServerSpec[] | undefined {
  if (!id) return undefined;
  const entry = MCP_CATALOG.find((item) => item.id === id);
  if (!entry || entry.inputs?.some((input) => input.required && !input.default)) return undefined;
  const profile = buildFromCatalog(entry, entry.id, {});
  const { enabled: _enabled, ...server } = profile;
  return [server];
}

function splitList(value: string | undefined): string[] | undefined {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function statusMark(status: StepState['status']): string {
  if (status === 'running') return '…';
  if (status === 'ok') return '✓';
  if (status === 'failed') return '✗';
  return '-';
}

function statusColor(status: StepState['status']): string {
  if (status === 'ok') return theme.ok;
  if (status === 'failed') return theme.err;
  if (status === 'running') return theme.warn;
  return theme.dim;
}
