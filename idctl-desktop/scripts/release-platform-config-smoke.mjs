#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmInvocation, resolveNpmCli } from './npm-invocation.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const build = pkg.build || {};
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
assert.match(
  gitignore,
  /^\/idctl-desktop\/resources\/THIRD_PARTY_NOTICES\.md$/m,
  'generated dependency notices must not dirty the exact application source used for runtime staging',
);
const stageSource = readFileSync(join(desktop, 'scripts', 'stage-unified-runtime.mjs'), 'utf8');
assert.match(pkg.scripts?.['build:release'] || '', /--require-runtime/);
for (const script of ['dist', 'release:mac', 'release:win', 'release:linux']) {
  assert.match(pkg.scripts?.[script] || '', /npm run build:release/, `${script} must pin the staged runtime into the build`);
}
for (const [script, platform] of [
  ['release:mac', 'mac'],
  ['release:win', 'win'],
  ['release:linux', 'linux'],
]) {
  assert.match(
    pkg.scripts?.[script] || '',
    new RegExp(`node scripts/run-production-builder\\.mjs --platform ${platform} --`),
    `${script} must enter electron-builder through the production policy wrapper`,
  );
}
const targets = (value) => (Array.isArray(value) ? value : [value])
  .map((entry) => typeof entry === 'string' ? entry : entry?.target)
  .filter(Boolean);

assert.equal(build.appId, 'world.idchain.idagents-control', 'appId is an update and profile compatibility boundary');
assert.equal(pkg.author, 'IDACC Contributors', 'installer metadata must use a neutral project identity');
assert.equal(build.publish?.provider, 'github');
assert.equal(build.publish?.owner, 'bobofbuilding');
assert.equal(build.publish?.repo, 'idacc');
assert.match(build.artifactName, /\$\{version\}/);
assert.match(build.artifactName, /\$\{arch\}/);
assert.equal(build.asar, true);
assert.match(String(build.electronUpdaterCompatibility || ''), /^>=6\./);
const projectLicenseResource = (build.extraResources || []).find((entry) => entry?.to === 'IDACC-LICENSE.txt');
assert.equal(projectLicenseResource?.from, '../LICENSE', 'every packaged app must carry the project MIT notice');
assert.ok(existsSync(join(root, 'LICENSE')), 'the project MIT notice is missing');
const thirdPartyNoticesResource = (build.extraResources || []).find((entry) => entry?.to === 'THIRD_PARTY_NOTICES.md');
assert.equal(
  thirdPartyNoticesResource?.from,
  'resources/THIRD_PARTY_NOTICES.md',
  'every packaged app must carry notices for its bundled production dependencies',
);
assert.match(
  String(pkg.scripts?.['build:release'] || ''),
  /prepare:notices/,
  'production packaging must generate dependency notices from the exact staged runtime',
);

assert.deepEqual(new Set(targets(build.mac?.target)), new Set(['dmg', 'zip']));
assert.equal(build.mac?.hardenedRuntime, true);
assert.equal(build.mac?.notarize, true);
assert.equal(build.mac?.gatekeeperAssess, false);
assert.equal(build.dmg?.sign, true, 'the distributable DMG must carry its own code signature');
assert.equal(
  build.dmg?.writeUpdateInfo,
  false,
  'macOS updater metadata must describe the ZIP because stapling changes the DMG bytes after packaging',
);
assert.ok(existsSync(join(desktop, build.mac?.entitlements || '')));
assert.ok(existsSync(join(desktop, build.mac?.entitlementsInherit || '')));

const globalFiles = JSON.stringify(build.files || []);
const macFiles = JSON.stringify(build.mac?.files || []);
const windowsFiles = JSON.stringify(build.win?.files || []);
const linuxFiles = JSON.stringify(build.linux?.files || []);
assert.doesNotMatch(globalFiles, /libnut-darwin/, 'the Mach-O Computer Use driver must not enter Windows/Linux packages');
assert.match(macFiles, /libnut-darwin/, 'the macOS package must retain its Computer Use driver');
assert.match(windowsFiles, /!node_modules\/@nut-tree-fork\/libnut-darwin/, 'Windows must explicitly exclude the Mach-O driver dependency');
assert.match(windowsFiles, /node-mac-permissions/, 'Windows must explicitly exclude macOS permission bindings');
assert.match(linuxFiles, /!node_modules\/@nut-tree-fork\/libnut-darwin/, 'Linux must explicitly exclude the Mach-O driver dependency');
assert.match(linuxFiles, /node-mac-permissions/, 'Linux must explicitly exclude macOS permission bindings');

