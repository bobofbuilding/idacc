import { useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { InboxItem } from '../../../../idctl/src/api/types.ts';

type BlockerQuestion = { id: string; question: string; options: string[]; agent: string; taskRef?: string; taskTitle?: string; team: string; createdAt: number };
function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

export function Inbox({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const [questions, setQuestions] = useState<BlockerQuestion[]>([]);
  async function reloadQuestions() { setQuestions(await call<BlockerQuestion[]>('questions:list', team).catch(() => [])); }
  useEffect(() => { void reloadQuestions(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated]);

  const total = store.inbox.length + questions.length;
  return (
    <div className="view">
      <header className="view-head">
        <h1>Inbox</h1>
        <span className="muted">{total} awaiting you{questions.length ? ` · ${questions.length} decision${questions.length === 1 ? '' : 's'}` : ''}</span>
      </header>

      {questions.length ? (
        <section className="card">
          <h3>Decisions needed <span className="muted small">· blocker questions from tasks — pick an option to unblock</span></h3>
          {questions.map((q) => <QuestionRow key={q.id} q={q} onDone={() => void reloadQuestions()} />)}
        </section>
      ) : null}

      <section className="card grow">
        <h3>Manager inbox <span className="muted small">{store.inbox.length ? `· ${store.inbox.length} waiting on your reply` : '· nothing needs a reply right now'}</span></h3>
        {store.inbox.length === 0 ? (
          <div className="muted center pad">You're all caught up — no questions from the manager or your agents.</div>
        ) : (
          store.inbox.map((it) => <InboxRow key={it.query_id} item={it} onDone={() => store.refresh()} />)
        )}
      </section>
    </div>
  );
}

/** A blocker decision with options. Choosing one delivers the answer to the agent
 *  that's blocked and clears the question; "Skip" just removes it. */
function QuestionRow({ q, onDone }: { q: BlockerQuestion; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function choose(option: string) {
    setBusy(true); setErr('');
    try {
      const answer = `Decision for task “${q.taskTitle ?? q.taskRef ?? ''}”. You asked: ${q.question} — the answer is: ${option}. Proceed accordingly.`;
      if (q.agent) void call('dispatch', `/ask ${q.agent} ${qArg(answer)}`).catch(() => {}); // deliver async; don't block the UI
      await call('questions:remove', q.id);
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function skip() {
    setBusy(true); setErr('');
    try { await call('questions:remove', q.id); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="inbox-row">
      <div className="inbox-from">{q.agent || 'agent'}{q.taskTitle ? ` · ${q.taskTitle}` : ''}</div>
      <div className="inbox-msg b">{q.question}</div>
      <div className="row-actions" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {q.options.map((o) => (
          <button key={o} className="btn" disabled={busy} onClick={() => void choose(o)} title={`Answer “${o}” and unblock ${q.agent}`}>{o}</button>
        ))}
        <span className="grow" />
        <button className="btn small" disabled={busy} onClick={() => void skip()} title="Dismiss without answering">Skip</button>
      </div>
      {err ? <p className="status-error small">{err}</p> : null}
    </div>
  );
}

/** One manager-inbox item, with an inline reply box and a dismiss button. */
function InboxRow({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    const msg = reply.trim();
    if (!msg) return;
    setBusy(true); setErr('');
    try { await call('inbox:respond', item.query_id, msg); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function dismiss() {
    setBusy(true); setErr('');
    try { await call('inbox:dismiss', item.query_id); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="inbox-row">
      <div className="inbox-from">{item.from ?? 'manager'}</div>
      <div className="inbox-msg">{item.message}</div>
      <div className="row-actions" style={{ marginTop: 8, gap: 8, alignItems: 'flex-start' }}>
        <textarea
          style={{ flex: 1, minHeight: 46, fontSize: 13, resize: 'vertical' }}
          placeholder="type a reply… (⌘/Ctrl+Enter to send)"
          value={reply}
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
        />
        <button className="btn primary" disabled={busy || !reply.trim()} onClick={() => void send()}>
          {busy ? '…' : 'Send reply'}
        </button>
        <button className="btn" disabled={busy} onClick={() => void dismiss()} title="Clear without replying">
          Dismiss
        </button>
      </div>
      {err ? <p className="status-error small">{err}</p> : null}
    </div>
  );
}
