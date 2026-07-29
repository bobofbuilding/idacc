import { normalizeRouteIds, normalizeRouteAckState, normalizeStringList, stableEvalArtifactHash } from '../eval-artifact-hash.mjs';
import { CANONICAL_SOURCE_ORIGINS, normalizeSourceOrigins } from '../source-origins.mjs';
import { persistVectorReplayGateVerdict } from '../db.mjs';
import { validateSourceIds } from '../sources.mjs';
import {
  canonicalContentHash,
  deriveIdempotencyKey,
  idempotencyConflict,
  idempotencyErrorBody,
  normalizeIdempotencyKey,
} from '../idempotency.mjs';

function parseJsonObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => { out[key] = stableClone(value[key]); });
    return out;
  }
  return value ?? null;
}

export function evalReplaySnapshotStamp(rows = [], context = {}) {
  const sampleRows = rows.map(row => ({
    id: row.id,
    route: row.route,
    createdAt: row.created_at ?? null,
    artifactHash: row.artifact_hash ?? null,
    returnedEntityIds: row.returned_entity_ids ?? null,
    returnedTextUnitIds: row.returned_text_unit_ids ?? null,
    returnedFactIds: row.returned_fact_ids ?? null,
    acceptedIds: row.accepted_ids ?? null,
    volunteeredSourceIds: row.volunteered_source_ids ?? null,
    routeIds: row.route_ids ?? null,
    requiredSourceIds: row.required_source_ids ?? null,
    requiredAcceptanceIds: row.required_acceptance_ids ?? null,
    usedIds: row.used_ids ?? null,
    metadata: row.metadata ?? null,
  }));
  const latestCreatedAt = sampleRows.reduce((max, row) => Math.max(max, Number(row.createdAt ?? 0)), 0);
  return JSON.stringify(stableClone({
    route: context.route ?? null,
    limit: Number(context.limit ?? rows.length),
    compareVectors: Boolean(context.compareVectors),
    sampleCount: sampleRows.length,
    latestCreatedAt: latestCreatedAt || null,
    samples: sampleRows,
  }));
}

