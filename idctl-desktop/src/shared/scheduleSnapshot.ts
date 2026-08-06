/**
 * Reconcile the Manager's all-team schedule aggregate with the active team's
 * direct schedule read. `null` means a read failed; an empty array is a
 * successful read that found no schedules.
 *
 * The direct active-team read is authoritative for that team. The aggregate
 * still supplies every other team. This keeps a transient/compatibility failure
 * in either endpoint from blanking otherwise valid schedule state.
 */
export function reconcileScheduleSnapshot<T extends { id: string; team?: string }>(
  aggregate: readonly T[] | null,
  local: readonly T[] | null,
  team: string,
  previousAggregate: readonly T[] = [],
): { all: T[]; local: T[] } | null {
  if (aggregate === null && local === null) return null;

  if (local !== null) {
    const localTagged = local.map((schedule) => ({ ...schedule, team: schedule.team ?? team }));
    // On a display refresh, callers may provide the last verified aggregate so
    // an all-team outage does not make other teams appear deleted. Mutation
    // guards intentionally omit it and never authorize from stale state.
    const otherTeams = (aggregate ?? previousAggregate).filter((schedule) => (schedule.team ?? team) !== team);
    return {
      all: [...otherTeams, ...localTagged],
      local: localTagged,
    };
  }

  const all = [...(aggregate ?? [])];
  return {
    all,
    local: all.filter((schedule) => (schedule.team ?? team) === team),
  };
}
