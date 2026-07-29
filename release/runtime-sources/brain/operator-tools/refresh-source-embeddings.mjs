#!/usr/bin/env node

import { createHash } from 'node:crypto';

import { db, sqliteVecStatus, upsertSourceEmbeddingVector } from '../db.mjs';
import { recordScriptFailure, scriptEnvelope, scriptFailureEnvelope } from '../brain-client.mjs';
import {
  EMBEDDING_FTS_FALLBACK,
  assertEmbeddingProviderEnabled,
  embeddingProviderCapabilities,
  sanitizeEmbeddingInput,
  withEmbeddingRetry,
} from '../embedding-wrapper.mjs';

function parseArgs(argv) {
  const args = {
    limit: 100,
    provider: process.env.BRAIN_EMBEDDING_PROVIDER || process.env.BRAIN_EMBED_PROVIDER || 'auto',
    model: process.env.BRAIN_EMBEDDING_MODEL || process.env.BRAIN_EMBED_MODEL || '',
    maxChars: 4000,
    batchSize: Math.max(1, Number(process.env.BRAIN_EMBED_BATCH_SIZE ?? 16) || 16),
    batchDelayMs: Math.max(0, Number(process.env.BRAIN_EMBED_BATCH_DELAY_MS ?? 0) || 0),
    retries: Math.max(0, Number(process.env.BRAIN_EMBED_RETRIES ?? 3) || 0),
    retryBaseMs: Math.max(0, Number(process.env.BRAIN_EMBED_RETRY_BASE_MS ?? 500) || 0),
  };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (key === 'limit') args.limit = Number(value);
    else if (key === 'provider') args.provider = value;
    else if (key === 'model') args.model = value;
    else if (key === 'max-chars') args.maxChars = Number(value);
    else if (key === 'max-content-size' || key === 'max_content_size') args.maxChars = Number(value);
    else if (key === 'batch-size') args.batchSize = Math.max(1, Number(value) || 16);
    else if (key === 'batch-delay-ms') args.batchDelayMs = Math.max(0, Number(value) || 0);
    else if (key === 'retries') args.retries = Math.max(0, Number(value) || 0);
    else if (key === 'retry-base-ms') args.retryBaseMs = Math.max(0, Number(value) || 0);
  }
  return args;
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function lexicalVector(text) {
  const buckets = new Array(64).fill(0);
  for (const token of String(text ?? '').toLowerCase().match(/[a-z0-9:_-]{3,}/g) ?? []) {
    const hash = createHash('sha256').update(token).digest();
    buckets[hash[0] % buckets.length] += 1;
  }
  const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1;
  return buckets.map(value => Math.round((value / norm) * 1000000) / 1000000);
}

async function openaiEmbedding(text, { model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for provider=openai');
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'text-embedding-3-small',
      input: text,
    }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`OpenAI embeddings request failed: ${response.status} ${await response.text()}`),
      { retryable: response.status === 429 || response.status >= 500 });
  }
  const json = await response.json();
  return {
    vector: json.data?.[0]?.embedding ?? [],
    model: json.model || model || 'text-embedding-3-small',
    metadata: { comparison_only: false, provider: 'openai' },
  };
}

