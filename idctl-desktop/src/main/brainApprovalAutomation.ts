import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brain } from '../../../idctl/src/api/brain.ts';
import { resolveConfigPath } from '../../../idctl/src/settings/paths.ts';

export type AutomatableBrainApproval = {
  id: number | string;
  kind?: string;
  subject?: string;
  status?: string;
  risk_level?: string;
  requested_by?: string;
  payload?: Record<string, unknown>;
  governance?: {
    human_attention?: { reason?: string; level?: string };
    risk?: { level?: string; action?: string; reversible?: boolean };
  };
};

export type BrainApprovalReviewer = {
  team: string;
  agent: string;
  specialty: 'skill-domain' | 'evidence' | 'implementation' | 'coordination';
};

export type BrainApprovalReviewResult = {
  decision: 'approve' | 'reject' | 'repair' | 'escalate';
  confidence: number;
  reason: string;
  evidenceIds: string[];
  reviewer?: string;
};

type ReviewQuery = {
  reviewer: BrainApprovalReviewer;
  queryId?: string;
  status: 'starting' | 'pending' | 'delivered' | 'failed';
  result?: BrainApprovalReviewResult;
  error?: string;
};

export type BrainApprovalReviewState = {
  approvalId: string;
  status: 'reviewing' | 'escalated' | 'resolved';
  startedAt: number;
  updatedAt: number;
  queries: ReviewQuery[];
  reason?: string;
};

type StateFile = { version: 1; approvals: Record<string, BrainApprovalReviewState> };

export type BrainApprovalAutomationAdapter = {
  reviewers(): Promise<BrainApprovalReviewer[]>;
  start(reviewer: BrainApprovalReviewer, prompt: string, sessionId: string): Promise<{ queryId?: string; inline?: string }>;
  poll(reviewer: BrainApprovalReviewer, queryId: string): Promise<{ status?: string; text?: string; error?: string }>;
};

export type BrainApprovalAutomationRun = {
  scanned: number;
  started: number;
  resolved: number;
  routedToRepair: number;
  escalated: number;
  pending: number;
  errors: string[];
};

const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MAX_REVIEWERS = 3;
const SENSITIVE_SKILL_RE = /\b(?:private\s*key|seed\s*phrase|wallet|sign(?:ing|ature)?|transfer|withdraw|spend|mainnet|deploy|destroy|delete|revoke|permission|credential|secret|token\s+approval)\b/i;
let adapter: BrainApprovalAutomationAdapter | null = null;
let running: Promise<BrainApprovalAutomationRun> | null = null;
let stateCache: StateFile | null = null;
let stateCacheAt = 0;

function statePath(): string {
  const dir = dirname(resolveConfigPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'brain-approval-agent-review.json');
}

function emptyState(): StateFile {
  return { version: 1, approvals: {} };
}

function loadState(): StateFile {
  if (stateCache && Date.now() - stateCacheAt < 1000) return stateCache;
  const file = statePath();
  if (!existsSync(file)) {
    stateCache = emptyState();
    stateCacheAt = Date.now();
    return stateCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StateFile;
    stateCache = parsed?.version === 1 && parsed.approvals && typeof parsed.approvals === 'object' ? parsed : emptyState();
  } catch {
    stateCache = emptyState();
  }
  stateCacheAt = Date.now();
  return stateCache;
}

function saveState(state: StateFile): void {
  const file = statePath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try { renameSync(tmp, file); } catch (error) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw error; }
  stateCache = state;
  stateCacheAt = Date.now();
}

function enabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes(String(process.env.IDACC_BRAIN_AGENT_REVIEW ?? '1').toLowerCase());
}

function approvalRisk(approval: AutomatableBrainApproval): string {
  return String(approval.risk_level || approval.governance?.risk?.level || 'medium').toLowerCase();
}

function payloadText(approval: AutomatableBrainApproval): string {
  try { return `${String(approval.subject || '')}\n${JSON.stringify(approval.payload ?? {})}`; } catch { return String(approval.subject || ''); }
}

