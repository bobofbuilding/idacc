#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
  unifiedStackReleaseSmokePolicy,
} from './unified-stack-release-smoke-policy.mjs';
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
} from '../idctl-desktop/scripts/main-process-startup-policy.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(root, '.github', 'workflows', 'review-build.yml'), 'utf8')
  .replace(/\r\n?/g, '\n');
const ciWorkflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  .replace(/\r\n?/g, '\n');
const productionWorkflow = readFileSync(
  join(root, '.github', 'workflows', 'release.yml'),
  'utf8',
).replace(/\r\n?/g, '\n');
const pkg = JSON.parse(readFileSync(join(root, 'idctl-desktop', 'package.json'), 'utf8'));
const builder = readFileSync(join(root, 'idctl-desktop', 'scripts', 'build.mjs'), 'utf8');
const productionBuilder = readFileSync(
  join(root, 'idctl-desktop', 'scripts', 'run-production-builder.mjs'),
  'utf8',
);
const releaseBuildSmoke = readFileSync(
  join(root, 'idctl-desktop', 'scripts', 'release-build-smoke.mjs'),
  'utf8',
);
const mainProcessStartupPolicy = readFileSync(
  join(root, 'idctl-desktop', 'scripts', 'main-process-startup-policy.mjs'),
  'utf8',
);
const releaseStackHarness = readFileSync(
  join(root, 'scripts', 'unified-stack-release-smoke.mjs'),
  'utf8',
);
const mainSource = readFileSync(join(root, 'idctl-desktop', 'src', 'main', 'main.ts'), 'utf8');
const unifiedStackSource = readFileSync(
  join(root, 'idctl-desktop', 'src', 'main', 'unifiedStack.ts'),
  'utf8',
);
const reviewBuilderPath = join(root, 'idctl-desktop', 'scripts', 'run-review-builder.mjs');
const reviewBuilder = readFileSync(reviewBuilderPath, 'utf8');
const updater = readFileSync(join(root, 'idctl-desktop', 'src', 'main', 'updater.ts'), 'utf8');
const notice = readFileSync(join(root, 'release', 'REVIEW-NOTICE.md'), 'utf8');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
const gitAttributes = readFileSync(join(root, '.gitattributes'), 'utf8');
const helper = join(root, 'scripts', 'review-artifact-bundle.mjs');
const helperSource = readFileSync(helper, 'utf8');
const appImageVerifier = readFileSync(
  join(root, 'scripts', 'verify-appimage-artifact.mjs'),
  'utf8',
);
const appImageVerifierSmoke = readFileSync(
  join(root, 'scripts', 'appimage-artifact-verifier-smoke.mjs'),
  'utf8',
);
const debVerifier = readFileSync(
  join(root, 'scripts', 'verify-deb-artifact.mjs'),
  'utf8',
);
const debVerifierSmoke = readFileSync(
  join(root, 'scripts', 'deb-artifact-verifier-smoke.mjs'),
  'utf8',
);

function readApplicationSourceTree(path) {
  let source = '';
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      source += readApplicationSourceTree(entryPath);
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      source += `\n${readFileSync(entryPath, 'utf8')}`;
    }
  }
  return source;
}

const applicationSourceTree = readApplicationSourceTree(
  join(root, 'idctl-desktop', 'src'),
);

