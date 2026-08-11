import type { Task } from '../../../idctl/src/api/types.ts';

export type ActiveOwnerQuerySignal = {
  count: number;
  queries: Array<{ query_id?: string; status?: string; prompt_preview?: string }>;
};

export function ownerQueryKey(team: string, agent: string): string {
  return JSON.stringify([String(team || 'default').trim(), String(agent || '').trim().toLowerCase()]);
}

/** Require query evidence for this exact task before showing a green working state. */
export function taskHasActiveOwnerQuery(task: Task, signal?: ActiveOwnerQuerySignal | null): boolean {
  if (!signal?.queries?.length) return false;
  const markers = [task.shortId, task.name, task.uuid]
    .flatMap((value) => {
      const text = String(value || '').trim().toLowerCase();
      return text ? [text, text.replace(/^#/, '')] : [];
    })
    .filter((value) => value.length >= 4);
  if (!markers.length) return false;
  return signal.queries.some((query) => {
    if (query.status && !/pending|processing/i.test(query.status)) return false;
    const prompt = String(query.prompt_preview || '').toLowerCase();
    return markers.some((marker) => prompt.includes(marker));
  });
}