export function brainApprovalAutomationEligibility(approval: AutomatableBrainApproval): { eligible: boolean; reason: string } {
  if (!enabled()) return { eligible: false, reason: 'agent_review_disabled' };
  if (approval.kind !== 'skill.publish') return { eligible: false, reason: 'kind_requires_operator_policy' };
  const risk = approvalRisk(approval);
  if (!['low', 'medium'].includes(risk)) return { eligible: false, reason: 'risk_requires_operator' };
  const attention = String(approval.governance?.human_attention?.level || '').toLowerCase();
  if (['high', 'critical', 'required'].includes(attention)) return { eligible: false, reason: 'explicit_human_attention' };
  if (SENSITIVE_SKILL_RE.test(payloadText(approval))) return { eligible: false, reason: 'authority_or_sensitive_scope' };
  return { eligible: true, reason: 'safe_skill_publication_review' };
}

export function brainApprovalAutomationState(id: number | string): BrainApprovalReviewState | undefined {
  return loadState().approvals[String(id)];
}

export function shouldDeferBrainApprovalToAgents(approval: AutomatableBrainApproval): boolean {
  if (!brainApprovalAutomationEligibility(approval).eligible) return false;
  return brainApprovalAutomationState(approval.id)?.status !== 'escalated';
}

export function configureBrainApprovalAutomation(next: BrainApprovalAutomationAdapter): void {
  adapter = next;
}

function redacted(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redacted(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /secret|token|password|credential|authorization|private.?key|seed/i.test(key)
        ? '[redacted]'
        : redacted(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 1600);
  return value;
}

function originalEvidenceIds(approval: AutomatableBrainApproval): string[] {
  const payload = approval.payload ?? {};
  const keys = ['source_ids', 'sourceIds', 'source_text_unit_ids', 'sourceTextUnitIds', 'fact_ids', 'factIds', 'text_unit_ids', 'textUnitIds'];
  const out: string[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const id = String(item ?? '').trim();
      if (id) out.push(`${key}:${id}`);
    }
  }
  return [...new Set(out)].slice(0, 80);
}

function reviewCitesOriginalEvidence(approval: AutomatableBrainApproval, review: BrainApprovalReviewResult): boolean {
  const originals = originalEvidenceIds(approval);
  return review.evidenceIds.some((reviewed) => originals.some((original) =>
    reviewed === original || original.endsWith(`:${reviewed}`) || reviewed.endsWith(`:${original}`)));
}

function reviewPrompt(approval: AutomatableBrainApproval, reviewer: BrainApprovalReviewer): string {
  const evidence = originalEvidenceIds(approval);
  return [
    'AUTONOMOUS BRAIN SKILL-PUBLICATION REVIEW. Do not ask the operator to decide this review.',
    `You are the ${reviewer.specialty} reviewer. Independently inspect Brain evidence and the current skill catalog before deciding.`,
    'Approve only when the proposal has a clear bounded scope, valid source evidence, no useful duplicate, and no unsafe or hidden authority.',
    'Choose repair when evidence/scope can be fixed automatically. Choose reject for a redundant, unsafe, or non-useful proposal. Escalate only for an actual external authority decision.',
    `Approval ID: ${approval.id}`,
    `Subject: ${String(approval.subject || '').slice(0, 240)}`,
    `Risk: ${approvalRisk(approval)}`,
    `Evidence references carried by the proposal: ${evidence.length ? evidence.join(', ') : '(none)'}`,
    `Redacted proposal payload:\n${JSON.stringify(redacted(approval.payload ?? {}), null, 2).slice(0, 12_000)}`,
    'Return exactly one JSON object and no markdown:',
    '{"decision":"approve|reject|repair|escalate","confidence":0.0,"reason":"concise reason","evidence_ids":["source/fact/text IDs actually checked"]}',
  ].join('\n\n');
}

export function parseBrainApprovalReview(text: unknown): BrainApprovalReviewResult | null {
  const raw = String(text ?? '').trim();
  const candidates = [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const rawDecision = String(parsed.decision ?? '').toLowerCase();
      const token = rawDecision === 'approved' ? 'approve' : rawDecision === 'rejected' ? 'reject' : rawDecision;
      const decision = token === 'approve' || token === 'reject' || token === 'repair' || token === 'escalate' ? token : '';
      if (!decision) continue;
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
      const reason = String(parsed.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
      const rawIds = parsed.evidence_ids ?? parsed.evidenceIds;
      const evidenceIds = Array.isArray(rawIds) ? rawIds.map(String).map((id) => id.trim()).filter(Boolean).slice(0, 80) : [];
      if (!reason) continue;
      return { decision, confidence, reason, evidenceIds };
    } catch { /* try the next candidate */ }
  }
  return null;
}

