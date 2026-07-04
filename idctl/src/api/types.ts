/**
 * Wire types for the id-agents manager daemon (:4100).
 *
 * These mirror the shapes the manager actually returns (cross-checked against
 * id-agents/src/tui/api/types.ts and the live daemon). Fields are kept optional
 * where the daemon may omit them across runtimes (claude-code-cli, codex,
 * cursor-cli, public-agent-remote).
 */

export interface AgentPluginMetadata {
  name?: string;
  path?: string;
}

export interface AgentMcpServerMetadata {
  name?: string;
  transport?: string;
  command?: string;
  url?: string;
}

export interface AgentMetadata {
  runtime?: string;
  description?: string;
  heartbeat?: boolean;
  pid?: number;
  skills?: string[];
  plugins?: Array<AgentPluginMetadata | string>;
  mcpServers?: AgentMcpServerMetadata[];
  delegates?: string[];
  instructions?: string;
  runtimeCredentialLane?: string;
  runtimeRateLimit?: {
    laneId?: string;
    coolingUntilMs?: number;
    reason?: string;
    observedAtMs?: number;
    queryId?: string;
    resetText?: string;
    message?: string;
  };
  runtimeRateLimitFailover?: {
    fromLaneId?: string;
    toLaneId?: string;
    queryId?: string;
    observedAtMs?: number;
  };
  provider_wallet_address?: string;
  providerWalletAddress?: string;
  providers?: Record<string, unknown>;
  skillmesh_address?: string;
  skillmesh_key_index?: number;
  skillmesh_key_path?: string;
  ows_wallet?: string;
  ows_address?: string;
  wallet?: boolean;
  idchain_domain?: string;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  alias?: string;
  port: number;
  status: string;
  health?: string;
  model?: string;
  type?: string;
  runtime?: string;
  url?: string;
  workingDirectory?: string;
  createdAt: number;
  lastHealthCheck?: number;
  metadata?: AgentMetadata;
  teamName?: string;
  deploymentShape?: 'local-process' | 'remote-endpoint';
  pid?: number | null;
  customer_domain?: string | null;
  public_endpoint_url?: string | null;
  ows_wallet?: string | null;
  ows_address?: string | null;
  idchain_domain?: string | null;
  ssh_target?: string | null;
  last_seen?: number | null;
  last_probed_at?: number | null;
  last_error?: string | null;
  consecutive_failures?: number;
}

export interface Team {
  id: string;
  name: string;
  agentCount: number;
  createdAt?: string;
}

export interface ManagerEvent {
  seq: number;
  team?: string;
  topic: string;
  actor?: string;
  subject?: string;
  data?: Record<string, unknown>;
  /** Client-stamped arrival time (legacy). */
  timestamp?: number;
  /** Wall-clock time the event actually occurred (epoch ms), from the manager.
   *  Preferred over `timestamp` so ages stay correct across reconnects/replays. */
  occurred_at?: number;
}

export interface EventsResponse {
  events: ManagerEvent[];
  next_seq: number;
  replay_truncated?: boolean;
  earliest_available_seq?: number | null;
}

/** One live "what the agent is doing" step (tool call / file edit), streamed
 *  by agents to the manager's in-memory activity ring. */
export interface ActivityStep {
  seq: number;
  at: number;
  agent: string;
  team: string;
  kind: string;      // file | read | run | search | web | delegate | plan | tool | error
  tool?: string;
  summary: string;
  /** Originating dispatch id, when the agent reported one. Lets a caller
   *  attribute steps to an exact query (e.g. two dispatches to one agent). */
  queryId?: string;
}
export interface ActivityResponse {
  items: ActivityStep[];
  next_seq: number;
}

export interface Task {
  name?: string;
  uuid?: string;
  shortId?: string;
  title: string;
  description?: string | null;
  status: string;
  ownerName?: string | null;
  teamName?: string;
  linkedEvents?: string[];
  createdAt: number;
  updatedAt?: number;
  completedAt?: number | null;
  delegationAudit?: {
    status?: 'ok' | 'pending-delegation' | 'needs-delegation' | string;
    ownerRole?: string;
    reason?: string;
    ageSeconds?: number;
    graceSeconds?: number;
    childTaskRefs?: string[];
    [key: string]: unknown;
  } | null;
}

/** A query awaiting a human/manager answer (manager inbox). */
export interface InboxItem {
  query_id: string;
  prompt?: string | null;
  message: string;
  timestamp: number;
  status: string;
  session_id?: string | null;
  from?: string | null;
  reply_endpoint?: string | null;
  schedule?: Record<string, unknown> | null;
  mode?: string | null;
}

export interface NewsItem {
  id?: number;
  type: string;
  timestamp: number;
  message?: string;
  in_reply_to?: string;
  query_id?: string;
  data?: Record<string, unknown>;
}

/** External query lifecycle vocabulary returned by GET /query/:id. */
export type QueryStatus =
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface QueryResult {
  status: QueryStatus;
  result?: { result?: string; message?: string } | string;
  error?: string;
  agent?: string;
}

export interface ActiveAgentQueries {
  team?: string;
  agent?: { id?: string; name?: string; status?: string };
  count: number;
  queries: Array<{
    query_id: string;
    status: QueryStatus | string;
    created: number;
    age_ms?: number;
    prompt_preview?: string;
  }>;
}

export interface ProbeResult {
  team: string;
  probed: number;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    status: 'ok' | 'failed' | string;
    error?: string;
    duration_ms?: number;
  }>;
}

/** Standard envelope for /remote and most management endpoints. */
export interface RemoteEnvelope<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}
