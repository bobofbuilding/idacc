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
const mainWindowSource = readFileSync(join(desktop, 'src', 'main', 'main.ts'), 'utf8');
const rendererSource = readFileSync(join(desktop, 'src', 'renderer', 'App.tsx'), 'utf8');
assert.match(
  mainWindowSource,
  /titleBarStyle:\s*process\.platform === 'darwin'\s*\?\s*'hiddenInset'\s*:\s*'default'/,
  'macOS may use hiddenInset, but Windows and Linux must retain native window controls',
);
assert.match(
  rendererSource,
  /\/Mac\|iPhone\|iPad\|iPod\/i\.test\(navigator\.platform\)[\s\S]*\?\s*'⌘K'[\s\S]*:\s*'Ctrl\+K'/,
  'the visible command-palette shortcut must match macOS versus Windows/Linux keyboards',
);
assert.ok(
  build.asarUnpack?.includes('out/native/idacc-job-host.exe'),
  'the Windows Job Host must be executable outside app.asar',
);
assert.ok(
  build.asarUnpack?.includes('out/main/managed-service-bootstrap.cjs'),
  'the managed-service bootstrap path must match the unpacked runtime contract',
);
assert.ok(
  build.asarUnpack?.includes('out/main/mcp-probe-runner.cjs'),
  'the managed MCP probe runner must be executable outside app.asar',
);
assert.equal(
  pkg.scripts?.['test:windows-job-host'],
  'node scripts/windows-job-host-integration-smoke.mjs',
);
assert.equal(
  pkg.scripts?.['test:windows-native-toolchain'],
  'node scripts/build.mjs --probe-windows-native-toolchain',
);
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
const tauriConfig = JSON.parse(
  readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'),
);
const tauriCargo = readFileSync(
  join(desktop, 'src-tauri', 'Cargo.toml'),
  'utf8',
);
const tauriFrontendBuilder = readFileSync(
  join(desktop, 'scripts', 'build-tauri.mjs'),
  'utf8',
);
const retiredTauriScript = join(
  desktop,
  'scripts',
  'retired-tauri-production.mjs',
);
for (const script of ['tauri', 'tauri:dev', 'tauri:build']) {
  assert.equal(
    pkg.scripts?.[script],
    'node scripts/retired-tauri-production.mjs',
    `${script} must fail closed instead of producing a non-unified application`,
  );
}
assert.equal(
  pkg.scripts?.['dev:tauri-simulation'],
  'node scripts/run-tauri-simulation.mjs',
);
assert.equal(pkg.dependencies?.['@tauri-apps/api'], undefined);
assert.equal(pkg.dependencies?.['@tauri-apps/plugin-http'], undefined);
assert.match(pkg.devDependencies?.['@tauri-apps/api'] || '', /^\^2\./);
assert.match(pkg.devDependencies?.['@tauri-apps/plugin-http'] || '', /^\^2\./);
assert.equal(tauriConfig.bundle?.active, false);
assert.match(tauriConfig.productName, /Simulation \(Developer Only\)/);
assert.match(tauriConfig.identifier, /interface-simulation$/);
assert.match(tauriCargo, /^name = "idacc-interface-simulation"$/m);
assert.match(tauriCargo, /Developer-only interface simulation/);
assert.match(
  tauriFrontendBuilder,
  /IDACC_TAURI_SIMULATION !== 'developer-only'/,
);
const retiredTauri = spawnSync(process.execPath, [retiredTauriScript], {
  cwd: desktop,
  encoding: 'utf8',
});
assert.notEqual(retiredTauri.status, 0);
assert.match(
  `${retiredTauri.stdout}\n${retiredTauri.stderr}`,
  /does not bundle or supervise Manager and Brain/,
);
assert.match(
  gitignore,
  /^\/idctl-desktop\/resources\/THIRD_PARTY_NOTICES\.md$/m,
  'generated dependency notices must not dirty the exact application source used for runtime staging',
);
const stageSource = readFileSync(join(desktop, 'scripts', 'stage-unified-runtime.mjs'), 'utf8');
assert.match(pkg.scripts?.['build:release'] || '', /--require-runtime/);
const tsxPackageScripts = Object.entries(pkg.scripts || {})
  .filter(([, command]) => String(command).includes('tsx/dist/cli.mjs'));
