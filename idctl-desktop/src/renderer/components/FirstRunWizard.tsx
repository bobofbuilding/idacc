import { useEffect, useMemo, useState } from 'react';
import { call } from '../store.ts';
import type {
  ConsumerOnboardingStatus,
  OnboardingAssignment,
} from '../../shared/consumerOnboarding.ts';
import {
  resolveSubscriptionAction,
  type SubscriptionActionResult,
} from '../../shared/subscriptionAction.ts';

type ProviderKind = 'ollama' | 'lmstudio' | 'openai-compatible' | 'anthropic' | 'openai';

const PROVIDER_DEFAULTS: Record<ProviderKind, { name: string; baseUrl: string }> = {
  ollama: { name: 'local-ollama', baseUrl: 'http://127.0.0.1:11434' },
  lmstudio: { name: 'local-lm-studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  'openai-compatible': { name: 'compatible-api', baseUrl: 'http://127.0.0.1:8000/v1' },
  anthropic: { name: 'anthropic-api', baseUrl: 'https://api.anthropic.com' },
  openai: { name: 'openai-api', baseUrl: 'https://api.openai.com/v1' },
};

function gateLabel(key: keyof ConsumerOnboardingStatus['gates']): string {
  switch (key) {
    case 'stack': return 'Bundled services';
    case 'assignment': return 'Verified model routes';
    case 'roster': return 'Starter team';
    case 'hierarchy': return 'Team coordination';
    case 'agents': return 'Agent health';
    case 'instructions': return 'Starter responsibilities';
    case 'capabilities': return 'Brain & core skills';
  }
}

export function FirstRunWizard({
  status,
  open,
  onStatus,
  onClose,
}: {
  status: ConsumerOnboardingStatus | null;
  open: boolean;
  onStatus: (status: ConsumerOnboardingStatus) => void;
  onClose: () => void;
}) {
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [providerKind, setProviderKind] = useState<ProviderKind>('ollama');
  const [providerName, setProviderName] = useState(PROVIDER_DEFAULTS.ollama.name);
  const [providerUrl, setProviderUrl] = useState(PROVIDER_DEFAULTS.ollama.baseUrl);
  const [providerKey, setProviderKey] = useState('');

  const selectedOption = useMemo(
    () => status?.assignments.find((option) => option.runtime === runtime),
    [runtime, status?.assignments],
  );

  useEffect(() => {
    if (!status?.assignments.length) {
      setRuntime('');
      setModel('');
      return;
    }
    const preferred = status.state.selectedAssignment?.runtime;
    const next = status.assignments.some((option) => option.runtime === runtime)
      ? runtime
      : status.assignments.find((option) => option.runtime === preferred)?.runtime
        ?? status.assignments[0].runtime;
    if (next !== runtime) setRuntime(next);
  }, [runtime, status?.assignments, status?.state.selectedAssignment?.runtime]);

  useEffect(() => {
    if (!selectedOption) {
      setModel('');
      return;
    }
    if (model && selectedOption.models.includes(model)) return;
    const preferred = status?.state.selectedAssignment?.runtime === selectedOption.runtime
      ? status.state.selectedAssignment.model
      : '';
    setModel(preferred && selectedOption.models.includes(preferred) ? preferred : selectedOption.models[0] ?? '');
  }, [model, selectedOption, status?.state.selectedAssignment]);

  async function refresh() {
    setBusy('refresh');
    setMessage('');
    try {
      onStatus(await call<ConsumerOnboardingStatus>('onboarding:status', { force: true }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  async function manageSubscription(provider: string, action: 'signin' | 'install') {
    setBusy(`${action}:${provider}`);
    setMessage('');
    try {
      const result = await call<SubscriptionActionResult>(`subs:${action}`, provider);
      const resolution = resolveSubscriptionAction(action, result);
      if (resolution.kind === 'manual') {
        let copied = false;
        try {
          await navigator.clipboard.writeText(resolution.command);
          copied = true;
        } catch {
          // Clipboard access is best-effort; the command remains visible below.
        }
        setMessage(
          `${resolution.message}${copied ? '; it was copied to your clipboard.' : ':'} ${resolution.command}`,
        );
      } else {
        setMessage(resolution.message);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  function selectProviderKind(kind: ProviderKind) {
    setProviderKind(kind);
    setProviderName(PROVIDER_DEFAULTS[kind].name);
    setProviderUrl(PROVIDER_DEFAULTS[kind].baseUrl);
    setProviderKey('');
  }

  async function connectProvider() {
    setBusy('provider');
    setMessage('');
    try {
      const result = await call<{ status: ConsumerOnboardingStatus }>('onboarding:configureProvider', {
        name: providerName,
        kind: providerKind,
        baseUrl: providerUrl,
        ...(providerKey.trim() ? { apiKey: providerKey.trim() } : {}),
      });
      onStatus(result.status);
      setMessage('Provider connected and its live model catalog is ready.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderKey('');
      setBusy('');
    }
  }

  async function createStarterTeam() {
    if (!runtime || (selectedOption?.requiresModel && !model)) return;
    setBusy('fleet');
    setMessage('');
    try {
      const assignment: OnboardingAssignment = { runtime, ...(model ? { model } : {}) };
      const next = await call<ConsumerOnboardingStatus>('onboarding:runStarterFleet', assignment);
      onStatus(next);
      setMessage(next.currentReady
        ? 'Your private starter workspace is ready.'
        : next.issues[0] || 'Setup needs another pass.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  async function defer() {
    setBusy('defer');
    setMessage('');
    try {
      const next = await call<ConsumerOnboardingStatus>('onboarding:defer');
      onStatus(next);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  async function resume() {
    setBusy('resume');
    setMessage('');
    try {
      onStatus(await call<ConsumerOnboardingStatus>('onboarding:resume'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  if (!open || !status) return null;
  const working = Boolean(busy);
  const setupFinished = status.phase === 'ready';
  const canClose = setupFinished || status.phase === 'limited' || status.phase === 'degraded';

  return (
    <div className="modal-overlay onboarding-overlay">
      <div className="modal onboard-modal onboarding-wizard" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-heading">
          <div>
            <div className="eyebrow">Private workspace setup</div>
            <div className="modal-title" id="onboarding-title">
              {status.phase === 'preparing'
                ? 'Preparing IDACC'
                : setupFinished
                  ? 'Your workspace is ready'
                  : status.phase === 'degraded'
                    ? 'Your workspace needs attention'
                    : 'Choose how your agents think'}
            </div>
          </div>
          {canClose ? <button className="icon-btn" aria-label="Close setup" onClick={onClose}>×</button> : null}
        </div>

        <p className="muted onboarding-intro">
          IDACC includes its Agent manager and Brain. Your goals, memory, projects, credentials, and agent work stay in this private profile and are not bundled into application updates.
        </p>

        <div className="unified-stack-services">
          {status.services.map((service) => (
            <div className="unified-stack-service" key={service.name}>
              <span className={service.healthy ? 'dot live' : service.bundled ? 'dot busy' : 'dot dead'} />
              <strong>{service.name === 'brain' ? 'Brain' : 'Agent manager'}</strong>
              <span className="muted">{service.healthy ? 'ready' : service.error || (service.bundled ? 'starting…' : 'not included')}</span>
            </div>
          ))}
        </div>

        {status.phase === 'preparing' ? (
          <>
            <div className="onboarding-wait">
              <span className="spinner" aria-hidden="true" />
              <span>
                The app will continue when both bundled services are healthy. If startup does
                not recover, limited mode keeps Settings and diagnostics available.
              </span>
            </div>
            <div className="row end gap onboarding-actions">
              <button className="btn" disabled={working} onClick={() => void defer()}>
                {busy === 'defer' ? 'Opening…' : 'Continue in limited mode'}
              </button>
              <button className="btn primary" disabled={working} onClick={() => void refresh()}>
                {busy === 'refresh' ? 'Checking…' : 'Re-check services'}
              </button>
            </div>
          </>
        ) : (
          <>
            {status.phase === 'limited' ? (
              <div className="onboarding-notice">
                Limited mode is active. Existing screens remain available, but the starter team is not yet guaranteed to work.
                <button className="btn small" disabled={working} onClick={() => void resume()}>Continue setup</button>
              </div>
            ) : null}

            {!setupFinished ? (
              <section className="onboarding-section">
                <div className="onboarding-section-title">
                  <span className="onboarding-step">1</span>
                  <div><strong>Connect a model route</strong><div className="muted small">Use an existing subscription, local model server, or API provider.</div></div>
                </div>

                <div className="onboarding-runtime-row">
                  <label>
                    Route
                    <select value={runtime} onChange={(event) => setRuntime(event.target.value)} disabled={working || !status.assignments.length}>
                      {!status.assignments.length ? <option value="">No verified routes yet</option> : null}
                      {status.assignments.map((option) => <option value={option.runtime} key={option.runtime}>{option.label}</option>)}
                    </select>
                  </label>
                  <label>
                    Model
                    <select value={model} onChange={(event) => setModel(event.target.value)} disabled={working || !selectedOption?.models.length}>
                      {!selectedOption?.models.length ? <option value="">Account default</option> : null}
                      {selectedOption?.models.map((name) => <option value={name} key={name}>{name}</option>)}
                    </select>
                  </label>
                  <button className="btn" disabled={working} onClick={() => void refresh()}>{busy === 'refresh' ? 'Checking…' : 'Re-check'}</button>
                </div>

                {status.subscriptions.length ? (
                  <div className="onboarding-subscriptions">
                    {status.subscriptions.map((subscription) => (
                      <div className="onboarding-subscription" key={subscription.provider}>
                        <span className={subscription.loggedIn || subscription.linked ? 'dot live' : subscription.installed ? 'dot busy' : 'dot'} />
                        <div className="grow">
                          <strong>{subscription.label}</strong>
                          <div className="muted small">
                            {subscription.loggedIn || subscription.linked
                              ? subscription.account ? `Linked as ${subscription.account}` : 'Account linked'
                              : subscription.installed ? 'Installed, not linked' : 'Not installed'}
                          </div>
                        </div>
                        {!(subscription.loggedIn || subscription.linked) && subscription.installed && subscription.loginSupported ? (
                          <button className="btn small" disabled={working} onClick={() => void manageSubscription(subscription.provider, 'signin')}>
                            {busy === `signin:${subscription.provider}` ? 'Opening…' : 'Sign in'}
                          </button>
                        ) : null}
                        {subscription.installed === false && subscription.installSupported ? (
                          <button className="btn small" disabled={working} onClick={() => void manageSubscription(subscription.provider, 'install')}>
                            {busy === `install:${subscription.provider}` ? 'Opening…' : 'Install'}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                <details className="onboarding-provider">
                  <summary>Connect a local server or API provider</summary>
                  <div className="onboarding-provider-grid">
                    <label>
                      Type
                      <select value={providerKind} onChange={(event) => selectProviderKind(event.target.value as ProviderKind)} disabled={working}>
                        <option value="ollama">Ollama</option>
                        <option value="lmstudio">LM Studio</option>
                        <option value="openai-compatible">OpenAI-compatible</option>
                        <option value="anthropic">Anthropic API</option>
                        <option value="openai">OpenAI API</option>
                      </select>
                    </label>
                    <label>Name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} disabled={working} /></label>
                    <label className="wide">Server URL<input value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} disabled={working} /></label>
                    <label className="wide">
                      API key <span className="muted">(only when required)</span>
                      <input type="password" autoComplete="off" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} disabled={working} />
                    </label>
                  </div>
                  <div className="row end"><button className="btn" disabled={working || !providerName.trim() || !providerUrl.trim()} onClick={() => void connectProvider()}>{busy === 'provider' ? 'Connecting…' : 'Connect & verify'}</button></div>
                </details>
              </section>
            ) : null}

            <section className="onboarding-section">
              <div className="onboarding-section-title">
                <span className="onboarding-step">2</span>
                <div><strong>Verify the private starter team</strong><div className="muted small">Existing agents are preserved. IDACC creates only missing lead, coder, or researcher agents.</div></div>
              </div>
              <div className="onboarding-agents">
                {status.starterAgents.map((agent) => (
                  <div className="onboarding-agent" key={agent.name}>
                    <span className={agent.present && agent.active && agent.skillsReady && agent.brainMcpReady ? 'dot live' : agent.setupStatus === 'running' ? 'dot busy' : agent.error ? 'dot dead' : 'dot'} />
                    <div>
                      <strong>{agent.name}</strong>
                      <div className="muted small">{agent.role}</div>
                    </div>
                    <span className="muted small">
                      {agent.error
                        ? 'needs attention'
                        : agent.present
                          ? agent.active && agent.skillsReady && agent.brainMcpReady
                            ? 'ready'
                            : agent.active
                              ? 'configuring capabilities'
                              : 'starting'
                          : 'will be created'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="onboarding-gates">
                {(Object.entries(status.gates) as Array<[keyof ConsumerOnboardingStatus['gates'], boolean]>).map(([key, ok]) => (
                  <span className={`onboarding-gate ${ok ? 'ok' : ''}`} key={key}>{ok ? '✓' : '○'} {gateLabel(key)}</span>
                ))}
              </div>
            </section>

            {message ? <div className={`onboarding-message${status.currentReady ? ' success' : ''}`}>{message}</div> : null}
            {!message && status.issues.length && !setupFinished ? <div className="onboarding-message">{status.issues[0]}</div> : null}

            <div className="row end gap onboarding-actions">
              {!setupFinished && status.phase !== 'limited' ? (
                <button className="btn" disabled={working || !status.canDefer} onClick={() => void defer()}>
                  {busy === 'defer' ? 'Saving…' : 'Continue in limited mode'}
                </button>
              ) : null}
              {setupFinished ? (
                <button className="btn primary" onClick={onClose}>Enter IDACC</button>
              ) : status.phase !== 'limited' ? (
                <button
                  className="btn primary"
                  disabled={working || !runtime || Boolean(selectedOption?.requiresModel && !model)}
                  onClick={() => void createStarterTeam()}
                >
                  {busy === 'fleet' ? 'Building & verifying…' : status.state.startedAt ? 'Retry setup' : 'Create starter workspace'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
