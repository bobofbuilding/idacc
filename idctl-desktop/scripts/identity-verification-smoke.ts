import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENS_ADDR_SELECTOR,
  ENS_RESOLVER_SELECTOR,
  classifyEnsBinding,
  classifyIdentityStandardEvidence,
  decodeAbiAddress,
  encodeEnsCall,
  ensNamehash,
  hasRuntimeCode,
  identityRegisterNoop,
} from '../src/shared/identityVerification.ts';

assert.equal(
  ensNamehash('eth'),
  '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae',
);
assert.match(encodeEnsCall(ENS_RESOLVER_SELECTOR, 'alice.eth'), /^0x0178b8bf[0-9a-f]{64}$/);
assert.match(encodeEnsCall(ENS_ADDR_SELECTOR, 'alice.eth'), /^0x3b3b57de[0-9a-f]{64}$/);
assert.equal(
  decodeAbiAddress(`0x${'0'.repeat(24)}1234567890abcdef1234567890abcdef12345678`),
  '0x1234567890abcdef1234567890abcdef12345678',
);
assert.equal(decodeAbiAddress(`0x${'0'.repeat(64)}`), null);
assert.equal(hasRuntimeCode('0x60006000'), true);
assert.equal(hasRuntimeCode('0x'), false);
const resolved = '0x1234567890abcdef1234567890abcdef12345678';
assert.equal(classifyEnsBinding(resolved, []), 'unbound');
assert.equal(classifyEnsBinding(resolved, [resolved.toUpperCase().replace('0X', '0x')]), 'verified');
assert.equal(classifyEnsBinding(resolved, ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd']), 'mismatch');
assert.equal(classifyEnsBinding('', [resolved]), 'missing');
const declaredDraftStandards = classifyIdentityStandardEvidence({
  hasAgent: true,
  hasDomain: true,
  hasWallet: true,
  hasSmartAccount: true,
  ensBindingVerified: true,
  ensip24Declared: true,
  erc8004Declared: true,
  erc8048Declared: true,
  erc8049Declared: true,
  b20Declared: true,
});
assert.deepEqual(declaredDraftStandards, {
  ensBinding: 'verified',
  ensip24: 'self',
  erc8004: 'self',
  erc8048: 'self',
  erc8049: 'self',
  b20: 'self',
});
assert.deepEqual(
  Object.entries(declaredDraftStandards).filter(([, state]) => state === 'verified').map(([standard]) => standard),
  ['ensBinding'],
  'verified ENS binding and generic contract evidence must not promote draft standards',
);
assert.deepEqual(identityRegisterNoop({
  id: 'a',
  name: 'alice',
  port: 1,
  status: 'running',
  createdAt: 1,
  metadata: { idchain_domain: 'alice.example.eth' },
}), { noop: true, domain: 'alice.example.eth' });
assert.deepEqual(identityRegisterNoop(undefined), { noop: false });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readFileSync(join(root, 'src', 'main', 'bridge.ts'), 'utf8');
const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
const view = readFileSync(join(root, 'src', 'renderer', 'views', 'Identity.tsx'), 'utf8');
assert.match(bridge, /const registration = identityRegisterNoop\(current\)/);
assert.match(bridge, /noop: true, changed: false/);
assert.match(bridge, /signature: '', verifiedAt: Date\.now\(\)/);
assert.match(main, /case 'identity:verifyEvidence'/);
assert.match(main, /ENS_REGISTRY_ADDRESS/);
assert.match(main, /binding === 'unbound'/);
assert.match(main, /state: 'unavailable' as const/);
assert.match(view, /Verify live evidence/);
assert.match(view, /Manager record/);
assert.match(view, /Declared contract/);
assert.match(view, /no duplicate transaction was sent/);
assert.match(view, /Onchain identity &amp; metadata evidence/);
assert.match(view, /ENS address binding is verified separately/);
assert.match(view, /Generic bytecode never proves conformance to a draft metadata standard/);
assert.match(view, /versioned attestation schema and trust roots/);

console.log('identity verification smoke: ok');
