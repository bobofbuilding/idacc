import { promptVersion } from '../prompt-config.mjs';
import { canonicalSourceId } from '../source-ids.mjs';
import { latestVectorReplayGateVerdict } from '../db.mjs';

export async function handleQueryRoutes({
  method,
  path,
  req,
  res,
  db,
  readBody,
  send,
  parseJson,
  buildLocalContext,
  responseWithOptionalEval,
} = {}) {
  const queryInstructions = {
    fts: [
      'Use this as a keyword-only baseline context bundle.',
      'Prefer cited entity, fact, and text unit IDs over uncited prose.',
    ],
    local: [
      'Use this for entity-centered local context expansion.',
      'Ground conclusions in returned facts, text units, and edge evidence.',
    ],
    global: [
      'Use this for corpus-level orientation from cited community reports.',
      'Treat report summaries as derived context and follow their source text unit and fact IDs for audit.',
    ],
    drift: [
      'Use the community primer first, then expand through the local bundle.',
      'Ask the follow-up questions when citations conflict or coverage is thin.',
    ],
    questions: [
      'Use these questions to decide the next retrieval or curation step.',
      'Resolve contradictions before writing durable facts or memories.',
    ],
  };

  const sourceIdsForPayload = (payload = {}) => {
    const local = payload.local ?? payload;
    const ids = [
      ...(local.entities ?? []).map(entity => canonicalSourceId('entity', entity.id)),
      ...(local.facts ?? []).map(fact => canonicalSourceId('fact', fact.id)),
      ...(local.textUnits ?? []).map(unit => canonicalSourceId('text', unit.id)),
      ...(local.vectorSources ?? []).map(source => source.canonical_source_id).filter(Boolean),
      ...(payload.reports ?? []).flatMap(report => [
        `community_report:${report.id}`,
        ...(report.source_text_unit_ids ?? []).map(id => canonicalSourceId('text', id)),
        ...(report.fact_ids ?? []).map(id => canonicalSourceId('fact', id)),
      ]),
    ];
    return [...new Set(ids)];
  };

  const withQueryContract = (mode, payload, q) => ({
    ...payload,
    mode,
    strategy: {
      fts: 'keyword_baseline',
      local: 'entity_local',
      global: 'community_global',
      drift: 'community_primer_plus_local_expansion',
      questions: 'follow_up_question_generation',
    }[mode] ?? mode,
    instructions: queryInstructions[mode] ?? [],
    context_bundle: {
      mode,
      query: q,
      source_ids: sourceIdsForPayload(payload),
      citation_required: true,
      generated_answer: false,
      ...(payload.prompt_version ? { prompt_version: payload.prompt_version } : {}),
    },
  });

  const recordFollowUpQuestionEvent = ({ mode, query, payload }) => {
    const sourceIds = sourceIdsForPayload(payload);
    const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`).run(
      'brain-routes',
      'brain:follow-up-questions',
      String(query ?? ''),
      JSON.stringify({
        mode,
        query,
        prompt_version: promptVersion('followUpQuestions'),
        questions: payload.followUpQuestions ?? payload.questions ?? [],
        source_ids: sourceIds,
      }),
      JSON.stringify(['brain', 'follow-up-questions', promptVersion('followUpQuestions'), mode]),
    );
    payload.timeline_event_id = Number(event.lastInsertRowid);
    return payload.timeline_event_id;
  };

  const vectorEnabled = (body = {}) => Boolean(
    body.include_vectors ?? body.includeVectors ?? body.vector ?? body.vector_retrieval ?? body.vectorRetrieval ??
    process.env.BRAIN_VECTOR_RETRIEVAL === '1'
  ) || Boolean(latestVectorReplayGateVerdict(db)?.rolloutAllowed);

  if (method === 'POST' && path === '/query/fts') {
    const b = await readBody(req);
    const startedAt = Date.now();
    const q = b.q ?? b.query ?? b.text ?? '';
    const payload = buildLocalContext({
      q,
      entityId: b.entity_id ?? b.entityId,
      limit: Math.min(Number(b.limit ?? 5), 20),
      includeVector: false,
      vectorLimit: 0,
    });
    send(res, 200, responseWithOptionalEval(withQueryContract('fts', payload, q), b, 'fts', q, startedAt));
    return true;
  }

  if (method === 'POST' && path === '/query/local') {
    const b = await readBody(req);
    const startedAt = Date.now();
    const q = b.q ?? b.query ?? b.text ?? '';
    const payload = buildLocalContext({
      q,
      entityId: b.entity_id ?? b.entityId,
      limit: Math.min(Number(b.limit ?? 5), 20),
      includeVector: vectorEnabled(b),
      vectorLimit: Math.min(Number(b.vector_limit ?? b.vectorLimit ?? 5), 20),
      vectorMaxAgeDays: Number(b.vector_max_age_days ?? b.vectorMaxAgeDays ?? 30),
    });
    send(res, 200, responseWithOptionalEval(withQueryContract('local', payload, q), b, 'local', q, startedAt));
    return true;
  }

  if (method === 'POST' && path === '/query/global') {
    const b = await readBody(req);
    const startedAt = Date.now();
    const q = b.q ?? b.query ?? b.text ?? '';
    const limit = Math.min(Number(b.limit ?? 5), 20);
    const rows = q
      ? db.prepare(`SELECT * FROM community_reports WHERE title LIKE ? OR summary LIKE ? ORDER BY rank DESC, created_at DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, limit)
      : db.prepare(`SELECT * FROM community_reports ORDER BY rank DESC, created_at DESC LIMIT ?`).all(limit);
    const communities = db.prepare(`SELECT * FROM communities ORDER BY updated_at DESC LIMIT ?`).all(limit)
      .map(r => ({ ...r, entity_ids: parseJson(r.entity_ids, []), metadata: parseJson(r.metadata, {}) }));
    const payload = {
      reports: rows.map(r => ({
        ...r,
        findings: parseJson(r.findings, []),
        source_text_unit_ids: parseJson(r.source_text_unit_ids, []),
        fact_ids: parseJson(r.fact_ids, []),
      })),
      communities,
    };
    send(res, 200, responseWithOptionalEval(withQueryContract('global', payload, q), b, 'global', q, startedAt));
    return true;
  }

  if (method === 'POST' && path === '/query/drift') {
    const b = await readBody(req);
    const startedAt = Date.now();
    const q = b.q ?? b.query ?? b.text ?? '';
    const local = buildLocalContext({
      q,
      entityId: b.entity_id ?? b.entityId,
      limit: Math.min(Number(b.limit ?? 5), 20),
      includeVector: vectorEnabled(b),
      vectorLimit: Math.min(Number(b.vector_limit ?? b.vectorLimit ?? 5), 20),
      vectorMaxAgeDays: Number(b.vector_max_age_days ?? b.vectorMaxAgeDays ?? 30),
    });
    const entityIds = local.entities.map(e => e.id);
    const relatedCommunities = [];
    for (const c of db.prepare(`SELECT * FROM communities ORDER BY updated_at DESC LIMIT 50`).all()) {
      const ids = parseJson(c.entity_ids, []);
      if (ids.some(id => entityIds.includes(id))) relatedCommunities.push({ ...c, entity_ids: ids, metadata: parseJson(c.metadata, {}) });
    }
    // Community ids are string composite keys (e.g. "community:a|b|c"); community_reports.community_id
    // stores the same string. Use the id verbatim — Number(c.id) here was always NaN, so the reports
    // sub-query never matched and `reports` came back empty for every drift query.
    const communityIds = relatedCommunities.slice(0, 5).map(c => c.id).filter(Boolean);
    const reports = communityIds.length
      ? db.prepare(`SELECT * FROM community_reports WHERE community_id IN (${communityIds.map(() => '?').join(',')}) ORDER BY rank DESC, created_at DESC LIMIT ?`)
        .all(...communityIds, Math.min(Number(b.report_limit ?? b.reportLimit ?? 5), 20))
        .map(r => ({
          ...r,
          findings: parseJson(r.findings, []),
          source_text_unit_ids: parseJson(r.source_text_unit_ids, []),
          fact_ids: parseJson(r.fact_ids, []),
        }))
      : [];
    const payload = {
      local,
      communities: relatedCommunities.slice(0, 5),
      reports,
      prompt_version: promptVersion('followUpQuestions'),
      followUpQuestions: [
        'Which cited fact or text unit should be treated as authoritative?',
        'Are any active facts contradictory across sources?',
        'Which related entity should be expanded next?',
      ],
    };
    recordFollowUpQuestionEvent({ mode: 'drift', query: q, payload });
    send(res, 200, responseWithOptionalEval(withQueryContract('drift', payload, q), b, 'drift', q, startedAt));
    return true;
  }

  if (method === 'POST' && path === '/query/questions') {
    const b = await readBody(req);
    const startedAt = Date.now();
    const q = b.q ?? b.query ?? b.text ?? '';
    const local = buildLocalContext({ q, entityId: b.entity_id ?? b.entityId, limit: 5 });
    const contradictions = new Set();
    for (const fact of local.facts) {
      const peers = local.facts.filter(f => f.entity_id === fact.entity_id && f.field === fact.field);
      if (new Set(peers.map(p => JSON.stringify(p.value))).size > 1) contradictions.add(`${fact.entity_id}:${fact.field}`);
    }
    const payload = {
      local,
      prompt_version: promptVersion('followUpQuestions'),
      questions: [
        ...[...contradictions].map(k => `Resolve conflicting active facts for ${k}.`),
        ...local.entities.slice(0, 3).map(e => `What recent source best updates ${e.name}?`),
        'Should this task produce a durable fact, a shared memory, or both?',
      ].slice(0, 8),
    };
    recordFollowUpQuestionEvent({ mode: 'questions', query: q, payload });
    send(res, 200, responseWithOptionalEval(withQueryContract('questions', payload, q), b, 'questions', q, startedAt));
    return true;
  }

  return false;
}
