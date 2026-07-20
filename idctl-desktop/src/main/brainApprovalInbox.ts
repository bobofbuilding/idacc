import { addQuestion, listQuestions, removeQuestion, type BlockerQuestion } from './questionstore.ts';
import { brain } from '../../../idctl/src/api/brain.ts';

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
    risk?: { level?: string; action?: string; reversible?: boolean };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function brainJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || 'GET').toUpperCase() as 'GET' | 'POST';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
  const response = await brain.route<T>(method, path, body);
  if (!response) throw new Error(`Manager-mediated Brain request failed: ${method} ${path}`);
  return response;
}

function resolutionPath(kind: string): string {
  switch (kind) {
    case 'memory.retire':
      return 'review stale/noisy memory; approval lets Brain retire it with rollback evidence';
    case 'entity.alias.fuzzy_merge':
      return 'approve only when both records are the same real-world entity; approval lets Brain record a reversible alias merge';
    case 'team.instruction.supersede':
      return 'confirm replacement instruction; approval lets Brain supersede the older team instruction memory';
    case 'fact.contradiction':
      return 'review the competing facts, choose the trusted fact only when the evidence is clear, otherwise reject or resolve it in Brain Health';
    case 'skill.publish':
      return 'confirm evidence and scope; approval lets Brain publish the skill proposal';
    case 'skill.proposal.evidence_invalid':
      return 'confirm evidence gap; rejection or repair should keep invalid citations out of the catalog';
    default:
      return 'review payload and risk; approval moves the item into Brain’s guarded apply path';
  }
}

function candidateLabels(approval: BrainApproval): string[] {
  const candidates = asArray(approval.payload?.['candidates'])
    .map((candidate) => {
      const row = asRecord(candidate);
      return clip(row.name || row.entity_id || row.id || row.subject, 180);
    })
    .filter(Boolean);
  if (candidates.length) return candidates.slice(0, 6);
  return String(approval.subject || '')
    .split('|')
    .map((part) => clip(part, 180))
    .filter(Boolean)
    .slice(0, 6);
}

function percent(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const scaled = n <= 1 ? n * 100 : n;
  return `${Math.round(scaled)}%`;
}

function booleanLabel(value: unknown): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

function readPath(record: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = record;
  for (const part of path) {
    const row = asRecord(cursor);
    if (!(part in row)) return undefined;
    cursor = row[part];
  }
  return cursor;
}

function firstText(record: Record<string, unknown>, paths: string[][], max = 900): string {
  for (const path of paths) {
    const value = readPath(record, path);
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = clip(redactText(value), max);
      if (text) return text;
    }
  }
  return '';
}

function redactText(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(?:sk|pk|ghp|gho|xoxb|xoxp|Bearer)[A-Za-z0-9_./+=:-]{16,}\b/g, '[redacted secret]')
    .replace(/\b(?!0x[a-fA-F0-9]{40}\b)[A-Za-z0-9_./+=-]{72,}\b/g, '[redacted long value]');
}

function timeLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(asMs(n)).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function countLabel(value: unknown, noun: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${Math.round(n).toLocaleString('en-US')} ${noun}${Math.round(n) === 1 ? '' : 's'}`;
}

function memoryRetireDecisionLines(approval: BrainApproval, subject: string, common: string[]): string[] {
  const payload = approval.payload ?? {};
  const memoryId = firstText(payload, [['memory_id'], ['memory', 'id']], 80) || subject;
  const key = firstText(payload, [['key'], ['memory_key'], ['memory', 'key']], 160);
  const agent = firstText(payload, [['agent_id'], ['agent'], ['memory', 'agent_id']], 120);
  const evidence = firstText(payload, [
    ['evidence'],
    ['memory', 'evidence'],
    ['memory', 'text'],
    ['memory', 'content'],
    ['text'],
    ['content'],
    ['summary'],
  ], 1100);
  const suggestedReason = firstText(payload, [['suggested_reason'], ['reason'], ['recommendation']], 260);
  const ignored = countLabel(payload['ignored_count'], 'ignored suggestion');
  const volunteered = timeLabel(payload['last_volunteered_at']);
  const used = timeLabel(payload['last_used_at']);
  const score = Number(payload['score']);
  const reversible = payload['reversible'] ?? approval.governance?.risk?.reversible;

  const signals = [
    agent ? `owner/agent ${agent}` : '',
    key ? `key ${key}` : '',
    ignored,
    volunteered ? `last offered ${volunteered}` : '',
    used ? `last accepted use ${used}` : 'no accepted use recorded',
    Number.isFinite(score) ? `Brain retirement score ${Math.round(score * 10) / 10}` : '',
    `rollback available: ${booleanLabel(reversible)}`,
  ].filter(Boolean);

  return [
    'Decision: Should this Brain memory stop being used for answers, routing, and recommendations?',
    `Memory under review: ${memoryId}${key ? ` (${key})` : ''}.`,
    evidence
      ? `Memory text / evidence excerpt:\n${evidence}`
      : 'Memory text / evidence excerpt: not included in the Brain approval payload. Open Brain Health before approving; this card only proves that Brain asked to retire the memory, not what the memory says.',
    suggestedReason ? `Brain recommendation: ${suggestedReason}.` : '',
    signals.length ? `Review signals: ${signals.join('; ')}.` : '',
    common.join(' '),
    'Approve means: mark this approval as approved so Brain can queue a reversible retirement. The memory should no longer influence future retrieval/routing after Brain applies it.',
    'Reject means: keep the memory active because it is still true, useful, or not sufficiently reviewed.',
    'Approve only if: the excerpt is outdated, duplicated, misleading, or repeatedly irrelevant. If the excerpt is missing or unclear, reject or open Brain Health first.',
  ].filter(Boolean);
}

function shortList(value: unknown, max = 8): string {
  const items = asArray(value).map((item) => clip(redactText(item), 80)).filter(Boolean);
  if (!items.length) return '';
  const shown = items.slice(0, max);
  return `${shown.join(', ')}${items.length > shown.length ? `, +${items.length - shown.length} more` : ''}`;
}

function summarizeClaimValue(value: unknown, maxItems = 4): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => summarizeClaimValueItem(item)).filter(Boolean);
    if (!items.length) return 'no readable value provided';
    const shown = items.slice(0, maxItems);
    return `${items.length} item${items.length === 1 ? '' : 's'}: ${shown.join('; ')}${items.length > shown.length ? `; +${items.length - shown.length} more` : ''}`;
  }

  const row = asRecord(value);
  if (Object.keys(row).length) return summarizeClaimValueItem(row);

  const text = clip(redactText(value), 700);
  return text || 'no readable value provided';
}

function summarizeClaimValueItem(value: unknown): string {
  const row = asRecord(value);
  if (Object.keys(row).length) {
    const path = firstText(row, [['path'], ['file'], ['file_path'], ['name'], ['id']], 140);
    const category = firstText(row, [['category'], ['kind'], ['type']], 80);
    const risk = firstText(row, [['risk'], ['risk_level'], ['severity']], 80);
    const summary = firstText(row, [['summary'], ['description'], ['title'], ['claim'], ['text'], ['content']], 320);
    const snippet = firstText(row, [['snippet'], ['excerpt'], ['evidence']], 220);
    const meta = [category, risk].filter(Boolean).join(', ');
    if (path && summary) return `${path}${meta ? ` (${meta})` : ''}: ${summary}`;
    if (summary) return `${summary}${meta ? ` (${meta})` : ''}`;
    if (path && snippet) return `${path}: ${snippet}`;
    if (path) return path;
    const json = JSON.stringify(row);
    return clip(redactText(json), 360);
  }
  return clip(redactText(value), 320);
}

function contradictionClaimLines(approval: BrainApproval): string[] {
  const payload = approval.payload ?? {};
  const claimSets = [
    asArray(payload['competing_values']),
    asArray(payload['claims']),
    asArray(payload['facts']),
    asArray(payload['candidates']),
  ].filter((items) => items.length);
  const claims = claimSets[0] ?? [];
  return claims.slice(0, 6).map((claim, index) => {
    const row = asRecord(claim);
    const id = firstText(row, [['fact_id'], ['id'], ['claim_id'], ['source_fact_id']], 80);
    const label = id ? `Fact ${id}` : `Fact ${String.fromCharCode(65 + index)}`;
    const value = row['value'] ?? row['claim'] ?? row['fact'] ?? row['statement'] ?? row['text'] ?? claim;
    const source = firstText(row, [['source'], ['origin'], ['created_by'], ['requested_by']], 120);
    const confidence = percent(row['confidence']);
    const observed = timeLabel(row['observed_at'] ?? row['created_at'] ?? row['updated_at']);
    const textUnits = shortList(row['text_unit_ids'], 5);
    const signals = [
      source ? `source ${source}` : '',
      confidence ? `confidence ${confidence}` : '',
      observed ? `observed ${observed}` : '',
      textUnits ? `text units ${textUnits}` : '',
    ].filter(Boolean);
    return `- ${label}: ${summarizeClaimValue(value)}${signals.length ? ` (${signals.join('; ')})` : ''}`;
  });
}

function contradictionDecisionLines(approval: BrainApproval, subject: string, common: string[]): string[] {
  const payload = approval.payload ?? {};
  const entity = firstText(payload, [['entity_id'], ['entity'], ['record_id'], ['subject']], 180) || subject;
  const field = firstText(payload, [['field'], ['property'], ['key']], 160);
  const claims = contradictionClaimLines(approval);
  const confidence = percent(payload['confidence']);
  const sourceFactIds = shortList(payload['source_fact_ids'], 8);
  const sourceTextUnits = shortList(payload['source_text_unit_ids'], 8);
  const consecutiveCycles = Number(payload['consecutive_cycle_count']);
  const repeated = payload['observed_in_consecutive_cycles'] === true
    ? Number.isFinite(consecutiveCycles) && consecutiveCycles > 0
      ? `seen in ${Math.round(consecutiveCycles)} consecutive cycles`
      : 'seen in consecutive cycles'
    : '';
  const proposed = asRecord(payload['proposed_resolution']);
  const requiredFields = shortList(proposed['required_fields'], 6);
  const losingStatuses = shortList(proposed['allowed_losing_status'], 6);
  const reversible = proposed['reversible'] ?? approval.governance?.risk?.reversible;
  const applyRoute = firstText(proposed, [['apply_route']], 120);
  const signals = [
    confidence ? `Brain confidence ${confidence}` : '',
    sourceFactIds ? `source fact IDs ${sourceFactIds}` : '',
    sourceTextUnits ? `source text units ${sourceTextUnits}` : '',
    repeated,
    `rollback available: ${booleanLabel(reversible)}`,
  ].filter(Boolean);
  const applyNotes = [
    requiredFields ? `Brain apply requires ${requiredFields}` : '',
    losingStatuses ? `losing fact can be marked ${losingStatuses}` : '',
    applyRoute ? `apply route ${applyRoute}` : '',
  ].filter(Boolean);

  return [
    'Decision: Which stored fact should Brain trust for this exact topic, and which competing fact should stay disputed/superseded?',
    `Topic: ${entity}${field ? ` / field: ${field}` : ''}.`,
    claims.length
      ? `Competing facts Brain is asking you to compare:\n${claims.join('\n')}`
      : 'Competing facts: not included in this Inbox payload. Do not approve from this card; open Brain Health to inspect the claims and choose the winner.',
    signals.length ? `Evidence signals: ${signals.join('; ')}.` : '',
    common.join(' '),
    'Real question: are these two records mutually exclusive versions of the same fact, or are they both valid facts that should be split by commit, date, chain, contract, or another scope?',
    'Approve means: mark this approval as reviewed only after the winner is clear. This Inbox button does not pick the winner by itself; if Brain still needs a winning_fact_id, the guarded apply step must get that from Brain Health or a proposal review before facts change.',
    'Reject means: keep Brain from changing these facts from this approval. Use this when the card does not show enough evidence, when both facts can be true under different scopes, or when the winning fact is not obvious.',
    applyNotes.length ? `Apply guardrails: ${applyNotes.join('; ')}.` : '',
    field === 'changed_diff_snippets'
      ? 'For repo change summaries: approve only if one claim is the correct snapshot for this repo field. If both are real changes from different commits/builds, reject or resolve in Brain Health by splitting the facts instead of choosing a false winner.'
      : '',
  ].filter(Boolean);
}

function approvalPlainLanguage(approval: BrainApproval, kind: string, subject: string, reason: string): string[] {
  const payload = approval.payload ?? {};
  const candidates = candidateLabels(approval);
  const risk = clip(approval.risk_level || approval.governance?.risk?.level || 'medium', 80);
  const similarity = percent(payload['similarity']);
  const reversible = payload['reversible'] ?? approval.governance?.risk?.reversible;
  const hardDelete = payload['hard_delete'];
  const common = [
    `Risk: ${risk}.`,
    reason ? `Why Brain is asking: ${reason}.` : '',
  ].filter(Boolean);

  switch (kind) {
    case 'entity.alias.fuzzy_merge':
      return [
        'Question: Should Brain treat these two records as the same thing, or keep them separate?',
        candidates.length ? `Records to compare:\n${candidates.map((c) => `- ${c}`).join('\n')}` : `Record names: ${subject}.`,
        'Proof needed to approve: same real-world entity. For tokens, contracts, chains, or wallets, approve only if the chain and contract/address evidence match.',
        [...common, similarity ? `Brain signal: names are ${similarity} similar.` : 'Brain signal: name similarity only.', `Reversible: ${booleanLabel(reversible)}.`, hardDelete === false ? 'No record will be hard-deleted.' : 'Deletion behavior: review before approving.'].filter(Boolean).join(' '),
        'Approve means: queue a reversible Brain alias merge so future Brain lookup/search may treat these records as one canonical thing.',
        'Reject means: keep both Brain records independent. Use this when they are different tokens, different contracts, different chains, or you are unsure.',
      ];
    case 'memory.retire':
      return memoryRetireDecisionLines(approval, subject, common);
    case 'team.instruction.supersede':
      return [
        'Plain-English meaning: Brain found an older team instruction that appears to be replaced by newer guidance.',
        `Instruction/topic: ${subject}.`,
        common.join(' '),
        'Approve if: the newer instruction should become the source of truth.',
        'Reject if: the older instruction is still valid or needs manual consolidation first.',
      ];
    case 'fact.contradiction':
      return contradictionDecisionLines(approval, subject, common);
    case 'skill.publish':
      return [
        'Plain-English meaning: Brain has a skill proposal that may be ready to publish into the skill catalog.',
        `Skill/proposal: ${subject}.`,
        common.join(' '),
        'Approve if: the skill has enough evidence, a clear scope, and should become searchable/assignable.',
        'Reject if: the skill is incomplete, redundant, unsafe, or not useful yet.',
      ];
    case 'skill.proposal.evidence_invalid':
      return [
        'Plain-English meaning: Brain found a skill proposal whose supporting evidence looks weak or invalid.',
        `Skill/proposal: ${subject}.`,
        common.join(' '),
        'Approve if: you agree the evidence is invalid and the proposal should be held back or repaired.',
        'Reject if: the evidence is actually valid and Brain should not mark it as an evidence problem.',
      ];
    default:
      return [
        'Plain-English meaning: Brain is asking for human review before changing its memory, catalog, or governance state.',
        `Item: ${subject}.`,
        common.join(' '),
        'Approve if: the proposed change is correct and safe to queue.',
        'Reject if: the current state should remain unchanged.',
      ];
  }
}

function questionForApproval(approval: BrainApproval): BlockerQuestion {
  const id = String(approval.id);
  const kind = clip(approval.kind || 'approval', 120);
  const subject = clip(approval.subject || '(no subject)', 200);
  const risk = clip(approval.risk_level || approval.governance?.risk?.level || 'medium', 80);
  const reason = clip(approval.governance?.human_attention?.reason || approval.payload?.['recommendation'] || '', 240);
  const detail = [
    `Brain approval #${id}`,
    '',
    `Review type: ${kind}`,
    `Short label: ${subject}`,
    '',
    ...approvalPlainLanguage(approval, kind, subject, reason).filter(Boolean),
    '',
    `Resolution path: ${resolutionPath(kind)}.`,
    'What happens after approval: IDACC marks this approval as approved and Brain may place it into its guarded apply queue. The actual apply step remains separate and auditable.',
    'What happens after rejection: IDACC marks this approval as rejected and Brain keeps the current state.',
  ].join('\n');

  const options = kind === 'entity.alias.fuzzy_merge'
    ? ['Approve alias merge', 'Reject / keep separate']
    : kind === 'memory.retire'
      ? ['Approve retirement after review', 'Reject / keep memory active']
      : kind === 'fact.contradiction'
        ? ['Approve only after winner is clear', 'Reject / needs more evidence']
        : ['Approve after review — queue Brain change', 'Reject — keep current Brain state'];

  return {
    id: `brain-approval-${id}`,
    question: detail,
    options,
    agent: '',
    taskRef: `brain-approval:${id}`,
    taskTitle: `Brain approval #${id}`,
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
      detailVersion: 4,
    },
  };
}

