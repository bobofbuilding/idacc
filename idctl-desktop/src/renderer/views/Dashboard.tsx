import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, useSyncVersion, type FleetStore, type TeamEvent } from '../store.ts';
import { isAgentLive } from '../agentStatus.ts';
import {
  activityAddressExplorerUrl,
  activityAddressLabel,
  broadcasterActivityScope,
  buildBroadcasterAddressHints,
  extractPublicEvmAddresses,
  normalizeActivityText,
  shortPublicAddress,
} from '../activityFeed.ts';
import { Chat } from './Chat.tsx';
import type { InboxItem, NewsItem, Task } from '../../../../idctl/src/api/types.ts';

/**
 * Dashboard = talk to default/lead + watch the fleet. The main panel is intentionally
 * pinned to the default primary lead; team-specific routing belongs in HR Manager.
 */

const DASHBOARD_CHAT_TEAM = 'default';
const DASHBOARD_CHAT_TARGET = 'lead';

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
async function writeActivityClipboard(value: string): Promise<boolean> {
  try {
    if (window.idagents?.copyText) return await window.idagents.copyText(value);
  } catch {
    // Fall through for browser/Tauri builds without the Electron clipboard bridge.
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  }
}
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
type WorkDraftSummary = { count: number; titles: string[] };
function extractJsonArray(text: string): string {
  const start = text.search(/\[\s*\{/);
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}
function workDraftFromText(text: string): WorkDraftSummary | null {
  const raw = extractJsonArray(text);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const rows = parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    if (rows.length === 0) return null;
    const taskShaped = rows.filter((row) => str(row.title) || str(row.description) || str(row.owner) || str(row.agent));
    if (taskShaped.length === 0) return null;
    return { count: rows.length, titles: taskShaped.map((row) => str(row.title)).filter(Boolean).slice(0, 3) };
  } catch {
    return null;
  }
}
function isInternalPlannerActor(actor: string): boolean {
  return /\b(task-manager|task-master)\b/i.test(actor);
}
function isInternalWorkDecompositionText(actor: string, text: string): boolean {
  if (!isInternalPlannerActor(actor)) return false;
  const raw = extractJsonArray(text);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every((row) =>
      !!row
      && typeof row === 'object'
      && !Array.isArray(row)
      && (str((row as Record<string, unknown>).agent) || str((row as Record<string, unknown>).owner))
      && ('dependsOn' in (row as Record<string, unknown>) || 'depends_on' in (row as Record<string, unknown>)),
    );
  } catch {
    return false;
  }
}
function isInternalWorkDecompositionNews(n: DashboardNews): boolean {
  const actor = newsActor(n) || str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source);
  const raw = n.message || previewOf(n.data ?? {});
  return isInternalWorkDecompositionText(actor, raw);
}
function workDraftDesc(actor: string, text: string): string | null {
  if (isInternalWorkDecompositionText(actor, text)) return null;
  const draft = workDraftFromText(text);
  if (!draft) return null;
  const noun = draft.count === 1 ? 'work item' : 'work items';
  const titles = draft.titles.length ? `: ${draft.titles.join('; ')}${draft.count > draft.titles.length ? ` +${draft.count - draft.titles.length} more` : ''}` : '';
  return [actor, `proposed ${draft.count} ${noun}${titles}`].filter(Boolean).join(' — ');
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
    const expiryReason = str(d.expiry_reason);
    if (st === 'expired' && queryExpiryIsCleanup(expiryReason)) {
      const label = expiryReason === 'duplicate_task_ask'
        ? 'cleaned duplicate query'
        : expiryReason === 'terminal_task_ask'
          ? 'closed obsolete query'
          : 'cleaned stale query';
      return [who, label].filter(Boolean).join(' ');
    }
    const verb = QUERY_VERB[st] || (st ? `query ${st}` : 'query');
    const preview = previewOf(d);
    const head = who ? `${who} ${verb}` : verb;
    const draft = workDraftDesc(head, preview);
    if (draft) return draft;
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
function queryExpiryIsCleanup(reason: string): boolean {
  return /^(duplicate_task_ask|terminal_task_ask|stale_plan_decision|queued_peer_wake)$/.test(reason);
}
function topicClass(t: string): string {
  if (/online|delivered|done|complete/.test(t)) return 'ok';
  if (/offline|fail|expired|error/.test(t)) return 'err';
  if (/due|pending/.test(t)) return 'warn';
  return 'accent';
}
function eventClass(e: { topic: string; data?: Record<string, unknown> }): string {
  if (e.topic === 'query:expired' && queryExpiryIsCleanup(str(e.data?.expiry_reason))) return 'warn';
  return topicClass(e.topic);
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
function taskIsDone(t: Task): boolean {
  return DONE_RE.test(t.status);
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
function newsFullDesc(n: DashboardNews): string {
  const actor = newsActor(n);
  const message = normalizeActivityText(n.message || previewOf(n.data ?? {}) || n.type);
  return [actor, message].filter(Boolean).join(' — ');
}
function newsWorkDraftDesc(n: DashboardNews): string | null {
  if (isInternalWorkDecompositionNews(n)) return null;
  const raw = n.message || previewOf(n.data ?? {});
  return workDraftDesc(newsActor(n), raw);
}
function inboxDesc(i: InboxItem): string {
  const from = i.from || 'manager';
  const preview = clip(i.message || i.prompt || i.query_id, 120);
  return `${from} needs reply — ${preview}`;
}
function uniqSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

type OrgHier = {
  primary: { team: string; agent: string } | null;
  secondaries: { agent: string; team: string; leadsTeams: string[] }[];
  coordinators: Record<string, string>;
  teams: string[];
};
type LiteTask = { ownerName?: string | null; status: string; title?: string; shortId?: string };
type DashboardNews = NewsItem & { teamName?: string };
type ActivityAddress = { address: string; label: string; explorerUrl?: string };
type ActivityFeedItem = {
  key: string;
  topic: string;
  className: string;
  desc: string;
  fullDesc?: string;
  addresses?: ActivityAddress[];
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
function CoordinationTree({
  store,
  events,
  coordinationTeams,
  hier,
  tasks,
}: {
  store: FleetStore;
  events: TeamEvent[];
  coordinationTeams: string[];
  hier: OrgHier;
  tasks: LiteTask[];
}) {
  const [spend, setSpend] = useState<{ total: number; count: number; top?: { agent: string; total: number } } | null>(null);
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);
  const loadUsage = useCallback(() => {
    void call<{ day?: { total?: number; count?: number; agents?: { agent: string; total?: number; output: number }[] } }>('usage').then((u) => {
      if (!liveRef.current || !u?.day) return;
      const agents = u.day.agents ?? [];
      const top = agents.length ? agents.map((a) => ({ agent: a.agent, total: a.total ?? a.output })).sort((x, y) => y.total - x.total)[0] : undefined;
      setSpend({ total: u.day.total ?? 0, count: u.day.count ?? 0, top });
    }).catch(() => {});
  }, []);
  useEffect(() => { loadUsage(); }, [loadUsage, store.lastUpdated]);
  useEffect(() => {
    const iv = setInterval(() => { loadUsage(); }, 15000);
    return () => clearInterval(iv);
  }, [loadUsage]);

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
  const coordinationTeamSet = new Set(coordinationTeams);
  const visibleSecondaries = hier.secondaries
    .map((s) => ({ ...s, leadsTeams: s.leadsTeams.filter((tm) => coordinationTeamSet.has(tm)) }))
    .filter((s) => s.leadsTeams.length > 0);
  // HR-known teams not owned by any visible secondary, surfaced under the primary —
  // EXCEPT the primary lead's own (default) team: the lead already appears as
  // "primary lead" above, so rendering its team row would duplicate the same agent.
  const coveredTeams = new Set(visibleSecondaries.flatMap((s) => s.leadsTeams));
  const orphanTeams = coordinationTeams.filter((tm) => !coveredTeams.has(tm) && hier.coordinators[tm] !== primary);

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
    () => uniqSorted([
      ...store.teams.map((t) => t.name),
      ...store.allAgents.filter((a) => isAgentLive(a.status)).map((a) => a.team ?? ''),
    ]).filter((n) => store.allAgents.some((a) => a.team === n && isAgentLive(a.status))),
    [store.teams, store.allAgents],
  );
  // HR Manager's graph is based on the full cross-team roster, not only currently
  // running teams. Dashboard should mirror that org shape and show stopped teams
  // greyed out instead of silently dropping them from Live Coordination.
  const coordinationTeams = useMemo(
    () => uniqSorted([
      ...hier.teams,
      ...store.teams.map((t) => t.name),
      ...store.allAgents.map((a) => a.team ?? ''),
      ...hier.secondaries.flatMap((s) => s.leadsTeams ?? []),
    ]).filter((team) => team !== 'public'),
    [hier.teams, hier.secondaries, store.teams, store.allAgents],
  );
  // Holistic activity feed: recent events plus durable task/comms state across
  // EVERY team (newest first). Events alone are lossy: a task/news row can exist
  // without a retained event, so the tile merges all sources before sorting.
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [news, setNews] = useState<DashboardNews[]>([]);
  const [activityClockTick, setActivityClockTick] = useState(0);
  const [expandedActivityKeys, setExpandedActivityKeys] = useState<Set<string>>(() => new Set());
  const [activityMenu, setActivityMenu] = useState<{ item: ActivityFeedItem; x: number; y: number } | null>(null);
  const [copiedActivityKey, setCopiedActivityKey] = useState('');
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
  useEffect(() => {
    const iv = setInterval(() => { setActivityClockTick((n) => (n + 1) % 60); }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!activityMenu) return undefined;
    const close = () => setActivityMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [activityMenu]);
  const toggleActivityExpanded = useCallback((key: string) => {
    setExpandedActivityKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const copyActivity = useCallback(async (item: ActivityFeedItem) => {
    const addressLines = (item.addresses ?? [])
      .filter(({ address }) => !(item.fullDesc ?? item.desc).includes(address))
      .map(({ label, address }) => `${label}: ${address}`);
    const team = item.team ? `[${item.team}] ` : '';
    const value = `${team}${item.fullDesc ?? item.desc}${addressLines.length ? `\n${addressLines.join('\n')}` : ''}`;
    const copied = await writeActivityClipboard(value);
    setCopiedActivityKey(copied ? item.key : `failed:${item.key}`);
    window.setTimeout(() => {
      setCopiedActivityKey((current) => current === item.key || current === `failed:${item.key}` ? '' : current);
      setActivityMenu((current) => current?.item.key === item.key ? null : current);
    }, 700);
  }, []);
  const activityTaskStats = useMemo(() => {
    const activeTeamSet = new Set(activeTeams);
    const scoped = tasks.filter((t) => !t.teamName || activeTeamSet.has(t.teamName));
    const open = scoped.filter((t) => !taskIsDone(t)).length;
    const working = scoped.filter((t) => DOING_RE.test(t.status) && !taskIsDone(t)).length;
    return { open, working, total: tasks.length };
  }, [activeTeams, tasks]);
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
    const broadcasterAddressByScope = buildBroadcasterAddressHints(news.map((n) => ({
      team: n.teamName,
      actor: str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source),
      timestamp: toMs(n.timestamp),
      text: n.message || previewOf(n.data ?? {}),
    })));
    for (const e of events) {
      const at = toMs(e.timestamp ?? e.occurred_at);
      items.push({
        key: `event:${e.team ?? ''}:${e.seq}`,
        topic: e.topic.split(':')[0] || 'event',
        className: eventClass(e),
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
    const draftBuckets = new Map<string, { team?: string; agent?: string; at: number; batches: number; examples: string[] }>();
    for (const n of news) {
      const draft = newsWorkDraftDesc(n);
      if (draft) {
        const at = toMs(n.timestamp);
        const agent = str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source) || undefined;
        const bucketKey = `${n.teamName ?? ''}:${agent ?? ''}:${Math.floor(at / (10 * 60 * 1000))}`;
        const bucket = draftBuckets.get(bucketKey) ?? { team: n.teamName, agent, at, batches: 0, examples: [] };
        bucket.at = Math.max(bucket.at, at);
        bucket.batches += 1;
        if (bucket.examples.length < 3) bucket.examples.push(draft.replace(/^.*? — /, ''));
        draftBuckets.set(bucketKey, bucket);
        continue;
      }
      items.push({
        key: `comms:${n.teamName ?? ''}:${n.id ?? `${n.timestamp}:${n.type}:${n.message ?? ''}`}`,
        topic: 'comms',
        className: newsClass(n),
        desc: newsDesc(n),
        fullDesc: newsFullDesc(n),
        team: n.teamName,
        agent: str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source) || undefined,
        at: toMs(n.timestamp),
        title: n.type,
        addresses: (() => {
          const raw = n.message || previewOf(n.data ?? {});
          const actor = str(n.data?.from) || str(n.data?.sender) || str(n.data?.agent) || str(n.data?.source);
          const direct = extractPublicEvmAddresses(raw);
          const scoped = /broadcaster\s+EOA/i.test(raw)
            ? broadcasterAddressByScope.get(broadcasterActivityScope(n.teamName, actor)) ?? []
            : [];
          return Array.from(new Set([...direct, ...scoped])).map((address) => ({
            address,
            label: activityAddressLabel(raw),
            explorerUrl: activityAddressExplorerUrl(raw, address),
          }));
        })(),
      });
    }
    for (const [key, bucket] of draftBuckets) {
      const actor = bucket.agent ? `${bucket.agent} → remote` : 'agent → remote';
      const noun = bucket.batches === 1 ? 'draft batch' : 'related draft batches';
      items.push({
        key: `draft:${key}`,
        topic: 'draft',
        className: 'warn',
        desc: `${actor} proposed ${bucket.batches} ${noun}${bucket.examples.length ? `: ${bucket.examples.join(' · ')}` : ''}`,
        team: bucket.team,
        agent: bucket.agent,
        at: bucket.at,
        title: 'Autopilot decomposition drafts grouped by team, actor, and 10-minute window',
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
        <div className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          talk to
          <span className="readonly-target" title="Dashboard chat is pinned to the default primary lead. Use HR Manager for team-specific conversations.">
            {DASHBOARD_CHAT_TEAM} · {DASHBOARD_CHAT_TARGET}
          </span>
        </div>
      </header>

      <CoordinationTree store={store} events={events} coordinationTeams={coordinationTeams} hier={hier} tasks={tasks} />

      {/* Explicit flex row so the chat fills the left and the activity tile always shows on the right. */}
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        {/* Primary lead chat: locked to default/lead (no team or agent picker). */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Chat store={store} embedded teamOverride={DASHBOARD_CHAT_TEAM} lockTarget={DASHBOARD_CHAT_TARGET} key={`${DASHBOARD_CHAT_TEAM}:${DASHBOARD_CHAT_TARGET}`} />
        </div>

        {/* marginTop offsets the chat's control row so the tile top squares with the chat card
            top (when no project is focused; a focused project's banner adds a little extra). */}
        <aside className="card" style={{ width: 560, flexShrink: 0, marginTop: 38, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h3 style={{ marginTop: 0 }}>
            Activity <span className="muted small">· {activeTeams.length} active teams · {feedItems.length} recent rows · {activityTaskStats.working} working · {activityTaskStats.open} open tasks · {activityTaskStats.total} total · {news.length + store.inbox.length} recent comms</span>
          </h3>
          <div className="feed-list activity-feed" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {feedItems.map((item) => {
              const expanded = expandedActivityKeys.has(item.key);
              const expandable = !!item.fullDesc && item.fullDesc !== item.desc;
              return (
              <div
                className={`feed-row activity-feed-row${expanded ? ' expanded' : ''}`}
                key={item.key}
                title={expandable ? item.fullDesc : item.title}
                tabIndex={expandable ? 0 : undefined}
                aria-expanded={expandable ? expanded : undefined}
                onDoubleClick={() => { if (expandable) toggleActivityExpanded(item.key); }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  toggleActivityExpanded(item.key);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const menuWidth = 196;
                  const menuHeight = expandable ? 78 : 42;
                  setActivityMenu({
                    item,
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
                  });
                }}
              >
                <span className={`topic ${item.className}`}>{item.topic}</span>
                <span className="desc">
                  {item.team ? <span className="muted" style={{ marginRight: 4 }}>[{item.team}]</span> : null}
                  {expanded ? item.fullDesc ?? item.desc : item.desc}
                  {(item.addresses ?? []).length > 0 ? (
                    <span className="activity-addresses">
                      {item.addresses?.map(({ address, label, explorerUrl }) => explorerUrl ? (
                        <a
                          className="activity-address"
                          href={explorerUrl}
                          key={address}
                          target="_blank"
                          rel="noreferrer"
                          title={`${label}: ${address}`}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          {label}: {expanded ? address : shortPublicAddress(address)}
                        </a>
                      ) : (
                        <span className="activity-address" key={address} title={`${label}: ${address}`}>
                          {label}: {expanded ? address : shortPublicAddress(address)}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {item.at ? <span className="muted t" data-clock={activityClockTick}>{ago(item.at)}</span> : null}
              </div>
              );
            })}
            {feedItems.length === 0 ? <div className="muted">waiting for activity…</div> : null}
          </div>
          {activityMenu ? (
            <div
              className="activity-context-menu"
              role="menu"
              style={{ left: activityMenu.x, top: activityMenu.y }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              {activityMenu.item.fullDesc && activityMenu.item.fullDesc !== activityMenu.item.desc ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    toggleActivityExpanded(activityMenu.item.key);
                    setActivityMenu(null);
                  }}
                >
                  {expandedActivityKeys.has(activityMenu.item.key) ? 'Collapse message' : 'Expand full message'}
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => { void copyActivity(activityMenu.item); }}>
                {copiedActivityKey === activityMenu.item.key
                  ? 'Copied'
                  : copiedActivityKey === `failed:${activityMenu.item.key}`
                    ? 'Copy failed'
                    : 'Copy full message'}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
