export function contextPhase(name, details = {}) {
  return {
    name,
    ...details,
    recorded_at: Math.floor(Date.now() / 1000),
  };
}

export function phaseNameForOrigin(origin) {
  if (origin === 'trajectory_memory') return 'trajectory_memory_retrieval';
  if (origin === 'shared_memory') return 'lexical_entity_memory_retrieval';
  if (origin === 'repo_affinity') return 'repo_affinity_hints';
  if (origin === 'related_entity') return 'lexical_entity_memory_retrieval';
  if (origin === 'historical_precision') return 'historical_precision_expansion';
  if (origin === 'lexical') return 'lexical_entity_memory_retrieval';
  if (origin === 'pinned_task_context') return 'pinned_task_context_retrieval';
  return origin || 'unknown';
}

export function phaseAttribution({
  normalizeSourceIds,
  acceptedSourceIds = [],
  volunteeredSourceIds = [],
  sourceOrigins = {},
} = {}) {
  if (typeof normalizeSourceIds !== 'function') throw new Error('normalizeSourceIds dependency required');
  const accepted = new Set(normalizeSourceIds(acceptedSourceIds).canonical);
  const volunteered = normalizeSourceIds(volunteeredSourceIds).canonical;
  const byPhase = {};
  for (const sourceId of volunteered) {
    const origins = Array.isArray(sourceOrigins[sourceId]) && sourceOrigins[sourceId].length
      ? sourceOrigins[sourceId]
      : ['unknown'];
    for (const origin of origins) {
      const phase = phaseNameForOrigin(origin);
      byPhase[phase] ??= { phase, origins: [], volunteered: 0, accepted: 0, ignored: 0, accepted_source_ids: [], ignored_source_ids: [] };
      if (!byPhase[phase].origins.includes(origin)) byPhase[phase].origins.push(origin);
      byPhase[phase].volunteered++;
      if (accepted.has(sourceId)) {
        byPhase[phase].accepted++;
        byPhase[phase].accepted_source_ids.push(sourceId);
      } else {
        byPhase[phase].ignored++;
        byPhase[phase].ignored_source_ids.push(sourceId);
      }
    }
  }
  return Object.values(byPhase).map(row => ({
    ...row,
    precision: row.volunteered ? Math.round((row.accepted / row.volunteered) * 1000) / 1000 : null,
    accepted_source_ids: [...new Set(row.accepted_source_ids)],
    ignored_source_ids: [...new Set(row.ignored_source_ids)],
  })).sort((a, b) => b.volunteered - a.volunteered || a.phase.localeCompare(b.phase));
}

