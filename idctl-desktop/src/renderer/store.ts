/**
 * Renderer-side live store. Talks to the manager only through the IPC bridge
 * (window.idagents.call). Mirrors the TUI's polling/streaming loops: a 3s
 * snapshot poll (agents/teams/inbox) plus a long-poll event cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Team, ManagerEvent, InboxItem } from '../../../idctl/src/api/types.ts';
import { syncDomainsForMethod, type StoreChangeEvent } from '../shared/syncDomains.ts';

export type Connection = 'connecting' | 'online' | 'offline';

/**
 * Pluggable data transport so the same UI runs under any shell:
 *   - Electron: IPC bridge (window.idagents)
 *   - Tauri:    a webview-side adapter (ManagerClient over the Tauri HTTP plugin)
 * The shell's entry point calls setTransport() before rendering.
 */
export type Transport = (method: string, args: unknown[]) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

let transport: Transport | null = null;
export function setTransport(t: Transport): void {
  transport = t;
}

type StoreChangeListener = (event: StoreChangeEvent) => void;
const storeChangeListeners = new Set<StoreChangeListener>();
let transportEventsBound = false;
let pendingStoreChange: StoreChangeEvent | null = null;
let pendingStoreChangeTimer: ReturnType<typeof setTimeout> | null = null;
const recentStoreChanges = new Map<string, number>();
const syncDomainVersions = new Map<string, number>();
let wildcardSyncVersion = 0;
const STORE_CHANGE_FLUSH_MS = 120;
const STORE_CHANGE_DEDUPE_MS = 500;

function syncVersionFor(wanted: Set<string>): number {
  let version = wildcardSyncVersion;
  for (const domain of wanted) version += syncDomainVersions.get(domain) ?? 0;
  return version;
}

function syncDomainSet(domains: string | string[]): Set<string> {
  const key = Array.isArray(domains) ? domains.join('|') : domains;
  return new Set(key.split('|').filter(Boolean));
}

export function currentSyncVersion(domains: string | string[]): number {
  return syncVersionFor(syncDomainSet(domains));
}

function noteSyncDomains(domains: string[]): void {
  for (const domain of domains) {
    if (domain === '*') wildcardSyncVersion += 1;
    else syncDomainVersions.set(domain, (syncDomainVersions.get(domain) ?? 0) + 1);
  }
}

function storeChangeKey(event: StoreChangeEvent): string {
  return `${event.method}:${[...event.domains].sort().join('|')}`;
}

function flushStoreChange(): void {
  pendingStoreChangeTimer = null;
  const event = pendingStoreChange;
  pendingStoreChange = null;
  if (!event) return;
  for (const listener of storeChangeListeners) {
    try { listener(event); } catch { /* listeners should not break the bus */ }
  }
}

export function emitStoreChange(event: StoreChangeEvent): void {
  if (!event.domains.length) return;
  const key = storeChangeKey(event);
  const last = recentStoreChanges.get(key) ?? 0;
  if (Date.now() - last < STORE_CHANGE_DEDUPE_MS) return;
  recentStoreChanges.set(key, Date.now());
  noteSyncDomains(event.domains);
  for (const [recentKey, at] of recentStoreChanges) {
    if (Date.now() - at > STORE_CHANGE_DEDUPE_MS * 4) recentStoreChanges.delete(recentKey);
  }
  if (pendingStoreChange) {
    pendingStoreChange = {
      method: pendingStoreChange.method === event.method ? event.method : 'batch',
      domains: [...new Set([...pendingStoreChange.domains, ...event.domains])],
      at: Date.now(),
    };
  } else {
    pendingStoreChange = { ...event, domains: [...new Set(event.domains)], at: Date.now() };
  }
  if (!pendingStoreChangeTimer) {
    pendingStoreChangeTimer = setTimeout(flushStoreChange, STORE_CHANGE_FLUSH_MS);
  }
}

export function subscribeStoreChanges(listener: StoreChangeListener): () => void {
  storeChangeListeners.add(listener);
  return () => { storeChangeListeners.delete(listener); };
}

export function bindStoreEvents(api?: { onStoreChange?: (cb: (event: StoreChangeEvent) => void) => () => void }): void {
  if (transportEventsBound) return;
  transportEventsBound = true;
  api?.onStoreChange?.((event) => emitStoreChange(event));
}

