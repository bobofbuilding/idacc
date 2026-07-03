/**
 * Dashboard/work invalidation taxonomy.
 *
 * These domains are deliberately coarse. They tell every mounted page what to
 * reload after a successful mutation without broadcasting the mutation payload.
 */

export interface StoreChangeEvent {
  method: string;
  domains: string[];
  at: number;
}

const RULES: Array<[RegExp, string[]]> = [
  [/^plans:(save|remove)$/, ['plans', 'work', 'brain']],
  [/^brain:(createPlan|setPlanStatus)$/, ['brain', 'brain-plans', 'plans', 'work']],
  [/^goals:(save|remove)$/, ['goals', 'work', 'brain']],
  [/^goalDriver:(setConfig|runOnce)$/, ['goals', 'tasks', 'work', 'brain']],
  [/^loops:(save|remove)$/, ['loops', 'work', 'brain']],
  [/^dreams:(save|remove)$/, ['dreams', 'work', 'brain']],
  [/^materials:(save|remove|importFiles|priority|process|processNext|recoverStale|markRecommendation)$/, ['materials', 'work', 'brain', 'inbox']],
  [/^questions:(add|remove)$/, ['questions', 'inbox', 'tasks', 'work', 'brain']],
  [/^brainApprovals:syncInbox$/, ['questions', 'inbox', 'brain']],
  [/^brainApproval:resolve$/, ['questions', 'inbox', 'brain']],
  [/^inbox:(respond|dismiss)$/, ['inbox', 'tasks', 'dashboard', 'brain']],
  [/^tasks:set(Lane|Deps|Review)$/, ['tasks', 'work', 'brain']],
  [/^work:(createPlan|fanout|triage)$/, ['tasks', 'work', 'dashboard', 'brain']],
  [/^(addHeartbeat|addCalendarCheckin|pauseSchedule|resumeSchedule|removeSchedule|checkins:close)$/, ['schedules', 'checkins', 'loops', 'work', 'brain']],
  [/^projects:(save|remove|syncRoot)$/, ['projects', 'dashboard', 'brain']],
  [/^coordinator:(set|setPrimary)$/, ['org', 'dashboard', 'agents', 'work', 'brain']],
  [/^org:(sync|setConfig|setSecondaryLeads)$/, ['org', 'dashboard', 'agents', 'work', 'brain']],
  [/^(setAgent|agent:(move|setInstructions)|spawnAgent|deployTeam|team:|rebuildAgent|installSkill|uninstallSkill|createSkill|projectPluginSkill|deleteSkill|setTeamDelegates|setAgentDelegates)/, ['agents', 'teams', 'dashboard', 'brain', 'modules']],
  [/^skills:(syncBrain|categorize)$/, ['modules', 'brain']],
  [/^(mcp:(add|remove)|providers:(add|remove|setDefault|setModelSelection|toggle|connect)|runtime:probe|manager:setLocalConcurrency|headroom:setPilot|evmRpc:(save|remove|probe)|image:setServer)/, ['settings', 'modules', 'brain']],
  [/^(chats:(save|rename|remove|markRead|patch)|chat:saveFiles|chat:savePasted)$/, ['chats', 'dashboard']],
  [/^(dispatch|dispatch:start|remote)$/, ['dashboard', 'tasks', 'inbox']],
];

export function syncDomainsForMethod(method: string): string[] {
  const domains = new Set<string>();
  for (const [pattern, hits] of RULES) {
    if (!pattern.test(method)) continue;
    for (const hit of hits) domains.add(hit);
  }
  return [...domains];
}
