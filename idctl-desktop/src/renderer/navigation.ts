export type WorkTab = 'overview' | 'tasks' | 'goals' | 'plans' | 'learn' | 'schedule' | 'loops' | 'dream';
export type WorkArea = 'work' | 'knowledge' | 'automations';
export const WORK_AREAS: Record<WorkArea, readonly WorkTab[]> = {
  work: ['tasks', 'goals', 'plans'], knowledge: ['learn', 'dream'], automations: ['overview', 'schedule', 'loops', 'dream'],
};
export function workDestination(target: string): { view: 'tasks' | 'knowledge' | 'automations'; tab: WorkTab } | null {
  const aliases: Record<string, WorkTab> = { tasks: 'tasks', work: 'tasks', knowledge: 'learn', automations: 'overview', schedule: 'schedule' };
  const tab = aliases[target] ?? (target.startsWith('tasks:') || target.startsWith('work:') || target.startsWith('knowledge:') || target.startsWith('automations:') ? target.split(':')[1] : undefined);
  if (!tab || !Object.values(WORK_AREAS).some((tabs) => tabs.includes(tab as WorkTab))) return null;
  return { view: WORK_AREAS.knowledge.includes(tab as WorkTab) ? 'knowledge' : WORK_AREAS.automations.includes(tab as WorkTab) ? 'automations' : 'tasks', tab: tab as WorkTab };
}
