import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import { useToast } from '../components/toast.tsx';
import { buildPrimaryLeadPlanWork } from '../../shared/planWork.ts';
import { primaryLeadReadiness } from '../../shared/planRouting.ts';

/**
 * Plans tab (under Work). Two sets, one shared organizer (search / sort /
 * optional filters / completed visibility) at the top:
 *  - Brain plans — the LIVE plan set the brain maintains on disk. Read-only content,
 *    but per-plan actions can AUDIT the real status (and write it back), find BLOCKERS,
 *    COMPILE the plan into tasks, or set it PENDING.
 *  - Your drafts — local AI-generated plans you draft + finalize, then PROMOTE into the
 *    living brain plans. Lifecycle: draft (AI-assisted) → active (human edits) → done
 *    (finalized) → ↑ Promote → a brain plan at ⏳ pending → 🔄 partial → ✅ done.
 */

type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
type PlanRevision = { version: number; at: number; note: string; content: string };
interface Plan {
  id: string; title: string; request: string; agent?: string; team: string;
  status: PlanStatus; content: string; version: number; revisions: PlanRevision[];
  tags?: string[]; createdAt: number; updatedAt: number;
}
type PlanSummary = { id: string; title: string; status: PlanStatus; version: number; agent?: string; team: string; createdAt: number; updatedAt: number; tags?: string[] };
type BrainPlan = { num?: string; title: string; file: string; status?: string; effort?: string; notes?: string; mtime?: number };
type BrainPlansResp = { dir: string | null; plans: BrainPlan[] };
type BrainPlanField = 'title' | 'status' | 'mtime';
type DraftPlanField = 'title' | 'status' | 'version' | 'updatedAt' | 'content' | 'tags';
type SortMode = 'recent' | 'title' | 'status';
type BrainStatusKey = 'pending' | 'partial' | 'hold' | 'done';
type BrainStatusWrite = 'PENDING' | 'PARTIAL' | 'PAUSED' | 'DONE';
type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
type GoalPriority = 'primary' | 'secondary' | 'general';
interface Goal {
  id: string; title: string; idea: string; agent?: string; team: string;
  status: GoalStatus; priority?: GoalPriority; autopilot?: boolean; content: string;
  driver?: { lastRunAt?: number; taskRefs?: string[]; note?: string };
  createdAt: number; updatedAt: number;
}

// Auto-decompose IPC shapes (mirror main/work.ts) for "compile into tasks".
type SubTask = { title: string; description: string; agent: string; dependsOn: number[] };
type DecomposeResult = { ok: boolean; subtasks: SubTask[]; raw: string; error?: string };
type CreatedTask = { ok: boolean; ref?: string; title?: string; agent?: string; error?: string; warning?: string; deferred?: boolean };
type CreatePlanResult = { created: CreatedTask[]; dispatched: number; deferred: number };
type TeamLead = { team: string; lead: string | null; activeCount: number; totalCount: number };
type FanoutResult = { team: string; lead?: string; status: 'dispatched' | 'deferred' | 'no-active-agent' | 'failed'; queryId?: string; detail?: string };
type TeamLeadDelegatedTask = CreatedTask & { team: string; lead: string };
type TeamLeadDelegationResult = { ok: boolean; targetCount: number; subtasks: SubTask[]; created: TeamLeadDelegatedTask[]; dispatched: number; deferred: number; errors: string[]; raw?: string };

