#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseScript = readFileSync(join(root, 'scripts', 'release.sh'), 'utf8');
const resumeScript = readFileSync(join(root, 'scripts', 'resume-release.sh'), 'utf8');
const releaseHelpers = readFileSync(join(root, 'scripts', 'lib', 'release-command.sh'), 'utf8');
const releasePublication = readFileSync(join(root, 'scripts', 'lib', 'release-publication.mjs'), 'utf8');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
const provenance = readFileSync(join(root, 'docs', 'RELEASE_PROVENANCE.md'), 'utf8');
const cutoverDocumentation = readFileSync(join(root, 'docs', 'RELEASE_CUTOVER.md'), 'utf8');
const productSpec = readFileSync(join(root, 'docs', 'PRODUCT_SPEC.md'), 'utf8');
const cutoverMarker = JSON.parse(readFileSync(join(root, 'release', 'legacy-release-cutover.json'), 'utf8'));
const idctlPackage = JSON.parse(readFileSync(join(root, 'idctl', 'package.json'), 'utf8'));
const retiredDirectPublisher = new RegExp([
  ['release', 'publish\\.py'].join('-'),
  ['IDACC', 'RELEASE', 'PUBLISHER'].join('_'),
  `\\.${['iacc', 'publish'].join('-')}`,
].join('|'));

for (const [name, source] of [
  ['release.sh', releaseScript],
  ['resume-release.sh', resumeScript],
  ['CONTRIBUTING.md', contributing],
  ['RELEASE_PROVENANCE.md', provenance],
  ['RELEASE_CUTOVER.md', cutoverDocumentation],
  ['PRODUCT_SPEC.md', productSpec],
]) {
  assert.doesNotMatch(source, retiredDirectPublisher);
  if (name.endsWith('.sh')) {
    assert.doesNotMatch(source, /\bpython3?\b|\bditto\b|electron-builder/, `${name} must not publish a local macOS build`);
  }
}

