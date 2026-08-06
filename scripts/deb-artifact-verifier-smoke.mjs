#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEB_PIPELINE_TIMEOUT_MS,
  inspectDebArtifactRecords,
  loadDebVerificationPolicy,
  parseDebVerifierArgs,
  parseTarVerboseListing,
  PINNED_ELECTRON_BUILDER_VERSION,
  runDebTarCommand,
  verifyDebBuildConfig,
} from './verify-deb-artifact.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(root, 'idctl-desktop');
const configFixture = {
  packageJson: JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')),
  packageLock: JSON.parse(readFileSync(join(desktopRoot, 'package-lock.json'), 'utf8')),
  builderPackage: JSON.parse(
    readFileSync(join(desktopRoot, 'node_modules', 'app-builder-lib', 'package.json'), 'utf8'),
  ),
  afterInstallTemplate: readFileSync(
    join(
      desktopRoot,
      'node_modules',
      'app-builder-lib',
      'templates',
      'linux',
      'after-install.tpl',
    ),
    'utf8',
  ),
  appArmorTemplate: readFileSync(
    join(
      desktopRoot,
      'node_modules',
      'app-builder-lib',
      'templates',
      'linux',
      'apparmor-profile.tpl',
    ),
    'utf8',
  ),
};
const policy = loadDebVerificationPolicy();
assert.deepEqual(verifyDebBuildConfig(configFixture), policy);
assert.equal(DEFAULT_DEB_PIPELINE_TIMEOUT_MS, 300_000);