export function useSyncVersion(domains: string | string[]): number {
  const key = Array.isArray(domains) ? domains.join('|') : domains;
  const wanted = useMemo(() => syncDomainSet(key), [key]);
  const [version, setVersion] = useState(() => syncVersionFor(wanted));
  useEffect(() => {
    setVersion(syncVersionFor(wanted));
    return subscribeStoreChanges((event) => {
      if (!event.domains.length) return;
      if (event.domains.includes('*') || event.domains.some((domain) => wanted.has(domain))) {
        setVersion(syncVersionFor(wanted));
      }
    });
  }, [wanted]);
  return version;
}

/** Typed call over the active transport. Throws on the error envelope. */
export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!transport) throw new Error('no transport configured');
  const res = await transport(method, args);
  if (!res.ok) throw new Error(res.error || 'manager error');
  const domains = syncDomainsForMethod(method);
  if (domains.length) emitStoreChange({ method, domains, at: Date.now() });
  return res.result as T;
}

/**
 * The team's coordinator ("lead") agent name: the explicit coordinator if it
 * names a current agent, else a lead/manager-named agent, else the first agent.
 */
export function resolveCoordinator(agents: Agent[], coordinator?: string): string | undefined {
  if (coordinator && agents.some((a) => a.name === coordinator)) return coordinator;
  return agents.find((a) => /^(lead|manager)$/i.test(a.name))?.name ?? agents[0]?.name;
}
/** Agents with the coordinator/lead first; the rest keep their existing order. */
export function agentsLeadFirst(agents: Agent[], coordinator?: string): Agent[] {
  const lead = resolveCoordinator(agents, coordinator);
  if (!lead) return agents;
  return [...agents].sort((a, b) => Number(b.name === lead) - Number(a.name === lead));
}

/** An agent tagged with the team it belongs to (used by the holistic all-teams view). */
export type TeamAgent = Agent & { team?: string };
export type TeamEvent = ManagerEvent & { team?: string };

export interface FleetStore {
  connection: Connection;
  managerUrl: string;
  team?: string;
  coordinator?: string;
  agents: Agent[];
  teams: Team[];
  events: ManagerEvent[];
  inbox: InboxItem[];
  chatUnread: number;
  lastError?: string;
  lastUpdated?: number;
  /** Holistic mode (default): the Dashboard + status bar show every team's fleet at once. */
  viewAll: boolean;
  /** All agents across every team (each tagged with `.team`); populated only while viewAll. */
  allAgents: TeamAgent[];
  refresh: () => void;
  refreshChatUnread: () => Promise<void>;
  setTeam: (team: string) => Promise<void>;
}

const EVENT_BUFFER = 1000;
const SNAPSHOT_POLL_MS = 5000;
const ALL_TEAMS_POLL_MS = 15000;
const HIDDEN_POLL_MS = 30000;
const EVENT_VIEW_REFRESH_MIN_MS = 5000;
const EVENT_STREAM_BACKPRESSURE_MS = 750;
const EVENT_STREAM_IDLE_BACKOFF_MS = 1000;
const EVENT_CURSOR_STORAGE_PREFIX = 'idacc:event-cursor:';
const VIEW_INVALIDATING_EVENT_PREFIXES = ['agent:', 'checkin:', 'goal:', 'learn:', 'schedule:', 'task:', 'team:'];

function fleetSnapshotSig(input: {
  info: { managerUrl: string; team?: string; coordinator?: string };
  agents: Agent[];
  teams: Team[];
  inbox: InboxItem[];
  chatUnread: number;
}): string {
  return JSON.stringify({
    info: input.info,
    chatUnread: input.chatUnread,
    agents: input.agents.map((a) => [
      a.id,
      a.name,
      a.status,
      a.health,
      a.pid ?? a.metadata?.pid ?? null,
      a.model ?? '',
      a.runtime ?? '',
    ]),
    teams: input.teams.map((t) => [t.id ?? '', t.name]),
    inbox: input.inbox.map((i) => [i.query_id, i.status ?? '', i.timestamp ?? 0]),
  });
}

function allAgentsSig(groups: Array<{ team: string; agents: Agent[] }>): string {
  return JSON.stringify(groups.map((g) => [
    g.team,
    g.agents.map((a) => [
      a.id,
      a.name,
      a.status,
      a.health,
      a.pid ?? a.metadata?.pid ?? null,
      a.model ?? '',
      a.runtime ?? '',
    ]),
  ]));
}