async function ollamaEmbedding(text, { model }) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const resolvedModel = model || 'nomic-embed-text';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolvedModel, prompt: text }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Ollama embeddings request failed: ${response.status} ${await response.text()}`),
      { retryable: response.status === 429 || response.status >= 500 });
  }
  const json = await response.json();
  return {
    vector: json.embedding ?? [],
    model: resolvedModel,
    metadata: { comparison_only: false, provider: 'ollama', base_url: baseUrl },
  };
}

async function embedText(text, args) {
  if (args.provider === 'openai') return openaiEmbedding(text, args);
  if (args.provider === 'ollama') return ollamaEmbedding(text, args);
  return {
    vector: lexicalVector(text),
    model: args.model || 'lexical-hash-64',
    metadata: { comparison_only: true, provider: 'deterministic-local' },
  };
}

function normalizeProvider(provider) {
  const normalized = String(provider || 'auto').toLowerCase();
  if (['local', 'lexical'].includes(normalized)) return 'deterministic-local';
  return normalized;
}

function embeddingProviderChain(provider) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'auto') return ['openai', 'ollama', 'deterministic-local'];
  return [normalized];
}

async function embedTextWithFallback(text, args, { label } = {}) {
  const providers = embeddingProviderChain(args.provider);
  let lastErr;
  for (const provider of providers) {
    try {
      const embedding = await withEmbeddingRetry(async () => {
        if (provider !== 'deterministic-local') assertEmbeddingProviderEnabled(provider);
        return embedText(text, { ...args, provider });
      }, {
        retries: args.retries,
        baseMs: args.retryBaseMs,
        label: `${label ?? 'embed'}:${provider}`,
      });
      const actualProvider = embedding?.metadata?.provider || provider;
      return {
        embedding,
        provider: actualProvider,
        providerCapabilities: embeddingProviderCapabilities(actualProvider),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('embedding provider chain exhausted');
}

function sourceRows(limit, maxChars) {
  // Bound memory but keep enough beyond maxChars to detect truncation downstream.
  const safetyCap = Math.max(maxChars * 8, 16_000);
  const entities = db.prepare(`
    SELECT id, type, name, description, data, tags, updated_at
    FROM entities
    WHERE COALESCE(status, 'active') != 'merged'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    canonical_source_id: `entity:${row.id}`,
    source_kind: 'entity',
    text: `${row.id} ${row.type} ${row.name} ${row.description} ${row.data} ${row.tags}`.slice(0, safetyCap),
  }));
  const facts = db.prepare(`
    SELECT id, entity_id, field, value, context, observed_at
    FROM facts
    WHERE status='active'
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    canonical_source_id: `fact:${row.id}`,
    source_kind: 'fact',
    text: `${row.entity_id} ${row.field} ${row.value} ${row.context}`.slice(0, safetyCap),
  }));
  const textUnits = db.prepare(`
    SELECT id, title, content, metadata, updated_at
    FROM text_units
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    canonical_source_id: `text:${row.id}`,
    source_kind: 'text',
    text: `${row.title} ${row.content} ${row.metadata}`.slice(0, safetyCap),
  }));
  return [...entities, ...facts, ...textUnits].slice(0, limit);
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.provider = normalizeProvider(args.provider);
  const providerChain = embeddingProviderChain(args.provider);
  const requestedProviderCapabilities = Object.fromEntries(providerChain.map(provider => [
    provider,
    embeddingProviderCapabilities(provider),
  ]));
  if (args.provider !== 'auto' && requestedProviderCapabilities[args.provider]?.external && !requestedProviderCapabilities[args.provider]?.enabled) {
    console.log(JSON.stringify(scriptEnvelope({
      skipped: 'provider_disabled',
      written: 0,
      failed: 0,
      provider: args.provider,
      model: args.model || null,
      provider_capabilities: requestedProviderCapabilities[args.provider],
      fts_fallback: EMBEDDING_FTS_FALLBACK,
      sqlite_vec: sqliteVecStatus(),
      vector_indexed: 0,
      vector_skipped: {},
    }, { script: 'refresh-source-embeddings' }), null, 2));
    return;
  }
  const rows = sourceRows(Math.max(Number(args.limit) || 100, 1), Math.max(Number(args.maxChars) || 4000, 500));
  const stmt = db.prepare(`
    INSERT INTO source_embeddings
      (canonical_source_id, source_kind, provider, model, content_hash, embedding_json, text_preview, metadata, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(canonical_source_id) DO UPDATE SET
      source_kind=excluded.source_kind,
      provider=excluded.provider,
      model=excluded.model,
      content_hash=excluded.content_hash,
      embedding_json=excluded.embedding_json,
      text_preview=excluded.text_preview,
      metadata=excluded.metadata,
      refreshed_at=unixepoch()
  `);
  let written = 0;
  let vectorIndexed = 0;
  let truncatedCount = 0;
  let sanitizedCount = 0;
  let failed = 0;
  const providerSuccessCounts = Object.fromEntries(providerChain.map(provider => [provider, 0]));
  const vectorSkipped = {};
  // G6: process in batches so large refreshes don't hammer the provider; G5: each
  // input is sanitized; truncation is recorded in the embedding metadata.
  const batches = chunkArray(rows, args.batchSize);
  for (let b = 0; b < batches.length; b++) {
    for (const row of batches[b]) {
      const sanitized = sanitizeEmbeddingInput(row.text, { maxChars: args.maxChars });
      if (!sanitized.text) continue;
      if (sanitized.metadata.truncated) truncatedCount++;
      if (sanitized.metadata.data_uri_stripped || sanitized.metadata.base64_stripped || sanitized.metadata.hex_stripped) sanitizedCount++;
      let embeddingResult;
      try {
        embeddingResult = await embedTextWithFallback(sanitized.text, args, { label: row.canonical_source_id });
      } catch (err) {
        failed++;
        continue;
      }
      const { embedding, provider: actualProvider, providerCapabilities } = embeddingResult;
      if (!Array.isArray(embedding.vector) || !embedding.vector.length) continue;
      providerSuccessCounts[actualProvider] = (providerSuccessCounts[actualProvider] ?? 0) + 1;
      const metadata = {
        ...embedding.metadata,
        ...sanitized.metadata,
        provider_capabilities: providerCapabilities,
        fts_fallback: EMBEDDING_FTS_FALLBACK,
      };
      stmt.run(
        row.canonical_source_id,
        row.source_kind,
        actualProvider,
        embedding.model,
        hashText(sanitized.text),
        JSON.stringify(embedding.vector),
        sanitized.text.slice(0, 1000),
        JSON.stringify(metadata),
      );
      const vectorResult = upsertSourceEmbeddingVector({
        canonicalSourceId: row.canonical_source_id,
        sourceKind: row.source_kind,
        embedding: embedding.vector,
      });
      if (vectorResult.indexed) vectorIndexed++;
      else vectorSkipped[vectorResult.reason ?? 'unknown'] = (vectorSkipped[vectorResult.reason ?? 'unknown'] ?? 0) + 1;
      written++;
    }
    if (args.batchDelayMs && b < batches.length - 1) await new Promise(resolve => setTimeout(resolve, args.batchDelayMs));
  }
  console.log(JSON.stringify(scriptEnvelope({
    batches: batches.length,
    batch_size: args.batchSize,
    truncated: truncatedCount,
    sanitized: sanitizedCount,
    failed,
    written,
    provider: args.provider,
    provider_chain: providerChain,
    provider_success_counts: providerSuccessCounts,
    model: args.model || null,
    provider_capabilities: requestedProviderCapabilities,
    fts_fallback: EMBEDDING_FTS_FALLBACK,
    sqlite_vec: sqliteVecStatus(),
    vector_indexed: vectorIndexed,
    vector_skipped: vectorSkipped,
  }, { script: 'refresh-source-embeddings' }), null, 2));
}

main().catch(async (err) => {
  await recordScriptFailure({ script: 'refresh-source-embeddings', error: err });
  console.log(JSON.stringify(scriptFailureEnvelope(err, {
    script: 'refresh-source-embeddings',
    hint: 'check the embedding provider, model configuration, and Brain database before retrying',
    retry_command: 'node operator-tools/refresh-source-embeddings.mjs',
    risk: { level: 'medium', action: 'inspect-embeddings' },
  }), null, 2));
  process.exit(1);
});
