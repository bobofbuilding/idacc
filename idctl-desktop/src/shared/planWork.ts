export interface PlanWorkBrainPlan {
  num?: string;
  title: string;
  file: string;
  status?: string;
  effort?: string;
  notes?: string;
  mtime?: number;
}

export interface PlanWorkGoal {
  id: string;
  title: string;
  idea: string;
  agent?: string;
  team: string;
  origin: 'plans';
  status: 'active';
  priority: 'general';
  autopilot: false;
  content: string;
  driver?: {
    lastRunAt?: number;
    taskRefs?: string[];
    note?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface PlanWorkSubTask {
  title: string;
  description: string;
  agent: string;
  dependsOn: number[];
}

export interface PrimaryLeadPlanWork {
  goal: PlanWorkGoal;
  objective: string;
  subtask: PlanWorkSubTask;
  source: string;
  owner: string;
}

function compactText(input: string, limit: number): string {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}...` : text;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function planWorkGoalId(plan: Pick<PlanWorkBrainPlan, 'file' | 'title'>): string {
  return `goal_plan_${stableHash(`${plan.file || ''}\n${plan.title || ''}`)}`;
}

function sourceLabel(plan: PlanWorkBrainPlan): string {
  return [plan.num, plan.file].filter(Boolean).join(' - ') || plan.title;
}

export function buildPrimaryLeadPlanWork(
  plan: PlanWorkBrainPlan,
  planContent: string,
  lead: string,
  leadTeam: string,
  now = Date.now(),
): PrimaryLeadPlanWork {
  const goalId = planWorkGoalId(plan);
  const source = sourceLabel(plan);
  const owner = leadTeam ? `${leadTeam}/${lead}` : lead;
  const title = `Plan: ${compactText(plan.title, 96)}`;
  const body = String(planContent || '').trim() || '(no plan content found)';
  const goal: PlanWorkGoal = {
    id: goalId,
    title,
    idea: `Work live brain plan ${source}`,
    agent: lead,
    team: leadTeam || 'default',
    origin: 'plans',
    status: 'active',
    priority: 'general',
    autopilot: false,
    content: [
      `# ${title}`,
      '',
      `Objective generated from Work > Plans for live brain plan ${source}.`,
      '',
      `- Owner: ${owner}`,
      '- Flow: primary lead decomposes remaining work, creates delegated child tasks, validates completed packets, and closes the parent task with delegated child names.',
      '- Guard: skip work already shipped; route optional follow-ups to backlog instead of creating duplicate live tasks.',
      '',
      '## Source Plan',
      '',
      body,
    ].join('\n'),
    driver: { note: `Created from brain plan ${source}` },
    createdAt: now,
    updatedAt: now,
  };
  const objective = `goal ${goalId}: Work brain plan "${plan.title}" through primary-lead delegation. Source: ${source}. Primary lead ${owner} must decompose only remaining work, create team-lead/member-owned child tasks, validate completed packets, and close the parent task with delegated child task names.`;
  const subtask: PlanWorkSubTask = {
    title: `Delegate plan: ${compactText(plan.title, 92)}`,
    description: [
      `goal ${goalId}`,
      `Source brain plan: ${compactText(source, 120)}`,
      `Primary lead: ${owner}`,
      'Coordination task: create child /task rows assigned to relevant team leads or active non-lead agents before execution; do not do the whole plan yourself.',
      'Skip shipped work; close only after child tasks and validator checks finish.',
    ].join('\n'),
    agent: lead,
    dependsOn: [],
  };
  return { goal, objective, subtask, source, owner };
}
