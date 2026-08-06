/**
 * ProviderClient — probe an inference backend for liveness and list its models.
 * One probe() does both. Shapes are the ones verified against live servers /
 * documented APIs during design:
 *
 *   ollama            GET {base}/api/tags                 .models[].name   (no auth)
 *   lmstudio          GET {base}/v1/models                .data[].id       (no auth)
 *   openai-compatible GET {base}/v1/models  (Bearer)      .data[].id
 *   anthropic         GET {base}/v1/models  (x-api-key +  .data[].id
 *                                            anthropic-version: 2023-06-01)
 *   openai            GET {base}/v1/models  (Bearer)      .data[].id
 *
 * Status: 200→live · 401→auth-error (endpoint proven up, key bad/missing) ·
 * connection refused / DNS / timeout → unreachable · anything else → error.
 */

import type { ProviderProfile } from './schema.ts';
import { normalizeProviderBaseUrl } from './providerTransport.ts';

export interface DiscoveredModel {
  id: string;
  label?: string;
  detail?: string;
}

export type ProbeStatus = 'live' | 'auth-error' | 'unreachable' | 'error';

export interface ProbeOutcome {
  ok: boolean;
  status: ProbeStatus;
  httpStatus?: number;
  models: DiscoveredModel[];
  message?: string;
  /**
   * Whether the JSON body had the expected list shape (ollama → `models[]`,
   * OpenAI-style → `data[]`). Lets discovery reject a random 200-OK JSON service
   * squatting on a probed port without also rejecting a real-but-empty server.
   */
  shaped?: boolean;
}

/**
 * Bound + sanitize a model id from an untrusted server: strip control/bidi
 * characters and cap length, so a hostile or buggy process on a probed loopback
 * port can't write megabyte / homoglyph / RTL-spoofed ids into the config file
 * or the DOM. Returns '' (dropped by the caller) when nothing usable remains.
 */
function sanitizeModelId(s: string): string {
  const cleaned = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
  return cleaned.length > 0 && cleaned.length <= 256 ? cleaned : '';
}

function normalizeBase(url: string): string {
  return normalizeProviderBaseUrl(url);
}

/** Append the OpenAI-style models path. If the base already ends at an API root
 *  (`/v1` like Groq/Together, or `/openai` like Gemini's shim / DeepInfra), just
 *  add `/models`; otherwise assume a bare host and add `/v1/models`. */
function openAiModelsUrl(base: string): string {
  const b = normalizeBase(base);
  return /\/(v1|openai)$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}

export class ProviderClient {
  private p: ProviderProfile;
  private apiKey?: string;

  constructor(p: ProviderProfile, apiKey?: string) {
    this.p = p;
    this.apiKey = apiKey;
  }

  private endpoint(): { url: string; headers: Record<string, string> } {
    const base = normalizeBase(this.p.baseUrl);
    const headers: Record<string, string> = {};
    switch (this.p.kind) {
      case 'ollama':
        // native /api/tags lives at the bare host, NOT under /v1.
        return { url: `${base.replace(/\/v1$/, '')}/api/tags`, headers };
      case 'anthropic':
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        return { url: /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`, headers };
      case 'lmstudio':
      case 'openai':
      case 'openai-compatible':
      default:
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        return { url: openAiModelsUrl(base), headers };
    }
  }

  async probe(signal?: AbortSignal, timeoutMs = 6000): Promise<ProbeOutcome> {
    let endpoint: { url: string; headers: Record<string, string> };
    try {
      // Transport validation happens before authentication headers are built or
      // fetch can run, including for insecure hand-edited legacy profiles.
      endpoint = this.endpoint();
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        models: [],
        message: error instanceof Error ? error.message : 'Provider URL is not allowed.',
      };
    }
    const { url, headers } = endpoint;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 'unreachable', models: [], message: `cannot reach ${url} (${msg})` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 'auth-error', httpStatus: res.status, models: [], message: `${res.status} — endpoint up, API key missing or invalid` };
    }
    if (!res.ok) {
      return { ok: false, status: 'error', httpStatus: res.status, models: [], message: `${res.status} ${res.statusText}` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: 'error', httpStatus: res.status, models: [], message: 'response was not JSON' };
    }
    const b = body as Record<string, unknown>;
    const shaped = this.p.kind === 'ollama' ? Array.isArray(b?.models) : Array.isArray(b?.data);
    return { ok: true, status: 'live', httpStatus: res.status, models: this.parse(body), shaped };
  }

  private parse(body: unknown): DiscoveredModel[] {
    const b = body as Record<string, unknown>;
    if (this.p.kind === 'ollama') {
      const models = Array.isArray(b?.models) ? (b.models as Record<string, unknown>[]) : [];
      return models
        .map((m): DiscoveredModel | null => {
          const id = sanitizeModelId(String(m.name ?? m.model ?? ''));
          const d = (m.details ?? {}) as Record<string, unknown>;
          const detail = [d.parameter_size, d.quantization_level].filter(Boolean).join(' ');
          return id ? { id, detail: detail || undefined } : null;
        })
        .filter((x): x is DiscoveredModel => x != null);
    }
    // OpenAI-style: { data: [{ id, display_name? }] }
    const data = Array.isArray(b?.data) ? (b.data as Record<string, unknown>[]) : [];
    return data
      .map((m): DiscoveredModel | null => {
        const id = sanitizeModelId(String(m.id ?? ''));
        const label = m.display_name ? String(m.display_name) : undefined;
        return id ? { id, label } : null;
      })
      .filter((x): x is DiscoveredModel => x != null);
  }
}