const verifierSource = readFileSync(
  join(root, 'scripts', 'verify-deb-artifact.mjs'),
  'utf8',
);
assert.doesNotMatch(
  verifierSource,
  /['"]--occurrence['"]/,
  'member extraction must scan to archive EOF so the dpkg-deb producer can exit',
);

function clonedConfigFixture() {
  return {
    ...configFixture,
    packageJson: structuredClone(configFixture.packageJson),
    packageLock: structuredClone(configFixture.packageLock),
    builderPackage: structuredClone(configFixture.builderPackage),
  };
}

const configNegativeFixtures = [
  {
    name: 'unpinned package builder',
    mutate(candidate) {
      candidate.packageJson.devDependencies['electron-builder'] = '^26.15.7';
    },
    pattern: /package\.json electron-builder pin/,
  },
  {
    name: 'unpinned lock builder',
    mutate(candidate) {
      candidate.packageLock.packages['node_modules/electron-builder'].version = '26.15.6';
    },
    pattern: /package-lock electron-builder version/,
  },
  {
    name: 'mutated builder integrity',
    mutate(candidate) {
      candidate.packageLock.packages['node_modules/app-builder-lib'].integrity =
        'sha512-not-the-pinned-package';
    },
    pattern: /package-lock app-builder-lib integrity/,
  },
  {
    name: 'different installed builder',
    mutate(candidate) {
      candidate.builderPackage.version = '26.15.6';
    },
    pattern: /installed app-builder-lib version/,
  },
  {
    name: 'renamed application',
    mutate(candidate) {
      candidate.packageJson.productName = '../unsafe';
    },
    pattern: /productName must be exactly/,
  },
  {
    name: 'missing deb target',
    mutate(candidate) {
      candidate.packageJson.build.linux.target = ['AppImage'];
    },
    pattern: /exactly one deb target/,
  },
  {
    name: 'mutated postinst template',
    mutate(candidate) {
      candidate.afterInstallTemplate += '\n# unexpected mutation\n';
    },
    pattern: /after-install\.tpl SHA-256/,
  },
  {
    name: 'mutated AppArmor template',
    mutate(candidate) {
      candidate.appArmorTemplate = candidate.appArmorTemplate.replace('userns,', '');
    },
    pattern: /apparmor-profile\.tpl SHA-256/,
  },
];
for (const fixture of configNegativeFixtures) {
  const candidate = clonedConfigFixture();
  fixture.mutate(candidate);
  assert.throws(
    () => verifyDebBuildConfig(candidate),
    fixture.pattern,
    fixture.name,
  );
}

assert.deepEqual(parseDebVerifierArgs(['--config-only']), { mode: 'config' });
assert.equal(
  parseDebVerifierArgs(['--deb', './IDACC.deb']).mode,
  'artifact',
);
for (const args of [
  [],
  ['--deb'],
  ['--deb', 'one.deb', 'two.deb'],
  ['--config-only', '--deb', 'one.deb'],
]) {
  assert.throws(() => parseDebVerifierArgs(args), /usage:/);
}

function record(permissions, path, { uid = 0, gid = 0, size = 123 } = {}) {
  return `${permissions} ${uid}/${gid} ${size} `
    + `2026-07-28 12:34:56.000000000 +0000 ${path}`;
}

const goodDataListing = [
  record('drwxr-xr-x', './opt/', { size: 0 }),
  record('-rwxr-xr-x', policy.helperArchivePath),
  record('-rw-r--r--', policy.appArmorArchivePath),
].join('\n');
const goodControlListing = [
  record('-rw-r--r--', './control'),
  record('-rwxr-xr-x', policy.postinstArchivePath),
].join('\n');
const goodRecords = {
  dataListing: goodDataListing,
  controlListing: goodControlListing,
  postinst: policy.postinst,
  appArmorProfile: policy.appArmorProfile,
};

const parsed = parseTarVerboseListing(goodDataListing);
assert.equal(parsed.length, 3);
assert.equal(parsed[1].path, policy.helperArchivePath);
assert.equal(parsed[1].uid, 0);
assert.equal(parsed[1].gid, 0);

const inspected = inspectDebArtifactRecords(goodRecords, policy);
assert.equal(inspected.helperPath, policy.helperArchivePath);
assert.equal(inspected.helperPermissions, '-rwxr-xr-x');
assert.equal(inspected.postinstPath, policy.postinstArchivePath);
assert.equal(inspected.appArmorPath, policy.appArmorArchivePath);

const suidHelper = inspectDebArtifactRecords(
  {
    ...goodRecords,
    dataListing: goodDataListing.replace('-rwxr-xr-x', '-rwsr-xr-x'),
  },
  policy,
);
assert.equal(suidHelper.helperPermissions, '-rwsr-xr-x');

function mutateRecords(overrides) {
  return {
    ...goodRecords,
    ...overrides,
  };
}

const negativeFixtures = [
  {
    name: 'missing helper',
    records: mutateRecords({
      dataListing: record('-rw-r--r--', policy.appArmorArchivePath),
    }),
    pattern: /chrome-sandbox must appear exactly once/,
  },
  {
    name: 'duplicate helper',
    records: mutateRecords({
      dataListing: `${goodDataListing}\n${record('-rwxr-xr-x', policy.helperArchivePath)}`,
    }),
    pattern: /chrome-sandbox must appear exactly once/,
  },
  {
    name: 'alternate helper path',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        policy.helperArchivePath,
        './opt/Other Product/chrome-sandbox',
      ),
    }),
    pattern: /chrome-sandbox must appear exactly once/,
  },
  {
    name: 'traversing helper path',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        policy.helperArchivePath,
        './opt/ID Agents Control Center/../chrome-sandbox',
      ),
    }),
    pattern: /chrome-sandbox must appear exactly once/,
  },
  {
    name: 'helper symlink',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        record('-rwxr-xr-x', policy.helperArchivePath),
        record('lrwxrwxrwx', `${policy.helperArchivePath} -> /tmp/unsafe`, { size: 0 }),
      ),
    }),
    pattern: /chrome-sandbox must be a regular non-link file/,
  },
  {
    name: 'helper hard link',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        record('-rwxr-xr-x', policy.helperArchivePath),
        record('hrwxr-xr-x', `${policy.helperArchivePath} link to ./tmp/unsafe`),
      ),
    }),
    pattern: /chrome-sandbox must be a regular non-link file/,
  },
  {
    name: 'helper wrong owner',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        record('-rwxr-xr-x', policy.helperArchivePath),
        record('-rwxr-xr-x', policy.helperArchivePath, { uid: 1000, gid: 1000 }),
      ),
    }),
    pattern: /numeric uid:gid 0:0/,
  },
  {
    name: 'helper group writable',
    records: mutateRecords({
      dataListing: goodDataListing.replace('-rwxr-xr-x', '-rwxrwxr-x'),
    }),
    pattern: /chrome-sandbox mode must be/,
  },
  {
    name: 'helper missing execute bit',
    records: mutateRecords({
      dataListing: goodDataListing.replace('-rwxr-xr-x', '-rw-r--r--'),
    }),
    pattern: /chrome-sandbox mode must be/,
  },
  {
    name: 'postinst symlink',
    records: mutateRecords({
      controlListing: goodControlListing.replace(
        record('-rwxr-xr-x', policy.postinstArchivePath),
        record('lrwxrwxrwx', `${policy.postinstArchivePath} -> ./unsafe`, { size: 0 }),
      ),
    }),
    pattern: /postinst must be a regular non-link file/,
  },
  {
    name: 'mutated postinst',
    records: mutateRecords({
      postinst: policy.postinst.replace('chmod 4755', 'chmod 0777'),
    }),
    pattern: /postinst does not exactly match/,
  },
  {
    name: 'sandbox-disabled postinst',
    records: mutateRecords({
      postinst: `${policy.postinst}\n/opt/app --no-sandbox\n`,
    }),
    pattern: /postinst does not exactly match/,
  },
  {
    name: 'duplicate AppArmor profile',
    records: mutateRecords({
      dataListing: `${goodDataListing}\n${record('-rw-r--r--', policy.appArmorArchivePath)}`,
    }),
    pattern: /bundled AppArmor profile must appear exactly once/,
  },
  {
    name: 'AppArmor profile symlink',
    records: mutateRecords({
      dataListing: goodDataListing.replace(
        record('-rw-r--r--', policy.appArmorArchivePath),
        record(
          'lrwxrwxrwx',
          `${policy.appArmorArchivePath} -> /tmp/unsafe`,
          { size: 0 },
        ),
      ),
    }),
    pattern: /bundled AppArmor profile must be a regular non-link file/,
  },
  {
    name: 'mutated AppArmor profile',
    records: mutateRecords({
      appArmorProfile: policy.appArmorProfile.replace('userns,', '# userns removed'),
    }),
    pattern: /AppArmor profile does not exactly match/,
  },
];

