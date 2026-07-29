function parseJson(value, fallback = {}) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function extractJsonAfterMarker(content = '', marker = '') {
  const text = String(content ?? '');
  const index = text.lastIndexOf(marker);
  if (index < 0) return null;
  const raw = text.slice(index + marker.length).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function round(value) {
  return value == null ? null : Math.round(Number(value) * 1000) / 1000;
}

function insertTimeline(db, { source = 'brain-cycle', type, subject = '', data = {}, tags = [] }) {
  const r = db.prepare(`
    INSERT INTO timeline (source, type, subject, data, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, type, subject, JSON.stringify(data ?? {}), JSON.stringify(tags ?? []));
  return Number(r.lastInsertRowid);
}

function phaseAttributionForSample(metadata = {}, phaseName = '') {
  const phaseRows = Array.isArray(metadata.phase_attribution) ? metadata.phase_attribution : [];
  return phaseRows.find(row => String(row.phase ?? '') === String(phaseName ?? '')) ?? null;
}

function phasePrecisionFromWindow(db, { phase, from, to }) {
  const rows = db.prepare(`
    SELECT metadata
    FROM eval_queries
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
    LIMIT 2000
  `).all(from, to);
  let samples = 0;
  let volunteered = 0;
  let used = 0;
  for (const row of rows) {
    const metadata = parseJson(row.metadata, {});
    const phaseRow = phaseAttributionForSample(metadata, phase);
    if (!phaseRow) continue;
    samples++;
    volunteered += Number(phaseRow.volunteered ?? 0);
    used += Number(phaseRow.accepted ?? phaseRow.used ?? 0);
  }
  return {
    phase,
    from,
    to,
    samples,
    volunteered,
    used,
    precision: volunteered ? round(used / volunteered) : null,
  };
}

export function recordPhaseImprovementOutcomes(db, {
  source = 'brain-cycle',
  now = Math.floor(Date.now() / 1000),
  lookbackDays = Number(process.env.BRAIN_PHASE_IMPROVEMENT_LOOKBACK_DAYS ?? 7),
  forwardDays = Number(process.env.BRAIN_PHASE_IMPROVEMENT_FORWARD_DAYS ?? 7),
  minDelta = Number(process.env.BRAIN_PHASE_IMPROVEMENT_MIN_DELTA ?? 0.05),
} = {}) {
  const completed = db.prepare(`
    SELECT * FROM learning_tasks
    WHERE kind='context.phase.improve' AND status='completed'
    ORDER BY completed_at DESC, updated_at DESC, created_at DESC
    LIMIT 100
  `).all();
  const existing = new Set(db.prepare(`
    SELECT subject FROM timeline
    WHERE type='context.phase.improve:outcome'
  `).all().map(row => String(row.subject ?? '')));
  const outcomes = [];

  for (const row of completed) {
    const taskId = String(row.id);
    if (existing.has(taskId)) continue;

    const payload = parseJson(row.payload, {});
    const phaseName = String(payload.phase?.phase ?? payload.phase ?? row.subject ?? '').trim();
    if (!phaseName) continue;

    const createdAt = Number(row.created_at ?? row.updated_at ?? row.completed_at ?? now);
    const completedAt = Number(row.completed_at ?? row.updated_at ?? now);
    const beforeFrom = Math.max(0, createdAt - Math.max(1, Number(lookbackDays)) * 86400);
    const beforeTo = createdAt;
    const afterFrom = completedAt;
    const afterTo = Math.min(now, completedAt + Math.max(1, Number(forwardDays)) * 86400);
    const before = phasePrecisionFromWindow(db, { phase: phaseName, from: beforeFrom, to: beforeTo });
    const after = phasePrecisionFromWindow(db, { phase: phaseName, from: afterFrom, to: afterTo > afterFrom ? afterTo : now });

    let outcome = 'pending';
    let delta = null;
    if (before.samples > 0 && after.samples > 0 && before.precision != null && after.precision != null) {
      delta = round(after.precision - before.precision);
      if (delta >= minDelta) outcome = 'improved';
      else if (delta <= -minDelta) outcome = 'regressed';
      else outcome = 'neutral';
    } else if (after.samples > 0 && before.samples === 0) {
      outcome = 'insufficient_baseline';
    } else if (before.samples > 0 && after.samples === 0) {
      outcome = 'insufficient_followup';
    }

    const record = {
      task_id: taskId,
      phase: phaseName,
      recommendation: payload.recommendation ?? payload.payload?.recommendation ?? '',
      before,
      after,
      delta,
      outcome,
      created_at: createdAt,
      completed_at: completedAt,
    };

    insertTimeline(db, {
      source,
      type: 'context.phase.improve:outcome',
      subject: taskId,
      data: record,
      tags: ['brain', 'learning', 'phase', outcome],
    });
    outcomes.push(record);
  }

  return outcomes;
}

function parseTrajectoryMemory(content = '') {
  return extractJsonAfterMarker(content, 'Trajectory JSON:');
}

function normalizeList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item).trim()).filter(Boolean))];
}

export function trajectoryReflectionCandidates(db, { limit = 25 } = {}) {
  const rows = db.prepare(`
    SELECT id, agent_id, mem_key, content, tags, created_at, last_used_at, ignored_count
    FROM agent_memories
    WHERE agent_id='task-trajectories'
      AND visibility='public'
      AND status='active'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 25));
  const knownKeys = new Set(rows.map(row => String(row.mem_key ?? '')));
  const candidates = [];

  for (const row of rows) {
    const key = String(row.mem_key ?? '');
    if (!key.startsWith('trajectory:')) continue;
    const trajectory = parseTrajectoryMemory(row.content);
    if (!trajectory) continue;

    const heuristicKey = `trajectory-heuristic:${trajectory.task_id || trajectory.query_id || row.id}`;
    if (knownKeys.has(heuristicKey)) continue;

    candidates.push({
      source_memory_id: Number(row.id),
      source_memory_key: key,
      heuristic_key: heuristicKey,
      trajectory,
    });
    if (candidates.length >= Math.max(1, Number(limit) || 25)) break;
  }

  return candidates;
}

