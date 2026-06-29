// SPDX-License-Identifier: MIT
/**
 * Control drawer — a right-side slide-over that hosts the Dashboard's control panels. Phase 2
 * ships the infrastructure plus one functional panel (Quick controls); Phase 3 adds the rich
 * Project Driver and Org panels. Every action runs through the IPC bridge, so it's brain-learned.
 */
import { useState } from 'react';
import type { FleetStore } from '../../store.ts';
import { call } from '../../store.ts';

type OrgPreview = {
  agents: number;
  changed: number;
  rebuilt: string[];
  brain: boolean;
  skippedBusy: number;
  autoRebuild: boolean;
  rebuildLimit: number;
  changedAgents: { team: string; agent: string; status?: string; rebuild: boolean; reason?: string }[];
};
type OrgSyncResult = { agents: number; written: number; rebuilt: string[]; brain: boolean; skippedBusy: number };

function formatOrgPreview(p: OrgPreview): string {
  const sample = p.changedAgents.slice(0, 8).map((a) =>
    `- ${a.team}/${a.agent}${a.rebuild ? ' -> rebuild' : a.reason ? ` -> ${a.reason}` : ''}${a.status ? ` (${a.status})` : ''}`,
  );
  const more = p.changedAgents.length > sample.length ? [`- ...and ${p.changedAgents.length - sample.length} more`] : [];
  return [
    'Org sync preview',
    `Agents scanned: ${p.agents}`,
    `Goal files that would change: ${p.changed}`,
    `Brain hierarchy write: ${p.brain ? 'yes' : 'no'}`,
    `Auto-rebuild: ${p.autoRebuild ? `yes, ${p.rebuilt.length}/${p.rebuildLimit} planned` : 'off'}`,
    p.skippedBusy ? `Deferred rebuilds: ${p.skippedBusy}` : 'Deferred rebuilds: 0',
    ...(sample.length ? ['', 'Affected agents:', ...sample, ...more] : []),
  ].join('\n');
}

function formatOrgResult(r: OrgSyncResult): string {
  const rebuilt = r.rebuilt.length ? ` (${r.rebuilt.slice(0, 5).join(', ')}${r.rebuilt.length > 5 ? ', ...' : ''})` : '';
  return `Org synced — ${r.written} goals updated · rebuilt ${r.rebuilt.length}${rebuilt}${r.skippedBusy ? ` · ${r.skippedBusy} deferred` : ''} · brain=${r.brain ? 'ok' : 'n/a'}`;
}

export function ControlDrawer({
  store, panel, onClose, navigate,
}: {
  store: FleetStore;
  panel: string | null;
  onClose: () => void;
  navigate?: (view: string) => void;
}) {
  if (!panel) return null;
  const title = panel === 'quick' ? 'Dashboard shortcuts' : panel;
  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} panel`}>
        <header className="drawer-head">
          <h3>{title}</h3>
          <button className="btn icon-danger" onClick={onClose} title="Close">✕</button>
        </header>
        <div className="drawer-body">
          {panel === 'quick' ? <QuickControlsPanel store={store} navigate={navigate} onClose={onClose} /> : <div className="muted">Unknown panel: {panel}</div>}
        </div>
      </aside>
    </div>
  );
}

/** Dashboard defaults to observe/talk; direct mutators live behind the advanced section. */
function QuickControlsPanel({ store, navigate, onClose }: { store: FleetStore; navigate?: (view: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const go = (view: string) => {
    navigate?.(view);
    onClose();
  };

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const result = await fn();
      setStatus(typeof result === 'string' ? result : `${label} ✓`);
    }
    catch (e) { setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };
  const guardedAct = async (label: string, detail: string, fn: () => Promise<unknown>): Promise<void> => {
    if (!window.confirm(`${label}?\n\n${detail}`)) return;
    await act(label, fn);
  };
  const previewOrgSync = async (): Promise<void> => {
    await act('Org sync', async () => {
      setStatus('Org sync previewing…');
      const cfg = await call<{ enabled?: boolean; autoRebuild?: boolean }>('org:getConfig').catch(() => ({ enabled: true, autoRebuild: true }));
      const opts = { autoRebuild: cfg.autoRebuild !== false };
      const preview = await call<OrgPreview>('org:preview', opts);
      const text = formatOrgPreview(preview);
      if (!window.confirm(`${text}\n\nApply this org sync from Dashboard?`)) {
        return 'Org sync cancelled after preview';
      }
      setStatus('Org sync applying…');
      const result = await call<OrgSyncResult>('org:sync', opts);
      store.refresh();
      return formatOrgResult(result);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="card">
        <h3>Observe</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => void act('Probe all agents', () => call('probeAll'))}>Probe all</button>
          <button className="btn" disabled={busy} onClick={() => { store.refresh(); setStatus('Refreshed'); }}>Refresh</button>
        </div>
      </section>

      <section className="card">
        <h3>Review in owner pages</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => go('projects')}>Open Projects</button>
          <button className="btn" disabled={busy} onClick={() => go('teams:route')} title="Open HR Manager Route → Hierarchy & sync">Open HR Route</button>
          <button className="btn" disabled={busy} onClick={() => go('health')}>Open Health</button>
        </div>
      </section>

      <details className="card" style={{ background: 'var(--bg-2)' }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>Advanced direct shortcuts</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn" disabled={busy} onClick={() => void guardedAct('Sync workspace projects from Dashboard', 'This scans the workspace and adds or adopts project tracker entries. Prefer Projects when you want to review tracker state before and after.', () => call('projects:syncRoot'))}>Sync projects</button>
            <button className="btn" disabled={busy} onClick={() => void previewOrgSync()}>Preview org sync</button>
          </div>
        </div>
      </details>

      {status ? <div className="muted small" aria-live="polite">{status}</div> : null}
    </div>
  );
}
