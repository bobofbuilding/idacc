import { providerTransportDecision } from '../../../idctl/src/settings/providerTransport.ts';

export const STARTER_OLLAMA_MAX_MODELS = 32;
export const STARTER_OLLAMA_PROBE_CONCURRENCY = 4;
export const STARTER_OLLAMA_MODEL_TIMEOUT_MS = 1_200;
export const STARTER_OLLAMA_TOTAL_TIMEOUT_MS = 4_000;
export const STARTER_OLLAMA_MAX_RESPONSE_BYTES = 64 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaStarterToolEvidence {
  toolCapableModels: string[];
  nonToolModels: string[];
  unverifiedModels: string[];
  checkedModels: number;
  truncated: boolean;
  detail: string;
}

export interface InspectOllamaStarterToolOptions {
  fetchImpl?: FetchLike;
  maxModels?: number;
  concurrency?: number;
  modelTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
}

function uniqueModelIds(models: string[]): string[] {
  return Array.from(new Set(
    models
      .map((model) => String(model ?? '').trim())
      .filter((model) => model.length > 0 && model.length <= 256),
  ));
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.min(Math.floor(Number(value)), maximum);
}

function ollamaShowUrl(baseUrl: string): string {
  const decision = providerTransportDecision(baseUrl);
  if (!decision.ok || !decision.normalizedUrl) {
    throw new Error(decision.error || 'The Ollama provider URL is not allowed.');
  }
  const url = new URL(decision.normalizedUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  url.pathname = `${path}/api/show`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Ollama capability response exceeded the size limit.');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Ollama capability response exceeded the size limit.');
    }
    return JSON.parse(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('response-size-limit');
        throw new Error('Ollama capability response exceeded the size limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return JSON.parse(body);
}

async function inspectOneModel(
  showUrl: string,
  model: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<'tools' | 'no-tools' | 'unverified'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(showUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) return 'unverified';
    const body = await boundedJson(response, maxResponseBytes) as { capabilities?: unknown };
    if (!Array.isArray(body?.capabilities)) return 'unverified';
    return body.capabilities.includes('tools') ? 'tools' : 'no-tools';
  } catch {
    return 'unverified';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a native Ollama server for authoritative, model-specific tool support.
 *
 * This intentionally does not use family-name guesses. A missing, malformed,
 * oversized, slow, or failed `/api/show` response leaves that model available
 * to general agent pickers but excludes it from the Brain-backed starter setup.
 */
export async function inspectOllamaStarterToolModels(
  baseUrl: string,
  models: string[],
  options: InspectOllamaStarterToolOptions = {},
): Promise<OllamaStarterToolEvidence> {
  const allModels = uniqueModelIds(models);
  const maxModels = positiveBound(options.maxModels, STARTER_OLLAMA_MAX_MODELS, STARTER_OLLAMA_MAX_MODELS);
  const candidates = allModels.slice(0, maxModels);
  const truncatedModels = allModels.slice(candidates.length);
  const concurrency = positiveBound(
    options.concurrency,
    STARTER_OLLAMA_PROBE_CONCURRENCY,
    STARTER_OLLAMA_PROBE_CONCURRENCY,
  );
  const modelTimeoutMs = positiveBound(
    options.modelTimeoutMs,
    STARTER_OLLAMA_MODEL_TIMEOUT_MS,
    STARTER_OLLAMA_MODEL_TIMEOUT_MS,
  );
  const totalTimeoutMs = positiveBound(
    options.totalTimeoutMs,
    STARTER_OLLAMA_TOTAL_TIMEOUT_MS,
    STARTER_OLLAMA_TOTAL_TIMEOUT_MS,
  );
  const maxResponseBytes = positiveBound(
    options.maxResponseBytes,
    STARTER_OLLAMA_MAX_RESPONSE_BYTES,
    STARTER_OLLAMA_MAX_RESPONSE_BYTES,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  let showUrl: string;
  try {
    showUrl = ollamaShowUrl(baseUrl);
  } catch {
    return {
      toolCapableModels: [],
      nonToolModels: [],
      unverifiedModels: allModels,
      checkedModels: 0,
      truncated: allModels.length > maxModels,
      detail: 'Ollama model tool capability could not be verified because the provider URL is not allowed.',
    };
  }

  const results = new Map<string, 'tools' | 'no-tools' | 'unverified'>();
  const deadline = Date.now() + totalTimeoutMs;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const model = candidates[index];
      const result = await inspectOneModel(
        showUrl,
        model,
        fetchImpl,
        Math.max(1, Math.min(modelTimeoutMs, remaining)),
        maxResponseBytes,
      );
      results.set(model, result);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, candidates.length) },
    () => worker(),
  ));

  const toolCapableModels = candidates.filter((model) => results.get(model) === 'tools');
  const nonToolModels = candidates.filter((model) => results.get(model) === 'no-tools');
  const unverifiedModels = [
    ...candidates.filter((model) => !results.has(model) || results.get(model) === 'unverified'),
    ...truncatedModels,
  ];
  const excludedCount = nonToolModels.length + unverifiedModels.length;
  const boundedNote = truncatedModels.length
    ? ` The bounded readiness check inspects at most ${maxModels} models per route; select a smaller model set in Settings and re-check to verify another model.`
    : '';
  const detail = toolCapableModels.length
    ? `Verified ${toolCapableModels.length} Ollama model${toolCapableModels.length === 1 ? '' : 's'} for Brain tool calls via /api/show.${
      excludedCount ? ` ${excludedCount} model${excludedCount === 1 ? '' : 's'} remain${excludedCount === 1 ? 's' : ''} general-use only.` : ''
    }${boundedNote}`
    : `No installed Ollama model returned authoritative /api/show tool capability; ${
      excludedCount || allModels.length
    } model${(excludedCount || allModels.length) === 1 ? '' : 's'} remain general-use only.${boundedNote}`;

  return {
    toolCapableModels,
    nonToolModels,
    unverifiedModels,
    checkedModels: results.size,
    truncated: truncatedModels.length > 0,
    detail,
  };
}
