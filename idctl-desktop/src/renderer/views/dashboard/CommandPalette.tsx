// SPDX-License-Identifier: MIT
/**
 * Command palette (⌘K) — fuzzy-search every control action and run it. The keyboard-first
 * front door to the Dashboard command surface: navigation, quick fleet actions, and panel
 * commands from one box. Action commands keep the palette open to show
 * their result; navigation / drawer commands close it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FleetStore } from '../../store.ts';
import {
  buildCommands,
  commandMetadata,
  filterCommands,
  initialCommandQuery,
  slashCommandFromQuery,
  type Command,
  type CommandCtx,
} from '../../dashboard/commands.ts';
import {
  createCommandIdempotencyKey,
  evaluateCommandGate,
  executeGatedCommand,
  recordDeclinedCommand,
  type CommandEnvironment,
} from '../../dashboard/commandRuntime.ts';

export function CommandPalette({
  store, open, onClose, navigate, openDrawer, commandEnvironment,
}: {
  store: FleetStore;
  open: boolean;
  onClose: () => void;
  navigate: (view: string) => void;
  openDrawer: (panelId: string) => void;
  commandEnvironment: CommandEnvironment;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<{ command: Command; idempotencyKey: string } | null>(null);
  const [runningCommands, setRunningCommands] = useState<Set<string>>(() => new Set());
  const executingKeysRef = useRef(new Set<string>());
  const executingCommandsRef = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => buildCommands(store), [store]);
  const staticResults = useMemo(() => filterCommands(all, query), [all, query]);
  const slashCommand = useMemo(() => slashCommandFromQuery(query, store), [query, store]);
  const results = useMemo(
    () => slashCommand ? [slashCommand, ...staticResults.filter((c) => c.id !== slashCommand.id)] : staticResults,
    [slashCommand, staticResults],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setStatus('');
    setPending(null);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  // Keep the highlighted row visible as the selection moves.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const finishRun = async (cmd: Command, idempotencyKey: string, confirmed: boolean) => {
    if (executingKeysRef.current.has(idempotencyKey) || executingCommandsRef.current.has(cmd.id)) {
      setStatus(`${cmd.label} is already running.`);
      return;
    }
    executingKeysRef.current.add(idempotencyKey);
    executingCommandsRef.current.add(cmd.id);
    setRunningCommands((current) => new Set(current).add(cmd.id));
    setPending(null);
    try {
      const metadata = commandMetadata(cmd);
      const result = await executeGatedCommand({
        metadata,
        environment: commandEnvironment,
        confirmed,
        idempotencyKey,
        resourceRefs: cmd.resourceRefs ?? [metadata.ownerView],
        operation: async (command) => {
          const ctx: CommandCtx = {
            store,
            command,
            navigate: (v) => { navigate(v); onClose(); },
            openDrawer: (id) => { openDrawer(id); onClose(); },
            setStatus,
          };
          await cmd.run(ctx);
        },
      });
      if (result.receipt.state === 'succeeded') setStatus(`${cmd.label} completed`);
      else if (result.receipt.error) setStatus(result.receipt.error);
    } finally {
      executingKeysRef.current.delete(idempotencyKey);
      executingCommandsRef.current.delete(cmd.id);
      setRunningCommands((current) => {
        const next = new Set(current);
        next.delete(cmd.id);
        return next;
      });
    }
  };

  const requestRun = (cmd?: Command) => {
    if (!cmd) return;
    if (executingCommandsRef.current.has(cmd.id)) {
      setStatus(`${cmd.label} is already running.`);
      return;
    }
    const gate = evaluateCommandGate(commandMetadata(cmd), commandEnvironment);
    const idempotencyKey = createCommandIdempotencyKey(cmd.id);
    if (gate.state === 'confirmation-required') {
      setPending({ command: cmd, idempotencyKey });
      setStatus(`Review and confirm this ${cmd.risk}-risk command.`);
      return;
    }
    void finishRun(cmd, idempotencyKey, false);
  };

  const declinePending = () => {
    if (!pending) return;
    recordDeclinedCommand({
      metadata: commandMetadata(pending.command),
      idempotencyKey: pending.idempotencyKey,
      resourceRefs: pending.command.resourceRefs ?? [pending.command.ownerView],
    });
    setStatus(`${pending.command.label} declined; nothing was changed.`);
    setPending(null);
  };

  const close = () => {
    if (pending) declinePending();
    onClose();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (pending) declinePending();
      else onClose();
    }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (pending) void finishRun(pending.command, pending.idempotencyKey, true);
      else requestRun(results[active]);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search…  (Esc to close)"
          value={query}
          disabled={!!pending}
          onChange={(e) => setQuery(initialCommandQuery(e.target.value))}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">No commands match “{query}”.</div>
          ) : results.map((c, i) => (
            (() => {
              const gate = evaluateCommandGate(commandMetadata(c), commandEnvironment);
              const blocked = gate.state === 'blocked';
              const running = runningCommands.has(c.id);
              return (
                <button
                  key={c.id}
                  className={`cmdk-row${i === active ? ' active' : ''}${blocked ? ' blocked' : ''}${running ? ' running' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => requestRun(c)}
                  aria-disabled={blocked || running}
                  title={blocked ? gate.reason : running ? 'Command is already running' : `${c.risk} risk · owner ${c.ownerView}`}
                >
                  <span className="cmdk-grp">{c.group}</span>
                  <span className="cmdk-label">{c.label}</span>
                  {c.risk !== 'none' ? <span className={`cmdk-risk risk-${c.risk}`}>{c.risk}</span> : null}
                  {(c.hint && !['view', 'drawer'].includes(c.hint)) || running ? <span className="cmdk-hint">{blocked ? 'unavailable' : running ? 'running…' : c.hint}</span> : null}
                </button>
              );
            })()
          ))}
        </div>
        {pending ? (
          <section className="cmdk-confirm" role="alertdialog" aria-label={`Confirm ${pending.command.label}`}>
            <div>
              <strong>Confirm {pending.command.label}</strong>
              <div className="muted small">
                {pending.command.risk} risk · owned by {pending.command.ownerView}
                {pending.command.requiredFeatures.length ? ` · requires ${pending.command.requiredFeatures.join(', ')}` : ''}
              </div>
            </div>
            <div className="row-actions">
              <button className="btn" onClick={declinePending}>Decline</button>
              <button
                className="btn primary"
                disabled={runningCommands.has(pending.command.id)}
                onClick={() => void finishRun(pending.command, pending.idempotencyKey, true)}
              >
                Confirm
              </button>
            </div>
          </section>
        ) : null}
        <div className="cmdk-foot">
          <span className="muted small">↑↓ to move · ↵ to run · esc to close</span>
          {status ? <span className="cmdk-status">{status}</span> : null}
        </div>
      </div>
    </div>
  );
}
