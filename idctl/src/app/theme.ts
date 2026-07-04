/** Shared palette + tiny helpers so views stay visually consistent. */

export const theme = {
  accent: 'cyan',
  accentAlt: 'magenta',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  dim: 'gray',
  text: 'white',
} as const;

/** Map an agent/query/probe status word to a palette colour. */
export function statusColor(status: string | undefined): string {
  const s = (status ?? '').toLowerCase();
  if (/running|online|ok|delivered|done|completed|active/.test(s)) return theme.ok;
  if (/start|pending|processing|probing|claimed|in[_-]?progress|busy/.test(s)) return theme.warn;
  if (/stop|offline|fail|error|expired|cancel|dead/.test(s)) return theme.err;
  return theme.dim;
}

/** A coloured dot for a status. */
export function dot(status: string | undefined): string {
  return '●';
}

/** Relative "12s ago" / "3m ago" formatting for timestamps (ms). */
export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** Compact a runtime id for narrow columns: claude-code-cli → claude, cursor-cli → cursor. */
export function shortRuntime(r: string | undefined): string {
  if (!r) return '—';
  return r.replace('claude-code-cli', 'claude').replace('-cli', '').replace('public-agent-remote', 'remote');
}

/** Compact a model id: claude-opus-4-8 → opus-4-8, claude-sonnet-5 → sonnet-5. */
export function shortModel(m: string | undefined): string {
  if (!m) return '—';
  return m.replace(/^claude-/, '');
}