const STATUSES: PlanStatus[] = ['draft', 'active', 'done', 'archived'];
const STATUS_CLASS: Record<PlanStatus, string> = { draft: 'st-paused', active: 'st-active', done: 'st-done', archived: 'st-blocked' };
const BRAIN_BUCKETS: { key: BrainStatusKey; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'partial', label: 'Partial' },
  { key: 'hold', label: 'Paused' },
  { key: 'done', label: 'Done' },
];
const BRAIN_KEY_CLASS: Record<BrainStatusKey, string> = { done: 'st-done', partial: 'st-active', pending: 'st-paused', hold: 'st-blocked' };
const BRAIN_STATUS_ACTIONS: { write: BrainStatusWrite; key: BrainStatusKey; label: string; confirm: string }[] = [
  { write: 'PENDING', key: 'pending', label: 'Set pending', confirm: 'queue it for a future work pass' },
  { write: 'PARTIAL', key: 'partial', label: 'Mark partial', confirm: 'show that work is underway or partly complete' },
  { write: 'PAUSED', key: 'hold', label: 'Pause', confirm: 'pause it until a blocker or dependency clears' },
  { write: 'DONE', key: 'done', label: 'Mark done', confirm: 'move it into completed plans' },
];
function brainStatusKey(s?: string): BrainStatusKey {
  const t = (s || '').toLowerCase();
  if (/done|✅/.test(t)) return 'done';
  if (/partial|🔄|progress/.test(t)) return 'partial';
  if (/hold|pause|paused|🛑|block/.test(t)) return 'hold';
  return 'pending';
}
function brainStatusLabel(key: BrainStatusKey): string {
  return BRAIN_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

function qArg(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function newId(): string { return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function splitTags(s: string): string[] { return [...new Set(s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))]; }
function isPromotedDraft(p: { tags?: string[] }): boolean { return (p.tags ?? []).some((t) => /^→ plan /.test(t)); }
function ago(ts: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
/** Absolute local date-time (for tooltips). */
function abs(ts: number): string { return ts ? new Date(ts).toLocaleString() : '—'; }
function group<T>(items: T[], keyOf: (x: T) => string, buckets: { key: string; label: string }[]) {
  return buckets.map((b) => ({ ...b, items: items.filter((x) => keyOf(x) === b.key) })).filter((g) => g.items.length);
}

const GEN_PROMPT = (req: string) =>
  `Create a clear, structured implementation plan for this request. Use Markdown: a one-line overview, then numbered phases with concrete steps, dependencies, and risks/considerations. Be specific and actionable.\n\nRequest: ${req}`;
const UPDATE_PROMPT = (content: string, instr: string) =>
  `Here is the current plan (Markdown):\n\n${content}\n\nRevise it according to these instructions: ${instr}\n\nReturn the COMPLETE updated plan in Markdown (the full document, not just the changes).`;
const SUGGEST_PROMPT = (content: string) =>
  `Review this implementation plan and list 3-6 concrete, high-value improvements as short imperative instructions, ONE per line, no preamble or numbering (e.g. "Add a rollback step to phase 3"). Plan:\n\n${content}`;
const AUDIT_PROMPT = (title: string, content: string) =>
  'Audit the TRUE current status of this implementation plan. Verify against the ACTUAL codebase and your knowledge — use your tools to check what is really implemented; do NOT just trust the plan\'s own claims. Reply with JSON ONLY (no prose, no fences): {"status":"DONE|PARTIAL|PENDING|PAUSED","summary":"<1-3 sentences: what is actually done and what remains>"}.\n\nUse PAUSED only when the plan cannot safely progress without a blocker, operator decision, or external dependency. PLAN: ' + title + '\n\n' + content;
const BLOCKERS_PROMPT = (title: string, content: string) =>
  'Review this plan and surface anything that needs the USER — a hard blocker, a decision (a genuine fork), a confirmation before touching shared/live infra, or a piece of MANUAL work only the user can do. Verify against the actual codebase where relevant. Return JSON ONLY (no prose, no code fences): ' +
  '[{"question":"<what you need from the user — 1-2 sentences with the key context so they can decide fast>","options":["<best option A>","<best option B>", ...]}]. ' +
  'Give 2-4 concrete BEST options when there is a decision; for a confirmation use ["Approve","Hold off"]; if it needs the user to do manual work, say so in the question and use ["I\'ll do it","Skip for now"]. ' +
  'Only include things that truly need the USER (not work you can just do). Return [] if nothing needs the user. PLAN: ' + title + '\n\n' + content;

export function Plans({ store }: { store: FleetStore }) {
  const draftSyncVersion = useSyncVersion(['plans', 'work', 'brain']);
  const brainSyncVersion = useSyncVersion(['brain-plans', 'brain', 'plans', 'work', 'tasks']);
  const team = store.team ?? 'default';
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [detail, setDetail] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [req, setReq] = useState('');
  const [agent, setAgent] = useState('');
  const [updInstr, setUpdInstr] = useState('');
  const [updAgent, setUpdAgent] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [viewVer, setViewVer] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const aliveRef = useRef(true);
  const genTok = useRef(0);
  const toast = useToast();
  useEffect(() => () => { aliveRef.current = false; }, []);
  function cancel() { genTok.current++; setBusy(false); setMsg('cancelled'); }

  const genAgent = (agent && store.agents.some((a) => a.name === agent) ? agent : coordinator);
  const okContent = (s: string) => { const t = (s || '').trim(); return t && t !== '(empty reply)' && t !== '(no reply)' ? t : ''; };
  const names = useMemo(() => store.agents.map((a) => a.name), [store.agents]);

  // ---- organizer (shared, top) ----
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [groupBy, setGroupBy] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [draftStatus, setDraftStatus] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [brainStatus, setBrainStatus] = useState<Set<string>>(new Set());
  const toggle = (set: (u: (prev: Set<string>) => Set<string>) => void, v: string) =>
    set((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; });

  async function reload() {
    let list = await call<PlanSummary[]>('plans:list', team).catch(() => []);
    const promoted = list.filter(isPromotedDraft);
    if (promoted.length) {
      await Promise.all(promoted.map((p) => call('plans:remove', p.id).catch(() => {})));
      list = await call<PlanSummary[]>('plans:list', team).catch(() => []);
      if (detail && promoted.some((p) => p.id === detail.id)) setDetail(null);
    }
    setPlans(list);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team, store.lastUpdated, draftSyncVersion]);

  // ---- brain plans (live, read-only content) ----
  const [brain, setBrain] = useState<BrainPlansResp>({ dir: null, plans: [] });
  const [brainOpen, setBrainOpen] = useState<string | null>(null);
  const [brainContent, setBrainContent] = useState('');
  async function reloadBrain() { setBrain(await call<BrainPlansResp>('brain:plans').catch(() => ({ dir: null, plans: [] }))); }
  useEffect(() => {
    void reloadBrain();
    const id = setInterval(() => { void reloadBrain(); }, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, store.lastUpdated, brainSyncVersion]);
  async function openBrain(file: string) {
    if (brainOpen === file) { setBrainOpen(null); setBrainContent(''); return; }
    setBrainOpen(file); setBrainContent('loading…');
    const r = await call<{ file: string; content: string } | null>('brain:plan', file).catch(() => null);
    if (aliveRef.current) setBrainContent(r?.content ?? '(could not read this plan)');
  }

  // ---- per-brain-plan actions ----
  const [busyFile, setBusyFile] = useState<string | null>(null); // one brain-plan action at a time
  const [audit, setAudit] = useState<Record<string, { from?: string; to?: string; summary: string }>>({});
  const [blockers, setBlockers] = useState<Record<string, string>>({});
  type StatusWrite = { ok: boolean; from?: string; to?: string; error?: string; stale?: boolean; current?: { status?: string; mtime?: number } };
  const changedText = (before: string | number | undefined, after: string | number | undefined) => `${String(before || 'none')} -> ${String(after || 'none')}`;
  function brainStamp(p: BrainPlan): Record<BrainPlanField, string | number | undefined> {
    return { title: p.title, status: p.status ?? '', mtime: p.mtime };
  }
  async function ensureBrainPlanFresh(p: BrainPlan, action: string, fields: BrainPlanField[] = ['title', 'status', 'mtime'], quiet = false): Promise<BrainPlan | null> {
    const current = (await call<BrainPlansResp>('brain:plans').catch(() => ({ dir: null, plans: [] }))).plans.find((x) => x.file === p.file) ?? null;
    if (!current) {
      if (!quiet) {
        window.alert(`${action} blocked: this brain plan no longer exists in the live plan index.`);
        await reloadBrain();
      }
      return null;
    }
    const before = brainStamp(p);
    const after = brainStamp(current);
    const changed = fields.filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
    if (changed.length) {
      if (!quiet) {
        window.alert([
          `${action} blocked: "${p.title}" changed since this card was rendered.`,
          '',
          ...changed.map((field) => `- ${field}: ${changedText(before[field], after[field])}`),
          '',
          'Plans will refresh; review the current brain plan before applying another change.',
        ].join('\n'));
        await reloadBrain();
      }
      return null;
    }
    return current;
  }
  function draftStamp(p: Plan): Record<DraftPlanField, string | number | undefined> {
    return { title: p.title, status: p.status, version: p.version, updatedAt: p.updatedAt, content: p.content, tags: JSON.stringify(p.tags ?? []) };
  }
  async function ensureDraftPlanFresh(p: Plan, action: string, fields: DraftPlanField[] = ['version', 'updatedAt']): Promise<Plan | null> {
    const current = await call<Plan | null>('plans:get', p.id).catch(() => null);
    if (!current) {
      window.alert(`${action} blocked: this draft plan no longer exists.`);
      await reload();
      setDetail(null);
      return null;
    }
    const before = draftStamp(p);
    const after = draftStamp(current);
    const changed = fields.filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
    if (changed.length) {
      window.alert([
        `${action} blocked: "${p.title}" changed since this editor was opened.`,
        '',
        ...changed.map((field) => `- ${field}: ${field === 'content' ? 'changed' : changedText(before[field], after[field])}`),
        '',
        'The draft will refresh; review the current plan before applying another change.',
      ].join('\n'));
      setDetail(current);
      setTagInput((current.tags ?? []).join(', '));
      await reload();
      return null;
    }
    return current;
  }

  async function currentBrainPlan(file: string): Promise<BrainPlan | null> {
    return (await call<BrainPlansResp>('brain:plans').catch(() => ({ dir: null, plans: [] }))).plans.find((x) => x.file === file) ?? null;
  }

  async function writeBrainStatus(current: BrainPlan, status: BrainStatusWrite, action: string): Promise<StatusWrite> {
    const res = await call<StatusWrite>('brain:setPlanStatus', current.file, status, null, { status: current.status, mtime: current.mtime })
      .catch((): StatusWrite => ({ ok: false, error: 'write failed' }));
    if (res.stale) {
      await reloadBrain();
      throw new Error(res.error ?? `${action} blocked: plan changed while writing status`);
    }
    await reloadBrain();
    return res;
  }

  async function applyBrainStatus(p: BrainPlan, status: BrainStatusWrite) {
    const action = BRAIN_STATUS_ACTIONS.find((x) => x.write === status);
    const fresh = await ensureBrainPlanFresh(p, action?.label ?? `Set ${p.title} status`);
    if (!fresh) return;
    const currentKey = brainStatusKey(fresh.status);
    if (action && currentKey === action.key) { setMsg(`"${fresh.title}" is already ${brainStatusLabel(action.key).toLowerCase()}`); return; }
    if (!window.confirm(`${action?.label ?? 'Update status'} for "${fresh.title}"?\n\nThis writes the live brain plan status to ${brainStatusLabel(action?.key ?? brainStatusKey(status))} and will ${action?.confirm ?? 'update the plan lifecycle state'}.`)) return;
    setBusyFile(fresh.file); setMsg(`${action?.label ?? 'Updating status'} for "${fresh.title}"...`);
    try {
      const res = await writeBrainStatus(fresh, status, action?.label ?? 'Update status');
      if (aliveRef.current) setMsg(res.ok ? `"${fresh.title}" ${res.from} -> ${res.to}` : `failed: ${res.error ?? 'n/a'}`);
    } catch (e) {
      if (aliveRef.current) setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusyFile(null);
    }
  }

  type AuditResult = { text: string; key?: BrainStatusKey; summary: string };
  type BlockerResult = { text: string; added: number };
  type DispatchResult = { text: string; dispatched: boolean };

  // ── Unified "Work" pipeline: AUDIT → FIND BLOCKERS → COMPILE & DISPATCH ──────────
  // One button. The plan is first audited (real status refreshed), then scanned for
  // blockers. Blockers pause the plan and surface Inbox questions; clear plans are
  // delegated and then marked PARTIAL so pending/partial/paused/done stay meaningful.
  async function auditCore(p: BrainPlan): Promise<AuditResult> {
    const who = genAgent;
    if (!who) return { text: 'no agent to audit', summary: '' };
    const baseline = await ensureBrainPlanFresh(p, `Audit ${p.title}`);
    if (!baseline) throw new Error('plan changed; refreshed');
    const got = await call<{ file: string; content: string } | null>('brain:plan', baseline.file).catch(() => null);
    let reply = '';
    try {
      reply = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(AUDIT_PROMPT(baseline.title, got?.content ?? ''))}`));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await relayPlanBlocker(baseline, `Work > Plans could not complete the audit preflight for "${baseline.title}". Delegation will continue, but review the plan status manually. ${reason}`, {
        agent: who,
        key: `audit-preflight:${reason}`,
        options: ['Review plan status', 'Retry work pass', 'Hold this plan'],
        metadata: { phase: 'audit-preflight', reason },
      });
      if (aliveRef.current) setAudit((m) => ({ ...m, [baseline.file]: { summary: `audit preflight failed: ${reason}` } }));
      return { text: `audit skipped: ${reason}`, summary: reason };
    }
    const a = reply.indexOf('{'); const b = reply.lastIndexOf('}');
    const obj = a >= 0 && b > a ? (() => { try { return JSON.parse(reply.slice(a, b + 1)); } catch { return null; } })() : null;
    const status = String(obj?.status ?? '').trim();
    const summary = String(obj?.summary ?? '').trim() || reply.slice(0, 300);
    if (!status) {
      if (aliveRef.current) setAudit((m) => ({ ...m, [baseline.file]: { summary } }));
      return { text: 'no clear status', summary };
    }
    const fresh = await ensureBrainPlanFresh(baseline, `Audit ${baseline.title}`);
    if (!fresh) throw new Error('plan changed while audit was running; refreshed');
    const res = await writeBrainStatus(fresh, status as BrainStatusWrite, `Audit ${fresh.title}`);
    if (aliveRef.current) setAudit((m) => ({ ...m, [fresh.file]: { from: res.from, to: res.to, summary } }));
    const key = res.to ? brainStatusKey(res.to) : brainStatusKey(status);
    return { text: res.ok ? `${res.from} -> ${res.to}` : 'audit (write failed)', key, summary };
  }
  async function blockersCore(p: BrainPlan): Promise<BlockerResult> {
    const who = genAgent;
    if (!who) return { text: 'no agent', added: 0 };
    const baseline = await ensureBrainPlanFresh(p, `Scan blockers for ${p.title}`, ['title', 'mtime']);
    if (!baseline) throw new Error('plan changed; refreshed');
    const got = await call<{ file: string; content: string } | null>('brain:plan', baseline.file).catch(() => null);
    let reply = '';
    try {
      reply = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(BLOCKERS_PROMPT(baseline.title, got?.content ?? ''))}`));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await relayPlanBlocker(baseline, `Work > Plans could not complete the blocker preflight for "${baseline.title}". Delegation will continue, but unresolved blocker review may still be needed. ${reason}`, {
        agent: who,
        key: `blocker-preflight:${reason}`,
        options: ['Review blockers manually', 'Retry work pass', 'Hold this plan'],
        metadata: { phase: 'blocker-preflight', reason },
      });
      if (aliveRef.current) setBlockers((m) => ({ ...m, [baseline.file]: `preflight failed -> Inbox; continuing` }));
      return { text: `blocker scan skipped: ${reason}`, added: 0 };
    }
    // Route anything needing the USER to the Inbox as a decision (option or comment),
    // instead of dumping text into the plan card.
    const a = reply.indexOf('['); const b = reply.lastIndexOf(']');
    const arr = a >= 0 && b > a ? (() => { try { return JSON.parse(reply.slice(a, b + 1)); } catch { return []; } })() : [];
    const fresh = await ensureBrainPlanFresh(baseline, `Scan blockers for ${baseline.title}`, ['title', 'mtime']);
    if (!fresh) throw new Error('plan changed while blocker scan was running; refreshed');
    let added = 0;
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const question = String(it?.question ?? '').trim();
      if (!question) continue;
      const options = (Array.isArray(it?.options) ? it.options : []).map((o: unknown) => String(o)).filter(Boolean);
      if (await relayPlanBlocker(fresh, question, {
        options: options.length ? options : ['Acknowledge'],
        agent: who,
        key: `agent-blocker:${added}:${question}`,
        metadata: { phase: 'blocker-scan' },
      })) added++;
    }
    if (aliveRef.current) setBlockers((m) => ({ ...m, [fresh.file]: added ? `${added} decision${added === 1 ? '' : 's'} → Inbox` : 'nothing needs you' }));
    return { text: added ? `${added} -> Inbox` : 'no blockers', added };
  }

  async function savePrimaryLeadPlanGoal(goal: Goal): Promise<Goal> {
    const existing = await call<Goal | null>('goals:get', goal.id).catch(() => null);
    const next: Goal = {
      ...(existing ?? goal),
      ...goal,
      status: 'active',
      priority: existing?.priority ?? goal.priority ?? 'general',
      autopilot: false,
      createdAt: existing?.createdAt || goal.createdAt,
      updatedAt: Date.now(),
      driver: {
        ...(existing?.driver ?? {}),
        ...(goal.driver ?? {}),
      },
    };
    await call('goals:save', next);
    return next;
  }

  async function relayPlanBlocker(
    p: BrainPlan,
    question: string,
    opts: { options?: string[]; agent?: string; team?: string; key?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    const q = String(question || '').replace(/\s+/g, ' ').trim();
    if (!q) return false;
    const blockerTeam = opts.team || team || 'default';
    const blockerAgent = opts.agent || genAgent || coordinator || '';
    const key = String(opts.key || q).replace(/\s+/g, '-').slice(0, 96);
    try {
      await call('questions:add', {
        question: q,
        options: opts.options?.length ? opts.options : ['Retry when ready', 'Hold this plan'],
        agent: blockerAgent,
        taskRef: `plan:${p.file}`,
        taskTitle: p.title,
        team: blockerTeam,
        dedupeKey: `plan:${p.file}:${key}`,
        source: 'plans',
        metadata: {
          planFile: p.file,
          planStatus: p.status,
          planNum: p.num,
          ...opts.metadata,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function primaryLeadReady(lead: string, leadTeam: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const live = await call<TeamLead[]>('work:teamLeads', [leadTeam]).catch(() => [] as TeamLead[]);
    const localFleet = store.allAgents.length ? store.allAgents : store.agents.map((a) => ({ ...a, team: store.team ?? 'default' }));
    return primaryLeadReadiness(lead, leadTeam, live, localFleet, store.team ?? 'default');
  }

  // Compile the plan + dispatch to ALL active teams/agents — no selection. The primary
  // (owning) team gets trackable task cards (auto-assigned + worked); every OTHER active
  // team gets the plan handed to its lead, run in parallel.
  //
  // PARTITIONED dispatch (efficient orchestration, no duplicated work): decompose the
  // plan ONCE, group the sub-tasks into dependency CLUSTERS (connected components — so
  // interdependent work stays on one team and its order is honored), then spread the
  // clusters across every active team weighted by capacity (running agents). Independent
  // clusters run in parallel on different teams; each team balances its slice across its
  // own agents. Result: one plan, split across the whole active fleet — never duplicated.
  async function dispatchCore(p: BrainPlan): Promise<DispatchResult> {
    const baseline = await ensureBrainPlanFresh(p, `Dispatch ${p.title}`, ['title', 'mtime']);
    if (!baseline) throw new Error('plan changed; refreshed');
    const got = await call<{ file: string; content: string } | null>('brain:plan', baseline.file).catch(() => null);
    // Phase 3 (CC refactor): hand the plan to the PRIMARY LEAD to decompose, prune already-done
    // work, and delegate to the relevant team leads. The default coder/researcher are validators
    // on the return path, not execution routers. Mechanical path below is the fallback only when
    // no primary lead is online.
    const hier = await call<{ primary: { team: string; agent: string } | null }>('coordinator:hierarchy').catch(() => ({ primary: null }));
    const lead = hier.primary?.agent;
    const leadTeam = hier.primary?.team ?? store.team ?? 'default';
    if (lead) {
      const fresh = await ensureBrainPlanFresh(baseline, `Dispatch ${baseline.title}`, ['title', 'mtime']);
      if (!fresh) throw new Error('plan changed before dispatch; refreshed');
      const work = buildPrimaryLeadPlanWork(fresh, got?.content ?? '', lead, leadTeam);
      const savedGoal = await savePrimaryLeadPlanGoal(work.goal);
      const ready = await primaryLeadReady(lead, leadTeam);
      if (!ready.ok) {
        await relayPlanBlocker(fresh, `Work > Plans saved objective ${savedGoal.id} for "${fresh.title}", but it could not create the primary-lead delegation task because ${ready.reason}.`, {
          agent: lead,
          team: leadTeam,
          key: `primary-lead-unavailable:${ready.reason}`,
          options: ['Restart primary lead and retry', 'Assign manually from Tasks', 'Hold this plan'],
          metadata: { phase: 'primary-lead-ready', goalId: savedGoal.id, reason: ready.reason },
        });
        return { text: `objective ${savedGoal.id} saved, but primary lead is unavailable: ${ready.reason}`, dispatched: false };
      }
      const res = await call<TeamLeadDelegationResult>('work:delegateToTeamLeads', work.objective, {
        currentTeam: leadTeam,
        primaryLead: lead,
      }).catch((e): TeamLeadDelegationResult => ({
        ok: false,
        targetCount: 0,
        subtasks: [],
        created: [],
        dispatched: 0,
        deferred: 0,
        errors: [e instanceof Error ? e.message : String(e)],
      }));
      const created = res.created.filter((c) => c.ok);
      if (!res.ok || !created.length) {
        const reason = (res.errors ?? []).filter(Boolean).join('; ') || 'no live team-lead task was created';
        await relayPlanBlocker(fresh, `Work > Plans saved objective ${savedGoal.id} for "${fresh.title}", but it could not create live delegated team-lead tasks. ${reason}`, {
          agent: lead,
          team: leadTeam,
          key: `team-lead-delegation:${reason}`,
          options: ['Retry after clearing capacity', 'Review active team leads', 'Hold this plan'],
          metadata: { phase: 'team-lead-delegation', goalId: savedGoal.id, reason, targetCount: res.targetCount },
        });
        return { text: `objective ${savedGoal.id} saved, but delegated tasks were not created: ${reason}`, dispatched: false };
      }
      const refs = created.map((task) => task.ref || task.title || `${task.team}/${task.lead}`).filter(Boolean);
      await savePrimaryLeadPlanGoal({
        ...savedGoal,
        driver: {
          ...(savedGoal.driver ?? {}),
          taskRefs: [...new Set([...(savedGoal.driver?.taskRefs ?? []), ...refs])],
          lastRunAt: Date.now(),
          note: `Delegated from brain plan ${work.source} to ${created.length} team-lead task(s)`,
        },
      });
      if (res.dispatched <= 0) {
        const reason = [(res.errors ?? []).join('; '), res.deferred ? `${res.deferred} task(s) waiting on capacity/dependencies` : 'manager did not accept a kickoff'].filter(Boolean).join('; ');
        await relayPlanBlocker(fresh, `Work > Plans created delegated task(s) for "${fresh.title}", but no team-lead kickoff was accepted. ${reason}`, {
          agent: lead,
          team: leadTeam,
          key: `team-lead-kickoff:${reason}`,
          options: ['Retry kickoff', 'Open Tasks and triage manually', 'Hold this plan'],
          metadata: { phase: 'team-lead-kickoff', goalId: savedGoal.id, taskRefs: refs, reason },
        });
        return { text: `objective ${savedGoal.id} + ${created.length} delegated task(s), but kickoff blocked: ${reason}`, dispatched: false };
      }
      if (res.deferred > 0 || (res.errors ?? []).length) {
        const reason = [(res.errors ?? []).join('; '), res.deferred ? `${res.deferred} task(s) deferred by capacity/dependencies` : ''].filter(Boolean).join('; ');
        await relayPlanBlocker(fresh, `Work > Plans delegated "${fresh.title}" to ${created.length} team-lead task(s), but part of the plan still needs triage. ${reason}`, {
          agent: lead,
          team: leadTeam,
          key: `team-lead-delegation-partial:${reason}`,
          options: ['Triage deferred work', 'Continue with dispatched tasks', 'Hold this plan'],
          metadata: { phase: 'team-lead-delegation-partial', goalId: savedGoal.id, taskRefs: refs, reason },
        });
      }
      const teams = [...new Set(created.map((task) => `${task.team}/${task.lead}`))].join(', ');
      const note = [res.deferred ? `${res.deferred} waiting on capacity/dependencies` : 'manager kickoff accepted', (res.errors ?? []).length ? 'partial blocker sent to Inbox' : ''].filter(Boolean).join('; ');
      return { text: `objective ${savedGoal.id} + ${created.length} delegated team-lead task(s) for ${teams}${note ? ` (${note})` : ''}`, dispatched: true };
    }
    // ---- fallback: mechanical decompose + partition + dispatch (no primary lead online) ----
    const obj = `Implement this plan, end to end:\n\n# ${baseline.title}\n\n${got?.content ?? ''}`;
    const who = genAgent;
    if (!who) {
      await relayPlanBlocker(baseline, `Work > Plans could not compile "${baseline.title}" because no active planning agent is available.`, {
        key: 'fallback-no-planning-agent',
        options: ['Restart an agent and retry', 'Hold this plan'],
        metadata: { phase: 'fallback-decompose', reason: 'no planning agent' },
      });
      return { text: 'no agent to compile', dispatched: false };
    }
    // 1) Decompose ONCE → sub-tasks (+ dependency edges).
    const dec = await call<DecomposeResult>('work:decompose', obj, who).catch((): DecomposeResult => ({ ok: false, subtasks: [], raw: '', error: 'decompose failed' }));
    if (!dec.ok || !dec.subtasks.length) {
      const reason = dec.error || 'could not split into tasks';
      await relayPlanBlocker(baseline, `Work > Plans could not decompose "${baseline.title}" into delegated tasks. ${reason}`, {
        agent: who,
        key: `fallback-decompose:${reason}`,
        options: ['Retry decomposition', 'Review plan manually', 'Hold this plan'],
        metadata: { phase: 'fallback-decompose', reason },
      });
      return { text: reason, dispatched: false };
    }
    const fresh = await ensureBrainPlanFresh(baseline, `Dispatch ${baseline.title}`, ['title', 'mtime']);
    if (!fresh) throw new Error('plan changed while decomposition was running; refreshed');
    const subs = dec.subtasks;
    const N = subs.length;
    // 2) Active teams with a running lead + their capacity (running-agent count).
    const allTeams = store.teams.map((t) => t.name).filter(Boolean);
    const leads = (await call<TeamLead[]>('work:teamLeads', allTeams).catch(() => [] as TeamLead[])).filter((l) => l.activeCount > 0 && l.lead);
    if (!leads.length) {
      await relayPlanBlocker(fresh, `Work > Plans could not dispatch "${fresh.title}" because no active team lead is available.`, {
        key: 'fallback-no-active-team-leads',
        options: ['Restart team leads and retry', 'Hold this plan'],
        metadata: { phase: 'fallback-dispatch', reason: 'no active team leads' },
      });
      return { text: 'no active teams to dispatch to', dispatched: false };
    }
    // 3) Dependency clusters (union-find on the dep edges).
    const parent = Array.from({ length: N }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    subs.forEach((s, i) => (s.dependsOn || []).forEach((d) => { if (d >= 0 && d < N && d !== i) parent[find(i)] = find(d); }));
    const clusterMap = new Map<number, number[]>();
    for (let i = 0; i < N; i++) { const r = find(i); (clusterMap.get(r) ?? clusterMap.set(r, []).get(r)!).push(i); }
    const clusters = [...clusterMap.values()].sort((a, b) => b.length - a.length); // biggest first
    // 4) Capacity-weighted assignment: each cluster → the team with the lowest projected
    //    load-per-running-agent (greedy bin-packing).
    const load: Record<string, number> = Object.fromEntries(leads.map((l) => [l.team, 0]));
    const assign: Record<string, number[]> = Object.fromEntries(leads.map((l) => [l.team, []]));
    for (const cl of clusters) {
      const pick = leads.reduce((best, l) =>
        (load[l.team] + cl.length) / Math.max(1, l.activeCount) < (load[best.team] + cl.length) / Math.max(1, best.activeCount) ? l : best, leads[0]);
      assign[pick.team].push(...cl); load[pick.team] += cl.length;
    }
    // 5) Per team → local sub-task batch (remap deps to local indices; clear the agent so
    //    each team balances across ITS own active agents) + create + dispatch.
    const parts: string[] = [];
    for (const l of leads) {
      const idxs = assign[l.team].sort((a, b) => a - b);
      if (!idxs.length) continue;
      const localOf = new Map<number, number>(); idxs.forEach((g, li) => localOf.set(g, li));
      const batch = idxs.map((g) => ({
        title: subs[g].title,
        description: subs[g].description,
        agent: '', // let work:createPlan balance across this team's active agents
        dependsOn: (subs[g].dependsOn || []).filter((d) => localOf.has(d)).map((d) => localOf.get(d) as number),
      }));
      const res = await call<CreatePlanResult>('work:createPlan', obj, batch, { team: l.team, dispatch: true, lane: 'doing', coordinator: l.lead || undefined }).catch((): CreatePlanResult => ({ created: [], dispatched: 0, deferred: 0 }));
      const ok = res.created.filter((c) => c.ok).length;
      if (res.dispatched > 0) parts.push(`${l.team}: ${res.dispatched}/${ok || batch.length} started`);
    }
    if (!parts.length) {
      await relayPlanBlocker(fresh, `Work > Plans split "${fresh.title}" into ${N} task(s), but no team accepted live task creation or dispatch.`, {
        agent: who,
        key: `fallback-nothing-dispatched:${N}`,
        options: ['Retry dispatch after clearing capacity', 'Open Tasks and triage manually', 'Hold this plan'],
        metadata: { phase: 'fallback-dispatch', taskCount: N },
      });
    }
    return { text: parts.length ? `split ${N} tasks -> ${parts.join(' · ')}` : 'nothing dispatched', dispatched: parts.length > 0 };
  }
  // One button → all three phases, single live toast.
  async function runWork(p: BrainPlan) {
    if (busyFile) return;
    const fresh = await ensureBrainPlanFresh(p, `Work ${p.title}`);
    if (!fresh) return;
    if (!window.confirm(`Work plan "${fresh.title}" now?\n\nThis audits the true status, pauses on blockers with Inbox questions, or creates a tracked objective plus manager-backed lead task for remaining work.`)) return;
    setBusyFile(fresh.file);
    const t = toast({ kind: 'progress', text: `Working “${fresh.title}” — auditing status…` });
    try {
      const a = await auditCore(fresh);
      if (a.key === 'done') {
        t.update({ kind: 'success', text: `“${fresh.title}” is done · ${a.summary || a.text}` });
        if (aliveRef.current) setMsg(`audited done · ${a.summary || a.text}`);
        return;
      }
      t.update({ kind: 'progress', text: `Working “${fresh.title}” — scanning for blockers… (${a.text})` });
      const b = await blockersCore(fresh);
      if (b.added > 0) {
        const latest = await currentBrainPlan(fresh.file);
        if (latest && brainStatusKey(latest.status) !== 'done') {
          await writeBrainStatus(latest, 'PAUSED', `Pause ${latest.title}`);
        }
        t.update({ kind: 'success', text: `“${fresh.title}” paused · ${b.text}; answer in Inbox before automation continues.` });
        if (aliveRef.current) setMsg(`paused · ${b.text}`);
        return;
      }
      t.update({ kind: 'progress', text: `Working “${fresh.title}” — creating objective and lead delegation task…` });
      const d = await dispatchCore(fresh);
      if (d.dispatched) {
        const latest = await currentBrainPlan(fresh.file);
        if (latest && brainStatusKey(latest.status) !== 'done') {
          await writeBrainStatus(latest, 'PARTIAL', `Mark ${latest.title} partial after delegation`);
        }
      }
      t.update({ kind: d.dispatched ? 'success' : 'error', text: `“${fresh.title}” ${d.dispatched ? 'delegated' : 'not delegated'} · audited (${a.text}) · ${b.text} · ${d.text}` });
      if (aliveRef.current) setMsg(`audited (${a.text}) · ${b.text} · ${d.text}${d.dispatched ? ' · status -> Partial' : ''}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await relayPlanBlocker(fresh, `Work > Plans failed before it could delegate "${fresh.title}". ${m}`, {
        key: `work-exception:${m}`,
        options: ['Retry work pass', 'Hold this plan'],
        metadata: { phase: 'work-exception', error: m },
      });
      t.update({ kind: 'error', text: `“${fresh.title}” work failed: ${m}` });
      if (aliveRef.current) setMsg(`work failed: ${m}`);
    } finally { if (aliveRef.current) setBusyFile(null); }
  }

  async function open(id: string) {
    if (detail?.id === id) { setDetail(null); return; }
    setViewVer(null); setShowLog(false); setConfirmDel(false); setUpdInstr('');
    const p = await call<Plan | null>('plans:get', id).catch(() => null);
    setDetail(p);
    const a = p?.agent;
    setUpdAgent(a && names.includes(a) ? a : genAgent);
    setTagInput((p?.tags ?? []).join(', '));
  }
  const reviser = updAgent && names.includes(updAgent) ? updAgent : (detail?.agent && names.includes(detail.agent) ? detail.agent : genAgent);

  async function generate() {
    const request = req.trim();
    if (!request) { setMsg('describe what you want a plan for'); return; }
    if (!genAgent) { setMsg('no agent available to generate the plan'); return; }
    const tok = ++genTok.current;
    setBusy(true); setMsg(`generating plan with ${genAgent}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${genAgent} ${qArg(GEN_PROMPT(request))}`));
      if (genTok.current !== tok) return;
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty plan — try again'); return; }
      const now = Date.now();
      const plan: Plan = {
        id: newId(), title: clip(request, 60), request, agent: genAgent, team, status: 'draft',
        content, version: 1, revisions: [{ version: 1, at: now, note: `Generated from: ${clip(request, 80)}`, content }],
        tags: [], createdAt: now, updatedAt: now,
      };
      await call('plans:save', plan);
      if (!aliveRef.current) return;
      setReq(''); setShowNew(false); setMsg('plan generated ✓');
      await reload();
      setDetail(plan); setViewVer(null); setShowLog(false); setUpdAgent(genAgent); setTagInput('');
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  async function updatePlan() {
    const instr = updInstr.trim();
    if (!detail || !instr) return;
    const base = detail;
    const who = reviser;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`updating plan with ${who}…`);
    try {
      const content = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(UPDATE_PROMPT(base.content, instr))}`));
      if (genTok.current !== tok) return;
      if (!content) { if (aliveRef.current) setMsg('agent returned an empty revision — kept the current version'); return; }
      const current = await ensureDraftPlanFresh(base, `Update plan ${base.title}`, ['version', 'updatedAt', 'content']);
      if (!current) return;
      const now = Date.now();
      const version = current.version + 1;
      const next: Plan = { ...current, content, version, agent: who, revisions: [...current.revisions, { version, at: now, note: instr, content }], updatedAt: now };
      await call('plans:save', next);
      if (!aliveRef.current) return;
      setDetail(next); setUpdInstr(''); setViewVer(null); setMsg(`updated to v${version} ✓`);
      await reload();
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  async function suggest() {
    if (!detail) return;
    const who = reviser;
    const tok = ++genTok.current;
    setBusy(true); setMsg(`asking ${who} for improvements…`);
    try {
      const out = okContent(await call<string>('dispatch', `/ask ${who} ${qArg(SUGGEST_PROMPT(detail.content))}`));
      if (genTok.current !== tok) return;
      if (!out) { if (aliveRef.current) setMsg('no suggestions returned — try again'); return; }
      if (aliveRef.current) { setUpdInstr(out); setMsg('suggestions ready — review/edit below, then Update'); }
    } catch (err) {
      if (aliveRef.current && genTok.current === tok) setMsg(`suggest failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (aliveRef.current && genTok.current === tok) setBusy(false);
    }
  }

  /** Field edit (title/status/tags). "done" no longer auto-files — a done draft stays
   *  visible so you can finalize it and Promote it into the live brain plans (→ ⏳ pending). */
  async function patchPlan(p: Partial<Plan>) {
    if (!detail) return;
    if (p.status && p.status !== detail.status && !window.confirm(`Change draft plan "${detail.title}" status to ${p.status}?\n\nThis writes the saved draft lifecycle state.`)) return;
    const cur = (await call<Plan | null>('plans:get', detail.id).catch(() => null)) ?? detail;
    const next: Plan = { ...cur, ...p, updatedAt: Date.now() };
    setDetail(next);
    await call('plans:save', next).catch(() => {});
    if (aliveRef.current) await reload();
  }

  // Promote a finalized draft into the brain's LIVING plan set: writes a new plan file at
  // ⏳ PENDING (so it enters pending → partial → done), then removes the source draft so
  // there is one visible plan record instead of a stale duplicate.
  async function promoteDraft() {
    if (!detail) return;
    const current = await ensureDraftPlanFresh(detail, `Promote plan ${detail.title}`, ['title', 'status', 'version', 'updatedAt', 'content', 'tags']);
    if (!current) return;
    if (!window.confirm(`Promote "${current.title}" to a live brain plan?\n\nThis writes a new brain plan at PENDING and removes the draft copy so it does not appear twice.`)) return;
    setBusy(true); setMsg(`promoting “${clip(current.title, 40)}” to a live plan…`);
    try {
      const res = await call<{ ok: boolean; file?: string; num?: string; committed?: boolean; error?: string }>('brain:createPlan', current.title, current.content);
      if (!res?.ok) { if (aliveRef.current) setMsg(`promote failed: ${res?.error ?? 'could not write the brain plan'}`); return; }
      await call('plans:remove', current.id).catch(() => {});
      setDetail(null);
      await reloadBrain();
      await reload();
      if (aliveRef.current) setMsg(`promoted → live plan ${res.num} (Pending)${res.committed ? ' · committed' : ' · written'} — draft removed`);
    } catch (e) {
      if (aliveRef.current) setMsg(`promote failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { if (aliveRef.current) setBusy(false); }
  }
  async function remove() {
    if (!detail) return;
    const current = await ensureDraftPlanFresh(detail, `Delete plan ${detail.title}`, ['version', 'updatedAt']);
    if (!current) return;
    await call('plans:remove', current.id).catch(() => {});
    setDetail(null); setConfirmDel(false); setMsg('plan deleted ✓');
    await reload();
  }

  const shownContent = detail ? (viewVer != null ? detail.revisions.find((r) => r.version === viewVer)?.content ?? detail.content : detail.content) : '';
  const allDraftTags = useMemo(() => { const s = new Set<string>(); for (const p of plans) for (const t of p.tags ?? []) s.add(t); return [...s].sort(); }, [plans]);

  const organizedBrain = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = brain.plans.filter((p) => {
      if (brainStatus.size && !brainStatus.has(brainStatusKey(p.status))) return false;
      if (!ql) return true;
      return p.title.toLowerCase().includes(ql) || (p.notes ?? '').toLowerCase().includes(ql) || (p.num ?? '').includes(ql);
    });
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'status') list = [...list].sort((a, b) => BRAIN_BUCKETS.findIndex((x) => x.key === brainStatusKey(a.status)) - BRAIN_BUCKETS.findIndex((x) => x.key === brainStatusKey(b.status)));
    return list;
  }, [brain.plans, q, brainStatus, sort]);

  const organizedDrafts = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = plans.filter((p) => {
      if (draftStatus.size && !draftStatus.has(p.status)) return false;
      if (tagFilter.size && !(p.tags ?? []).some((t) => tagFilter.has(t))) return false;
      if (!ql) return true;
      return p.title.toLowerCase().includes(ql) || (p.agent ?? '').toLowerCase().includes(ql) || (p.tags ?? []).some((t) => t.toLowerCase().includes(ql));
    });
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'status') list = [...list].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
    return list;
  }, [plans, q, draftStatus, tagFilter, sort]);

  // Focus the default view on actionable work. Completed Brain plans and filed drafts are
  // still one click away, and also appear automatically when their status filter is active.
  const brainActive = organizedBrain.filter((p) => brainStatusKey(p.status) !== 'done');
  const brainCompleted = organizedBrain.filter((p) => brainStatusKey(p.status) === 'done');
  const draftActive = organizedDrafts.filter((p) => p.status !== 'archived');
  const draftFiled = organizedDrafts.filter((p) => p.status === 'archived');
  const completedCount = brainCompleted.length + draftFiled.length;
  const hasFilters = Boolean(brainStatus.size || draftStatus.size || tagFilter.size);
  const filterCount = brainStatus.size + draftStatus.size + tagFilter.size;
  const includeCompleted = showCompleted || brainStatus.has('done') || draftStatus.has('archived');
  const brainCounts = BRAIN_BUCKETS.reduce((acc, bucket) => {
    acc[bucket.key] = organizedBrain.filter((p) => brainStatusKey(p.status) === bucket.key).length;
    return acc;
  }, {} as Record<BrainStatusKey, number>);
  const nextWorkPlan =
    brainActive.find((p) => brainStatusKey(p.status) === 'pending')
    ?? brainActive.find((p) => brainStatusKey(p.status) === 'partial')
    ?? brainActive.find((p) => brainStatusKey(p.status) === 'hold')
    ?? null;
  async function runNextPlan() {
    if (!nextWorkPlan) { setMsg('no pending, partial, or paused plans match the current filters'); return; }
    await runWork(nextWorkPlan);
  }

  const statusChips = (ids: string[], active: Set<string>, onToggle: (id: string) => void, labelOf: (id: string) => string, classOf: (id: string) => string) => (
    <span className="chips">
      {ids.map((id) => (
        <button key={id} className={`chip${active.has(id) ? ' on' : ''}`} onClick={() => onToggle(id)} title={`filter: ${labelOf(id)}`}>
          <span className={`st-dot ${classOf(id)}`} /> {labelOf(id)}
        </button>
      ))}
    </span>
  );

  const brainCard = (p: BrainPlan) => {
    const isOpen = brainOpen === p.file;
    const acting = busyFile === p.file;
    const key = brainStatusKey(p.status);
    const workLabel = key === 'hold' ? 'Resume & work' : key === 'partial' ? 'Continue work' : 'Work';
    return (
      <div className={`skill-card plan-row${isOpen ? ' editing' : ''}`} key={p.file}>
        <div className="plan-row-head" onClick={() => void openBrain(p.file)}>
          <div className="plan-row-titleline">
            <span className={`st-badge ${BRAIN_KEY_CLASS[key]}`} title={p.status || brainStatusLabel(key)}>{brainStatusLabel(key)}</span>
            {p.num ? <span className="mono small muted">{p.num}</span> : null}
            <span className="b plan-row-title">{p.title}</span>
            {p.effort ? <span className="muted small plan-row-effort">· {p.effort}</span> : null}
          </div>
          <div className="plan-row-note">
            {p.notes ? <span className="muted small plan-note" title={p.notes}>{p.notes}</span> : null}
            {p.mtime ? <span className="muted small" title={`file last modified ${abs(p.mtime)}`}>updated {ago(p.mtime)}</span> : null}
          </div>
          <div className="plan-row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn small primary" disabled={busyFile !== null}
            title="Audit this plan, pause on blockers with Inbox questions, or delegate remaining work and mark it partial."
            onClick={() => void runWork(p)}>{acting ? 'Working...' : workLabel}</button>
          <select className="cell-select small" value="" disabled={busyFile !== null} title="Write a guarded live brain-plan status" onChange={(e) => {
            const status = e.target.value as BrainStatusWrite;
            e.currentTarget.value = '';
            if (status) void applyBrainStatus(p, status);
          }}>
            <option value="">Status...</option>
            {BRAIN_STATUS_ACTIONS.filter((a) => a.key !== key).map((a) => <option key={a.write} value={a.write}>{a.label}</option>)}
          </select>
          </div>
          <span className="muted plan-row-expander">{isOpen ? '▾' : '▸'}</span>
        </div>
        {audit[p.file] ? (
          <div className="muted small plan-row-feedback">
            {audit[p.file].to ? <span className="ok-text">{audit[p.file].from} → {audit[p.file].to} · </span> : null}{audit[p.file].summary}
          </div>
        ) : null}
        {blockers[p.file] ? (
          <div className="small muted plan-row-feedback" title="Decisions that need you are in the Inbox — respond with an option, a comment, or take it on yourself.">
            ⚠ {blockers[p.file]}
          </div>
        ) : null}
        {isOpen ? <pre className="plan-content">{brainContent}</pre> : null}
      </div>
    );
  };

  const draftCard = (p: PlanSummary) => {
    const isOpen = detail?.id === p.id;
    return (
      <div className={`skill-card plan-row plan-draft-row${isOpen ? ' editing' : ''}`} key={p.id}>
        <div className="plan-row-head" onClick={() => void open(p.id)}>
          <div className="plan-row-titleline">
            <span className={`st-badge ${STATUS_CLASS[p.status]}`}>{p.status}</span>
            <span className="b plan-row-title">{p.title}</span>
            <span className="muted small">· v{p.version}{p.agent ? ` · ${p.agent}` : ''}</span>
          </div>
          <div className="plan-row-note">
            {(p.tags ?? []).length ? <span className="muted small plan-note" title={(p.tags ?? []).join(', ')}>{(p.tags ?? []).join(', ')}</span> : null}
            <span className="muted small" title={`created ${abs(p.createdAt)}\nupdated ${abs(p.updatedAt)}`}>
              {p.createdAt && p.updatedAt && Math.abs(p.updatedAt - p.createdAt) > 60000
                ? `created ${ago(p.createdAt)} · updated ${ago(p.updatedAt)}`
                : `created ${ago(p.createdAt || p.updatedAt)}`}
            </span>
          </div>
          <span className="muted plan-row-expander">{isOpen ? '▾' : '▸'}</span>
        </div>
        {isOpen && detail ? (
          <div className="plan-detail">
            <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
              <input className="chat-title" style={{ flex: '0 1 260px' }} value={detail.title} disabled={busy} onChange={(e) => setDetail({ ...detail, title: e.target.value })} onBlur={(e) => void patchPlan({ title: e.target.value })} />
              <select className="cell-select small" value={detail.status} disabled={busy} onChange={(e) => void patchPlan({ status: e.target.value as PlanStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {(detail.tags ?? []).some((t) => /^→ plan /.test(t)) ? (
                <span className="ok-text small" title="This draft has been promoted into the live brain plans.">✓ promoted ({(detail.tags ?? []).find((t) => /^→ plan /.test(t))})</span>
              ) : detail.status === 'done' || detail.status === 'active' ? (
                <button className={`btn small${detail.status === 'done' ? ' primary' : ''}`} disabled={busy}
                  title="Promote this finalized draft into the live brain plans at ⏳ PENDING — from there it runs pending → partial → done."
                  onClick={() => void promoteDraft()}>↑ Promote to live plan</button>
              ) : null}
              <input style={{ flex: '0 1 200px', fontSize: 12 }} placeholder="tags (comma-separated)" value={tagInput} disabled={busy} onChange={(e) => setTagInput(e.target.value)} onBlur={() => void patchPlan({ tags: splitTags(tagInput) })} title="categorize this plan" />
              <span className="grow" />
              <button className="btn small" disabled={busy} onClick={() => setShowLog((v) => !v)}>{showLog ? 'Hide changelog' : `Changelog (${detail.revisions.length})`}</button>
              {confirmDel ? (
                <>
                  <button className="btn icon-danger small" disabled={busy} onClick={() => void remove()}>Delete?</button>
                  <button className="btn small" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn icon-danger small" disabled={busy} title="Delete plan" onClick={() => setConfirmDel(true)}>✕</button>
              )}
            </div>
            <div className="muted small" style={{ marginBottom: 4 }} title={`created ${abs(detail.createdAt)}\nupdated ${abs(detail.updatedAt)}`}>
              created {abs(detail.createdAt)} · updated {abs(detail.updatedAt)} ({ago(detail.updatedAt)}) · v{detail.version}
            </div>
            {viewVer != null ? <div className="muted small" style={{ marginBottom: 4 }}>viewing v{viewVer} · <button className="link-btn" onClick={() => setViewVer(null)}>back to current (v{detail.version})</button></div> : null}
            <pre className="plan-content">{shownContent}</pre>
            {showLog ? (
              <div className="plan-log">
                <div className="muted small b" style={{ margin: '8px 0 4px' }}>Changelog</div>
                {[...detail.revisions].reverse().map((r) => (
                  <div className="feed-row" key={r.version}>
                    <span className="mono small">v{r.version}</span>
                    <span className="muted small">{ago(r.at)}</span>
                    <span className="small grow">{r.note}</span>
                    <button className="link-btn small" onClick={() => setViewVer(r.version === detail.version ? null : r.version)}>{r.version === detail.version ? 'current' : 'view'}</button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="row-actions" style={{ gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted small">revise with</span>
              <select className="cell-select small" value={reviser} disabled={busy} onChange={(e) => setUpdAgent(e.target.value)} title="agent that revises this plan">
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button className="btn small" disabled={busy} title="Ask the agent to propose improvements" onClick={() => void suggest()}>✦ Suggest improvements</button>
            </div>
            <div className="row-actions" style={{ gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
              <textarea style={{ flex: 1, minHeight: 38 }} placeholder="update the plan — e.g. “add a rollback step to phase 3” (creates a new version + changelog entry)" value={updInstr} disabled={busy} onChange={(e) => setUpdInstr(e.target.value)} />
              <button className="btn primary" disabled={busy || !updInstr.trim()} onClick={() => void updatePlan()}>{busy ? '…' : 'Update'}</button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderList = (active: unknown[], renderCard: (x: never) => JSX.Element, keyOf: (x: never) => string, buckets: { key: string; label: string }[]) =>
    groupBy
      ? group(active as never[], keyOf, buckets).map((g) => (
          <div key={g.key}>
            <div className="muted small b" style={{ margin: '8px 0 4px' }}>{g.label} · {g.items.length}</div>
            <div className="skill-catalog">{(g.items as never[]).map(renderCard)}</div>
          </div>
        ))
      : <div className="skill-catalog">{(active as never[]).map(renderCard)}</div>;

  return (
    <>
      {/* Unified organizer */}
      <section className="card plans-toolbar" style={{ marginBottom: 10 }}>
        <div className="plans-toolbar-main">
          <input className="catalog-search plans-search" placeholder="search plans…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted small plans-filter-label">sort</span>
          <select className="cell-select small" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
            <option value="recent">most recent</option>
            <option value="title">title (A–Z)</option>
            <option value="status">status</option>
          </select>
          <button className={`btn small${showFilters || hasFilters ? ' primary' : ''}`} onClick={() => setShowFilters((v) => !v)}>
            Filters{filterCount ? ` (${filterCount})` : ''}
          </button>
          <button className={`btn small${includeCompleted ? ' primary' : ''}`} onClick={() => setShowCompleted((v) => !v)}>
            Completed{completedCount ? ` (${completedCount})` : ''}
          </button>
          <span className="muted small plans-count-pill">pending {brainCounts.pending} · partial {brainCounts.partial} · paused {brainCounts.hold} · done {brainCounts.done}</span>
          <span className="grow" />
          <div className="plans-toolbar-actions">
            {msg ? <span className={`small ${/failed|timed out|expired|cancelled|could not/.test(msg) ? 'status-error' : 'muted'}`}>{msg}</span> : null}
            {busy ? <button className="btn" onClick={cancel}>Cancel</button> : null}
            <button className="btn primary" disabled={busy} onClick={() => setShowNew((v) => !v)}>{showNew ? '− Cancel' : '+ Request plan'}</button>
          </div>
        </div>
        {showFilters || hasFilters ? (
          <div className="plans-filter-row">
            <label className="muted small plans-inline-control">
              <input type="checkbox" checked={groupBy} onChange={(e) => setGroupBy(e.target.checked)} /> group by status
            </label>
            {hasFilters ? <button className="btn small" onClick={() => { setBrainStatus(new Set()); setDraftStatus(new Set()); setTagFilter(new Set()); }}>clear filters</button> : null}
            <span className="muted small plans-filter-label">plans</span>
            {statusChips(BRAIN_BUCKETS.map((b) => b.key), brainStatus, (id) => toggle(setBrainStatus, id), (k) => BRAIN_BUCKETS.find((b) => b.key === k)?.label ?? k, (k) => BRAIN_KEY_CLASS[k as BrainStatusKey])}
            <span className="muted small plans-filter-label">drafts</span>
            {statusChips(STATUSES, draftStatus, (id) => toggle(setDraftStatus, id), (s) => s, (s) => STATUS_CLASS[s as PlanStatus])}
            {allDraftTags.length ? (
              <>
                <span className="muted small plans-filter-label">tags</span>
                <span className="chips">
                  {allDraftTags.map((t) => (
                    <button key={t} className={`chip${tagFilter.has(t) ? ' on' : ''}`} onClick={() => toggle(setTagFilter, t)}>{tagFilter.has(t) ? '✓ ' : ''}{t}</button>
                  ))}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {showNew ? (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Request a plan</h3>
          <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 12px' }}>
            <span>agent</span>
            <b>
              <select className="cell-select" value={genAgent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </b>
            <span>request</span>
            <b><textarea style={{ width: '100%', minHeight: 70 }} placeholder="what should the plan accomplish?" value={req} disabled={busy} onChange={(e) => setReq(e.target.value)} /></b>
          </div>
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !req.trim()} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate plan'}</button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="plans-section-head">
          <div className="plans-section-title">
            <h3 style={{ margin: 0 }}>Plans</h3>
            <span className="muted small">· {brainActive.length} active{brainCompleted.length ? ` · ${brainCompleted.length} completed` : ''} · ⟳ live</span>
            {brain.dir
              ? <span className="muted small mono plan-path" title={brain.dir}>{brain.dir.replace(/^.*\/projects\//, '…/')}</span>
              : <span className="warn-text small">brain plans dir not found</span>}
          </div>
          <button className="btn small primary" disabled={busyFile !== null || !nextWorkPlan} title={nextWorkPlan ? `Work next matching plan: ${nextWorkPlan.title}` : 'No pending, partial, or paused plan matches the current filters'} onClick={() => void runNextPlan()}>
            {busyFile ? 'Working...' : nextWorkPlan ? 'Work next' : 'No work queued'}
          </button>
        </div>
        {brain.plans.length === 0 ? (
          <p className="muted small">{brain.dir ? 'No plans in the brain index yet.' : 'Could not locate the brain plans directory (projects root not detected — set it in Projects).'}</p>
        ) : brainActive.length === 0 && !includeCompleted ? (
          <p className="muted center pad">No active plans match the filter.{brainCompleted.length ? ' Use Completed to show finished plans.' : ''}</p>
        ) : (
          <>
            {renderList(brainActive, brainCard as (x: never) => JSX.Element, ((p: BrainPlan) => brainStatusKey(p.status)) as (x: never) => string, BRAIN_BUCKETS.filter((b) => b.key !== 'done'))}
            {includeCompleted && brainCompleted.length ? (
              <div>
                <div className="muted small b" style={{ margin: '10px 0 4px' }}>Completed ({brainCompleted.length})</div>
                <div className="skill-catalog">{brainCompleted.map(brainCard)}</div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="card">
        <div className="plans-section-head">
          <div className="plans-section-title">
            <h3 style={{ margin: 0 }}>Your drafts</h3>
            <span className="muted small">· {draftActive.length} active{draftFiled.length ? ` · ${draftFiled.length} filed` : ''}</span>
            <span className="muted small">draft → active → done → promote removes draft</span>
          </div>
        </div>
        {plans.length === 0 ? (
          <p className="muted center pad">No plans yet. <b>+ Request a plan</b> and an agent will draft one — then update it anytime and it keeps a changelog.</p>
        ) : draftActive.length === 0 && !includeCompleted ? (
          <p className="muted center pad">No active drafts match the filter.{draftFiled.length ? ' Use Completed to show filed drafts.' : ''}</p>
        ) : (
          <>
            {renderList(draftActive, draftCard as (x: never) => JSX.Element, ((p: PlanSummary) => p.status) as (x: never) => string, STATUSES.map((s) => ({ key: s, label: s })))}
            {includeCompleted && draftFiled.length ? (
              <div>
                <div className="muted small b" style={{ margin: '10px 0 4px' }}>Filed drafts ({draftFiled.length})</div>
                <div className="skill-catalog">{draftFiled.map(draftCard)}</div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
