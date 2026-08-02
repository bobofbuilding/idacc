import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyComputerUseRisk,
  computerUseActionNeedsApproval,
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

assert.equal(computerUseActionNeedsApproval('supervised', 'mouse_move', { x: 1, y: 1 }), true);
assert.equal(computerUseActionNeedsApproval('guarded', 'mouse_move', { x: 1, y: 1 }), false);
assert.equal(computerUseActionNeedsApproval('guarded', 'key', { keys: 'cmd+q' }), true);
assert.equal(computerUseActionNeedsApproval('guarded', 'type', { text: 'sudo rm -rf /tmp/example' }), true);
assert.equal(computerUseActionNeedsApproval('full-control', 'key', { keys: 'cmd+q' }), false);
assert.equal(computerUseActionNeedsApproval('full-control', 'type', { text: 'sudo rm -rf /tmp/example' }), false);
assert.equal(classifyComputerUseRisk('type', { text: 'npm run build' }).risky, false);

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
const permissions = readFileSync(join(root, 'src', 'main', 'computeruse', 'permissions.ts'), 'utf8');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
const mcp = readFileSync(join(root, 'resources', 'computeruse-mcp', 'server.mjs'), 'utf8');

assert.doesNotMatch(view, /function mcpCapable|\/claude\|codex\//);
assert.match(view, /computerUseRuntimeEligible\(agentRuntime\(a\)\)/);
assert.match(view, /buildFleetStructureSnapshot\(/);
assert.match(view, /Full-control readiness/);
assert.match(view, /setControlMode\('full-control'\)/);
assert.match(view, /Disarming or PANIC automatically returns to Approve every action/);
assert.match(view, /partial session was disarmed/);
assert.match(view, /attachment was rolled back/);
assert.match(view, />Repair<\/button>/);
assert.match(view, /cu:setDisplay/);
assert.match(broker, /export function setBrokerDisplay/);
assert.match(broker, /captureDisplay\(S\.displayId/);
assert.match(broker, /S\.lastShot !== actionShot/);
assert.match(broker, /computerUseActionNeedsApproval\(S\.controlMode, type, body\)/);
assert.match(broker, /export function setFullControl/);
assert.match(broker, /S\.controlMode = 'supervised'/);
assert.match(broker, /!S\.armed \|\| !S\.blessed\.size/);
assert.match(broker, /rec\(agent, type, `\$\{f\.display\.label\} \$\{f\.width\}×\$\{f\.height\}`, 'executed'\)/);
assert.match(broker, /The bundled Computer Use controller is not staged/);
assert.match(broker, /flushPending\(false\)/);
assert.match(capture, /screen\.getAllDisplays\(\)/);
assert.match(main, /case 'cu:setDisplay'/);
assert.match(main, /case 'cu:setFullControl'/);
assert.match(main, /Computer Use safety mode changed before this request/);
assert.match(main, /Computer Use pause state changed before this request/);
assert.match(main, /if \(!result\.ok\) throw new Error\(result\.error/);
assert.match(mcp, /name: 'computer_middle_click'/);
assert.match(mcp, /explicit Full control session grant/);
assert.match(broker, /process\.platform === 'darwin'/);
assert.match(broker, /available: false/);
assert.match(broker, /Windows\/Linux review build does not include the macOS screen-control driver/);
assert.match(view, /if \(cuUnavailable\)/);
assert.match(view, /Unavailable on this operating system/);
assert.match(view, /permission links, and agent blessing are not started or shown here/);
assert.match(permissions, /if \(process\.platform !== 'darwin'\)/);

console.log('computer use policy smoke: ok');