assert.match(releaseHelpers, /gh auth status --hostname github\.com/);
assert.match(releaseHelpers, /git verify-tag "\$tag"/);
assert.match(releaseHelpers, /--json isDraft,isPrerelease/);
assert.match(releaseHelpers, /\.isPrerelease == true then "prerelease"/);
assert.match(releaseScript, /git tag -s -a "\$TAG"/);
assert.match(releaseScript, /git push --atomic origin/);
assert.match(releaseScript, /release_wait_for_github_verified_tag/);
assert.match(releaseScript, /check-release-publication\.mjs" --json/);
assert.match(releaseScript, /node "\$TUI\/build\/gen-version\.mjs"/);
assert.match(releaseScript, /incrementSemverPatch/);
assert.doesNotMatch(
  releaseScript,
  /\.map\(Number\)|Number\(c\)\s*\+\s*1/,
  'release version comparison and patch increment must be BigInt-safe',
);
assert.match(releasePublication, /\.map\(BigInt\)/);
assert.doesNotMatch(
  releasePublication,
  /\.map\(Number\)|numeric:\s*true/,
  'shared release tag ordering must be BigInt-safe',
);
assert.equal(
  idctlPackage.scripts?.['prebuild:mjs'],
  'node build/gen-version.mjs',
  'direct idctl bundles must regenerate their manifest-derived version',
);
assert.match(releaseScript, /isSemverTagGreater/);
assert.match(releaseScript, /"v\$VER" "\$CHANGELOG_BASELINE"/);
assert.match(releaseScript, /greater than current public release \$CHANGELOG_BASELINE/);
assert.match(releaseScript, /RANGE="\$\{CHANGELOG_BASELINE\}\.\.HEAD"/);
assert.match(releaseScript, /CHANGELOG_LINES=\("\$PRIMARY_NOTE"\)/);
assert.match(releaseScript, /append_changelog_line "\$note"/);
assert.doesNotMatch(releaseScript, /git describe/, 'changelog history must start at the published release, not an unpublished local tag');
assert.match(releaseHelpers, /release_active_workflow_record/);
assert.match(releaseHelpers, /release_successful_workflow_record/);
assert.match(releaseHelpers, /release_wait_for_dispatched_workflow_record/);
assert.match(releaseHelpers, /release_wait_for_workflow_run/);
assert.match(releaseHelpers, /run\.head_sha === process\.env\.IDACC_EXPECTED_COMMIT/);
assert.match(releaseHelpers, /run\.head_branch === process\.env\.IDACC_EXPECTED_TAG/);
assert.match(releaseHelpers, /run\.event === "workflow_dispatch"/);
assert.match(releaseHelpers, /multiple matching \$kind Production release runs/);
assert.match(resumeScript, /release_active_workflow_record/);
assert.match(resumeScript, /release_successful_workflow_record/);
assert.match(resumeScript, /DISPATCH_ARGS=\([\s\S]*workflow run release\.yml/);
assert.match(resumeScript, /--field "version=\$VER"/);
assert.match(resumeScript, /--field "publish=\$PUBLISH"/);
assert.match(resumeScript, /SIGNING_MODE="signed"/);
assert.match(resumeScript, /--signing-mode=unsigned/);
assert.match(resumeScript, /--field "signing_mode=\$SIGNING_MODE"/);
assert.match(resumeScript, /unsigned_acknowledgement=publish-v\$VER-unsigned/);
assert.match(resumeScript, /--field "request_id=\$REQUEST_ID"/);
assert.match(resumeScript, /REQUEST_ID="idacc-\$\(node -e/);
assert.match(resumeScript, /release_wait_for_dispatched_workflow_record/);
assert.match(resumeScript, /release_wait_for_workflow_run/);
assert.match(resumeScript, /scripts\/verify-public-release\.mjs/);
assert.match(resumeScript, /unset GH_TOKEN GITHUB_TOKEN IDACC_RELEASE_TOKEN RELEASE_ADMIN_TOKEN/);
assert.match(resumeScript, /\$STATE" = "prerelease"/);
const dispatchCompletion = resumeScript.slice(resumeScript.indexOf('DISPATCH_ARGS=('));
assert.ok(
  dispatchCompletion.indexOf('release_wait_for_dispatched_workflow_record')
    < dispatchCompletion.indexOf('release_wait_for_workflow_run')
    && dispatchCompletion.indexOf('release_wait_for_workflow_run')
      < dispatchCompletion.indexOf('scripts/verify-public-release.mjs'),
  'release command must discover and await its exact workflow run before public completion verification',
);

assert.match(workflow, /^name:\s*Production release\s*$/m);
assert.match(
  workflow,
  /^run-name:\s*Production release v\$\{\{\s*inputs\.version\s*\}\} publish=\$\{\{\s*inputs\.publish\s*\}\} request=\$\{\{\s*inputs\.request_id\s*\}\}\s*$/m,
);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
assert.match(workflow, /^\s*version:\s*$/m);
assert.match(workflow, /^\s*publish:\s*$/m);
assert.match(workflow, /^\s*request_id:\s*$/m);
assert.match(workflow, /^\s*signing_mode:\s*$/m);
assert.match(workflow, /^\s*unsigned_acknowledgement:\s*$/m);
assert.match(workflow, /RELEASE_REQUEST_ID:\s*\$\{\{\s*inputs\.request_id\s*\}\}/);
assert.match(workflow, /RELEASE_SIGNING_MODE:\s*\$\{\{\s*inputs\.signing_mode\s*\}\}/);
assert.match(workflow, /UNSIGNED_RELEASE_ACKNOWLEDGEMENT:\s*\$\{\{\s*inputs\.unsigned_acknowledgement\s*\}\}/);
assert.doesNotMatch(workflow, /\[ "\$\{\{\s*inputs\.unsigned_acknowledgement/);
assert.match(workflow, /publish-v\$RELEASE_VERSION-unsigned/);
assert.match(workflow, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{7,127\}\$/);
assert.match(workflow, /default:\s*false/);
assert.match(workflow, /Require a GitHub-verified signed annotated tag/);
assert.match(workflow, /git\/tags\/\$TAG_SHA" --jq '\.tag'/);
assert.match(workflow, /\.verification\.verified/);
assert.match(workflow, /\.verification\.reason/);
assert.match(workflow, /IDACC_GITHUB_VERIFIED_TAG:\s*\$\{\{\s*steps\.release-request\.outputs\.tag\s*\}\}/);
assert.match(workflow, /IDACC_GITHUB_VERIFIED_COMMIT:\s*\$\{\{\s*steps\.signed-tag\.outputs\.commit\s*\}\}/);
assert.match(workflow, /\$GITHUB_REF" != "refs\/tags\/\$RELEASE_TAG/);
assert.match(workflow, /\$GITHUB_SHA" != "\$TAG_COMMIT/);
assert.match(workflow, /Dispatch this workflow from the exact signed tag/);
assert.match(workflow, /Require GitHub-enforced immutable releases/);
assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/immutable-releases/);
assert.equal(
  (workflow.match(/repos\/\$GITHUB_REPOSITORY\/immutable-releases/g) || []).length,
  3,
  'the immutable-release repository setting must be checked at every publication boundary',
);
assert.equal(
  (workflow.match(/GH_TOKEN="\$RELEASE_ADMIN_TOKEN" gh api/g) || []).length,
  3,
  'every immutable-release setting read must use the dedicated Administration:read token',
);
assert.match(workflow, /Enable GitHub release immutability/);
assert.match(workflow, /compare\/\$RELEASE_COMMIT\.\.\.main/);
assert.match(workflow, /check-release-publication\.mjs --allow-tag "\$RELEASE_TAG"/);
const releaseFrontierBlock = workflow.slice(
  workflow.indexOf('RELEASE_FRONTIER='),
  workflow.indexOf('REQUEST_RELEASE_STATE='),
);
assert.match(releaseFrontierBlock, /release\.draft === false/);
assert.match(releaseFrontierBlock, /release\.prerelease === false/);
assert.match(releaseFrontierBlock, /requested\.prerelease === true[\s\S]*"prerelease"/);
assert.match(releaseFrontierBlock, /\.map\(BigInt\)/);
assert.doesNotMatch(
  releaseFrontierBlock,
  /\.map\(Number\)/,
  'release frontier ordering must preserve arbitrary-size semver components',
);
assert.match(workflow, /--json isDraft,isPrerelease/);
assert.match(workflow, /state=\$REQUEST_RELEASE_STATE/);
assert.match(workflow, /REQUEST_RELEASE_STATE/);
assert.match(workflow, /HIGHEST_PUBLISHED_TAG/);
assert.match(workflow, /must be newer than published/);
assert.match(workflow, /if:\s*\$\{\{\s*inputs\.publish\s*\}\}/);
assert.match(workflow, /promote-draft:/);
assert.match(workflow, /Promote draft matching an immutable successful-run artifact/);
assert.match(workflow, /runtime-source-tests:/);
assert.match(workflow, /npm run ci:preflight --prefix \.runtime-sources\/manager/);
assert.match(workflow, /npm run test:local-agent-lifecycle --prefix \.runtime-sources\/manager/);
assert.match(workflow, /node scripts\/runtime-source-capsule\.mjs materialize/);
assert.match(workflow, /npm ci --omit=dev --prefix \.runtime-sources\/brain/);
assert.doesNotMatch(workflow, /RUNTIME_SOURCE_TOKEN/);
assert.match(workflow, /ref:\s*\$\{\{\s*needs\.validate\.outputs\.release_commit\s*\}\}/);
assert.match(workflow, /Verify GitHub locked the published release/);
assert.match(workflow, /Verify GitHub locked the promoted release/);
assert.match(workflow, /releases\/tags\/\$RELEASE_TAG"[\s\S]*--jq '\.immutable'/);
assert.match(workflow, /xcrun notarytool submit "\$DMG"/);
assert.match(workflow, /xcrun stapler staple "\$DMG"/);
assert.match(workflow, /verify-public-release:/);
assert.match(workflow, /node scripts\/verify-public-release\.mjs/);
assert.match(workflow, /node scripts\/verify-update-descriptors\.mjs/);
assert.match(workflow, /Revalidate updater semantics before immutable promotion/);
assert.match(provenance, /vendored runtime capsule/i);
assert.match(provenance, /do not require a\s+private runtime-source credential/i);
assert.match(provenance, /RELEASE_ADMIN_TOKEN[\s\S]*Administration/);
assert.equal(cutoverMarker.baselinePublishedTag, 'v0.1.619');
assert.equal(cutoverMarker.firstCanonicalVersionMustExceed, 'v0.1.684');
assert.equal(cutoverMarker.schemaVersion, 3);
assert.equal(cutoverMarker.legacyTags.length, 65);
assert.equal(
  cutoverMarker.legacyTags.filter(({ release }) => release.state === 'published').length,
  62,
);
assert.equal(cutoverMarker.legacyTags.filter(({ kind }) => kind === 'annotated').length, 2);
assert.deepEqual(
  cutoverMarker.legacyTags
    .filter(({ release }) => release.state === 'absent')
    .map(({ tag }) => tag),
  ['v0.1.622', 'v0.1.624', 'v0.1.625'],
);
assert.match(gitignore, /^!release\/legacy-release-cutover\.json$/m);
assert.match(contributing, /RELEASE_CUTOVER\.md/);
assert.match(provenance, /RELEASE_CUTOVER\.md/);
const documentedFrontier = `GitHub Latest and the changelog baseline remain \`${
  cutoverMarker.baselinePublishedTag
}\`; \`${cutoverMarker.firstCanonicalVersionMustExceed}\` is the historical version floor that the first canonical signed release must exceed.`;
for (const [name, source] of [
  ['RELEASE_CUTOVER.md', cutoverDocumentation],
  ['RELEASE_PROVENANCE.md', provenance],
  ['PRODUCT_SPEC.md', productSpec],
]) {
  assert.ok(
    source.replace(/\s+/g, ' ').includes(documentedFrontier),
    `${name} must distinguish the public changelog baseline from the historical version floor`,
  );
}
assert.match(productSpec, /v0\.1\.620.*v0\.1\.684/s);
assert.match(productSpec, /62.*published.*3.*absent/s);

for (const legacyFlag of ['--commit', '--commit-only', '--no-publish']) {
  const rejected = spawnSync('bash', [join(root, 'scripts', 'release.sh'), 'Real release summary', legacyFlag], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0, `${legacyFlag} must not preserve the retired partial publisher path`);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /retired/);
}

const releaseStateProbeScript = `
gh() {
  if [[ " $* " == *" --json isDraft,isPrerelease "* ]]; then
    printf '%s\\n' "$MOCK_RELEASE_STATE"
    return 0
  fi
  return 0
}
source "$1"
release_state owner/repo v1.2.3
`;
for (const expectedState of ['draft', 'prerelease', 'published']) {
  const result = spawnSync(
    'bash',
    ['-c', releaseStateProbeScript, 'bash', join(root, 'scripts', 'lib', 'release-command.sh')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MOCK_RELEASE_STATE: expectedState },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), expectedState);
}
const invalidReleaseState = spawnSync(
  'bash',
  ['-c', releaseStateProbeScript, 'bash', join(root, 'scripts', 'lib', 'release-command.sh')],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MOCK_RELEASE_STATE: 'invalid' },
  },
);
assert.notEqual(invalidReleaseState.status, 0);
assert.match(invalidReleaseState.stderr, /invalid Release state/);

// The schema guard is exercised in a disposable repository so both structurally
// invalid tag forms are proven to fail without needing a developer signing key.
const fixture = mkdtempSync(join(tmpdir(), 'idacc-release-command-smoke-'));
try {
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'idctl', 'src'), { recursive: true });
  mkdirSync(join(fixture, 'idctl-desktop'), { recursive: true });
  cpSync(
    join(root, 'scripts', 'validate-release-schema.mjs'),
    join(fixture, 'scripts', 'validate-release-schema.mjs'),
  );
  const manifest = `${JSON.stringify({ version: '1.2.3' }, null, 2)}\n`;
  const lock = `${JSON.stringify({
    version: '1.2.3',
    packages: { '': { version: '1.2.3' } },
  }, null, 2)}\n`;
  for (const directory of ['idctl', 'idctl-desktop']) {
    writeFileSync(join(fixture, directory, 'package.json'), manifest);
    writeFileSync(join(fixture, directory, 'package-lock.json'), lock);
  }
  writeFileSync(
    join(fixture, 'idctl', 'src', 'version.ts'),
    '// AUTO-GENERATED test fixture.\nexport const IDCTL_VERSION = "1.2.3";\n',
  );
  writeFileSync(
    join(fixture, 'CHANGELOG.md'),
    '# Changelog\n\n## [1.2.3] — 2026-07-26\n### What changed\n- Exercise signed release validation.\n',
  );

  const git = (...args) => spawnSync('git', args, {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('config', 'user.name', 'Release Smoke').status, 0);
  assert.equal(git('config', 'user.email', 'release-smoke@example.invalid').status, 0);
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-q', '-m', 'v1.2.3: Exercise signed release validation').status, 0);

  const validate = () => spawnSync(
    process.execPath,
    [join(fixture, 'scripts', 'validate-release-schema.mjs'), '--publish', '1.2.3'],
    { cwd: fixture, encoding: 'utf8' },
  );
  const fixtureCommit = git('rev-parse', 'HEAD').stdout.trim();
  const verifyWithReleaseHelper = () => spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; release_assert_local_signed_tag "$2" "$3"',
      'bash',
      join(root, 'scripts', 'lib', 'release-command.sh'),
      'v1.2.3',
      fixtureCommit,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );

  assert.equal(git('tag', 'v1.2.3').status, 0);
  const lightweight = validate();
  assert.notEqual(lightweight.status, 0);
  assert.match(lightweight.stderr, /signed annotated tag object|lightweight/i);
  const helperLightweight = verifyWithReleaseHelper();
  assert.notEqual(helperLightweight.status, 0);
  assert.match(helperLightweight.stderr, /annotated tag object|lightweight/i);

  assert.equal(git('tag', '-d', 'v1.2.3').status, 0);
  assert.equal(git('tag', '-a', 'v1.2.3', '-m', 'Unsigned annotated tag').status, 0);
  const unsigned = validate();
  assert.notEqual(unsigned.status, 0);
  assert.match(unsigned.stderr, /annotated but unsigned/i);
  const helperUnsigned = verifyWithReleaseHelper();
  assert.notEqual(helperUnsigned.status, 0);
  assert.match(helperUnsigned.stderr, /annotated but unsigned/i);

  assert.equal(git('tag', '-d', 'v1.2.3').status, 0);
  assert.equal(
    git(
      'tag',
      '-a',
      'v1.2.3',
      '-m',
      'Signature-looking text only\n\n-----BEGIN SSH SIGNATURE-----\ninvalid\n-----END SSH SIGNATURE-----',
    ).status,
    0,
  );
  const fakeArmor = validate();
  assert.notEqual(fakeArmor.status, 0);
  assert.match(fakeArmor.stderr, /failed cryptographic verification with git verify-tag/i);
  const helperFakeArmor = verifyWithReleaseHelper();
  assert.notEqual(helperFakeArmor.status, 0);
  assert.match(helperFakeArmor.stderr, /failed cryptographic verification with 'git verify-tag'/i);

  assert.equal(git('tag', '-d', 'v1.2.3').status, 0);
  const signingKey = join(fixture, 'release-signing-key');
  const keygen = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', 'release-smoke@example.invalid', '-f', signingKey],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(keygen.status, 0, `ssh-keygen failed:\n${keygen.stdout}\n${keygen.stderr}`);
  const allowedSigners = join(fixture, 'allowed-signers');
  writeFileSync(
    allowedSigners,
    `release-smoke@example.invalid ${readFileSync(`${signingKey}.pub`, 'utf8').trim()}\n`,
  );
  assert.equal(git('config', 'gpg.format', 'ssh').status, 0);
  assert.equal(git('config', 'user.signingkey', signingKey).status, 0);
  assert.equal(git('config', 'gpg.ssh.allowedSignersFile', allowedSigners).status, 0);
  assert.equal(git('tag', '-s', '-a', 'v1.2.3', '-m', 'Valid SSH-signed tag').status, 0);
  assert.equal(git('verify-tag', 'v1.2.3').status, 0);
  const signed = validate();
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
  const helperSigned = verifyWithReleaseHelper();
  assert.equal(helperSigned.status, 0, `${helperSigned.stdout}\n${helperSigned.stderr}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await import('./release-publication-smoke.mjs');
await import('./release-publication-cli-smoke.mjs');
await import('./release-draft-promotion-smoke.mjs');
await import('./public-release-verifier-smoke.mjs');
await import('./release-workflow-wait-smoke.mjs');

console.log('release command smoke: ok');
