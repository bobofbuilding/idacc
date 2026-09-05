/** In-app text prompts, queued so every caller receives a result. */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
}
type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const PromptCtx = createContext<PromptFn>(async () => null);
export const usePrompt = (): PromptFn => useContext(PromptCtx);

interface Request extends PromptOptions {
  resolve: (v: string | null) => void;
}

function PromptDialog({ request, close }: { request: Request; close: (value: string | null) => void }) {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    input.current?.focus();
    input.current?.select();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal-overlay prompt-overlay"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(null); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(null); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button'));
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }}
    >
      <form className="modal" onSubmit={(event) => { event.preventDefault(); close(value); }}>
        <div id={titleId} className="modal-title">{request.title}</div>
        <input
          ref={input}
          autoFocus
          aria-labelledby={titleId}
          className="composer-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter may be accepting a character in an IME, not submitting the form.
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
          }}
        />
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          <button type="submit" className="btn primary">{request.okLabel ?? 'OK'}</button>
        </div>
      </form>
    </dialog>
  );
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const queue = useRef<(Request & { id: number })[]>([]);
  const sequence = useRef(0);
  const [state, setState] = useState<(Request & { id: number }) | null>(null);

  const prompt = useCallback<PromptFn>((opts) => new Promise((resolve) => {
    const request = { ...opts, resolve, id: ++sequence.current };
    queue.current.push(request);
    if (queue.current.length === 1) setState(request);
  }), []);

  const close = useCallback((request: Request, value: string | null) => {
    // Ignore a second event from a dialog that has already finished.
    if (queue.current[0] !== request) return;
    queue.current.shift();
    request.resolve(value);
    setState(queue.current[0] ?? null);
  }, []);

  useEffect(() => () => {
    for (const request of queue.current.splice(0)) request.resolve(null);
  }, []);

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      {state ? <PromptDialog key={state.id} request={state} close={(value) => close(state, value)} /> : null}
    </PromptCtx.Provider>
  );
}
