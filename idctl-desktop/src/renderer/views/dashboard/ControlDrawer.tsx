// SPDX-License-Identifier: MIT
/** Control drawer — a right-side slide-over for Dashboard shortcuts. */
import { useEffect, useRef, useState } from 'react';
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
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!panel) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const first = drawerRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? drawerRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
    };
  }, [panel]);

  if (!panel) return null;
  const title = panel === 'quick' ? 'Dashboard shortcuts' : panel === 'project-driver' ? 'Project driver' : panel === 'org' ? 'Organization' : panel === 'plans' ? 'Plans' : panel === 'board' ? 'Board' : panel === 'control-center' ? 'Control center' : panel;
  const titleId = `dashboard-drawer-${panel}-title`;
  const onDrawerKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      drawerRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        ref={drawerRef}
        className="drawer"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onDrawerKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h3 id={titleId}>{title}</h3>
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
