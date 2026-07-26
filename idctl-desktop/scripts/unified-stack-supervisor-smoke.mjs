import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalLoopbackServiceUrl,
  BRAIN_LISTENER_STATUS_MAX_BYTES,
  readBrainListenerStatusFile,
  parseRuntimeManifest,
  restartDelayMs,
  rotateServiceLog,
  shouldOpenCrashFuse,
  validateServiceHealth,
  validateBrainListenerStatus,
  manifestDigestMatches,
  runtimeManifestSha256,
  verifyRuntimePayload,
} from '../src/main/unifiedStackPolicy.ts';
import {
  defaultBrainAutomationSettings,
  normalizeBrainAutomationSettings,
} from '../../idctl/src/settings/schema.ts';
import {
  loadSettings,
  setBrainAutomationSettings,
} from '../../idctl/src/settings/store.ts';

assert.deepEqual(defaultBrainAutomationSettings(), {
  cycleEnabled: false,
  cycleCadenceHours: 24,
});
assert.deepEqual(normalizeBrainAutomationSettings(), {
  cycleEnabled: false,
  cycleCadenceHours: 24,
});
assert.deepEqual(normalizeBrainAutomationSettings({
  cycleEnabled: false,
  cycleCadenceHours: 72,
}), {
  cycleEnabled: false,
  cycleCadenceHours: 72,
});
assert.deepEqual(normalizeBrainAutomationSettings({
  cycleEnabled: true,
  cycleCadenceHours: 0,
}), {
  cycleEnabled: true,
  cycleCadenceHours: 24,
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (record, path = record.path) => JSON.stringify({
  path,
  type: record.type,
  size: record.size,
  sha256: record.sha256,
  ...(record.type === 'symlink' ? { target: record.target } : {}),
});
const treeHash = (records, prefix = '') => {
  const normalized = prefix ? `${prefix}/` : '';
  const lines = records
    .filter((record) => !normalized || record.path.startsWith(normalized))
    .map((record) => canonical(record, normalized ? record.path.slice(normalized.length) : record.path))
    .join('\n');
  return sha256(lines ? `${lines}\n` : '');
};
const fixtureFiles = [
  { path: 'brain/brain.mjs', type: 'file', size: 0, sha256: sha256('') },
  { path: 'manager/dist/start-agent-manager.js', type: 'file', size: 0, sha256: sha256('') },
];
const manifestValue = {
  schemaVersion: 2,
  generatedAt: '2026-07-25T00:00:00.000Z',
  application: {
    name: 'idagents-control-center',
    version: '1.0.0',
    commit: '7'.repeat(40),
    tree: '8'.repeat(40),
    dirty: false,
  },
  components: {
    manager: {
      repository: 'https://example.com/manager.git',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      version: '1.2.3',
      packageLockSha256: '3'.repeat(64),
      entrypoint: 'dist/start-agent-manager.js',
      serviceId: 'idacc-manager',
    },
    brain: {
      repository: 'https://example.com/brain.git',
      commit: '4'.repeat(40),
      tree: '5'.repeat(40),
      version: '4.5.6',
      packageLockSha256: '6'.repeat(64),
      entrypoint: 'brain.mjs',
      serviceId: 'idacc-brain',
    },
  },
  trees: {
    manager: treeHash(fixtureFiles, 'manager'),
    brain: treeHash(fixtureFiles, 'brain'),
    runtime: treeHash(fixtureFiles),
  },
  files: fixtureFiles,
};
const manifest = parseRuntimeManifest(manifestValue);
assert.equal(manifest.components.manager.version, '1.2.3');
const npmBinTarget = '../which/bin/node-which';
const symlinkFixtureFiles = [
  ...fixtureFiles,
  {
    path: 'brain/node_modules/.bin/node-which',
    type: 'symlink',
    size: Buffer.byteLength(npmBinTarget),
    sha256: sha256(`symlink\0${npmBinTarget}`),
    target: npmBinTarget,
  },
].sort((left, right) => left.path.localeCompare(right.path));
const symlinkManifestValue = {
  ...manifestValue,
  trees: {
    manager: treeHash(symlinkFixtureFiles, 'manager'),
    brain: treeHash(symlinkFixtureFiles, 'brain'),
    runtime: treeHash(symlinkFixtureFiles),
  },
  files: symlinkFixtureFiles,
};
assert.equal(
  parseRuntimeManifest(symlinkManifestValue).files
    .find((record) => record.type === 'symlink')?.target,
  npmBinTarget,
  'production manifest parsing must accept npm .bin links that remain inside the runtime root',
);
for (const unsafeTarget of [
  '../../../../outside-runtime',
  '/tmp/outside-runtime',
  'C:/outside-runtime',
  '..\\outside-runtime',
]) {
  assert.throws(
    () => parseRuntimeManifest({
      ...symlinkManifestValue,
      files: symlinkFixtureFiles.map((record) => (
        record.type === 'symlink'
          ? {
              ...record,
              target: unsafeTarget,
              size: Buffer.byteLength(unsafeTarget),
              sha256: sha256(`symlink\0${unsafeTarget}`),
            }
          : record
      )),
    }),
    /files\[\d+\] is invalid/,
    `production manifest parsing must reject unsafe symlink target ${unsafeTarget}`,
  );
}
assert.throws(
  () => parseRuntimeManifest({ schemaVersion: 1, components: {} }),
  /schemaVersion/,
);
assert.throws(
  () => parseRuntimeManifest({ schemaVersion: 2, generatedAt: 'now', components: {} }),
  /components.manager/,
);
const serializedManifest = JSON.stringify(manifestValue);
assert.equal(manifestDigestMatches(serializedManifest, runtimeManifestSha256(serializedManifest)), true);
assert.equal(manifestDigestMatches(`${serializedManifest} `, runtimeManifestSha256(serializedManifest)), false);

const listenerStatusRoot = mkdtempSync(join(tmpdir(), 'idacc-listener-status-'));
try {
  const statusPath = join(listenerStatusRoot, 'brain-listener-status.json');
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const listenerNonce = 'listener-process-nonce';
  const listenerPid = 42_424;
  const validStatus = {
    schemaVersion: 1,
    instanceNonce: listenerNonce,
    pid: listenerPid,
    primaryTeam: { id: 'default', name: 'Default', active: true },
    teamCount: 1,
    lastSuccessfulPollAt: new Date(now - 1_000).toISOString(),
    cursors: [{ id: 'default', name: 'Default', seq: 17 }],
  };
  writeFileSync(statusPath, JSON.stringify(validStatus), { mode: 0o600 });
  assert.deepEqual(
    readBrainListenerStatusFile(statusPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }),
    {
      healthy: true,
      lastSuccessfulPollAt: validStatus.lastSuccessfulPollAt,
      teamCount: 1,
      primaryTeam: { id: 'default', name: 'Default', active: true },
    },
    'a fresh process-bound listener poll must satisfy readiness',
  );
  assert.match(
    validateBrainListenerStatus(
      { ...validStatus, instanceNonce: 'stale-process-nonce' },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /managed process/,
    'a listener status from an earlier spawn must not satisfy readiness',
  );
  const staleStatus = validateBrainListenerStatus(
    {
      ...validStatus,
      lastSuccessfulPollAt: new Date(now - 30_001).toISOString(),
    },
    { instanceNonce: listenerNonce, pid: listenerPid, now },
  );
  assert.equal(staleStatus.healthy, false);
  assert.equal(staleStatus.lastSuccessfulPollAt, new Date(now - 30_001).toISOString());
  assert.match(staleStatus.error || '', /recently/);
  assert.match(
    validateBrainListenerStatus(
      { ...validStatus, pid: listenerPid + 1 },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /managed process/,
  );
  const inactivePrimary = validateBrainListenerStatus({
    ...validStatus,
    primaryTeam: { ...validStatus.primaryTeam, active: false },
    cursors: [{ id: 'research-id', name: 'Research', seq: 3 }],
  }, { instanceNonce: listenerNonce, pid: listenerPid, now });
  assert.equal(inactivePrimary.healthy, true);
  assert.equal(inactivePrimary.primaryTeam?.active, false);
  assert.match(
    validateBrainListenerStatus(
      {
        ...validStatus,
        primaryTeam: { ...validStatus.primaryTeam, active: false },
      },
      { instanceNonce: listenerNonce, pid: listenerPid, now },
    ).error || '',
    /activity disagreed/,
  );

  const missingStatusPath = join(listenerStatusRoot, 'never-published.json');
  for (const checkedAt of [now, now + 60_000]) {
    const missing = readBrainListenerStatusFile(missingStatusPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now: checkedAt,
    });
    assert.equal(missing.healthy, false);
    assert.match(missing.error || '', /not present/);
  }

  const malformedPath = join(listenerStatusRoot, 'malformed.json');
  writeFileSync(malformedPath, '{"schemaVersion":', { mode: 0o600 });
  assert.match(
    readBrainListenerStatusFile(malformedPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }).error || '',
    /valid JSON/,
  );

  const oversizedPath = join(listenerStatusRoot, 'oversized.json');
  writeFileSync(oversizedPath, Buffer.alloc(BRAIN_LISTENER_STATUS_MAX_BYTES + 1), { mode: 0o600 });
  assert.match(
    readBrainListenerStatusFile(oversizedPath, {
      instanceNonce: listenerNonce,
      pid: listenerPid,
      now,
    }).error || '',
    /size limit/,
  );

  if (process.platform !== 'win32') {
    const symlinkPath = join(listenerStatusRoot, 'status-link.json');
    symlinkSync(statusPath, symlinkPath);
    assert.match(
      readBrainListenerStatusFile(symlinkPath, {
        instanceNonce: listenerNonce,
        pid: listenerPid,
        now,
      }).error || '',
      /symbolic link/,
    );
    chmodSync(statusPath, 0o644);
    assert.match(
      readBrainListenerStatusFile(statusPath, {
        instanceNonce: listenerNonce,
        pid: listenerPid,
        now,
      }).error || '',
      /not private/,
    );
  }
} finally {
  rmSync(listenerStatusRoot, { recursive: true, force: true });
}

const integrityRoot = mkdtempSync(join(tmpdir(), 'idacc-runtime-integrity-'));
try {
  mkdirSync(join(integrityRoot, 'manager', 'dist'), { recursive: true });
  mkdirSync(join(integrityRoot, 'brain'), { recursive: true });
  writeFileSync(join(integrityRoot, 'manager', 'dist', 'start-agent-manager.js'), '');
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), '');
  assert.deepEqual(verifyRuntimePayload(integrityRoot, manifest), []);
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), 'tampered');
  assert.match(verifyRuntimePayload(integrityRoot, manifest).join('\n'), /size changed|digest changed/);
  writeFileSync(join(integrityRoot, 'brain', 'brain.mjs'), '');
  writeFileSync(join(integrityRoot, 'brain', 'injected.mjs'), 'injected');
  assert.match(verifyRuntimePayload(integrityRoot, manifest).join('\n'), /unmanifested file/);
} finally {
  rmSync(integrityRoot, { recursive: true, force: true });
}

