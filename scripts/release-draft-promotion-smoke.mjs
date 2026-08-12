#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const verifier = join(root, 'scripts', 'verify-release-promotion.mjs');
const commit = 'a'.repeat(40);
const runId = '8675309';

assert.match(workflow, /release_commit:\s*\$\{\{\s*steps\.signed-tag\.outputs\.commit\s*\}\}/);
assert.match(workflow, /previous_success_run_id:\s*\$\{\{\s*steps\.release-resume\.outputs\.run_id\s*\}\}/);
assert.match(workflow, /previous_success_artifact_id:\s*\$\{\{\s*steps\.release-resume\.outputs\.artifact_id\s*\}\}/);
assert.ok(workflow.includes('.head_sha == \\"$RELEASE_COMMIT\\"'));
assert.match(workflow, /actions\/runs\/\$RUN_ID\/artifacts\?per_page=100/);
assert.ok(workflow.includes('.name == "idacc-assembled-release" and .expired == false'));
assert.match(workflow, /actions\/runs\/\$RUN_ID\/jobs\?per_page=100/);
assert.match(workflow, /const onlyPublishFailed = byName\.get\("Publish verified release"\) === "failure"/);
assert.match(workflow, /"Attest assembled release"/);
assert.match(workflow, /\[ "\$VERIFIED_ARTIFACT_RUN" = "true" \] \|\| continue/);

