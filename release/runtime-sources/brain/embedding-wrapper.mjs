export const EMBEDDING_FTS_FALLBACK = 'fts5_keyword_and_embedding_json_scan';
export const DEFAULT_EMBEDDING_MAX_CHARS = 4000;

function envEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function providerFlagName(provider) {
  return `BRAIN_EMBED_${String(provider ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function embeddingProviderCapabilities(provider = 'deterministic-local', { env = process.env } = {}) {
  const normalized = String(provider || 'deterministic-local').toLowerCase();
  if (['deterministic-local', 'local', 'lexical'].includes(normalized)) {
    return {
      provider: 'deterministic-local',
      external: false,
      enabled: true,
      flag: null,
      fallback: EMBEDDING_FTS_FALLBACK,
    };
  }
  const flag = providerFlagName(normalized);
  const enabled = envEnabled(env.BRAIN_EMBED_PROVIDER_CALLS) ||
    envEnabled(env[flag]) ||
    envEnabled(env[`BRAIN_EMBEDDING_${normalized.toUpperCase()}_ENABLED`]);
  return {
    provider: normalized,
    external: true,
    enabled,
    flag,
    fallback: EMBEDDING_FTS_FALLBACK,
  };
}

export function assertEmbeddingProviderEnabled(provider, options = {}) {
  const capabilities = embeddingProviderCapabilities(provider, options);
  if (!capabilities.enabled) {
    const err = new Error(`embedding provider ${capabilities.provider} is disabled; set BRAIN_EMBED_PROVIDER_CALLS=1 or ${capabilities.flag}=1 to enable external calls`);
    err.code = 'embedding.provider_disabled';
    err.retryable = false;
    err.capabilities = capabilities;
    throw err;
  }
  return capabilities;
}

export function estimateEmbeddingTokens(text) {
  const str = String(text ?? '');
  if (!str) return 0;
  const words = str.match(/\S+/g)?.length ?? 0;
  return Math.max(Math.ceil(str.length / 4), Math.ceil(words * 1.3));
}

function replaceAndCount(str, pattern, replacement) {
  let count = 0;
  const out = str.replace(pattern, () => {
    count++;
    return replacement;
  });
  return { out, count };
}

export function sanitizeEmbeddingInput(text, { maxChars = DEFAULT_EMBEDDING_MAX_CHARS } = {}) {
  const original = String(text ?? '');
  const cap = Math.max(1, Number(maxChars) || DEFAULT_EMBEDDING_MAX_CHARS);
  let sanitized = original;
  let dataUriStripped = 0;
  let base64Stripped = 0;
  let hexStripped = 0;

  let replaced = replaceAndCount(
    sanitized,
    /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{80,}/gi,
    ' [binary data omitted] ',
  );
  sanitized = replaced.out;
  dataUriStripped += replaced.count;

  replaced = replaceAndCount(sanitized, /[A-Za-z0-9+/]{300,}={0,2}/g, ' [base64 blob omitted] ');
  sanitized = replaced.out;
  base64Stripped += replaced.count;

  replaced = replaceAndCount(sanitized, /(?:[0-9a-fA-F]{2}[\s:]?){200,}/g, ' [hex blob omitted] ');
  sanitized = replaced.out;
  hexStripped += replaced.count;

  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  const truncated = sanitized.length > cap;
  const textForEmbedding = truncated ? sanitized.slice(0, cap) : sanitized;
  return {
    text: textForEmbedding,
    sanitized,
    metadata: {
      sanitizer: 'brain.embedding.v1',
      original_chars: original.length,
      input_chars: sanitized.length,
      embedded_chars: textForEmbedding.length,
      est_tokens: estimateEmbeddingTokens(textForEmbedding),
      truncated,
      max_chars: cap,
      data_uri_stripped: dataUriStripped,
      base64_stripped: base64Stripped,
      hex_stripped: hexStripped,
    },
  };
}

export async function withEmbeddingRetry(fn, { retries = 3, baseMs = 500, jitterMs = 100, label = 'embed' } = {}) {
  let lastErr;
  const retryCount = Math.max(0, Number(retries) || 0);
  const baseDelay = Math.max(0, Number(baseMs) || 0);
  const jitter = Math.max(0, Number(jitterMs) || 0);
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      return await fn({ attempt, label });
    } catch (err) {
      lastErr = err;
      if (err?.retryable === false || attempt === retryCount) break;
      const delay = baseDelay * (2 ** attempt) + (jitter ? Math.floor(Math.random() * jitter) : 0);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// Mirrors the operator-tool env defaults (BRAIN_EMBED_BATCH_SIZE / _BATCH_DELAY_MS /
// _RETRIES / _RETRY_BASE_MS) so the batch guard behaves identically wherever it is reused.
export const DEFAULT_EMBEDDING_BATCH = {
  maxChars: DEFAULT_EMBEDDING_MAX_CHARS,
  batchSize: 16,
  batchDelayMs: 0,
  retries: 3,
  baseMs: 500,
  jitterMs: 100,
};

function chunkItems(arr, size) {
  const step = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
  return out;
}

// Pre-embedding safety wrapper at BATCH scope — the first-class, reusable version of the
// per-row loop in operator-tools/refresh-source-embeddings.mjs. For every input it:
//   1. sanitizes (strip inline base64/data-URI/hex blobs, hard-cap size, record truncation),
//   2. processes inputs in fixed-size batches with an optional inter-batch delay so a large
//      refresh does not hammer the provider,
//   3. retries each embed call with exponential backoff (withEmbeddingRetry), and
//   4. on a still-failing item, an empty vector, or empty-after-sanitize text, DROPS that item
//      to the FTS5 fallback instead of throwing — the batch and caller keep going.
// `embedFn(sanitizedText, item, ctx)` is the only side-effecting dependency (returns the
// provider result, e.g. { vector, model, metadata }). `sleep` is injectable for fast tests.
export async function embedBatchWithGuard(items = [], embedFn, options = {}) {
  if (typeof embedFn !== 'function') throw new TypeError('embedBatchWithGuard requires an embedFn(sanitizedText, item, ctx)');
  const o = { ...DEFAULT_EMBEDDING_BATCH, ...options };
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const textOf = options.textOf ?? ((it) => (typeof it === 'string' ? it : it?.text));
  const batches = chunkItems(Array.isArray(items) ? items : [], o.batchSize);
  const results = [];
  const stats = { total: Array.isArray(items) ? items.length : 0, batches: batches.length, embedded: 0, truncated: 0, sanitized: 0, skipped_empty: 0, fallback: 0 };
  let index = -1;
  for (let b = 0; b < batches.length; b++) {
    for (const item of batches[b]) {
      index++;
      const sanitized = sanitizeEmbeddingInput(textOf(item), { maxChars: o.maxChars });
      if (sanitized.metadata.truncated) stats.truncated++;
      if (sanitized.metadata.data_uri_stripped || sanitized.metadata.base64_stripped || sanitized.metadata.hex_stripped) stats.sanitized++;
      if (!sanitized.text) {
        stats.skipped_empty++;
        results.push({ index, item, ok: false, skipped: true, reason: 'empty_after_sanitize', fallback: EMBEDDING_FTS_FALLBACK, sanitizeMetadata: sanitized.metadata });
        continue;
      }
      try {
        const embedding = await withEmbeddingRetry(
          ({ attempt }) => embedFn(sanitized.text, item, { attempt, index }),
          { retries: o.retries, baseMs: o.baseMs, jitterMs: o.jitterMs, label: o.label ?? `embed:${index}` },
        );
        const vector = Array.isArray(embedding?.vector) ? embedding.vector : Array.isArray(embedding) ? embedding : null;
        if (!vector || !vector.length) {
          stats.fallback++;
          results.push({ index, item, ok: false, reason: 'empty_vector', fallback: EMBEDDING_FTS_FALLBACK, sanitizeMetadata: sanitized.metadata });
          continue;
        }
        stats.embedded++;
        results.push({ index, item, ok: true, embedding, sanitizeMetadata: { ...sanitized.metadata, fts_fallback: EMBEDDING_FTS_FALLBACK } });
      } catch (err) {
        stats.fallback++;
        results.push({ index, item, ok: false, reason: err?.code || err?.message || 'embed_failed', fallback: EMBEDDING_FTS_FALLBACK, sanitizeMetadata: sanitized.metadata });
      }
    }
    if (o.batchDelayMs && b < batches.length - 1) await sleep(o.batchDelayMs);
  }
  return { results, stats, fallback: EMBEDDING_FTS_FALLBACK };
}
