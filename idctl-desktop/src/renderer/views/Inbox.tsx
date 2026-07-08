import { useEffect, useMemo, useState } from 'react';
import { call, useSyncVersion, type FleetStore } from '../store.ts';
import type { InboxItem } from '../../../../idctl/src/api/types.ts';
import { planInboxStatusForOption } from '../../shared/planInbox.ts';

type BlockerQuestion = { id: string; question: string; options: string[]; agent: string; taskRef?: string; taskTitle?: string; team: string; createdAt: number; seenCount?: number; lastSeenAt?: number; source?: string; metadata?: Record<string, unknown> };
type QuestionAction = { label: string; value: string; title: string; primary?: boolean };
type QuestionPresentation = {
  eyebrow: string;
  title: string;
  detail: string;
  recommendation?: string;
  actions: QuestionAction[];
  raw?: string;
};
function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

/** Order decisions so a prerequisite task's decision comes BEFORE a dependent's.
 *  depth(ref) = 0 with no prereqs, else 1 + max(depth(prereq)). Sort by depth, then
 *  original order (stable) for ties / decisions not tied to a task. Cycle-safe. */
function orderByDeps(qs: BlockerQuestion[], deps: Record<string, string[]>): BlockerQuestion[] {
  const memo = new Map<string, number>();
  const onStack = new Set<string>();
  const depth = (ref: string): number => {
    if (memo.has(ref)) return memo.get(ref)!;
    if (onStack.has(ref)) return 0; // cycle guard
    onStack.add(ref);
    let d = 0;
    for (const p of (deps[ref] ?? [])) d = Math.max(d, 1 + depth(p));
    onStack.delete(ref);
    memo.set(ref, d);
    return d;
  };
  return qs.map((q, i) => ({ q, i, d: q.taskRef ? depth(q.taskRef) : 0 }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.q);
}

function planRecoveryReason(q: BlockerQuestion): string {
  const phase = String(q.metadata?.phase ?? '').replace(/-/g, ' ').trim();
  const reason = String(q.metadata?.reason ?? q.metadata?.error ?? '').trim();
  if (reason) return phase ? `${phase}: ${reason}` : reason;
  const m = q.question.match(/\.\s*([^.]*(?:failed|unavailable|blocked|deferred|capacity|agent failed)[^.]*)$/i);
  return m?.[1]?.trim() || 'Plan automation needs a recovery pass before work continues.';
}

function presentQuestion(q: BlockerQuestion): QuestionPresentation {
  const options = q.options.length ? q.options : ['Acknowledge'];
  const actions: QuestionAction[] = options.map((value) => ({ label: value, value, title: `Answer "${value}"` }));
  const isPlanQuestion = q.taskRef?.startsWith('plan:') ?? false;
  if (!isPlanQuestion) {
    return {
      eyebrow: [q.team, q.agent].filter(Boolean).join(' · ') || 'Decision',
      title: q.question,
      detail: '',
      actions,
    };
  }
  const planTitle = q.taskTitle || q.taskRef?.replace(/^plan:/, '') || 'this plan';
  const failedBeforeDelegation = /failed before it could delegate|could not create live delegated|could not complete .*preflight|could not decompose|could not dispatch/i.test(q.question);
  const relabeled = actions.map((action, index): QuestionAction => {
    const value = action.value;
    if (/retry/i.test(value)) {
      return {
        ...action,
        label: failedBeforeDelegation ? 'Retry with delegation fallback' : 'Retry recovery pass',
        title: 'Ask the plan owner to run the work pass again using the deterministic team-lead fallback if the planner fails.',
        primary: index === 0,
      };
    }
    if (/hold|pause/i.test(value)) {
      return {
        ...action,
        label: 'Pause plan',
        title: 'Keep the plan paused until the underlying agent/capacity issue is resolved.',
      };
    }
    if (/review/i.test(value)) {
      return {
        ...action,
        label: 'Review then continue',
        title: 'Review the blocker manually, then continue the plan when ready.',
      };
    }
    return action;
  });
  return {
    eyebrow: [q.team, q.agent, 'Work > Plans'].filter(Boolean).join(' · '),
    title: failedBeforeDelegation ? 'Plan delegation needs a recovery pass' : 'Plan needs your decision',
    detail: `Plan: ${planTitle}`,
    recommendation: failedBeforeDelegation
      ? `Recommended: retry the work pass. If planner delegation fails again, the current build creates bounded coordination tasks for active team leads and records unresolved delegation here. Technical reason: ${planRecoveryReason(q)}`
      : planRecoveryReason(q),
    actions: relabeled,
    raw: q.question,
  };
}

export function Inbox({ store }: { store: FleetStore }) {
  const syncVersion = useSyncVersion(['questions', 'inbox', 'tasks', 'work']);
  const [questions, setQuestions] = useState<BlockerQuestion[]>([]);
  const [deps, setDeps] = useState<Record<string, string[]>>({});
  async function reloadQuestions() {
    setQuestions(await call<BlockerQuestion[]>('questions:list').catch(() => []));
    setDeps(await call<Record<string, string[]>>('tasks:deps').catch(() => ({})));
  }
  useEffect(() => { void reloadQuestions(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store.lastUpdated, syncVersion]);
  const ordered = useMemo(() => orderByDeps(questions, deps), [questions, deps]);

  const total = store.inbox.length + questions.length;
  return (
    <div className="view">
      <header className="view-head">
        <h1>Inbox</h1>
        <span className="muted">{total} awaiting you{questions.length ? ` · ${questions.length} decision${questions.length === 1 ? '' : 's'}` : ''}</span>
      </header>

      {questions.length ? (
        <section className="card">
          <h3>Decisions needed <span className="muted small">· in dependency order — answer prerequisites first to unblock what follows</span></h3>
          {ordered.map((q) => <QuestionRow key={q.id} q={q} onDone={() => void reloadQuestions()} />)}
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

/** A decision/blocker an agent surfaced. You can: pick one of the agent's best
 *  options, write your own response, or take it on yourself ("I'll handle it" — tells
 *  the agent to set it aside). Any of these delivers back to the agent and clears it. */
function QuestionRow({ q, onDone }: { q: BlockerQuestion; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  const subject = q.taskTitle ?? q.taskRef ?? '';
  const isLearnQuestion = q.taskRef?.startsWith('learn:') ?? false;
  const isPlanQuestion = q.taskRef?.startsWith('plan:') ?? false;
  const isBrainApproval = q.taskRef?.startsWith('brain-approval:') ?? q.source === 'brain-approvals';
  const isSyntheticQuestion = isLearnQuestion || isPlanQuestion;
  const from = q.agent || (isBrainApproval ? 'Brain governance' : isSyntheticQuestion ? 'review gate' : 'agent');
  const brainApprovalId = isBrainApproval ? String(q.metadata?.approvalId ?? q.taskRef?.split(':')[1] ?? '').trim() : '';
  const presentation = presentQuestion(q);

  // Deliver a response to the blocked agent (best-effort, async) and clear the item.
  // A response moves the task into the board's "Under Review" lane (the block is being
  // worked on the back of your answer); it auto-resolves once the agent progresses.
  async function deliver(answer: string) {
    setBusy(true); setErr('');
    try {
      if (q.agent && !isSyntheticQuestion && !isBrainApproval && answer) void call('dispatch', `/ask ${q.agent} ${qArg(answer)}`).catch(() => {});
      if (q.taskRef && !isSyntheticQuestion) void call('tasks:setReview', q.taskRef, 'under-review').catch(() => {});
      await call('questions:remove', q.id);
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function resolvePlanQuestion(option: string) {
    setBusy(true); setErr('');
    try {
      const file = String(q.metadata?.file ?? q.metadata?.planFile ?? q.taskRef?.slice('plan:'.length) ?? '').trim();
      const status = planInboxStatusForOption(option);
      if (file) {
        await call('plans:recover', {
          file,
          option,
          questionId: q.id,
          comment: comment.trim(),
          status,
        });
      } else {
        await call('questions:remove', q.id);
      }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function resolveBrainApproval(option: string) {
    const status = /reject|deny|keep current|keep separate|separate/i.test(option) ? 'rejected' : 'approved';
    setBusy(true); setErr('');
    try {
      await call('brainApproval:resolve', brainApprovalId, status, option);
      await call('questions:remove', q.id).catch(() => undefined);
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function openBrainHealth() {
    setBusy(true); setErr('');
    try { await call('brain:openDashboard', 'health'); setBusy(false); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  const chooseOption = (o: string) => isBrainApproval
    ? resolveBrainApproval(o)
    : isPlanQuestion
      ? resolvePlanQuestion(o)
    : deliver(`Decision on “${subject}”. You asked: ${q.question} — the user chose: ${o}. Proceed accordingly.`);
  const sendComment = () => {
    const c = comment.trim();
    if (!c) return;
    if (isPlanQuestion) void resolvePlanQuestion('comment');
    else void deliver(`Response on “${subject}”. You asked: ${q.question} — the user says: ${c}. Proceed accordingly.`);
  };
  const handleManually = () => isPlanQuestion
    ? resolvePlanQuestion("I'll handle it")
    : deliver(`Re “${subject}”: ${q.question} — the USER is handling this manually/independently. Do NOT work on it or re-raise it; set it aside and continue with everything else. The user will follow up when it's done.`);
  async function skip() {
    setBusy(true); setErr('');
    try {
      if (q.taskRef && !isSyntheticQuestion && !isBrainApproval) void call('tasks:setReview', q.taskRef, '').catch(() => {}); // dismissing clears the adjustment state
      await call('questions:remove', q.id); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="inbox-row">
      <div className="inbox-from">
        {presentation.eyebrow || `${q.team ? `${q.team} · ` : ''}${from}`}{q.seenCount && q.seenCount > 1 ? ` · raised ${q.seenCount} times` : ''}
      </div>
      <div className="inbox-msg b" style={{ whiteSpace: 'pre-line' }}>{presentation.title}</div>
      {presentation.detail ? <div className="inbox-detail">{presentation.detail}</div> : null}
      {presentation.recommendation ? <div className="inbox-recommendation">{presentation.recommendation}</div> : null}
      {presentation.raw && presentation.raw !== presentation.title ? (
        <details className="inbox-raw">
          <summary>technical detail</summary>
          <div>{presentation.raw}</div>
        </details>
      ) : null}
      {/* Options stacked top-to-bottom, hugging the left. */}
      {presentation.actions.length ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          {presentation.actions.map((action) => (
            <button key={action.value} className={`btn${action.primary ? ' primary' : ''}`} style={{ textAlign: 'left' }} disabled={busy} onClick={() => void chooseOption(action.value)} title={isBrainApproval ? `${action.value}; Brain apply remains separate` : action.title}>{action.label}</button>
          ))}
        </div>
      ) : null}
      {/* Then the secondary actions, underneath the options. */}
      <div className="row-actions" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {isBrainApproval ? (
          <button className="btn small" disabled={busy} onClick={() => void openBrainHealth()} title="Open the Brain Health triage view without changing this approval">Open Brain Health</button>
        ) : (
          <>
            <button className="btn small" disabled={busy} onClick={() => setShowComment((v) => !v)} title="Write your own response instead of picking an option">✎ Comment</button>
            <button className="btn small" disabled={busy} onClick={() => void handleManually()} title="You'll handle this yourself — the agent sets it aside and won't re-raise it">🛠 I'll handle it</button>
          </>
        )}
        <button className="btn small" disabled={busy} onClick={() => void skip()} title={isBrainApproval ? 'Dismiss locally; unresolved Brain approvals may return on the next sync' : 'Dismiss without answering'}>{isBrainApproval ? 'Dismiss locally' : 'Skip'}</button>
      </div>
      {showComment ? (
        <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea style={{ flex: 1, minHeight: 48 }} placeholder="Write your response / instructions for the agent… (⌘/Ctrl+Enter to send)" value={comment} disabled={busy} autoFocus
            onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void sendComment(); }} />
          <button className="btn primary" disabled={busy || !comment.trim()} onClick={() => void sendComment()}>{busy ? '…' : 'Send'}</button>
        </div>
      ) : null}
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
