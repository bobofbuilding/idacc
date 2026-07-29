import { completeLearningTask, createLearningTask, parseLearningTask, parseRollbackRecord, recoverExpiredLearningTaskLeases } from '../learning-policy.mjs';
import { detectKnowledgeGapSignals } from '../knowledge-gap-detector.mjs';
import { curatorUnmergeEntities, curatorRestoreEntityType } from '../db.mjs';
import {
  canonicalContentHash,
  deriveIdempotencyKey,
  idempotencyConflict,
  idempotencyErrorBody,
  insertIdempotentTimeline,
  normalizeIdempotencyKey,
} from '../idempotency.mjs';

function insertTimeline(db, { source = 'learning-routes', type, subject = '', data = {}, tags = [] }) {
  const r = db.prepare(`
    INSERT INTO timeline (source, type, subject, data, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, type, subject, JSON.stringify(data ?? {}), JSON.stringify(tags ?? []));
  return Number(r.lastInsertRowid);
}

function stringifyJsonColumns(row, columns = []) {
  const out = { ...(row ?? {}) };
  for (const column of columns) {
    if (out[column] !== undefined && typeof out[column] !== 'string') out[column] = JSON.stringify(out[column] ?? {});
  }
  return out;
}

function restoreRow(db, table, row, { jsonColumns = [] } = {}) {
  if (!row || typeof row !== 'object') return null;
  const clean = stringifyJsonColumns(row, jsonColumns);
  const columns = Object.keys(clean).filter(key => clean[key] !== undefined);
  if (!columns.length) return null;
  db.prepare(`
    INSERT OR REPLACE INTO ${table} (${columns.join(',')})
    VALUES (${columns.map(() => '?').join(',')})
  `).run(...columns.map(column => clean[column]));
  return clean.id ?? null;
}

function restoreSourceState(db, subject, beforeState = {}) {
  const id = String(subject ?? '');
  if (id.startsWith('entity:')) return restoreRow(db, 'entities', beforeState);
  if (id.startsWith('fact:')) return restoreRow(db, 'facts', beforeState, { jsonColumns: ['value', 'context'] });
  if (id.startsWith('text:')) return restoreRow(db, 'text_units', beforeState, { jsonColumns: ['metadata'] });
  if (id.startsWith('memory:')) return restoreRow(db, 'agent_memories', beforeState, { jsonColumns: ['tags'] });
  throw Object.assign(new Error(`unsupported source rollback subject: ${id}`), { status: 400 });
}

function applyRollbackRecord(db, rollback, parseJson, { source = 'learning-routes' } = {}) {
  const before = parseJson(rollback.before_state, {});
  const after = parseJson(rollback.after_state, {});
  const inverse = rollback.inverse_action;
  const result = { inverse_action: inverse };

  if (inverse === 'memory.restore' || inverse === 'memory.status.restore') {
    const memory = before.memory;
    if (!memory) throw Object.assign(new Error('rollback missing memory before_state'), { status: 400 });
    result.memory_id = restoreRow(db, 'agent_memories', memory, { jsonColumns: ['tags'] });
  } else if (inverse === 'memory.delete') {
    const memoryId = Number(after.memory?.id ?? after.memory_id ?? before.memory?.id);
    if (!Number.isInteger(memoryId)) throw Object.assign(new Error('rollback missing memory id'), { status: 400 });
    db.prepare(`DELETE FROM agent_memories WHERE id=?`).run(memoryId);
    result.memory_id = memoryId;
  } else if (inverse === 'restore_source_state') {
    result.source_id = rollback.subject;
    result.restored_id = restoreSourceState(db, rollback.subject, before);
  } else if (inverse === 'restore_approval_pending') {
    result.approval_id = restoreRow(db, 'approvals', before, { jsonColumns: ['payload', 'resolution'] });
  } else if (inverse === 'learning_task.cancel') {
    const taskId = Number(after.learning_task_id);
    if (!Number.isInteger(taskId)) throw Object.assign(new Error('rollback missing learning task id'), { status: 400 });
    db.prepare(`UPDATE learning_tasks SET status='cancelled', updated_at=unixepoch() WHERE id=?`).run(taskId);
    result.learning_task_id = taskId;
  } else if (inverse === 'eval.fixture.delete') {
    const fixtureId = Number(after.fixture?.id ?? after.fixture_id);
    if (!Number.isInteger(fixtureId)) throw Object.assign(new Error('rollback missing fixture id'), { status: 400 });
    db.prepare(`DELETE FROM eval_fixtures WHERE id=?`).run(fixtureId);
    result.fixture_id = fixtureId;
  } else if (inverse === 'eval.fixture.restore') {
    const fixture = before.fixture;
    if (!fixture) throw Object.assign(new Error('rollback missing fixture before_state'), { status: 400 });
    result.fixture_id = restoreRow(db, 'eval_fixtures', fixture, { jsonColumns: ['required_source_ids', 'required_strings', 'metadata'] });
  } else if (inverse === 'facts.restore-statuses') {
    const facts = Array.isArray(before.facts) ? before.facts : [];
    if (!facts.length) throw Object.assign(new Error('rollback missing fact statuses'), { status: 400 });
    const stmt = db.prepare(`UPDATE facts SET status=? WHERE id=?`);
    for (const fact of facts) stmt.run(fact.status ?? 'active', Number(fact.id));
    result.fact_ids = facts.map(fact => Number(fact.id)).filter(Number.isInteger);
  } else if (inverse === 'skill.enable') {
    if (before.skill) restoreRow(db, 'skill_nodes', before.skill, { jsonColumns: ['tags'] });
    if (before.entity) restoreRow(db, 'entities', before.entity, { jsonColumns: ['data', 'tags'] });
    result.skill_id = before.skill?.skill_id ?? before.entity?.id ?? rollback.subject;
  } else if (inverse === 'entity.unmerge') {
    result.unmerged = curatorUnmergeEntities(before);
  } else if (inverse === 'entity.retype') {
    result.entity_id = curatorRestoreEntityType(before);
  } else {
    throw Object.assign(new Error(`unsupported rollback inverse action: ${inverse}`), { status: 400 });
  }

  const eventId = insertTimeline(db, {
    source,
    type: 'learning-rollback:applied',
    subject: String(rollback.id),
    data: {
      rollback_id: rollback.id,
      approval_id: rollback.approval_id,
      kind: rollback.kind,
      subject: rollback.subject,
      ...result,
    },
    tags: ['learning', 'rollback', 'applied'],
  });
  db.prepare(`UPDATE learning_rollback_records SET applied_at=unixepoch() WHERE id=?`).run(rollback.id);
  return { ...result, timeline_event_id: eventId };
}

export async function handleLearningRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson }) {
  if (method === 'GET' && path === '/learning-tasks') {
    const status = searchParams.get('status');
    const assignee = searchParams.get('assignee');
    const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
    const conds = [];
    const params = [];
    if (status) { conds.push('status=?'); params.push(status); }
    if (assignee) { conds.push('assignee=?'); params.push(assignee); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT * FROM learning_tasks
      ${where}
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(...params, limit).map(r => parseLearningTask(r, parseJson));
    send(res, 200, { ok: true, tasks: rows });
    return true;
  }

  if (method === 'POST' && path === '/learning-tasks') {
    const b = await readBody(req);
    const kind = String(b.kind ?? '').trim();
    if (!kind) {
      send(res, 400, { error: 'kind required' });
      return true;
    }
    let idempotencyKey;
    try {
      idempotencyKey = normalizeIdempotencyKey(
        b.idempotency_key ?? b.idempotencyKey ?? null,
      );
    } catch (error) {
      send(res, error.status ?? 400, idempotencyErrorBody(error));
      return true;
    }
    const taskInput = {
      kind,
      subject: String(b.subject ?? ''),
      approvalId: b.approval_id ?? b.approvalId ?? null,
      assignee: String(b.assignee ?? ''),
      status: b.status ?? 'queued',
      priority: Number(b.priority ?? 0),
      evidenceIds: b.evidence_ids ?? b.evidenceIds ?? {},
      payload: b.payload ?? {},
      result: b.result ?? {},
    };
    const canonicalTask = {
      ...taskInput,
      source: b.source ?? 'learning-routes',
    };
    const idempotencyHash = canonicalContentHash(canonicalTask);
    let transactionOpen = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      if (idempotencyKey) {
        const existing = db.prepare(`
          SELECT *
          FROM learning_tasks
          WHERE idempotency_key=?
        `).get(idempotencyKey);
        if (existing) {
          if (existing.idempotency_hash !== idempotencyHash) {
            throw idempotencyConflict('learning task', idempotencyKey, Number(existing.id));
          }
          db.exec('COMMIT');
          transactionOpen = false;
          send(res, 200, {
            ok: true,
            task: parseLearningTask(existing, parseJson),
            deduplicated: true,
          });
          return true;
        }
      }
      const id = createLearningTask(db, {
        ...taskInput,
        idempotencyKey,
        idempotencyHash: idempotencyKey ? idempotencyHash : null,
      });
      insertIdempotentTimeline(db, {
        source: 'learning-routes',
        type: 'learning-task:created',
        subject: String(id),
        data: { id, kind, subject: b.subject ?? '', source: b.source ?? 'learning-routes' },
        tags: ['learning-task', kind],
        idempotencyKey: idempotencyKey
          ? deriveIdempotencyKey(idempotencyKey, 'learning-task-created')
          : null,
      });
      const row = db.prepare(`SELECT * FROM learning_tasks WHERE id=?`).get(id);
      db.exec('COMMIT');
      transactionOpen = false;
      send(res, 200, {
        ok: true,
        task: parseLearningTask(row, parseJson),
        deduplicated: false,
      });
    } catch (error) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      if (error?.status) {
        send(res, error.status, idempotencyErrorBody(error));
        return true;
      }
      throw error;
    }
    return true;
  }

  if (method === 'POST' && path === '/learning-tasks/claim') {
    const b = await readBody(req);
    const assignee = String(b.assignee ?? b.agent_id ?? b.agentId ?? '').trim();
    if (!assignee) {
      send(res, 400, { error: 'assignee required' });
      return true;
    }
    const kinds = Array.isArray(b.kinds ?? b.kind)
      ? (b.kinds ?? b.kind).map(String).filter(Boolean)
      : (b.kind ? [String(b.kind)] : []);
    const limit = Math.min(Math.max(Number(b.limit ?? 1), 1), 25);
    const leaseSeconds = Math.min(Math.max(Number(b.lease_seconds ?? b.leaseSeconds ?? 3600), 60), 86400);
    const recovered = recoverExpiredLearningTaskLeases(db, {
      limit: Number(b.recover_limit ?? b.recoverLimit ?? 100),
      source: 'learning-routes',
    });
    const conds = [`status='queued'`];
    const params = [];
    if (kinds.length) {
      conds.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    const rows = db.prepare(`
      SELECT * FROM learning_tasks
      WHERE ${conds.join(' AND ')}
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(...params, limit);
    const now = Math.floor(Date.now() / 1000);
    const claimed = [];
    for (const row of rows) {
      const payload = parseJson(row.payload, {});
      const result = parseJson(row.result, {});
      const nextPayload = {
        ...payload,
        claimed_by: assignee,
        claimed_at: now,
        lease_expires_at: now + leaseSeconds,
        retry_count: Number(payload.retry_count ?? 0),
      };
      const updated = db.prepare(`
        UPDATE learning_tasks
        SET status='assigned', assignee=?, payload=?, updated_at=unixepoch()
        WHERE id=? AND status='queued'
      `).run(assignee, JSON.stringify(nextPayload), row.id);
      if (!updated.changes) continue;
      insertTimeline(db, {
        type: 'learning-task:claimed',
        subject: String(row.id),
        data: { id: row.id, kind: row.kind, subject: row.subject, assignee, lease_expires_at: nextPayload.lease_expires_at },
        tags: ['learning-task', 'claimed'],
      });
      claimed.push(parseLearningTask({
        ...row,
        assignee,
        status: 'assigned',
        payload: JSON.stringify(nextPayload),
        result: JSON.stringify(result),
        updated_at: now,
      }, parseJson));
    }
    send(res, 200, { ok: true, claimed, recovered });
    return true;
  }

  if (method === 'POST' && path === '/learning-tasks/recover') {
    const b = await readBody(req);
    const recovered = recoverExpiredLearningTaskLeases(db, {
      limit: Math.min(Math.max(Number(b.limit ?? 100), 1), 1000),
      source: String(b.source ?? 'learning-routes'),
    });
    send(res, 200, { ok: true, ...recovered });
    return true;
  }

  if (method === 'POST' && path === '/brain/gap-detector/run') {
    const b = await readBody(req);
    const detector = detectKnowledgeGapSignals(db, {
      days: Number(b.days ?? 14),
      feedbackLimit: Number(b.feedback_limit ?? b.feedbackLimit ?? 200),
      evalLimit: Number(b.eval_limit ?? b.evalLimit ?? 200),
      lowPrecisionThreshold: Number(b.low_precision_threshold ?? b.lowPrecisionThreshold ?? 0.2),
      maxCreate: Number(b.max_create ?? b.maxCreate ?? 25),
      source: String(b.source ?? 'brain-gap-detector'),
      create: b.create === undefined ? true : Boolean(b.create),
    });
    send(res, 200, { ok: true, detector });
    return true;
  }

  const taskMatch = path.match(/^\/learning-tasks\/(\d+)$/);
  if (method === 'PATCH' && taskMatch) {
    const b = await readBody(req);
    const id = Number(taskMatch[1]);
    const current = db.prepare(`SELECT * FROM learning_tasks WHERE id=?`).get(id);
    if (!current) {
      send(res, 404, { error: 'learning task not found' });
      return true;
    }
    const status = b.status ?? current.status;
    if (!['queued', 'assigned', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(status)) {
      send(res, 400, { error: 'invalid status' });
      return true;
    }
    const assignee = b.assignee ?? current.assignee;
    const currentPayload = parseJson(current.payload, {});
    const nextPayload = b.payload === undefined ? currentPayload : { ...currentPayload, ...(b.payload ?? {}) };
    if (status === 'blocked') nextPayload.retry_count = Number(nextPayload.retry_count ?? 0) + 1;
    const resultObject = b.result === undefined ? parseJson(current.result, {}) : (b.result ?? {});
    let applied = null;
    if (status === 'completed' && current.status !== 'completed') {
      try {
        applied = completeLearningTask(db, { ...current, payload: JSON.stringify(nextPayload), result: JSON.stringify(resultObject) }, resultObject, {
          source: String(b.source ?? assignee ?? 'learning-routes'),
          parseJson,
        });
      } catch (error) {
        send(res, error.status ?? 400, { error: error.message, details: error.details ?? undefined });
        return true;
      }
    }
    const result = JSON.stringify({ ...resultObject, ...(applied ? { applied } : {}) });
    const completedAtExpr = status === 'completed' ? 'unixepoch()' : status === current.status ? 'completed_at' : 'NULL';
    db.prepare(`
      UPDATE learning_tasks
      SET status=?, assignee=?, payload=?, result=?, updated_at=unixepoch(), completed_at=${completedAtExpr}
      WHERE id=?
    `).run(status, assignee, JSON.stringify(nextPayload), result, id);
    const updated = db.prepare(`SELECT * FROM learning_tasks WHERE id=?`).get(id);
    send(res, 200, { ok: true, task: parseLearningTask(updated, parseJson), applied });
    return true;
  }

  if (method === 'GET' && path === '/learning-rollbacks') {
    const approvalId = searchParams.get('approval_id') ?? searchParams.get('approvalId');
    const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
    const rows = approvalId
      ? db.prepare(`SELECT * FROM learning_rollback_records WHERE approval_id=? ORDER BY created_at DESC LIMIT ?`).all(Number(approvalId), limit)
      : db.prepare(`SELECT * FROM learning_rollback_records ORDER BY created_at DESC LIMIT ?`).all(limit);
    send(res, 200, { ok: true, rollbacks: rows.map(r => parseRollbackRecord(r, parseJson)) });
    return true;
  }

  const rollbackApplyMatch = path.match(/^\/learning-rollbacks\/(\d+)\/apply$/);
  if (method === 'POST' && rollbackApplyMatch) {
    const b = await readBody(req);
    const id = Number(rollbackApplyMatch[1]);
    const rollback = db.prepare(`SELECT * FROM learning_rollback_records WHERE id=?`).get(id);
    if (!rollback) {
      send(res, 404, { error: 'rollback record not found' });
      return true;
    }
    if (rollback.applied_at) {
      send(res, 200, { ok: true, rollback: parseRollbackRecord(rollback, parseJson), alreadyApplied: true });
      return true;
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      const applied = applyRollbackRecord(db, rollback, parseJson, { source: String(b.source ?? 'learning-routes') });
      db.exec('COMMIT');
      const updated = db.prepare(`SELECT * FROM learning_rollback_records WHERE id=?`).get(id);
      send(res, 200, { ok: true, rollback: parseRollbackRecord(updated, parseJson), applied });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      send(res, error.status ?? 400, { error: error.message });
    }
    return true;
  }

  return false;
}