assert.equal(
  pkg.scripts?.['test:review-build-workflow'],
  'node ../scripts/review-build-workflow-smoke.mjs',
);
assert.equal(
  pkg.scripts?.['test:appimage-artifact'],
  'node ../scripts/appimage-artifact-verifier-smoke.mjs',
);
assert.equal(
  pkg.scripts?.['test:deb-artifact'],
  'node ../scripts/deb-artifact-verifier-smoke.mjs',
);
assert.equal(pkg.build?.toolsets?.appimage, '1.0.3');
assert.deepEqual(pkg.build?.appImage?.executableArgs, []);
assert.match(ciWorkflow, /npm run test:review-build-workflow --prefix idctl-desktop/);
assert.match(ciWorkflow, /npm run test:appimage-artifact --prefix idctl-desktop/);
assert.match(ciWorkflow, /npm run test:deb-artifact --prefix idctl-desktop/);
assert.match(ciWorkflow, /npm run test:runtime-source-capsule --prefix idctl-desktop/);
for (const script of [
  'test:credential-isolation',
  'test:secure-settings-vault',
  'test:profile-migrations',
  'test:startup-recovery',
  'test:provider-runtime-rehydration',
  'test:runtime-profile-isolation',
  'test:context-budget-retention',
  'test:chat-failure',
  'test:brain-plans-profile',
  'test:goals-plan-separation',
  'test:consumer-onboarding',
  'test:consumer-onboarding-integration',
  'test:selftest-result-file',
  'test:legacy-manager-updater-retired',
]) {
  assert.match(
    workflow,
    new RegExp(`npm run ${script.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} --prefix idctl-desktop`),
    `unsigned review artifacts must be gated by ${script}`,
  );
}
assert.match(workflow, /^name:\s*Unsigned native review bundle$/m);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
assert.match(workflow, /^\s*-\s*agent\/\*\*\s*$/m);
assert.match(workflow, /\^refs\/heads\/agent\/\.\+/);
assert.match(workflow, /Unsigned review builds may run only from an agent\/\*\* branch/);
assert.match(workflow, /\[ "\$GITHUB_ACTOR" != "\$GITHUB_REPOSITORY_OWNER" \]/);
assert.match(workflow, /Only the repository owner may start an unsigned review build/);
assert.ok(
  workflow.indexOf('$GITHUB_ACTOR') < workflow.indexOf('actions/checkout@'),
  'the repository-owner guard must run before checkout',
);
assert.doesNotMatch(
  workflow,
  /\$\{\{\s*secrets\./,
  'credential-free review builds must not reference repository or environment secrets',
);
assert.match(
  workflow,
  /^permissions:\s*\n\s*contents:\s*read\s*\n\s*statuses:\s*write\s*$/m,
);
assert.equal((workflow.match(/contents:\s*write/g) || []).length, 1);
assert.match(
  workflow,
  /assemble-review-bundle:[\s\S]*?permissions:\s*\n\s*contents:\s*write/,
  'only the final isolated prerelease publisher may write release contents',
);
assert.doesNotMatch(workflow, /id-token:\s*write|attestations:\s*write|actions:\s*write|packages:\s*write/);
assert.match(workflow, /context=idacc\/unsigned-review-run/);
assert.match(
  workflow,
  /target_url="\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID"/,
);
assert.match(workflow, /report-review-status:\s*\n[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/);
assert.match(workflow, /STATE=success[\s\S]*?Unsigned multi-OS review bundle is verified/);
assert.match(
  workflow,
  /IDACC_MANAGER_SOURCE:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.runtime-sources\/manager/,
);
assert.match(workflow, /IDACC_REQUIRE_MANAGER_POLICY_SOURCE:\s*"1"/);
assert.match(workflow, /gh release create "\$TAG"[\s\S]*--prerelease/);
assert.match(workflow, /test "\$\(gh release view "\$TAG"[\s\S]*\.isPrerelease\)" = true/);
assert.doesNotMatch(workflow, /action-gh-release|create-release|upload-release-asset|softprops/i);
assert.doesNotMatch(workflow, /\benvironment:\s*production\b/);
assert.doesNotMatch(workflow, /--require-signing/);
assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/);
for (const credential of [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_EXPECTED_PUBLISHER_SUBJECT',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_TEAM_ID',
]) {
  assert.doesNotMatch(
    workflow,
    new RegExp(`^\\s*${credential}:`, 'm'),
    `${credential} must not be exported in credential-free review jobs`,
  );
}
assert.equal(
  (workflow.match(/^\s*token:\s*\$\{\{\s*github\.token\s*\}\}\s*$/gm) || []).length,
  2,
  'only the two public Manager checkout steps may use the scoped automatic token',
);
assert.equal(
  (workflow.match(/uses:\s*actions\/checkout@/g) || []).length,
  (workflow.match(/^\s*persist-credentials:\s*false\s*$/gm) || []).length,
  'every review checkout must disable credential persistence',
);
assert.match(workflow, /npm run ci:preflight --prefix \.runtime-sources\/manager/);
assert.match(workflow, /npm run test:local-agent-lifecycle --prefix \.runtime-sources\/manager/);
assert.equal(
  (workflow.match(/node scripts\/runtime-source-capsule\.mjs verify/g) || []).length,
  2,
);
assert.equal(
  (workflow.match(/node scripts\/runtime-source-capsule\.mjs materialize/g) || []).length,
  2,
);
assert.doesNotMatch(workflow, /repository:\s*\$\{\{\s*steps\.runtime-lock\.outputs\.brain_repository/);
assert.doesNotMatch(workflow, /IDACC_BRAIN_SOURCE/);
assert.match(workflow, /npm ci --prefix \.runtime-sources\/brain --omit=dev/);
assert.match(workflow, /xargs -0 -n 1 node --check/);
assert.match(workflow, /http:\/\/127\.0\.0\.1:4219\/health/);
assert.match(workflow, /node scripts\/validate-runtime-lock\.mjs/);
assert.match(workflow, /npm run test:runtime-source-capsule --prefix idctl-desktop/);
assert.match(workflow, /npm run test:appimage-artifact --prefix idctl-desktop/);
assert.match(workflow, /npm run test:deb-artifact --prefix idctl-desktop/);

for (const [target, os, arch] of [
  ['darwin-arm64', 'macos-15', 'arm64'],
  ['darwin-x64', 'macos-15-intel', 'x64'],
  ['win32-x64', 'windows-2025', 'x64'],
  ['linux-x64', 'ubuntu-24.04', 'x64'],
]) {
  assert.match(workflow, new RegExp(`os:\\s*${os}[\\s\\S]{0,160}target:\\s*${target}`));
  assert.match(workflow, new RegExp(`target:\\s*${target}[\\s\\S]{0,220}arch:\\s*${arch}`));
}
assert.equal(
  (workflow.match(/^\s*target:\s*(?:darwin-arm64|darwin-x64|win32-x64|linux-x64)\s*$/gm) || []).length,
  4,
);
const matrixBlock = workflow.slice(
  workflow.indexOf('matrix:\n'),
  workflow.indexOf('\n    env:\n', workflow.indexOf('matrix:\n')),
);
assert.doesNotMatch(matrixBlock, /latest[^ \n]*\.ya?ml/i);
assert.equal((matrixBlock.match(/updater_globs:/g) || []).length, 4);
assert.equal((matrixBlock.match(/review-mac\.yml/g) || []).length, 2);
assert.match(matrixBlock, /review\.yml/);
assert.match(matrixBlock, /review-linux\.yml/);
assert.equal(
  (matrixBlock.match(/release_smoke_args:/g) || []).length,
  4,
  'every native target must explicitly declare its release-smoke argument policy',
);
assert.equal(
  (matrixBlock.match(/release_smoke_args:\s*--linux-github-actions-suid-sandbox/g) || []).length,
  1,
  'only one native target may request isolated SUID sandbox preparation',
);
assert.match(
  matrixBlock,
  /os:\s*ubuntu-24\.04[\s\S]{0,320}target:\s*linux-x64[\s\S]{0,800}release_smoke_args:\s*--linux-github-actions-suid-sandbox/,
  'only the pinned Ubuntu 24 Linux review target may request isolated SUID sandbox preparation',
);
for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  assert.match(
    matrixBlock,
    new RegExp(`target:\\s*${target}[\\s\\S]{0,800}release_smoke_args:\\s*""`),
    `${target} must use the packaged application's sandbox defaults`,
  );
}
assert.match(workflow, /--config\.mac\.identity=- --config\.mac\.notarize=false --config\.mac\.hardenedRuntime=false --config\.mac\.requirements=build\/review-requirements\.txt --config\.mac\.signIgnore=\/Contents\/Resources\/idacc-runtime\/ --config\.afterSign=scripts\/review-after-sign\.mjs --config\.dmg\.sign=false/);
assert.match(readFileSync(join(root, 'idctl-desktop', 'build', 'review-requirements.txt'), 'utf8'), /designated => true/);
assert.match(readFileSync(join(root, 'idctl-desktop', 'build', 'review-root-requirements.txt'), 'utf8'), /designated => identifier "world\.idchain\.idagents-control"/);
assert.match(readFileSync(join(root, 'idctl-desktop', 'scripts', 'review-after-sign.mjs'), 'utf8'), /--preserve-metadata=entitlements,flags/);
assert.match(workflow, /--config\.win\.signExecutable=false/);
assert.doesNotMatch(workflow, /\bnpx electron-builder\b/);
assert.match(workflow, /node scripts\/run-review-builder\.mjs[\s\S]*\$\{\{\s*matrix\.target_args\s*\}\}[\s\S]*--\$\{\{\s*matrix\.arch\s*\}\}[\s\S]*\$\{\{\s*matrix\.unsigned_builder_args\s*\}\}[\s\S]*--config\.extraMetadata\.version="\$IDACC_REVIEW_VERSION"[\s\S]*--publish never/);
assert.match(workflow, /--config\.publish\.channel=review/);
assert.match(workflow, /if \[ "\$\{\{ matrix\.platform \}\}" = mac \]; then\s+sudo sysctl -w kern\.maxfiles=524288\s+sudo sysctl -w kern\.maxfilesperproc=524288\s+ulimit -n 524288\s+test "\$\(ulimit -n\)" = 524288\s+fi/);
assert.match(workflow, /IDACC_REVIEW_BUILD:\s*"1"/);
assert.match(workflow, /IDACC_REVIEW_VERSION:\s*\$\{\{\s*needs\.prepare\.outputs\.review_version\s*\}\}/);
assert.match(workflow, /REVIEW_VERSION="\$VERSION"/);
assert.match(workflow, /candidate=review-v%s-%s/);
assert.match(workflow, /review_version=%s/);
assert.match(workflow, /--application-version "\$IDACC_REVIEW_VERSION"/);
assert.match(workflow, /node scripts\/review-artifact-bundle\.mjs verify-package/);
assert.match(workflow, /node scripts\/check-release-payload\.mjs/);
assert.match(
  workflow,
  /node scripts\/unified-stack-release-smoke\.mjs\s*\\\s*\n\s*["']?idctl-desktop\/release\/\$\{\{\s*matrix\.unpacked\s*\}\}["']?\s*\\\s*\n\s*\$\{\{\s*matrix\.release_smoke_args\s*\}\}/,
);
assert.equal(
  (workflow.match(/node scripts\/verify-appimage-artifact\.mjs/g) || []).length,
  1,
  'the review workflow must extract and inspect exactly one Linux AppImage',
);
assert.equal(
  (workflow.match(/node scripts\/verify-deb-artifact\.mjs/g) || []).length,
  1,
  'the review workflow must inspect exactly one Linux Debian package',
);
assert.match(
  workflow,
  /- name: Verify the Linux installer sandbox policies\s+if: matrix\.platform == 'linux'\s+shell: bash[\s\S]*?test "\$\{#APPIMAGES\[@\]\}" -eq 1[\s\S]*?node scripts\/verify-appimage-artifact\.mjs\s*\\\s*\n\s*--appimage "\$\{APPIMAGES\[0\]\}"\s*\\\s*\n\s*--expected-build review[\s\S]*?test "\$\{#DEBS\[@\]\}" -eq 1[\s\S]*?node scripts\/verify-deb-artifact\.mjs\s*\\\s*\n\s*--deb "\$\{DEBS\[0\]\}"/,
);
assert.ok(
  workflow.indexOf('node scripts/run-review-builder.mjs')
    < workflow.indexOf('node scripts/verify-appimage-artifact.mjs')
    && workflow.indexOf('node scripts/verify-appimage-artifact.mjs')
      < workflow.indexOf('node scripts/verify-deb-artifact.mjs')
    && workflow.indexOf('node scripts/verify-deb-artifact.mjs')
      < workflow.indexOf('node scripts/review-artifact-bundle.mjs verify-package'),
  'both built Linux installers must be inspected before payload verification or upload',
);
assert.match(workflow, /node scripts\/generate-release-metadata\.mjs/);
assert.match(workflow, /node scripts\/review-artifact-bundle\.mjs record/);
assert.match(workflow, /node scripts\/review-artifact-bundle\.mjs assemble/);
assert.equal(
  (workflow.match(/--application-version/g) || []).length,
  4,
  'review identity must reach the builder, packaged-app verifier, record, and bundle assembler',
);
assert.match(workflow, /sha256sum -c SHA256SUMS/);
assert.match(
  workflow,
  /for PLATFORM_SUMS in provenance\/\*\/SHA256SUMS; do[\s\S]*cd "\$\(dirname "\$PLATFORM_SUMS"\)"[\s\S]*sha256sum -c SHA256SUMS/,
  'assembly must verify each normalized per-platform checksum file from its own directory',
);
assert.match(workflow, /test -x "\$APPIMAGE"/);
assert.match(workflow, /tar -czf "review-delivery\/\$ARCHIVE" -C review-bundle \./);
assert.match(workflow, /sha256sum "\$ARCHIVE" > "\$ARCHIVE\.sha256"/);
assert.match(workflow, /sha256sum -c "\$ARCHIVE\.sha256"/);
assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
assert.equal(
  (workflow.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) || []).length,
  2,
);
assert.match(
  workflow,
  /name:\s*idacc-\$\{\{\s*needs\.prepare\.outputs\.candidate\s*\}\}-attempt-\$\{\{\s*github\.run_attempt\s*\}\}-platform-\$\{\{\s*matrix\.target\s*\}\}-unsigned-review/,
);
assert.match(
  workflow,
  /pattern:\s*idacc-\$\{\{\s*needs\.prepare\.outputs\.candidate\s*\}\}-attempt-\$\{\{\s*github\.run_attempt\s*\}\}-platform-\*-unsigned-review/,
);
assert.match(
  workflow,
  /name:\s*idacc-\$\{\{\s*needs\.prepare\.outputs\.candidate\s*\}\}-attempt-\$\{\{\s*github\.run_attempt\s*\}\}-all-native-unsigned-review/,
);
assert.equal(
  (workflow.match(/\$\{\{\s*github\.run_attempt\s*\}\}/g) || []).length >= 3,
  true,
  'platform downloads and combined uploads must carry their immutable run-attempt identity',
);
assert.doesNotMatch(
  workflow,
  /pattern:\s*idacc-[^\n]*all-native/,
  'the cross-attempt platform download pattern must not match the combined all-native artifact',
);
assert.equal((workflow.match(/--run-attempt "\$GITHUB_RUN_ATTEMPT"/g) || []).length, 2);
assert.match(workflow, /path:\s*review-platform\/\*\*/);
assert.match(workflow, /path:\s*\|[\s\S]*review-delivery\/\*[\s\S]*publish\/\*/);
assert.equal((workflow.match(/retention-days:\s*30/g) || []).length, 2);
assert.match(workflow, /Production updater descriptors are forbidden in review artifacts/);
assert.match(workflow, /did not change the stable GitHub Latest route or the consumer production channel/);
assert.match(workflow, /No private signing or notarization credentials were used/);
assert.match(workflow, /verify-update-descriptors\.mjs[\s\S]*--channel review/);
const reviewAssemblyBlock = workflow.slice(
  workflow.indexOf('assemble-review-bundle:'),
  workflow.indexOf('\n  report-review-status:', workflow.indexOf('assemble-review-bundle:')),
);
assert.ok(
  reviewAssemblyBlock.indexOf('npm ci --prefix idctl-desktop --omit=dev --ignore-scripts')
    < reviewAssemblyBlock.indexOf('node scripts/merge-update-metadata.mjs'),
  'review assembly must install the exact locked metadata parser before merging updater feeds',
);

assert.match(builder, /const reviewBuild = releaseBuild && process\.env\.IDACC_REVIEW_BUILD === '1'/);
assert.match(builder, /__IDACC_REVIEW_BUILD__:\s*JSON\.stringify\(reviewBuild\)/);
assert.match(builder, /idacc-review-updater-enabled:v1/);
assert.match(builder, /idacc-production-updater-enabled:v1/);
assert.match(builder, /reviewOnly:\s*reviewBuild/);
assert.match(builder, /updaterEnabled:\s*releaseBuild/);
assert.match(builder, /updaterChannel:\s*reviewBuild \? 'review' : 'production'/);
assert.match(builder, /sourceVersion:\s*sourcePackageVersion/);
assert.match(builder, /applicationVersion:\s*reviewVersion \|\| sourcePackageVersion/);
assert.match(
  releaseBuildSmoke,
  /buildMode\.updaterEnabled,\s*true/,
);
assert.match(
  releaseBuildSmoke,
  /expectedReviewBuild\s*\?\s*process\.env\.IDACC_REVIEW_VERSION\s*:\s*sourcePackage\.version/,
);
assert.doesNotMatch(reviewBuilder, /requiredArgument\('--config\.publish=null'\)/);
assert.match(reviewBuilder, /review builder must retain only the compiled public IDACC publisher/);
assert.match(reviewBuilder, /--config\.extraMetadata\.version=/);
assert.match(reviewBuilder, /--config\.publish\.channel=review/);
assert.match(reviewBuilder, /--config\.mac\.signIgnore=\/Contents\/Resources\/idacc-runtime\//);
assert.match(reviewBuilder, /process\.env\.IDACC_REVIEW_BUILD !== '1'/);
assert.match(updater, /declare const __IDACC_REVIEW_BUILD__:\s*boolean/);
assert.match(updater, /UPDATE_CHANNEL_POLICY === REVIEW_UPDATE_POLICY/);
assert.match(updater, /autoUpdater\.channel = REVIEW_BUILD \? 'review' : 'latest'/);
for (const [name, source] of [
  ['desktop package configuration', JSON.stringify(pkg)],
  ['desktop application source tree', applicationSourceTree],
  ['application builder', builder],
  ['review builder', reviewBuilder],
  ['production builder', productionBuilder],
  ['application entry point', mainSource],
  ['unified service supervisor', unifiedStackSource],
]) {
  assert.doesNotMatch(
    source,
    /--(?:no-sandbox|disable-setuid-sandbox)|\bdisableSandbox\b|\bsandbox\s*:\s*false/,
    `${name} must not directly disable Electron's sandbox`,
  );
}
assert.match(mainProcessStartupPolicy, /electron\.app\.enableSandbox\(\)/);
assert.match(mainProcessStartupPolicy, /process\.stderr\.write/);
assert.match(mainProcessStartupPolicy, /\.deb package/);
assert.match(mainProcessStartupPolicy, /process\.exit\(\$\{RELEASE_LINUX_SANDBOX_EXIT_CODE\}\)/);
assert.match(builder, /banner:\s*\{\s*js:\s*mainProcessStartupBanner\(mainProcessPolicyMode\)/);
assert.match(releaseBuildSmoke, /mainProcessStartupPolicy/);
assert.match(gitignore, /^!release\/REVIEW-NOTICE\.md$/m);
assert.match(gitignore, /^!release\/runtime-sources\/\*\*$/m);
assert.match(
  gitAttributes,
  /^\/release\/runtime-sources\/\*\* -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab$/m,
  'capsule bytes must never be rewritten by cross-platform checkout EOL conversion',
);
assert.match(notice, /not a consumer release/i);
assert.match(notice, /Self-update is enabled only on the isolated `review` prerelease channel/i);
assert.match(notice, /prerelease does not change the stable GitHub Latest route/i);
assert.match(notice, /signed-tag, code-signing, notarization/);
assert.match(notice, /No private signing or notarization credentials are used/);
assert.match(notice, /No user-supplied or private runtime-source credential is used/i);
assert.match(notice, /github\.token[\s\S]*public IDACC and Manager/i);
assert.match(notice, /pending\/final review status and the isolated prerelease[\s\S]*exact IDACC commit/i);
assert.match(notice, /vendored runtime capsule/i);
assert.match(notice, /publisher\s+assertions/i);
assert.match(notice, /chmod 0755 ID-Agents-Control-Center-\*\.AppImage/);
assert.match(notice, /conditionally request Electron's `--no-sandbox`/);
assert.match(notice, /rejects that request before bundled application modules load/);
assert.match(notice, /will not continue without its sandbox/);
assert.match(notice, /install the Debian package instead/);
assert.match(notice, /Debian package[\s\S]*AppArmor integration/i);
assert.match(notice, /Branch protection[\s\S]*administrative\s+controls/i);
assert.ok(existsSync(helper));
assert.equal(
  win32.join('out', 'build-mode.json'),
  'out\\build-mode.json',
  'Windows ASAR lookups require a native separator',
);
assert.equal(
  win32.join('out', 'main', 'main.cjs'),
  'out\\main\\main.cjs',
  'nested Windows ASAR lookups require native separators',
);
assert.match(
  helperSource,
  /extractFile\(\s*asarPath,\s*join\(\s*'out',\s*'build-mode\.json'\s*\)\s*\)/,
  'the packaged build-mode lookup must use the host-native path form expected by @electron/asar',
);
assert.match(
  helperSource,
  /extractFile\(\s*asarPath,\s*join\(\s*'out',\s*'main',\s*'main\.cjs'\s*\)\s*,?\s*\)/,
  'the packaged main-process lookup must use the host-native path form expected by @electron/asar',
);
assert.doesNotMatch(
  helperSource,
  /extractFile\(\s*asarPath,\s*['"]out[\\/]/,
  'nested ASAR lookups must not regress to platform-specific string literals',
);
assert.match(helperSource, /extractFile\(asarPath, 'package\.json'\)/);
assert.match(helperSource, /packaged\.main !== 'out\/main\/main\.cjs'/);
assert.match(appImageVerifier, /\['--appimage-extract'\]/);
assert.match(appImageVerifier, /join\(rootPath, 'AppRun'\)/);
assert.match(appImageVerifier, /join\(rootPath, config\.executableName\)/);
assert.match(appImageVerifier, /contains an unconditional Electron/);
assert.match(appImageVerifier, /desktop Exec= does not launch AppRun/);
assert.match(appImageVerifier, /extractFile\(asarPath, 'package\.json'\)/);
assert.match(appImageVerifier, /extractFile\(asarPath, 'out\/build-mode\.json'\)/);
assert.match(appImageVerifier, /extractFile\(asarPath, 'out\/main\/main\.cjs'\)/);
assert.match(appImageVerifier, /packaged\?\.main !== PACKAGED_MAIN_ENTRY/);
assert.match(appImageVerifier, /mainProcess\.startsWith\(banner\)/);
assert.match(appImageVerifier, /inspectAppRunContent/);
assert.match(appImageVerifierSmoke, /legacy toolset/);
assert.match(appImageVerifierSmoke, /sandbox-disabling desktop args/);
assert.match(appImageVerifierSmoke, /primary desktop Exec= does not launch AppRun/);
assert.match(appImageVerifierSmoke, /out\/main\/unguarded\.cjs/);
assert.match(debVerifier, /PINNED_AFTER_INSTALL_TEMPLATE_SHA256/);
assert.match(debVerifier, /--fsys-tarfile/);
assert.match(debVerifier, /--ctrl-tarfile/);
assert.match(debVerifier, /postinst does not exactly match the pinned/);
assert.match(debVerifier, /AppArmor profile does not exactly match the pinned/);
assert.match(debVerifierSmoke, /helper symlink/);
assert.match(debVerifierSmoke, /mutated postinst/);
assert.match(debVerifierSmoke, /mutated AppArmor profile/);

const ordinaryPackagedApp = resolve('/tmp/linux-unpacked');
assert.deepEqual(
  unifiedStackReleaseSmokePolicy([ordinaryPackagedApp], {
    platform: 'darwin',
    env: {},
  }),
  {
    packagedApp: ordinaryPackagedApp,
    prepareLinuxGithubActionsSandbox: false,
    runnerTemp: null,
  },
  'ordinary release smokes must retain Electron sandbox defaults',
);
assert.throws(
  () => unifiedStackReleaseSmokePolicy(
    ['/tmp/IDACC.app', LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION],
    {
      platform: 'darwin',
      env: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_OS: 'Linux',
        ImageOS: 'ubuntu24',
      },
    },
  ),
  /Linux-only/,
  'isolated Linux sandbox preparation must fail closed on non-Linux platforms',
);
const githubWorkspace = resolve('/github/work/idacc');
const githubRunnerTemp = resolve('/github/runner-temp');
const hostedLinuxEnv = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  IDACC_GITHUB_RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Linux',
  ImageOS: 'ubuntu24',
  GITHUB_WORKSPACE: githubWorkspace,
  RUNNER_TEMP: githubRunnerTemp,
};
for (const [marker, value] of [
  ['CI', 'false'],
  ['GITHUB_ACTIONS', 'false'],
  ['IDACC_GITHUB_RUNNER_ENVIRONMENT', 'self-hosted'],
  ['RUNNER_OS', 'Windows'],
  ['ImageOS', 'ubuntu22'],
]) {
  const env = { ...hostedLinuxEnv, [marker]: value };
  assert.throws(
    () => unifiedStackReleaseSmokePolicy(
      [
        'idctl-desktop/release/linux-unpacked',
        LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
      ],
      {
        platform: 'linux',
        env,
        cwd: githubWorkspace,
      },
    ),
    /restricted to the pinned GitHub-hosted Ubuntu 24 Actions image/,
    `isolated SUID preparation must fail closed when ${marker} is wrong`,
  );
  delete env[marker];
  assert.throws(
    () => unifiedStackReleaseSmokePolicy(
      [
        'idctl-desktop/release/linux-unpacked',
        LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
      ],
      {
        platform: 'linux',
        env,
        cwd: githubWorkspace,
      },
    ),
    /restricted to the pinned GitHub-hosted Ubuntu 24 Actions image/,
    `isolated SUID preparation must fail closed when ${marker} is missing`,
  );
}
assert.deepEqual(
  unifiedStackReleaseSmokePolicy(
    [
      'idctl-desktop/release/linux-unpacked',
      LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
    ],
    {
      platform: 'linux',
      env: hostedLinuxEnv,
      cwd: githubWorkspace,
    },
  ),
  {
    packagedApp: resolve(
      githubWorkspace,
      'idctl-desktop',
      'release',
      'linux-unpacked',
    ),
    prepareLinuxGithubActionsSandbox: true,
    runnerTemp: githubRunnerTemp,
  },
  'the explicit mode must isolate only the exact Ubuntu 24 GitHub package path',
);
assert.throws(
  () => unifiedStackReleaseSmokePolicy(
    [
      'idctl-desktop/release/linux-unpacked',
      '--no-sandbox',
    ],
    {
      platform: 'linux',
      env: hostedLinuxEnv,
      cwd: githubWorkspace,
    },
  ),
  /unsupported unified-stack release-smoke option/,
  'raw Electron flags must never reach the packaged release smoke',
);
assert.throws(
  () => unifiedStackReleaseSmokePolicy(
    [
      'idctl-desktop/release/linux-unpacked',
      LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
      LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
    ],
    {
      platform: 'linux',
      env: hostedLinuxEnv,
      cwd: githubWorkspace,
    },
  ),
  /unsupported unified-stack release-smoke option/,
  'duplicate or extra smoke options must fail closed',
);
assert.throws(
  () => unifiedStackReleaseSmokePolicy(
    [
      'idctl-desktop/release/other-unpacked',
      LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
    ],
    {
      platform: 'linux',
      env: hostedLinuxEnv,
      cwd: githubWorkspace,
    },
  ),
  /requires the exact GitHub workspace linux-unpacked path/,
);
assert.throws(
  () => unifiedStackReleaseSmokePolicy(
    [
      'idctl-desktop/release/linux-unpacked',
      LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION,
    ],
    {
      platform: 'linux',
      env: {
        ...hostedLinuxEnv,
        RUNNER_TEMP: resolve(githubWorkspace, '_temp'),
      },
      cwd: githubWorkspace,
    },
  ),
  /requires a private absolute RUNNER_TEMP outside GITHUB_WORKSPACE/,
);
assert.match(releaseStackHarness, /\['--non-interactive', '--', command, \.\.\.args\]/);
for (const workflowSource of [ciWorkflow, productionWorkflow, workflow]) {
  assert.match(
    workflowSource,
    /IDACC_GITHUB_RUNNER_ENVIRONMENT:\s*\$\{\{\s*runner\.environment\s*\}\}/,
  );
}
assert.match(releaseStackHarness, /const ISOLATED_PARENT = '\/tmp'/);
assert.match(releaseStackHarness, /const STAT = '\/usr\/bin\/stat'/);
const privilegedDirectorySnapshotHarness = releaseStackHarness.slice(
  releaseStackHarness.indexOf('function privilegedDirectorySnapshot'),
  releaseStackHarness.indexOf('function sameIdentity'),
);
assert.match(
  privilegedDirectorySnapshotHarness,
  /STAT,\s*\n\s*\['--format=%d:%i:%u:%g:%a:%F', '--', path\]/,
);
assert.doesNotMatch(
  privilegedDirectorySnapshotHarness,
  /(?:'-L'|--dereference)/,
  'privileged directory identity checks must use GNU stat without dereferencing symlinks',
);
assert.match(
  releaseStackHarness,
  /realpathSync\(ISOLATED_PARENT\) !== ISOLATED_PARENT/,
);
assert.match(
  releaseStackHarness,
  /parent\.uid !== 0[\s\S]*parent\.gid !== 0[\s\S]*parent\.mode !== 0o1777/,
);
assert.match(
  releaseStackHarness,
  /MKTEMP,\s*\n\s*\['-d', join\(ISOLATED_PARENT, `\$\{ISOLATED_PREFIX\}XXXXXX`\)\]/,
);
assert.match(
  releaseStackHarness,
  /CP,\s*\n\s*\[[\s\S]*?'-R',[\s\S]*?'-P',[\s\S]*?'-T',[\s\S]*?'--',[\s\S]*?sourceRoot,[\s\S]*?packagedApp,[\s\S]*?\]/,
);
const isolatedCopyArguments = releaseStackHarness.slice(
  releaseStackHarness.indexOf('privileged(\n      CP,'),
  releaseStackHarness.indexOf("'isolated packaged application copy'"),
);
assert.doesNotMatch(
  isolatedCopyArguments,
  /(?:'-a'|'-p'|'-d'|--archive|--preserve|--link)/,
  'the isolated copy must retain ordinary executable bits without preserving '
    + 'special modes, ownership, or hard-link relationships',
);
if (process.platform === 'linux') {
  const copyFixture = mkdtempSync(
    join(tmpdir(), 'idacc-linux-copy-semantics-'),
  );
  const previousUmask = process.umask(0o022);
  try {
    const source = join(copyFixture, 'source');
    const destination = join(copyFixture, 'destination');
    mkdirSync(source, { mode: 0o755 });
    mkdirSync(destination, { mode: 0o700 });
    const ordinaryExecutable = join(source, 'ordinary-executable');
    const specialExecutable = join(source, 'special-executable');
    const hardlinkedExecutable = join(source, 'hardlinked-executable');
    const symbolicExecutable = join(source, 'symbolic-executable');
    writeFileSync(ordinaryExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(specialExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(ordinaryExecutable, 0o755);
    chmodSync(specialExecutable, 0o4755);
    assert.equal(lstatSync(specialExecutable).mode & 0o7777, 0o4755);
    linkSync(ordinaryExecutable, hardlinkedExecutable);
    symlinkSync('ordinary-executable', symbolicExecutable);
    const destinationBefore = lstatSync(destination);

    const copied = spawnSync(
      '/usr/bin/cp',
      ['-R', '-P', '-T', '--', source, destination],
      {
        encoding: 'utf8',
        env: {
          LANG: 'C',
          LC_ALL: 'C',
          PATH: '/usr/bin:/bin',
        },
      },
    );
    assert.equal(
      copied.status,
      0,
      `GNU copy semantics fixture failed:\n${copied.stdout || ''}\n${copied.stderr || ''}`,
    );
    const destinationAfter = lstatSync(destination);
    assert.equal(destinationAfter.dev, destinationBefore.dev);
    assert.equal(destinationAfter.ino, destinationBefore.ino);
    assert.equal(destinationAfter.mode & 0o7777, 0o700);
    const copiedOrdinary = lstatSync(join(destination, 'ordinary-executable'));
    const copiedSpecial = lstatSync(join(destination, 'special-executable'));
    const copiedHardlink = lstatSync(join(destination, 'hardlinked-executable'));
    const copiedSymlink = lstatSync(join(destination, 'symbolic-executable'));
    assert.equal(copiedOrdinary.mode & 0o7777, 0o755);
    assert.equal(copiedSpecial.mode & 0o7777, 0o755);
    assert.equal(copiedOrdinary.nlink, 1);
    assert.equal(copiedHardlink.nlink, 1);
    assert.notEqual(copiedOrdinary.ino, copiedHardlink.ino);
    assert.equal(copiedSymlink.isSymbolicLink(), true);
    assert.equal(
      readlinkSync(join(destination, 'symbolic-executable')),
      'ordinary-executable',
    );
  } finally {
    process.umask(previousUmask);
    rmSync(copyFixture, { recursive: true, force: true });
  }
}
const isolatedPreparationHarness = releaseStackHarness.slice(
  releaseStackHarness.indexOf('function prepareIsolatedLinuxCopy'),
  releaseStackHarness.indexOf('function executable'),
);
const isolatedApplicationDirectoryCreation = isolatedPreparationHarness.indexOf(
  "'isolated application directory creation'",
);
const emptyApplicationInspection = isolatedPreparationHarness.indexOf(
  "'empty isolated application directory'",
);
const isolatedApplicationCopy = isolatedPreparationHarness.indexOf(
  "'isolated packaged application copy'",
);
const privateCopiedApplicationInspection = isolatedPreparationHarness.indexOf(
  "'private copied application directory'",
);
const applicationInspectionMode = isolatedPreparationHarness.indexOf(
  "'isolated application directory inspection mode'",
);
const rootInspectionMode = isolatedPreparationHarness.indexOf(
  "'isolated staging root inspection mode'",
);
const copiedHelperInspection = isolatedPreparationHarness.indexOf(
  "'isolated packaged chrome-sandbox'",
);
const copiedHelperBaselineMode = isolatedPreparationHarness.indexOf(
  "'isolated chrome-sandbox copied baseline mode'",
);
const copiedHelperSuidMode = isolatedPreparationHarness.indexOf(
  "'isolated chrome-sandbox mode'",
);
assert.ok(
  isolatedApplicationDirectoryCreation >= 0
  && emptyApplicationInspection > isolatedApplicationDirectoryCreation
  && isolatedApplicationCopy > emptyApplicationInspection
  && privateCopiedApplicationInspection > isolatedApplicationCopy
  && applicationInspectionMode > privateCopiedApplicationInspection
  && rootInspectionMode > applicationInspectionMode
  && copiedHelperInspection > rootInspectionMode
  && copiedHelperBaselineMode > copiedHelperInspection
  && copiedHelperSuidMode > copiedHelperBaselineMode,
  'the root-owned application must become non-writable before traversal is exposed, '
    + 'and helper identity/baseline must be checked before SUID is enabled',
);
assert.match(
  isolatedPreparationHarness,
  /MKDIR,\s*\n\s*\['--mode=0700', '--', packagedApp\]/,
);
assert.match(
  isolatedPreparationHarness,
  /sameIdentity\(privateCopiedApp, emptyApp\)[\s\S]*privateCopiedApp\.uid !== 0[\s\S]*privateCopiedApp\.gid !== 0[\s\S]*privateCopiedApp\.mode !== 0o700/,
);
assert.match(
  isolatedPreparationHarness,
  /rootAfterCopy\.uid !== 0[\s\S]*rootAfterCopy\.gid !== 0[\s\S]*rootAfterCopy\.mode !== 0o755/,
);
assert.match(
  isolatedPreparationHarness,
  /appBeforeMode\.uid !== 0[\s\S]*appBeforeMode\.gid !== 0[\s\S]*appBeforeMode\.mode !== 0o755/,
);
assert.match(
  releaseStackHarness,
  /privileged\(CHMOD, \['--', '4755', copiedSandbox\]/,
);
assert.match(
  releaseStackHarness,
  /copy\.preparedSnapshots \|\| copy\.stagedSnapshots/,
);
assert.match(releaseStackHarness, /sameIdentity\(app, cleanupSnapshots\.app\)/);
assert.match(releaseStackHarness, /sameIdentity\(helper, cleanupSnapshots\.helper\)/);
assert.match(
  releaseStackHarness,
  /copy\.stagedSnapshots = \{[\s\S]*helper: copiedSandboxIdentity[\s\S]*isolated chrome-sandbox copied baseline mode/,
);
const isolatedCleanupHarness = releaseStackHarness.slice(
  releaseStackHarness.indexOf('function removeIsolatedLinuxCopy'),
  releaseStackHarness.indexOf('function prepareIsolatedLinuxCopy'),
);
assert.match(
  isolatedCleanupHarness,
  /sameIdentity\(helper, cleanupSnapshots\.helper\)[\s\S]*CHMOD,\s*\n\s*\['--', '0755', copiedSandbox\]/,
);
assert.match(
  isolatedCleanupHarness,
  /sameIdentity\(helper, cleanupSnapshots\.helper\)[\s\S]*helper\.mode !== 0o755/,
);
assert.match(
  isolatedCleanupHarness,
  /privileged\(\s*RM,\s*\['-rf', '--', copy\.temporaryRoot\]/,
);
assert.match(
  isolatedCleanupHarness,
  /if \(stableForRemoval\)[\s\S]*privileged\(\s*RM/,
  'deletion must still be attempted after a verified hierarchy even if clearing SUID fails',
);
assert.doesNotMatch(releaseStackHarness, /\bCHOWN\b|chownSync|cpSync/);
assert.match(releaseStackHarness, /source packaged chrome-sandbox was mutated/);
assert.match(releaseStackHarness, /refusing ambiguous Linux sandbox smoke cleanup path/);
assert.doesNotMatch(releaseStackHarness, /--no-sandbox|--disable-setuid-sandbox/);

const scratch = mkdtempSync(join(tmpdir(), 'idacc-review-workflow-'));
const applicationVersion = pkg.version;
const candidate = `review-v${applicationVersion}-aaaaaaaaaaaa`;
const commit = 'a'.repeat(40);
const sourceEpoch = '1767225600';
const repository = 'bobofbuilding/idacc';
const targets = [
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', files: ['IDACC-arm64.dmg', 'IDACC-arm64.zip'], updater: ['review-mac.yml', 'IDACC-arm64.zip.blockmap'] },
  { id: 'darwin-x64', platform: 'darwin', arch: 'x64', files: ['IDACC-x64.dmg', 'IDACC-x64.zip'], updater: ['review-mac.yml', 'IDACC-x64.zip.blockmap'] },
  { id: 'win32-x64', platform: 'win32', arch: 'x64', files: ['IDACC-x64.exe'], updater: ['review.yml', 'IDACC-x64.exe.blockmap'] },
  { id: 'linux-x64', platform: 'linux', arch: 'x64', files: ['IDACC-x64.AppImage', 'IDACC-x64.deb'], updater: ['review-linux.yml'] },
];

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function checksumText(entries) {
  return `${entries
    .map(([name, digest]) => `${digest}  ${name}`)
    .sort()
    .join('\n')}\n`;
}

function replaceChecksum(path, name, digest) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const next = lines.map((line) => (
    line.endsWith(`  ${name}`) ? `${digest}  ${name}` : line
  ));
  assert.equal(
    next.some((line, index) => line !== lines[index]),
    true,
    `fixture checksum ${name} was not found`,
  );
  write(path, `${next.join('\n')}\n`);
}

function runHelper(args, expectSuccess = true) {
  const result = spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (expectSuccess) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } else {
    assert.notEqual(result.status, 0);
  }
  return result;
}

function assertBuildMode(mode, expectedReviewBuild) {
  assert.equal(mode.mode, 'production');
  assert.equal(mode.reviewOnly, expectedReviewBuild);
  assert.equal(mode.updaterEnabled, true);
  assert.equal(mode.updaterChannel, expectedReviewBuild ? 'review' : 'production');
  assert.equal(mode.sourceVersion, pkg.version);
  assert.equal(
    mode.applicationVersion,
    expectedReviewBuild ? applicationVersion : pkg.version,
  );
}

assertBuildMode({
  mode: 'production',
  reviewOnly: false,
  updaterEnabled: true,
  updaterChannel: 'production',
  sourceVersion: pkg.version,
  applicationVersion: pkg.version,
}, false);
assertBuildMode({
  mode: 'production',
  reviewOnly: true,
  updaterEnabled: true,
  updaterChannel: 'review',
  sourceVersion: pkg.version,
  applicationVersion,
}, true);

const builderPolicy = spawnSync(process.execPath, [
  reviewBuilderPath,
  '--platform', 'linux',
  '--application-version', applicationVersion,
  '--policy-only',
  '--',
  '--linux', 'AppImage', 'deb',
  '--x64',
  '--config.publish.provider=github',
  '--config.publish.owner=bobofbuilding',
  '--config.publish.repo=idacc',
  '--config.publish.releaseType=release',
  '--config.publish.channel=review',
  `--config.extraMetadata.version=${applicationVersion}`,
  '--publish', 'never',
], {
  cwd: join(root, 'idctl-desktop'),
  encoding: 'utf8',
  env: {
    ...process.env,
    IDACC_REVIEW_BUILD: '1',
    IDACC_REVIEW_VERSION: applicationVersion,
  },
});
assert.equal(builderPolicy.status, 0, `${builderPolicy.stdout}\n${builderPolicy.stderr}`);
assert.match(builderPolicy.stdout, /review builder policy: ok/);

const duplicatePublishPolicy = spawnSync(process.execPath, [
  reviewBuilderPath,
  '--platform', 'linux',
  '--application-version', applicationVersion,
  '--policy-only',
  '--',
  '--linux', 'AppImage', 'deb',
  '--x64',
  '--config.publish.provider=github',
  '--config.publish.owner=bobofbuilding',
  '--config.publish.repo=idacc',
  '--config.publish.releaseType=release',
  '--config.publish.channel=review',
  `--config.extraMetadata.version=${applicationVersion}`,
  '--publish', 'never',
  '--publish', 'always',
], {
  cwd: join(root, 'idctl-desktop'),
  encoding: 'utf8',
  env: {
    ...process.env,
    IDACC_REVIEW_BUILD: '1',
    IDACC_REVIEW_VERSION: applicationVersion,
  },
});
assert.notEqual(duplicatePublishPolicy.status, 0);
assert.match(
  `${duplicatePublishPolicy.stdout}\n${duplicatePublishPolicy.stderr}`,
  /exactly one --publish policy/i,
);

const mismatchedPlatformPolicy = spawnSync(process.execPath, [
  reviewBuilderPath,
  '--platform', 'linux',
  '--application-version', applicationVersion,
  '--policy-only',
  '--',
  '--win', 'nsis',
  '--x64',
  '--config.publish.provider=github',
  '--config.publish.owner=bobofbuilding',
  '--config.publish.repo=idacc',
  '--config.publish.releaseType=release',
  '--config.publish.channel=review',
  `--config.extraMetadata.version=${applicationVersion}`,
  '--publish', 'never',
], {
  cwd: join(root, 'idctl-desktop'),
  encoding: 'utf8',
  env: {
    ...process.env,
    IDACC_REVIEW_BUILD: '1',
    IDACC_REVIEW_VERSION: applicationVersion,
  },
});
assert.notEqual(mismatchedPlatformPolicy.status, 0);
assert.match(
  `${mismatchedPlatformPolicy.stdout}\n${mismatchedPlatformPolicy.stderr}`,
  /exactly one --linux platform flag/i,
);

try {
  const buildMode = join(scratch, 'build-mode.json');
  write(buildMode, `${JSON.stringify({
    mode: 'production',
    reviewOnly: true,
    updaterEnabled: true,
    updaterChannel: 'review',
    mainProcessStartupPolicy: {
      mode: 'review',
      marker: mainProcessStartupPolicyMarker('review'),
      rejectsLinuxSandboxDisableSwitches: true,
    },
    sourceVersion: pkg.version,
    applicationVersion,
  })}\n`);
  const input = join(scratch, 'input');
  const runtimeLock = JSON.parse(
    readFileSync(join(root, 'release', 'runtime-lock.json'), 'utf8'),
  );
  const capsuleSource = runtimeLock.components.brain.distributionSource;
  const capsuleManifestSource = resolve(root, capsuleSource.manifest);
  for (const target of targets) {
    const platformRoot = join(input, `artifact-${target.id}`, 'review-platform');
    const installers = join(platformRoot, 'installers');
    const updater = join(platformRoot, 'updater');
    for (const name of target.files) {
      const path = join(installers, name);
      write(path, `${target.id}:${name}\n`);
      if (name.endsWith('.AppImage')) chmodSync(path, 0o755);
    }
    for (const name of target.updater) {
      write(join(updater, name), `${target.id}:${name}\n`);
    }
    const recordPath = join(platformRoot, 'platform-records', `${target.id}.json`);
    runHelper([
      'record',
      '--root', root,
      '--output', recordPath,
      '--installers', installers,
      '--updater', updater,
      '--build-mode', buildMode,
      '--platform', target.platform,
      '--arch', target.arch,
      '--candidate', candidate,
      '--commit', commit,
      '--repository', repository,
      '--run-url', 'https://github.com/bobofbuilding/idacc/actions/runs/1',
      '--run-attempt', '1',
      '--source-date-epoch', sourceEpoch,
      '--application-version', applicationVersion,
    ]);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const provenance = join(platformRoot, 'provenance', target.id);
    const application = {
      name: pkg.name,
      version: pkg.version,
      repository: 'https://github.com/bobofbuilding/idacc.git',
      commit,
      tree: 'b'.repeat(40),
      dirty: false,
    };
    const build = {
      platform: target.platform,
      arch: target.arch,
      node: '22.17.0',
      npm: '10.9.2',
      electron: pkg.devDependencies.electron,
    };
    const trees = {
      manager: 'c'.repeat(64),
      brain: 'd'.repeat(64),
      runtime: 'e'.repeat(64),
    };
    const runtimeManifest = {
      schemaVersion: 2,
      generatedAt: record.generatedAt,
      sourceDateEpoch: Number(sourceEpoch),
      application,
      build,
      components: runtimeLock.components,
      trees,
      files: [{
        path: 'manager/dist/start-agent-manager.js',
        type: 'file',
        size: 1,
        sha256: 'f'.repeat(64),
      }],
    };
    const sbom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: {
        component: {
          type: 'application',
          name: pkg.name,
          version: pkg.version,
          properties: [
            { name: 'idacc:commit', value: commit },
            { name: 'idacc:runtime-tree-sha256', value: trees.runtime },
            { name: 'idacc:manager-commit', value: runtimeLock.components.manager.commit },
            { name: 'idacc:brain-commit', value: runtimeLock.components.brain.commit },
            { name: 'idacc:brain-distribution-mode', value: capsuleSource.mode },
            {
              name: 'idacc:brain-capsule-manifest-sha256',
              value: capsuleSource.manifestSha256,
            },
            {
              name: 'idacc:brain-capsule-tree-sha256',
              value: capsuleSource.treeSha256,
            },
          ],
        },
      },
      components: [{
        type: 'application',
        name: 'brain',
        version: runtimeLock.components.brain.version,
        properties: [
          { name: 'idacc:component-source', value: 'brain' },
          { name: 'idacc:commit', value: runtimeLock.components.brain.commit },
          { name: 'idacc:distribution-mode', value: capsuleSource.mode },
          { name: 'idacc:capsule-manifest-sha256', value: capsuleSource.manifestSha256 },
          { name: 'idacc:capsule-tree-sha256', value: capsuleSource.treeSha256 },
        ],
      }],
    };
    writeJson(join(provenance, 'runtime-lock.json'), runtimeLock);
    writeJson(join(provenance, 'runtime-manifest.json'), runtimeManifest);
    writeJson(join(provenance, 'SBOM.cdx.json'), sbom);
    write(join(provenance, 'THIRD_PARTY_NOTICES.md'), '# Third-Party Notices\n');
    cpSync(capsuleManifestSource, join(provenance, 'brain-runtime-capsule.json'));
    const releaseManifest = {
      schemaVersion: 1,
      generatedAt: record.generatedAt,
      application,
      build,
      components: runtimeLock.components,
      trees,
      metadata: {
        runtimeLock: {
          name: 'runtime-lock.json',
          sha256: sha256File(join(provenance, 'runtime-lock.json')),
        },
        runtimeManifest: {
          name: 'runtime-manifest.json',
          sha256: sha256File(join(provenance, 'runtime-manifest.json')),
        },
        sbom: {
          name: 'SBOM.cdx.json',
          sha256: sha256File(join(provenance, 'SBOM.cdx.json')),
        },
        thirdPartyNotices: {
          name: 'THIRD_PARTY_NOTICES.md',
          sha256: sha256File(join(provenance, 'THIRD_PARTY_NOTICES.md')),
        },
        brainRuntimeCapsule: {
          name: 'brain-runtime-capsule.json',
          sha256: sha256File(join(provenance, 'brain-runtime-capsule.json')),
        },
      },
      artifacts: record.artifacts.map((artifact) => ({
        name: artifact.name,
        size: artifact.byteLength,
        sha256: artifact.sha256,
      })),
    };
    writeJson(join(provenance, 'release-manifest.json'), releaseManifest);
    const checksumEntries = [
      ...record.artifacts.map((artifact) => [artifact.name, artifact.sha256]),
      ...[
        'runtime-lock.json',
        'runtime-manifest.json',
        'SBOM.cdx.json',
        'THIRD_PARTY_NOTICES.md',
        'brain-runtime-capsule.json',
        'release-manifest.json',
      ].map((name) => [name, sha256File(join(provenance, name))]),
    ];
    write(join(provenance, 'SHA256SUMS'), checksumText(checksumEntries));
  }

  const badInstallers = join(scratch, 'bad-installers');
  const badUpdater = join(scratch, 'bad-updater');
  write(join(badInstallers, 'IDACC-x64.exe'), 'installer\n');
  write(join(badInstallers, 'latest.yml'), 'forbidden\n');
  write(join(badUpdater, 'review.yml'), 'review\n');
  const rejected = runHelper([
    'record',
    '--root', root,
    '--output', join(scratch, 'bad-record.json'),
    '--installers', badInstallers,
    '--updater', badUpdater,
    '--build-mode', buildMode,
    '--platform', 'win32',
    '--arch', 'x64',
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--run-url', 'https://github.com/bobofbuilding/idacc/actions/runs/1',
    '--run-attempt', '1',
    '--source-date-epoch', sourceEpoch,
    '--application-version', applicationVersion,
  ], false);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /updater sidecar/i);

  const output = join(scratch, 'bundle');
  runHelper([
    'assemble',
    '--input', input,
    '--output', output,
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ]);
  assert.ok(existsSync(join(output, 'REVIEW-NOTICE.md')));
  assert.ok(existsSync(join(output, 'REVIEW-BUNDLE.json')));
  assert.ok(existsSync(join(output, 'SHA256SUMS')));
  assert.equal(readdirSync(join(output, 'platform-records')).length, 4);
  assert.equal(readdirSync(join(output, 'installers')).length, 7);
  assert.match(
    readFileSync(join(output, 'SHA256SUMS'), 'utf8'),
    /review[^ \n]*\.ya?ml|\.blockmap/i,
  );
  const bundle = JSON.parse(readFileSync(join(output, 'REVIEW-BUNDLE.json'), 'utf8'));
  assert.equal(bundle.reviewOnly, true);
  assert.equal(bundle.productionReady, false);
  assert.equal(bundle.updater.enabled, true);
  assert.equal(bundle.updater.channel, 'review');
  assert.equal(bundle.updater.descriptorsIncluded, true);
  assert.equal(bundle.applicationVersion, applicationVersion);
  assert.equal(bundle.credentials.signingNotarizationRelease, 'not-used');
  assert.match(bundle.credentials.runtimeSourceCheckout, /no private runtime-source credential was used/i);
  assert.match(bundle.credentials.runtimeSourceCheckout, /vendored runtime capsule/i);
  assert.deepEqual(bundle.targets, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  const assembledAppImage = join(output, 'installers', 'IDACC-x64.AppImage');
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(assembledAppImage).mode & 0o777, 0o755);
  }
  assert.equal(
    bundle.artifacts.find(({ name }) => name === 'IDACC-x64.AppImage')?.mode,
    '0755',
  );
  for (const target of targets) {
    const provenance = join(output, 'provenance', target.id);
    const normalizedChecksums = readFileSync(
      join(provenance, 'SHA256SUMS'),
      'utf8',
    ).trimEnd().split('\n');
    assert.equal(
      normalizedChecksums.length,
      target.files.length + 6,
      `${target.id} normalized checksums must cover its installers and metadata`,
    );
    for (const line of normalizedChecksums) {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      assert.ok(match, `${target.id} normalized checksum is malformed`);
      const checksumPath = match[2];
      if (target.files.includes(checksumPath.replace('../../installers/', ''))) {
        assert.match(checksumPath, /^\.\.\/\.\.\/installers\/[^/]+$/);
      } else {
        assert.equal(checksumPath, checksumPath.split('/').at(-1));
      }
      assert.equal(
        sha256File(resolve(provenance, checksumPath)),
        match[1],
        `${target.id} normalized checksum must be usable from its provenance directory`,
      );
    }
  }

  const windowsPlatformRoot = join(input, 'artifact-win32-x64', 'review-platform');
  const retryWindowsRoot = join(
    input,
    'artifact-win32-x64-attempt-2',
    'review-platform',
  );
  cpSync(windowsPlatformRoot, retryWindowsRoot, { recursive: true });
  const retryWindowsRecordPath = join(
    retryWindowsRoot,
    'platform-records',
    'win32-x64.json',
  );
  const retryWindowsRecord = JSON.parse(readFileSync(retryWindowsRecordPath, 'utf8'));
  retryWindowsRecord.runAttempt = 2;
  writeJson(retryWindowsRecordPath, retryWindowsRecord);
  const mixedAttemptOutput = join(scratch, 'mixed-attempt-bundle');
  runHelper([
    'assemble',
    '--input', input,
    '--output', mixedAttemptOutput,
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '2',
  ]);
  const mixedBundle = JSON.parse(
    readFileSync(join(mixedAttemptOutput, 'REVIEW-BUNDLE.json'), 'utf8'),
  );
  assert.equal(mixedBundle.runAttempt, 2);
  assert.deepEqual(mixedBundle.targetRunAttempts, {
    'darwin-arm64': 1,
    'darwin-x64': 1,
    'linux-x64': 1,
    'win32-x64': 2,
  });
  assert.equal(
    JSON.parse(
      readFileSync(
        join(mixedAttemptOutput, 'platform-records', 'win32-x64.json'),
        'utf8',
      ),
    ).runAttempt,
    2,
    'mixed-attempt assembly must select the newest valid record for each target',
  );
  rmSync(join(input, 'artifact-win32-x64-attempt-2'), {
    recursive: true,
    force: true,
  });

  const windowsProvenance = join(windowsPlatformRoot, 'provenance', 'win32-x64');
  const windowsChecksumsPath = join(windowsProvenance, 'SHA256SUMS');
  const originalWindowsChecksums = readFileSync(windowsChecksumsPath, 'utf8');
  replaceChecksum(windowsChecksumsPath, 'IDACC-x64.exe', '0'.repeat(64));
  const checksumMismatch = runHelper([
    'assemble',
    '--input', input,
    '--output', join(scratch, 'checksum-mismatch-bundle'),
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ], false);
  assert.match(
    `${checksumMismatch.stdout}\n${checksumMismatch.stderr}`,
    /installer bytes, record, and provenance checksum do not match/i,
  );
  write(windowsChecksumsPath, originalWindowsChecksums);

  const firstChecksumLine = originalWindowsChecksums.trimEnd().split('\n')[0];
  write(
    windowsChecksumsPath,
    `${originalWindowsChecksums}${firstChecksumLine}\n`,
  );
  const duplicateChecksum = runHelper([
    'assemble',
    '--input', input,
    '--output', join(scratch, 'duplicate-checksum-bundle'),
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ], false);
  assert.match(
    `${duplicateChecksum.stdout}\n${duplicateChecksum.stderr}`,
    /duplicate checksum path/i,
  );
  write(windowsChecksumsPath, originalWindowsChecksums);

  const [firstDigest] = firstChecksumLine.split('  ');
  const unsafeChecksumLines = originalWindowsChecksums.trimEnd().split('\n');
  unsafeChecksumLines[0] = `${firstDigest}  ../outside-review-bundle`;
  write(windowsChecksumsPath, `${unsafeChecksumLines.join('\n')}\n`);
  const unsafeChecksum = runHelper([
    'assemble',
    '--input', input,
    '--output', join(scratch, 'unsafe-checksum-bundle'),
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ], false);
  assert.match(
    `${unsafeChecksum.stdout}\n${unsafeChecksum.stderr}`,
    /unsafe checksum path/i,
  );
  write(windowsChecksumsPath, originalWindowsChecksums);

  const runtimeLockPath = join(windowsProvenance, 'runtime-lock.json');
  const originalRuntimeLock = readFileSync(runtimeLockPath, 'utf8');
  const hostileRuntimeLock = JSON.parse(originalRuntimeLock);
  hostileRuntimeLock.components.manager.commit = '1'.repeat(40);
  writeJson(runtimeLockPath, hostileRuntimeLock);
  replaceChecksum(windowsChecksumsPath, 'runtime-lock.json', sha256File(runtimeLockPath));
  const mismatchedRuntimeLock = runHelper([
    'assemble',
    '--input', input,
    '--output', join(scratch, 'runtime-lock-mismatch-bundle'),
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ], false);
  assert.match(
    `${mismatchedRuntimeLock.stdout}\n${mismatchedRuntimeLock.stderr}`,
    /runtime lock components do not match/i,
  );
  write(runtimeLockPath, originalRuntimeLock);
  write(windowsChecksumsPath, originalWindowsChecksums);

  const releaseManifestPath = join(windowsProvenance, 'release-manifest.json');
  const originalReleaseManifest = readFileSync(releaseManifestPath, 'utf8');
  const hostileReleaseManifest = JSON.parse(originalReleaseManifest);
  hostileReleaseManifest.artifacts[0].sha256 = '1'.repeat(64);
  writeJson(releaseManifestPath, hostileReleaseManifest);
  replaceChecksum(
    windowsChecksumsPath,
    'release-manifest.json',
    sha256File(releaseManifestPath),
  );
  const mismatchedReleaseManifest = runHelper([
    'assemble',
    '--input', input,
    '--output', join(scratch, 'release-manifest-mismatch-bundle'),
    '--notice', join(root, 'release', 'REVIEW-NOTICE.md'),
    '--candidate', candidate,
    '--commit', commit,
    '--repository', repository,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
    '--run-attempt', '1',
  ], false);
  assert.match(
    `${mismatchedReleaseManifest.stdout}\n${mismatchedReleaseManifest.stderr}`,
    /release manifest artifact does not match/i,
  );
  write(releaseManifestPath, originalReleaseManifest);
  write(windowsChecksumsPath, originalWindowsChecksums);

  const packageSource = join(scratch, 'package-source');
  write(
    join(packageSource, 'package.json'),
    `${JSON.stringify({
      name: pkg.name,
      version: applicationVersion,
      main: 'out/main/main.cjs',
    })}\n`,
  );
  write(
    join(packageSource, 'out', 'build-mode.json'),
    `${JSON.stringify({
      mode: 'production',
      reviewOnly: true,
      updaterEnabled: true,
      updaterChannel: 'review',
      mainProcessStartupPolicy: {
        mode: 'review',
        marker: mainProcessStartupPolicyMarker('review'),
        rejectsLinuxSandboxDisableSwitches: true,
      },
      sourceVersion: pkg.version,
      applicationVersion,
    })}\n`,
  );
  write(
    join(packageSource, 'out', 'main', 'main.cjs'),
    `${mainProcessStartupBanner('review')}const compiledUpdatePolicy = "idacc-review-updater-enabled:v1";\n`,
  );
  const unpacked = join(scratch, 'fake-unpacked');
  const resources = join(unpacked, 'resources');
  mkdirSync(resources, { recursive: true });
  write(join(resources, 'app-update.yml'), 'provider: github\nowner: bobofbuilding\nrepo: idacc\n');
  const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
  const { createPackage } = requireFromDesktop('@electron/asar');
  await createPackage(packageSource, join(resources, 'app.asar'));
  runHelper([
    'verify-package',
    '--root', root,
    '--unpacked', unpacked,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
  ]);
  write(join(resources, 'app-update.yml'), 'provider: github\nowner: attacker\nrepo: idacc\n');
  const updateConfigRejected = runHelper([
    'verify-package',
    '--root', root,
    '--unpacked', unpacked,
    '--source-version', pkg.version,
    '--application-version', applicationVersion,
  ], false);
  assert.match(
    `${updateConfigRejected.stdout}\n${updateConfigRejected.stderr}`,
    /not pinned to public IDACC/i,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('unsigned native review workflow smoke: ok\n');
