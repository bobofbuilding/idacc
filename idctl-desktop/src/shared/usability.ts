/** Parse only an explicit, complete plan-combination request, never a progress report. */
export function requestedPlanConsolidation(text: string): string[] | null {
  const match = text.trim().match(/^(?:please\s+)?(?:\/combine|combine|merge|consolidate)\s+plans?\s+((?:#?\d{1,3})(?:\s*(?:,|\+|and|&)\s*(?:plan\s+)?#?\d{1,3}){1,11})[.!]?$/i);
  if (!match) return null;
  const ids = [...new Set((match[1].match(/\d+/g) ?? []).map(Number))];
  return ids.length >= 2 && ids.every((id) => id > 0) ? ids.map(String) : null;
}

export const LEARN_BRAIN_SYNC_SCHEMA_VERSION = 3;
export interface LearningMaterialState {
  status?: string;
  brainSync?: {
    status?: string; schemaVersion?: number; exactEntity?: boolean;
    entity?: boolean; sourceEntity?: boolean; facts?: boolean; edges?: boolean;
    expectedEdgeCount?: number; edgeCount?: number;
  };
}
export function hasCurrentBrainGraphSync(material: LearningMaterialState): boolean {
  const sync = material.brainSync;
  if (!sync || sync.status !== 'ok' || sync.schemaVersion !== LEARN_BRAIN_SYNC_SCHEMA_VERSION || sync.exactEntity !== true) return false;
  if (!sync.entity || !sync.sourceEntity || !sync.facts || !sync.edges) return false;
  const expected = Math.max(0, Number(sync.expectedEdgeCount ?? 0) || 0);
  return Number(sync.edgeCount ?? 0) >= expected;
}
export function learningSummary(materials: LearningMaterialState[] | null) {
  if (materials === null) return { label: 'Status unavailable', detail: 'Could not refresh the library. Try again shortly.' };
  const processing = materials.filter((m) => m.status === 'processing').length;
  const queued = materials.filter((m) => m.status === 'queued').length;
  const attention = materials.filter((m) => m.status === 'failed' || m.status === 'blocked' || (m.status === 'ready' && !hasCurrentBrainGraphSync(m))).length;
  return {
    label: processing ? `${processing} processing` : queued ? `${queued} queued` : attention ? `${attention} need attention` : 'Up to date',
    detail: attention ? `${attention} source${attention === 1 ? '' : 's'} need processing or knowledge sync` : 'No pending sources',
  };
}
export const HEARTBEAT_INTERVALS = [
  { label: '1 min', s: 60 }, { label: '5 min', s: 300 }, { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 }, { label: '6 hours', s: 21600 }, { label: '12 hours', s: 43200 }, { label: '24 hours', s: 86400 },
];
export function heartbeatIntervals(current: number) {
  return HEARTBEAT_INTERVALS.some((interval) => interval.s === current) ? HEARTBEAT_INTERVALS
    : [...HEARTBEAT_INTERVALS, { label: `Custom: every ${current % 3600 === 0 ? `${current / 3600} hours` : current % 60 === 0 ? `${current / 60} minutes` : `${current} seconds`}`, s: current }].sort((a, b) => a.s - b.s);
}