for (const fixture of negativeFixtures) {
  assert.throws(
    () => inspectDebArtifactRecords(fixture.records, policy),
    fixture.pattern,
    fixture.name,
  );
}

for (const [name, listing] of [
  ['nonnumeric owner', '-rwxr-xr-x root/root 123 2026-07-28 12:34 ./postinst'],
  ['unparseable candidate', 'not-a-tar-record chrome-sandbox'],
  ['NUL path', `${record('-rwxr-xr-x', policy.helperArchivePath)}\0`],
]) {
  assert.throws(() => parseTarVerboseListing(listing), /DEB artifact verification failed/, name);
}

const pipelineFixtureRoot = mkdtempSync(
  join(tmpdir(), 'idacc-deb-pipeline-smoke-'),
);
try {
  const producerPidPath = join(pipelineFixtureRoot, 'producer.pid');
  const consumerPidPath = join(pipelineFixtureRoot, 'consumer.pid');
  const producerScript = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(producerPidPath)}, String(process.pid));
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const write = () => {
      while (process.stdout.write(chunk)) {}
    };
    process.stdout.on('drain', write);
    write();
    setInterval(() => {}, 1000);
  `;
  const consumerScript = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(consumerPidPath)}, String(process.pid));
    process.stdin.once('data', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  await assert.rejects(
    runDebTarCommand(
      producerScript,
      '-e',
      ['-e', consumerScript],
      1024 * 1024,
      'early consumer regression fixture',
      {
        dpkgDebPath: process.execPath,
        tarPath: process.execPath,
        timeoutMs: 1_000,
      },
    ),
    /timed out after 1000 milliseconds/,
  );
  assert.ok(
    Date.now() - startedAt < 5_000,
    'the DEB pipeline watchdog must reject promptly',
  );
  for (const pidPath of [producerPidPath, consumerPidPath]) {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH|no such process/i,
      `timed-out child ${pid} must be reaped`,
    );
  }

  const invalidTimeoutPidPath = join(pipelineFixtureRoot, 'invalid-timeout.pid');
  await assert.rejects(
    runDebTarCommand(
      `require('node:fs').writeFileSync(${
        JSON.stringify(invalidTimeoutPidPath)
      }, String(process.pid))`,
      '-e',
      ['-e', 'process.exit(0)'],
      1024,
      'invalid timeout fixture',
      {
        dpkgDebPath: process.execPath,
        tarPath: process.execPath,
        timeoutMs: 0,
      },
    ),
    /timeout must be a positive integer/,
  );
  assert.equal(
    existsSync(invalidTimeoutPidPath),
    false,
    'invalid watchdog configuration must be rejected before spawning children',
  );

  const missingProducerPath = join(pipelineFixtureRoot, 'missing-dpkg-deb');
  const spawnFailureStartedAt = Date.now();
  await assert.rejects(
    runDebTarCommand(
      'unused fixture argument',
      '--unused-mode',
      ['-e', 'setInterval(() => {}, 1000)'],
      1024,
      'spawn failure fixture',
      {
        dpkgDebPath: missingProducerPath,
        tarPath: process.execPath,
        timeoutMs: 5_000,
      },
    ),
    /unable to execute .*missing-dpkg-deb.*ENOENT/,
  );
  assert.ok(
    Date.now() - spawnFailureStartedAt < 5_000,
    'a child spawn error must clean up its peer and await both close events',
  );
} finally {
  rmSync(pipelineFixtureRoot, { recursive: true, force: true });
}

assert.match(
  policy.postinst,
  /if ! \{ \[\[ -L \/proc\/self\/ns\/user \]\] && unshare --user true; \}; then/,
);
assert.match(
  policy.postinst,
  new RegExp(`chmod 4755 '${policy.helperInstallPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
);
assert.match(
  policy.postinst,
  new RegExp(`chmod 0755 '${policy.helperInstallPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
);
assert.doesNotMatch(policy.postinst, /--(?:no-sandbox|disable-setuid-sandbox)/);
assert.match(policy.appArmorProfile, /\n  userns,\n/);

console.log(
  `DEB artifact verifier smoke: ok (electron-builder ${PINNED_ELECTRON_BUILDER_VERSION}, `
  + `${configNegativeFixtures.length} config and ${negativeFixtures.length} artifact `
  + 'negative fixtures; EOF member scan and bounded child-process cleanup)',
);
