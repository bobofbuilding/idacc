import assert from 'node:assert/strict';
import { buildProviderModelLanes, buildRuntimeCatalog, managedRuntimeHasEvidence, offerableRuntimes, runtimeSupports } from './runtimeCatalog.ts';
import type { ProviderProfile } from './schema.ts';

const providers = [
  { kind: 'anthropic', enabled: true, keySource: 'config', needsKey: true, lastSync: { status: 'live', modelCount: 3 } },
  { kind: 'openai', enabled: true, keySource: 'none', needsKey: true, lastSync: { status: 'live', modelCount: 4 } },
  { kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', enabled: true, keySource: 'config', needsKey: true, lastSync: { status: 'preset', modelCount: 5 } },
  { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, needsKey: false, lastSync: { status: 'live', modelCount: 2 } },
];

const managed = [
  { runtime: 'codex', installed: true, loggedIn: true, statusSupported: true },
  { runtime: 'cursor-cli', installed: true, loggedIn: false, statusSupported: true },
  { runtime: 'grok', installed: true, loggedIn: true, statusSupported: true },
  { runtime: 'antigravity', installed: true, loggedIn: true, statusSupported: true },
  { runtime: 'copilot', installed: true, loggedIn: false, statusSupported: false },
  { runtime: 'kiro-cli', installed: true, loggedIn: true, statusSupported: true },
  { runtime: 'gemini', installed: true, loggedIn: false, statusSupported: true },
  { runtime: 'claude-code-cli', installed: true, loggedIn: true, statusSupported: true },
];

assert.deepEqual(
  offerableRuntimes(providers, undefined, managed),
  ['codex', 'grok', 'antigravity', 'copilot', 'kiro-cli', 'claude-code-cli', 'claude-agent-sdk', 'ollama'],
  'runtime pickers should list Settings-proven manager harnesses without duplicate Claude Code aliases',
);

assert.deepEqual(
  offerableRuntimes(providers, 'claude-code-local', managed),
  ['claude-code-local', 'codex', 'grok', 'antigravity', 'copilot', 'kiro-cli', 'claude-code-cli', 'claude-agent-sdk', 'ollama'],
  'existing claude-code-local assignments should remain visible even though new selections use Claude Code',
);

const providerLanes = buildProviderModelLanes([
  { name: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, keySource: 'config', needsKey: true, lastSync: { at: 1, status: 'live', modelCount: 2, models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'] } },
  { name: 'NVIDIABuild-Autogen-73', kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', enabled: true, keySource: 'config', needsKey: true, lastSync: { at: 1, status: 'preset', modelCount: 1, models: ['qwen/qwen3.5-397b-a17b'] } },
]);

assert.deepEqual(
  providerLanes.map((lane) => ({ id: lane.id, label: lane.label, kind: lane.kind, selectable: lane.selectable, count: lane.models.length })),
  [
    { id: 'provider:openrouter', label: 'API · openrouter', kind: 'api', selectable: true, count: 2 },
    { id: 'provider:NVIDIABuild-Autogen-73', label: 'API · NVIDIABuild-Autogen-73', kind: 'api', selectable: true, count: 1 },
  ],
  'ready API providers should become selectable model lanes without becoming static manager harness runtimes',
);

const localProviderLanes = buildProviderModelLanes([
  { name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, needsKey: false, lastSync: { at: 1, status: 'live', modelCount: 1, models: ['qwen3:1.7b'] } },
  { name: 'lmstudio', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, needsKey: false, lastSync: { at: 1, status: 'live', modelCount: 1, models: ['local-model'] } },
]);

assert.deepEqual(
  localProviderLanes.map((lane) => ({ id: lane.id, label: lane.label, kind: lane.kind, selectable: lane.selectable, count: lane.models.length })),
  [
    { id: 'provider:ollama', label: 'Local · Ollama', kind: 'local', selectable: true, count: 1 },
    { id: 'provider:lmstudio', label: 'Local · LM Studio', kind: 'local', selectable: true, count: 1 },
  ],
  'synced local providers should become selectable concrete local model lanes',
);

const providerCatalog = buildRuntimeCatalog([
  { name: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, needsKey: true, lastSync: { at: 1, status: 'live', modelCount: 2, models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'] } },
] satisfies ProviderProfile[]);
assert.deepEqual(
  providerCatalog['provider:openrouter'],
  ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'],
  'provider lane model catalogs should be keyed by provider:<name> for the staged Harness dropdown',
);

const curatedCatalog = buildRuntimeCatalog([]);
assert.deepEqual(
  curatedCatalog['claude-code-cli'].slice(0, 2),
  ['claude-fable-5', 'claude-sonnet-5'],
  'Claude Code curated fallback should include current Fable and Sonnet 5 choices before older Claude models',
);

assert.deepEqual(
  curatedCatalog.codex.slice(0, 3),
  ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  'Codex curated fallback should include current GPT-5.6 choices before older GPT models when the local Codex cache has not caught up',
);

const selectedProviderCatalog = buildRuntimeCatalog([
  {
    name: 'openrouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    needsKey: true,
    lastSync: { at: 1, status: 'live', modelCount: 3, models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6', 'x-ai/grok-4'] },
    modelSelection: { mode: 'selected', models: ['x-ai/grok-4'] },
  },
] satisfies ProviderProfile[]);
assert.deepEqual(
  selectedProviderCatalog['provider:openrouter'],
  ['x-ai/grok-4'],
  'provider model selection should filter the Health provider lane without deleting the synced catalog',
);

const selectedProviderLanes = buildProviderModelLanes([
  {
    name: 'openrouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    keySource: 'config',
    needsKey: true,
    lastSync: { at: 1, status: 'live', modelCount: 3, models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6', 'x-ai/grok-4'] },
    modelSelection: { mode: 'selected', models: ['x-ai/grok-4'] },
  },
] satisfies Array<ProviderProfile & { keySource?: string; needsKey?: boolean }>);
assert.deepEqual(
  selectedProviderLanes.map((lane) => ({ id: lane.id, count: lane.models.length, models: lane.models })),
  [{ id: 'provider:openrouter', count: 1, models: ['x-ai/grok-4'] }],
  'provider model lanes should expose only selected Health models',
);

assert.deepEqual(
  offerableRuntimes([], 'cursor-cli', []),
  ['cursor-cli'],
  'current assigned runtimes should remain visible even when no longer newly available',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'gemini', installed: true, loggedIn: false, statusSupported: false }]),
  [],
  'Gemini CLI should not become assignable from binary presence alone',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'antigravity', installed: true, loggedIn: false, statusSupported: false }]),
  [],
  'Antigravity CLI should require signed-in model-probe evidence before assignment',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'antigravity', installed: true, loggedIn: true, statusSupported: true }]),
  ['antigravity'],
  'Antigravity CLI should become assignable once the manager exposes the Antigravity harness and Settings confirms sign-in',
);