export function buildTrajectoryHeuristic(candidate = {}) {
  const trajectory = candidate.trajectory ?? {};
  const acceptedSourceIds = normalizeList(trajectory.accepted_source_ids);
  const outcomeTags = ['successful', 'self-learning', String(trajectory.route ?? 'unknown')].filter(Boolean);
  const preconditions = normalizeList([
    trajectory.route ? `route:${trajectory.route}` : '',
    trajectory.agent_id ? `agent:${trajectory.agent_id}` : '',
    trajectory.task_id ? `task:${trajectory.task_id}` : trajectory.query_id ? `query:${trajectory.query_id}` : '',
    trajectory.intent ? `intent:${String(trajectory.intent).slice(0, 120)}` : '',
  ]);
  const failureModes = normalizeList(
    trajectory.result?.failure_modes
      ?? trajectory.result?.failureModes
      ?? trajectory.metadata?.failure_modes
      ?? trajectory.metadata?.failureModes
      ?? ['none observed in successful trajectory'],
  );
  const heuristic = {
    trajectory_memory_id: candidate.source_memory_id ?? null,
    trajectory_memory_key: candidate.source_memory_key ?? '',
    task_id: trajectory.task_id ?? '',
    query_id: trajectory.query_id ?? '',
    route: trajectory.route ?? '',
    agent_id: trajectory.agent_id ?? '',
    intent: trajectory.intent ?? '',
    outcome_tags: outcomeTags,
    preconditions,
    failure_modes: failureModes,
    cited_source_ids: acceptedSourceIds,
    changed_files: normalizeList(trajectory.changed_files),
    commands: normalizeList(trajectory.commands),
    tests: normalizeList(trajectory.tests),
    recorded_at: new Date().toISOString(),
  };

  return {
    key: candidate.heuristic_key ?? `trajectory-heuristic:${candidate.source_memory_id ?? Date.now()}`,
    tags: ['trajectory', 'heuristic', 'successful', 'self-learning', trajectory.route, trajectory.agent_id]
      .map(value => String(value ?? '').trim())
      .filter(Boolean),
    content: [
      'Successful trajectory heuristic.',
      `Outcome tags: ${heuristic.outcome_tags.join(', ')}.`,
      heuristic.preconditions.length ? `Preconditions: ${heuristic.preconditions.join(', ')}.` : '',
      heuristic.failure_modes.length ? `Failure modes: ${heuristic.failure_modes.join(', ')}.` : '',
      heuristic.cited_source_ids.length ? `Cited sources: ${heuristic.cited_source_ids.join(', ')}.` : '',
      heuristic.changed_files.length ? `Changed files: ${heuristic.changed_files.join(', ')}.` : '',
      heuristic.tests.length ? `Tests: ${heuristic.tests.join(' | ')}.` : '',
      `Heuristic JSON: ${JSON.stringify(heuristic)}`,
    ].filter(Boolean).join('\n'),
    heuristic,
  };
}

