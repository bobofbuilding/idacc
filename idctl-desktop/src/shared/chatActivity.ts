import type { ActivityStep } from '../../../idctl/src/api/types.ts';

function activityKey(step: ActivityStep): string {
  // seq can restart with the Manager process, so include the event time/content.
  return `${step.seq}:${step.at}:${step.agent}:${step.kind}:${step.summary}`;
}

/** Only exact, tagged activity can annotate a particular Chat reply. */
export function exactQueryActivity(items: ActivityStep[], queryId: string): ActivityStep[] {
  if (!queryId) return [];
  return (Array.isArray(items) ? items : []).filter((item) => item.queryId === queryId);
}

/** Merge overlapping activity polls without duplicating a visible/persisted step. */
export function mergeExactQueryActivity(
  previous: ActivityStep[],
  incoming: ActivityStep[],
  queryId: string,
  limit: number,
): ActivityStep[] {
  const merged = new Map<string, ActivityStep>();
  for (const step of [...previous, ...exactQueryActivity(incoming, queryId)]) {
    merged.set(activityKey(step), step);
  }
  return [...merged.values()].slice(-Math.max(0, limit));
}
