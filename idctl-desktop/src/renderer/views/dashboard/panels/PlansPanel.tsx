// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { call } from '../../../store.ts';

type BrainPlan = { file: string; num?: string; title: string; status: string; mtime?: number };
type DraftPlan = { id: string; title: string; status: string };

export function PlansPanel({ onOpenWork }: { onOpenWork: () => void }) {
  const [brainPlans, setBrainPlans] = useState<BrainPlan[]>([]);
  const [drafts, setDrafts] = useState<DraftPlan[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [brain, local] = await Promise.all([
      call<{ plans?: BrainPlan[] }>('brain:plans').catch(() => ({ plans: [] as BrainPlan[] })),
      call<DraftPlan[]>('plans:list', 'default').catch(() => []),
    ]);
    setBrainPlans(brain.plans ?? []);
    setDrafts(local);
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true); setStatus('Creating plan through Manager…');
    try {
      await call('brain:createPlan', title.trim(), content.trim());
      setTitle(''); setContent(''); setStatus('Plan created.'); await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const updateStatus = async (plan: BrainPlan, next: string) => {
    setBusy(true); setStatus(`Updating ${plan.title}…`);
    try {
      await call('brain:setPlanStatus', plan.file, next, null, { status: plan.status, mtime: plan.mtime });
      setStatus(`Plan marked ${next}.`); await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="driver-panel">
      <div className="driver-heading"><strong>Plans</strong><span className="muted small">{brainPlans.length} Brain · {drafts.length} drafts</span><button className="btn" onClick={onOpenWork}>Open Work</button></div>
      <label className="driver-objective">Plan title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="driver-objective">Objective and acceptance criteria<textarea value={content} onChange={(event) => setContent(event.target.value)} /></label>
      <button className="btn primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void create()}>Create plan</button>
      <hr />
      {brainPlans.slice(0, 12).map((plan) => (
        <div className="driver-task-row" key={plan.file}>
          <span><strong>{plan.title}</strong><br /><span className="muted small">{plan.num ? `#${plan.num} · ` : ''}{plan.status}</span></span>
          <select value={plan.status} disabled={busy} onChange={(event) => void updateStatus(plan, event.target.value)}>
            {['PENDING', 'ACTIVE', 'PARTIAL', 'BLOCKED', 'PAUSED', 'DONE'].map((value) => <option key={value}>{value}</option>)}
          </select>
        </div>
      ))}
      {status ? <div className="driver-status" aria-live="polite">{status}</div> : null}
    </div>
  );
}