assert.deepEqual(
  tsxPackageScripts.map(([name]) => name).sort(),
  [
    'test:brain-plans-profile',
    'test:chat-delegation',
    'test:computer-use-policy',
    'test:computer-use-retention',
    'test:consumer-onboarding',
    'test:context-budget-retention',
    'test:health-classification',
    'test:identity-verification',
    'test:learn-brain-sync',
    'test:learn-queue',
    'test:provider-runtime-rehydration',
    'test:runtime-profile-isolation',
    'test:secret-redaction',
    'test:startup-recovery',
    'test:subscription-portability',
  ],
  'every TypeScript smoke using tsx must remain covered',
);
for (const [name, command] of tsxPackageScripts) {
  assert.match(
    String(command),
    /^node \.\.\/idctl\/node_modules\/tsx\/dist\/cli\.mjs scripts\/[a-z0-9-]+\.ts$/,
    `${name} must invoke the cross-platform tsx JavaScript entrypoint through Node`,
  );
}
assert.doesNotMatch(
  Object.values(pkg.scripts || {}).join('\n'),
  /node_modules\/\.bin\/tsx/,
  'desktop scripts must not invoke the POSIX-only tsx shim path',
);
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
assert.equal(
  (build.extraResources || []).some((entry) => entry?.to === 'idacc-context-retrieval'),
  false,
  'the retired retrieval pilot must not ship as a user-manageable plugin resource',
);
assert.equal(
  existsSync(join(desktop, 'resources', 'idacc-context-retrieval')),
  false,
  'the retired retrieval pilot source directory must not remain in the application bundle inputs',
);
assert.equal(
  existsSync(join(desktop, 'src', 'main', 'headroomPlugin.ts')),
  false,
  'the retired retrieval pilot validator must not remain as a dormant main-process feature',
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
assert.equal(
  build.toolsets?.appimage,
  '1.0.3',
  'AppImage packaging must use the exact supported static-runtime toolset instead of the legacy FUSE2 default',
);
assert.deepEqual(
  build.appImage?.executableArgs,
  [],
  'the shipped AppImage desktop launcher must not receive unconditional sandbox-disabling arguments',
);
assert.equal(
  pkg.scripts?.['test:appimage-artifact'],
  'node ../scripts/appimage-artifact-verifier-smoke.mjs',
);
assert.equal(
  pkg.scripts?.['test:deb-artifact'],
  'node ../scripts/deb-artifact-verifier-smoke.mjs',
);

assert.match(String(pkg.devDependencies?.electron || ''), /^41\.\d+\.\d+$/, 'Electron 41 is the newest line compatible with manager better-sqlite3 12.8');
assert.match(String(pkg.dependencies?.['electron-updater'] || ''), /^\d+\.\d+\.\d+$/, 'electron-updater must be exact');
assert.match(String(pkg.scripts?.['build:release'] || ''), /--require-runtime/, 'production builds must require a verified staged runtime');
assert.match(pkg.scripts?.['test:update-descriptor-contract'] || '', /update-descriptor-contract-smoke/);
assert.match(pkg.scripts?.['test:updater-public-provider'] || '', /electron-updater-public-provider-smoke/);
assert.match(pkg.scripts?.['test:credential-isolation'] || '', /credential-environment-smoke/);
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
const dashboardRenderedSmoke = readFileSync(
  join(desktop, 'scripts', 'dashboard-rendered-smoke.mjs'),
  'utf8',
);
const supervisorIntegrationSmoke = readFileSync(
  join(desktop, 'scripts', 'unified-stack-supervisor-integration.mjs'),
  'utf8',
);
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
  /--(?:no-sandbox|disable-setuid-sandbox)/,
  'the packaged production smoke must exercise Electron with its sandbox defaults',
);
assert.match(
  dashboardRenderedSmoke,
  /process\.platform === 'linux'\s*&&\s*process\.env\.CI === 'true'\s*&&\s*process\.env\.GITHUB_ACTIONS === 'true'/,
  'the rendered dashboard sandbox bypass must remain restricted to GitHub Actions on Linux',
);
assert.match(
  dashboardRenderedSmoke,
  /isGitHubActionsLinux\s*\?\s*\['--no-sandbox', main\]\s*:\s*\[main\]/,
  'the rendered dashboard smoke may bypass an unavailable GitHub-hosted Linux sandbox only behind its narrow guard',
);
assert.equal(
  (dashboardRenderedSmoke.match(/--no-sandbox/g) || []).length,
  1,
  'the rendered dashboard smoke must contain exactly one narrowly gated sandbox bypass',
);
assert.doesNotMatch(
  dashboardRenderedSmoke,
  /--disable-setuid-sandbox/,
  'the ineffective setuid-only bypass must not mask GitHub-hosted Linux sandbox failures',
);
assert.match(
  supervisorIntegrationSmoke,
  /process\.platform === 'linux'\s*&&\s*process\.env\.CI === 'true'\s*&&\s*process\.env\.GITHUB_ACTIONS === 'true'/,
  'the supervisor integration sandbox bypass must remain restricted to GitHub Actions on Linux',
);
assert.match(
  supervisorIntegrationSmoke,
  /isGitHubActionsLinux\s*\?\s*\['--no-sandbox', '\.'\]\s*:\s*\['\.'\]/,
  'the supervisor integration may bypass an unavailable GitHub-hosted Linux sandbox only behind its narrow guard',
);
assert.equal(
  (supervisorIntegrationSmoke.match(/--no-sandbox/g) || []).length,
  1,
  'the supervisor integration must contain exactly one narrowly gated sandbox bypass',
);
assert.doesNotMatch(
  supervisorIntegrationSmoke,
  /--disable-setuid-sandbox/,
  'the supervisor integration must not use an ineffective setuid-only sandbox bypass',
);
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

