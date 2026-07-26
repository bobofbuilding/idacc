import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computerUseRuntimeEligible,
  mapComputerUsePoint,
  selectComputerUseDisplay,
  validateComputerUseFrame,
} from '../src/shared/computerUsePolicy.ts';

assert.equal(computerUseRuntimeEligible('claude-code-cli'), true);
assert.equal(computerUseRuntimeEligible('codex'), true);
assert.equal(computerUseRuntimeEligible('ollama'), true);
assert.equal(computerUseRuntimeEligible('cursor-cli'), false);
assert.equal(computerUseRuntimeEligible('made-up-claude-runtime'), false);

const displays = [
  { id: 10, primary: true, label: 'Primary' },
  { id: 20, label: 'Studio' },
];
assert.equal(selectComputerUseDisplay(displays, 20, 10)?.id, 20);
assert.equal(selectComputerUseDisplay(displays, 99, 10)?.id, 10);
assert.equal(selectComputerUseDisplay([], 10, 10), null);

const frame = {
  agent: 'default:alice',
  displayId: 20,
  width: 2000,
  height: 1000,
  bounds: { x: -1000, y: 100, width: 1000, height: 500 },
  scaleFactor: 2,
  capturedAt: 1_000_000,
};
const geometry = {
  id: 20,
  bounds: { ...frame.bounds },
  scaleFactor: 2,
};
assert.deepEqual(validateComputerUseFrame(frame, 'default:alice', geometry, 1_030_000), { ok: true });
assert.equal(validateComputerUseFrame(frame, 'default:bob', geometry, 1_030_000).ok, false);
assert.equal(validateComputerUseFrame(frame, 'default:alice', { ...geometry, id: 10 }, 1_030_000).ok, false);
assert.equal(validateComputerUseFrame(frame, 'default:alice', geometry, 1_060_001).ok, false);
assert.deepEqual(mapComputerUsePoint(frame, 1000, 500), { ok: true, gx: -500, gy: 350 });
assert.deepEqual(mapComputerUsePoint(frame, 2000, 500), { ok: false });
assert.deepEqual(mapComputerUsePoint(frame, 1000, 1000), { ok: false });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const view = readFileSync(join(root, 'src', 'renderer', 'views', 'ComputerUse.tsx'), 'utf8');
const broker = readFileSync(join(root, 'src', 'main', 'computeruse', 'broker.ts'), 'utf8');
const capture = readFileSync(join(root, 'src', 'main', 'computeruse', 'capture.ts'), 'utf8');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');

assert.doesNotMatch(view, /function mcpCapable|\/claude\|codex\//);
assert.match(view, /computerUseRuntimeEligible\(agentRuntime\(a\)\)/);
assert.match(view, /attachment was rolled back/);
assert.match(view, />Repair<\/button>/);
assert.match(view, /cu:setDisplay/);
assert.match(broker, /export function setBrokerDisplay/);
assert.match(broker, /captureDisplay\(S\.displayId/);
assert.match(broker, /S\.lastShot !== actionShot/);
assert.match(broker, /flushPending\(false\)/);
assert.match(capture, /screen\.getAllDisplays\(\)/);
assert.match(main, /case 'cu:setDisplay'/);

console.log('computer use policy smoke: ok');