export function trajectoryReflectionSummary(db, { limit = 10 } = {}) {
  const rawMemories = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_memories
    WHERE agent_id='task-trajectories'
      AND visibility='public'
      AND status='active'
      AND mem_key LIKE 'trajectory:%'
  `).get()?.c ?? 0);
  const heuristicMemories = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_memories
    WHERE agent_id='task-trajectories'
      AND visibility='public'
      AND status='active'
      AND mem_key LIKE 'trajectory-heuristic:%'
  `).get()?.c ?? 0);
  const heuristicRows = db.prepare(`
    SELECT id, mem_key, content, created_at, last_used_at, ignored_count
    FROM agent_memories
    WHERE agent_id='task-trajectories'
      AND visibility='public'
      AND status='active'
      AND mem_key LIKE 'trajectory-heuristic:%'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 10)).map(row => {
    const parsed = extractJsonAfterMarker(row.content, 'Heuristic JSON:') ?? null;
    return {
      id: Number(row.id),
      key: String(row.mem_key ?? ''),
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      ignored_count: Number(row.ignored_count ?? 0),
      heuristic: parsed,
    };
  });
  const pendingCompaction = trajectoryReflectionCandidates(db, { limit: 100 }).length;
  return {
    rawMemories,
    heuristicMemories,
    pendingCompaction,
    recentHeuristics: heuristicRows,
  };
}

export function buildNextRecommendations({
  report,
  phaseImprovementSummary,
  trajectoryReflection,
} = {}) {
  const recommendations = [];
  const weakPhases = report?.contextPrecision?.weakPhases ?? [];
  if (weakPhases.length) {
    const phase = weakPhases[0];
    recommendations.push({
      surface: 'context.phase.improve',
      priority: 'high',
      action: 'inspect weak retrieval phases and tune ranking/budgeting',
      phase: phase.phase,
      volunteered: phase.volunteered,
      used: phase.used,
      precision: phase.precision,
    });
  }
  const regressions = phaseImprovementSummary?.outcomes?.filter(outcome => outcome.outcome === 'regressed') ?? [];
  if (regressions.length) {
    const outcome = regressions[0];
    recommendations.push({
      surface: 'context.phase.improve',
      priority: 'medium',
      action: 'review the latest regression and compare before/after phase precision',
      phase: outcome.phase,
      task_id: outcome.task_id,
      delta: outcome.delta,
    });
  }
  if ((trajectoryReflection?.pendingCompaction ?? 0) > 0) {
    recommendations.push({
      surface: 'task-trajectories',
      priority: 'medium',
      action: 'compact successful trajectories into reusable heuristics',
      rawMemories: trajectoryReflection.rawMemories ?? 0,
      heuristicMemories: trajectoryReflection.heuristicMemories ?? 0,
      pendingCompaction: trajectoryReflection.pendingCompaction,
    });
  }
  if ((trajectoryReflection?.heuristicMemories ?? 0) > 0) {
    recommendations.push({
      surface: 'task-trajectories',
      priority: 'low',
      action: 'reuse compacted trajectory heuristics for similar tasks',
      heuristicMemories: trajectoryReflection.heuristicMemories ?? 0,
    });
  }
  if ((phaseImprovementSummary?.counts?.improved ?? 0) > 0) {
    recommendations.push({
      surface: 'context.phase.improve',
      priority: 'low',
      action: 'preserve the improved retrieval pattern and compare it against future regressions',
      improved: phaseImprovementSummary.counts.improved,
    });
  }
  return recommendations;
}

export function summarizePhaseImprovementOutcomes(db, { days = 7, limit = 25 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const rows = db.prepare(`
    SELECT * FROM timeline
    WHERE type='context.phase.improve:outcome' AND created_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(since, Math.max(1, Number(limit) || 25)).map(row => ({
    ...row,
    data: parseJson(row.data, {}),
    tags: parseJson(row.tags, []),
  }));
  const counts = { total: rows.length, improved: 0, regressed: 0, neutral: 0, pending: 0, insufficient_baseline: 0, insufficient_followup: 0 };
  const byPhase = {};
  for (const row of rows) {
    const outcome = String(row.data?.outcome ?? 'pending');
    if (counts[outcome] == null) counts.pending++;
    else counts[outcome]++;
    const phase = String(row.data?.phase ?? 'unknown');
    const bucket = byPhase[phase] ??= { phase, outcomes: 0, improved: 0, regressed: 0, neutral: 0, pending: 0, average_delta: null };
    bucket.outcomes++;
    if (bucket[outcome] == null) bucket.pending++;
    else bucket[outcome]++;
    bucket._deltaSum = (bucket._deltaSum ?? 0) + Number(row.data?.delta ?? 0);
  }
  const byPhaseRows = Object.values(byPhase).map(row => ({
    phase: row.phase,
    outcomes: row.outcomes,
    improved: row.improved,
    regressed: row.regressed,
    neutral: row.neutral,
    pending: row.pending,
    average_delta: row.outcomes ? round(row._deltaSum / row.outcomes) : null,
  })).sort((a, b) => b.outcomes - a.outcomes || a.phase.localeCompare(b.phase));
  return {
    since,
    counts,
    byPhase: byPhaseRows,
    outcomes: rows.map(row => ({
      task_id: row.subject,
      ...row.data,
      created_at: row.created_at,
    })),
  };
}
