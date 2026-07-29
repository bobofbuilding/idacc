import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction } from 'ethers';
import { createAgentPrivateKey, ethereumAddressForPrivateKey, signEip1559Transaction, signEvmDigest } from '../src/shared/agentSigner.ts';
import { agentSignerVaultPathForConfig } from '../src/main/profileStatePaths.ts';
import { evaluateSecureStorageBackend, secureStorageStatus } from '../src/main/secureStoragePolicy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vault = readFileSync(join(root, 'src/main/agentSignerVault.ts'), 'utf8');
const main = readFileSync(join(root, 'src/main/main.ts'), 'utf8');
const appProfile = readFileSync(join(root, 'src/main/appProfile.ts'), 'utf8');
const identity = readFileSync(join(root, 'src/renderer/views/Identity.tsx'), 'utf8');

const privateKey = createAgentPrivateKey();
const publicKey = secp256k1.getPublicKey(privateKey, false);
const digest = new Uint8Array(32).fill(7);
const signature = signEvmDigest(privateKey, digest);
assert.match(ethereumAddressForPrivateKey(privateKey), /^0x[0-9a-f]{40}$/);
assert.match(signature, /^0x[0-9a-f]{130}$/);
assert.equal(
  secp256k1.verify(Buffer.from(signature.slice(2, 130), 'hex'), digest, publicKey, {
    prehash: false,
    lowS: true,
    format: 'compact',
  }),
  true,
);
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
assert.match(vault, /agentSignerVaultPathForConfig\(appProfilePaths\(\)\.config\)/);
assert.match(vault, /secureStorageStatus\(safeStorage\)/);
assert.doesNotMatch(vault, /app\.getPath\(['"]userData['"]\).*agent-signers/);
assert.match(appProfile, /legacyDesktopSignerVault:\s*join\(app\.getPath\('userData'\), 'keys', 'agent-signers\.json'\)/);
assert.match(
  appProfile,
  /allowLegacyImport:\s*selection\.profileName === 'default' && !selection\.explicitDataDir/,
);
assert.match(vault, /mode: 0o600/);
assert.match(vault, /privateKey\.fill\(0\)/);
assert.doesNotMatch(vault, /privateKey:\s*string/);
assert.match(vault, /signAgentTransaction/);
assert.match(main, /id: 'signer-custody'/);
assert.match(main, /secureStorageStatus\(safeStorage\)\.available/);
assert.match(identity, /profile-scoped agent signer keys are Electron safeStorage-encrypted/);
assert.match(identity, /Root-wallet and OWS custody stays external/);

const firstVault = agentSignerVaultPathForConfig(join('profiles', 'first', 'config', 'config.json'));
const secondVault = agentSignerVaultPathForConfig(join('profiles', 'second', 'config', 'config.json'));
assert.equal(firstVault, join('profiles', 'first', 'config', 'agent-signers.json'));
assert.equal(secondVault, join('profiles', 'second', 'config', 'agent-signers.json'));
assert.notEqual(firstVault, secondVault);

assert.deepEqual(
  evaluateSecureStorageBackend({
    platform: 'linux',
    encryptionAvailable: true,
    selectedBackend: 'basic_text',
  }),
  {
    available: false,
    backend: 'electron-safeStorage/Linux-basic_text',
    error: 'Linux safeStorage selected the insecure basic_text backend; configure Secret Service or KWallet and retry.',
  },
);
assert.deepEqual(
  evaluateSecureStorageBackend({
    platform: 'linux',
    encryptionAvailable: true,
    selectedBackend: 'gnome_libsecret',
  }),
  { available: true, backend: 'electron-safeStorage/Linux-Secret-Service' },
);
assert.equal(
  evaluateSecureStorageBackend({ platform: 'darwin', encryptionAvailable: true }).backend,
  'electron-safeStorage/macOS-Keychain',
);
assert.equal(
  evaluateSecureStorageBackend({ platform: 'win32', encryptionAvailable: true }).backend,
  'electron-safeStorage/Windows-DPAPI',
);
assert.equal(
  secureStorageStatus({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
  }, 'linux').available,
  false,
);

console.log('agent signer vault smoke: ok');
