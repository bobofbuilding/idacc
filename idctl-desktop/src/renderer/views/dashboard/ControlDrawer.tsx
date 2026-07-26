// SPDX-License-Identifier: MIT
/** Control drawer — a right-side slide-over for Dashboard shortcuts. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetStore } from '../../store.ts';
import { call } from '../../store.ts';
import type { CommandEnvironment } from '../../dashboard/commandRuntime.ts';
import {
  DRAWER_COMMANDS,
  drawerCommandStatus,
  runDrawerCommand,
} from '../../dashboard/drawerCommands.ts';
import { ProjectDriverPanel } from './panels/ProjectDriverPanel.tsx';
import { OrgPanel } from './panels/OrgPanel.tsx';
import { PlansPanel } from './panels/PlansPanel.tsx';
import { BoardPanel } from './panels/BoardPanel.tsx';
import { ControlCenterPanel } from './panels/ControlCenterPanel.tsx';
import type { DrawerGuardReporter, DrawerGuardState } from './drawerGuard.ts';

const CLEAR_GUARD: DrawerGuardState = { dirty: false, busy: false };

export function ControlDrawer({
  store, panel, onClose, navigate, commandEnvironment, returnFocusTarget,
}: {
  store: FleetStore;
  panel: string | null;
  onClose: () => void;
  navigate?: (view: string) => void;
  commandEnvironment: CommandEnvironment;
  returnFocusTarget?: HTMLElement | null;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const guardPromptRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [guardReport, setGuardReport] = useState<{ panel: string | null; state: DrawerGuardState }>({
    panel: null,
    state: CLEAR_GUARD,
  });
  const [closePrompt, setClosePrompt] = useState(false);
  const [pendingView, setPendingView] = useState<string | null>(null);
  const guard = guardReport.panel === panel ? guardReport.state : CLEAR_GUARD;
  const reportGuard = useCallback((state: DrawerGuardState) => {
    setGuardReport({ panel, state });
  }, [panel]);

  useEffect(() => {
    setClosePrompt(false);
    setPendingView(null);
  }, [panel]);

  useEffect(() => {
    if (!panel) return;
    returnFocusRef.current = returnFocusTarget?.isConnected
      ? returnFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
  }, [panel, returnFocusTarget]);

  useEffect(() => {
    if (!closePrompt) return;
    const frame = requestAnimationFrame(() => {
      guardPromptRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [closePrompt, guard.busy]);

  const completeClose = useCallback((target?: string | null) => {
    setClosePrompt(false);
    setPendingView(null);
    onClose();
    if (target) navigate?.(target);
  }, [navigate, onClose]);

  const requestClose = useCallback((target?: string) => {
    if (guard.busy || guard.dirty) {
      setPendingView(target ?? null);
      setClosePrompt(true);
      return;
    }
    completeClose(target);
  }, [completeClose, guard.busy, guard.dirty]);

  if (!panel) return null;
  const title = panel === 'quick' ? 'Dashboard shortcuts' : panel === 'project-driver' ? 'Project driver' : panel === 'org' ? 'Organization' : panel === 'plans' ? 'Plans' : panel === 'board' ? 'Board' : panel === 'control-center' ? 'Control center' : panel;
  const titleId = `dashboard-drawer-${panel}-title`;
  const onDrawerKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (closePrompt) setClosePrompt(false);
      else requestClose();
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
    <div
      className="drawer-overlay"
      data-dashboard-drawer-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
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
          {(guard.dirty || guard.busy) ? (
            <span className="drawer-guard-badge" aria-live="polite">
              {guard.busy ? 'Action running' : 'Unsaved changes'}
            </span>
          ) : null}
          <button className="btn icon-danger" onClick={() => requestClose()} title="Close" aria-label="Close control drawer">✕</button>
        </header>
        <div className="drawer-body">
          {panel === 'quick' ? <QuickControlsPanel store={store} commandEnvironment={commandEnvironment} navigate={requestClose} onGuardChange={reportGuard} /> : null}
          {panel === 'project-driver' ? <ProjectDriverPanel store={store} commandEnvironment={commandEnvironment} onGuardChange={reportGuard} onOpenWork={() => requestClose('tasks')} /> : null}
          {panel === 'org' ? <OrgPanel store={store} commandEnvironment={commandEnvironment} onGuardChange={reportGuard} onOpenHr={() => requestClose('teams:route')} /> : null}
          {panel === 'plans' ? <PlansPanel commandEnvironment={commandEnvironment} onGuardChange={reportGuard} onOpenWork={() => requestClose('tasks')} /> : null}
          {panel === 'board' ? <BoardPanel commandEnvironment={commandEnvironment} onGuardChange={reportGuard} onOpenWork={() => requestClose('tasks')} /> : null}
          {panel === 'control-center' ? <ControlCenterPanel commandEnvironment={commandEnvironment} onGuardChange={reportGuard} onOpenSettings={() => requestClose('settings')} onOpenCapabilities={() => requestClose('modules')} /> : null}
          {!['quick', 'project-driver', 'org', 'plans', 'board', 'control-center'].includes(panel) ? <div className="muted">Unknown panel: {panel}</div> : null}
        </div>
        {closePrompt ? (
          <section
            ref={guardPromptRef}
            className="drawer-close-guard"
            role="alertdialog"
            aria-label="Protect unfinished drawer work"
            aria-live="assertive"
          >
            <div>
              <strong>{guard.busy ? 'This action is still running' : 'Discard unsaved changes?'}</strong>
              <p>
                {guard.busy
                  ? 'The drawer will stay open until the command settles, so its result and recovery receipt are not lost.'
                  : guard.detail || 'Closing now will discard the edits in this drawer.'}
              </p>
            </div>
            <div className="row-actions">
              <button className="btn" onClick={() => { setClosePrompt(false); setPendingView(null); }}>Keep working</button>
              <button
                className="btn danger"
                disabled={guard.busy}
                onClick={() => completeClose(pendingView)}
              >
                {guard.dirty ? 'Discard changes' : 'Close drawer'}
              </button>
            </div>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

/** Dashboard defaults to observe/talk; mutation-heavy flows open their owner pages. */
function QuickControlsPanel({
  store,
  navigate,
  commandEnvironment,
  onGuardChange,
}: {
  store: FleetStore;
  navigate?: (view: string) => void;
  commandEnvironment: CommandEnvironment;
  onGuardChange?: DrawerGuardReporter;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onGuardChange?.({ dirty: false, busy, detail: busy ? 'A fleet probe is still running.' : undefined });
  }, [busy, onGuardChange]);

  const probe = async (): Promise<void> => {
    const label = 'Probe all agents';
    setBusy(true);
    setStatus(`${label}…`);
    const result = await runDrawerCommand({
      metadata: DRAWER_COMMANDS.quickProbe,
      environment: commandEnvironment,
      label,
      resourceRefs: ['fleet'],
      operation: () => call('probeAll'),
    });
    setStatus(drawerCommandStatus(label, result, 'Probe dispatched to all agents.'));
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="card">
        <h3>Observe</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => void probe()}>Probe all</button>
          <button className="btn" disabled={busy} onClick={() => { store.refresh(); setStatus('Refreshed'); }}>Refresh</button>
        </div>
      </section>

      <section className="card">
        <h3>Review in owner pages</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => navigate?.('projects')}>Open Projects</button>
          <button className="btn" disabled={busy} onClick={() => navigate?.('teams:route')} title="Open HR Manager Manage → Hierarchy & sync">Open HR Manage</button>
          <button className="btn" disabled={busy} onClick={() => navigate?.('teams:health')}>Open HR Health</button>
        </div>
      </section>

      {status ? <div className="muted small" aria-live="polite">{status}</div> : null}
    </div>
  );
}
