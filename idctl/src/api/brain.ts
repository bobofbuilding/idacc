// SPDX-License-Identifier: MIT
/**
 * BrainClient — the Control Center's typed channel to the self-learning brain.
 *
 * Until now the CC had exactly ONE brain write (orgSync.writeOrgToBrain — an inline fetch).
 * This generalizes that precedent so EVERY operator control action can be recorded to the
 * brain: an audit event on the timeline, structured facts, entities, ingested text, or keyed
 * shared memory. It is the app-side half of "everything updated in the self-learning brain"
 * (Phase 1): config/control mutations that never touch the manager (and so are invisible to
 * the manager→brain event stream) are mirrored through the manager's acknowledged relay.
 *
 * EVERY write is best-effort: short timeout, errors swallowed, never throws. The brain is an
 * observer — a brain hiccup must never block, slow, or fail a control action. Callers should
 * `void brain.control(...)` (fire-and-forget) right after their own state write succeeds.
 *
 * Endpoint shapes verified against the live brain (brain-listener.mjs / brain-client.mjs):
 *   POST /timeline           { source, type, subject, data, tags }
 *   POST /entities           { id, type, name, source, status, tags, data, exactId?, mergeAliases? }
 *   POST /facts/bulk         { facts: [{ entity_id, field, value, source }] }
 *   POST /text-units/ingest  { source_kind, source_id, title, content, metadata, process_config }
 *   POST /memory/:agentId    { key, content, tags, shared?, project? }
 *   GET  /memory/:agentId/:key        -> { memory: { content } }
 *   GET  /memory/shared?tag=&project= -> { memories: [{ content, id, agent_id, mem_key }] }
 */

const DEFAULT_URL = process.env.BRAIN_URL || 'http://127.0.0.1:4200';
const DEFAULT_TOKEN = process.env.BRAIN_TOKEN || '';
const DEFAULT_SOURCE = 'control-center';
const DEFAULT_TIMEOUT_MS = 2500;

/** Field names whose values are secrets and must NEVER be sent to the brain. */
const SECRET_KEYS = /^(api[-_]?key|token|secret|password|passwd|authorization|auth|bearer|private[-_]?key)$/i;