const workflow = readFileSync(
  join(root, '.github', 'workflows', 'ci.yml'),
  'utf8',
).replace(/\r\n?/g, '\n');
assert.match(workflow, /windows-(?:latest|2025|2022)/, 'CI must exercise Windows packaging');
assert.match(workflow, /ubuntu-(?:latest|24\.04|22\.04)/, 'CI must exercise Linux packaging');
const crossPlatformStaticJob = workflow.slice(
  workflow.indexOf('  cross-platform-static:'),
  workflow.indexOf('\n  reproducible-macos-runtime:'),
);
assert.match(
  crossPlatformStaticJob,
  /\n    defaults:\n      run:\n        shell: bash\n/,
  'cross-platform static commands must use the GitHub bash fail-fast/pipefail runner on Windows too',
);
assert.doesNotMatch(
  workflow,
  /RUNTIME_SOURCE_TOKEN|RUNTIME_READ_TOKEN|--allow-dirty-application/,
  'CI must use the committed Brain capsule and never depend on a private runtime-source token',
);
assert.match(workflow, /node scripts\/runtime-source-capsule\.mjs materialize/);
assert.match(workflow, /npm run test:runtime-source-capsule --prefix idctl-desktop/);
assert.match(workflow, /token:\s*\$\{\{\s*github\.token\s*\}\}/);
assert.equal(
  (workflow.match(/uses: actions\/checkout@/g) || []).length,
  (workflow.match(/persist-credentials: false/g) || []).length,
  'every CI checkout must remove its token before lifecycle scripts execute',
);