function eventsInvalidateViews(events: ManagerEvent[]): boolean {
  return events.some((event) => VIEW_INVALIDATING_EVENT_PREFIXES.some((prefix) => event.topic.startsWith(prefix)));
}

function fleetPollDelay(baseMs: number): number {
  return typeof document !== 'undefined' && document.hidden ? Math.max(baseMs, HIDDEN_POLL_MS) : baseMs;
}

function viewNeedsAllTeamsAgents(view?: string): boolean {
  return !view || ['dashboard', 'tasks', 'schedule', 'teams', 'health', 'modules', 'projects', 'identity', 'computer'].includes(view);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventCursorKey(team?: string): string {
  return `${EVENT_CURSOR_STORAGE_PREFIX}${team || 'default'}`;
}

function readStoredEventCursor(team?: string): number {
  try {
    const raw = localStorage.getItem(eventCursorKey(team));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStoredEventCursor(team: string | undefined, seq: number): void {
  if (!Number.isFinite(seq) || seq <= 0) return;
  try { localStorage.setItem(eventCursorKey(team), String(Math.floor(seq))); } catch { /* storage unavailable */ }
}

export function useFleet(activeView?: string): FleetStore {
  const [connection, setConnection] = useState<Connection>('connecting');
  // Fires once per offline→online transition so we re-push persisted settings
  // (e.g. local-model concurrency) to the manager on connect AND after a restart.
  const wasOnlineRef = useRef(false);
  const [managerUrl, setManagerUrl] = useState('');
  const [team, setTeamState] = useState<string | undefined>(undefined);
  const [coordinator, setCoordinatorState] = useState<string | undefined>(undefined);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [events, setEvents] = useState<ManagerEvent[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [lastError, setLastError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<number>();
  // Holistic "all teams" is now ALWAYS ON, app-wide — there is no per-team view toggle.
  // (store.team still tracks the manager's active team for the few lead-scoped actions.)
  const viewAll = true;
  const [allAgents, setAllAgents] = useState<TeamAgent[]>([]);
  const [tick, setTick] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotSigRef = useRef('');
  const allAgentsSigRef = useRef('');
  const lastEventViewRefreshRef = useRef(0);
  const [streamEpoch, setStreamEpoch] = useState(0); // bumped ONLY on team change → never resets the event cursor on a plain refresh
  const epoch = useRef(0); // bump on team change to reset the event cursor loop
  const teamRef = useRef<string | undefined>(undefined);
  const needsAllTeamsAgents = viewNeedsAllTeamsAgents(activeView);
  useEffect(() => { teamRef.current = team; }, [team]);

  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setLastUpdated(Date.now());
      setTick((t) => t + 1);
    }, 100);
  }, []);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);
  // Cheap, targeted badge refresh — re-reads ONLY the unread count, without
  // restarting the snapshot/event-stream poll loops (a plain refresh() would).
  const refreshChatUnread = useCallback(async () => {
    const cu = await call<number>('chats:unreadCount', teamRef.current).catch(() => 0);
    setChatUnread(typeof cu === 'number' ? cu : 0);
  }, []);

  const setTeam = useCallback(async (t: string) => {
    const i = await call<{ team?: string; coordinator?: string }>('setTeam', t);
    setTeamState(i.team);
    setCoordinatorState(i.coordinator ?? undefined);
    setEvents([]);
    setAgents([]);
    epoch.current += 1;
    setStreamEpoch((e) => e + 1); // restart the event cursor for the new team
    refresh();
  }, [refresh]);

  // Snapshot poll.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [info, ag, tm, ib] = await Promise.all([
          call<{ managerUrl: string; team?: string; coordinator?: string }>('info'),
          call<Agent[]>('agents'),
          call<Team[]>('teams'),
          call<InboxItem[]>('inboxPending').catch(() => [] as InboxItem[]),
        ]);
        if (!alive) return;
        const cu = await call<number>('chats:unreadCount', info.team).catch(() => 0);
        if (!alive) return;
        const nextSig = fleetSnapshotSig({
          info,
          agents: ag,
          teams: tm,
          inbox: ib,
          chatUnread: typeof cu === 'number' ? cu : 0,
        });
        if (nextSig !== snapshotSigRef.current) {
          snapshotSigRef.current = nextSig;
          setManagerUrl(info.managerUrl);
          setTeamState(info.team);
          setCoordinatorState(info.coordinator ?? undefined);
          setAgents(ag);
          setTeams(tm);
          setInbox(ib);
          setChatUnread(typeof cu === 'number' ? cu : 0);
          setLastUpdated(Date.now());
        }
        setConnection('online');
        setLastError(undefined);
        // On (re)connect — including after a manager restart — re-apply persisted
        // settings the manager doesn't keep itself (local-model concurrency).
        if (!wasOnlineRef.current) {
          wasOnlineRef.current = true;
          void call('manager:applyStoredConcurrency').catch(() => {});
        }
      } catch (err) {
        if (!alive) return;
        setConnection('offline');
        wasOnlineRef.current = false; // re-arm so the next reconnect re-applies settings
        setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) timer = setTimeout(poll, fleetPollDelay(SNAPSHOT_POLL_MS));
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tick]);

  // Event-stream cursor loop.
  useEffect(() => {
    let alive = true;
    let since = readStoredEventCursor(teamRef.current);
    const myEpoch = epoch.current;
    const loop = async () => {
      if (!since) {
        try {
          const tail = await call<{ next_seq: number }>('events:tail');
          if (!alive || epoch.current !== myEpoch) return;
          since = Number(tail.next_seq) || 0;
          writeStoredEventCursor(teamRef.current, since);
        } catch {
          since = readStoredEventCursor(teamRef.current);
        }
      }
      while (alive && epoch.current === myEpoch) {
        try {
          const resp = await call<{ events: ManagerEvent[]; next_seq: number }>('events', since);
          if (!alive) return;
          const hadEvents = !!resp.events?.length;
          if (hadEvents) {
            // Stamp each event with its REAL wall-clock time (`occurred_at`, epoch
            // ms from the manager) so the activity feed shows correct ages — and
            // they survive a reconnect/replay (e.g. after an app update + restart,
            // when the whole backlog is re-fetched). Fall back to now() only if an
            // event truly carries no time (older managers).
            const batch = resp.events.map((e) => ({ ...e, timestamp: e.timestamp ?? e.occurred_at ?? Date.now() }));
            setEvents((prev) => [...prev, ...batch].slice(-EVENT_BUFFER));
            const now = Date.now();
            if (eventsInvalidateViews(resp.events) && now - lastEventViewRefreshRef.current >= EVENT_VIEW_REFRESH_MIN_MS) {
              lastEventViewRefreshRef.current = now;
              setLastUpdated(now);
            }
          }
          const nextSeq = Number(resp.next_seq) || since;
          since = Math.max(since, nextSeq);
          writeStoredEventCursor(teamRef.current, since);
          await sleep(fleetPollDelay(hadEvents ? EVENT_STREAM_BACKPRESSURE_MS : EVENT_STREAM_IDLE_BACKOFF_MS));
        } catch {
          await sleep(3000);
        }
      }
    };
    loop();
    return () => {
      alive = false;
    };
    // Depends on streamEpoch (team change) only — a plain refresh() must NOT
    // restart this loop, or it would reset the cursor to 0 and replay history.
  }, [streamEpoch]);

  // Holistic aggregate (always on): fetch every team's agents (each tagged with its team) so the
  // fleet grid + Dashboard + Work board + status bar always show all teams at once.
  useEffect(() => {
    if (!needsAllTeamsAgents) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const groups = await call<{ team: string; agents: Agent[] }[]>('agents:allTeams').catch(() => []);
        if (!alive) return;
        const nextSig = allAgentsSig(groups);
        if (nextSig !== allAgentsSigRef.current) {
          allAgentsSigRef.current = nextSig;
          setAllAgents(groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team }))));
        }
      } catch { /* keep last */ }
      finally { if (alive) timer = setTimeout(load, fleetPollDelay(ALL_TEAMS_POLL_MS)); }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [tick, needsAllTeamsAgents]);

  return { connection, managerUrl, team, coordinator, agents, teams, events, inbox, chatUnread, lastError, lastUpdated, viewAll, allAgents, refresh, refreshChatUnread, setTeam };
}
