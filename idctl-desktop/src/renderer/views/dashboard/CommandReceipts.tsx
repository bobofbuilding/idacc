// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { FleetStore } from '../../store.ts';
import { buildCommands } from '../../dashboard/commands.ts';
import { DRAWER_COMMANDS } from '../../dashboard/drawerCommands.ts';
import {
  commandReceiptStore,
  type CommandReceipt,
} from '../../dashboard/commandRuntime.ts';

const DRAWER_OWNER_BY_ID = new Map<string, string>(
  Object.values(DRAWER_COMMANDS).map((metadata) => [metadata.commandId, metadata.ownerView]),
);

function ownerFallback(commandId: string): string {
  const drawerOwner = DRAWER_OWNER_BY_ID.get(commandId);
  if (drawerOwner) return drawerOwner;
  const owners: Record<string, string> = {
    'chat.work.dispatch': 'tasks',
    'chat.projects.create': 'projects',
    'chat.org.assign-lead': 'teams',
    'chat.work.triage': 'tasks',
  };
  if (owners[commandId]) return owners[commandId];
  if (commandId.startsWith('remote.')) return 'dashboard';
  return 'dashboard';
}

function commandFallbackLabel(commandId: string): string {
  const labels: Record<string, string> = {
    'chat.work.dispatch': 'Decompose and dispatch work',
    'chat.projects.create': 'Register project',
    'chat.org.assign-lead': 'Assign team lead',
    'chat.work.triage': 'Triage unassigned work',
    'drawer.quick.probe': 'Probe all agents',
    'drawer.project.save': 'Save project routing',
    'drawer.project.decompose': 'Decompose project objective',
    'drawer.project.dispatch': 'Dispatch reviewed work',
    'drawer.project.triage': 'Triage project queue',
    'drawer.org.assign-lead': 'Assign accountable lead',
    'drawer.org.secondary-scope': 'Save secondary lead scope',
    'drawer.org.sync': 'Synchronize organization',
    'drawer.plan.create': 'Create Brain plan',
    'drawer.plan.status': 'Update Brain plan status',
    'drawer.board.lane': 'Update task lane',
    'drawer.control.provider': 'Toggle runtime provider',
    'drawer.control.concurrency': 'Apply local concurrency',
    'remote.ask': 'Send message to agent',
    'remote.hey': 'Send message to agent',
  };
  return labels[commandId] ?? commandId;
}

function stateLabel(receipt: CommandReceipt): string {
  if (receipt.state === 'timed-out') return 'timed out';
  return receipt.state;
}

function elapsed(receipt: CommandReceipt): string {
  const end = receipt.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - receipt.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

export function CommandReceipts({
  store,
  navigate,
}: {
  store: FleetStore;
  navigate: (view: string) => void;
}) {
  const receiptStore = commandReceiptStore();
  const receipts = useSyncExternalStore(receiptStore.subscribe, receiptStore.snapshot, receiptStore.snapshot);
  const hasRunning = receipts.some((receipt) => receipt.state === 'running' || receipt.state === 'reconciling');
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);
  const commands = useMemo(() => buildCommands(store), [store]);
  const commandById = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);
  if (!receipts.length) return null;

  return (
    <aside className="command-receipts" aria-label="Command receipts">
      <header className="command-receipts-head">
        <strong>Command receipts</strong>
        <span className="muted small">{receipts.length} retained</span>
        <button className="btn small" onClick={() => receiptStore.clearTerminal()}>Clear finished</button>
      </header>
      <div className="command-receipts-list">
        {receipts.slice(0, 6).map((receipt) => {
          const command = commandById.get(receipt.commandId);
          const ownerView = command?.ownerView ?? ownerFallback(receipt.commandId);
          const failed = receipt.state === 'failed' || receipt.state === 'timed-out' || receipt.state === 'blocked';
          return (
            <article
              key={receipt.idempotencyKey}
              className={`command-receipt state-${receipt.state}`}
              data-command-id={receipt.commandId}
              data-command-state={receipt.state}
            >
              <div className="command-receipt-main">
                <span aria-live="polite" className={`command-receipt-state${failed ? ' status-error' : receipt.state === 'succeeded' ? ' ok-text' : ''}`}>
                  {receipt.state === 'running' ? '● ' : ''}{stateLabel(receipt)}
                </span>
                <strong>{command?.label ?? commandFallbackLabel(receipt.commandId)}</strong>
                <span className="muted small">{elapsed(receipt)}</span>
              </div>
              {receipt.resourceRefs.length ? (
                <div className="command-receipt-refs">{receipt.resourceRefs.join(' · ')}</div>
              ) : null}
              {receipt.error ? <div className="command-receipt-error">{receipt.error}</div> : null}
              {receipt.recovery && (failed || receipt.state === 'deferred') ? <div className="command-receipt-recovery">{receipt.recovery}</div> : null}
              <div className="command-receipt-actions">
                {(failed || receipt.state === 'declined' || receipt.state === 'deferred') ? (
                  <button className="btn small" onClick={() => navigate(ownerView)}>Open {ownerView}</button>
                ) : null}
                {!['running', 'reconciling', 'timed-out'].includes(receipt.state) ? (
                  <button
                    className="btn small"
                    aria-label={`Dismiss ${receipt.commandId} receipt`}
                    onClick={() => receiptStore.remove(receipt.idempotencyKey)}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
