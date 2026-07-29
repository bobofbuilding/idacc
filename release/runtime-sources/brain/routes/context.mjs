import { buildVolunteerContext } from '../context/service.mjs';
import { idempotencyErrorBody } from '../idempotency.mjs';

export async function handleContextRoutes({
  method,
  path,
  req,
  res,
  db,
  readBody,
  send,
  ok,
  canonicalSourceId,
  normalizeSourceIds,
  mergeSourceOrigins,
  bundleCanonicalSourceIds,
  sourcePrecisionStats,
  repoHintsForContext,
  extractContextCandidates,
  buildLocalContext,
  findTrajectoryMemoryContext,
  findSharedMemoryContext,
  sourceOriginsForBundle,
  attachVolunteerMetadata,
  highPrecisionExpansion,
  applyContextBudget,
  createContextPackage,
  parseContextPackage,
  expandCanonicalSources,
  latestTaskVolunteeredContext,
  recordFeedbackMissing,
  markMemoriesVolunteered,
} = {}) {
  let m;

  const invalidPositiveNumber = (value) => value !== undefined
    && (!Number.isFinite(Number(value)) || Number(value) <= 0);

  if (method === 'POST' && path === '/context/volunteer') {
    const b = await readBody(req);
    const text = b.text ?? b.q ?? '';
    if (!text) return send(res, 400, { error: 'text required' });
    if (invalidPositiveNumber(b.limit)) return send(res, 400, { error: 'limit must be a positive number' });
    if (invalidPositiveNumber(b.max_sources ?? b.maxSources)) return send(res, 400, { error: 'max_sources must be a positive number' });
    if (invalidPositiveNumber(b.max_chars ?? b.maxChars)) return send(res, 400, { error: 'max_chars must be a positive number' });
    send(res, 200, ok(buildVolunteerContext({
        db,
        canonicalSourceId,
        mergeSourceOrigins,
        bundleCanonicalSourceIds,
        sourcePrecisionStats,
        repoHintsForContext,
        extractContextCandidates,
        buildLocalContext,
        findTrajectoryMemoryContext,
        findSharedMemoryContext,
        sourceOriginsForBundle,
        attachVolunteerMetadata,
        highPrecisionExpansion,
        applyContextBudget,
        createContextPackage,
        markMemoriesVolunteered,
      }, b), { mode: 'volunteer' }));
    return true;
  }

  if (method === 'POST' && path === '/context/package') {
    const b = await readBody(req);
    const taskId = b.task_id ?? b.taskId ?? '';
    const provided = b.source_ids ?? b.sourceIds ?? b.canonical_source_ids ?? b.canonicalSourceIds ?? [];
    const latest = latestTaskVolunteeredContext(taskId);
    const canonical = normalizeSourceIds(provided).canonical;
    const sourceIds = canonical.length ? canonical : latest.canonical;
    if (!sourceIds.length) return send(res, 400, { error: 'source_ids or task_id with volunteered context required' });
    const id = createContextPackage({
      taskId,
      agentId: b.agent_id ?? b.agentId ?? '',
      queryText: b.query_text ?? b.queryText ?? b.text ?? '',
      summary: b.summary ?? '',
      sourceIds,
      includedSourceIds: b.included_source_ids ?? b.includedSourceIds ?? sourceIds,
      omittedSourceIds: b.omitted_source_ids ?? b.omittedSourceIds ?? [],
      retrievableSourceIds: b.retrievable_source_ids ?? b.retrievableSourceIds ?? [],
      sourceOrigins: b.source_origins ?? b.sourceOrigins ?? latest.sourceOrigins,
      budget: b.budget ?? {},
      timelineEventId: b.timeline_event_id ?? b.timelineEventId ?? null,
      expiresAt: b.expires_at ?? b.expiresAt ?? null,
      ttlSeconds: b.ttl_seconds ?? b.ttlSeconds ?? null,
    });
    send(res, 200, { ok: true, package: parseContextPackage(db.prepare(`SELECT * FROM context_packages WHERE id=?`).get(id)) });
    return true;
  }

  m = path.match(/^\/context\/packages\/(\d+)$/);
  if (method === 'GET' && m) {
    const pkg = parseContextPackage(db.prepare(`SELECT * FROM context_packages WHERE id=?`).get(Number(m[1])));
    if (!pkg) return send(res, 404, { error: 'context package not found' });
    send(res, 200, { ok: true, package: pkg });
    return true;
  }

  m = path.match(/^\/context\/packages\/(\d+)\/expand$/);
  if (method === 'POST' && m) {
    const b = await readBody(req);
    const pkg = parseContextPackage(db.prepare(`SELECT * FROM context_packages WHERE id=?`).get(Number(m[1])));
    if (!pkg) return send(res, 404, { error: 'context package not found' });
    if (pkg.expires_at != null && Number(pkg.expires_at) < Math.floor(Date.now() / 1000)) {
      return send(res, 410, { error: 'context package expired' });
    }
    const scope = b.scope ?? 'all';
    const requested = b.source_ids ?? b.sourceIds ?? [];
    const ids = requested.length ? requested
      : scope === 'included' ? pkg.included_source_ids
      : scope === 'retrievable' ? pkg.retrievable_source_ids
      : scope === 'omitted' ? pkg.omitted_source_ids
      : [...new Set([...pkg.included_source_ids, ...pkg.omitted_source_ids, ...pkg.retrievable_source_ids])];
    const expanded = expandCanonicalSources(ids);
    db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
      .run('brain-context', 'context:package-expanded', String(pkg.id), JSON.stringify({
        package_id: pkg.id,
        task_id: pkg.task_id,
        scope,
        requested_source_ids: normalizeSourceIds(ids).canonical,
        returned_source_ids: expanded.sources.map(s => s.canonical_source_id),
        missing_source_ids: expanded.missing,
      }), JSON.stringify(['brain', 'context', 'package']));
    send(res, 200, { ok: true, package: pkg, ...expanded });
    return true;
  }

  if (method === 'POST' && path === '/context/feedback-missing') {
    const b = await readBody(req);
    let recorded;
    try {
      recorded = recordFeedbackMissing({
        taskId: b.task_id ?? b.taskId ?? '',
        queryId: b.query_id ?? b.queryId ?? '',
        agentId: b.agent_id ?? b.agentId ?? '',
        queryText: b.query_text ?? b.queryText ?? b.q ?? b.text ?? '',
        volunteeredSourceIds: b.volunteered_source_ids ?? b.volunteeredSourceIds ?? b.brain_context?.cited?.canonical_source_ids ?? [],
        source: b.source ?? 'brain-context',
        metadata: b.metadata ?? {},
        idempotencyKey: b.idempotency_key ?? b.idempotencyKey ?? null,
      });
    } catch (error) {
      if (error?.status) {
        send(res, error.status, idempotencyErrorBody(error));
        return true;
      }
      throw error;
    }
    if (!recorded) return send(res, 404, { error: 'no volunteered context found' });
    send(res, 200, { ok: true, event: recorded });
    return true;
  }

  return false;
}
