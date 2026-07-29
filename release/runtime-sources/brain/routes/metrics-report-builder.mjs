export function learningTaskQueueSummary({ db, parseJson, parseLearningTask, since = 0 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const staleQueuedSeconds = Number(process.env.BRAIN_LEARNING_TASK_STALE_QUEUED_SECONDS ?? 86400);
  const retryThresholds = (() => {
    const defaults = {
      default: Number(process.env.BRAIN_LEARNING_TASK_RETRY_THRESHOLD ?? 3),
      'citation.repair': 3,
      'source.refresh': 2,
      'source.mark_stale': 2,
      'proposal.reject': 2,
      'correction.pattern': 3,
      'skill.revision': 3,
    };
    const raw = process.env.BRAIN_LEARNING_TASK_RETRY_THRESHOLDS ?? '';
    if (!raw) return defaults;
    try {
      const parsed = parseJson(raw, {});
      for (const [kind, threshold] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
        const n = Number(threshold);
        if (Number.isFinite(n) && n > 0) defaults[kind] = Math.floor(n);
      }
    } catch {
      for (const part of raw.split(',')) {
        const [kind, threshold] = part.split(':').map(s => s?.trim());
        const n = Number(threshold);
        if (kind && Number.isFinite(n) && n > 0) defaults[kind] = Math.floor(n);
      }
    }
    return defaults;
  })();
  const rows = db.prepare(`SELECT * FROM learning_tasks ORDER BY created_at ASC LIMIT 1000`).all()
    .map(row => parseLearningTask(row, parseJson));
  const byStatus = {};
  const byKind = {};
  const byAssignee = {};
  let totalAge = 0;
  let openAge = 0;
  let openCount = 0;
  let retryCount = 0;
  let staleQueued = 0;
  let staleAssigned = 0;
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byKind[row.kind] ??= { kind: row.kind, total: 0, queued: 0, assigned: 0, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 };
    byKind[row.kind].total++;
    byKind[row.kind][row.status] = (byKind[row.kind][row.status] ?? 0) + 1;
    const assignee = row.assignee || 'unassigned';
    byAssignee[assignee] ??= { assignee, total: 0, queued: 0, assigned: 0, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 };
    byAssignee[assignee].total++;
    byAssignee[assignee][row.status] = (byAssignee[assignee][row.status] ?? 0) + 1;
    const age = Math.max(0, now - Number(row.created_at ?? now));
    totalAge += age;
    if (!['completed', 'cancelled'].includes(row.status)) {
      openAge += age;
      openCount++;
    }
    retryCount += Number(row.payload?.retry_count ?? 0);
    if (row.status === 'queued' && age >= staleQueuedSeconds) staleQueued++;
    if (['assigned', 'in_progress'].includes(row.status) && Number(row.payload?.lease_expires_at ?? 0) > 0 && Number(row.payload.lease_expires_at) < now) {
      staleAssigned++;
    }
  }
  const recentCompleted = rows.filter(row => row.status === 'completed' && Number(row.completed_at ?? 0) >= since).length;
  const pendingEscalations = db.prepare(`
    SELECT COUNT(*) AS c FROM approvals
    WHERE kind='learning-task.escalate' AND status='pending'
  `).get().c;
  return {
    total: rows.length,
    open: openCount,
    byStatus,
    byKind: Object.values(byKind).sort((a, b) => b.total - a.total),
    byAssignee: Object.values(byAssignee).sort((a, b) => b.total - a.total),
    staleQueued,
    staleAssigned,
    retryCount,
    pendingEscalations,
    recentCompleted,
    averageAgeSeconds: rows.length ? Math.round(totalAge / rows.length) : 0,
    averageOpenAgeSeconds: openCount ? Math.round(openAge / openCount) : 0,
    thresholds: { staleQueuedSeconds, retryThresholds },
  };
}