assert.deepEqual(targets(build.win?.target), ['nsis']);
assert.equal(pkg.devDependencies?.['electron-builder'], '26.15.7');
assert.equal(
  pkg.devDependencies?.['electron-builder-squirrel-windows'],
  'file:tools/electron-builder-squirrel-windows-disabled',
  'the unused Squirrel peer must resolve to the local fail-closed guard, not its vulnerable packaging tree',
);
assert.deepEqual(pkg.overrides?.['app-builder-lib'], {
  '@electron/asar': '4.2.1',
  '@electron/universal': '3.0.6',
  ejs: '5.0.2',
});
const DisabledSquirrelWindowsTarget = require('electron-builder-squirrel-windows');
assert.throws(
  () => new DisabledSquirrelWindowsTarget(),
  /Squirrel\.Windows packaging is disabled/,
  'selecting the unsupported Squirrel target must fail clearly instead of entering an unreviewed toolchain',
);
assert.equal(build.win?.requestedExecutionLevel, 'asInvoker');
assert.equal(build.win?.signAndEditExecutable, true);
assert.equal(build.win?.verifyUpdateCodeSignature, true);
assert.equal(build.nsis?.oneClick, false);
assert.equal(build.nsis?.perMachine, false);
assert.equal(build.nsis?.deleteAppDataOnUninstall, false);

assert.deepEqual(new Set(targets(build.linux?.target)), new Set(['AppImage', 'deb']));
assert.equal(build.linux?.executableName, 'idagents-control-center');
assert.equal(pkg.desktopName, 'idagents-control-center.desktop');
assert.equal(build.linux?.syncDesktopName, true);
assert.equal(build.linux?.maintainer, 'IDACC Contributors', 'Linux package metadata must not embed a personal identity');

