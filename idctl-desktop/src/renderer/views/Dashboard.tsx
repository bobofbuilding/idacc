import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore, type TeamEvent } from '../store.ts';
import { isAgentLive } from '../agentStatus.ts';
import { Chat } from './Chat.tsx';
import type { InboxItem, NewsItem, Task } from '../../../../idctl/src/api/types.ts';

/**
 * Dashboard = talk to a team lead + watch the fleet. The main panel is a chat locked to a
 * chosen team's lead/coordinator (pick the team from the header — independent of any global
 * active team), beside a slim, live activity feed spanning every team.
 */

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function agentLabel(idOrName: string, byId: Map<string, string>): string {
  if (!idOrName) return '';
  return byId.get(idOrName) ?? (/^agent_\d+_/.test(idOrName) ? '@' + idOrName.replace(/^agent_\d+_/, '') : idOrName);
}
const QUERY_VERB: Record<string, string> = {
  dispatched: 'was asked', received: 'received a query', processing: 'is thinking',
  delivered: 'replied', done: 'finished', complete: 'finished', completed: 'finished',
  failed: 'failed', timeout: 'timed out', cancelled: 'was cancelled', queued: 'queued a query',
};
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function previewOf(d: Record<string, unknown>): string {
  return str(d.message_preview) || str(d.preview) || str(d.message) || str(d.text) || str(d.title) || str(d.note);
}
function replyKind(preview: string): string {
  const p = preview.toLowerCase();
  if (!preview) return '';
  if (/^ready\b/.test(p) || p === 'ok' || p === 'ack') return 'heartbeat';
  if (/\b(error|failed|exception|cannot|denied|timeout)\b/.test(p)) return 'error';
  if (/```|function|const |class |def |import |\bSELECT\b/.test(preview)) return 'code';
  if (/\?$/.test(preview.trim())) return 'question';
  return 'message';
}
function describe(e: { topic: string; actor?: string; data?: Record<string, unknown> }, name: (id: string) => string): string {
  const d = e.data ?? {};
  const who = name(str(d.agent) || str(e.actor) || str(d.from) || str(d.name));
  const t = e.topic;
  if (t.startsWith('query:')) {
    const st = str(d.status) || t.split(':')[1] || '';
    const verb = QUERY_VERB[st] || (st ? `query ${st}` : 'query');
    const preview = previewOf(d);
    const head = who ? `${who} ${verb}` : verb;
    if (preview) { const kind = replyKind(preview); return `${head}${kind ? ` · ${kind}` : ''} · “${clip(preview, 80)}”`; }
    return head;
  }
  if (t.startsWith('task:')) return [who, clip(previewOf(d) || str(d.status) || t.split(':')[1], 90)].filter(Boolean).join(' — ');
  if (t.startsWith('agent:')) return [who, t.split(':')[1]].filter(Boolean).join(' ');
  if (t.startsWith('checkin')) return [name(str(d.delegate)) || who, clip(str(d.title), 80)].filter(Boolean).join(' — ');
  if (/relay|delegat|ask|deleg/.test(t)) { const to = name(str(d.to) || str(d.target) || str(d.delegate)); return [who, to].filter(Boolean).join(' → '); }
  const detail = previewOf(d) || str(d.status);
  return [who, clip(detail, 90)].filter(Boolean).join(' · ') || t;
}
function topicClass(t: string): string {
  if (/online|delivered|done|complete/.test(t)) return 'ok';
  if (/offline|fail|expired|error/.test(t)) return 'err';
  if (/due|pending/.test(t)) return 'warn';
  return 'accent';
}
function toMs(ts?: number | null): number {
  if (!ts) return 0;
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}
function taskRef(t: Task): string {
  return t.shortId || t.name || t.uuid || '';
}
function taskTime(t: Task): number {
  return toMs(t.completedAt ?? t.updatedAt ?? t.createdAt);
}
function taskClass(status: string): string {
  if (DONE_RE.test(status)) return 'ok';
  if (/block|fail|error|stuck|cancel/i.test(status)) return 'err';
  if (/todo|open|queue|new|backlog|pending/i.test(status)) return 'warn';
  return 'accent';
}
function taskVerb(status: string): string {
  if (DONE_RE.test(status)) return 'completed';
  if (DOING_RE.test(status)) return 'working';
  if (/todo|open|queue|new|backlog|pending/i.test(status)) return 'queued';
  return status || 'task';
}
function newsActor(n: DashboardNews): string {
  const d = n.data ?? {};
  const from = str(d.from) || str(d.sender) || str(d.agent) || str(d.source);
  const to = str(d.to) || str(d.target) || str(d.recipient);
  if (from && to) return `${from} → ${to}`;
  return from || to;
}
function newsClass(n: DashboardNews): string {
  const text = `${n.type} ${n.message ?? ''}`;
  if (/fail|error|denied|timeout|exception/i.test(text)) return 'err';
  if (/reply|complete|delivered|response/i.test(text)) return 'ok';
  if (/pending|received|message|notify|outbound/i.test(text)) return 'warn';
  return 'accent';
}
function newsDesc(n: DashboardNews): string {
  const actor = newsActor(n);
  const preview = clip(n.message || previewOf(n.data ?? {}) || n.type, 120);
  return [actor, preview].filter(Boolean).join(' — ');
}
function inboxDesc(i: InboxItem): string {
  const from = i.from || 'manager';
  const preview = clip(i.message || i.prompt || i.query_id, 120);
  return `${from} needs reply — ${preview}`;
}

type OrgHier = {
  primary: { team: string; agent: string } | null;
  secondaries: { agent: string; team: string; leadsTeams: string[] }[];
  coordinators: Record<string, string>;
  teams: string[];
};
type LiteTask = { ownerName?: string | null; status: string; title?: string; shortId?: string };
type DashboardNews = NewsItem & { teamName?: string };
type ActivityFeedItem = {
  key: string;
  topic: string;
  className: string;
  desc: string;
  team?: string;
  agent?: string; // raw agent id/name, used for active-agent filtering
  at: number;
  title: string;
};
const DOING_RE = /doing|progress|active|start|claim/i;
const DONE_RE = /done|complete/i;
const WORKING_STATUS_RE = /processing|busy/i;
const RECENT_WORKING_MS = 90_000;
const WORKING_EVENT_RE = /activity|processing|tool|file|query:processing|task:(doing|claim|claimed|progress|active|start)/i;

function activityKey(agent: { name: string; team?: string }): string {
  return `${agent.team ?? ''}:${agent.name}`;
}
function eventAgent(e: TeamEvent): string {
  return str(e.data?.agent) || str(e.actor) || str(e.data?.from) || str(e.data?.name);
}
function recentWorkingKeys(events: TeamEvent[]): Set<string> {
  const cutoff = Date.now() - RECENT_WORKING_MS;
  const keys = new Set<string>();
  for (const e of events) {
    const at = toMs(e.timestamp ?? e.occurred_at);
    const signal = `${e.topic} ${str(e.data?.status)} ${str(e.data?.kind)} ${str(e.data?.type)}`;
    if (at < cutoff || !WORKING_EVENT_RE.test(signal)) continue;
    const agent = eventAgent(e);
    if (!agent) continue;
    keys.add(`${e.team ?? ''}:${agent}`);
    keys.add(agent);
  }
  return keys;
}

/**
 * Live coordination tree — a real-time mirror of who's driving what: primary lead → secondary
 * leads → team leads → workers, each with its live state (working / idle / stopped) and current
 * task. The observation half of the CC refactor (Phase 4): the agents orchestrate, this just shows it.
 */
function CoordinationTree({ store, events, activeTeams }: { store: FleetStore; events: TeamEvent[]; activeTeams: string[] }) {
  const syncVersion = useSyncVersion(['org', 'agents', 'tasks', 'work', 'dashboard']);
  const [hier, setHier] = useState<OrgHier>({ primary: null, secondaries: [], coordinators: {}, teams: [] });
  const [tasks, setTasks] = useState<LiteTask[]>([]);
  const [spend, setSpend] = useState<{ total: number; count: number; top?: { agent: string; total: number } } | null>(null);
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);
  const load = useCallback(() => {
    void call<OrgHier>('org:hierarchy').then((h) => { if (liveRef.current && h) setHier(h); }).catch(() => {});
    void call<LiteTask[]>('tasks:allTeams').then((t) => { if (liveRef.current) setTasks(Array.isArray(t) ? t : []); }).catch(() => {});
    void call<{ day?: { total?: number; count?: number; agents?: { agent: string; total?: number; output: number }[] } }>('usage').then((u) => {
      if (!liveRef.current || !u?.day) return;
      const agents = u.day.agents ?? [];
      const top = agents.length ? agents.map((a) => ({ agent: a.agent, total: a.total ?? a.output })).sort((x, y) => y.total - x.total)[0] : undefined;
      setSpend({ total: u.day.total ?? 0, count: u.day.count ?? 0, top });
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, store.lastUpdated, syncVersion]);
  useEffect(() => {
    const iv = setInterval(() => { load(); }, 15000);
    return () => clearInterval(iv);
  }, [load]);

  const workingKeys = recentWorkingKeys(events);
  const taskOf = (name?: string) => (name ? tasks.find((t) => t.ownerName === name && DOING_RE.test(t.status) && !DONE_RE.test(t.status)) : undefined);
  const isWorking = (agent: { id?: string; name: string; team?: string; status?: string }) =>
    !!taskOf(agent.name) || workingKeys.has(activityKey(agent)) || workingKeys.has(agent.name) || !!(agent.id && workingKeys.has(agent.id)) || WORKING_STATUS_RE.test(agent.status ?? '');
  const node = (name: string, role: string, team?: string) => {
    const a = store.allAgents.find((x) => x.name === name && (!team || x.team === team)) ?? store.allAgents.find((x) => x.name === name);
    const present = !!a;
    const isLive = present && isAgentLive(a?.status);
    const working = !!(a && isWorking(a));
    const color = !present ? '#6b6b6b' : working ? '#3ccb78' : isLive ? '#c98a3c' : '#777';
    const state = !present ? 'not deployed' : working ? 'working' : isLive ? 'idle' : 'stopped';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }} title={state}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <b style={{ fontSize: 13 }}>{name}</b>
        <span className="muted small">{role}</span>
      </span>
    );
  };

  // A team row: the team lead (dot + name on the left) followed by one live dot per
  // team member to the right — green working / orange idle / grey stopped. No team
  // title, no task text, no idle label. The primary lead's own team is excluded
  // upstream so the lead isn't duplicated here as a team lead.
  const teamRow = (tm: string) => {
    const tl = hier.coordinators[tm];
    const members = store.allAgents.filter((a) => a.team === tm && a.name !== tl);
    return (
      <div key={tm} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {tl ? node(tl, 'team lead', tm) : <span className="muted small">no lead</span>}
        {members.length ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {members.map((a) => {
              const isLive = isAgentLive(a.status);
              const working = isWorking(a);
              const color = working ? '#3ccb78' : isLive ? '#c98a3c' : '#777';
              const state = working ? 'working' : isLive ? 'idle' : 'stopped';
              return (
                <span
                  key={a.id}
                  title={`${a.name} · ${state}`}
                  style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}
                />
              );
            })}
          </span>
        ) : null}
      </div>
    );
  };

  const primary = hier.primary?.agent;
  if (!primary) return null; // nothing to show until a primary lead is designated (HR Manager)
  const activeTeamSet = new Set(activeTeams);
  const visibleSecondaries = hier.secondaries
    .map((s) => ({ ...s, leadsTeams: s.leadsTeams.filter((tm) => activeTeamSet.has(tm)) }))
    .filter((s) => s.leadsTeams.length > 0);
  // Active teams not owned by any visible secondary, surfaced under the primary —
  // EXCEPT the primary lead's own (default) team: the lead already appears as
  // "primary lead" above, so rendering its team row would duplicate the same agent.
  const coveredTeams = new Set(visibleSecondaries.flatMap((s) => s.leadsTeams));
  const orphanTeams = activeTeams.filter((tm) => !coveredTeams.has(tm) && hier.coordinators[tm] !== primary);

  return (
    <section className="card" style={{ marginBottom: 12, flexShrink: 0 }}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        Live coordination <span className="muted small">· who's driving what, right now</span>
        <span className="grow" />
        {spend ? (
          <span className="muted small" title="Fleet token spend in the last 24h (new, non-cached tokens) and the top spender — Reset session on a heavy agent from HR Manager to deflate a bloated context.">
            ✳ {fmtTokens(spend.total)} tokens / 24h · {spend.count} turns{spend.top ? ` · top ${spend.top.agent} ${fmtTokens(spend.top.total)}` : ''}
          </span>
        ) : null}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          {node(primary, 'primary lead')}
          {orphanTeams.length ? (
            <div style={{ paddingLeft: 18, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {orphanTeams.map((tm) => teamRow(tm))}
            </div>
          ) : null}
        </div>
        {visibleSecondaries.map((s) => (
          <div key={s.agent} style={{ paddingLeft: 16, borderLeft: '1px solid var(--border, #2a2a2a)' }}>
            <div style={{ marginBottom: 4 }}>↳ {node(s.agent, 'secondary')}</div>
            <div style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {s.leadsTeams.map((tm) => teamRow(tm))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Dashboard({ store }: { store: FleetStore }) {
  const activitySyncVersion = useSyncVersion(['dashboard', 'tasks', 'work', 'inbox', 'chats']);
  const hierarchySyncVersion = useSyncVersion(['org', 'agents', 'dashboard']);
  const [hier, setHier] = useState<OrgHier>({ primary: null, secondaries: [], coordinators: {}, teams: [] });
  const hierarchyLiveRef = useRef(true);
  useEffect(() => () => { hierarchyLiveRef.current = false; }, []);
  const loadHierarchy = useCallback(() => {
    void call<OrgHier>('org:hierarchy').then((h) => { if (hierarchyLiveRef.current && h) setHier(h); }).catch(() => {});
  }, []);
  useEffect(() => { loadHierarchy(); }, [loadHierarchy, store.lastUpdated, hierarchySyncVersion]);
  // Teams that currently have ≥1 running agent (idle teams hidden from the picker).
  const activeTeams = useMemo(
    () => store.teams.map((t) => t.name).filter((n) => store.allAgents.some((a) => a.team === n && isAgentLive(a.status))),
    [store.teams, store.allAgents],
  );
  // The chat targets a CHOSEN team's lead — independent of the global active team.
  // Default to the active team (if running) else the first team with running agents.
  const [chatTeam, setChatTeam] = useState<string>('');
  useEffect(() => {
    setChatTeam((cur) => {
      if (cur && activeTeams.includes(cur)) return cur;
      if (store.team && activeTeams.includes(store.team)) return store.team;
      return activeTeams[0] ?? store.team ?? 'default';
    });
  }, [activeTeams, store.team]);

  const teamAgents = useMemo(() => store.allAgents.filter((a) => a.team === chatTeam), [store.allAgents, chatTeam]);
  const leadForTeam = useCallback((team: string) => {
    const agents = store.allAgents.filter((a) => a.team === team);
    const configured = hier.coordinators[team] || (team === store.team ? store.coordinator : undefined);
    return resolveCoordinator(agents, configured) ?? 'lead';
  }, [hier.coordinators, store.allAgents, store.coordinator, store.team]);
  const lead = leadForTeam(chatTeam);

  // Holistic activity feed: recent events plus durable task/comms state across
  // EVERY team (newest first). Events alone are lossy: a task/news row can exist
  // without a retained event, so the tile merges all sources before sorting.
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [news, setNews] = useState<DashboardNews[]>([]);
  const activityLiveRef = useRef(true);
  useEffect(() => () => { activityLiveRef.current = false; }, []);
  const loadActivity = useCallback(() => {
    void (async () => {
      const [evs, ts, ns] = await Promise.all([
        call<TeamEvent[]>('events:multi', 80).catch(() => [] as TeamEvent[]),
        call<Task[]>('tasks:allTeams').catch(() => [] as Task[]),
        call<DashboardNews[]>('news:allTeams', 80).catch(() => [] as DashboardNews[]),
      ]);
      if (!activityLiveRef.current) return;
      setEvents(evs);
      setTasks(ts);
      setNews(ns);
    })();
  }, []);
  useEffect(() => { loadActivity(); }, [loadActivity, store.lastUpdated, activitySyncVersion]);
  useEffect(() => {
    const iv = setInterval(() => { loadActivity(); }, 15000);
    return () => clearInterval(iv);
  }, [loadActivity]);
  const agentById = useMemo(() => new Map(store.allAgents.map((a) => [a.id, a.name] as const)), [store.allAgents]);
  const feedItems = useMemo<ActivityFeedItem[]>(() => {
    const name = (id: string) => agentLabel(id, agentById);
    const activeTeamSet = new Set(activeTeams);
    const fleetAgentKeys = new Set<string>();
    const activeAgentKeys = new Set<string>();
    for (const a of store.allAgents) {
      fleetAgentKeys.add(a.id); fleetAgentKeys.add(a.name);
      if (isAgentLive(a.status)) { activeAgentKeys.add(a.id); activeAgentKeys.add(a.name); }
    }
    const items: ActivityFeedItem[] = [];
    for (const e of events) {
      const at = toMs(e.timestamp ?? e.occurred_at);
      items.push({
        key: `event:${e.team ?? ''}:${e.seq}`,
        topic: e.topic.split(':')[0] || 'event',
        className: topicClass(e.topic),
        desc: describe(e, name),
        team: e.team,
        agent: str(e.data?.agent) || str(e.actor) || str(e.data?.from) || str(e.data?.name) || undefined,
        at,
        title: e.topic,
      });
    }
    for (const t of tasks) {
      const ref = taskRef(t);
      const owner = t.ownerName ? `${t.ownerName} · ` : '';
      const at = taskTime(t);
      items.push({
        key: `task:${t.teamName ?? ''}:${ref || `${t.title}:${at}`}`,
        topic: 'task',
        className: taskClass(t.status),
        desc: `${owner}${taskVerb(t.status)}${ref ? ` · ${ref}` : ''} · ${clip(t.title, 110)}`,
        team: t.teamName,
        agent: t.ownerName ?? undefined,
        at,
        title: `${t.status}${t.description ? ` — ${t.description}` : ''}`,
      });
    }
    for (const n of news) {
      items.push({
        key: `comms:${n.teamName ?? ''}:${n.id ?? `${n.timestamp}:${n.type}:${n.message ?? ''}`}`,
        topic: 'comms',
        className: newsClass(n),
        desc: newsDesc(n),
        team: n.teamName,
        agent: str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source) || undefined,
        at: toMs(n.timestamp),
        title: n.type,
      });
    }
    for (const i of store.inbox) {
      items.push({
        key: `inbox:${i.query_id}`,
        topic: 'inbox',
        className: 'warn',
        desc: inboxDesc(i),
        team: store.team,
        agent: i.from || undefined,
        at: toMs(i.timestamp),
        title: i.query_id,
      });
    }
    return items
      .filter((i) => {
        if (!i.desc) return false;
        if (i.team && !activeTeamSet.has(i.team)) return false;
        if (i.agent && fleetAgentKeys.has(i.agent) && !activeAgentKeys.has(i.agent)) return false;
        return true;
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 80);
  }, [activeTeams, agentById, events, tasks, news, store.allAgents, store.inbox, store.team]);

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header className="view-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1>Dashboard</h1>
        <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          talk to
          <select value={chatTeam} onChange={(e) => setChatTeam(e.target.value)} style={{ maxWidth: 260 }}>
            {(activeTeams.length ? activeTeams : [chatTeam].filter(Boolean)).map((t) => {
              const tl = leadForTeam(t);
              return <option key={t} value={t}>{t}{t === store.team ? ' (active)' : ''} · {tl}</option>;
            })}
          </select>
        </label>
      </header>

      <CoordinationTree store={store} events={events} activeTeams={activeTeams} />

      {/* Explicit flex row so the chat fills the left and the activity tile always shows on the right. */}
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        {/* Lead chat: locked to the chosen team's lead (no agent picker — Chat renders its own card). */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Chat store={store} embedded teamOverride={chatTeam} lockTarget={lead} key={chatTeam} />
        </div>

        {/* marginTop offsets the chat's control row so the tile top squares with the chat card
            top (when no project is focused; a focused project's banner adds a little extra). */}
        <aside className="card" style={{ width: 560, flexShrink: 0, marginTop: 38, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h3 style={{ marginTop: 0 }}>
            Activity <span className="muted small">· active teams{feedItems.length ? ` (${feedItems.length})` : ''} · {tasks.length} tasks · {news.length + store.inbox.length} comms</span>
          </h3>
          <div className="feed-list" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {feedItems.map((item) => (
              <div className="feed-row" key={item.key} title={item.title}>
                <span className={`topic ${item.className}`}>{item.topic}</span>
                <span className="desc">{item.team ? <span className="muted" style={{ marginRight: 4 }}>[{item.team}]</span> : null}{item.desc}</span>
                {item.at ? <span className="muted t">{ago(item.at)}</span> : null}
              </div>
            ))}
            {feedItems.length === 0 ? <div className="muted">waiting for activity…</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
