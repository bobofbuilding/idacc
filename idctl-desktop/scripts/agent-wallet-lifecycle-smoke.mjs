import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'idacc-agent-wallet-'));
process.env.XDG_CONFIG_HOME = root;

try {
  const {
    ROOT_AGENT_SAFE_ADDRESS,
    agentEnsLabel,
    agentEnsName,
  } = await import('../../idctl/src/keys/types.ts');
  const { MockKeyProvider } = await import('../../idctl/src/keys/mockProvider.ts');

  assert.equal(agentEnsLabel('default:Research Lead'), 'research-lead');
  assert.equal(agentEnsName('default:Research Lead'), 'research-lead.agent.bittrees.eth');

  const provider = new MockKeyProvider();
  await assert.rejects(
    provider.provisionAccount('default:unsafe', { label: 'full', targets: ['*'], spendLimitWei: '0' }, 0),
    /finite, scoped, and spend-capped/,
  );
  const bundled = await provider.provisionAccount(
    'default:researcher',
    { label: 'research', targets: ['0x2222222222222222222222222222222222222222'], spendLimitWei: '2' },
    60_000,
  );
  assert.equal(bundled.reused, false);
  assert.equal(bundled.account.deployed, true);
  assert.equal(bundled.account.status, 'active');
  assert.equal(bundled.account.sessions.length, 1);
  const bundledAgain = await provider.provisionAccount(
    'default:researcher',
    { label: 'research', targets: ['0x2222222222222222222222222222222222222222'], spendLimitWei: '2' },
    60_000,
  );
  assert.equal(bundledAgain.reused, true);
  assert.equal(bundledAgain.account.sessions.length, 1, 'provision retries must not duplicate authority');
  const replacement = await provider.rotateSession(
    'default:researcher',
    bundled.session.id,
    { label: 'research-v2', targets: ['0x3333333333333333333333333333333333333333'], spendLimitWei: '3' },
    120_000,
  );
  const rotated = (await provider.listAccounts(['default:researcher']))[0];
  assert.equal(replacement.status, 'active');
  assert.equal(rotated.sessions.find((row) => row.id === bundled.session.id)?.status, 'revoked');
  assert.equal(rotated.sessions.filter((row) => row.status === 'active').length, 1);
  const assets = await provider.inspectAssets('default:researcher');
  assert.equal(assets.status, 'clear');
  assert.equal(assets.source, 'mock');

  const draft = await provider.ensureAccount('default:coder');
  assert.equal(draft.ensName, 'coder.agent.bittrees.eth');
  assert.equal(draft.owner, ROOT_AGENT_SAFE_ADDRESS);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.deployed, false);
  await assert.rejects(
    provider.issueSession('default:coder', { label: 'coding', targets: ['0x1111111111111111111111111111111111111111'], spendLimitWei: '1' }, 60_000),
    /deployed and active/,
  );

  const deployed = await provider.deployAccount('default:coder');
  assert.equal(deployed.status, 'active');
  const session = await provider.issueSession(
    'default:coder',
    { label: 'coding', targets: ['0x1111111111111111111111111111111111111111'], spendLimitWei: '1' },
    60_000,
  );
  assert.equal(session.status, 'active');

  const revoked = await provider.revokeAccount('default:coder');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.smartAccount, draft.smartAccount);
  assert.equal(revoked.ensName, draft.ensName);
  assert.equal(revoked.sessions[0]?.status, 'revoked');

  const restored = await provider.restoreAccount('default:coder');
  assert.equal(restored.status, 'active');
  assert.equal(restored.sessions[0]?.status, 'revoked');
  assert.equal(restored.smartAccount, draft.smartAccount);

  const persisted = JSON.parse(readFileSync(join(root, 'idctl', 'keys-mock.json'), 'utf8'));
  assert.equal(persisted.accounts['default:coder'].ensName, 'coder.agent.bittrees.eth');
  assert.equal(persisted.accounts['default:coder'].owner, ROOT_AGENT_SAFE_ADDRESS);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('agent wallet lifecycle smoke: ok');