assert.match(String(pkg.devDependencies?.electron || ''), /^41\.\d+\.\d+$/, 'Electron 41 is the newest line compatible with manager better-sqlite3 12.8');
assert.match(String(pkg.dependencies?.['electron-updater'] || ''), /^\d+\.\d+\.\d+$/, 'electron-updater must be exact');
assert.match(String(pkg.scripts?.['build:release'] || ''), /--require-runtime/, 'production builds must require a verified staged runtime');
assert.match(pkg.scripts?.['test:update-descriptor-contract'] || '', /update-descriptor-contract-smoke/);
assert.match(pkg.scripts?.['test:updater-public-provider'] || '', /electron-updater-public-provider-smoke/);
for (const script of ['release:mac', 'release:win', 'release:linux']) {
  assert.match(String(pkg.scripts?.[script] || ''), /build:release/, `${script} must use the runtime-bound production build`);
}
const signingPolicySource = readFileSync(join(desktop, 'scripts', 'release-signing-policy.mjs'), 'utf8');
const builderWrapperSource = readFileSync(join(desktop, 'scripts', 'run-production-builder.mjs'), 'utf8');
const publisherVerifierSource = readFileSync(join(desktop, 'scripts', 'verify-packaged-publisher.mjs'), 'utf8');
assert.match(signingPolicySource, /--config\.forceCodeSigning=true/);
assert.match(signingPolicySource, /--config\.mac\.identity=/);
assert.match(signingPolicySource, /--config\.win\.signtoolOptions\.publisherName=/);
assert.match(signingPolicySource, /MACOS_EXPECTED_TEAM_ID/);
assert.match(signingPolicySource, /MACOS_EXPECTED_SIGNING_IDENTITY/);
assert.match(signingPolicySource, /WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
assert.match(builderWrapperSource, /electron-builder\/out\/cli\/cli\.js/);
assert.match(builderWrapperSource, /productionBuilderArgs/);
assert.match(publisherVerifierSource, /publisherName/);
assert.match(publisherVerifierSource, /WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
const { DebugLogger } = require('builder-util/out/DebugLogger.js');
await validateConfiguration(build, new DebugLogger(false));
await validateConfiguration({
  ...build,
  forceCodeSigning: true,
  mac: {
    ...build.mac,
    identity: 'IDACC Contributors (IDACC12345)',
  },
  win: {
    ...build.win,
    signtoolOptions: {
      ...(build.win?.signtoolOptions || {}),
      publisherName: 'CN=IDACC Contributors, O=IDACC Contributors, C=US',
    },
  },
}, new DebugLogger(false));
for (const icon of ['build/icon.icns', 'build/icon.ico', 'build/icon.png']) {
  assert.ok(existsSync(join(desktop, icon)), `${icon} is missing`);
}

const mainSource = readFileSync(join(desktop, 'src', 'main', 'main.ts'), 'utf8');
const releaseStackSmoke = readFileSync(join(root, 'scripts', 'unified-stack-release-smoke.mjs'), 'utf8');
assert.match(mainSource, /writeStackSelftestResultFile/);
assert.match(mainSource, /IDACC_STACK_SELFTEST_RESULT_FILE/);
assert.match(
  mainSource,
  /app\.isPackaged \|\| process\.env\.IDACC_STACK_CONTRACT_SELFTEST !== '0'/,
  'packaged production self-tests must not allow the behavioral runtime contract to be skipped',
);
const unifiedStackSource = readFileSync(join(desktop, 'src', 'main', 'unifiedStack.ts'), 'utf8');
assert.match(
  unifiedStackSource,
  /requireAttestation:\s*app\.isPackaged/,
  'packaged services must attest their exact service ID, runtime version, and process nonce',
);
assert.match(
  unifiedStackSource,
  /testRoot && !app\.isPackaged/,
  'a packaged app must never honor an external runtime-root override',
);
assert.doesNotMatch(
  unifiedStackSource,
  /app\.isPackaged \|\| process\.env\.IDACC_STACK_SELFTEST/,
  'packaged self-tests must exercise the runtime physically bundled in the app',
);
assert.match(releaseStackSmoke, /IDACC_STACK_SELFTEST_RESULT_FILE:\s*resultFile/);
assert.match(releaseStackSmoke, /IDACC_STACK_SELFTEST_READY_TIMEOUT_MS:\s*'90_000'/);
assert.match(releaseStackSmoke, /IDACC_STACK_RANDOM_PORTS:\s*'1'/);
assert.match(releaseStackSmoke, /IDACC_RUNTIME_ROOT:\s*''/);
assert.match(releaseStackSmoke, /timeout:\s*360_000/);
assert.doesNotMatch(
  releaseStackSmoke,
  /\b(?:manager|brain)Port\s*=\s*\d+/,
  'release stack smoke must use and report the randomly reserved service endpoints',
);
assert.match(releaseStackSmoke, /maxRetries:\s*process\.platform === 'win32'/);
assert.match(releaseStackSmoke, /mode\s*&\s*0o777\)\s*!==\s*0o600/);
assert.match(pkg.scripts?.['test:selftest-result-file'] || '', /selftest-result-file-smoke/);
assert.match(pkg.scripts?.['test:legacy-manager-updater-retired'] || '', /legacy-manager-updater-retired-smoke/);
assert.match(stageSource, /npmInvocation/);
assert.doesNotMatch(
  stageSource,
  /\brun\(\s*['"]npm['"]/,
  'runtime staging must not launch a bare npm command through shell-free child_process',
);
assert.equal(pkg.devDependencies?.tar, '7.5.22');
assert.match(stageSource, /import \{ extract as extractTar \} from 'tar'/);
assert.doesNotMatch(
  stageSource,
  /execFileSync\(\s*['"]tar['"]/,
  'runtime staging must not require an external tar executable',
);

const npmFixture = mkdtempSync(join(tmpdir(), 'idacc-npm-invocation-'));
try {
  const fixtureNode = join(npmFixture, process.platform === 'win32' ? 'node.exe' : 'node');
  const fixtureCli = join(npmFixture, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(dirname(fixtureCli), { recursive: true });
  writeFileSync(fixtureNode, '');
  writeFileSync(fixtureCli, '');
  const fixtureOptions = {
    env: { PATH: '' },
    execPath: fixtureNode,
    platform: 'win32',
  };
  const resolvedFixtureCli = realpathSync(fixtureCli);
  assert.equal(resolveNpmCli(fixtureOptions), resolvedFixtureCli);
  assert.deepEqual(
    npmInvocation(['ci', '--omit=dev'], fixtureOptions),
    {
      command: fixtureNode,
      args: [resolvedFixtureCli, 'ci', '--omit=dev'],
      source: 'resolved-cli',
      cli: resolvedFixtureCli,
    },
  );

  const windowsFallback = npmInvocation(['ci', '--omit=dev'], {
    env: { PATH: '', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    execPath: join(npmFixture, 'empty', 'nested', 'missing-node.exe'),
    platform: 'win32',
  });
  assert.equal(windowsFallback.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(windowsFallback.args, ['/d', '/s', '/c', 'npm.cmd ci --omit=dev']);
  assert.notEqual(windowsFallback.command, 'npm');
  assert.throws(
    () => npmInvocation(['run', 'build & whoami'], {
      env: { PATH: '', ComSpec: 'cmd.exe' },
      execPath: join(npmFixture, 'empty', 'nested', 'missing-node.exe'),
      platform: 'win32',
    }),
    /unsafe argument/,
  );
} finally {
  rmSync(npmFixture, { recursive: true, force: true });
}

const liveNpm = npmInvocation(['--version']);
const liveNpmResult = spawnSync(liveNpm.command, liveNpm.args, {
  cwd: desktop,
  encoding: 'utf8',
});
assert.equal(
  liveNpmResult.status,
  0,
  `resolved npm CLI must execute on the current platform: ${liveNpmResult.stderr || liveNpmResult.error?.message || ''}`,
);
assert.match(String(liveNpmResult.stdout).trim(), /^\d+\.\d+\.\d+(?:[-+].*)?$/);

const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
assert.match(workflow, /windows-(?:latest|2025|2022)/, 'CI must exercise Windows packaging');
assert.match(workflow, /ubuntu-(?:latest|24\.04|22\.04)/, 'CI must exercise Linux packaging');
assert.match(workflow, /RUNTIME_SOURCE_TOKEN/, 'CI must use the scoped runtime source token');
assert.doesNotMatch(workflow, /RUNTIME_READ_TOKEN|--allow-dirty-application/);
assert.equal(
  (workflow.match(/uses: actions\/checkout@/g) || []).length,
  (workflow.match(/persist-credentials: false/g) || []).length,
  'every CI checkout must remove its token before lifecycle scripts execute',
);

const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const actionPins = [
  ['checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 7, 10],
  ['setup-node', '820762786026740c76f36085b0efc47a31fe5020 # v7.0.0', 3, 6],
  ['upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1', 2, 2],
  ['download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1', 0, 5],
  ['attest', 'f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0', 0, 3],
];
for (const [action, pin, ciCount, releaseCount] of actionPins) {
  const pattern = new RegExp(
    `uses: actions/${action}@${String(pin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'g',
  );
  assert.equal(
    (workflow.match(pattern) || []).length,
    ciCount,
    `CI must use the reviewed Node 24 ${action} release pin everywhere`,
  );
  assert.equal(
    (releaseWorkflow.match(pattern) || []).length,
    releaseCount,
    `production release must use the reviewed Node 24 ${action} release pin everywhere`,
  );
}
for (const [name, source] of [
  ['CI', workflow],
  ['production release', releaseWorkflow],
]) {
  const fullDesktopAudits = source.match(/npm audit --prefix idctl-desktop --audit-level=high/g) || [];
  const desktopAudits = source.match(/npm audit --prefix idctl-desktop --omit=dev --audit-level=high/g) || [];
  const idctlAudits = source.match(/npm audit --prefix idctl --omit=dev --audit-level=high/g) || [];
  assert.equal(
    fullDesktopAudits.length,
    desktopAudits.length,
    `${name} workflow must audit the complete desktop build toolchain everywhere it audits the production payload`,
  );
  assert.ok(desktopAudits.length > 0, `${name} workflow must audit desktop production dependencies`);
  assert.equal(
    idctlAudits.length,
    desktopAudits.length,
    `${name} workflow must audit idctl everywhere it audits desktop production dependencies`,
  );
}
for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
  assert.match(releaseWorkflow, new RegExp(target), `production release is missing ${target}`);
}
assert.match(releaseWorkflow, /WINDOWS_CODESIGN_P12/);
assert.match(releaseWorkflow, /MACOS_DEVELOPER_ID_P12/);
assert.match(releaseWorkflow, /MACOS_EXPECTED_TEAM_ID/);
assert.match(releaseWorkflow, /MACOS_EXPECTED_SIGNING_IDENTITY/);
assert.match(releaseWorkflow, /WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
assert.match(releaseWorkflow, /node scripts\/run-production-builder\.mjs/);
assert.match(releaseWorkflow, /node idctl-desktop\/scripts\/verify-packaged-publisher\.mjs/);
assert.match(releaseWorkflow, /SignerCertificate\.Subject -cne \$env:WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
assert.match(releaseWorkflow, /TeamIdentifier=\/\//);
assert.match(releaseWorkflow, /Developer ID Application: \$MACOS_EXPECTED_SIGNING_IDENTITY/);
assert.match(releaseWorkflow, /certificate leaf\[subject\.OU\] =/);
assert.match(releaseWorkflow, /1\.2\.840\.113635\.100\.6\.1\.13/);
assert.match(releaseWorkflow, /merge-update-metadata\.mjs/);
assert.match(releaseWorkflow, /merge-release-metadata\.mjs/);
assert.match(releaseWorkflow, /node scripts\/verify-update-descriptors\.mjs/);
assert.match(releaseWorkflow, /npm run test:update-descriptor-contract --prefix idctl-desktop/);
assert.match(releaseWorkflow, /npm run test:updater-public-provider --prefix idctl-desktop/);
assert.match(workflow, /npm run test:update-descriptor-contract --prefix idctl-desktop/);
assert.match(workflow, /npm run test:updater-public-provider --prefix idctl-desktop/);
assert.match(releaseWorkflow, /RUNTIME_SOURCE_TOKEN/);
assert.match(releaseWorkflow, /runtime-source-tests:/);
assert.match(releaseWorkflow, /Require GitHub-enforced immutable releases/);
assert.match(releaseWorkflow, /repos\/\$GITHUB_REPOSITORY\/immutable-releases/);
assert.equal(
  (releaseWorkflow.match(/GH_TOKEN="\$RELEASE_ADMIN_TOKEN" gh api/g) || []).length,
  3,
  'every immutable-releases setting read must use the dedicated repository Administration token',
);
assert.equal(
  (releaseWorkflow.match(/repos\/\$GITHUB_REPOSITORY\/immutable-releases/g) || []).length,
  3,
  'immutability must be preflighted before validation, initial publication, and draft promotion',
);
assert.match(releaseWorkflow, /xcrun notarytool submit "\$DMG"/);
assert.match(releaseWorkflow, /xcrun stapler staple "\$DMG"/);
assert.match(releaseWorkflow, /codesign --verify --verbose=2 "\$DMG"/);
assert.match(releaseWorkflow, /verify-public-release:/);
assert.match(releaseWorkflow, /node scripts\/verify-public-release\.mjs/);
assert.match(releaseWorkflow, /Verify the unauthenticated public release and updater downloads/);
assert.match(releaseWorkflow, /Verify GitHub locked the published release/);
assert.match(releaseWorkflow, /Verify GitHub locked the promoted release/);
assert.match(releaseWorkflow, /npm run ci:preflight --prefix \.runtime-sources\/manager/);
assert.match(releaseWorkflow, /npm test --prefix \.runtime-sources\/brain/);
assert.equal(
  (releaseWorkflow.match(/uses: actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4\.2\.0/g) || []).length,
  3,
  'production provenance and SBOMs must use the current SHA-pinned unified GitHub attestation action',
);
assert.doesNotMatch(
  releaseWorkflow,
  /actions\/attest-(?:build-provenance|sbom)@/,
  'deprecated attestation wrapper actions must not re-enter the production release',
);
assert.equal(
  (releaseWorkflow.match(/artifact-metadata: write/g) || []).length,
  2,
  'each attestation job must grant the artifact metadata permission required by actions/attest v4',
);
for (const source of [workflow, releaseWorkflow]) {
  for (const focusedSmoke of [
    'identity-verification-smoke.ts',
    'health-classification-smoke.ts',
    'computer-use-policy-smoke.ts',
    'consumer-design-gaps-smoke.ts',
    'test:subscription-portability',
  ]) {
    assert.match(source, new RegExp(focusedSmoke.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}
assert.doesNotMatch(releaseWorkflow, /RUNTIME_READ_TOKEN|--allow-dirty-application/);
assert.doesNotMatch(releaseWorkflow, /npm run build(?:\s|$)/, 'production workflow builds must use build:release');
assert.match(releaseWorkflow, /publish\/latest-mac\.yml/);
assert.equal(
  (releaseWorkflow.match(/uses: actions\/checkout@/g) || []).length,
  (releaseWorkflow.match(/persist-credentials: false/g) || []).length,
  'every production checkout must remove its token before lifecycle scripts execute',
);

await import('../../scripts/release-command-smoke.mjs');

console.log('release platform configuration smoke: ok');
