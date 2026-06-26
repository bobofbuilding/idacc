// SPDX-License-Identifier: MIT
/**
 * BrainClient — the Control Center's typed channel to the self-learning brain (:4200).
 *
 * Until now the CC had exactly ONE brain write (orgSync.writeOrgToBrain — an inline fetch).
 * This generalizes that precedent so EVERY operator control action can be recorded to the
 * brain: an audit event on the timeline, structured facts, entities, ingested text, or keyed
 * shared memory. It is the app-side half of "everything updated in the self-learning brain"
 * (Phase 1): config/control mutations that never touch the manager (and so are invisible to
 * the manager→brain event stream) are mirrored here directly instead.
 *
 * EVERY write is best-effort: short timeout, errors swallowed, never throws. The brain is an
 * observer — a brain hiccup must never block, slow, or fail a control action. Callers should
 * `void brain.control(...)` (fire-and-forget) right after their own state write succeeds.
 *
 * Endpoint shapes verified against the live brain (brain-listener.mjs / brain-client.mjs):
 *   POST /timeline           { source, type, subject, data, tags }
 *   POST /entities           { id, type, name, source, status, tags, data }
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
}
export interface BrainFact {
  entity_id: string;
  field: string;
  value: unknown;
  source?: string;
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
}

export class BrainClient {
  readonly url: string;
  private readonly token: string;
  private readonly source: string;
  private readonly timeoutMs: number;

  constructor(opts: BrainClientOptions = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/+$/, '');
    this.token = opts.token ?? DEFAULT_TOKEN;
    this.source = opts.source || DEFAULT_SOURCE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** Best-effort request. Returns the parsed body on 2xx, else null. Never throws. */
  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      const r = await fetch(`${this.url}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) return null;
      const text = await r.text();
      if (!text) return null as T | null;
      try { return JSON.parse(text) as T; } catch { return null; }
    } catch {
      return null;
    }
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
