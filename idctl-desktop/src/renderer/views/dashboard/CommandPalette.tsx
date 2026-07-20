// SPDX-License-Identifier: MIT
/**
 * Command palette (⌘K) — fuzzy-search every control action and run it. The keyboard-first
 * front door to the Dashboard command surface: navigation, quick fleet actions, and panel
 * commands from one box. Action commands keep the palette open to show
 * their result; navigation / drawer commands close it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FleetStore } from '../../store.ts';
import { buildCommands, filterCommands, initialCommandQuery, slashCommandFromQuery, type Command, type CommandCtx } from '../../dashboard/commands.ts';

export function CommandPalette({
  store, open, onClose, navigate, openDrawer,
}: {
  store: FleetStore;
  open: boolean;
  onClose: () => void;
  navigate: (view: string) => void;
  openDrawer: (panelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState('');
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

  const run = async (cmd?: Command) => {
    if (!cmd) return;
    const ctx: CommandCtx = {
      store,
      navigate: (v) => { navigate(v); onClose(); },
      openDrawer: (id) => { openDrawer(id); onClose(); },
      setStatus,
    };
    try { await cmd.run(ctx); } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); void run(results[active]); }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search…  (Esc to close)"
          value={query}
          onChange={(e) => setQuery(initialCommandQuery(e.target.value))}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">No commands match “{query}”.</div>
          ) : results.map((c, i) => (
            <button
              key={c.id}
              className={`cmdk-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => void run(c)}
            >
              <span className="cmdk-grp">{c.group}</span>
              <span className="cmdk-label">{c.label}</span>
              {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
            </button>
          ))}
        </div>
        <div className="cmdk-foot">
          <span className="muted small">↑↓ to move · ↵ to run · esc to close</span>
          {status ? <span className="cmdk-status">{status}</span> : null}
        </div>
      </div>
    </div>
  );
}
