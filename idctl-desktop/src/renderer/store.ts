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
let transportStoreEventsAvailable = false;
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
  transportStoreEventsAvailable = Boolean(api?.onStoreChange);
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
  if (domains.length && !transportStoreEventsAvailable) emitStoreChange({ method, domains, at: Date.now() });
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

type AppRuntimeStatus = { phase?: 'running' | 'quiescing' | 'cleanup-failed' | 'finalizing' };

const EVENT_BUFFER = 1000;
const SNAPSHOT_POLL_MS = 5000;
const SNAPSHOT_FAILURES_BEFORE_OFFLINE = 2;
const ALL_TEAMS_PRIMARY_POLL_MS = 15000;
const ALL_TEAMS_SECONDARY_POLL_MS = 60000;
const ALL_TEAMS_HIDDEN_POLL_MS = 120000;
const HIDDEN_POLL_MS = 30000;
const EVENT_VIEW_REFRESH_MIN_MS = 5000;
const EVENT_STREAM_BACKPRESSURE_MS = 750;
const EVENT_STREAM_IDLE_BACKOFF_MS = 1000;
// Keep reading/writing the original team-scoped numeric key so upgrades and
// downgrades retain a useful cursor. New builds additionally bind that team
// label to the Manager's profile-owned stream id and persist each stream
// independently, preventing two profiles with a team named "default" from
// overwriting one another.
const EVENT_CURSOR_STORAGE_PREFIX = 'idacc:event-cursor:';
const EVENT_STREAM_CURSOR_STORAGE_PREFIX = 'idacc:event-cursor:stream:';
const EVENT_STREAM_BINDING_STORAGE_PREFIX = 'idacc:event-stream:';
const VIEW_INVALIDATING_EVENT_PREFIXES = ['agent:', 'checkin:', 'goal:', 'learn:', 'schedule:', 'task:', 'team:'];
const VIEW_EVENT_PREFIXES: Record<string, string[]> = {
  dashboard: VIEW_INVALIDATING_EVENT_PREFIXES,
  tasks: ['agent:', 'goal:', 'learn:', 'schedule:', 'task:', 'team:'],
  schedule: ['agent:', 'schedule:', 'task:', 'team:'],
  teams: ['agent:', 'checkin:', 'team:'],
  health: ['agent:', 'checkin:', 'team:'],
  modules: ['agent:', 'team:'],
  projects: ['agent:', 'task:', 'team:'],
  identity: ['agent:', 'team:'],
  computer: ['agent:', 'team:'],
  inbox: [],
  settings: [],
};

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

export function eventsInvalidateViews(events: ManagerEvent[], activeView?: string): boolean {
  const prefixes = VIEW_EVENT_PREFIXES[activeView || ''] ?? VIEW_INVALIDATING_EVENT_PREFIXES;
  if (!prefixes.length) return false;
  return events.some((event) => prefixes.some((prefix) => event.topic.startsWith(prefix)));
}

function fleetPollDelay(baseMs: number): number {
  return typeof document !== 'undefined' && document.hidden ? Math.max(baseMs, HIDDEN_POLL_MS) : baseMs;
}

export function viewNeedsAllTeamsAgents(view?: string): boolean {
  return !view || ['dashboard', 'tasks', 'schedule', 'teams', 'health', 'modules', 'projects', 'identity', 'computer'].includes(view);
}

export function allTeamsAgentsPollDelay(view?: string): number {
  const primary = !view || ['dashboard', 'tasks', 'schedule'].includes(view);
  const base = primary ? ALL_TEAMS_PRIMARY_POLL_MS : ALL_TEAMS_SECONDARY_POLL_MS;
  return typeof document !== 'undefined' && document.hidden ? Math.max(base, ALL_TEAMS_HIDDEN_POLL_MS) : base;
}

export function snapshotConnectionAfterFailure(consecutiveFailures: number): Connection {
  return consecutiveFailures >= SNAPSHOT_FAILURES_BEFORE_OFFLINE ? 'offline' : 'connecting';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventCursorKey(team?: string): string {
  return `${EVENT_CURSOR_STORAGE_PREFIX}${team || 'default'}`;
}

type EventCursorStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type EventStreamCursor = {
  seq: number;
  streamId?: string;
};

export type EventCursorResponse = {
  next_seq: number;
  stream_id?: string;
  cursor_reset?: boolean;
};

export type EventCursorReconciliation = {
  cursor: EventStreamCursor;
  /** False means the response was only a stream/reset handshake and its event
   * batch must not be rendered; the next request starts at `cursor.seq`. */
  acceptEvents: boolean;
  /** A changed/reset stream invalidates activity already rendered from the
   * previous log, so the caller must clear its in-memory event buffer. */
  clearEvents: boolean;
};

export function eventLoopEpochIsCurrent(
  alive: boolean,
  currentEpoch: number,
  requestEpoch: number,
): boolean {
  return alive && currentEpoch === requestEpoch;
}

function cursorStorage(storage?: EventCursorStorage): EventCursorStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function eventStreamBindingKey(team?: string): string {
  return `${EVENT_STREAM_BINDING_STORAGE_PREFIX}${encodeURIComponent(team || 'default')}`;
}

function eventStreamCursorKey(streamId: string): string {
  return `${EVENT_STREAM_CURSOR_STORAGE_PREFIX}${encodeURIComponent(streamId)}`;
}

function normalizedStreamId(value: unknown): string | undefined {
  const streamId = typeof value === 'string' ? value.trim() : '';
  return streamId || undefined;
}

function normalizedCursorSeq(value: unknown, fallback: number): number {
  const seq = Number(value);
  return Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : fallback;
}

function readCursorSeq(storage: EventCursorStorage | null, key: string): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw.trim() === '') return null;
    const seq = Number(raw);
    return Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : null;
  } catch {
    return null;
  }
}

