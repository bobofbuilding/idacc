import { createHash } from 'node:crypto';

export async function handleApprovalQueueRoutes({ method, path, searchParams, req, res, db, readBody, send, fail, parseJson }) {
  const isCreateRoute = path === '/approvals' || path === '/proposals';
  const isListRoute = path === '/approvals' || path === '/proposals';
  const envelope = (data = {}, meta = {}) => ({ ok: true, data, meta, profile: 'local', ...data });
  const stableClone = value => {
    if (Array.isArray(value)) return value.map(stableClone);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach(key => { out[key] = stableClone(value[key]); });
      return out;
    }
    return value ?? null;
  };
  const approvalSnapshotStamp = row => {
    if (!row) return '';
    return JSON.stringify(stableClone({
      id: row.id,
      status: row.status,
      kind: row.kind,
      subject: row.subject,
      riskLevel: row.risk_level ?? null,
      requestedBy: row.requested_by ?? null,
      createdAt: row.created_at ?? null,
      resolvedAt: row.resolved_at ?? null,
      payload: parseJson(row.payload, {}),
      resolution: parseJson(row.resolution, {}),
    }));
  };

  const insertApproval = (body = {}) => db.prepare(`
    INSERT INTO approvals (kind, subject, payload, risk_level, requested_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    body.kind,
    body.subject ?? '',
    JSON.stringify(body.payload ?? {}),
    body.risk_level ?? body.riskLevel ?? 'medium',
    body.requested_by ?? body.requestedBy ?? 'brain',
  );

  const governanceMetadata = (row, payload, resolution, { proposalView = false } = {}) => {
    const stablePrefix = proposalView ? 'proposal' : 'approval';
    const riskLevel = String(row.risk_level ?? 'medium').toLowerCase();
    const existing = payload?.governance ?? {};
    const traceSeed = JSON.stringify({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      status: row.status,
      risk_level: riskLevel,
      created_at: row.created_at,
      payload,
      resolution,
    });
    const qualityMarker = row.kind === 'fact.contradiction'
      ? (row.status === 'resolved' ? 'resolved' : row.status === 'rejected' ? 'rejected' : 'disputed')
      : row.kind === 'edge.repair'
        ? (row.status === 'resolved' ? 'repaired' : row.status === 'rejected' ? 'rejected' : 'repair-review')
        : row.status === 'resolved' || row.status === 'approved'
          ? 'actioned'
          : row.status === 'rejected'
            ? 'rejected'
            : 'review';
    const humanAttentionRequired = Boolean(existing.human_attention?.required)
      || row.status === 'pending'
      || riskLevel === 'high'
      || row.kind === 'fact.contradiction'
      || row.kind === 'edge.repair';
    const reviewRequired = humanAttentionRequired || riskLevel !== 'low';
    const reviewSlaSeconds = Number(existing.queue?.review_sla_seconds ?? (riskLevel === 'high' ? 3600 * 4 : riskLevel === 'medium' ? 3600 * 24 : 3600 * 72));
    return {
      stable_id: existing.stable_id ?? `${stablePrefix}:${row.id}`,
      cycle_id: existing.cycle_id ?? null,
      decision_trace_id: existing.decision_trace_id ?? `decision-trace:${stablePrefix}:${row.id}`,
      decision_trace_hash: existing.decision_trace_hash ?? createHash('sha256').update(traceSeed).digest('hex').slice(0, 16),
      eval_replay_ref: existing.eval_replay_ref ?? { route: '/eval/replay', method: 'POST' },
      control_center_ref: existing.control_center_ref ?? '/dashboard/learning',
      status_marker: existing.status_marker ?? row.status,
      quality_marker: existing.quality_marker ?? qualityMarker,
      risk: {
        schema_version: existing.risk?.schema_version ?? 'risk.v1',
        level: existing.risk?.level ?? riskLevel,
        score: existing.risk?.score ?? (riskLevel === 'high' ? 0.9 : riskLevel === 'medium' ? 0.6 : 0.3),
        category: existing.risk?.category ?? (row.kind.startsWith('fact.')
          ? 'knowledge-integrity'
          : row.kind.startsWith('entity.alias')
            ? 'identity-resolution'
            : row.kind.startsWith('edge.')
              ? 'graph-integrity'
              : 'operational-learning'),
        action: existing.risk?.action ?? (reviewRequired ? 'review-required' : 'auto-apply-eligible'),
        reversible: existing.risk?.reversible ?? true,
      },
      inverse_op: {
        kind: existing.inverse_op?.kind ?? null,
        ready: existing.inverse_op?.ready ?? false,
        ref: existing.inverse_op?.ref ?? null,
        metadata: existing.inverse_op?.metadata ?? {},
      },
      audit: {
        rubric_version: existing.audit?.rubric_version ?? 'curator.v1',
        rubric_id: existing.audit?.rubric_id ?? `${row.kind}.default`,
        decision_trace_id: existing.audit?.decision_trace_id ?? (existing.decision_trace_id ?? `decision-trace:${stablePrefix}:${row.id}`),
        checks: existing.audit?.checks ?? [],
        notes: existing.audit?.notes ?? [],
      },
      queue: {
        queued_at: existing.queue?.queued_at ?? row.created_at,
        resolved_at: existing.queue?.resolved_at ?? row.resolved_at ?? null,
        review_required: existing.queue?.review_required ?? reviewRequired,
        review_sla_seconds: reviewSlaSeconds,
        review_due_at: existing.queue?.review_due_at ?? (row.created_at ? row.created_at + reviewSlaSeconds : null),
        age_seconds: row.created_at ? Math.max(0, Math.floor(Date.now() / 1000) - Number(row.created_at)) : null,
      },
      human_attention: {
        required: humanAttentionRequired,
        level: existing.human_attention?.level ?? (riskLevel === 'high' ? 'high' : row.status === 'pending' ? 'medium' : 'low'),
        reason: existing.human_attention?.reason
          ?? (row.kind === 'fact.contradiction'
            ? 'cross-source contradiction requires review'
            : row.kind === 'edge.repair'
              ? 'graph edge repair requires review'
            : row.status === 'pending'
              ? 'pending review'
              : riskLevel === 'high'
                ? 'high-risk action'
                : 'no immediate operator action'),
      },
    };
  };

  const decodeApprovalRow = (row, { proposalView = false } = {}) => {
    const payload = parseJson(row.payload, {});
    const resolution = parseJson(row.resolution, {});
    return {
      ...row,
      payload,
      resolution,
      governance: governanceMetadata(row, payload, resolution, { proposalView }),
    };
  };

  if (method === 'POST' && isCreateRoute) {
    const b = await readBody(req);
    if (!b.kind) {
      fail(res, 400, 'brain.validation', 'kind required', {
        hint: 'include a proposal or approval kind',
        retry_command: 'POST /approvals',
        risk: { level: 'medium', action: 'inspect' },
      });
      return true;
    }
    const r = insertApproval(b);
    const id = Number(r.lastInsertRowid);
    const created = decodeApprovalRow(db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id), { proposalView: path === '/proposals' });
    const response = envelope({ id, approval: created }, { route: path, action: 'create' });
    if (path === '/proposals') response.proposal = created;
    send(res, 200, response);
    return true;
  }

  if (method === 'GET' && isListRoute) {
    const status = searchParams.get('status') ?? 'pending';
    const kind = searchParams.get('kind');
    const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
    const clauses = ['status=?'];
    const params = [status];
    if (kind) {
      clauses.push('kind=?');
      params.push(kind);
    }
    const rows = db.prepare(`SELECT * FROM approvals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit)
      .map(row => decodeApprovalRow(row, { proposalView: path === '/proposals' }));
    if (path === '/proposals') {
      send(res, 200, envelope({ proposals: rows }, { route: path, status }));
      return true;
    }
    send(res, 200, envelope({ approvals: rows }, { route: path, status }));
    return true;
  }

  const getMatch = path.match(/^\/(?:approvals|proposals)\/(\d+)$/);
  if (method === 'GET' && getMatch) {
    const row = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(Number(getMatch[1]));
    if (!row) {
      fail(res, 404, 'brain.not_found', 'approval not found', {
        hint: 'check the approval id',
        retry_command: `GET ${path}`,
        risk: { level: 'low', action: 'inspect' },
      });
      return true;
    }
    const decoded = decodeApprovalRow(row, { proposalView: path.startsWith('/proposals/') });
    const response = envelope({ id: decoded.id, approval: decoded }, { route: path, action: 'get' });
    if (path.startsWith('/proposals/')) response.proposal = decoded;
    send(res, 200, response);
    return true;
  }

  const resolveMatch = path.match(/^\/(?:approvals|proposals)\/(\d+)\/resolve$/);
  if (method === 'POST' && resolveMatch) {
    const b = await readBody(req);
    const status = b.status ?? (b.approved === true ? 'approved' : b.approved === false ? 'rejected' : 'resolved');
    if (!['approved', 'rejected', 'resolved', 'cancelled'].includes(status)) {
      fail(res, 400, 'brain.validation', 'invalid status', {
        hint: 'use approved, rejected, resolved, or cancelled',
        retry_command: `POST ${path} with a valid status`,
        risk: { level: 'medium', action: 'inspect' },
      });
      return true;
    }
    const current = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(Number(resolveMatch[1]));
    if (!current || current.status !== 'pending') {
      fail(res, 404, 'brain.not_found', 'pending approval not found', {
        hint: 'check the approval id and pending status',
        retry_command: `GET /approvals?status=pending&id=${resolveMatch[1]}`,
        risk: { level: 'low', action: 'inspect' },
      });
      return true;
    }
    const expectedStamp = b.expectedStamp ?? b.expectedApprovalStamp;
    if (expectedStamp && expectedStamp !== approvalSnapshotStamp(current)) {
      fail(res, 409, 'brain.conflict', 'approval changed since review', {
        hint: 'refresh the approval queue and review the current payload before resolving',
        retry_command: `GET /approvals/${resolveMatch[1]}`,
        risk: { level: 'medium', action: 'refresh' },
      });
      return true;
    }
    const r = db.prepare(`UPDATE approvals SET status=?, resolution=?, resolved_at=unixepoch() WHERE id=? AND status='pending'`)
      .run(status, JSON.stringify(b.resolution ?? {}), Number(resolveMatch[1]));
    if (!r.changes) {
      fail(res, 404, 'brain.not_found', 'pending approval not found', {
        hint: 'check the approval id and pending status',
        retry_command: `GET /approvals?status=pending&id=${resolveMatch[1]}`,
        risk: { level: 'low', action: 'inspect' },
      });
      return true;
    }
    const id = Number(resolveMatch[1]);
    const updated = decodeApprovalRow(db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id), { proposalView: path.startsWith('/proposals/') });
    const response = envelope({ id, status, approval: updated }, { route: path, action: 'resolve' });
    if (path.startsWith('/proposals/')) response.proposal = updated;
    send(res, 200, response);
    return true;
  }

  return false;
}
