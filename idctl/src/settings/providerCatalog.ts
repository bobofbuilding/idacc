/**
 * Curated catalog of inference backends — so the operator picks a provider and
 * gets its base URL / kind filled in, instead of memorizing endpoints. Cloud
 * providers below are all OpenAI-compatible (GET {base}/models for discovery +
 * Bearer auth), so they reuse the existing `openai-compatible` kind. Local
 * servers need no key.
 *
 * Connect & sync verifies whatever is added actually lists models, so a slightly
 * stale base URL is self-correcting rather than silent.
 */

import type { ProviderKind } from './schema.ts';

export interface ProviderCatalogEntry {
  /** Stable id, also the default profile name. */
  id: string;
  /** Friendly label for the picker. */
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  needsKey: boolean;
  local?: boolean;
  /** Preset model ids for providers with NO GET /models endpoint (Perplexity). */
  models?: string[];
  notes?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // ---- Local model servers (no API key) --------------------------------
  { id: 'ollama', name: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', needsKey: false, local: true },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, local: true },
  { id: 'vllm', name: 'vLLM (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', needsKey: false, local: true, notes: 'Serves whatever --model it was launched with.' },
  { id: 'llamacpp', name: 'llama.cpp server (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, local: true },
  { id: 'localai', name: 'LocalAI (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, local: true },
  { id: 'jan', name: 'Jan (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1337/v1', needsKey: false, local: true },
  { id: 'headroom-proxy', name: 'Headroom proxy (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8787/v1', needsKey: false, local: true, notes: 'Optional canary route for selected agents. Start Headroom separately and keep a direct-provider fallback.' },

  // ---- Cloud — first-party kinds ---------------------------------------
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },

  // ---- Cloud — OpenAI-compatible ---------------------------------------
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, notes: 'Fast LPU inference.' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, notes: 'Aggregator: 300+ models from many providers.' },
  { id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', needsKey: true },
  { id: 'mistral', name: 'Mistral AI', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'xai', name: 'xAI (Grok)', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, notes: "Google's OpenAI-compatible shim; uses your Gemini API key." },
  { id: 'fireworks', name: 'Fireworks AI', kind: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', needsKey: true },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai-compatible', baseUrl: 'https://api.cerebras.ai/v1', needsKey: true, notes: 'Very high tok/s on wafer-scale hardware.' },
  { id: 'deepinfra', name: 'DeepInfra', kind: 'openai-compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', needsKey: true },
  { id: 'nebius', name: 'Nebius AI Studio', kind: 'openai-compatible', baseUrl: 'https://api.studio.nebius.com/v1', needsKey: true },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai-compatible', baseUrl: 'https://api.perplexity.ai', needsKey: true, models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research'], notes: 'Search-grounded; no /models list, so models are preset.' },
];

export function findProvider(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
