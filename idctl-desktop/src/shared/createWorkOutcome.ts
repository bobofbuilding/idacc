export interface CreateWorkAttempt {
  ok: boolean;
  ref: string;
  agent: string;
  dispatched: boolean;
  error?: string;
  warning?: string;
}

export interface CreateWorkTeamResult {
  team: string;
  dispatched: number;
  attempts: CreateWorkAttempt[];
}

export interface CreateWorkOutcome {
  createdCount: number;
  dispatchedCount: number;
  createdRefs: string[];
  failedTargetKeys: string[];
  failures: string[];
  dispatchIssues: string[];
  complete: boolean;
  text: string;
}

function compact(value: unknown, limit = 240): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Turn Create Work's structured result into an auditable, actionable message. */
export function createWorkOutcome(results: readonly CreateWorkTeamResult[], requestedCount: number): CreateWorkOutcome {
  const attempts = results.flatMap((result) => result.attempts.map((attempt) => ({ ...attempt, team: result.team })));
  const created = attempts.filter((attempt) => attempt.ok);
  const failed = attempts.filter((attempt) => !attempt.ok);
  const createdRefs = [...new Set(created.map((attempt) => compact(attempt.ref, 120)).filter(Boolean))];
  const failedTargetKeys = [...new Set(failed.map((attempt) => `${attempt.team}/${attempt.agent}`))];
  const failures = failed.map((attempt) => {
    const reason = compact(attempt.error || attempt.warning || 'Manager returned no task ID or failure reason');
    return `${attempt.team}/${attempt.agent}: ${reason}`;
  });
  const missingResults = Math.max(0, requestedCount - attempts.length);
  if (missingResults) failures.push(`${missingResults} target${missingResults === 1 ? '' : 's'}: Manager returned no task result; refresh the roster and retry`);
  const dispatchIssues = created
    .filter((attempt) => !attempt.dispatched)
    .map((attempt) => `${attempt.team}/${attempt.agent} ${attempt.ref}: ${compact(attempt.error || attempt.warning || 'task created; dispatch was not confirmed')}`);
  const createdCount = created.length;
  const dispatchedCount = results.reduce((sum, result) => sum + Number(result.dispatched || 0), 0);
  const complete = createdCount === requestedCount;
  const prefix = createdCount
    ? `assigned ${createdCount}/${requestedCount} · dispatched ${dispatchedCount} across ${results.length} team${results.length === 1 ? '' : 's'}${createdRefs.length ? ` · task${createdRefs.length === 1 ? '' : 's'} ${createdRefs.join(', ')}` : ''}`
    : `No task created (0/${requestedCount})`;
  const text = [
    prefix,
    failures.length ? `not created: ${failures.join('; ')}` : '',
    dispatchIssues.length ? `dispatch pending: ${dispatchIssues.join('; ')}` : '',
  ].filter(Boolean).join(' · ');
  return {
    createdCount,
    dispatchedCount,
    createdRefs,
    failedTargetKeys,
    failures,
    dispatchIssues,
    complete,
    text,
  };
}
