import assert from 'node:assert/strict';
import {
  agentConfigurationRuntime,
  effectiveAgentSpeed,
  storedAgentSpeed,
} from './agentConfiguration.ts';

assert.equal(storedAgentSpeed({}), '');
assert.equal(effectiveAgentSpeed({}), 'default');
assert.equal(storedAgentSpeed({ metadata: { speed: 'fast' } }), 'fast');
assert.equal(effectiveAgentSpeed({ metadata: { speed: 'fast' } }), 'fast');

// The UI must send the durable empty value as its expected snapshot. Sending
// the displayed value "default" produces a false 409 conflict in Manager.
const expected = { speed: storedAgentSpeed({}) };
const current = { speed: '' };
const staleFields = Object.entries(current)
  .filter(([key, value]) => Object.hasOwn(expected, key) && String(expected[key as keyof typeof expected] ?? '') !== String(value ?? ''))
  .map(([key]) => key);
assert.deepEqual(staleFields, []);

assert.equal(
  agentConfigurationRuntime({ runtime: 'provider-api', metadata: { runtime: 'provider:local%20lane' } }),
  'provider:local%20lane',
);
assert.equal(
  agentConfigurationRuntime({ runtime: 'codex', metadata: { runtime: 'legacy-display-value' } }),
  'codex',
);
assert.equal(agentConfigurationRuntime({ metadata: { runtime: 'codex' } }), 'codex');

console.log('agent configuration snapshot tests passed');
