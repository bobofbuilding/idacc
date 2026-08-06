// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { call } from '../../../store.ts';
import type { CommandEnvironment } from '../../../dashboard/commandRuntime.ts';
import {
  DRAWER_COMMANDS,
  drawerCommandStatus,
  runDrawerCommand,
} from '../../../dashboard/drawerCommands.ts';
import { useDrawerGuard, type DrawerGuardReporter } from '../drawerGuard.ts';

type Provider = { name: string; kind?: string; enabled?: boolean; isDefault?: boolean };
type Mcp = { name: string; transport?: string };

export function ControlCenterPanel({
  onOpenSettings,
  onOpenCapabilities,
  commandEnvironment,
  onGuardChange,
}: {
  onOpenSettings: () => void;
  onOpenCapabilities: () => void;
  commandEnvironment: CommandEnvironment;
  onGuardChange?: DrawerGuardReporter;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [concurrency, setConcurrency] = useState(1);
  const [savedConcurrency, setSavedConcurrency] = useState(1);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [providerRows, servers, gate] = await Promise.all([
      call<Provider[]>('providers:list').catch(() => []),
      call<Mcp[]>('mcp:list').catch(() => []),
      call<{ concurrency?: number }>('manager:localConcurrency').catch((): { concurrency?: number } => ({})),
    ]);
    const currentConcurrency = gate.concurrency ?? 1;
    setProviders(providerRows);
    setMcp(servers);
    setConcurrency(currentConcurrency);
    setSavedConcurrency(currentConcurrency);
  };
  useEffect(() => { void load(); }, []);
  useDrawerGuard(
    onGuardChange,
    concurrency !== savedConcurrency,
    busy,
    busy ? 'A runtime setting is still being applied.' : 'The local concurrency edit has not been applied.',
  );
  const toggle = async (name: string) => {
    setBusy(true);
    const result = await runDrawerCommand({
      metadata: DRAWER_COMMANDS.controlProvider,
      environment: commandEnvironment,
      label: `Toggle provider ${name}`,
      resourceRefs: [`provider:${name}`],
      operation: () => call('providers:toggle', name),
    });
    if (result.receipt.state === 'succeeded') await load();
    setStatus(drawerCommandStatus(`Toggle provider ${name}`, result, `${name} updated.`));
    setBusy(false);
  };
  const saveConcurrency = async () => {
    setBusy(true);
    const result = await runDrawerCommand({
      metadata: DRAWER_COMMANDS.controlConcurrency,
      environment: commandEnvironment,
      label: 'Apply local inference concurrency',
      resourceRefs: ['local-concurrency', `value:${concurrency}`],
      operation: () => call('manager:setLocalConcurrency', concurrency),
    });
    if (result.receipt.state === 'succeeded') setSavedConcurrency(concurrency);
    setStatus(drawerCommandStatus('Apply local inference concurrency', result, `Local concurrency set to ${concurrency}.`));
    setBusy(false);
  };
  return (
    <div className="driver-panel">
      <div className="driver-heading"><strong>Runtime control</strong><button className="btn" onClick={onOpenSettings}>Open Settings</button></div>
      {providers.map((provider) => <div className="driver-task-row" key={provider.name}><span><strong>{provider.name}</strong><br /><span className="muted small">{provider.kind ?? 'provider'}{provider.isDefault ? ' · default' : ''}</span></span><button className="btn" disabled={busy} onClick={() => void toggle(provider.name)}>{provider.enabled === false ? 'Enable' : 'Disable'}</button></div>)}
      <label className="driver-objective">Local inference concurrency<input type="number" min={1} max={16} value={concurrency} onChange={(event) => setConcurrency(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label>
      <button className="btn" disabled={busy || concurrency === savedConcurrency} onClick={() => void saveConcurrency()}>Apply concurrency</button>
      <hr />
      <div className="driver-heading"><strong>MCP catalog</strong><span className="muted small">{mcp.length} registered</span><button className="btn" onClick={onOpenCapabilities}>Open Capabilities</button></div>
      {mcp.slice(0, 10).map((server) => <div className="driver-task-row" key={server.name}><span>{server.name}</span><span className="muted small">{server.transport ?? 'stdio'}</span></div>)}
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