export function selectBrainApprovalReviewers(reviewers: BrainApprovalReviewer[]): BrainApprovalReviewer[] {
  const unique = [...new Map(reviewers.map((reviewer) => [`${reviewer.team}/${reviewer.agent}`, reviewer])).values()];
  const rank = (reviewer: BrainApprovalReviewer): number => {
    if (reviewer.team === 'skillmesh-ops' && /lead/i.test(reviewer.agent)) return 0;
    if (reviewer.team === 'default' && reviewer.agent === 'researcher') return 1;
    if (reviewer.team === 'default' && reviewer.agent === 'coder') return 2;
    if (reviewer.specialty === 'skill-domain') return 3;
    if (reviewer.specialty === 'evidence') return 4;
    if (reviewer.specialty === 'implementation') return 5;
    return 6;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || `${a.team}/${a.agent}`.localeCompare(`${b.team}/${b.agent}`));
}

type Consensus = { action: 'approve' | 'reject' | 'repair' | 'more' | 'escalate'; reason: string; reviews: BrainApprovalReviewResult[] };

export function brainApprovalReviewConsensus(results: BrainApprovalReviewResult[], totalStarted: number): Consensus {
  const usable = results.filter((result) => result.confidence >= 0.6);
  const repair = usable.filter((result) => result.decision === 'repair');
  if (repair.length) return { action: 'repair', reason: repair.map((result) => result.reason).join('; ').slice(0, 1000), reviews: usable };
  const approvals = usable.filter((result) => result.decision === 'approve');
  const rejections = usable.filter((result) => result.decision === 'reject');
  if (approvals.length >= 2 && rejections.length === 0) return { action: 'approve', reason: approvals.map((result) => result.reason).join('; ').slice(0, 1000), reviews: usable };
  if (rejections.length >= 2 && approvals.length === 0) return { action: 'reject', reason: rejections.map((result) => result.reason).join('; ').slice(0, 1000), reviews: usable };
  if (usable.length < 2 || totalStarted < MAX_REVIEWERS) return { action: 'more', reason: 'independent reviewers have not reached consensus', reviews: usable };
  const escalations = usable.filter((result) => result.decision === 'escalate');
  if (approvals.length > rejections.length && approvals.length >= 2) return { action: 'approve', reason: approvals.map((result) => result.reason).join('; ').slice(0, 1000), reviews: usable };
  if (rejections.length > approvals.length && rejections.length >= 2) return { action: 'reject', reason: rejections.map((result) => result.reason).join('; ').slice(0, 1000), reviews: usable };
  return { action: 'escalate', reason: escalations[0]?.reason || 'three independent reviewers did not reach a safe majority', reviews: usable };
}

async function brainJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || 'GET').toUpperCase() as 'GET' | 'POST';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
  const response = await brain.route<T>(method, path, body);
  if (!response) throw new Error(`Manager-mediated Brain request failed: ${method} ${path}`);
  return response;
}

async function listPendingApprovals(limit = 200): Promise<AutomatableBrainApproval[]> {
  const response = await brainJson<{ approvals?: AutomatableBrainApproval[]; data?: { approvals?: AutomatableBrainApproval[] } }>(`/approvals?status=pending&limit=${limit}`);
  return response.approvals ?? response.data?.approvals ?? [];
}

