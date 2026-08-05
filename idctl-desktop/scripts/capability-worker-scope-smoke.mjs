#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentsForCapabilityScope,
  capabilityScopeUsesHierarchy,
} from '../src/renderer/views/capabilityScope.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const agents = [
  { id: 'default-lead', name: 'lead', team: 'default' },
  { id: 'default-worker', name: 'coder', team: 'default' },
  { id: 'ops-lead', name: 'ops-lead', team: 'ops-team' },
  { id: 'ops-worker', name: 'maintainer', team: 'ops-team' },
  { id: 'research-lead', name: 'research-lead', team: 'research' },
  { id: 'research-worker', name: 'analyst', team: 'research' },
  { id: 'unknown-worker', name: 'orphan', team: 'unknown-team' },
];
const coordinators = { default: 'lead', 'ops-team': 'ops-lead', research: 'research-lead' };

assert.equal(capabilityScopeUsesHierarchy('workers'), true);
assert.deepEqual(
  agentsForCapabilityScope('workers', agents, agents.slice(0, 2), coordinators).map((agent) => agent.id),
  ['ops-worker', 'research-worker'],
  'worker scope must exclude default-team agents, team leads, and teams without a verified coordinator',
);
assert.deepEqual(
  agentsForCapabilityScope('leads', agents, agents.slice(0, 2), coordinators).map((agent) => agent.id),
  ['default-lead', 'ops-lead', 'research-lead'],
);

const modules = readFileSync(join(root, 'src', 'renderer', 'views', 'Modules.tsx'), 'utf8');
const bridge = readFileSync(join(root, 'src', 'main', 'bridge.ts'), 'utf8');
const tauri = readFileSync(join(root, 'src', 'tauri', 'adapter.ts'), 'utf8');
const client = readFileSync(join(root, '..', 'idctl', 'src', 'api', 'client.ts'), 'utf8');
assert.match(
  modules,
  /'setAgentMcp',[\s\S]{0,160}plan\.agent\.id,[\s\S]{0,120}plan\.team,[\s\S]{0,80}plan\.before/,
  'transactional MCP attach/detach writes must include the exact freshly reviewed server snapshot',
);
assert.match(
  modules,
  /rebuild remains available after detaching the final server/,
  'the rebuild affordance must remain after the final MCP attachment is removed',
);
assert.match(bridge, /expectedServers\?: McpServerSpec\[\]/);
assert.match(bridge, /rendererAgentMcpStamp\(expectedServers\) !== rendererAgentMcpStamp\(currentReviewed\)/);
assert.match(bridge, /setAgentMcp\(String\(agentId\), desiredExact, currentReviewed\)/);
assert.match(bridge, /setAgentMcp:[\s\S]{0,180}serializeMcpRegistryWrite/);
assert.match(bridge, /hydrateRequiredRegisteredMcp/);
assert.match(tauri, /tauriRendererAgentMcpStamp\(expectedServers\) !== tauriRendererAgentMcpStamp\(currentReviewed\)/);
assert.match(tauri, /setAgentMcp:[\s\S]{0,260}serializeTauriMcpRegistryWrite/);
assert.match(tauri, /result: sanitizeSecretPayload\(result\)/);
assert.match(client, /\.\.\.\(Array\.isArray\(expectedServers\) \? \{ expectedServers \} : \{\}\)/);
assert.match(
  modules,
  /Restored \$\{restored\}\/\$\{completed\.length\} confirmed earlier write/,
  'multi-target MCP failures must report transactional rollback of confirmed writes',
);
assert.match(
  modules,
  /Remove MCP server "\$\{name\}" everywhere\?/,
  'registry removal must explicitly review fleet-wide detach semantics',
);
const removalStart = modules.indexOf('async function removeMcpProfile');
const removalEnd = modules.indexOf('async function rebuildTargets', removalStart);
const removalFlow = modules.slice(removalStart, removalEnd);
assert.ok(removalStart >= 0 && removalEnd > removalStart, 'MCP removal flow must exist');
assert.ok(
  removalFlow.indexOf("'setAgentMcp'") < removalFlow.indexOf("'rebuildAgent'")
    && removalFlow.indexOf("'rebuildAgent'") < removalFlow.indexOf("'mcp:remove'"),
  'the registry entry must be removed only after attached agent copies are detached and rebuilt',
);
assert.match(
  removalFlow,
  /requireComplete: true/,
  'destructive registry removal must use a complete all-team snapshot',
);
assert.match(
  removalFlow,
  /automatic rollback needs Repair/,
  'partial fleet detach failures must remain visible and repairable',
);
assert.match(
  bridge,
  /strictAllTeamAgentGroups\(\)[\s\S]{0,900}Registry removal was blocked/,
  'the main process must independently reject registry deletion while any agent copy remains',
);
assert.match(
  bridge,
  /force\s*\?\s*await client\.categorizeSkillsAI[\s\S]{0,240}heuristicSkillTags/,
  'only explicit forced re-tagging may dispatch AI; first-load categorization must use the offline heuristic',
);
assert.match(
  modules,
  /may use metered or billable provider capacity/,
  'explicit AI re-tagging must disclose possible provider cost before dispatch',
);
for (const [surface, source] of [
  ['Modules', modules],
  ['desktop bridge', bridge],
  ['Tauri adapter', tauri],
]) {
  assert.doesNotMatch(
    source,
    /idacc-context-retrieval|headroom:pluginPath|headroom:backendContract/,
    `${surface} must not synthesize or expose the retired retrieval pilot`,
  );
}

console.log('capability worker scope smoke: ok');
