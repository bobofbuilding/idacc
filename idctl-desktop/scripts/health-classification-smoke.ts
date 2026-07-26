import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAgentAvailability,
  classifyThroughputSample,
  isAgentProbeEligible,
} from '../src/shared/healthClassification.ts';
import { statusClass } from '../src/renderer/agentStatus.ts';

assert.equal(classifyAgentAvailability({ status: 'running' }), 'running');
assert.equal(classifyAgentAvailability({ status: 'rebuilding' }), 'transitional');
assert.equal(classifyAgentAvailability({ status: 'offline' }), 'stopped');
assert.equal(classifyAgentAvailability({ status: 'mystery-state' }), 'unknown');
assert.equal(isAgentProbeEligible({ status: 'mystery-state' }), false);
assert.equal(statusClass({ status: 'mystery-state' }), 'warn');
assert.equal(statusClass({ status: 'offline' }), 'err');
assert.equal(statusClass({ status: '', health: 'healthy' }), 'ok');
assert.equal(isAgentProbeEligible({ status: '', health: 'healthy' }), true);
assert.equal(classifyAgentAvailability({ status: 'running', health: 'offline' }), 'stopped');
assert.equal(isAgentProbeEligible({ status: '', deploymentShape: 'local-process', pid: 42 }), false);
assert.equal(
  isAgentProbeEligible({
    status: '',
    deploymentShape: 'remote-endpoint',
    last_seen: 1_000_000,
    last_probed_at: 1_000_000,
    consecutive_failures: 0,
  }, 1_000_000_000 + 60_000),
  true,
);
assert.equal(
  isAgentProbeEligible({
    status: '',
    deploymentShape: 'remote-endpoint',
    last_seen: 1_000_000,
    last_probed_at: 1_000_000,
    consecutive_failures: 1,
  }, 1_000_000_000 + 60_000),
  false,
);
assert.equal(
  isAgentProbeEligible({
    status: '',
    deploymentShape: 'remote-endpoint',
    last_seen: 2_000_000,
    last_probed_at: 2_000_000,
    consecutive_failures: 0,
  }, 1_000_000_000),
  false,
  'an implausibly future last_seen value must not prove liveness',
);
assert.equal(
  isAgentProbeEligible({
    status: '',
    deploymentShape: 'remote-endpoint',
    last_seen: 1_000_000,
    consecutive_failures: 0,
  }, 1_000_000_000 + 60_000),
  false,
  'last_seen without a fresh structured probe must not prove liveness',
);

assert.equal(classifyThroughputSample(18, 900_000, 3, 1_000_000), 'fresh-harness-sample');
assert.equal(classifyThroughputSample(18, 1, 3, 1_000_000), 'harness-24h-average');
assert.equal(classifyThroughputSample(18, 1_000_001, 3, 1_000_000), 'harness-24h-average');
assert.equal(classifyThroughputSample(-1, 900_000, 3, 1_000_000), 'harness-24h-average');
assert.equal(classifyThroughputSample(undefined, undefined, 0, 1_000_000), 'no-harness-telemetry');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const healthView = readFileSync(join(root, 'src', 'renderer', 'views', 'Health.tsx'), 'utf8');
assert.match(healthView, />harness telemetry</);
assert.match(healthView, /performance telemetry, not provider billing/);
assert.match(healthView, /fresh harness sample/);
assert.match(healthView, /24h harness average/);

console.log('health classification smoke: ok');
