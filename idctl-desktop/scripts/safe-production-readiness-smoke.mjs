import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bridge = readFileSync(join(root, 'src/main/bridge.ts'), 'utf8');
const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8');
const tauri = readFileSync(join(root, 'src/tauri/adapter.ts'), 'utf8');
const identity = readFileSync(join(root, 'src/renderer/views/Identity.tsx'), 'utf8');
const manifest = readFileSync(join(root, '../idctl/src/keys/safeManifest.ts'), 'utf8');
const rehearsal = readFileSync(join(root, '../idctl/src/keys/safeRehearsal.ts'), 'utf8');

assert.match(bridge, /function requireLiveKeyProvider/);
for (const action of [
  'Safe account preparation',
  'Safe deployment',
  'Safe and initial authority provisioning',
  'Session authority issuance',
  'Session authority revocation',
  'Session authority rotation',
  'Agent authority revocation',
  'Agent authority restoration',
]) {
  assert.match(bridge, new RegExp(`requireLiveKeyProvider\\('${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`));
}

assert.match(main, /case 'keys:productionReadiness'/);
assert.match(main, /eth_getCode/);
assert.match(main, /0xa0e67e2b/); // Safe getOwners()
assert.match(main, /0xe75235b8/); // Safe getThreshold()
assert.match(main, /owners\.length >= 2 && threshold >= 2/);
assert.match(main, /id: 'module-attestation'/);
assert.match(main, /verifySafeModuleManifest/);
assert.match(main, /id: 'authority-module-stability'/);
assert.match(main, /id: 'asset-inspection'/);
assert.match(main, /verifySafeRehearsal/);
assert.match(main, /eth_getTransactionReceipt/);
assert.match(main, /id: 'testnet-rehearsal'/);
assert.match(manifest, /safe-1\.4\.1-zodiac-roles-v2\.1/);
assert.match(manifest, /stability: 'stable'/);
assert.match(manifest, /Zodiac Roles Modifier v2\.1/);
assert.match(manifest, /contractVersion: '2\.1\.1'/);
assert.match(manifest, /Zodiac ModuleProxyFactory 3\.0\.1/);
assert.match(manifest, /Safe 1\.4\.1 MultiSendCallOnly/);
assert.match(manifest, /EXPERIMENTAL_ERC7579_CANDIDATE/);
assert.match(manifest, /runtimeCodeHashByChain/);
assert.match(rehearsal, /SAFE_REHEARSAL_STEPS = \['create', 'scoped-action', 'rotate', 'asset-guard', 'revoke'\]/);
assert.match(rehearsal, /safe-rehearsal\.json/);

assert.match(tauri, /'keys:productionReadiness'/);
assert.match(tauri, /simulation-only Tauri adapter/);
assert.match(identity, /Production release gate/);
assert.match(identity, /const contractCanSubmit = \(productionReady \|\| thresholdRepairPrepared\)/);
assert.match(identity, /Prepare threshold 2/);
assert.match(identity, /!productionReady && !thresholdRepair/);
assert.match(identity, /disabled=\{busy \|\| !productionReady/);

console.log('safe production readiness smoke: ok');