export async function handleEvalRoutes({
  method,
  path,
  req,
  res,
  db,
  readBody,
  send,
  parseJson,
  canonicalSourceId,
  normalizeSourceIds,
  collectRetrievalIds,
  resolveVolunteeredContext,
  latestPackageExpansionMetadata,
  phaseAttribution,
  markTaskContextUsed,
  markMemoriesUsed,
  markFactsUsed,
  maybeRecordSourcePrecisionThresholds,
  recordFeedbackMissing,
  validateSourceIds,
  sourcePrecisionStats,
  runEvalFixtureReplay,
  compareVectorReplay,
} = {}) {
  if (method === 'POST' && path === '/eval/capture') {
    const b = await readBody(req);
    const queryText = b.query_text ?? b.queryText ?? b.q ?? b.text ?? '';
    const route = b.route ?? b.mode;
    if (!queryText || !route) {
      send(res, 400, { error: 'query_text and route required' });
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
    const ids = collectRetrievalIds(b.response ?? b.results ?? {});
    const returnedEntityIds = b.returned_entity_ids ?? b.returnedEntityIds ?? ids.entityIds;
    const returnedTextUnitIds = b.returned_text_unit_ids ?? b.returnedTextUnitIds ?? ids.textUnitIds;
    const returnedFactIds = b.returned_fact_ids ?? b.returnedFactIds ?? ids.factIds;
    const accepted = normalizeSourceIds(b.accepted_ids ?? b.acceptedIds ?? []);
    const taskId = b.task_id ?? b.taskId ?? '';
    const routeIds = normalizeRouteIds(b.route_ids ?? b.routeIds ?? [route], [route]);
    const requiredSourceIds = normalizeStringList(
      b.required_source_ids ?? b.requiredSourceIds ?? accepted.canonical,
    );
    const requiredAcceptanceIds = normalizeStringList(
      b.required_acceptance_ids ?? b.requiredAcceptanceIds ?? accepted.canonical,
    );
    const usedIds = normalizeStringList(
      b.used_ids ?? b.usedIds ?? accepted.canonical,
    );
    const routeAckState = normalizeRouteAckState(
      b.route_ack_state ?? b.routeAckState,
      routeIds,
      route,
    );
    const volunteeredContext = resolveVolunteeredContext(
      taskId,
      b.volunteered_source_ids ?? b.volunteeredSourceIds ?? b.metadata?.volunteered_source_ids ?? b.metadata?.volunteeredSourceIds ?? [],
      b.source_origins ?? b.sourceOrigins ?? b.metadata?.source_origins ?? b.metadata?.sourceOrigins ?? {},
    );
    const volunteered = normalizeSourceIds(volunteeredContext.canonical);
    const hasAcceptedFeedback = Array.isArray(b.accepted_ids) || Array.isArray(b.acceptedIds);
    if (route === 'manager.task_completion' && !hasAcceptedFeedback) {
      const feedbackMissing = recordFeedbackMissing({
        taskId,
        agentId: b.agent_id ?? b.agentId ?? '',
        queryText,
        volunteeredSourceIds: volunteered.canonical,
        source: 'brain-eval',
        metadata: {
          ...parseJsonObject(b.metadata),
          route,
          route_ids: routeIds,
          reason: 'manager_missing_accepted_feedback',
        },
        idempotencyKey: idempotencyKey
          ? deriveIdempotencyKey(idempotencyKey, 'eval-feedback-missing')
          : null,
      });
      send(res, 200, {
        ok: true,
        skipped: true,
        reason: 'manager_missing_accepted_feedback',
        feedback_missing_recorded: Boolean(feedbackMissing),
      });
      return true;
    }
    const skillUsedIds = Array.isArray(b.skill_used_ids) ? b.skill_used_ids : Array.isArray(b.skillUsedIds) ? b.skillUsedIds : [];
    const skillHelpfulness = typeof b.skill_helpfulness === 'number' ? b.skill_helpfulness : typeof b.skillHelpfulness === 'number' ? b.skillHelpfulness : null;
    const contextPackageId = b.context_package_id ?? b.contextPackageId ?? b.metadata?.context_package_id ?? b.metadata?.contextPackageId ?? null;
    const expansionMetadata = latestPackageExpansionMetadata(contextPackageId);
    const phases = phaseAttribution({
      acceptedSourceIds: accepted.canonical,
      volunteeredSourceIds: volunteered.canonical,
      sourceOrigins: volunteeredContext.sourceOrigins,
    });
    const artifactHash = b.artifact_hash ?? b.artifactHash ?? stableEvalArtifactHash({
      query_text: queryText,
      route,
      route_ids: routeIds,
      required_source_ids: requiredSourceIds,
      required_acceptance_ids: requiredAcceptanceIds,
      used_ids: usedIds,
      accepted_ids: accepted.canonical,
      volunteered_source_ids: volunteered.canonical,
      returned_entity_ids: returnedEntityIds,
      returned_text_unit_ids: returnedTextUnitIds,
      returned_fact_ids: returnedFactIds,
      task_id: taskId,
      agent_id: b.agent_id ?? b.agentId ?? '',
    });
    const agentId = b.agent_id ?? b.agentId ?? '';
    const normalizedSkillUsedIds = [...new Set(skillUsedIds.map(String).filter(Boolean))];
    const normalizedContextPackageId = contextPackageId == null ? null : Number(contextPackageId);
    const latencyMs = b.latency_ms ?? b.latencyMs ?? null;
    const storedMetadata = {
      ...(b.metadata ?? {}),
      ...expansionMetadata,
      accepted_ids_raw: accepted.raw,
      volunteered_source_ids_raw: volunteered.raw,
      artifact_hash: artifactHash,
      source_origins: volunteeredContext.sourceOrigins,
      phase_attribution: phases,
      context_package_id: contextPackageId,
    };
    const canonicalCapture = {
      query_text: queryText,
      agent_id: agentId,
      task_id: taskId,
      route,
      returned_entity_ids: returnedEntityIds ?? [],
      returned_text_unit_ids: returnedTextUnitIds ?? [],
      returned_fact_ids: returnedFactIds ?? [],
      accepted_ids: accepted.canonical,
      volunteered_source_ids: volunteered.canonical,
      route_ids: routeIds,
      required_source_ids: requiredSourceIds,
      required_acceptance_ids: requiredAcceptanceIds,
      used_ids: usedIds,
      artifact_hash: artifactHash,
      route_ack_state: routeAckState,
      skill_used_ids: normalizedSkillUsedIds,
      skill_helpfulness: skillHelpfulness,
      context_package_id: normalizedContextPackageId,
      latency_ms: latencyMs,
      metadata: parseJsonObject(b.metadata),
    };
    const idempotencyHash = canonicalContentHash(canonicalCapture);
    let transactionOpen = false;
    let evalId;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      if (idempotencyKey) {
        const existing = db.prepare(`
          SELECT id, idempotency_hash
          FROM eval_queries
          WHERE idempotency_key=?
        `).get(idempotencyKey);
        if (existing) {
          if (existing.idempotency_hash !== idempotencyHash) {
            throw idempotencyConflict('eval capture', idempotencyKey, Number(existing.id));
          }
          db.exec('COMMIT');
          transactionOpen = false;
          send(res, 200, { ok: true, id: Number(existing.id), deduplicated: true });
          return true;
        }
      }

      const r = db.prepare(`
        INSERT INTO eval_queries
          (query_text, agent_id, task_id, route, returned_entity_ids, returned_text_unit_ids, returned_fact_ids, accepted_ids, volunteered_source_ids, route_ids, required_source_ids, required_acceptance_ids, used_ids, artifact_hash, route_ack_state, skill_used_ids, skill_helpfulness, context_package_id, latency_ms, metadata, idempotency_key, idempotency_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        queryText,
        agentId,
        taskId,
        route,
        JSON.stringify(returnedEntityIds ?? []),
        JSON.stringify(returnedTextUnitIds ?? []),
        JSON.stringify(returnedFactIds ?? []),
        JSON.stringify(accepted.canonical),
        JSON.stringify(volunteered.canonical),
        JSON.stringify(routeIds),
        JSON.stringify(requiredSourceIds),
        JSON.stringify(requiredAcceptanceIds),
        JSON.stringify(usedIds),
        artifactHash,
        JSON.stringify(routeAckState),
        JSON.stringify(normalizedSkillUsedIds),
        skillHelpfulness,
        normalizedContextPackageId,
        latencyMs,
        JSON.stringify(storedMetadata),
        idempotencyKey,
        idempotencyKey ? idempotencyHash : null,
      );
      evalId = Number(r.lastInsertRowid);
      markTaskContextUsed(taskId, accepted.canonical);
      markMemoriesUsed({ volunteeredSourceIds: volunteered.canonical, acceptedSourceIds: accepted.canonical });
      if (usedIds.length) {
        try {
          const issues = validateSourceIds(db, usedIds).filter((row) => !row.valid);
          if (issues.length) {
            db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
              .run(
                'brain-eval',
                'citation:quality-check',
                taskId || agentId || route,
                JSON.stringify({ used_ids: usedIds, invalid: issues, route, agent_id: agentId, task_id: taskId }),
                JSON.stringify(['brain', 'citation', 'quality']),
              );
          }
        } catch {}
      }
      markFactsUsed({ volunteeredSourceIds: volunteered.canonical, acceptedSourceIds: accepted.canonical });
      maybeRecordSourcePrecisionThresholds(volunteered.canonical);
      db.exec('COMMIT');
      transactionOpen = false;
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
    send(res, 200, { ok: true, id: evalId, deduplicated: false });
    return true;
  }

  if (method === 'POST' && path === '/eval/replay') {
    const b = await readBody(req);
    const limit = Math.min(Number(b.limit ?? 25), 200);
    const route = b.route ?? null;
    const fixtureReplay = b.fixture_mode || b.fixtureMode || b.fixtures
      ? runEvalFixtureReplay({ route, limit, includeRetired: !!(b.include_retired ?? b.includeRetired) })
      : null;
    const rows = route
      ? db.prepare(`SELECT * FROM eval_queries WHERE route=? ORDER BY created_at DESC LIMIT ?`).all(route, limit)
      : db.prepare(`SELECT * FROM eval_queries ORDER BY created_at DESC LIMIT ?`).all(limit);
    const compareVectors = Boolean(b.compare_vectors || b.compareVectors);
    const currentStamp = evalReplaySnapshotStamp(rows, { route, limit, compareVectors });
    const expectedStamp = b.expectedReplayStamp ?? b.expectedStamp;
    if (expectedStamp && expectedStamp !== currentStamp) {
      send(res, 409, {
        ok: false,
        error: {
          type: 'brain.conflict',
          message: 'eval replay sample set changed since review',
          hint: 'refresh Brain Learning and review the current replay sample count before running eval replay',
        },
        risk: { level: 'medium', action: 'refresh' },
      });
      return true;
    }
    const samples = rows.map((r) => ({
      ...r,
      returned_entity_ids: parseJson(r.returned_entity_ids, []),
      returned_text_unit_ids: parseJson(r.returned_text_unit_ids, []),
      returned_fact_ids: parseJson(r.returned_fact_ids, []),
      accepted_ids: parseJson(r.accepted_ids, []),
      volunteered_source_ids: parseJson(r.volunteered_source_ids, []),
      route_ids: parseJson(r.route_ids, [r.route]),
      required_source_ids: parseJson(r.required_source_ids, []),
      required_acceptance_ids: parseJson(r.required_acceptance_ids, []),
      used_ids: parseJson(r.used_ids, []),
      artifact_hash: r.artifact_hash,
      route_ack_state: parseJson(r.route_ack_state, {}),
      skill_used_ids: parseJson(r.skill_used_ids, []),
      metadata: parseJson(r.metadata, {}),
    }));
    const orderedReturned = (s) => [
      ...s.returned_entity_ids.map((id) => canonicalSourceId('entity', id)),
      ...s.returned_text_unit_ids.map((id) => canonicalSourceId('text', id)),
      ...s.returned_fact_ids.map((id) => canonicalSourceId('fact', id)),
    ].filter(Boolean).map(String);
    const evaluatePlan26Gates = (sample) => {
      const returned = new Set([
        ...sample.returned_entity_ids.map((id) => canonicalSourceId('entity', id)),
        ...sample.returned_text_unit_ids.map((id) => canonicalSourceId('text', id)),
        ...sample.returned_fact_ids.map((id) => canonicalSourceId('fact', id)),
      ]);
      const routeIds = normalizeRouteIds(sample.route_ids, [sample.route]);
      const routeAckState = normalizeRouteAckState(sample.route_ack_state, routeIds, sample.route);
      const volunteeredIds = normalizeStringList(sample.volunteered_source_ids);
      const usedIds = normalizeStringList(sample.used_ids);
      const requiredSourceIds = normalizeStringList(sample.required_source_ids);
      const requiredAcceptanceIds = normalizeStringList(sample.required_acceptance_ids);
      const sourceOrigins = normalizeSourceOrigins(
        sample.metadata?.source_origins
          ?? sample.metadata?.sourceOrigins
          ?? {},
        [...volunteeredIds, ...requiredSourceIds, ...requiredAcceptanceIds, ...usedIds],
      );
      const artifactHash = String(sample.artifact_hash ?? '').trim();
      const computedHash = stableEvalArtifactHash({
        query_text: sample.query_text,
        route: sample.route,
        route_ids: routeIds,
        required_source_ids: requiredSourceIds,
        required_acceptance_ids: requiredAcceptanceIds,
        used_ids: usedIds,
        accepted_ids: sample.accepted_ids,
        volunteered_source_ids: sample.volunteered_source_ids,
        returned_entity_ids: sample.returned_entity_ids,
        returned_text_unit_ids: sample.returned_text_unit_ids,
        returned_fact_ids: sample.returned_fact_ids,
        task_id: sample.task_id,
        agent_id: sample.agent_id,
      });
      const covered = requiredSourceIds.every((id) => returned.has(id));
      const routeAckOk = routeIds.length
        && routeIds.every((routeId) => typeof routeAckState?.[routeId] === 'string' && String(routeAckState[routeId]).trim());
      const volunteerContextOk = !volunteeredIds.length
        || volunteeredIds.every((sourceId) => {
          const origins = normalizeStringList(sourceOrigins?.[sourceId] ?? []);
          return origins.length > 0;
        });
      return {
        envelopeEmitOk: Boolean(sample.query_text && sample.route)
          && Boolean(routeIds.length && requiredSourceIds.length && requiredAcceptanceIds.length && usedIds.length),
        evalReplayReproducible: Boolean(artifactHash) && artifactHash === computedHash,
        volunteerContextSourced: volunteerContextOk,
        sourceCoverageComplete: requiredSourceIds.length === 0 ? false : covered,
        routeAcksOk: routeAckOk,
        failures: {
          missingQueryText: !sample.query_text,
          missingRoute: !sample.route,
          missingRequiredSourceIds: !requiredSourceIds.length,
          missingRequiredAcceptanceIds: !requiredAcceptanceIds.length,
          missingUsedIds: !usedIds.length,
          missingRouteIds: !routeIds.length,
          missingArtifactHash: !artifactHash,
          artifactHashMismatch: Boolean(artifactHash) && artifactHash !== computedHash,
          incompleteRouteAck: !routeAckOk,
          missingSourceOriginsForVolunteer: volunteerContextOk === false,
          sourceCoverageGap: !covered,
        },
      };
    };
    const metricAtK = (returnedIds, acceptedIds, k) => {
      const returned = returnedIds.slice(0, k).map(String);
      const returnedAll = returnedIds.map(String);
      const accepted = [...new Set(normalizeSourceIds(acceptedIds).canonical.map(String))];
      if (!accepted.length) return null;
      const acceptedSet = new Set(accepted);
      const hits = returned.filter((id) => acceptedSet.has(id)).length;
      const coverageHits = returnedAll.filter((id) => acceptedSet.has(id)).length;
      const firstRelevant = returnedAll.findIndex((id) => acceptedSet.has(id));
      const dcg = returned.reduce((sum, id, idx) => sum + (acceptedSet.has(id) ? 1 / Math.log2(idx + 2) : 0), 0);
      const idealHits = Math.min(accepted.length, k);
      const idcg = Array.from({ length: idealHits }).reduce((sum, _v, idx) => sum + 1 / Math.log2(idx + 2), 0);
      const jaccardDenominator = new Set([...returned, ...accepted]).size;
      return {
        topKOverlap: hits,
        secondaryOverlap: hits,
        jaccardAtK: jaccardDenominator ? Math.round((hits / jaccardDenominator) * 1000) / 1000 : null,
        returnedAtK: returned.length,
        acceptedCount: accepted.length,
        precisionAtK: Math.round((hits / k) * 1000) / 1000,
        recallAtK: Math.round((hits / accepted.length) * 1000) / 1000,
        sourceCoverage: Math.round((coverageHits / accepted.length) * 1000) / 1000,
        mrr: firstRelevant >= 0 ? Math.round((1 / (firstRelevant + 1)) * 1000) / 1000 : 0,
        ndcg: idcg ? Math.round((dcg / idcg) * 1000) / 1000 : null,
        ndcgAtK: idcg ? Math.round((dcg / idcg) * 1000) / 1000 : null,
      };
    };
    const averageMetrics = (items) => {
      const valid = items.filter(Boolean);
      if (!valid.length) return { samples: 0, topKOverlap: null, secondaryOverlap: null, jaccardAtK: null, returnedAtK: null, acceptedCount: null, precisionAtK: null, recallAtK: null, sourceCoverage: null, mrr: null, ndcg: null, ndcgAtK: null };
      const avg = (key) => Math.round((valid.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / valid.length) * 1000) / 1000;
      return {
        samples: valid.length,
        topKOverlap: avg('topKOverlap'),
        secondaryOverlap: avg('secondaryOverlap'),
        jaccardAtK: avg('jaccardAtK'),
        returnedAtK: avg('returnedAtK'),
        acceptedCount: avg('acceptedCount'),
        precisionAtK: avg('precisionAtK'),
        recallAtK: avg('recallAtK'),
        sourceCoverage: avg('sourceCoverage'),
        mrr: avg('mrr'),
        ndcg: avg('ndcg'),
        ndcgAtK: avg('ndcgAtK'),
      };
    };
    const rankingK = Math.min(Math.max(Number(b.k ?? b.at_k ?? b.atK ?? 5) || 5, 1), 50);
    const byRoute = {};
    const byAgent = {};
    const byOrigin = Object.fromEntries(CANONICAL_SOURCE_ORIGINS.map(origin => [origin, { volunteered: 0, used: 0, samples: 0 }]));
    const byPhase = {};
    const makeBucket = () => ({
      count: 0,
      acceptedSamples: 0,
      acceptedReturned: 0,
      totalAccepted: 0,
      volunteeredSamples: 0,
      volunteeredUsed: 0,
      totalVolunteered: 0,
      totalLatencyMs: 0,
      latencySamples: 0,
      latencyValues: [],
      sourceCoverageSamples: 0,
    });
    const makeOriginBucket = () => ({ volunteered: 0, used: 0, samples: 0 });
    const makeStrategyBucket = () => ({ samples: 0, returned: 0, relevant: 0, acceptedReturned: 0 });
    const percentile = (values = [], p = 50) => {
      const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
      return sorted[index];
    };
    const textUnitStrategy = (sourceId) => {
      const id = String(sourceId ?? '');
      if (!id.startsWith('text:')) return null;
      const textId = Number(id.slice('text:'.length));
      if (!Number.isInteger(textId)) return null;
      const row = db.prepare(`SELECT parent_text_unit_id, process_config, metadata, source_kind FROM text_units WHERE id=?`).get(textId);
      if (!row) return null;
      const processConfig = parseJson(row.process_config, {});
      const metadata = parseJson(row.metadata, {});
      const role = metadata.role ?? (row.parent_text_unit_id ? 'child' : 'parent');
      return {
        strategy: processConfig.strategy ?? 'unknown',
        parser: processConfig.parser ?? '',
        prompt_version: processConfig.prompt_version ?? '',
        role,
        source_kind: row.source_kind,
      };
    };
    const byChunkStrategy = {};
    const byParentChildStrategy = {};
    const recordStrategyMetrics = (sample) => {
      const returnedOrdered = orderedReturned(sample);
      const returnedSet = new Set(returnedOrdered);
      const acceptedSet = new Set(normalizeSourceIds(sample.accepted_ids).canonical.map(String));
      const textSources = [...new Set([...returnedOrdered, ...acceptedSet].filter(id => String(id).startsWith('text:')))];
      const touched = new Set();
      for (const sourceId of textSources) {
        const info = textUnitStrategy(sourceId);
        if (!info) continue;
        for (const [bucketMap, key] of [
          [byChunkStrategy, info.strategy],
          [byParentChildStrategy, `${info.role}:${info.strategy}`],
        ]) {
          const bucket = bucketMap[key] ??= makeStrategyBucket();
          const sampleKey = `${key}:${sample.id}`;
          if (!touched.has(sampleKey)) {
            bucket.samples++;
            touched.add(sampleKey);
          }
          if (returnedSet.has(sourceId)) bucket.returned++;
          if (acceptedSet.has(sourceId)) bucket.relevant++;
          if (returnedSet.has(sourceId) && acceptedSet.has(sourceId)) bucket.acceptedReturned++;
        }
      }
    };
    for (const sample of samples) {
      const buckets = [
        byRoute[sample.route] ??= makeBucket(),
        byAgent[sample.agent_id || 'unknown'] ??= makeBucket(),
      ];
      for (const bucket of buckets) bucket.count++;
      const returned = new Set([
        ...sample.returned_entity_ids.map((id) => canonicalSourceId('entity', id)),
        ...sample.returned_text_unit_ids.map((id) => canonicalSourceId('text', id)),
        ...sample.returned_fact_ids.map((id) => canonicalSourceId('fact', id)),
      ].filter(Boolean).map(String));
      const accepted = normalizeSourceIds(sample.accepted_ids).canonical;
      const acceptedSet = new Set(accepted);
      const volunteered = normalizeSourceIds(sample.volunteered_source_ids).canonical;
      const sourceOrigins = normalizeSourceOrigins(
        sample.metadata?.source_origins && typeof sample.metadata.source_origins === 'object'
          ? sample.metadata.source_origins
          : sample.metadata?.sourceOrigins && typeof sample.metadata.sourceOrigins === 'object'
            ? sample.metadata.sourceOrigins
            : {},
        [...accepted, ...volunteered],
      );
      const phaseRows = Array.isArray(sample.metadata?.phase_attribution) ? sample.metadata.phase_attribution : [];
      for (const bucket of buckets) {
        if (accepted.length) {
          bucket.acceptedSamples++;
          bucket.totalAccepted += accepted.length;
          bucket.acceptedReturned += accepted.filter((id) => returned.has(id)).length;
        }
        if (volunteered.length) {
          bucket.volunteeredSamples++;
          bucket.totalVolunteered += volunteered.length;
          bucket.volunteeredUsed += volunteered.filter((id) => acceptedSet.has(id)).length;
        }
        if (typeof sample.latency_ms === 'number') {
          bucket.totalLatencyMs += sample.latency_ms;
          bucket.latencySamples++;
          bucket.latencyValues.push(sample.latency_ms);
        }
        if (sample.returned_text_unit_ids.length || sample.returned_fact_ids.length) bucket.sourceCoverageSamples++;
      }
      recordStrategyMetrics(sample);
      for (const id of volunteered) {
        const origins = Array.isArray(sourceOrigins[id]) && sourceOrigins[id].length ? sourceOrigins[id] : ['unknown'];
        for (const origin of origins) {
          const bucket = byOrigin[origin] ??= makeOriginBucket();
          bucket.volunteered++;
          if (acceptedSet.has(id)) bucket.used++;
          bucket.samples++;
        }
      }
      for (const phaseRow of phaseRows) {
        const bucket = byPhase[phaseRow.phase ?? 'unknown'] ??= makeOriginBucket();
        bucket.volunteered += Number(phaseRow.volunteered ?? 0);
        bucket.used += Number(phaseRow.accepted ?? phaseRow.used ?? 0);
        bucket.samples++;
      }
    }
    const rankingMetrics = {};
    const samplesByRoute = {};
    for (const sample of samples) (samplesByRoute[sample.route || 'unknown'] ??= []).push(sample);
    for (const [routeName, routeSamples] of Object.entries(samplesByRoute)) {
      rankingMetrics[routeName] = averageMetrics(routeSamples.map(sample => metricAtK(orderedReturned(sample), sample.accepted_ids, rankingK)));
    }
    const strategyNames = ['fts', 'local', 'global', 'drift', 'questions', 'hybrid'];
    const strategyGroups = new Map();
    for (const sample of samples) {
      const key = sample.query_text;
      if (!strategyGroups.has(key)) strategyGroups.set(key, []);
      strategyGroups.get(key).push(sample);
    }
    const strategyComparison = [];
    for (const [queryText, list] of strategyGroups.entries()) {
      const accepted = [...new Set(list.flatMap(sample => normalizeSourceIds(sample.accepted_ids).canonical))];
      if (!accepted.length) continue;
      const latestByRoute = new Map();
      for (const sample of list.slice().sort((a, b) => Number(b.id) - Number(a.id))) {
        if (!latestByRoute.has(sample.route)) latestByRoute.set(sample.route, sample);
      }
      const routes = {};
      for (const name of strategyNames.filter(name => name !== 'hybrid')) {
        const sample = latestByRoute.get(name);
        const returned = sample ? orderedReturned(sample) : [];
        routes[name] = {
          eval_id: sample?.id ?? null,
          returned,
          ...metricAtK(returned, accepted, rankingK),
        };
      }
      const hybridReturned = [...new Set(['fts', 'local', 'global', 'drift', 'questions'].flatMap(name => routes[name].returned))];
      routes.hybrid = {
        eval_id: latestByRoute.get('hybrid')?.id ?? null,
        returned: latestByRoute.has('hybrid') ? orderedReturned(latestByRoute.get('hybrid')) : hybridReturned,
        ...metricAtK(latestByRoute.has('hybrid') ? orderedReturned(latestByRoute.get('hybrid')) : hybridReturned, accepted, rankingK),
      };
      strategyComparison.push({ query_text: queryText, accepted_ids: accepted, k: rankingK, routes });
    }
    const serialize = (buckets) => Object.fromEntries(Object.entries(buckets).map(([name, s]) => [name, {
      count: s.count,
      acceptanceRecall: s.totalAccepted ? Math.round((s.acceptedReturned / s.totalAccepted) * 1000) / 1000 : null,
      volunteeredPrecision: s.totalVolunteered ? Math.round((s.volunteeredUsed / s.totalVolunteered) * 1000) / 1000 : null,
      volunteeredSampleRate: Math.round((s.volunteeredSamples / s.count) * 1000) / 1000,
      acceptedSampleRate: Math.round((s.acceptedSamples / s.count) * 1000) / 1000,
      operatorAcceptance: Math.round((s.acceptedSamples / s.count) * 1000) / 1000,
      avgLatencyMs: s.latencySamples ? Math.round(s.totalLatencyMs / s.latencySamples) : null,
      latencyMs: {
        avg: s.latencySamples ? Math.round(s.totalLatencyMs / s.latencySamples) : null,
        p50: percentile(s.latencyValues, 50),
        p95: percentile(s.latencyValues, 95),
      },
      sourceCoverage: s.totalAccepted ? Math.round((s.acceptedReturned / s.totalAccepted) * 1000) / 1000 : null,
      returnedSourceSampleRate: Math.round((s.sourceCoverageSamples / s.count) * 1000) / 1000,
    }]));
    const serializeOrigins = (buckets) => Object.fromEntries(Object.entries(buckets).map(([name, s]) => [name, {
      samples: s.samples,
      volunteered: s.volunteered,
      used: s.used,
      precision: s.volunteered ? Math.round((s.used / s.volunteered) * 1000) / 1000 : null,
    }]));
    const serializeStrategies = (buckets) => Object.fromEntries(Object.entries(buckets).map(([name, s]) => [name, {
      samples: s.samples,
      returned: s.returned,
      relevant: s.relevant,
      acceptedReturned: s.acceptedReturned,
      precision: s.returned ? Math.round((s.acceptedReturned / s.returned) * 1000) / 1000 : null,
      recall: s.relevant ? Math.round((s.acceptedReturned / s.relevant) * 1000) / 1000 : null,
    }]));
    // Retrieval-drift gates: for any query (route + query_text) captured 2+ times,
    // compare the newest retrieval against the previous one. Jaccard measures set
    // overlap of returned source ids; top-1 overlap measures whether the primary
    // result held. Drift below threshold (or a changed top-1) is surfaced as a
    // regression warning so retrieval changes are measurable, not silent.
    const driftGroups = new Map();
    for (const sample of samples) {
      const key = `${sample.route}::${sample.query_text}`;
      if (!driftGroups.has(key)) driftGroups.set(key, []);
      driftGroups.get(key).push(sample);
    }
    const jaccardWarnThreshold = Number(process.env.BRAIN_EVAL_JACCARD_WARN ?? 0.5);
    const driftChanges = [];
    let jaccardSum = 0;
    let top1Sum = 0;
    let comparisons = 0;
    for (const list of driftGroups.values()) {
      if (list.length < 2) continue;
      const ordered = list.slice().sort((a, b) => Number(b.id) - Number(a.id));
      const cur = orderedReturned(ordered[0]);
      const prev = orderedReturned(ordered[1]);
      const curSet = new Set(cur);
      const prevSet = new Set(prev);
      const intersection = [...curSet].filter((id) => prevSet.has(id)).length;
      const union = new Set([...cur, ...prev]).size;
      const jaccard = union ? Math.round((intersection / union) * 1000) / 1000 : 1;
      const curTop1 = cur[0] ?? null;
      const prevTop1 = prev[0] ?? null;
      const top1Changed = curTop1 !== prevTop1;
      const top1Overlap = top1Changed ? 0 : 1;
      jaccardSum += jaccard;
      top1Sum += top1Overlap;
      comparisons++;
      driftChanges.push({
        route: ordered[0].route,
        query_text: ordered[0].query_text,
        jaccard,
        top1_overlap: top1Overlap,
        top1_changed: top1Changed,
        current_top1: curTop1,
        previous_top1: prevTop1,
        added: cur.filter((id) => !prevSet.has(id)),
        removed: prev.filter((id) => !curSet.has(id)),
        current_eval_id: Number(ordered[0].id),
        previous_eval_id: Number(ordered[1].id),
      });
    }
    driftChanges.sort((a, b) => a.jaccard - b.jaccard || Number(b.top1_changed) - Number(a.top1_changed));
    const retrievalDrift = {
      comparisons,
      meanJaccard: comparisons ? Math.round((jaccardSum / comparisons) * 1000) / 1000 : null,
      meanTop1Overlap: comparisons ? Math.round((top1Sum / comparisons) * 1000) / 1000 : null,
      jaccardWarnThreshold,
      changes: driftChanges.slice(0, 50),
    };
    const regressionWarnings = driftChanges
      .filter((c) => c.jaccard < jaccardWarnThreshold || c.top1_changed)
      .slice(0, 50)
      .map((c) => ({
        kind: 'retrieval_drift',
        route: c.route,
        query_text: c.query_text,
        jaccard: c.jaccard,
        top1_overlap: c.top1_overlap,
        top1_changed: c.top1_changed,
        reason: c.top1_changed
          ? `top-1 result changed (${c.previous_top1} → ${c.current_top1})`
          : `jaccard ${c.jaccard} < ${jaccardWarnThreshold}`,
        current_eval_id: c.current_eval_id,
        previous_eval_id: c.previous_eval_id,
      }));
    const plan26Samples = samples.map((sample) => evaluatePlan26Gates(sample));
    const plan26Failures = [];
    const gateByName = {
      envelope_emit_ok: true,
      eval_replay_reproducible: true,
      volunteer_context_sourced: true,
      source_coverage_complete: true,
      route_acks_ok: true,
    };
    for (const sample of plan26Samples) {
      gateByName.envelope_emit_ok &&= sample.envelopeEmitOk;
      gateByName.eval_replay_reproducible &&= sample.evalReplayReproducible;
      gateByName.volunteer_context_sourced &&= sample.volunteerContextSourced;
      gateByName.source_coverage_complete &&= sample.sourceCoverageComplete;
      gateByName.route_acks_ok &&= sample.routeAcksOk;
      if (!sample.envelopeEmitOk) plan26Failures.push({ sample_id: sample.id ?? sample.eval_id, kind: 'envelope_emit', reasons: sample.failures });
      if (!sample.evalReplayReproducible) plan26Failures.push({ sample_id: sample.id ?? sample.eval_id, kind: 'replay_hash', reasons: sample.failures });
      if (!sample.volunteerContextSourced) plan26Failures.push({ sample_id: sample.id ?? sample.eval_id, kind: 'volunteer_context', reasons: sample.failures });
      if (!sample.sourceCoverageComplete) plan26Failures.push({ sample_id: sample.id ?? sample.eval_id, kind: 'source_coverage', reasons: sample.failures });
      if (!sample.routeAcksOk) plan26Failures.push({ sample_id: sample.id ?? sample.eval_id, kind: 'route_acks', reasons: sample.failures });
    }
    const plan26Passed = samples.length > 0
      && gateByName.envelope_emit_ok
      && gateByName.eval_replay_reproducible
      && gateByName.volunteer_context_sourced
      && gateByName.source_coverage_complete
      && gateByName.route_acks_ok;
    const precision = sourcePrecisionStats({ days: 90 });
    const vectorComparison = compareVectors
      ? compareVectorReplay(samples, {
          mode: b.vector_comparison_mode ?? b.vectorComparisonMode ?? b.comparisonMode ?? b.comparison_mode ?? b.mode ?? 'union',
          limit: Number(b.vector_limit ?? b.vectorLimit ?? 5),
          maxAgeDays: Number(b.vector_max_age_days ?? b.vectorMaxAgeDays ?? 30),
        })
      : null;
    if (vectorComparison) persistVectorReplayGateVerdict(db, vectorComparison);
    send(res, 200, {
      ok: true,
      summary: serialize(byRoute),
      byAgent: serialize(byAgent),
      byOrigin: serializeOrigins(byOrigin),
      byPhase: serializeOrigins(byPhase),
      byChunkStrategy: serializeStrategies(byChunkStrategy),
      byParentChildStrategy: serializeStrategies(byParentChildStrategy),
      bySource: Object.fromEntries([...precision.bySource.entries()].slice(0, 200)),
      byEntity: Object.fromEntries([...precision.byEntity.entries()].slice(0, 200)),
      rankingMetrics: { k: rankingK, byRoute: rankingMetrics },
      secondaryOverlap: {
        kind: 'ranked-source-overlap',
        note: 'Overlap/Jaccard are secondary diagnostics; precision, recall, MRR, NDCG, source coverage, latency, and operator acceptance are primary.',
        byRoute: Object.fromEntries(Object.entries(rankingMetrics).map(([name, metrics]) => [name, {
          topKOverlap: metrics.topKOverlap,
          jaccardAtK: metrics.jaccardAtK,
        }])),
      },
      strategyComparison,
      retrievalDrift,
      regressionWarnings,
      plan26_gates: {
        sample_count: samples.length,
        envelope_emit_ok: gateByName.envelope_emit_ok,
        eval_replay_reproducible: gateByName.eval_replay_reproducible,
        volunteer_context_sourced: gateByName.volunteer_context_sourced,
        source_coverage_complete: gateByName.source_coverage_complete,
        route_acks_ok: gateByName.route_acks_ok,
        passed: plan26Passed,
        failures: plan26Failures,
      },
      fixtureReplay,
      replayStamp: currentStamp,
      vectorComparison,
      samples,
    });
    return true;
  }

  if (method === 'POST' && path === '/eval/fixtures/promote') {
    const b = await readBody(req);
    const limit = Math.min(Number(b.limit ?? 25), 200);
    const route = b.route ?? null;
    const evalId = b.eval_id ?? b.evalId ?? null;
    const rows = evalId
      ? db.prepare(`SELECT * FROM eval_queries WHERE id=?`).all(Number(evalId))
      : route
        ? db.prepare(`SELECT * FROM eval_queries WHERE route=? ORDER BY created_at DESC LIMIT ?`).all(route, limit)
        : db.prepare(`SELECT * FROM eval_queries ORDER BY created_at DESC LIMIT ?`).all(limit);
    const requiredStrings = Array.isArray(b.required_strings) ? b.required_strings : Array.isArray(b.requiredStrings) ? b.requiredStrings : [];
    const promoted = [];
    for (const row of rows) {
      const accepted = normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical;
      const volunteered = normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical;
      const required = normalizeSourceIds(b.required_source_ids ?? b.requiredSourceIds ?? (accepted.length ? accepted : volunteered)).canonical;
      if (!row.query_text || (!required.length && !requiredStrings.length)) continue;
      const r = db.prepare(`
        INSERT INTO eval_fixtures
          (eval_query_id, query_text, route, agent_id, task_id, required_source_ids, required_strings, metadata, promoted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.query_text,
        row.route,
        row.agent_id,
        row.task_id,
        JSON.stringify(required),
        JSON.stringify(requiredStrings.map(String).filter(Boolean)),
        JSON.stringify({ source: 'eval_promotion', eval_metadata: parseJson(row.metadata, {}) }),
        b.promoted_by ?? b.promotedBy ?? 'brain',
      );
      promoted.push(Number(r.lastInsertRowid));
    }
    if (promoted.length) {
      db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
        .run('brain-eval', 'eval:fixtures-promoted', route ?? String(evalId ?? ''), JSON.stringify({ promoted_fixture_ids: promoted, count: promoted.length }), JSON.stringify(['brain', 'eval', 'fixture']));
    }
    send(res, 200, { ok: true, promoted: promoted.length, fixtureIds: promoted });
    return true;
  }

  return false;
}
