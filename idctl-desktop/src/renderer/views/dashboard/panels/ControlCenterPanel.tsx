// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { call } from '../../../store.ts';

type Provider = { name: string; kind?: string; enabled?: boolean; isDefault?: boolean };
type Mcp = { name: string; transport?: string };

export function ControlCenterPanel({ onOpenSettings, onOpenCapabilities }: { onOpenSettings: () => void; onOpenCapabilities: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [concurrency, setConcurrency] = useState(1);
  const [status, setStatus] = useState('');
  const load = async () => {
    const [providerRows, servers, gate] = await Promise.all([
      call<Provider[]>('providers:list').catch(() => []),
      call<Mcp[]>('mcp:list').catch(() => []),
      call<{ concurrency?: number }>('manager:localConcurrency').catch((): { concurrency?: number } => ({})),
    ]);
    setProviders(providerRows); setMcp(servers); setConcurrency(gate.concurrency ?? 1);
  };
  useEffect(() => { void load(); }, []);
  const toggle = async (name: string) => {
    try { await call('providers:toggle', name); setStatus(`${name} updated.`); await load(); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const saveConcurrency = async () => {
    try { await call('manager:setLocalConcurrency', concurrency); setStatus(`Local concurrency set to ${concurrency}.`); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <div className="driver-panel">
      <div className="driver-heading"><strong>Runtime control</strong><button className="btn" onClick={onOpenSettings}>Open Settings</button></div>
      {providers.map((provider) => <div className="driver-task-row" key={provider.name}><span><strong>{provider.name}</strong><br /><span className="muted small">{provider.kind ?? 'provider'}{provider.isDefault ? ' · default' : ''}</span></span><button className="btn" onClick={() => void toggle(provider.name)}>{provider.enabled === false ? 'Enable' : 'Disable'}</button></div>)}
      <label className="driver-objective">Local inference concurrency<input type="number" min={1} max={16} value={concurrency} onChange={(event) => setConcurrency(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label>
      <button className="btn" onClick={() => void saveConcurrency()}>Apply concurrency</button>
      <hr />
      <div className="driver-heading"><strong>MCP catalog</strong><span className="muted small">{mcp.length} registered</span><button className="btn" onClick={onOpenCapabilities}>Open Capabilities</button></div>
      {mcp.slice(0, 10).map((server) => <div className="driver-task-row" key={server.name}><span>{server.name}</span><span className="muted small">{server.transport ?? 'stdio'}</span></div>)}
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
