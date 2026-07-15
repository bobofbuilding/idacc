import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, setWalletConnectSettings } from '../../idctl/src/settings/store.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'idacc-walletconnect-'));
const config = join(temp, 'config.json');
const projectId = '0123456789abcdef0123456789abcdef';

try {
  const saved = setWalletConnectSettings({ enabled: true, projectId }, config).walletConnect;
  assert.deepEqual(saved?.enabled, true);
  assert.equal(saved?.projectId, projectId);
  assert.equal(loadSettings(config).walletConnect?.projectId, projectId);
  assert.throws(
    () => setWalletConnectSettings({ enabled: true, projectId: 'not-a-project-id' }, config),
    /32 hexadecimal characters/,
  );

  const disk = readFileSync(config, 'utf8');
  assert.doesNotMatch(disk, /pairingUri|sessionTopic|privateKey|wc@2/);

  const settings = readFileSync(join(root, 'src/renderer/views/Settings.tsx'), 'utf8');
  const identity = readFileSync(join(root, 'src/renderer/views/Identity.tsx'), 'utf8');
  const connector = readFileSync(join(root, 'src/renderer/walletConnect.ts'), 'utf8');
  const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8');
  assert.ok(settings.indexOf('Root Safe connection') < settings.indexOf('Agent chain RPCs'));
  assert.match(settings, /routine agent transactions:[\s\S]*session keys/);
  assert.match(identity, /Root Safe Bootstrap Proposal/);
  assert.match(identity, /Routine agent transactions use the agent&apos;s own finite, spend-capped session keys/);
  assert.match(identity, /Provision Safe \+ authority/);
  assert.match(identity, /keys:assetGuard/);
  assert.match(identity, /Rotate authority/);
  assert.match(identity, /resolveRootSafeProvider/);
  assert.match(connector, /optionalNamespaces/);
  assert.match(connector, /accounts\.some\(\(account\) => sameAddress\(account, AGENT_BITTREES_SAFE_ADDRESS\)\)/);
  assert.match(connector, /abortPairingAttempt/);
  assert.doesNotMatch(connector, /setInterval|setTimeout/);
  assert.match(html, /connect-src 'self' https:\/\/\*\.walletconnect\.org/);

  console.log('walletconnect bootstrap smoke: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
