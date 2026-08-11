import type { Task } from '../../../idctl/src/api/types.ts';

export interface DurableTaskContext {
  ref: string;
  found: boolean;
  team?: string;
  task?: Task;
  completionQueryId?: string;
  completionQueryStatus?: string;
  completionReply?: string;
  structuredDeliverables?: { outcomeResult?: unknown; evmAddresses: string[]; urls: string[] };
}

const EXACT_TASK_REF = /#[a-f0-9]{8,64}\b/i;
const NO_DELEGATION = /\b(?:do\s+not|don't|without)\s+(?:attempt(?:ing)?\s+)?(?:delegate|delegation)\b|\bretrieval[- ]only\b/i;
const EXISTING_RESULT_REQUEST = /\b(?:return|retrieve|show|give|read|report|provide)\b|\b(?:already[- ]completed|completed|existing|stored)\b|\b(?:deliverables?|results?|outcomes?|completion)\b/i;
const NEW_WORK_REQUEST = /\b(?:implement|build|fix|repair|change|modify|edit|create|continue|resume|reopen|assign|delegate|ship|deploy)\b/i;

/** Exact completed-task lookups with a no-delegation instruction stay local. */
export function isTaskRetrievalOnlyRequest(text: string): boolean {
  return EXACT_TASK_REF.test(text) && NO_DELEGATION.test(text) && EXISTING_RESULT_REQUEST.test(text);
}

/** Completed-result questions are reads even when the user did not spell out “do not delegate.” */
export function isCompletedTaskResultRequest(text: string): boolean {
  return EXACT_TASK_REF.test(text)
    && EXISTING_RESULT_REQUEST.test(text)
    && !NEW_WORK_REQUEST.test(text);
}

function compact(value: unknown, limit = 12_000): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value ?? ''); }
  }
  text = text.trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** Render only durable Manager evidence; never imply that validation proved repository state. */
export function formatTaskRetrievalResponse(contexts: readonly DurableTaskContext[]): string {
  const rows = contexts.map((context) => {
    if (!context.found || !context.task) {
      return `${context.ref}: no current Manager task record was found in the available team scopes.`;
    }
    const task = context.task;
    const outcome = context.structuredDeliverables?.outcomeResult ?? task.outcomeDetail?.result;
    const evidence = compact(context.completionReply);
    const durableOutcome = compact(outcome);
    const deliverables = [
      durableOutcome ? `Stored outcome:\n${durableOutcome}` : '',
      evidence && evidence !== durableOutcome ? `Stored completion reply:\n${evidence}` : '',
      context.structuredDeliverables?.evmAddresses?.length
        ? `Recorded EVM addresses: ${context.structuredDeliverables.evmAddresses.join(', ')}`
        : '',
      context.structuredDeliverables?.urls?.length
        ? `Recorded URLs: ${context.structuredDeliverables.urls.join(', ')}`
        : '',
    ].filter(Boolean);
    return [
      `${context.ref} — ${task.title}`,
      `Team: ${context.team || task.teamName || 'not recorded'} · status: ${task.status} · workflow: ${task.workflowState || 'not recorded'}`,
      ...deliverables,
      deliverables.length ? '' : 'No durable outcome or completion reply is stored for this task; IDACC will not invent the missing deliverable.',
    ].filter(Boolean).join('\n');
  });
  return [
    'Retrieved directly from the Manager task record. No delegation or new work was started.',
    '',
    rows.join('\n\n---\n\n'),
  ].join('\n');
}
