#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'idacc-release-publication-cli-'));
const origin = join(fixture, 'origin.git');
const checkout = join(fixture, 'checkout');
const marker = JSON.parse(readFileSync(join(root, 'release', 'legacy-release-cutover.json'), 'utf8'));
const releasesByTag = new Map(marker.legacyTags.map(({ tag, release }) => [
  tag,
  release.state === 'absent'
    ? null
    : {
        tag_name: tag,
        id: release.id,
        published_at: release.publishedAt,
        draft: false,
        prerelease: false,
      },
]));
let unexpectedPublishedTag = '';
let missingPublishedTag = '';
let changedIdentityTag = '';

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  assert.equal(
    result.status,
    0,
    `${program} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function copyIntoCheckout(relativePath) {
  const destination = join(checkout, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, relativePath), destination);
}

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Connection', 'close');
  if (request.url?.endsWith('/releases/latest')) {
    response.end(JSON.stringify({ tag_name: 'v0.1.619', draft: false }));
    return;
  }
  const tagMatch = request.url?.match(/\/releases\/tags\/([^/?]+)$/);
  if (tagMatch) {
    const tag = decodeURIComponent(tagMatch[1]);
    if (tag === unexpectedPublishedTag) {
      response.end(JSON.stringify({
        tag_name: tag,
        id: 999,
        published_at: '2026-07-26T00:00:00Z',
        draft: false,
        prerelease: false,
      }));
      return;
    }
    const release = releasesByTag.get(tag);
    if (release && tag !== missingPublishedTag) {
      response.end(JSON.stringify(
        tag === changedIdentityTag ? { ...release, id: release.id + 1 } : release,
      ));
      return;
    }
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'Not Found' }));
});

try {
  command('git', ['clone', '--quiet', '--bare', root, origin]);
  command('git', ['clone', '--quiet', origin, checkout]);
  const fixtureTags = command('git', ['tag', '--list'], { cwd: checkout })
    .stdout.trim().split(/\r?\n/).filter(Boolean);
  const fixtureKeepTags = new Set([
    marker.baselinePublishedTag,
    ...marker.legacyTags.map(({ tag }) => tag),
  ]);
  for (const tag of fixtureTags) {
    if (/^v\d+\.\d+\.\d+$/.test(tag) && !fixtureKeepTags.has(tag)) {
      command('git', ['tag', '--delete', tag], { cwd: checkout });
      command('git', ['push', '--quiet', 'origin', `:refs/tags/${tag}`], { cwd: checkout });
    }
  }
  for (const relativePath of [
    'release/legacy-release-cutover.json',
    'scripts/check-release-publication.mjs',
    'scripts/lib/legacy-release-cutover.mjs',
    'scripts/lib/release-publication.mjs',
  ]) {
    copyIntoCheckout(relativePath);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const guard = join(checkout, 'scripts', 'check-release-publication.mjs');
  const env = {
    ...process.env,
    IDACC_RELEASE_API_BASE: `http://127.0.0.1:${address.port}`,
    IDACC_RELEASE_REPOSITORY: 'bobofbuilding/idacc',
  };
  function run(args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [guard, ...args], { cwd: checkout, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  const allowed = await run(['--json']);
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  const state = JSON.parse(allowed.stdout);
  assert.equal(state.latestPublishedTag, 'v0.1.619');
  assert.equal(state.changelogBaselineTag, 'v0.1.619');
  assert.equal(state.firstCanonicalVersionMustExceed, 'v0.1.647');
  assert.deepEqual(state.cutover, {
    active: true,
    baselinePublishedTag: 'v0.1.619',
    legacyTagCount: 28,
    publishedNonLatestReleaseCount: 25,
    absentReleaseCount: 3,
  });

  unexpectedPublishedTag = 'v0.1.622';
  const absentPublished = await run();
  assert.notEqual(absentPublished.status, 0, 'an absent historical release must not be published');
  assert.match(`${absentPublished.stdout}\n${absentPublished.stderr}`, /v0\.1\.622 must remain absent/);
  unexpectedPublishedTag = '';

  missingPublishedTag = 'v0.1.630';
  const publishedRemoved = await run();
  assert.notEqual(publishedRemoved.status, 0, 'a recorded published release must not disappear');
  assert.match(`${publishedRemoved.stdout}\n${publishedRemoved.stderr}`, /v0\.1\.630 must remain a published GitHub Release/);
  missingPublishedTag = '';

  changedIdentityTag = 'v0.1.647';
  const identityChanged = await run();
  assert.notEqual(identityChanged.status, 0, 'a recorded release identity must not change');
  assert.match(`${identityChanged.stdout}\n${identityChanged.stderr}`, /v0\.1\.647 release id is/);
  changedIdentityTag = '';

  command('git', ['tag', 'v0.1.648'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', 'refs/tags/v0.1.648'], { cwd: checkout });
  const unexpected = await run();
  assert.notEqual(unexpected.status, 0, 'an unexpected unpublished frontier tag must block release.sh');
  assert.match(`${unexpected.stdout}\n${unexpected.stderr}`, /v0\.1\.648/);

  console.log('✓ release publication CLI cutover smoke test passed');
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  rmSync(fixture, { recursive: true, force: true });
}