assert.equal(runtimeSupports('antigravity', 'skills'), true, 'Antigravity uses the manager .agents skill workspace');
assert.equal(runtimeSupports('antigravity', 'portablePlugins'), true, 'portable plugin packages must have an Antigravity fallback path');

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'grok', installed: true, loggedIn: false, statusSupported: false }]),
  [],
  'Grok CLI should require signed-in status evidence before assignment',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'grok', installed: true, loggedIn: true, statusSupported: true }]),
  ['grok'],
  'Grok CLI should become assignable once the manager exposes the Grok harness and Settings confirms sign-in',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'kiro-cli', installed: true, loggedIn: true, statusSupported: true }]),
  ['kiro-cli'],
  'Kiro CLI should become assignable once the manager exposes the Kiro harness and Settings confirms sign-in',
);

assert.deepEqual(
  offerableRuntimes([], undefined, [{ runtime: 'copilot', installed: true, loggedIn: false, statusSupported: false }]),
  ['copilot'],
  'Copilot CLI should become assignable once the manager exposes the Copilot harness',
);

assert.deepEqual(
  offerableRuntimes([], 'grok', [{ runtime: 'grok', installed: true, loggedIn: false, statusSupported: false }]),
  ['grok'],
  'current unsupported assignments should remain visible for review and migration',
);

assert.equal(
  managedRuntimeHasEvidence({ runtime: 'q', installed: true, loggedIn: true, statusSupported: true }),
  false,
  'legacy q should stay out of linked runtime lanes even if installed',
);

console.log('[runtimeCatalog.test] OK');