const nonce = 'test-instance-nonce';
const attested = validateServiceHealth('manager', {
  status: 'ok',
  service: 'idacc-manager',
  runtimeVersion: '1.2.3',
  instanceNonce: nonce,
  protocolVersion: 'idacc.health.v1',
}, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(attested.healthy, true);
assert.equal(attested.identity, 'attested');
assert.equal(attested.identityVerified, true);

const compatibleManager = validateServiceHealth('manager', { status: 'ok', agents: 2 }, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(compatibleManager.identity, 'legacy-compatible');
assert.equal(compatibleManager.healthy, true);

const compatibleBrain = validateServiceHealth('brain', { ok: true, nodes: 0, edges: 0 }, {
  expectedVersion: '4.5.6',
  expectedServiceId: 'idacc-brain',
  instanceNonce: nonce,
  ownedProcess: true,
});
assert.equal(compatibleBrain.identity, 'legacy-compatible');
assert.equal(compatibleBrain.healthy, true);

for (const [name, payload, expectedVersion, expectedServiceId] of [
  ['manager', { status: 'ok', agents: 2 }, '1.2.3', 'idacc-manager'],
  ['brain', { ok: true, nodes: 0, edges: 0 }, '4.5.6', 'idacc-brain'],
]) {
  const strict = validateServiceHealth(name, payload, {
    expectedVersion,
    expectedServiceId,
    instanceNonce: nonce,
    ownedProcess: true,
    requireAttestation: true,
  });
  assert.equal(strict.healthy, false);
  assert.equal(strict.identity, 'rejected');
  assert.match(strict.error || '', /missing its exact service, version, or instance nonce attestation/);
}

const foreignLegacy = validateServiceHealth('manager', { status: 'ok' }, {
  expectedVersion: '1.2.3',
  expectedServiceId: 'idacc-manager',
  instanceNonce: nonce,
  ownedProcess: false,
});
assert.equal(foreignLegacy.healthy, false);
assert.equal(foreignLegacy.identity, 'rejected');

for (const payload of [
  { status: 'ok', service: 'brain', runtimeVersion: '1.2.3', instanceNonce: nonce },
  { status: 'ok', service: 'manager', runtimeVersion: '9.9.9', instanceNonce: nonce },
  { status: 'ok', service: 'manager', runtimeVersion: '1.2.3', instanceNonce: 'wrong' },
]) {
  const result = validateServiceHealth('manager', payload, {
    expectedVersion: '1.2.3',
    expectedServiceId: 'idacc-manager',
    instanceNonce: nonce,
    ownedProcess: true,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.identity, 'rejected');
}

assert.equal(restartDelayMs(1, 0.5), 1_000);
assert.equal(restartDelayMs(2, 0.5), 2_000);
assert.equal(restartDelayMs(20, 0.5), 30_000);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4], 4, { limit: 5, windowMs: 10 }), false);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4, 5], 5, { limit: 5, windowMs: 10 }), true);
assert.equal(shouldOpenCrashFuse([1, 2, 3, 4, 100], 100, { limit: 5, windowMs: 10 }), false);

