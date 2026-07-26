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
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
const provenance = readFileSync(join(root, 'docs', 'RELEASE_PROVENANCE.md'), 'utf8');
const cutoverDocumentation = readFileSync(join(root, 'docs', 'RELEASE_CUTOVER.md'), 'utf8');
const productSpec = readFileSync(join(root, 'docs', 'PRODUCT_SPEC.md'), 'utf8');
const cutoverMarker = JSON.parse(readFileSync(join(root, 'release', 'legacy-release-cutover.json'), 'utf8'));
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
assert.match(releaseScript, /git tag -s -a "\$TAG"/);
assert.match(releaseScript, /git push --atomic origin/);
assert.match(releaseScript, /release_wait_for_github_verified_tag/);
assert.match(releaseScript, /check-release-publication\.mjs" --json/);
assert.match(releaseScript, /RANGE="\$\{CHANGELOG_BASELINE\}\.\.HEAD"/);
assert.match(releaseScript, /CHANGELOG_LINES=\("\$PRIMARY_NOTE"\)/);
assert.match(releaseScript, /append_changelog_line "\$note"/);
assert.doesNotMatch(releaseScript, /git describe/, 'changelog history must start at the published release, not an unpublished local tag');
assert.match(resumeScript, /release_active_workflow_url/);
assert.match(resumeScript, /gh workflow run release\.yml/);
assert.match(resumeScript, /--field "version=\$VER"/);
assert.match(resumeScript, /--field "publish=\$PUBLISH"/);

assert.match(workflow, /^name:\s*Production release\s*$/m);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
assert.match(workflow, /^\s*version:\s*$/m);
assert.match(workflow, /^\s*publish:\s*$/m);
assert.match(workflow, /default:\s*false/);
assert.match(workflow, /Require a GitHub-verified signed annotated tag/);
assert.match(workflow, /git\/tags\/\$TAG_SHA" --jq '\.tag'/);
assert.match(workflow, /\.verification\.verified/);
assert.match(workflow, /\$GITHUB_REF" != "refs\/tags\/\$RELEASE_TAG/);
assert.match(workflow, /\$GITHUB_SHA" != "\$TAG_COMMIT/);
assert.match(workflow, /Dispatch this workflow from the exact signed tag/);
assert.match(workflow, /Require GitHub-enforced immutable releases/);
assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/immutable-releases/);
assert.match(workflow, /Enable GitHub release immutability/);
assert.match(workflow, /compare\/\$RELEASE_COMMIT\.\.\.main/);
assert.match(workflow, /check-release-publication\.mjs --allow-tag "\$RELEASE_TAG"/);
assert.match(workflow, /REQUEST_RELEASE_STATE/);
assert.match(workflow, /HIGHEST_PUBLISHED_TAG/);
assert.match(workflow, /must be newer than published/);
assert.match(workflow, /if:\s*\$\{\{\s*inputs\.publish\s*\}\}/);
assert.match(workflow, /promote-draft:/);
assert.match(workflow, /Promote draft matching an immutable successful-run artifact/);
assert.match(workflow, /runtime-source-tests:/);
assert.match(workflow, /npm run ci:preflight --prefix \.runtime-sources\/manager/);
assert.match(workflow, /npm run test:local-agent-lifecycle --prefix \.runtime-sources\/manager/);
assert.match(workflow, /npm test --prefix \.runtime-sources\/brain/);
assert.match(workflow, /ref:\s*\$\{\{\s*needs\.validate\.outputs\.release_commit\s*\}\}/);
assert.match(workflow, /Verify GitHub locked the published release/);
assert.match(workflow, /Verify GitHub locked the promoted release/);
assert.match(workflow, /releases\/tags\/\$RELEASE_TAG"[\s\S]*--jq '\.immutable'/);
assert.equal(cutoverMarker.baselinePublishedTag, 'v0.1.619');
assert.equal(cutoverMarker.firstCanonicalVersionMustExceed, 'v0.1.647');
assert.equal(cutoverMarker.schemaVersion, 2);
assert.equal(cutoverMarker.legacyTags.length, 28);
assert.equal(
  cutoverMarker.legacyTags.filter(({ release }) => release.state === 'published-non-latest').length,
  25,
);
assert.deepEqual(
  cutoverMarker.legacyTags
    .filter(({ release }) => release.state === 'absent')
    .map(({ tag }) => tag),
  ['v0.1.622', 'v0.1.624', 'v0.1.625'],
);
assert.match(gitignore, /^!release\/legacy-release-cutover\.json$/m);
assert.match(contributing, /RELEASE_CUTOVER\.md/);
assert.match(provenance, /RELEASE_CUTOVER\.md/);
assert.match(productSpec, /v0\.1\.620.*v0\.1\.647/s);
assert.match(productSpec, /25.*published.*3.*absent/s);

for (const legacyFlag of ['--commit', '--commit-only', '--no-publish']) {
  const rejected = spawnSync('bash', [join(root, 'scripts', 'release.sh'), 'Real release summary', legacyFlag], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0, `${legacyFlag} must not preserve the retired partial publisher path`);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /retired/);
}

// The schema guard is exercised in a disposable repository so both structurally
// invalid tag forms are proven to fail without needing a developer signing key.
const fixture = mkdtempSync(join(tmpdir(), 'idacc-release-command-smoke-'));
try {
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'idctl'), { recursive: true });
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

  assert.equal(git('tag', 'v1.2.3').status, 0);
  const lightweight = validate();
  assert.notEqual(lightweight.status, 0);
  assert.match(lightweight.stderr, /signed annotated tag object|lightweight/i);

  assert.equal(git('tag', '-d', 'v1.2.3').status, 0);
  assert.equal(git('tag', '-a', 'v1.2.3', '-m', 'Unsigned annotated tag').status, 0);
  const unsigned = validate();
  assert.notEqual(unsigned.status, 0);
  assert.match(unsigned.stderr, /annotated but unsigned/i);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await import('./release-publication-smoke.mjs');
await import('./release-publication-cli-smoke.mjs');
await import('./release-draft-promotion-smoke.mjs');

console.log('release command smoke: ok');