function readBoundStreamId(team: string | undefined, storage: EventCursorStorage | null): string | undefined {
  if (!storage) return undefined;
  try {
    return normalizedStreamId(storage.getItem(eventStreamBindingKey(team)));
  } catch {
    return undefined;
  }
}

function readStoredEventCursor(team?: string, storageOverride?: EventCursorStorage): EventStreamCursor {
  const storage = cursorStorage(storageOverride);
  const streamId = readBoundStreamId(team, storage);
  const streamSeq = streamId ? readCursorSeq(storage, eventStreamCursorKey(streamId)) : null;
  const legacySeq = readCursorSeq(storage, eventCursorKey(team));
  return {
    seq: streamSeq ?? legacySeq ?? 0,
    ...(streamId ? { streamId } : {}),
  };
}

function writeStoredEventCursor(
  team: string | undefined,
  cursor: EventStreamCursor,
  storageOverride?: EventCursorStorage,
): void {
  const storage = cursorStorage(storageOverride);
  if (!storage || !Number.isFinite(cursor.seq) || cursor.seq < 0) return;
  const seq = String(Math.floor(cursor.seq));
  try {
    // The legacy key is intentionally replaced too. A reset to zero must not
    // leave an old numeric cursor waiting forever after a downgrade.
    storage.setItem(eventCursorKey(team), seq);
    if (cursor.streamId) {
      storage.setItem(eventStreamCursorKey(cursor.streamId), seq);
      storage.setItem(eventStreamBindingKey(team), cursor.streamId);
    }
  } catch {
    // Storage is an optimization; the live stream continues without it.
  }
}

/**
 * Resolve a persisted cursor only after the Manager identifies the active
 * stream. Exact stream cursors win. A legacy team-only cursor is migrated when
 * there is no contradictory stream binding; a newly-seen profile starts at
 * that stream's live tail.
 */
export function initializeEventStreamCursor(
  team: string | undefined,
  tail: EventCursorResponse,
  storageOverride?: EventCursorStorage,
): EventStreamCursor {
  const storage = cursorStorage(storageOverride);
  const streamId = normalizedStreamId(tail.stream_id);
  const tailSeq = normalizedCursorSeq(tail.next_seq, 0);
  if (!streamId) {
    const cursor = { seq: readCursorSeq(storage, eventCursorKey(team)) ?? tailSeq };
    writeStoredEventCursor(team, cursor, storageOverride);
    return cursor;
  }

  const exactStreamSeq = readCursorSeq(storage, eventStreamCursorKey(streamId));
  const boundStreamId = readBoundStreamId(team, storage);
  const legacySeq = readCursorSeq(storage, eventCursorKey(team));
  const canMigrateLegacy = !boundStreamId || boundStreamId === streamId;
  const cursor: EventStreamCursor = {
    seq: exactStreamSeq ?? (canMigrateLegacy ? legacySeq : null) ?? tailSeq,
    streamId,
  };
  writeStoredEventCursor(team, cursor, storageOverride);
  return cursor;
}

/**
 * Apply one Manager event response. Normal reads remain monotonic within a
 * stream. `cursor_reset` is authoritative and may move backwards, while a
 * stream change restores only that exact stream's cursor (or re-queries from
 * zero when it has never been seen).
 */