assert.deepEqual(
  canonicalLoopbackServiceUrl('http://localhost:49152'),
  { url: 'http://127.0.0.1:49152', port: 49152 },
);
assert.throws(() => canonicalLoopbackServiceUrl('https://127.0.0.1:49152'), /loopback HTTP origin/);
assert.throws(() => canonicalLoopbackServiceUrl('http://example.com:49152'), /loopback HTTP origin/);
assert.throws(() => canonicalLoopbackServiceUrl('http://127.0.0.1:49152/path'), /loopback HTTP origin/);

const folder = mkdtempSync(join(tmpdir(), 'idacc-supervisor-log-'));
try {
  const log = join(folder, 'manager.log');
  writeFileSync(log, 'a'.repeat(12), { mode: 0o600 });
  writeFileSync(`${log}.1`, 'previous', { mode: 0o600 });
  const policy = { maxBytes: 10, keepFiles: 2, maxAgeMs: 1_000 };
  assert.equal(rotateServiceLog(log, policy, 10_000).rotated, true);
  assert.equal(readFileSync(log, 'utf8'), '');
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'a'.repeat(12));
  assert.equal(readFileSync(`${log}.2`, 'utf8'), 'previous');
  if (process.platform !== 'win32') {
    // Windows privacy is enforced by the profile root ACL; POSIX mode bits
    // are not a meaningful ownership boundary there.
    assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
  }

  writeFileSync(log, 'b'.repeat(12), { mode: 0o600 });
  assert.equal(rotateServiceLog(log, policy, 10_100).rotated, true);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'b'.repeat(12));
  assert.equal(readFileSync(`${log}.2`, 'utf8'), 'a'.repeat(12));

  utimesSync(`${log}.2`, new Date(0), new Date(0));
  rotateServiceLog(log, policy, 20_000);
  assert.throws(() => statSync(`${log}.2`), /ENOENT/);
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const settingsFolder = mkdtempSync(join(tmpdir(), 'idacc-brain-automation-settings-'));
try {
  const settingsFile = join(settingsFolder, 'config', 'config.json');
  const saved = setBrainAutomationSettings({
    cycleEnabled: false,
    cycleCadenceHours: 72,
  }, settingsFile);
  assert.deepEqual(saved.brainAutomation, {
    cycleEnabled: false,
    cycleCadenceHours: 72,
  });
  assert.deepEqual(loadSettings(settingsFile).brainAutomation, saved.brainAutomation);
  if (process.platform !== 'win32') {
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
  }
} finally {
  rmSync(settingsFolder, { recursive: true, force: true });
}

console.log('unified stack supervisor smoke: ok');
