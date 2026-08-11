#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const table = readFileSync(new URL('../src/renderer/views/AgentTable.tsx', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../idctl/src/api/client.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
const snapshot = readFileSync(new URL('../../idctl/src/settings/agentConfiguration.ts', import.meta.url), 'utf8');

const applyStart = table.indexOf('async function applyConfigDrafts()');
const applyEnd = table.indexOf('function confirmAgentChange(', applyStart);
assert.ok(applyStart >= 0 && applyEnd > applyStart, 'fleet table must expose the reviewed configuration apply flow');
const applyFlow = table.slice(applyStart, applyEnd);

assert.doesNotMatch(
  applyFlow,
  /status:\s*d\.status|current\.status\s*!==\s*d\.status/,
  'transient lifecycle status must not participate in the editable configuration compare-and-set',
);
assert.match(applyFlow, /const appliedKeys: string\[\] = \[\]/);
assert.match(applyFlow, /Object\.entries\(prev\)\.filter\(\(\[key\]\) => !applied\.has\(key\)\)/);
assert.match(table, /speed: storedAgentSpeed\(a\)/,
  'compare-and-set baselines must preserve the durable empty speed value');
assert.match(table, /normalizeSpeedPreference\(draft\?\.next\.speed \?\? storedAgentSpeed\(a\)\)/,
  'the speed picker must normalize durable empty speed only for display');
assert.match(snapshot, /metadataRuntime\?\.startsWith\('provider:'\)/,
  'provider lanes must match the Manager configuration snapshot');
assert.doesNotMatch(table, /autoRecommendedAgentKeys|if \(agent\.model\) continue/,
  'catalog loading must not silently stage model changes');
assert.match(table, /const runtimeCatalogVersion = useSyncVersion\(\['runtime-catalog'\]\)/,
  'runtime and model pickers must load the shared cache immediately');

for (const source of [client, bridge]) {
  const signatureStart = source.indexOf('applyAgentConfiguration(');
  const signature = source.slice(signatureStart, signatureStart + 900);
  assert.doesNotMatch(signature, /expected:[^\n]*status\?/, 'client contracts must not reintroduce status into the expected configuration');
}

console.log('agent configuration switching smoke: ok');
