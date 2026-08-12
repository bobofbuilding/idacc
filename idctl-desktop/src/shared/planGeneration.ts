/**
 * Builds the prompt for Work > Plans. Requesting a plan produces a stored
 * reference artifact; it never authorizes execution of the proposed steps.
 */
export function buildPlanGenerationPrompt(request: string): string {
  return [
    'Create a clear, structured implementation plan for this request. Use Markdown: a one-line overview, then numbered phases with concrete steps, dependencies, and risks/considerations. Be specific and actionable.',
    '',
    'This is planning-only. Return the reference plan; do not execute it, create implementation child tasks, modify code, deploy, broadcast, test live infrastructure, or perform operational work.',
    'If your task discipline requires a temporary planner task, close that task as advisory work with --advisory-query (or --no-delegation-reason "planning_only: reference plan delivered"). Never create an artificial completed child task solely to close a planning artifact.',
    '',
    `Request: ${request}`,
  ].join('\n');
}
