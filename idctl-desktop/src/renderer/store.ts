/**
 * Renderer-side live store. Talks to the manager only through the IPC bridge
 * (window.idagents.call). Mirrors the TUI's polling/streaming loops: a 3s
 * snapshot poll (agents/teams/inbox) plus a long-poll event cursor.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Team, ManagerEvent, InboxItem } from '../../../idctl/src/api/types.ts';

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

/** Typed call over the active transport. Throws on the error envelope. */
export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!transport) throw new Error('no transport configured');
  const res = await transport(method, args);
  if (!res.ok) throw new Error(res.error || 'manager error');
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
  setCoordinator: (agent: string) => Promise<void>;
  setViewAll: (on: boolean) => void;
}

const EVENT_BUFFER = 1000;

export function useFleet(): FleetStore {
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
  // Holistic "all teams" view — DEFAULT ON. Persisted so it sticks across launches.
  const [viewAll, setViewAllState] = useState<boolean>(() => {
    try { return localStorage.getItem('idctl.viewAll') !== 'false'; } catch { return true; }
  });
  const [allAgents, setAllAgents] = useState<TeamAgent[]>([]);
  const setViewAll = useCallback((on: boolean) => {
    setViewAllState(on);
    try { localStorage.setItem('idctl.viewAll', String(on)); } catch { /* no storage */ }
  }, []);
  const [tick, setTick] = useState(0);
  const [streamEpoch, setStreamEpoch] = useState(0); // bumped ONLY on team change → never resets the event cursor on a plain refresh
  const epoch = useRef(0); // bump on team change to reset the event cursor loop
  const teamRef = useRef<string | undefined>(undefined);
  useEffect(() => { teamRef.current = team; }, [team]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
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

  const setCoordinator = useCallback(async (agent: string) => {
    await call('coordinator:set', team ?? 'default', agent);
    setCoordinatorState(agent);
  }, [team]);

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
        setManagerUrl(info.managerUrl);
        setTeamState(info.team);
        setCoordinatorState(info.coordinator ?? undefined);
        setAgents(ag);
        setTeams(tm);
        setInbox(ib);
        setConnection('online');
        setLastError(undefined);
        setLastUpdated(Date.now());
        // On (re)connect — including after a manager restart — re-apply persisted
        // settings the manager doesn't keep itself (local-model concurrency).
        if (!wasOnlineRef.current) {
          wasOnlineRef.current = true;
          void call('manager:applyStoredConcurrency').catch(() => {});
        }
        // Unviewed-chat count for the Chat nav badge (scoped to the active team).
        const cu = await call<number>('chats:unreadCount', info.team).catch(() => 0);
        if (alive) setChatUnread(typeof cu === 'number' ? cu : 0);
      } catch (err) {
        if (!alive) return;
        setConnection('offline');
        wasOnlineRef.current = false; // re-arm so the next reconnect re-applies settings
        setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) timer = setTimeout(poll, 3000);
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
    let since = 0;
    const myEpoch = epoch.current;
    const loop = async () => {
      while (alive && epoch.current === myEpoch) {
        try {
          const resp = await call<{ events: ManagerEvent[]; next_seq: number }>('events', since);
          if (!alive) return;
          if (resp.events?.length) {
            // Stamp each event with its REAL wall-clock time (`occurred_at`, epoch
            // ms from the manager) so the activity feed shows correct ages — and
            // they survive a reconnect/replay (e.g. after an app update + restart,
            // when the whole backlog is re-fetched). Fall back to now() only if an
            // event truly carries no time (older managers).
            const batch = resp.events.map((e) => ({ ...e, timestamp: e.timestamp ?? e.occurred_at ?? Date.now() }));
            setEvents((prev) => [...prev, ...batch].slice(-EVENT_BUFFER));
          }
          since = resp.next_seq ?? since;
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
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

  // Holistic aggregate: while viewAll, fetch every team's agents (each tagged with its team)
  // so the fleet grid + status bar can show all teams at once. Cleared when off.
  useEffect(() => {
    if (!viewAll) { setAllAgents([]); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const groups = await call<{ team: string; agents: Agent[] }[]>('agents:allTeams').catch(() => []);
        if (!alive) return;
        setAllAgents(groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team }))));
      } catch { /* keep last */ }
      finally { if (alive) timer = setTimeout(load, 3000); }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [viewAll, tick]);

  return { connection, managerUrl, team, coordinator, agents, teams, events, inbox, chatUnread, lastError, lastUpdated, viewAll, allAgents, refresh, refreshChatUnread, setTeam, setCoordinator, setViewAll };
}
