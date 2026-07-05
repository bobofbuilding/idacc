export const COALESCED_READ_METHODS = new Set([
  'health',
  'agents',
  'teams',
  'agents:allTeams',
  'wiki:get',
  'events',
  'events:tail',
  'events:multi',
  'news:allTeams',
  'activity:get',
  'inboxPending',
  'tasks',
  'tasks:allTeams',
  'tasks:lanes',
  'tasks:deps',
  'tasks:review',
  'tasks:usage',
  'usage',
  'org:hierarchy',
  'checkins',
  'schedules',
  'schedules:allTeams',
  'runtime:models',
  'runtime:freshness',
  'runtime:cooldowns',
  'subs:status',
  'providers:list',
  'librarySkills',
  'libraryTeams',
  'configs',
  'work:teamLeads',
  'libraryPluginInspections',
  'query:poll',
]);

const READ_CACHE_TTL_MS = new Map<string, number>([
  ['agents', 3000],
  ['teams', 5000],
  ['agents:allTeams', 8000],
  ['wiki:get', 60000],
  ['events:tail', 1000],
  ['events:multi', 8000],
  ['news:allTeams', 8000],
  ['inboxPending', 5000],
  ['tasks', 5000],
  ['tasks:allTeams', 10000],
  ['tasks:lanes', 10000],
  ['tasks:deps', 10000],
  ['tasks:review', 10000],
  ['tasks:usage', 15000],
  ['usage', 15000],
  ['org:hierarchy', 10000],
  ['checkins', 10000],
  ['schedules', 10000],
  ['schedules:allTeams', 10000],
  ['runtime:models', 5 * 60000],
  ['runtime:freshness', 5 * 60000],
  ['runtime:cooldowns', 15000],
  ['subs:status', 5 * 60000],
  ['providers:list', 60000],
  ['librarySkills', 60000],
  ['libraryTeams', 60000],
  ['libraryPluginInspections', 60000],
  ['configs', 15000],
  ['work:teamLeads', 5000],
]);

function readCallKey(method: string, args: unknown[]): string {
  try {
    return `${method}:${JSON.stringify(args)}`;
  } catch {
    return `${method}:${args.map((a) => String(a)).join('\u0001')}`;
  }
}

function isForcedRead(method: string, args: unknown[]): boolean {
  if (method === 'subs:status' && args[0] === true) return true;
  if (method !== 'agents:allTeams') return false;
  const first = args[0];
  return typeof first === 'object' && first !== null && (first as { force?: unknown }).force === true;
}

function cacheKeyArgs(method: string, args: unknown[]): unknown[] {
  if (method === 'agents:allTeams' && isForcedRead(method, args)) return [];
  return args;
}

export class ReadCallCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly results = new Map<string, { at: number; result: unknown }>();

  clear(): void {
    this.inFlight.clear();
    this.results.clear();
  }

  async run(method: string, args: unknown[], run: () => Promise<unknown>): Promise<unknown> {
    const forced = isForcedRead(method, args);
    const key = readCallKey(method, cacheKeyArgs(method, args));
    const cacheable = !(method === 'subs:status' && args[0] === true);
    const ttl = cacheable ? READ_CACHE_TTL_MS.get(method) ?? 0 : 0;
    if (!forced && ttl > 0) {
      const cached = this.results.get(key);
      if (cached && Date.now() - cached.at < ttl) return cached.result;
    }
    const current = this.inFlight.get(key);
    if (!forced && current) return current;
    let next: Promise<unknown>;
    next = run()
      .then((result) => {
        if (ttl > 0) this.results.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => {
        if (!forced && this.inFlight.get(key) === next) this.inFlight.delete(key);
      });
    if (!forced) this.inFlight.set(key, next);
    return next;
  }
}