async function resolveApproval(approval: AutomatableBrainApproval, status: 'approved' | 'rejected' | 'resolved', reason: string, reviews: BrainApprovalReviewResult[]): Promise<void> {
  await brainJson(`/approvals/${approval.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      status,
      resolution: {
        source: 'idacc-agent-consensus',
        reviewer: 'manager-routed-agent-review',
        reason,
        reviews,
        decided_at: new Date().toISOString(),
        guardrail: 'two-reviewer consensus; apply remains a separate Brain guarded step',
      },
    }),
  });
}

async function routeRepair(approval: AutomatableBrainApproval, reason: string, reviews: BrainApprovalReviewResult[]): Promise<void> {
  const payload = approval.payload ?? {};
  const created = await brainJson<Record<string, unknown>>('/learning-tasks', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'skill.evidence.repair',
      subject: approval.subject ?? '',
      approval_id: approval.id,
      assignee: 'skillmesh-ops/skillmesh-ops-lead',
      priority: Number(payload['demand'] ?? 1) || 1,
      evidence_ids: { source_ids: originalEvidenceIds(approval) },
      payload: {
        approval_kind: approval.kind,
        approval_id: approval.id,
        approval_subject: approval.subject ?? '',
        reason,
        approval_payload: redacted(payload),
        agent_reviews: reviews,
        review_gate: 'repair evidence or scope, then create a new evidence-backed publish proposal; do not publish this proposal',
      },
      source: 'idacc-agent-consensus',
    }),
  });
  const row = (created['task'] ?? (created['data'] as Record<string, unknown> | undefined)?.['task'] ?? created) as Record<string, unknown>;
  await resolveApproval(approval, 'resolved', `Routed to skill.evidence.repair task ${String(row?.['id'] ?? 'unknown')}: ${reason}`, reviews);
}

async function startReviewer(state: BrainApprovalReviewState, approval: AutomatableBrainApproval, reviewer: BrainApprovalReviewer): Promise<void> {
  if (!adapter) throw new Error('Brain approval automation adapter is not configured');
  const query: ReviewQuery = { reviewer, status: 'starting' };
  state.queries.push(query);
  try {
    const started = await adapter.start(reviewer, reviewPrompt(approval, reviewer), `brain-approval-review:${approval.id}:${reviewer.team}:${reviewer.agent}`);
    if (started.inline) {
      const parsed = parseBrainApprovalReview(started.inline);
      query.status = parsed ? 'delivered' : 'failed';
      query.result = parsed ?? undefined;
      query.error = parsed ? undefined : 'reviewer returned an invalid review envelope';
    } else if (started.queryId) {
      query.queryId = started.queryId;
      query.status = 'pending';
    } else {
      query.status = 'failed';
      query.error = 'reviewer dispatch returned no query id';
    }
  } catch (error) {
    query.status = 'failed';
    query.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
}

async function pollQueries(state: BrainApprovalReviewState): Promise<void> {
  if (!adapter) return;
  await Promise.all(state.queries.filter((query) => query.status === 'pending' && query.queryId).map(async (query) => {
    try {
      const polled = await adapter!.poll(query.reviewer, query.queryId!);
      if (polled.status === 'delivered') {
        const parsed = parseBrainApprovalReview(polled.text);
        query.status = parsed ? 'delivered' : 'failed';
        query.result = parsed ?? undefined;
        query.error = parsed ? undefined : 'reviewer returned an invalid review envelope';
      } else if (['failed', 'expired', 'cancelled'].includes(String(polled.status))) {
        query.status = 'failed';
        query.error = String(polled.error || polled.status || 'review failed').slice(0, 500);
      }
    } catch (error) {
      query.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }
  }));
}

async function processApproval(approval: AutomatableBrainApproval, stateFile: StateFile, reviewers: BrainApprovalReviewer[]): Promise<'started' | 'pending' | 'resolved' | 'repair' | 'escalated'> {
  const id = String(approval.id);
  const now = Date.now();
  const candidates = selectBrainApprovalReviewers(reviewers);
  let state = stateFile.approvals[id];
  if (!state) {
    state = stateFile.approvals[id] = { approvalId: id, status: 'reviewing', startedAt: now, updatedAt: now, queries: [] };
    if (candidates.length < 2) {
      state.reason = 'waiting_for_two_independent_live_reviewers';
      return 'pending';
    }
    await Promise.all(candidates.slice(0, 2).map((reviewer) => startReviewer(state!, approval, reviewer)));
    state.updatedAt = Date.now();
    return 'started';
  }
  if (state.status === 'escalated') return 'escalated';
  if (state.status === 'resolved') return 'resolved';

  await pollQueries(state);
  if (now - state.startedAt >= REVIEW_TIMEOUT_MS) {
    for (const query of state.queries) {
      if (query.status === 'pending' || query.status === 'starting') {
        query.status = 'failed';
        query.error = 'review query exceeded its bounded review window';
      }
    }
  }
  const results = state.queries
    .filter((query) => query.result)
    .map((query) => ({ ...query.result!, reviewer: `${query.reviewer.team}/${query.reviewer.agent}` }));
  let consensus = brainApprovalReviewConsensus(results, state.queries.length);
  if (consensus.action === 'more') {
    const used = new Set(state.queries.map((query) => `${query.reviewer.team}/${query.reviewer.agent}`));
    const next = candidates.find((reviewer) => !used.has(`${reviewer.team}/${reviewer.agent}`));
    if (next) {
      await startReviewer(state, approval, next);
      state.updatedAt = Date.now();
      return 'pending';
    }
  }

  const allTerminal = state.queries.every((query) => query.status === 'delivered' || query.status === 'failed');
  if (consensus.action === 'more' && allTerminal && results.length < 2) {
    if (now - state.updatedAt >= 60_000 || now - state.startedAt >= REVIEW_TIMEOUT_MS) {
      state.queries = state.queries.filter((query) => query.status === 'delivered' && query.result);
      const used = new Set(state.queries.map((query) => `${query.reviewer.team}/${query.reviewer.agent}`));
      const retryPool = candidates.filter((reviewer) => !used.has(`${reviewer.team}/${reviewer.agent}`));
      const needed = Math.max(1, 2 - state.queries.length);
      await Promise.all(retryPool.slice(0, needed).map((reviewer) => startReviewer(state!, approval, reviewer)));
      state.startedAt = now;
      state.updatedAt = Date.now();
    }
    return 'pending';
  }
  if (consensus.action === 'more' && (!allTerminal || now - state.startedAt < REVIEW_TIMEOUT_MS)) {
    state.updatedAt = Date.now();
    return 'pending';
  }
  if (consensus.action === 'more') consensus = { ...consensus, action: 'escalate', reason: 'Independent reviewers returned conflicting valid verdicts.' };

  if (consensus.action === 'approve') {
    if (!originalEvidenceIds(approval).length || consensus.reviews.some((review) => !reviewCitesOriginalEvidence(approval, review))) {
      await routeRepair(approval, 'Reviewers could not preserve verifiable evidence IDs for publication.', consensus.reviews);
      state.status = 'resolved';
      state.reason = 'routed_to_evidence_repair';
      return 'repair';
    }
    await resolveApproval(approval, 'approved', consensus.reason, consensus.reviews);
    state.status = 'resolved';
    state.reason = 'approved_by_agent_consensus';
    return 'resolved';
  }
  if (consensus.action === 'reject') {
    await resolveApproval(approval, 'rejected', consensus.reason, consensus.reviews);
    state.status = 'resolved';
    state.reason = 'rejected_by_agent_consensus';
    return 'resolved';
  }
  if (consensus.action === 'repair') {
    await routeRepair(approval, consensus.reason, consensus.reviews);
    state.status = 'resolved';
    state.reason = 'routed_to_evidence_repair';
    return 'repair';
  }
  state.status = 'escalated';
  state.reason = consensus.reason;
  state.updatedAt = Date.now();
  return 'escalated';
}

async function runOnce(): Promise<BrainApprovalAutomationRun> {
  const result: BrainApprovalAutomationRun = { scanned: 0, started: 0, resolved: 0, routedToRepair: 0, escalated: 0, pending: 0, errors: [] };
  if (!enabled() || !adapter) return result;
  const approvals = await listPendingApprovals();
  result.scanned = approvals.length;
  const eligible = approvals.filter((approval) => brainApprovalAutomationEligibility(approval).eligible);
  const reviewerPool = eligible.length ? await adapter.reviewers() : [];
  const state = loadState();
  const pendingIds = new Set(approvals.map((approval) => String(approval.id)));
  for (const id of Object.keys(state.approvals)) if (!pendingIds.has(id)) delete state.approvals[id];

  for (const approval of eligible) {
    try {
      const outcome = await processApproval(approval, state, reviewerPool);
      if (outcome === 'started') result.started++;
      else if (outcome === 'resolved') result.resolved++;
      else if (outcome === 'repair') result.routedToRepair++;
      else if (outcome === 'escalated') result.escalated++;
      else result.pending++;
    } catch (error) {
      result.errors.push(`approval ${approval.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 700));
    }
  }
  saveState(state);
  return result;
}

export function runBrainApprovalAutomationOnce(): Promise<BrainApprovalAutomationRun> {
  if (running) return running;
  running = runOnce().finally(() => { running = null; });
  return running;
}

export function startBrainApprovalAutomationLoop(onChange: (result: BrainApprovalAutomationRun) => void = () => {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };
  const tick = async () => {
    try {
      const result = await runBrainApprovalAutomationOnce();
      if (result.started || result.resolved || result.routedToRepair || result.escalated) onChange(result);
      schedule(result.pending || result.started ? 15_000 : 60_000);
    } catch {
      schedule(60_000);
    }
  };
  schedule(5_000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
