// SPDX-License-Identifier: MIT
import type { Task } from '../../../../idctl/src/api/types.ts';

export interface ProjectProgressSummary {
  working: number;
  deferred: number;
  blocked: number;
  failed: number;
  complete: number;
  plans: number;
  total: number;
}

function stateOf(task: Task): string {
  return String(task.workflowState || task.status || '').trim().toLowerCase();
}

export function summarizeProjectProgress(tasks: readonly Task[]): ProjectProgressSummary {
  const summary: ProjectProgressSummary = {
    working: 0,
    deferred: 0,
    blocked: 0,
    failed: 0,
    complete: 0,
    plans: new Set(tasks.map((task) => task.planId).filter(Boolean)).size,
    total: tasks.length,
  };
  for (const task of tasks) {
    const state = stateOf(task);
    if (['validated', 'done', 'completed', 'complete', 'retired', 'superseded'].includes(state)) {
      summary.complete += 1;
    } else if (state === 'failed') {
      summary.failed += 1;
    } else if (['blocked', 'stalled'].includes(state)) {
      summary.blocked += 1;
    } else if (['triage_required', 'queued', 'validation_pending', 'todo', 'pending', 'deferred'].includes(state)) {
      summary.deferred += 1;
    } else {
      summary.working += 1;
    }
  }
  return summary;
}