for (const smokePath of [
  'dashboard-command-surface-smoke.mjs',
  'dashboard-activity-filter-smoke.mjs',
]) {
  const smokeSource = readFileSync(join(desktop, 'scripts', smokePath), 'utf8');
  assert.match(smokeSource, /fileURLToPath\(new URL\(/, `${smokePath} must decode file URLs as platform paths`);
  assert.doesNotMatch(smokeSource, /\.pathname\b/, `${smokePath} must not pass URL pathnames to Windows tools`);
  assert.match(smokeSource, /pathToFileURL\(outfile\)\.href/, `${smokePath} must encode output paths as canonical file URLs`);
  assert.doesNotMatch(smokeSource, /file:\/\/\$\{outfile\}/, `${smokePath} must not interpolate Windows paths into file URLs`);
}
const computerUseSessionSmoke = readFileSync(
  join(desktop, 'scripts', 'computer-use-session-discovery-smoke.mjs'),
  'utf8',
);
assert.match(
  computerUseSessionSmoke,
  /const legacyFallback = startMcp\(\{\s*HOME: legacyHome,\s*USERPROFILE: legacyHome,/,
  'the legacy Computer Use fallback fixture must select the same synthetic home on Windows',
);
const releasePublicationCliSmoke = readFileSync(
  join(root, 'scripts', 'release-publication-cli-smoke.mjs'),
  'utf8',
);
assert.match(
  releasePublicationCliSmoke,
  /const fixtureCommit = command\('git', \['rev-parse', 'HEAD'\]/,
  'the publication CLI smoke must derive its own disposable fixture commit',
);
assert.match(
  releasePublicationCliSmoke,
  /targetCommit: fixtureCommit/,
  'the publication CLI smoke must not depend on historical commits existing in a shallow caller',
);
assert.match(
  releasePublicationCliSmoke,
  /marker\.baselinePublishedTag,\s*\.\.\.marker\.legacyTags\.map/,
  'the publication CLI smoke must synthesize its complete baseline and legacy tag fixture',
);

const releaseWorkflow = readFileSync(
  join(root, '.github', 'workflows', 'release.yml'),
  'utf8',
).replaceAll('\r\n', '\n');
const publishReleaseJob = releaseWorkflow.slice(
  releaseWorkflow.indexOf('  publish:\n'),
  releaseWorkflow.indexOf('\n  promote-draft:'),
);
assert.match(
  publishReleaseJob,
  /env:\s*\n\s+GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/,
  'the artifact-only publish job must bind gh release commands to the target repository',
);
const actionPins = [
  ['checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 5, 8],
  ['setup-node', '820762786026740c76f36085b0efc47a31fe5020 # v7.0.0', 3, 6],
  ['upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1', 2, 2],
  ['download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1', 0, 5],
  ['attest', '508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4.2.1', 0, 3],
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
  assert.match(
    source,
    /npm run test:appimage-artifact --prefix idctl-desktop/,
    `${name} must run the AppImage verifier fixtures`,
  );
  assert.match(
    source,
    /npm run test:deb-artifact --prefix idctl-desktop/,
    `${name} must run the Debian-package verifier fixtures`,
  );
  assert.equal(
    (source.match(/node scripts\/verify-appimage-artifact\.mjs/g) || []).length,
    1,
    `${name} must inspect exactly one built Linux AppImage`,
  );
  assert.equal(
    (source.match(/node scripts\/verify-deb-artifact\.mjs/g) || []).length,
    1,
    `${name} must inspect exactly one built Linux Debian package`,
  );
  assert.match(
    source,
    /- name: Verify the Linux installer sandbox policies\s+if: matrix\.platform == 'linux'[\s\S]*?node scripts\/verify-appimage-artifact\.mjs\s*\\\s*\n\s*--appimage "\$\{APPIMAGES\[0\]\}"[\s\S]*?node scripts\/verify-deb-artifact\.mjs\s*\\\s*\n\s*--deb "\$\{DEBS\[0\]\}"/,
    `${name} must keep both installer artifact gates Linux-only`,
  );
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
for (const windowsRunner of ['windows-2022', 'windows-2025']) {
  assert.match(
    workflow,
    new RegExp(`- ${windowsRunner}`),
    `CI must exercise native-helper discovery on ${windowsRunner}`,
  );
}
assert.match(
  workflow,
  /Verify the Windows native compiler and helper sources[\s\S]*if: runner\.os == 'Windows'[\s\S]*npm run test:windows-native-toolchain --prefix idctl-desktop/,
  'CI must probe the native compiler before the full Windows build',
);
const nativeReleaseBuildJob = releaseWorkflow.slice(
  releaseWorkflow.indexOf('  native-build:'),
  releaseWorkflow.indexOf('\n  attest-native:'),
);
assert.match(
  nativeReleaseBuildJob,
  /- name: Verify real Windows profile ACL hardening\s+if: matrix\.platform == 'win'\s+shell: bash\s+run: npm run test:profile-migrations --prefix idctl-desktop/,
  'the exact signed Windows release commit must pass the real ACL migration smoke before packaging',
);
const unsignedWindowsNativeStep =
  nativeReleaseBuildJob.indexOf('- name: Build and exercise unsigned Windows native helpers');
const signedNativeBuildStep =
  nativeReleaseBuildJob.indexOf('- name: Build signed native consumer artifacts');
assert.ok(
  unsignedWindowsNativeStep >= 0
    && signedNativeBuildStep > unsignedWindowsNativeStep,
  'the native release job must exercise an unsigned Windows build before its signed build',
);
for (const command of [
  'npm run test:windows-native-toolchain',
  'npm run build',
  'npm run test:windows-job-host',
  'npm run test:windows-profile-native-build',
]) {
  assert.ok(
    nativeReleaseBuildJob.slice(
      unsignedWindowsNativeStep,
      signedNativeBuildStep,
    ).includes(command),
    `the unsigned Windows native release step is missing: ${command}`,
  );
}
assert.match(
  nativeReleaseBuildJob.slice(unsignedWindowsNativeStep, signedNativeBuildStep),
  /if: matrix\.platform == 'win'[\s\S]*CSC_IDENTITY_AUTO_DISCOVERY: "false"[\s\S]*WIN_CSC_LINK: ""[\s\S]*WINDOWS_EXPECTED_PUBLISHER_SUBJECT: ""/,
  'the Windows native helper regression must run without production signing inputs',
);
assert.match(releaseWorkflow, /WINDOWS_CODESIGN_P12/);
assert.match(releaseWorkflow, /MACOS_DEVELOPER_ID_P12/);
assert.match(releaseWorkflow, /MACOS_EXPECTED_TEAM_ID/);
assert.match(releaseWorkflow, /MACOS_EXPECTED_SIGNING_IDENTITY/);
assert.match(releaseWorkflow, /WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
assert.match(releaseWorkflow, /node scripts\/run-production-builder\.mjs/);
assert.match(releaseWorkflow, /signing_mode:\s*[\s\S]*- signed[\s\S]*- unsigned/);
assert.match(releaseWorkflow, /publish-v\$RELEASE_VERSION-unsigned/);
assert.match(releaseWorkflow, /Build owner-authorized unsigned stable artifacts/);
assert.match(releaseWorkflow, /--config\.publish\.channel=latest/);
assert.match(releaseWorkflow, /scripts\/unsigned-stable-after-sign\.mjs/);
assert.match(
  releaseWorkflow,
  /node scripts\/run-unsigned-stable-builder\.mjs[\s\S]*--application-version "\$RELEASE_VERSION"[\s\S]*--config\.extraMetadata\.version="\$RELEASE_VERSION"[\s\S]*--publish never/,
  'unsigned stable packages must use the policy-normalizing builder API wrapper',
);
const unsignedStableBuildStep = releaseWorkflow.slice(
  releaseWorkflow.indexOf('- name: Build owner-authorized unsigned stable artifacts'),
  releaseWorkflow.indexOf('- name: Verify the Linux installer sandbox policies'),
);
assert.match(unsignedStableBuildStep, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
assert.match(
  unsignedStableBuildStep,
  /if \[ "\$\{\{ matrix\.platform \}\}" = mac \]; then\s+sudo sysctl -w kern\.maxfiles=524288\s+sudo sysctl -w kern\.maxfilesperproc=524288\s+ulimit -n 524288\s+test "\$\(ulimit -n\)" = 524288\s+fi/,
  'unsigned stable macOS packaging must raise the runner file limit for the unified runtime',
);
for (const harmfulEmptySigningVariable of [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_EXPECTED_PUBLISHER_SUBJECT',
]) {
  assert.doesNotMatch(
    unsignedStableBuildStep,
    new RegExp(`^\\s*${harmfulEmptySigningVariable}:`, 'm'),
    `${harmfulEmptySigningVariable} must remain absent instead of resolving an empty certificate path`,
  );
}
assert.doesNotMatch(
  releaseWorkflow,
  /node node_modules\/electron-builder\/out\/cli\/cli\.js/,
  'the production workflow must not bypass normalized builder configuration',
);
const unsignedStableBuilder = join(
  desktop,
  'scripts',
  'run-unsigned-stable-builder.mjs',
);
const unsignedStableCommonArgs = [
  '--config.publish.provider=github',
  '--config.publish.owner=bobofbuilding',
  '--config.publish.repo=idacc',
  '--config.publish.releaseType=release',
  '--config.publish.channel=latest',
  `--config.extraMetadata.version=${pkg.version}`,
  '--publish',
  'never',
];
for (const [platform, targetArgs, policyArgs] of [
  [
    'mac',
    ['--mac', 'dmg', 'zip', '--arm64'],
    [
      '--config.mac.identity=-',
      '--config.mac.notarize=false',
      '--config.mac.hardenedRuntime=false',
      '--config.mac.requirements=build/review-requirements.txt',
      '--config.mac.signIgnore=/Contents/Resources/idacc-runtime/',
      '--config.afterSign=scripts/unsigned-stable-after-sign.mjs',
      '--config.dmg.sign=false',
    ],
  ],
  ['win', ['--win', 'nsis', '--x64'], ['--config.win.signExecutable=false']],
  ['linux', ['--linux', 'AppImage', 'deb', '--x64'], []],
]) {
  const result = spawnSync(process.execPath, [
    unsignedStableBuilder,
    '--platform', platform,
    '--application-version', pkg.version,
    '--policy-only',
    '--',
    ...targetArgs,
    ...policyArgs,
    ...unsignedStableCommonArgs,
  ], {
    cwd: desktop,
    encoding: 'utf8',
    env: {
      ...process.env,
      IDACC_UNSIGNED_STABLE_BUILD: '1',
      IDACC_UNSIGNED_STABLE_VERSION: pkg.version,
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      WIN_CSC_LINK: '',
      WIN_CSC_KEY_PASSWORD: '',
      WINDOWS_EXPECTED_PUBLISHER_SUBJECT: '',
    },
  });
  assert.equal(
    result.status,
    0,
    `unsigned stable ${platform} builder policy failed:\n${result.stderr}`,
  );
  assert.match(result.stdout, /unsigned stable builder policy: ok/);
}
assert.match(releaseWorkflow, /scripts\/verify-unsigned-stable-package\.mjs/);
assert.match(releaseWorkflow, /node idctl-desktop\/scripts\/verify-packaged-publisher\.mjs/);
assert.match(releaseWorkflow, /SignerCertificate\.Subject -cne \$env:WINDOWS_EXPECTED_PUBLISHER_SUBJECT/);
assert.match(
  releaseWorkflow,
  /resources\/app\.asar\.unpacked\/out\/native\/idacc-job-host\.exe/,
  'production release must explicitly locate the packaged Job Host',
);
assert.match(
  releaseWorkflow,
  /foreach \(\$file in @\(\$app, \$installer\.FullName, \$jobHost\)\)/,
  'production release must Authenticode-verify the packaged Job Host',
);
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
assert.match(releaseWorkflow, /npm run test:unified-updater-integrity --prefix idctl-desktop/);
assert.match(releaseWorkflow, /npm run test:unified-updater-download --prefix idctl-desktop/);
assert.match(workflow, /npm run test:unified-updater-integrity --prefix idctl-desktop/);
assert.match(workflow, /npm run test:unified-updater-download --prefix idctl-desktop/);
assert.match(workflow, /npm run test:windows-job-host --prefix idctl-desktop/);
assert.doesNotMatch(releaseWorkflow, /RUNTIME_SOURCE_TOKEN/);
assert.match(releaseWorkflow, /node scripts\/runtime-source-capsule\.mjs materialize/);
assert.match(releaseWorkflow, /npm run test:runtime-source-capsule --prefix idctl-desktop/);
assert.match(releaseWorkflow, /token:\s*\$\{\{\s*github\.token\s*\}\}/);
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
assert.match(releaseWorkflow, /npm ci --omit=dev --prefix \.runtime-sources\/brain/);
assert.match(releaseWorkflow, /xargs -0 -n1 node --check/);
assert.equal(
  (releaseWorkflow.match(/uses: actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4\.2\.1/g) || []).length,
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
    'test:goals-plan-separation',
    'test:credential-isolation',
    'test:chat-delegation',
    'test:startup-recovery',
    'test:release-payload',
    'runtimeCatalog.test.ts',
  ]) {
    assert.match(source, new RegExp(focusedSmoke.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}
assert.doesNotMatch(releaseWorkflow, /RUNTIME_READ_TOKEN|--allow-dirty-application/);
assert.equal(
  (releaseWorkflow.match(/npm run build(?:\s|$)/g) || []).length,
  1,
  'the only development build in production workflow must be the verified unsigned Windows native regression',
);
assert.match(releaseWorkflow, /publish\/latest-mac\.yml/);
assert.equal(
  (releaseWorkflow.match(/uses: actions\/checkout@/g) || []).length,
  (releaseWorkflow.match(/persist-credentials: false/g) || []).length,
  'every production checkout must remove its token before lifecycle scripts execute',
);

await import('../../scripts/release-command-smoke.mjs');

console.log('release platform configuration smoke: ok');
