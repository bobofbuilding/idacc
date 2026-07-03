import { addQuestion, listQuestions, removeQuestion, type BlockerQuestion } from './questionstore.ts';

type BrainApproval = {
  id: number | string;
  kind?: string;
  subject?: string;
  status?: string;
  risk_level?: string;
  requested_by?: string;
  created_at?: number | string;
  payload?: Record<string, unknown>;
  governance?: {
    human_attention?: { reason?: string; level?: string };
    risk?: { level?: string; action?: string };
  };
};

type BrainApprovalListResponse = {
  approvals?: BrainApproval[];
  data?: { approvals?: BrainApproval[] };
};

export type BrainApprovalSyncResult = {
  ok: boolean;
  synced: number;
  removed: number;
  skipped?: boolean;
  error?: string;
};

const SYNC_TTL_MS = 60_000;
let lastSyncAt = 0;
let inFlight: Promise<BrainApprovalSyncResult> | null = null;

function brainBaseUrl(): string {
  return String(process.env.IDACC_BRAIN_URL || process.env.BRAIN_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
}

function clip(value: unknown, max = 160): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function asMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

async function brainJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${brainBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brain ${res.status} ${res.statusText}: ${clip(body, 400)}`);
  }
  return await res.json() as T;
}

function resolutionPath(kind: string): string {
  switch (kind) {
    case 'memory.retire':
      return 'review stale/noisy memory; approval lets Brain retire it with rollback evidence';
    case 'entity.alias.fuzzy_merge':
      return 'confirm canonical and duplicate entities; approval lets Brain record a reversible alias merge';
    case 'team.instruction.supersede':
      return 'confirm replacement instruction; approval lets Brain supersede the older team instruction memory';
    case 'fact.contradiction':
      return 'choose the winning fact before apply; approval alone does not choose a winner';
    case 'skill.publish':
      return 'confirm evidence and scope; approval lets Brain publish the skill proposal';
    case 'skill.proposal.evidence_invalid':
      return 'confirm evidence gap; rejection or repair should keep invalid citations out of the catalog';
    default:
      return 'review payload and risk; approval moves the item into Brain’s guarded apply path';
  }
}

function questionForApproval(approval: BrainApproval): BlockerQuestion {
  const id = String(approval.id);
  const kind = clip(approval.kind || 'approval', 120);
  const subject = clip(approval.subject || '(no subject)', 200);
  const risk = clip(approval.risk_level || approval.governance?.risk?.level || 'medium', 80);
  const reason = clip(approval.governance?.human_attention?.reason || approval.payload?.['recommendation'] || '', 240);
  const detail = [
    `Brain approval #${id} needs review.`,
    `${kind} · ${subject}`,
    `Risk: ${risk}.`,
    reason ? `Reason: ${reason}.` : '',
    `Resolution path: ${resolutionPath(kind)}.`,
    'Approve only after reviewing; applying remains a separate guarded Brain step.',
  ].filter(Boolean).join(' ');

  return {
    id: `brain-approval-${id}`,
    question: detail,
    options: ['Approve for Brain apply queue', 'Reject / keep current state'],
    agent: 'Brain governance',
    taskRef: `brain-approval:${id}`,
    taskTitle: `${kind}: ${subject}`,
    team: 'brain',
    createdAt: asMs(approval.created_at),
    dedupeKey: `brain-approval:${id}`,
    source: 'brain-approvals',
    metadata: {
      approvalId: id,
      kind,
      subject,
      riskLevel: risk,
      requestedBy: approval.requested_by ?? 'brain',
      status: approval.status ?? 'pending',
      sourceUrl: `${brainBaseUrl()}/dashboard/health`,
    },
  };
}

async function doSync(limit = 100): Promise<BrainApprovalSyncResult> {
  const response = await brainJson<BrainApprovalListResponse>(`/approvals?status=pending&limit=${Math.max(1, Math.min(200, limit))}`);
  const approvals = response.approvals ?? response.data?.approvals ?? [];
  const pendingKeys = new Set(approvals.map((approval) => `brain-approval:${approval.id}`));
  const existing = listQuestions().filter((q) => q.dedupeKey?.startsWith('brain-approval:') || q.taskRef?.startsWith('brain-approval:'));
  const existingKeys = new Set(existing.map((q) => q.dedupeKey || q.taskRef).filter(Boolean));

  let removed = 0;
  for (const q of existing) {
    const key = q.dedupeKey || q.taskRef || '';
    if (!pendingKeys.has(key)) {
      removeQuestion(q.id);
      removed++;
    }
  }

  let synced = 0;
  for (const approval of approvals) {
    const key = `brain-approval:${approval.id}`;
    if (existingKeys.has(key)) continue;
    addQuestion(questionForApproval(approval));
    synced++;
  }
  lastSyncAt = Date.now();
  return { ok: true, synced, removed };
}

export async function syncBrainApprovalInbox(options: { force?: boolean; limit?: number } = {}): Promise<BrainApprovalSyncResult> {
  if (process.env.IDACC_BRAIN_APPROVAL_INBOX_SYNC === '0') return { ok: true, synced: 0, removed: 0, skipped: true };
  if (!options.force && Date.now() - lastSyncAt < SYNC_TTL_MS) return { ok: true, synced: 0, removed: 0, skipped: true };
  if (inFlight) return inFlight;
  inFlight = doSync(options.limit).catch((e) => {
    lastSyncAt = Date.now();
    return { ok: false, synced: 0, removed: 0, error: e instanceof Error ? e.message : String(e) };
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function resolveBrainApprovalFromInbox(id: unknown, status: unknown, note?: unknown): Promise<Record<string, unknown>> {
  const approvalId = String(id ?? '').replace(/^brain-approval:/, '').trim();
  if (!/^\d+$/.test(approvalId)) throw new Error('invalid Brain approval id');
  const nextStatus = String(status ?? '').toLowerCase();
  if (!['approved', 'rejected'].includes(nextStatus)) throw new Error('invalid Brain approval decision');

  const payload = {
    status: nextStatus,
    resolution: {
      source: 'idacc-inbox',
      reviewer: 'operator',
      note: String(note ?? '').slice(0, 500),
      decided_at: new Date().toISOString(),
      guardrail: 'resolved from IDACC inbox; apply remains a separate Brain guarded step',
    },
  };
  const response = await brainJson<Record<string, unknown>>(`/approvals/${approvalId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  removeQuestion(`brain-approval-${approvalId}`);
  lastSyncAt = 0;
  return { ok: true, id: approvalId, status: nextStatus, response };
}