const promotion = workflow.slice(workflow.indexOf('  promote-draft:'));
assert.match(promotion, /actions:\s*read/);
assert.match(promotion, /ref:\s*\$\{\{\s*needs\.validate\.outputs\.release_commit\s*\}\}/);
assert.match(promotion, /artifact-ids:\s*\$\{\{\s*needs\.validate\.outputs\.previous_success_artifact_id\s*\}\}/);
assert.match(promotion, /run-id:\s*\$\{\{\s*needs\.validate\.outputs\.previous_success_run_id\s*\}\}/);
assert.match(promotion, /github-token:\s*\$\{\{\s*github\.token\s*\}\}/);
assert.match(promotion, /node scripts\/verify-release-promotion\.mjs/);
assert.match(promotion, /--reference immutable-run-assets/);
assert.match(promotion, /--candidate draft-assets/);
assert.match(promotion, /npm ci --prefix idctl-desktop --omit=dev --ignore-scripts/);
assert.match(promotion, /Revalidate updater semantics before immutable promotion/);
assert.match(promotion, /node scripts\/verify-update-descriptors\.mjs/);
assert.match(promotion, /--directory draft-assets/);
assert.match(promotion, /RELEASE_ADMIN_TOKEN:\s*\$\{\{\s*secrets\.RELEASE_ADMIN_TOKEN\s*\}\}/);
assert.match(promotion, /GH_TOKEN="\$RELEASE_ADMIN_TOKEN" gh api/);
assert.match(promotion, /Verify GitHub locked the promoted release/);
assert.match(promotion, /repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG/);
assert.match(promotion, /--jq '\.immutable'/);
assert.match(promotion, /git\/tags\/\$TAG_OBJECT" --jq '\.object\.sha'/);
assert.ok(
  promotion.indexOf('Bind every draft byte to the immutable successful-run artifact')
    < promotion.indexOf('Revalidate updater semantics before immutable promotion')
    && promotion.indexOf('Revalidate updater semantics before immutable promotion')
      < promotion.indexOf('Publish the artifact-bound draft')
    && promotion.indexOf('Publish the artifact-bound draft')
      < promotion.indexOf('Verify GitHub locked the promoted release'),
);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function writeChecksums(directory) {
  const names = [
    'ID-Agents-Control-Center-1.2.3-arm64.dmg',
    'ID-Agents-Control-Center-1.2.3-x64.dmg',
    'ID-Agents-Control-Center-1.2.3-arm64.zip',
    'ID-Agents-Control-Center-1.2.3-x64.zip',
    'ID-Agents-Control-Center-1.2.3-x86_64.AppImage',
    'ID-Agents-Control-Center-1.2.3-amd64.deb',
    'ID-Agents-Control-Center-1.2.3-x64.exe',
    'IDACC-provenance-darwin-arm64.tar.gz',
    'IDACC-provenance-darwin-x64.tar.gz',
    'IDACC-provenance-linux-x64.tar.gz',
    'IDACC-provenance-win32-x64.tar.gz',
    'latest-linux.yml',
    'latest-mac.yml',
    'latest.yml',
    'release-index.json',
    'release-index.sha256',
  ];
  const lines = names
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}`);
  writeFileSync(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function writeBundle(directory, marker, sourceCommit = commit) {
  mkdirSync(directory, { recursive: true });
  const nativeArtifacts = [
    ['ID-Agents-Control-Center-1.2.3-arm64.dmg', 'darwin', 'arm64'],
    ['ID-Agents-Control-Center-1.2.3-x64.dmg', 'darwin', 'x64'],
    ['ID-Agents-Control-Center-1.2.3-arm64.zip', 'darwin', 'arm64'],
    ['ID-Agents-Control-Center-1.2.3-x64.zip', 'darwin', 'x64'],
    ['ID-Agents-Control-Center-1.2.3-x64.exe', 'win32', 'x64'],
    ['ID-Agents-Control-Center-1.2.3-x86_64.AppImage', 'linux', 'x64'],
    ['ID-Agents-Control-Center-1.2.3-amd64.deb', 'linux', 'x64'],
  ];
  for (const [name] of nativeArtifacts) {
    writeFileSync(join(directory, name), `${name}:${marker}\n`);
  }
  for (const name of [
    'latest-mac.yml',
    'latest.yml',
    'latest-linux.yml',
    'IDACC-provenance-darwin-arm64.tar.gz',
    'IDACC-provenance-darwin-x64.tar.gz',
    'IDACC-provenance-win32-x64.tar.gz',
    'IDACC-provenance-linux-x64.tar.gz',
  ]) {
    writeFileSync(join(directory, name), `${name}:${marker}\n`);
  }
  const artifacts = nativeArtifacts.map(([name, platform, arch]) => {
    const data = readFileSync(join(directory, name));
    return {
      name,
      size: data.length,
      sha256: sha256(data),
      platform,
      arch,
    };
  });
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-07-26T00:00:00.000Z',
    application: {
      name: 'ID Agents Control Center',
      version: '1.2.3',
      commit: sourceCommit,
    },
    components: {},
    releases: [
      { target: 'darwin-arm64' },
      { target: 'darwin-x64' },
      { target: 'linux-x64' },
      { target: 'win32-x64' },
    ],
    artifacts,
  };
  const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
  writeFileSync(join(directory, 'release-index.json'), indexBytes);
  writeFileSync(
    join(directory, 'release-index.sha256'),
    `${sha256(indexBytes)}  release-index.json\n`,
  );
  writeChecksums(directory);
}

function verify(reference, candidate, expectedCommit = commit) {
  return spawnSync(process.execPath, [
    verifier,
    '--reference', reference,
    '--candidate', candidate,
    '--expected-commit', expectedCommit,
    '--run-id', runId,
  ], {
    cwd: root,
    encoding: 'utf8',
  });
}

const fixture = mkdtempSync(join(tmpdir(), 'idacc-release-promotion-smoke-'));
try {
  const reference = join(fixture, 'reference');
  const candidate = join(fixture, 'candidate');
  writeBundle(reference, 'trusted');
  writeBundle(candidate, 'trusted');
  const accepted = verify(reference, candidate);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /match immutable successful run 8675309/);

  // This candidate is internally consistent: its asset, release index, index
  // checksum, and aggregate checksums all agree. It must still be rejected
  // because none of those mutable draft records establish successful-run origin.
  rmSync(candidate, { recursive: true, force: true });
  writeBundle(candidate, 'attacker-replaced');
  const selfConsistentReplacement = verify(reference, candidate);
  assert.notEqual(selfConsistentReplacement.status, 0);
  assert.match(selfConsistentReplacement.stderr, /does not match immutable artifact from successful run/);

  rmSync(candidate, { recursive: true, force: true });
  writeBundle(candidate, 'trusted');
  writeFileSync(join(candidate, 'unexpected.txt'), 'extra\n');
  writeChecksums(candidate);
  const extraAsset = verify(reference, candidate);
  assert.notEqual(extraAsset.status, 0);
  assert.match(extraAsset.stderr, /asset set differs/);

  const wrongCommit = verify(reference, candidate, 'b'.repeat(40));
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /release index is for commit/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('release draft promotion smoke: ok');
