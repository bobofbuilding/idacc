import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction } from 'ethers';
import { createAgentPrivateKey, ethereumAddressForPrivateKey, signEip1559Transaction, signEvmDigest } from '../src/shared/agentSigner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vault = readFileSync(join(root, 'src/main/agentSignerVault.ts'), 'utf8');
const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8');

const privateKey = createAgentPrivateKey();
const publicKey = secp256k1.getPublicKey(privateKey, false);
const digest = new Uint8Array(32).fill(7);
const signature = signEvmDigest(privateKey, digest);
assert.match(ethereumAddressForPrivateKey(privateKey), /^0x[0-9a-f]{40}$/);
assert.match(signature, /^0x[0-9a-f]{130}$/);
assert.equal(secp256k1.verify(signature.slice(2, 130), digest, publicKey, { prehash: false, lowS: true }), true);
const signedTransaction = signEip1559Transaction(privateKey, {
  chainId: 11155111,
  nonce: 3,
  to: '0x1111111111111111111111111111111111111111',
  data: '0x1234',
  valueWei: '0',
  gasLimit: '100000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
});
const parsedTransaction = Transaction.from(signedTransaction.rawTransaction);
assert.equal(parsedTransaction.from?.toLowerCase(), ethereumAddressForPrivateKey(privateKey).toLowerCase());
assert.equal(parsedTransaction.hash, signedTransaction.hash);
assert.equal(parsedTransaction.chainId, 11155111n);
privateKey.fill(0);

assert.match(vault, /safeStorage\.encryptString/);
assert.match(vault, /safeStorage\.decryptString/);
assert.match(vault, /mode: 0o600/);
assert.match(vault, /privateKey\.fill\(0\)/);
assert.doesNotMatch(vault, /privateKey:\s*string/);
assert.match(vault, /signAgentTransaction/);
assert.match(main, /id: 'signer-custody'/);

console.log('agent signer vault smoke: ok');
