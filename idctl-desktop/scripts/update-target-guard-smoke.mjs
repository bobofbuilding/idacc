import assert from 'node:assert/strict';
import { evaluateUpdateTarget } from '../src/shared/updateTarget.ts';

assert.deepEqual(
  evaluateUpdateTarget({ isPackaged: true, bundlePath: '/Applications/ID Agents Control Center.app', appAsarExists: true }),
  { ok: true },
);
assert.match(
  evaluateUpdateTarget({ isPackaged: false, bundlePath: '/tmp/dev', appAsarExists: false }).reason || '',
  /packaged application build/,
);
assert.match(
  evaluateUpdateTarget({ isPackaged: true, bundlePath: '/tmp/app', appAsarExists: true }).reason || '',
  /macOS application bundle/,
);
assert.match(
  evaluateUpdateTarget({ isPackaged: true, bundlePath: '/Applications/ID Agents Control Center.app', appAsarExists: false }).reason || '',
  /app\.asar is missing/,
);

console.log('update target guard smoke: ok');
