#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isContainedRuntimeManifestSymlink,
  isContainedRuntimeSymlink,
  MAX_RUNTIME_PAYLOAD_BYTES,
  sha256,
  sha256File,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from './lib/runtime-provenance.mjs';
import { pruneXmtpNativeBindings } from './lib/runtime-native-pruning.mjs';
import {
  desktopPackagedExclusionRoots,
  installedProductionPackageEntries,
} from './lib/release-dependency-inventory.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'idacc-release-provenance-'));

const xmtpBindingNames = [
  'bindings_node.darwin-arm64.node',
  'bindings_node.darwin-x64.node',
  'bindings_node.linux-arm64-gnu.node',
  'bindings_node.linux-arm64-musl.node',
  'bindings_node.linux-x64-gnu.node',
  'bindings_node.linux-x64-musl.node',
  'bindings_node.win32-x64-msvc.node',
];
const xmtpBindingDirectories = [
  'node_modules/@xmtp/node-bindings/dist',
  'node_modules/@xmtp/node-sdk/node_modules/@xmtp/node-bindings/dist',
  'node_modules/@xmtp/node-sdk/node_modules/@xmtp/content-type-primitives/node_modules/@xmtp/node-bindings/dist',
];
const xmtpPruningFixture = join(scratch, 'xmtp-pruning');
for (const directory of xmtpBindingDirectories) {
  mkdirSync(join(xmtpPruningFixture, directory), { recursive: true });
  for (const name of xmtpBindingNames) {
    writeFileSync(join(xmtpPruningFixture, directory, name), `${name}\n`);
  }
}
const xmtpPruning = pruneXmtpNativeBindings(xmtpPruningFixture, {
  platform: 'linux',
  arch: 'x64',
});
assert.equal(xmtpPruning.kept.length, xmtpBindingDirectories.length);
assert.equal(
  xmtpPruning.removed.length,
  xmtpBindingDirectories.length * (xmtpBindingNames.length - 1),
);
for (const directory of xmtpBindingDirectories) {
  assert.deepEqual(
    readdirSync(join(xmtpPruningFixture, directory)).filter((name) => name.endsWith('.node')),
    ['bindings_node.linux-x64-gnu.node'],
  );
}
const unsupportedXmtpFixture = join(scratch, 'xmtp-unsupported');
mkdirSync(join(unsupportedXmtpFixture, xmtpBindingDirectories[0]), { recursive: true });
writeFileSync(
  join(unsupportedXmtpFixture, xmtpBindingDirectories[0], 'bindings_node.linux-x64-gnu.node'),
  'native\n',
);
assert.throws(
  () => pruneXmtpNativeBindings(unsupportedXmtpFixture, {
    platform: 'linux',
    arch: 'arm64',
  }),
  /unsupported for linux-arm64/,
);
const incompleteXmtpFixture = join(scratch, 'xmtp-incomplete-copy');
const completeXmtpDirectory = join(incompleteXmtpFixture, xmtpBindingDirectories[0]);
const incompleteXmtpDirectory = join(incompleteXmtpFixture, xmtpBindingDirectories[1]);
mkdirSync(completeXmtpDirectory, { recursive: true });
mkdirSync(incompleteXmtpDirectory, { recursive: true });
writeFileSync(
  join(completeXmtpDirectory, 'bindings_node.darwin-arm64.node'),
  'native\n',
);
writeFileSync(
  join(incompleteXmtpDirectory, 'bindings_node.linux-x64-gnu.node'),
  'foreign-only\n',
);
assert.throws(
  () => pruneXmtpNativeBindings(incompleteXmtpFixture, {
    platform: 'darwin',
    arch: 'arm64',
  }),
  /is missing required bindings_node\.darwin-arm64\.node/,
  'every installed XMTP binding package must retain its target-native binary',
);
const emptyXmtpFixture = join(scratch, 'xmtp-empty-copy');
mkdirSync(
  join(emptyXmtpFixture, xmtpBindingDirectories[0]),
  { recursive: true },
);
writeFileSync(
  join(emptyXmtpFixture, xmtpBindingDirectories[0], 'index.js'),
  'export {};\n',
);
assert.throws(
  () => pruneXmtpNativeBindings(emptyXmtpFixture, {
    platform: 'darwin',
    arch: 'arm64',
  }),
  /is missing required bindings_node\.darwin-arm64\.node/,
  'an installed but empty XMTP binding package must not be treated as absent',
);