export function reconcileEventStreamCursor(
  team: string | undefined,
  current: EventStreamCursor,
  response: EventCursorResponse,
  storageOverride?: EventCursorStorage,
): EventCursorReconciliation {
  const storage = cursorStorage(storageOverride);
  const responseStreamId = normalizedStreamId(response.stream_id);
  const nextSeq = normalizedCursorSeq(response.next_seq, current.seq);

  if (responseStreamId && current.streamId && responseStreamId !== current.streamId) {
    const exactStreamSeq = readCursorSeq(storage, eventStreamCursorKey(responseStreamId));
    const cursor = {
      // A Manager reset always supersedes persisted state, including an exact
      // stream record. Otherwise resume the known stream or safely re-query it.
      seq: response.cursor_reset === true ? nextSeq : exactStreamSeq ?? 0,
      streamId: responseStreamId,
    };
    writeStoredEventCursor(team, cursor, storageOverride);
    return { cursor, acceptEvents: false, clearEvents: true };
  }

  const streamId = responseStreamId ?? current.streamId;
  const cursor: EventStreamCursor = {
    seq: response.cursor_reset === true ? nextSeq : Math.max(current.seq, nextSeq),
    ...(streamId ? { streamId } : {}),
  };
  writeStoredEventCursor(team, cursor, storageOverride);
  return {
    cursor,
    acceptEvents: response.cursor_reset !== true,
    clearEvents: response.cursor_reset === true,
  };
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
  const snapshotFailuresRef = useRef(0);
  const allAgentsSigRef = useRef('');
  const lastEventViewRefreshRef = useRef(0);
  const [streamEpoch, setStreamEpoch] = useState(0); // bumped ONLY on team change → never resets the event cursor on a plain refresh
  const epoch = useRef(0); // bump on team change to reset the event cursor loop
  const teamRef = useRef<string | undefined>(undefined);
  const activeViewRef = useRef(activeView);
  const needsAllTeamsAgents = viewNeedsAllTeamsAgents(activeView);
  useEffect(() => { teamRef.current = team; }, [team]);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);

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
        const lifecycle = await call<AppRuntimeStatus>('app:runtimeStatus').catch(() => ({ phase: 'running' }));
        if (!alive) return;
        if (lifecycle.phase && lifecycle.phase !== 'running') {
          snapshotFailuresRef.current = SNAPSHOT_FAILURES_BEFORE_OFFLINE;
          wasOnlineRef.current = false;
          setConnection('offline');
          setAgents([]);
          setAllAgents([]);
          setTeams([]);
          setInbox([]);
          setLastError('IDACC is shutting down; fleet data is no longer live.');
          return;
        }
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
        snapshotFailuresRef.current = 0;
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
        snapshotFailuresRef.current += 1;
        setConnection(snapshotConnectionAfterFailure(snapshotFailuresRef.current));
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
    const streamTeam = teamRef.current;
    let cursor = readStoredEventCursor(streamTeam);
    const myEpoch = epoch.current;
    const loop = async () => {
      // Resolve the Manager's profile-owned stream before trusting a persisted
      // team-name cursor. Older Managers omit stream_id and retain the legacy
      // numeric behavior.
      try {
        const tail = await call<EventCursorResponse>('events:tail');
        if (!alive || epoch.current !== myEpoch) return;
        cursor = initializeEventStreamCursor(streamTeam, tail);
      } catch {
        cursor = readStoredEventCursor(streamTeam);
      }
      while (alive && epoch.current === myEpoch) {
        try {
          const resp = await call<{ events: ManagerEvent[] } & EventCursorResponse>('events', cursor.seq);
          if (!eventLoopEpochIsCurrent(alive, epoch.current, myEpoch)) return;
          const reconciled = reconcileEventStreamCursor(streamTeam, cursor, resp);
          cursor = reconciled.cursor;
          if (reconciled.clearEvents) setEvents([]);
          const hadEvents = reconciled.acceptEvents && !!resp.events?.length;
          if (hadEvents) {
            // Stamp each event with its REAL wall-clock time (`occurred_at`, epoch
            // ms from the manager) so the activity feed shows correct ages — and
            // they survive a reconnect/replay (e.g. after an app update + restart,
            // when the whole backlog is re-fetched). Fall back to now() only if an
            // event truly carries no time (older managers).
            const batch = resp.events.map((e) => ({ ...e, timestamp: e.timestamp ?? e.occurred_at ?? Date.now() }));
            setEvents((prev) => [...prev, ...batch].slice(-EVENT_BUFFER));
            const now = Date.now();
            if (eventsInvalidateViews(resp.events, activeViewRef.current) && now - lastEventViewRefreshRef.current >= EVENT_VIEW_REFRESH_MIN_MS) {
              lastEventViewRefreshRef.current = now;
              setLastUpdated(now);
            }
          }
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

  // Holistic aggregate: fetch every team's agents (each tagged with its team) on
  // views that actually consume a cross-team roster. Heavy secondary views keep
  // the initial context but poll at a slower cadence; explicit mutations and
  // page-level force loads still refresh immediately when the operator acts.
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
      finally { if (alive) timer = setTimeout(load, allTeamsAgentsPollDelay(activeView)); }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [needsAllTeamsAgents, tick]);

  return { connection, managerUrl, team, coordinator, agents, teams, events, inbox, chatUnread, lastError, lastUpdated, viewAll, allAgents, refresh, refreshChatUnread, setTeam };
}
