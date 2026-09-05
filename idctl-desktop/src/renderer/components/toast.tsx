/**
 * Global toast notifications. Rendered at the app root (above page routing) so a
 * long-running action — e.g. "Compile & dispatch" — can report progress and then
 * COMPLETION even after the user navigates to another page. The toast handle's
 * update()/dismiss() come from this always-mounted provider, so they keep working
 * after the view that started them has unmounted. The underlying work runs in the
 * main process and is never tied to a view's lifecycle.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type ToastKind = 'progress' | 'success' | 'error' | 'info';
export interface ToastOptions { text: string; kind?: ToastKind; durationMs?: number }
export interface ToastHandle { id: string; update: (patch: Partial<ToastOptions>) => void; dismiss: () => void }
type ToastFn = (opts: ToastOptions) => ToastHandle;

const NOOP: ToastHandle = { id: '', update() {}, dismiss() {} };
const ToastCtx = createContext<ToastFn>(() => NOOP);
export const useToast = (): ToastFn => useContext(ToastCtx);

interface Toast { id: string; text: string; kind: ToastKind; expireAt?: number }
const DEFAULT_MS = 8000;
// progress toasts never auto-expire (they wait for an update); others fade.
function expiry(kind: ToastKind, durationMs?: number): number | undefined {
  return kind === 'progress' ? undefined : Date.now() + (durationMs ?? DEFAULT_MS);
}
let SEQ = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastFn>((opts) => {
    const id = `t${++SEQ}`;
    const kind = opts.kind ?? 'info';
    setToasts((t) => [...t, { id, text: opts.text, kind, expireAt: expiry(kind, opts.durationMs) }]);
    return {
      id,
      update: (patch) => setToasts((t) => t.map((x) => {
        if (x.id !== id) return x;
        const nk = patch.kind ?? x.kind;
        return { ...x, text: patch.text ?? x.text, kind: nk, expireAt: expiry(nk, patch.durationMs) };
      })),
      dismiss: () => dismiss(id),
    };
  }, [dismiss]);

  // Prune expired toasts on a light interval (only while any can expire).
  useEffect(() => {
    if (!toasts.some((t) => t.expireAt)) return;
    const iv = setInterval(() => setToasts((t) => t.filter((x) => !x.expireAt || x.expireAt > Date.now())), 500);
    return () => clearInterval(iv);
  }, [toasts]);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <style>{`@keyframes idctlSpin{to{transform:rotate(360deg)}}.idctl-spin{display:inline-block;animation:idctlSpin .9s linear infinite}`}</style>
      {toasts.length ? (
        <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 400 }}>
          {toasts.map((t) => {
            const accent = t.kind === 'success' ? '#3ccb78' : t.kind === 'error' ? '#e06c6c' : t.kind === 'progress' ? 'var(--accent, #6aa8ff)' : 'var(--border, #2a2a2a)';
            return (
              <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} aria-atomic="true" style={{ display: 'flex', alignItems: 'flex-start', gap: 9, background: 'var(--panel, #1b1b1b)', border: '1px solid var(--border, #2a2a2a)', borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: '9px 11px', boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}>
                <span aria-hidden="true" style={{ color: accent, fontWeight: 700, lineHeight: '18px' }}>
                  {t.kind === 'success' ? '✓' : t.kind === 'error' ? '⚠' : t.kind === 'progress' ? <span className="idctl-spin">⟳</span> : '•'}
                </span>
                <span style={{ flex: 1, fontSize: 12.5, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.text}</span>
                <button onClick={() => dismiss(t.id)} title="Dismiss" aria-label="Dismiss notification" style={{ background: 'none', border: 'none', color: 'var(--muted, #888)', cursor: 'pointer', fontSize: 14, lineHeight: '16px', padding: 0 }}>×</button>
              </div>
            );
          })}
        </div>
      ) : null}
    </ToastCtx.Provider>
  );
}