export function buildVolunteerContext({
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
} = {}, b = {}) {
  const text = b.text ?? b.q ?? '';
  const limit = Math.min(Number(b.limit ?? 3), 3);
  const candidates = extractContextCandidates(text, Math.max(limit * 3, 8));
  const precision = sourcePrecisionStats({ days: Number(b.precision_days ?? b.precisionDays ?? 90) || 90 });
  const repoHints = repoHintsForContext(text);
  const phases = [
    contextPhase('query_decomposition', { candidates }),
    contextPhase('historical_precision_loaded', { source_count: precision.bySource.size, entity_count: precision.byEntity.size }),
    contextPhase('repo_affinity_hints', { hints: repoHints }),
  ];
  const bundles = [];
  const seenEntities = new Set();
  for (const [idx, candidate] of candidates.entries()) {
    const local = buildLocalContext({ q: candidate, limit: 3 });
    const trajectoryMemories = findTrajectoryMemoryContext(candidate, 2);
    const memories = [
      ...trajectoryMemories,
      ...findSharedMemoryContext(candidate, 3).filter(memory => !trajectoryMemories.some(item => item.id === memory.id)),
    ].slice(0, 5);
    const novel = local.entities.filter(e => !seenEntities.has(e.id));
    if (!novel.length && !memories.length) continue;
    for (const e of novel) seenEntities.add(e.id);
    const bundle = {
      query: candidate,
      entityIds: local.entities.map(e => e.id),
      factIds: local.facts.map(f => f.id),
      textUnitIds: local.textUnits.map(u => u.id),
      memoryIds: memories.map(mem => mem.id),
      entities: local.entities.slice(0, 3),
      facts: local.facts.slice(0, 5),
      textUnits: local.textUnits.slice(0, 3),
      memories,
    };
    const sourceOrigins = sourceOriginsForBundle(bundle, 'lexical');
    bundles.push(attachVolunteerMetadata(bundle, precision, idx, sourceOrigins, { repoHints }));
  }
  phases.push(contextPhase('lexical_entity_memory_retrieval', {
    candidate_count: candidates.length,
    bundle_count: bundles.length,
    source_count: [...new Set(bundles.flatMap(bundleCanonicalSourceIds))].length,
  }));
  phases.push(contextPhase('trajectory_memory_retrieval', {
    memory_count: [...new Set(bundles.flatMap(bundle => (bundle.memories ?? [])
      .filter(memory => memory.agent_id === 'task-trajectories')
      .map(memory => memory.id)))].length,
  }));
  if (!bundles.length) {
    const local = buildLocalContext({ q: text, limit: 3 });
    const trajectoryMemories = findTrajectoryMemoryContext(text, 2);
    const memories = [
      ...trajectoryMemories,
      ...findSharedMemoryContext(text, 3).filter(memory => !trajectoryMemories.some(item => item.id === memory.id)),
    ].slice(0, 5);
    if (local.entities.length || local.facts.length || local.textUnits.length || memories.length) {
      const bundle = {
        query: text,
        entityIds: local.entities.map(e => e.id),
        factIds: local.facts.map(f => f.id),
        textUnitIds: local.textUnits.map(u => u.id),
        memoryIds: memories.map(mem => mem.id),
        entities: local.entities.slice(0, 3),
        facts: local.facts.slice(0, 5),
        textUnits: local.textUnits.slice(0, 3),
        memories,
      };
      const sourceOrigins = sourceOriginsForBundle(bundle, 'lexical');
      bundles.push(attachVolunteerMetadata(bundle, precision, 0, sourceOrigins, { repoHints }));
    }
  }
  phases.push(contextPhase('fallback_retrieval', {
    used: bundles.length > 0 && !phases.find(phase => phase.name === 'lexical_entity_memory_retrieval')?.bundle_count,
    bundle_count: bundles.length,
  }));
  const expansionStart = bundles.length;
  for (const bundle of highPrecisionExpansion({
    precision,
    usedSourceIds: bundles.flatMap(bundleCanonicalSourceIds),
    limit: Number(process.env.BRAIN_CONTEXT_PRECISION_EXPAND_LIMIT ?? 1),
  })) {
    const sourceOrigins = sourceOriginsForBundle(bundle, 'historical_precision');
    bundles.push(attachVolunteerMetadata(bundle, precision, bundles.length, sourceOrigins, { repoHints }));
  }
  phases.push(contextPhase('historical_precision_expansion', {
    added_bundles: Math.max(0, bundles.length - expansionStart),
  }));
  bundles.sort((a, b) => b.score - a.score);
  bundles.splice(limit);
  const budgeted = applyContextBudget(bundles, b);
  bundles.splice(0, bundles.length, ...budgeted.bundles);
  phases.push(contextPhase('ranking_and_budget', {
    bundle_count: bundles.length,
    selected_sources: budgeted.budget.selectedSources,
    omitted: budgeted.budget.omitted,
    retrievable: budgeted.budget.retrievable,
  }));
  const source_origins = mergeSourceOrigins(...bundles.map(bundle => bundle.sourceOrigins));
  const cited = {
    entity_ids: [...new Set(bundles.flatMap(bundle => bundle.entityIds))],
    fact_ids: [...new Set(bundles.flatMap(bundle => bundle.factIds))],
    text_unit_ids: [...new Set(bundles.flatMap(bundle => bundle.textUnitIds))],
    memory_ids: [...new Set(bundles.flatMap(bundle => bundle.memoryIds ?? []))],
  };
  const canonical_source_ids = [...new Set([
    ...cited.entity_ids.map(id => canonicalSourceId('entity', id)),
    ...cited.fact_ids.map(id => canonicalSourceId('fact', id)),
    ...cited.text_unit_ids.map(id => canonicalSourceId('text', id)),
    ...cited.memory_ids.map(id => `memory:${id}`),
  ].filter(Boolean))];
  const originalSourceIds = budgeted.budget.decisions.map(d => d.canonical_source_id).filter(Boolean);
  const omittedSourceIds = budgeted.budget.decisions.filter(d => d.outcome === 'omitted').map(d => d.canonical_source_id);
  const retrievableSourceIds = budgeted.budget.decisions.filter(d => d.outcome === 'retrievable').map(d => d.canonical_source_id);
  const taskId = b.task_id ?? b.taskId ?? '';
  const agentId = b.agent_id ?? b.agentId ?? '';
  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run('brain-context', 'context:volunteered', taskId || agentId || '', JSON.stringify({
      task_id: taskId,
      agent_id: agentId,
      text: String(text).slice(0, 1000),
      candidates,
      repo_hints: repoHints,
      ...cited,
      canonical_source_ids,
      source_origins,
      phases,
      budget: budgeted.budget,
    }), JSON.stringify(['brain', 'context']));
  const contextPackageId = createContextPackage({
    taskId,
    agentId,
    queryText: text,
    summary: `Volunteered ${canonical_source_ids.length} sources for ${taskId || agentId || 'context request'}.`,
    sourceIds: originalSourceIds,
    includedSourceIds: canonical_source_ids,
    omittedSourceIds,
    retrievableSourceIds,
    sourceOrigins: source_origins,
    budget: budgeted.budget,
    timelineEventId: Number(event.lastInsertRowid),
    ttlSeconds: b.package_ttl_seconds ?? b.packageTtlSeconds ?? null,
  });
  phases.push(contextPhase('package_recorded', { context_package_id: contextPackageId, timeline_event_id: Number(event.lastInsertRowid) }));
  db.prepare(`
    INSERT INTO context_volunteers
      (task_id, agent_id, query_text, entity_ids, fact_ids, text_unit_ids, canonical_source_ids, source_origins, timeline_event_id, context_package_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    agentId,
    String(text).slice(0, 4000),
    JSON.stringify(cited.entity_ids),
    JSON.stringify(cited.fact_ids),
    JSON.stringify(cited.text_unit_ids),
    JSON.stringify(canonical_source_ids),
    JSON.stringify(source_origins),
    Number(event.lastInsertRowid),
    contextPackageId,
  );
  markMemoriesVolunteered(canonical_source_ids);
  return {
    bundles,
    cited: { ...cited, canonical_source_ids, source_origins },
    budget: budgeted.budget,
    timelineEventId: Number(event.lastInsertRowid),
    contextPackageId,
    precision: {
      ranked: canonical_source_ids
        .map(id => precision.bySource.get(id))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20),
    },
    phases,
  };
}
