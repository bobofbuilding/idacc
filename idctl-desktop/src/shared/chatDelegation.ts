const EXPLICIT_DELEGATION = /\b(delegate|delegation|fan[ -]?out|team leads?|parallel(?:ize|ise| work)?)\b/i;
const EXECUTION_VERB = /\b(audit|build|change|complete|deploy|fix|implement|integrate|manage|merge|publish|push|release|repair|resolve|ship|sync|test|update|upgrade|validate|verify)\b/i;
const BROAD_SCOPE = /\b(all|each|every|across|end[ -]?to[ -]?end|full|entire|whole|production)\b/i;
const WORK_OBJECT = /\b(app|application|branch(?:es)?|feature(?:s)?|issue(?:s)?|page(?:s)?|project(?:s)?|release(?:s)?|repo(?:sitories|s)?|setup|system|version(?:s)?|workflow(?:s)?)\b/i;
const DIRECT_LEAD_OVERRIDE = /(?:^|\s)\/(?:direct|lead-only)\b|\b(do (?:it|this) yourself|without delegat(?:ing|ion))\b/i;

/**
 * Primary-lead Chat is a coordination surface. Actionable work is routed through
 * the Manager's real cross-team fan-out instead of relying on an LLM instruction
 * to remember to delegate. Questions and casual conversation stay with the lead.
 */
export function shouldDelegatePrimaryLeadRequest(text: string): boolean {
  const value = String(text || '').trim();
  if (!value || DIRECT_LEAD_OVERRIDE.test(value)) return false;
  if (EXPLICIT_DELEGATION.test(value)) return true;
  if (!EXECUTION_VERB.test(value)) return false;
  return BROAD_SCOPE.test(value) || WORK_OBJECT.test(value);
}

export function stripDirectLeadOverride(text: string): string {
  return String(text || '').replace(/(?:^|\s)\/(?:direct|lead-only)\b/ig, ' ').replace(/\s{2,}/g, ' ').trim();
}
