import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configuredRootIdentity,
  defaultRootIdentitySettings,
  LOCAL_AGENT_IDENTITY_ROOT,
} from '../../idctl/src/settings/schema.ts';
import {
  loadSettings,
  setRootIdentitySettings,
} from '../../idctl/src/settings/store.ts';

const temp = mkdtempSync(join(tmpdir(), 'idacc-root-identity-'));
const config = join(temp, 'config.json');
const safeAddress = '0x1111111111111111111111111111111111111111';

try {
  const fresh = loadSettings(config).rootIdentity;
  assert.deepEqual(fresh, defaultRootIdentitySettings());
  assert.equal(fresh?.enabled, false);
  assert.equal(fresh?.ensRoot, LOCAL_AGENT_IDENTITY_ROOT);
  assert.equal(fresh?.safeAddress, '');
  assert.equal(configuredRootIdentity(fresh), null);

  assert.throws(
    () => setRootIdentitySettings({ enabled: true, ensRoot: 'not-ens', safeAddress }, config),
    /ENS root ending in \.eth/,
  );
  assert.throws(
    () => setRootIdentitySettings({ enabled: true, ensRoot: 'agents.example.eth', safeAddress: '0x1234' }, config),
    /20-byte 0x EVM Safe address/,
  );
  assert.throws(
    () => setRootIdentitySettings({ enabled: true, ensRoot: 'agents.example.eth', safeAddress, chainId: 8453 }, config),
    /Ethereum mainnet/,
  );

  const enabled = setRootIdentitySettings({
    enabled: true,
    ensRoot: 'Agents.Example.ETH.',
    safeAddress,
    chainId: 1,
  }, config).rootIdentity;
  assert.equal(enabled?.enabled, true);
  assert.equal(enabled?.ensRoot, 'agents.example.eth');
  assert.equal(enabled?.safeAddress, safeAddress);
  assert.deepEqual(configuredRootIdentity(enabled), { ...enabled, enabled: true });

  const disabled = setRootIdentitySettings({ enabled: false }, config).rootIdentity;
  assert.equal(disabled?.enabled, false);
  assert.equal(configuredRootIdentity(disabled), null);
  assert.equal(disabled?.safeAddress, safeAddress, 'disabling should preserve the operator-owned identity for an explicit re-enable');

  writeFileSync(config, JSON.stringify({
    version: 1,
    managers: [],
    providers: [],
    rootIdentity: {
      enabled: true,
      ensRoot: 'invalid.local',
      safeAddress: '0x1234',
      chainId: 1,
    },
  }));
  const invalid = loadSettings(config).rootIdentity;
  assert.equal(invalid?.enabled, false, 'hand-edited invalid identity must load fail-closed');
  assert.equal(configuredRootIdentity(invalid), null);

  const disk = readFileSync(config, 'utf8');
  assert.doesNotMatch(disk, /bittrees/i);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('root identity settings smoke: ok');