async function doSync(limit = 100): Promise<BrainApprovalSyncResult> {
  const response = await brainJson<BrainApprovalListResponse>(`/approvals?status=pending&limit=${Math.max(1, Math.min(200, limit))}`);
  const approvals = response.approvals ?? response.data?.approvals ?? [];
  const pendingKeys = new Set(approvals.map((approval) => `brain-approval:${approval.id}`));
  const existing = listQuestions().filter((q) => q.dedupeKey?.startsWith('brain-approval:') || q.taskRef?.startsWith('brain-approval:'));
  const existingByKey = new Map(existing.map((q) => [q.dedupeKey || q.taskRef || q.id, q]));

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
    const next = questionForApproval(approval);
    const current = existingByKey.get(key);
    if (current) {
      const stale = current.question !== next.question
        || current.taskTitle !== next.taskTitle
        || current.options.join('\u001f') !== next.options.join('\u001f')
        || current.metadata?.detailVersion !== next.metadata?.detailVersion;
      if (!stale) continue;
      removeQuestion(current.id);
      addQuestion({
        ...next,
        createdAt: current.createdAt || next.createdAt,
        seenCount: current.seenCount,
        lastSeenAt: current.lastSeenAt,
      });
      synced++;
      continue;
    }
    addQuestion(next);
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
