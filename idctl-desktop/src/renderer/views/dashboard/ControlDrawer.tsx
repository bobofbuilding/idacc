// SPDX-License-Identifier: MIT
/** Control drawer — a right-side slide-over for Dashboard shortcuts. */
import { useState } from 'react';
import type { FleetStore } from '../../store.ts';
import { call } from '../../store.ts';
import { ProjectDriverPanel } from './panels/ProjectDriverPanel.tsx';
import { OrgPanel } from './panels/OrgPanel.tsx';
import { PlansPanel } from './panels/PlansPanel.tsx';
import { BoardPanel } from './panels/BoardPanel.tsx';
import { ControlCenterPanel } from './panels/ControlCenterPanel.tsx';

export function ControlDrawer({
  store, panel, onClose, navigate,
}: {
  store: FleetStore;
  panel: string | null;
  onClose: () => void;
  navigate?: (view: string) => void;
}) {
  if (!panel) return null;
  const title = panel === 'quick' ? 'Dashboard shortcuts' : panel === 'project-driver' ? 'Project driver' : panel === 'org' ? 'Organization' : panel === 'plans' ? 'Plans' : panel === 'board' ? 'Board' : panel === 'control-center' ? 'Control center' : panel;
  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} panel`}>
        <header className="drawer-head">
          <h3>{title}</h3>
          <button className="btn icon-danger" onClick={onClose} title="Close">✕</button>
        </header>
        <div className="drawer-body">
          {panel === 'quick' ? <QuickControlsPanel store={store} navigate={navigate} onClose={onClose} /> : null}
          {panel === 'project-driver' ? <ProjectDriverPanel store={store} onOpenWork={() => { navigate?.('tasks'); onClose(); }} /> : null}
          {panel === 'org' ? <OrgPanel store={store} onOpenHr={() => { navigate?.('teams:route'); onClose(); }} /> : null}
          {panel === 'plans' ? <PlansPanel onOpenWork={() => { navigate?.('tasks'); onClose(); }} /> : null}
          {panel === 'board' ? <BoardPanel onOpenWork={() => { navigate?.('tasks'); onClose(); }} /> : null}
          {panel === 'control-center' ? <ControlCenterPanel onOpenSettings={() => { navigate?.('settings'); onClose(); }} onOpenCapabilities={() => { navigate?.('modules'); onClose(); }} /> : null}
          {!['quick', 'project-driver', 'org', 'plans', 'board', 'control-center'].includes(panel) ? <div className="muted">Unknown panel: {panel}</div> : null}
        </div>
      </aside>
    </div>
  );
}

/** Dashboard defaults to observe/talk; mutation-heavy flows open their owner pages. */
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
          <button className="btn" disabled={busy} onClick={() => go('teams:route')} title="Open HR Manager Manage → Hierarchy & sync">Open HR Manage</button>
          <button className="btn" disabled={busy} onClick={() => go('teams:health')}>Open HR Health</button>
        </div>
      </section>

      {status ? <div className="muted small" aria-live="polite">{status}</div> : null}
    </div>
  );
}
