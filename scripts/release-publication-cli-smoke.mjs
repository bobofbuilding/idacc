#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
let unexpectedPublishedPrerelease = false;
let missingPublishedTag = '';
let changedIdentityTag = '';
let latestStableTag = 'v0.1.619';
let canonicalTagApi = null;
let inventoryPaddingCount = 0;
let malformedInventoryPage = 0;
let inventoryRequestPages = [];

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
    response.end(JSON.stringify({
      tag_name: latestStableTag,
      draft: false,
      prerelease: false,
    }));
    return;
  }
  const gitRefMatch = request.url?.match(/\/git\/ref\/tags\/([^/?]+)$/);
  if (gitRefMatch && canonicalTagApi) {
    response.end(JSON.stringify({
      ref: `refs/tags/${decodeURIComponent(gitRefMatch[1])}`,
      object: {
        type: canonicalTagApi.objectType,
        sha: canonicalTagApi.objectId,
      },
    }));
    return;
  }
  const gitTagMatch = request.url?.match(/\/git\/tags\/([^/?]+)$/);
  if (
    gitTagMatch
    && canonicalTagApi
    && decodeURIComponent(gitTagMatch[1]) === canonicalTagApi.objectId
  ) {
    response.end(JSON.stringify({
      tag: 'v0.1.685',
      object: {
        type: canonicalTagApi.targetObjectType,
        sha: canonicalTagApi.targetCommit,
      },
      verification: {
        verified: canonicalTagApi.verified,
        reason: canonicalTagApi.verificationReason,
      },
    }));
    return;
  }
  if (request.url?.includes('/releases?')) {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const page = Number(requestUrl.searchParams.get('page') || '1');
    const perPage = Number(requestUrl.searchParams.get('per_page') || '30');
    inventoryRequestPages.push(page);
    if (page === malformedInventoryPage) {
      response.end(JSON.stringify({ message: 'malformed inventory fixture' }));
      return;
    }
    const inventory = Array.from(
      { length: inventoryPaddingCount },
      (_, index) => ({
        tag_name: `pagination-fixture-${index + 1}`,
        id: 10_000 + index,
        published_at: '2026-07-01T00:00:00Z',
        draft: false,
        prerelease: false,
      }),
    );
    for (const [tag, release] of releasesByTag) {
      if (!release || tag === missingPublishedTag) continue;
      inventory.push(
        tag === changedIdentityTag
          ? { ...release, id: release.id + 1 }
          : release,
      );
    }
    if (unexpectedPublishedTag) {
      inventory.push({
        tag_name: unexpectedPublishedTag,
        id: 999,
        published_at: '2026-07-26T00:00:00Z',
        draft: false,
        prerelease: unexpectedPublishedPrerelease,
      });
    }
    const start = (page - 1) * perPage;
    response.end(JSON.stringify(inventory.slice(start, start + perPage)));
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
  command('git', ['config', 'user.name', 'IDACC Release Test'], { cwd: checkout });
  command('git', ['config', 'user.email', 'release-test@invalid.example'], { cwd: checkout });
  const fixtureCommit = command('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
  const fixtureTags = command('git', ['tag', '--list'], { cwd: checkout })
    .stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const tag of fixtureTags) {
    if (/^v\d+\.\d+\.\d+$/.test(tag)) {
      command('git', ['tag', '--delete', tag], { cwd: checkout });
      command('git', ['push', '--quiet', 'origin', `:refs/tags/${tag}`], { cwd: checkout });
    }
  }
  // The caller may be a depth-one, tagless CI checkout. Build the historical
  // cutover entirely inside this disposable fixture so the smoke never gains
  // hidden dependencies on the caller's clone depth or local tag cache.
  const cutoverTags = [
    marker.baselinePublishedTag,
    ...marker.legacyTags.map(({ tag }) => tag),
  ];
  command('git', ['tag', marker.baselinePublishedTag, fixtureCommit], { cwd: checkout });
  for (const entry of marker.legacyTags) {
    command(
      'git',
      entry.kind === 'annotated'
        ? ['tag', '--annotate', entry.tag, '--message', `unsigned fixture ${entry.tag}`, fixtureCommit]
        : ['tag', entry.tag, fixtureCommit],
      { cwd: checkout },
    );
  }
  const fixtureMarker = {
    ...marker,
    legacyTags: marker.legacyTags.map((entry) => (
      entry.kind === 'annotated'
        ? {
            ...entry,
            tagObject: command(
              'git',
              ['rev-parse', entry.tag],
              { cwd: checkout },
            ).stdout.trim(),
            targetCommit: fixtureCommit,
            signatureState: 'unsigned',
          }
        : {
            ...entry,
            targetCommit: fixtureCommit,
          }
    )),
  };
  command(
    'git',
    ['push', '--quiet', 'origin', ...cutoverTags.map((tag) => `refs/tags/${tag}`)],
    { cwd: checkout },
  );
  for (const relativePath of [
    'scripts/check-release-publication.mjs',
    'scripts/lib/legacy-release-cutover.mjs',
    'scripts/lib/release-publication.mjs',
  ]) {
    copyIntoCheckout(relativePath);
  }
  const fixtureMarkerPath = join(checkout, 'release', 'legacy-release-cutover.json');
  mkdirSync(dirname(fixtureMarkerPath), { recursive: true });
  writeFileSync(fixtureMarkerPath, `${JSON.stringify(fixtureMarker, null, 2)}\n`);

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
  assert.equal(state.firstCanonicalVersionMustExceed, 'v0.1.684');
  assert.deepEqual(state.cutover, {
    active: true,
    baselinePublishedTag: 'v0.1.619',
    legacyTagCount: 65,
    publishedReleaseCount: 62,
    absentReleaseCount: 3,
  });

  const publishedLegacyCount = [...releasesByTag.values()]
    .filter(Boolean)
    .length;
  inventoryPaddingCount = 100 - publishedLegacyCount;
  inventoryRequestPages = [];
  const exactPage = await run(['--json']);
  assert.equal(exactPage.status, 0, `${exactPage.stdout}\n${exactPage.stderr}`);
  assert.deepEqual(
    inventoryRequestPages,
    [1, 2],
    'an exact 100-record page must terminate after one empty follow-up page',
  );

  inventoryPaddingCount += 1;
  inventoryRequestPages = [];
  const multiplePages = await run(['--json']);
  assert.equal(
    multiplePages.status,
    0,
    `${multiplePages.stdout}\n${multiplePages.stderr}`,
  );
  assert.deepEqual(
    inventoryRequestPages,
    [1, 2],
    'release inventory records on page two must be accumulated',
  );

  malformedInventoryPage = 2;
  inventoryRequestPages = [];
  const malformedLaterPage = await run();
  assert.notEqual(
    malformedLaterPage.status,
    0,
    'a malformed later inventory page must fail closed',
  );
  assert.deepEqual(inventoryRequestPages, [1, 2]);
  assert.match(
    `${malformedLaterPage.stdout}\n${malformedLaterPage.stderr}`,
    /release inventory.*unexpected payload/i,
  );
  malformedInventoryPage = 0;
  inventoryPaddingCount = 0;

  unexpectedPublishedTag = 'v0.1.622';
  unexpectedPublishedPrerelease = false;
  const absentPublished = await run();
  assert.notEqual(absentPublished.status, 0, 'an absent historical release must not be published');
  assert.match(`${absentPublished.stdout}\n${absentPublished.stderr}`, /v0\.1\.622 must remain absent/);
  unexpectedPublishedTag = '';

  missingPublishedTag = 'v0.1.630';
  const publishedRemoved = await run();
  assert.notEqual(publishedRemoved.status, 0, 'a recorded published release must not disappear');
  assert.match(`${publishedRemoved.stdout}\n${publishedRemoved.stderr}`, /v0\.1\.630 must remain a published GitHub Release/);
  missingPublishedTag = '';

  changedIdentityTag = 'v0.1.684';
  const identityChanged = await run();
  assert.notEqual(identityChanged.status, 0, 'a recorded release identity must not change');
  assert.match(`${identityChanged.stdout}\n${identityChanged.stderr}`, /v0\.1\.684 release id is/);
  changedIdentityTag = '';

  command('git', ['tag', 'v0.1.685'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', 'refs/tags/v0.1.685'], { cwd: checkout });
  unexpectedPublishedTag = 'v0.1.685';
  unexpectedPublishedPrerelease = true;
  const prerelease = await run(['--require-tag', 'v0.1.685']);
  assert.notEqual(prerelease.status, 0, 'a prerelease must not satisfy stable release parity');
  assert.match(
    `${prerelease.stdout}\n${prerelease.stderr}`,
    /v0\.1\.685 has no published GitHub Release/,
  );
  unexpectedPublishedTag = '';
  unexpectedPublishedPrerelease = false;
  const unexpected = await run();
  assert.notEqual(unexpected.status, 0, 'an unexpected unpublished frontier tag must block release.sh');
  assert.match(`${unexpected.stdout}\n${unexpected.stderr}`, /v0\.1\.685/);

  unexpectedPublishedTag = 'v0.1.685';
  latestStableTag = 'v0.1.685';
  canonicalTagApi = {
    objectType: 'commit',
    objectId: fixtureCommit,
  };
  const canonicalLightweight = await run(['--require-tag', 'v0.1.685']);
  assert.notEqual(canonicalLightweight.status, 0);
  assert.match(
    `${canonicalLightweight.stdout}\n${canonicalLightweight.stderr}`,
    /lightweight canonical release tags are not allowed/,
  );

  command('git', ['tag', '--delete', 'v0.1.685'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', ':refs/tags/v0.1.685'], { cwd: checkout });
  command(
    'git',
    ['tag', '--annotate', 'v0.1.685', '--message', 'Unsigned canonical fixture', fixtureCommit],
    { cwd: checkout },
  );
  command('git', ['push', '--quiet', 'origin', 'refs/tags/v0.1.685'], { cwd: checkout });
  canonicalTagApi = {
    objectType: 'tag',
    objectId: command('git', ['rev-parse', 'v0.1.685'], { cwd: checkout }).stdout.trim(),
    targetObjectType: 'commit',
    targetCommit: fixtureCommit,
    verified: false,
    verificationReason: 'unsigned',
  };
  const canonicalUnsigned = await run(['--require-tag', 'v0.1.685']);
  assert.notEqual(canonicalUnsigned.status, 0);
  assert.match(
    `${canonicalUnsigned.stdout}\n${canonicalUnsigned.stderr}`,
    /valid GitHub-verified signature.*unverified.*unsigned/,
  );

  command('git', ['tag', '--delete', 'v0.1.685'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', ':refs/tags/v0.1.685'], { cwd: checkout });
  command(
    'git',
    [
      'tag',
      '--annotate',
      'v0.1.685',
      '--message',
      'Signature-looking text only\n\n-----BEGIN SSH SIGNATURE-----\ninvalid\n-----END SSH SIGNATURE-----',
      fixtureCommit,
    ],
    { cwd: checkout },
  );
  command('git', ['push', '--quiet', 'origin', 'refs/tags/v0.1.685'], { cwd: checkout });
  canonicalTagApi = {
    objectType: 'tag',
    objectId: command('git', ['rev-parse', 'v0.1.685'], { cwd: checkout }).stdout.trim(),
    targetObjectType: 'commit',
    targetCommit: fixtureCommit,
    verified: false,
    verificationReason: 'invalid',
  };
  const fakeSignatureArmor = await run(['--require-tag', 'v0.1.685']);
  assert.notEqual(fakeSignatureArmor.status, 0);
  assert.match(
    `${fakeSignatureArmor.stdout}\n${fakeSignatureArmor.stderr}`,
    /valid GitHub-verified signature.*unverified.*invalid/,
  );

  command('git', ['tag', '--delete', 'v0.1.685'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', ':refs/tags/v0.1.685'], { cwd: checkout });
  const signingKey = join(fixture, 'canonical-release-signing-key');
  command(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', 'release-test@invalid.example', '-f', signingKey],
  );
  const allowedSigners = join(fixture, 'canonical-release-allowed-signers');
  writeFileSync(
    allowedSigners,
    `release-test@invalid.example ${readFileSync(`${signingKey}.pub`, 'utf8').trim()}\n`,
  );
  command('git', ['config', 'gpg.format', 'ssh'], { cwd: checkout });
  command('git', ['config', 'user.signingkey', signingKey], { cwd: checkout });
  command('git', ['config', 'gpg.ssh.allowedSignersFile', allowedSigners], { cwd: checkout });
  command(
    'git',
    ['tag', '--sign', '--annotate', 'v0.1.685', '--message', 'Valid canonical fixture', fixtureCommit],
    { cwd: checkout },
  );
  command('git', ['verify-tag', 'v0.1.685'], { cwd: checkout });
  command('git', ['push', '--quiet', 'origin', 'refs/tags/v0.1.685'], { cwd: checkout });
  canonicalTagApi = {
    objectType: 'tag',
    objectId: command('git', ['rev-parse', 'v0.1.685'], { cwd: checkout }).stdout.trim(),
    targetObjectType: 'commit',
    targetCommit: fixtureCommit,
    verified: true,
    verificationReason: 'valid',
  };
  const canonical = await run(['--require-tag', 'v0.1.685', '--json']);
  assert.equal(canonical.status, 0, `${canonical.stdout}\n${canonical.stderr}`);
  const canonicalState = JSON.parse(canonical.stdout);
  assert.equal(canonicalState.latestPublishedTag, 'v0.1.685');
  assert.equal(canonicalState.cutover.active, false);

  console.log('✓ release publication CLI cutover smoke test passed');
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  rmSync(fixture, { recursive: true, force: true });
}