/** Deep-clone a value with any secret-named fields redacted. Caps depth/size so a huge
 *  settings blob can't bloat a timeline row. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? (v ? '«redacted»' : v) : redactSecrets(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

export interface TimelineEvent {
  type: string;
  subject?: string;
  data?: Record<string, unknown>;
  tags?: string[];
  source?: string;
}
export interface BrainEntity {
  id: string;
  type: string;
  name?: string;
  status?: string;
  tags?: string[];
  data?: Record<string, unknown>;
  source?: string;
  exactId?: boolean;
  mergeAliases?: boolean;
}
export interface BrainFact {
  entity_id: string;
  field: string;
  value: unknown;
  source?: string;
}
export interface BrainEntityEdge {
  from: string;
  to: string;
  kind: string;
  weight?: number;
  description?: string;
  textUnitIds?: number[];
}
export interface BrainEntityEdgeResult {
  ok: boolean;
  count: number;
  expected: number;
}
export interface BrainSkillNode {
  skillId: number;
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  computeCost?: number;
  chainable?: boolean;
}
export interface BrainSkillIndex {
  q?: string;
  domain?: string | null;
  tag?: string | null;
  sort?: string;
  total?: number;
  counts?: {
    total?: number;
    chainable?: number;
    nonChainable?: number;
    byDomain?: Record<string, number>;
    byTag?: Record<string, number>;
  };
  summary?: {
    totalSkills?: number;
    chainable?: number;
    nonChainable?: number;
    domains?: number;
    tags?: number;
    averageComputeCost?: number | null;
    maxUseCount?: number;
  };
  facets?: {
    domains?: unknown[];
    tags?: unknown[];
    chainable?: unknown[];
  };
  reuseGroups?: unknown[];
  topNodes?: unknown[];
  nodes?: unknown[];
  searchHints?: unknown[];
  reuseSuggestions?: unknown[];
  proposalSummary?: Record<string, unknown>;
  proposalGaps?: unknown[];
  profile?: string;
  meta?: { route?: string; profile?: string; generatedAt?: string; cacheControl?: string | null; noStore?: boolean };
}
export interface BrainFleetReport {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  fleet?: {
    source?: string;
    total?: number;
    running?: number;
    authority?: string;
    authoritative?: boolean;
    activeLabel?: string;
    statusAuthorityLabel?: string;
    managerUrl?: string;
    teamSource?: string;
    warnings?: string[];
    agents?: BrainFleetAgent[];
    cacheDrift?: {
      status?: string;
      liveTotal?: number | null;
      cachedTotal?: number | null;
      delta?: number | null;
    };
  };
}
export interface BrainFleetAgent {
  id?: string;
  name?: string;
  team?: string;
  status?: string;
  runtime?: string;
  model?: string;
  source?: string;
}
export interface BrainGraphReport {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  graph?: {
    nodeCount?: number;
    linkCount?: number;
    directNodeCount?: number;
    directLinkCount?: number;
    defaultIncludesNeighbors?: boolean;
    neighborsParamHonored?: boolean;
    sourceAuthority?: string;
    sourceAuthorityLabel?: string;
    identityBridgeCount?: number;
    warnings?: string[];
  };
}
export interface BrainCoreHealthReport {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  ok?: boolean;
  nodes?: number;
  edges?: number;
  memories?: number;
  entities?: number;
  timelineEvents?: number;
  facts?: number;
  fts?: boolean;
  sqliteVec?: {
    available?: boolean;
    degraded?: boolean;
    state?: string;
    dimensions?: number;
    extension?: string;
    fallback?: string;
    error?: string | null;
  };
  routeInventory?: {
    skew?: boolean;
    missing?: string[];
    count?: number;
    routes?: string[];
  };
  warnings?: string[];
}
export interface BrainControllerLink {
  id?: number;
  controller_id?: string;
  controllerId?: string;
  agent_id?: string;
  agentId?: string;
  role?: string;
  authority_level?: string;
  authorityLevel?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}
export interface BrainController {
  controller_id?: string;
  controllerId?: string;
  scope_user_id?: string;
  type?: string;
  label?: string;
  name?: string;
  primary_wallet?: string;
  primaryWallet?: string;
  status?: string;
  agent_links?: BrainControllerLink[];
  agentLinks?: BrainControllerLink[];
}
export interface BrainControllerReport {
  generatedAt?: string;
  route?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  total?: number;
  activeLinks?: number;
  controllers?: BrainController[];
  warnings?: string[];
}
export interface BrainAgentsReport {
  generatedAt?: string;
  route?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  total?: number;
  running?: number;
  source?: string;
  authority?: string;
  authoritative?: boolean;
  statusAuthorityLabel?: string;
  duplicateNames?: string[];
  controllerTotal?: number;
  activeControllerLinks?: number;
  scopedControllerMatches?: number;
  bareControllerMatches?: number;
  ambiguousBareControllerLinks?: number;
  unlinkedAgents?: number;
  slaFetchLimit?: number;
  slaOmitted?: number;
  cacheDrift?: {
    status?: string;
    liveTotal?: number | null;
    cachedTotal?: number | null;
    delta?: number | null;
  };
  warnings?: string[];
}
export interface SharedMemory {
  content?: string;
  id?: number;
  agent_id?: string;
  mem_key?: string;
}

export interface BrainClientOptions {
  url?: string;
  token?: string;
  source?: string;
  timeoutMs?: number;
  transport?: BrainTransport;
}

export type BrainResponse<T> = {
  body: T | null;
  cacheControl: string | null;
  noStore: boolean;
};

export interface BrainTransportRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  idempotency_key?: string;
  timeoutMs: number;
}

export type BrainTransport = (request: BrainTransportRequest) => Promise<BrainResponse<unknown>>;

let brainRequestSequence = 0;

function nextBrainIdempotencyKey(): string {
  brainRequestSequence = (brainRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `idacc:${Date.now().toString(36)}:${brainRequestSequence.toString(36)}`;
}

export class BrainClient {
  readonly url: string;
  private readonly token: string;
  private readonly source: string;
  private readonly timeoutMs: number;
  private transport?: BrainTransport;

  constructor(opts: BrainClientOptions = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/+$/, '');
    this.token = opts.token ?? DEFAULT_TOKEN;
    this.source = opts.source || DEFAULT_SOURCE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = opts.transport;
  }

  /** Route all Brain traffic through an owning process such as the id-agents manager. */
  setTransport(transport: BrainTransport | undefined): void {
    this.transport = transport;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** Best-effort request with response-header metadata. Never throws. */
  private async reqWithMeta<T = unknown>(method: string, path: string, body?: unknown): Promise<BrainResponse<T>> {
    if (this.transport) {
      const idempotencyKey = method === 'POST' ? nextBrainIdempotencyKey() : undefined;
      for (let attempt = 0; attempt < (method === 'POST' ? 2 : 1); attempt++) {
        try {
          return await this.transport({
            method: method as 'GET' | 'POST',
            path,
            ...(body === undefined ? {} : { body }),
            ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
            timeoutMs: this.timeoutMs,
          }) as BrainResponse<T>;
        } catch {
          if (attempt === 0 && method === 'POST') await new Promise((resolve) => setTimeout(resolve, 125));
        }
      }
      return { body: null, cacheControl: null, noStore: false };
    }
    try {
      const r = await fetch(`${this.url}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const cacheControl = r.headers.get('cache-control');
      const noStore = cacheControl?.toLowerCase().split(',').map((part) => part.trim()).includes('no-store') ?? false;
      if (!r.ok) return { body: null, cacheControl, noStore };
      const text = await r.text();
      if (!text) return { body: null, cacheControl, noStore };
      try { return { body: JSON.parse(text) as T, cacheControl, noStore }; } catch { return { body: null, cacheControl, noStore }; }
    } catch {
      return { body: null, cacheControl: null, noStore: false };
    }
  }

  /** Best-effort request. Returns the parsed body on 2xx, else null. Never throws. */
  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    return (await this.reqWithMeta<T>(method, path, body)).body;
  }

  /** Typed escape hatch for manager-allowlisted Brain routes not yet modeled above. */
  async route<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    return this.req<T>(method, path, body);
  }

  private noStoreWarnings(route: string, response: BrainResponse<unknown>): string[] {
    if (!response.body || response.noStore) return [];
    const received = response.cacheControl ? ` (received ${response.cacheControl})` : '';
    return [`Brain ${route} response is missing Cache-Control: no-store${received}; restart/redeploy Brain before trusting dashboard freshness.`];
  }

  /** Record an event on the brain's timeline (the universal audit channel). */
  async timeline(ev: TimelineEvent): Promise<boolean> {
    const r = await this.req('POST', '/timeline', {
      source: ev.source || this.source,
      type: ev.type,
      subject: ev.subject ?? '',
      data: ev.data ?? {},
      tags: ev.tags ?? [],
    });
    return r !== null;
  }

  /** Upsert a brain entity (e.g. a project node). */
  async entity(e: BrainEntity): Promise<boolean> {
    const r = await this.req('POST', '/entities', {
      id: e.id,
      type: e.type,
      name: e.name ?? e.id,
      source: e.source || this.source,
      status: e.status ?? '',
      tags: e.tags ?? [],
      data: e.data ?? {},
      exactId: e.exactId,
      mergeAliases: e.mergeAliases,
    });
    return r !== null;
  }

  /** Write structured facts (entity_id/field/value triples). Posts /facts/bulk. */
  async facts(facts: BrainFact[]): Promise<boolean> {
    const filtered = facts
      .filter((f) => f.entity_id && f.field && f.value !== undefined)
      .map((f) => ({ entity_id: f.entity_id, field: f.field, value: f.value, source: f.source || this.source }));
    if (!filtered.length) return false;
    const r = await this.req('POST', '/facts/bulk', { facts: filtered });
    return r !== null;
  }

  /** Upsert entity graph edges with the count Brain accepted. */
  async entityEdgesDetailed(edges: BrainEntityEdge[]): Promise<BrainEntityEdgeResult> {
    const filtered = edges
      .filter((e) => e.from && e.to && e.kind)
      .map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        weight: e.weight ?? 1,
        description: e.description ?? '',
        textUnitIds: e.textUnitIds ?? [],
      }));
    if (!filtered.length) return { ok: true, count: 0, expected: 0 };
    const r = await this.req<{ ok?: boolean; count?: number }>('POST', '/entity-edges/bulk', { edges: filtered });
    const count = Number(r?.count ?? 0) || 0;
    return {
      ok: !!r && r.ok !== false && count >= filtered.length,
      count,
      expected: filtered.length,
    };
  }

  /** Upsert entity graph edges so app-side records appear connected in Brain Graph. */
  async entityEdges(edges: BrainEntityEdge[]): Promise<boolean> {
    return (await this.entityEdgesDetailed(edges)).ok;
  }

  /** Ingest a markdown/text artifact (dreams, plan bodies) so the brain chunks + learns it. */
  async ingestText(input: {
    sourceKind: string;
    sourceId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!input.content?.trim()) return false;
    const r = await this.req('POST', '/text-units/ingest', {
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      title: input.title,
      content: input.content,
      metadata: input.metadata ?? {},
      process_config: { strategy: 'heuristic', chunk_size: 3000, chunk_overlap: 250 },
    });
    return r !== null;
  }

  /** Additively upsert skill catalog rows into the brain's skill graph. */
  async syncSkillNodes(nodes: BrainSkillNode[]): Promise<{ ok?: boolean; count?: number } | null> {
    const clean = nodes.filter((node) => Number.isInteger(node.skillId) && !!node.name?.trim());
    if (!clean.length) return { ok: true, count: 0 };
    return this.req('POST', '/graph/nodes/bulk', { nodes: clean });
  }

  /** Read the brain's skill index summary for catalog freshness/status UI. */
  async skillIndex(): Promise<BrainSkillIndex | null> {
    const response = await this.reqWithMeta<{
      data?: BrainSkillIndex;
      meta?: BrainSkillIndex['meta'];
      profile?: string;
    }>('GET', '/skills/index?limit=1&sort=popular');
    const r = response.body;
    if (!r?.data) return null;
    const profile = r.data.profile ?? r.meta?.profile ?? r.profile;
    return {
      ...r.data,
      ...(profile ? { profile } : {}),
      meta: {
        ...(r.data.meta ?? {}),
        ...(r.meta ?? {}),
        ...(profile ? { profile } : {}),
        cacheControl: response.cacheControl,
        noStore: response.noStore,
      },
    };
  }

  /** Read live fleet authority/status contract used by Brain dashboard Fleet/Health/Agents. */
  async fleetReport(): Promise<BrainFleetReport | null> {
    const response = await this.reqWithMeta<BrainFleetReport>('GET', '/fleet-report');
    const r = response.body;
    if (!r) return null;
    const warnings = this.noStoreWarnings('/fleet-report', response);
    return {
      ...r,
      cacheControl: response.cacheControl,
      noStore: response.noStore,
      ...(r.fleet
        ? { fleet: { ...r.fleet, warnings: [...(r.fleet.warnings ?? []), ...warnings] } }
        : {}),
    };
  }

  /** Read the Brain Agents dashboard authority contract without opening dashboard HTML. */
  async agentsReport(): Promise<BrainAgentsReport | null> {
    const [fleetResponse, controllerResponse] = await Promise.all([
      this.reqWithMeta<BrainFleetReport>('GET', '/fleet-report'),
      this.reqWithMeta<{ ok?: boolean; controllers?: BrainController[] }>('GET', '/controllers?limit=200'),
    ]);
    const fleetBody = fleetResponse.body;
    const controllerBody = controllerResponse.body;
    const fleet = fleetBody?.fleet;
    if (!fleet) return null;
    const agents = Array.isArray(fleet.agents) ? fleet.agents : [];
    const controllers = Array.isArray(controllerBody?.controllers) ? controllerBody.controllers : [];
    const authority = fleet.authority
      ?? (fleet.source === 'brain-cache' ? 'cache' : fleet.source === 'live-manager-partial' ? 'partial' : fleet.source === 'live-manager' ? 'live' : 'unknown');
    const nameCounts = new Map<string, number>();
    for (const agent of agents) {
      const name = String(agent.name ?? '');
      if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const duplicateNames = [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    const duplicateNameSet = new Set(duplicateNames);
    const linksFor = (controller: BrainController) => controller.agent_links ?? controller.agentLinks ?? [];
    const allLinks = controllers.flatMap((controller) => linksFor(controller).map((link) => ({ controller, link })));
    const activeLinks = allLinks.filter(({ link }) => (link.status ?? 'active') === 'active');
    let scopedControllerMatches = 0;
    let bareControllerMatches = 0;
    let ambiguousBareControllerLinks = 0;
    let unlinkedAgents = 0;
    for (const agent of agents) {
      const name = String(agent.name ?? '');
      const team = String(agent.team ?? '');
      const strongIds = new Set([
        agent.id,
        team && name ? `${team}:${name}` : null,
        team && name ? `${team}/${name}` : null,
      ].filter((value): value is string => Boolean(value)));
      const bareIds = new Set([name ? `agent:${name}` : null, name || null].filter((value): value is string => Boolean(value)));
      const hasStrong = activeLinks.some(({ link }) => strongIds.has(link.agent_id ?? link.agentId ?? ''));
      if (hasStrong) {
        scopedControllerMatches++;
        continue;
      }
      const hasBare = activeLinks.some(({ link }) => bareIds.has(link.agent_id ?? link.agentId ?? ''));
      if (hasBare && duplicateNameSet.has(name)) {
        ambiguousBareControllerLinks++;
        unlinkedAgents++;
        continue;
      }
      if (hasBare) {
        bareControllerMatches++;
        continue;
      }
      unlinkedAgents++;
    }
    const slaFetchLimit = 50;
    const warnings = [
      ...(fleet.warnings ?? []),
      ...this.noStoreWarnings('/fleet-report', fleetResponse),
      ...this.noStoreWarnings('/controllers', controllerResponse),
      ...(authority !== 'live' || fleet.authoritative !== true ? [fleet.statusAuthorityLabel ?? 'Brain Agents fleet source is not live-authoritative.'] : []),
      ...(duplicateNames.length ? [`Same-name Brain agents require scoped telemetry/controller links: ${duplicateNames.join(', ')}.`] : []),
      ...(ambiguousBareControllerLinks ? [`${ambiguousBareControllerLinks} Brain agent rows have ambiguous bare controller links.`] : []),
      ...(unlinkedAgents ? [`${unlinkedAgents} Brain agent rows have no scoped accountable controller link.`] : []),
      ...(Math.max(0, agents.length - slaFetchLimit) ? [`Brain Agents dashboard fetches SLA for first ${slaFetchLimit} rows only; omitted rows are unknown, not healthy.`] : []),
      ...(!controllerBody ? ['Brain /controllers is unavailable; accountable-controller fallback cannot be verified.'] : []),
    ];
    return {
      generatedAt: new Date().toISOString(),
      route: '/dashboard/agents',
      cacheControl: fleetResponse.cacheControl,
      noStore: fleetResponse.noStore,
      total: fleet.total ?? agents.length,
      running: fleet.running,
      source: fleet.source,
      authority,
      authoritative: fleet.authoritative,
      statusAuthorityLabel: fleet.statusAuthorityLabel,
      duplicateNames,
      controllerTotal: controllers.length,
      activeControllerLinks: activeLinks.length,
      scopedControllerMatches,
      bareControllerMatches,
      ambiguousBareControllerLinks,
      unlinkedAgents,
      slaFetchLimit,
      slaOmitted: Math.max(0, agents.length - slaFetchLimit),
      cacheDrift: fleet.cacheDrift,
      warnings,
    };
  }

  /** Read Brain Graph app contract without mutating graph state. */
  async graphReport(): Promise<BrainGraphReport | null> {
    type GraphData = {
      nodes?: unknown[];
      links?: unknown[];
      meta?: {
        includeNeighbors?: boolean;
        sourceAuthority?: string;
        sourceAuthorityLabel?: string;
        identityBridgeCount?: number;
        nodeCount?: number;
        linkCount?: number;
      };
      data?: {
        nodes?: unknown[];
        links?: unknown[];
        meta?: GraphData['meta'];
      };
    };
    const base = '/graph/app/data?kind=all&q=skill&limit=8&edge_limit=12';
    const [expandedResponse, directResponse] = await Promise.all([
      this.reqWithMeta<GraphData>('GET', base),
      this.reqWithMeta<GraphData>('GET', `${base}&neighbors=0`),
    ]);
    const expanded = expandedResponse.body;
    const direct = directResponse.body;
    if (!expanded && !direct) return null;
    const expandedMeta = expanded?.meta ?? expanded?.data?.meta ?? {};
    const directMeta = direct?.meta ?? direct?.data?.meta ?? {};
    const expandedNodes = expanded?.nodes ?? expanded?.data?.nodes ?? [];
    const expandedLinks = expanded?.links ?? expanded?.data?.links ?? [];
    const directNodes = direct?.nodes ?? direct?.data?.nodes ?? [];
    const directLinks = direct?.links ?? direct?.data?.links ?? [];
    const defaultIncludesNeighbors = expandedMeta.includeNeighbors === true;
    const neighborsParamHonored = directMeta.includeNeighbors === false;
    const warnings: string[] = [];
    if (!neighborsParamHonored) warnings.push('Brain Graph did not confirm neighbors=0; filtered graph expansion may be stale.');
    if (!expandedMeta.sourceAuthority || !expandedMeta.sourceAuthorityLabel) {
      warnings.push('Brain Graph source-authority labels are missing; restart/redeploy Brain before trusting Graph agent/entity status copy.');
    }
    if ((expanded && !expandedResponse.noStore) || (direct && !directResponse.noStore)) {
      const received = expandedResponse.cacheControl ?? directResponse.cacheControl;
      warnings.push(`Brain /graph/app/data response is missing Cache-Control: no-store${received ? ` (received ${received})` : ''}; restart/redeploy Brain before trusting dashboard freshness.`);
    }
    return {
      generatedAt: new Date().toISOString(),
      cacheControl: expandedResponse.cacheControl,
      noStore: expandedResponse.noStore,
      graph: {
        nodeCount: Number(expandedMeta.nodeCount ?? expandedNodes.length),
        linkCount: Number(expandedMeta.linkCount ?? expandedLinks.length),
        directNodeCount: direct ? Number(directMeta.nodeCount ?? directNodes.length) : undefined,
        directLinkCount: direct ? Number(directMeta.linkCount ?? directLinks.length) : undefined,
        defaultIncludesNeighbors,
        neighborsParamHonored,
        sourceAuthority: expandedMeta.sourceAuthority,
        sourceAuthorityLabel: expandedMeta.sourceAuthorityLabel,
        identityBridgeCount: expandedMeta.identityBridgeCount,
        warnings,
      },
    };
  }

  /** Read the safe Brain /health route, avoiding /brain/health report writes and learning reconciliation. */
  async coreHealth(): Promise<BrainCoreHealthReport | null> {
    const response = await this.reqWithMeta<BrainCoreHealthReport>('GET', '/health');
    const r = response.body;
    if (!r) return null;
    const warnings: string[] = [];
    if (r.ok !== true) warnings.push('Brain /health did not report ok=true.');
    if (r.routeInventory?.skew) {
      const missing = r.routeInventory.missing ?? [];
      warnings.push(`Brain route inventory is missing ${missing.length ? missing.join(', ') : 'critical routes'}.`);
    }
    if (r.sqliteVec?.degraded || r.sqliteVec?.available === false) {
      warnings.push('Brain sqlite-vec native vector capability is degraded; fallback retrieval may be in use.');
    }
    warnings.push(...this.noStoreWarnings('/health', response));
    return {
      ...r,
      generatedAt: new Date().toISOString(),
      cacheControl: response.cacheControl,
      noStore: response.noStore,
      warnings,
    };
  }

  /** Read Brain accountable-controller links for Identity/Agents status review. */
  async controllerReport(): Promise<BrainControllerReport | null> {
    const response = await this.reqWithMeta<{ ok?: boolean; controllers?: BrainController[] }>('GET', '/controllers?limit=200');
    const r = response.body;
    if (!r || !Array.isArray(r.controllers)) return null;
    const activeLinks = r.controllers.reduce((count, controller) => {
      const links = controller.agent_links ?? controller.agentLinks ?? [];
      return count + links.filter((link) => (link.status ?? 'active') === 'active').length;
    }, 0);
    return {
      generatedAt: new Date().toISOString(),
      route: '/controllers',
      cacheControl: response.cacheControl,
      noStore: response.noStore,
      total: r.controllers.length,
      activeLinks,
      controllers: r.controllers,
      warnings: this.noStoreWarnings('/controllers', response),
    };
  }

  /** Upsert keyed memory for an agent id (e.g. 'control-center' / 'team-instructions'). */
  async memory(agentId: string, input: { key: string; content: string; tags?: string[]; shared?: boolean; project?: string }): Promise<boolean> {
    const r = await this.req('POST', `/memory/${encodeURIComponent(agentId)}`, {
      key: input.key,
      content: input.content,
      tags: input.tags ?? [],
      ...(input.shared ? { shared: true } : {}),
      ...(input.project ? { project: input.project } : {}),
    });
    return r !== null;
  }

  /** Read a single keyed memory's content (null if absent). */
  async getMemory(agentId: string, key: string): Promise<string | null> {
    const r = await this.req<{ memory?: { content?: string } }>('GET', `/memory/${encodeURIComponent(agentId)}/${encodeURIComponent(key)}`);
    return r?.memory?.content ?? null;
  }

  /** Read shared memories (used to pull team-instructions back into agent sidecars). */
  async sharedMemory(opts: { tag?: string; project?: string; limit?: number } = {}): Promise<SharedMemory[]> {
    const q = new URLSearchParams();
    if (opts.tag) q.set('tag', opts.tag);
    if (opts.project) q.set('project', opts.project);
    q.set('limit', String(opts.limit ?? 8));
    const r = await this.req<{ memories?: SharedMemory[] }>('GET', `/memory/shared?${q.toString()}`);
    return r?.memories ?? [];
  }

  /**
   * Record a Control-Center operator action as a timeline event. The single helper every
   * mutation in bridge.ts calls (fire-and-forget) so the brain learns control actions that
   * never reach the manager. `action` is the IPC method name (e.g. 'coordinator:set'); the
   * payload is secret-redacted automatically.
   */
  async control(action: string, opts: { subject?: string; data?: Record<string, unknown>; tags?: string[] } = {}): Promise<boolean> {
    return this.timeline({
      type: `control:${action.replace(/:/g, '.')}`,
      subject: opts.subject ?? action,
      data: { action, ...(redactSecrets(opts.data ?? {}) as Record<string, unknown>) },
      tags: ['control-center', 'control', ...(opts.tags ?? [])],
    });
  }
}

/** Shared singleton — most callers just `import { brain } from '.../api/brain.ts'`. */
export const brain = new BrainClient();