function run(command, args, cwd, { expectFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: '1767225600',
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(' ')} should fail`);
  } else {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function packageLock(name, version) {
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name,
        version,
        license: 'MIT',
      },
    },
  };
}

function initRepository(path, { name, version, remote, manager = false }) {
  mkdirSync(path, { recursive: true });
  const packageJson = {
    name,
    version,
    description: `${name} fixture`,
    license: 'MIT',
    type: 'module',
    repository: {
      type: 'git',
      url: remote,
    },
    homepage: 'https://example.invalid/runtime',
    bugs: {
      url: 'https://example.invalid/runtime/issues',
    },
    engines: {
      node: '>=22',
    },
    dependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    overrides: {},
    ...(manager ? {
      private: false,
      main: 'dist/index.js',
      module: 'dist/index.mjs',
      types: 'dist/index.d.ts',
      typings: 'dist/index.d.ts',
      bin: {
        'fixture-manager': './dist/interactive-agent-cli.js',
        'fixture-manager-dashboard': './dist/tui/index.js',
      },
      exports: {
        '.': './dist/index.js',
        './cli': './dist/interactive-agent-cli.js',
      },
      scripts: { build: 'node build.mjs' },
      files: ['dist/**/*'],
      devDependencies: {},
    } : {}),
  };
  writeFileSync(join(path, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
  writeFileSync(join(path, 'package-lock.json'), JSON.stringify(packageLock(name, version), null, 2) + '\n');
  writeFileSync(join(path, 'LICENSE'), 'MIT fixture\n');
  if (manager) {
    writeFileSync(join(path, 'build.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "mkdirSync('dist/runtime', { recursive: true });",
      "mkdirSync('dist/tui', { recursive: true });",
      "writeFileSync('dist/start-agent-manager.js', \"import './runtime/service.js';\\nconsole.log('fixture manager');\\n\");",
      "writeFileSync('dist/runtime/service.js', \"export const service = 'neutral';\\n\");",
      "writeFileSync('dist/index.js', \"export const fixture = true;\\n\");",
      "writeFileSync('dist/index.mjs', \"export const fixture = true;\\n\");",
      "writeFileSync('dist/index.d.ts', \"export declare const fixture: true;\\n\");",
      "writeFileSync('dist/interactive-agent-cli.js', \"console.log('fixture cli');\\n\");",
      "writeFileSync('dist/tui/index.js', \"console.log('fixture dashboard');\\n\");",
      "writeFileSync('dist/operator-private.js', \"export const source = '/Users/fixture/private-manager';\\n\");",
      '',
    ].join('\n'));
    mkdirSync(join(path, 'configs'), { recursive: true });
    writeFileSync(join(path, 'configs', 'default.yaml'), 'version: 1\n');
    writeFileSync(join(path, 'configs', 'skillmesh-team.yaml'), 'version: 1\nteam: skillmesh\n');
    mkdirSync(join(path, 'skills', 'brain'), { recursive: true });
    writeFileSync(
      join(path, 'skills', 'brain', 'SKILL.md'),
      '# Brain\nUse the automatically attached Brain MCP tools.\n',
    );
    mkdirSync(join(path, 'skills', 'idagents-admin-control'), { recursive: true });
    writeFileSync(
      join(path, 'skills', 'idagents-admin-control', 'SKILL.md'),
      '# Manager administration\nUse the application controls for privileged changes.\n',
    );
    writeFileSync(
      join(path, 'skills', 'idagents-admin-control', 'remote-command.sh'),
      '#!/bin/sh\ncurl http://127.0.0.1:4100/remote\n',
    );
    mkdirSync(join(path, 'skills', 'idagents-team-builder'), { recursive: true });
    writeFileSync(
      join(path, 'skills', 'idagents-team-builder', 'SKILL.md'),
      '# Team builder\nUse a source checkout.\n',
    );
    mkdirSync(join(path, 'skills', 'wallet'), { recursive: true });
    writeFileSync(join(path, 'skills', 'wallet', 'SKILL.md'), '# Wallet\nUse an external vault.\n');
    mkdirSync(join(path, 'skills', 'bittrees-operator'), { recursive: true });
    writeFileSync(join(path, 'skills', 'bittrees-operator', 'SKILL.md'), '# Operator-only fixture\n');
  } else {
    const frameworkFiles = [
      'brain.mjs',
      'brain-cycle.mjs',
      'brain-listener.mjs',
      'brain-mcp.mjs',
      'brain-connector-validate.mjs',
      'brain-connector.schema.json',
      'context/service.mjs',
      'cycle/approvals.mjs',
      'dashboard/dashboards.mjs',
      'listener/contract.mjs',
      'mcp/server.mjs',
      'operator-tools/refresh-source-embeddings.mjs',
      'prompts/community-report.json',
      'routes/core.mjs',
      'seeds/skills.json',
    ];
    for (const relativePath of frameworkFiles) {
      const destination = join(path, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      const content = relativePath.endsWith('.json')
        ? '{}\n'
        : relativePath === 'brain.mjs'
          ? "import './routes/neutral.mjs';\nconsole.log('fixture brain');\n"
          : "export const fixture = true;\n";
      writeFileSync(destination, content);
    }
    writeFileSync(join(path, 'routes', 'neutral.mjs'), "export const route = 'neutral';\n");
    writeFileSync(join(path, 'routes', 'operator-private.mjs'), "export const source = '/Users/fixture/private-brain';\n");
    writeFileSync(join(path, 'README.md'), '# Fixture Brain\n');
    writeFileSync(join(path, 'skill-loop-publish.mjs'), 'export const privateKeySource = "/Users/fixture/.env";\n');
    mkdirSync(join(path, 'operator-tools'), { recursive: true });
    writeFileSync(join(path, 'operator-tools', 'deploy-private.mjs'), 'export const fixture = true;\n');
  }
  run('git', ['init', '-q'], path);
  run('git', ['config', 'user.email', 'release-provenance@example.invalid'], path);
  run('git', ['config', 'user.name', 'Release Provenance Test'], path);
  run('git', ['remote', 'add', 'origin', remote], path);
  run('git', ['add', '.'], path);
  run('git', ['commit', '-q', '-m', 'fixture source'], path);
  return {
    repository: remote,
    commit: run('git', ['rev-parse', 'HEAD'], path).stdout.trim(),
    tree: run('git', ['rev-parse', 'HEAD^{tree}'], path).stdout.trim(),
    version,
    packageLockSha256: sha256File(join(path, 'package-lock.json')),
    entrypoint: manager ? 'dist/start-agent-manager.js' : 'brain.mjs',
    serviceId: manager ? 'fixture-manager' : 'fixture-brain',
  };
}

try {
  const dependencyInventoryRoot = join(scratch, 'dependency-inventory');
  for (const packagePath of [
    'node_modules/present-parent',
    'node_modules/present-parent/node_modules/present-transitive',
    'node_modules/excluded-native',
    'node_modules/dev-only',
  ]) {
    mkdirSync(join(dependencyInventoryRoot, packagePath), { recursive: true });
  }
  const dependencyLock = {
    packages: {
      '': { name: 'fixture-root', version: '1.0.0' },
      'node_modules/absent-optional': {
        version: '1.0.0',
        optional: true,
      },
      'node_modules/dev-only': {
        version: '1.0.0',
        dev: true,
      },
      'node_modules/excluded-native': {
        version: '1.0.0',
      },
      'node_modules/present-parent': {
        version: '1.0.0',
      },
      'node_modules/present-parent/node_modules/present-transitive': {
        version: '2.0.0',
      },
    },
  };
  const dependencyPackage = {
    build: {
      files: ['out/**/*'],
      win: {
        files: ['!node_modules/excluded-native{,/**/*}'],
      },
    },
  };
  const dependencyExclusions = desktopPackagedExclusionRoots(dependencyPackage, 'win32');
  assert.deepEqual(dependencyExclusions, ['node_modules/excluded-native']);
  assert.deepEqual(
    installedProductionPackageEntries(
      dependencyLock,
      dependencyInventoryRoot,
      { excludedPackageRoots: dependencyExclusions },
    ).map(({ packagePath }) => packagePath),
    [
      'node_modules/present-parent',
      'node_modules/present-parent/node_modules/present-transitive',
    ],
    'SBOM inventory must omit absent optional, excluded native, and dev packages while retaining installed transitive packages',
  );

  const symlinkRoot = join(scratch, 'symlink-policy');
  const npmBinLink = join(symlinkRoot, 'brain', 'node_modules', '.bin', 'node-which');
  assert.equal(
    isContainedRuntimeSymlink(symlinkRoot, npmBinLink, '../which/bin/node-which'),
    true,
    'normal npm .bin links that resolve inside the runtime must be allowed',
  );
  assert.equal(
    isContainedRuntimeSymlink(symlinkRoot, npmBinLink, '../../../../../../outside-runtime'),
    false,
    'relative links that resolve outside the runtime must be rejected',
  );
  assert.equal(
    isContainedRuntimeSymlink(symlinkRoot, npmBinLink, join(scratch, 'outside-runtime')),
    false,
    'absolute links must be rejected',
  );
  assert.equal(
    isContainedRuntimeManifestSymlink(
      'brain/node_modules/.bin/node-which',
      '../which/bin/node-which',
    ),
    true,
    'manifest policy must accept the same contained npm .bin link as filesystem staging',
  );
  for (const unsafeTarget of [
    '../../../../outside-runtime',
    '/tmp/outside-runtime',
    'C:/outside-runtime',
    '..\\outside-runtime',
  ]) {
    assert.equal(
      isContainedRuntimeManifestSymlink('brain/node_modules/.bin/node-which', unsafeTarget),
      false,
      `manifest policy must reject unsafe symlink target ${unsafeTarget}`,
    );
  }

  const managerSource = join(scratch, 'manager');
  const brainSource = join(scratch, 'brain');
  const runtimeRoot = join(scratch, 'runtime');
  const metadataOutput = join(scratch, 'metadata');
  const secondMetadataOutput = join(scratch, 'metadata-win32-x64');
  const mergedMetadataOutput = join(scratch, 'merged-metadata');
  const reversedMergedMetadataOutput = join(scratch, 'merged-metadata-reversed');
  const lockPath = join(scratch, 'runtime-lock.json');
  const manager = initRepository(managerSource, {
    name: '@fixture/manager',
    version: '1.2.3',
    remote: 'https://example.invalid/fixture-manager.git',
    manager: true,
  });
  const brain = initRepository(brainSource, {
    name: '@fixture/brain',
    version: '4.5.6',
    remote: 'https://example.invalid/fixture-brain.git',
  });
  const lock = { schemaVersion: 1, components: { manager, brain } };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  assert.deepEqual(validateRuntimeLock(lock), []);
  assert.ok(validateRuntimeLock({ ...lock, schemaVersion: 99 }).length > 0);

  run(process.execPath, [
    join(root, 'scripts', 'validate-runtime-lock.mjs'),
    '--lock', lockPath,
    '--manager-source', managerSource,
    '--brain-source', brainSource,
  ], root);

  run(process.execPath, [
    join(root, 'idctl-desktop', 'scripts', 'stage-unified-runtime.mjs'),
    '--lock', lockPath,
    '--manager-source', managerSource,
    '--brain-source', brainSource,
    '--target', runtimeRoot,
    '--allow-dirty-application',
  ], root);

  assert.ok(existsSync(join(runtimeRoot, 'manager', manager.entrypoint)));
  assert.ok(existsSync(join(runtimeRoot, 'brain', brain.entrypoint)));
  const stagedManagerPackage = JSON.parse(
    readFileSync(join(runtimeRoot, 'manager', 'package.json'), 'utf8'),
  );
  assert.equal(stagedManagerPackage.name, '@fixture/manager');
  assert.equal(stagedManagerPackage.version, '1.2.3');
  assert.equal(stagedManagerPackage.description, '@fixture/manager fixture');
  assert.equal(stagedManagerPackage.type, 'module');
  assert.equal(stagedManagerPackage.license, 'MIT');
  assert.deepEqual(stagedManagerPackage.repository, {
    type: 'git',
    url: 'https://example.invalid/fixture-manager.git',
  });
  assert.deepEqual(stagedManagerPackage.engines, { node: '>=22' });
  assert.deepEqual(stagedManagerPackage.dependencies, {});
  assert.deepEqual(stagedManagerPackage.optionalDependencies, {});
  assert.deepEqual(stagedManagerPackage.peerDependencies, {});
  assert.deepEqual(stagedManagerPackage.overrides, {});
  assert.equal(stagedManagerPackage.private, true);
  for (const field of [
    'main',
    'module',
    'types',
    'typings',
    'bin',
    'exports',
    'scripts',
    'files',
    'devDependencies',
  ]) {
    assert.equal(
      Object.hasOwn(stagedManagerPackage, field),
      false,
      `staged Manager must not advertise source-only package field ${field}`,
    );
  }
  assert.ok(existsSync(join(runtimeRoot, 'manager', 'dist', 'runtime', 'service.js')));
  assert.ok(existsSync(join(runtimeRoot, 'brain', 'routes', 'neutral.mjs')));
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'dist', 'operator-private.js')), false);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'routes', 'operator-private.mjs')), false);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'configs', 'skillmesh-team.yaml')), false);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'bittrees-operator')), false);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'brain', 'SKILL.md')), true);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'idagents-admin-control', 'SKILL.md')), true);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'idagents-admin-control', 'remote-command.sh')), false);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'idagents-team-builder')), false);
  assert.equal(existsSync(join(runtimeRoot, 'manager', 'skills', 'wallet')), false);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'seeds')), false);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'operator-tools', 'refresh-source-embeddings.mjs')), true);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'operator-tools', 'deploy-private.mjs')), false);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'skill-loop-publish.mjs')), false);
  assert.equal(existsSync(join(runtimeRoot, 'brain', 'README.md')), false);
  const runtimeManifestPath = join(runtimeRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.components.manager.commit, manager.commit);
  assert.equal(manifest.components.brain.commit, brain.commit);
  assert.match(manifest.trees.runtime, /^[0-9a-f]{64}$/);
  assert.ok(manifest.files.length >= 8);
  assert.match(
    verifyRuntimeManifest(runtimeRoot, {
      ...manifest,
      files: [
        ...manifest.files,
        {
          path: 'brain/node_modules/.bin/escape',
          type: 'symlink',
          size: 1,
          sha256: '0'.repeat(64),
          target: '../../../../outside-runtime',
        },
      ],
    }, lock).join('\n'),
    /runtime manifest files\[\d+\] is invalid/,
    'staging verification must reject a manifest the production parser would reject',
  );
  assert.match(
    verifyRuntimeManifest(runtimeRoot, {
      ...manifest,
      files: manifest.files.map((record, index) => (
        index === 0
          ? { ...record, size: MAX_RUNTIME_PAYLOAD_BYTES + 1 }
          : record
      )),
    }, lock).join('\n'),
    /runtime manifest payload is \d+ bytes; maximum is \d+ bytes/,
    'staging verification must reject an unreviewed runtime size regression',
  );

  run(process.execPath, [
    join(root, 'scripts', 'verify-runtime-manifest.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
  ], root);

  const artifact = join(scratch, 'IDACC-fixture.zip');
  writeFileSync(artifact, 'fixture release artifact\n');
  writeFileSync(runtimeManifestPath, JSON.stringify({
    ...manifest,
    application: { ...manifest.application, dirty: true },
  }, null, 2) + '\n');
  run(process.execPath, [
    join(root, 'scripts', 'generate-release-metadata.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
    '--output', join(scratch, 'dirty-metadata'),
    '--artifact', artifact,
  ], root, { expectFailure: true });
  writeFileSync(runtimeManifestPath, JSON.stringify({
    ...manifest,
    application: { ...manifest.application, dirty: false },
  }, null, 2) + '\n');
  const emptyArtifactResult = run(process.execPath, [
    join(root, 'scripts', 'generate-release-metadata.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
    '--output', join(scratch, 'empty-artifact-metadata'),
  ], root, { expectFailure: true });
  assert.match(emptyArtifactResult.stderr, /at least one --artifact is required/);
  run(process.execPath, [
    join(root, 'scripts', 'generate-release-metadata.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
    '--output', metadataOutput,
    '--artifact', artifact,
  ], root);
  for (const name of [
    'release-manifest.json',
    'runtime-lock.json',
    'runtime-manifest.json',
    'SBOM.cdx.json',
    'THIRD_PARTY_NOTICES.md',
    'SHA256SUMS',
  ]) assert.ok(existsSync(join(metadataOutput, name)), `${name} should be generated`);
  const releaseManifest = JSON.parse(readFileSync(join(metadataOutput, 'release-manifest.json'), 'utf8'));
  const sbom = JSON.parse(readFileSync(join(metadataOutput, 'SBOM.cdx.json'), 'utf8'));
  assert.equal(releaseManifest.artifacts[0].sha256, sha256File(artifact));
  assert.equal(releaseManifest.components.manager.commit, manager.commit);
  assert.equal(sbom.components.some((component) =>
    component.type === 'application' && component.name === '@fixture/manager'
  ), true);
  assert.equal(sbom.components.some((component) =>
    component.type === 'application' && component.name === '@fixture/brain'
  ), true);
  assert.equal(sbom.components.filter((component) =>
    component.type === 'framework' && component.name === 'electron'
  ).length, 1);
  assert.equal(sbom.components.some((component) => component.name === '@electron/rebuild'), false);
  assert.match(readFileSync(join(metadataOutput, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /----- BEGIN LICENSE -----/);
  assert.match(readFileSync(join(metadataOutput, 'SHA256SUMS'), 'utf8'), new RegExp(`${sha256File(artifact)}  IDACC-fixture\\.zip`));
  const alternateLineEndingMetadataOutput = join(scratch, 'metadata-alternate-line-endings');
  const canonicalLockText = JSON.stringify(lock, null, 2) + '\n';
  const canonicalRuntimeManifestText = readFileSync(runtimeManifestPath, 'utf8');
  writeFileSync(lockPath, canonicalLockText.replaceAll('\n', '\r\n'));
  writeFileSync(
    runtimeManifestPath,
    canonicalRuntimeManifestText.replaceAll('\n', '\r\n'),
  );
  run(process.execPath, [
    join(root, 'scripts', 'generate-release-metadata.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
    '--output', alternateLineEndingMetadataOutput,
    '--artifact', artifact,
  ], root);
  assert.equal(
    readFileSync(join(alternateLineEndingMetadataOutput, 'runtime-lock.json'), 'utf8'),
    readFileSync(join(metadataOutput, 'runtime-lock.json'), 'utf8'),
    'runtime lock metadata must not depend on checkout line endings',
  );
  assert.equal(
    readFileSync(join(alternateLineEndingMetadataOutput, 'runtime-manifest.json'), 'utf8'),
    readFileSync(join(metadataOutput, 'runtime-manifest.json'), 'utf8'),
    'runtime manifest metadata must not depend on checkout line endings',
  );
  writeFileSync(lockPath, canonicalLockText);
  writeFileSync(runtimeManifestPath, canonicalRuntimeManifestText);
  const packagedNotices = join(scratch, 'packaged', 'THIRD_PARTY_NOTICES.md');
  run(process.execPath, [
    join(root, 'scripts', 'generate-release-metadata.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
    '--notices-only', packagedNotices,
  ], root);
  assert.equal(
    readFileSync(packagedNotices, 'utf8'),
    readFileSync(join(metadataOutput, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    'the notice embedded in the app must match the release metadata notice byte-for-byte',
  );

  cpSync(metadataOutput, secondMetadataOutput, { recursive: true });
  const secondArtifact = join(scratch, 'IDACC-fixture.exe');
  writeFileSync(secondArtifact, 'fixture Windows release artifact\n');
  const secondManifestPath = join(secondMetadataOutput, 'release-manifest.json');
  const secondRuntimeManifestPath = join(secondMetadataOutput, 'runtime-manifest.json');
  const secondBuild = { ...releaseManifest.build, platform: 'fixture', arch: 'fixture' };
  const secondTrees = { ...releaseManifest.trees, runtime: sha256('fixture-other-runtime') };
  const secondRuntimeManifest = JSON.parse(readFileSync(secondRuntimeManifestPath, 'utf8'));
  writeFileSync(secondRuntimeManifestPath, JSON.stringify({
    ...secondRuntimeManifest,
    build: secondBuild,
    trees: secondTrees,
  }, null, 2) + '\n');
  const secondReleaseManifest = {
    ...releaseManifest,
    build: secondBuild,
    trees: secondTrees,
    metadata: {
      ...releaseManifest.metadata,
      runtimeManifest: {
        ...releaseManifest.metadata.runtimeManifest,
        sha256: sha256File(secondRuntimeManifestPath),
      },
    },
    artifacts: [{
      name: 'IDACC-fixture.exe',
      size: readFileSync(secondArtifact).length,
      sha256: sha256File(secondArtifact),
    }],
  };
  writeFileSync(secondManifestPath, JSON.stringify(secondReleaseManifest, null, 2) + '\n');
  const secondChecksumFiles = [
    secondArtifact,
    join(secondMetadataOutput, 'runtime-lock.json'),
    join(secondMetadataOutput, 'runtime-manifest.json'),
    join(secondMetadataOutput, 'SBOM.cdx.json'),
    join(secondMetadataOutput, 'THIRD_PARTY_NOTICES.md'),
    secondManifestPath,
  ];
  writeFileSync(
    join(secondMetadataOutput, 'SHA256SUMS'),
    secondChecksumFiles
      .map((path) => `${sha256File(path)}  ${basename(path)}`)
      .sort()
      .join('\n') + '\n',
  );

  run(process.execPath, [
    join(root, 'scripts', 'merge-release-metadata.mjs'),
    '--metadata', metadataOutput,
    '--metadata', secondMetadataOutput,
    '--output', mergedMetadataOutput,
  ], root);
  run(process.execPath, [
    join(root, 'scripts', 'merge-release-metadata.mjs'),
    '--metadata', secondMetadataOutput,
    '--metadata', metadataOutput,
    '--output', reversedMergedMetadataOutput,
  ], root);
  const releaseIndexPath = join(mergedMetadataOutput, 'release-index.json');
  const releaseIndex = JSON.parse(readFileSync(releaseIndexPath, 'utf8'));
  assert.deepEqual(releaseIndex.releases.map((release) => release.target), [
    `${releaseManifest.build.platform}-${releaseManifest.build.arch}`,
    'fixture-fixture',
  ].sort());
  assert.equal(releaseIndex.artifacts.length, 2);
  assert.equal(releaseIndex.artifacts.every((entry) =>
    entry.platform && entry.arch && entry.runtimeTree && entry.releaseManifestSha256
  ), true);
  assert.equal(
    sha256File(releaseIndexPath),
    sha256File(join(reversedMergedMetadataOutput, 'release-index.json')),
  );
  run(process.execPath, [
    join(root, 'scripts', 'merge-release-metadata.mjs'),
    '--metadata', metadataOutput,
    '--metadata', metadataOutput,
    '--output', join(scratch, 'duplicate-target'),
  ], root, { expectFailure: true });
  appendFileSync(join(secondMetadataOutput, 'SBOM.cdx.json'), '\n');
  run(process.execPath, [
    join(root, 'scripts', 'merge-release-metadata.mjs'),
    '--metadata', metadataOutput,
    '--metadata', secondMetadataOutput,
    '--output', join(scratch, 'tampered-metadata'),
  ], root, { expectFailure: true });

  appendFileSync(join(runtimeRoot, 'manager', manager.entrypoint), '// tampered\n');
  run(process.execPath, [
    join(root, 'scripts', 'verify-runtime-manifest.mjs'),
    '--lock', lockPath,
    '--runtime-root', runtimeRoot,
  ], root, { expectFailure: true });

  writeFileSync(join(managerSource, 'untracked.txt'), 'dirty\n');
  run(process.execPath, [
    join(root, 'scripts', 'validate-runtime-lock.mjs'),
    '--lock', lockPath,
    '--manager-source', managerSource,
    '--brain-source', brainSource,
  ], root, { expectFailure: true });
  rmSync(join(managerSource, 'untracked.txt'));

  writeFileSync(join(managerSource, 'tracked.txt'), 'new commit\n');
  run('git', ['add', 'tracked.txt'], managerSource);
  run('git', ['commit', '-q', '-m', 'unexpected newer source'], managerSource);
  run(process.execPath, [
    join(root, 'scripts', 'validate-runtime-lock.mjs'),
    '--lock', lockPath,
    '--manager-source', managerSource,
    '--brain-source', brainSource,
  ], root, { expectFailure: true });

  console.log(`RELEASE_PROVENANCE_SMOKE ${JSON.stringify({
    exactPins: true,
    cleanSourceRequired: true,
    perFileHashes: manifest.files.length,
    tamperRejected: true,
    metadataGenerated: true,
    crossPlatformIndex: true,
  })}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
