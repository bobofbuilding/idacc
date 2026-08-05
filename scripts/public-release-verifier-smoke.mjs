#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const verifier = join(root, 'scripts', 'verify-public-release.mjs');
const repository = 'bobofbuilding/idacc';
const tag = 'v1.2.3';
const version = '1.2.3';
const commit = 'a'.repeat(40);
const tagObjectSha = 'b'.repeat(40);

function digest(algorithm, data, encoding = 'hex') {
  return createHash(algorithm).update(data).digest(encoding);
}

function bytes(value) {
  return Buffer.from(`${value}\n`, 'utf8');
}

function updateYaml(files, primary) {
  const records = files.map((name) => {
    const data = assets.get(name);
    return [
      `  - url: ${name}`,
      `    sha512: ${digest('sha512', data, 'base64')}`,
      `    size: ${data.length}`,
      ...(name.endsWith('.AppImage') ? ['    blockMapSize: 8'] : []),
    ].join('\n');
  }).join('\n');
  return Buffer.from([
    `version: ${version}`,
    'files:',
    records,
    `path: ${primary}`,
    `sha512: ${digest('sha512', assets.get(primary), 'base64')}`,
    'releaseDate: 2026-07-26T00:00:00.000Z',
    '',
  ].join('\n'));
}

const nativeArtifacts = [
  ['ID-Agents-Control-Center-1.2.3-arm64.dmg', 'darwin', 'arm64'],
  ['ID-Agents-Control-Center-1.2.3-x64.dmg', 'darwin', 'x64'],
  ['ID-Agents-Control-Center-1.2.3-arm64.zip', 'darwin', 'arm64'],
  ['ID-Agents-Control-Center-1.2.3-x64.zip', 'darwin', 'x64'],
  ['ID-Agents-Control-Center-1.2.3-x64.exe', 'win32', 'x64'],
  ['ID-Agents-Control-Center-1.2.3-x86_64.AppImage', 'linux', 'x64'],
  ['ID-Agents-Control-Center-1.2.3-amd64.deb', 'linux', 'x64'],
];
const assets = new Map(nativeArtifacts.map(([name]) => [name, bytes(name)]));
for (const name of [
  'IDACC-provenance-darwin-arm64.tar.gz',
  'IDACC-provenance-darwin-x64.tar.gz',
  'IDACC-provenance-linux-x64.tar.gz',
  'IDACC-provenance-win32-x64.tar.gz',
]) {
  assets.set(name, bytes(name));
}

assets.set(
  'latest-mac.yml',
  updateYaml(
    [
      'ID-Agents-Control-Center-1.2.3-arm64.zip',
      'ID-Agents-Control-Center-1.2.3-x64.zip',
    ],
    'ID-Agents-Control-Center-1.2.3-x64.zip',
  ),
);
assets.set(
  'latest.yml',
  updateYaml(
    ['ID-Agents-Control-Center-1.2.3-x64.exe'],
    'ID-Agents-Control-Center-1.2.3-x64.exe',
  ),
);
assets.set(
  'latest-linux.yml',
  updateYaml(
    [
      'ID-Agents-Control-Center-1.2.3-x86_64.AppImage',
      'ID-Agents-Control-Center-1.2.3-amd64.deb',
    ],
    'ID-Agents-Control-Center-1.2.3-x86_64.AppImage',
  ),
);

const releaseIndex = {
  schemaVersion: 1,
  application: {
    name: 'ID Agents Control Center',
    version,
    commit,
  },
  components: {},
  releases: [
    { target: 'darwin-arm64' },
    { target: 'darwin-x64' },
    { target: 'linux-x64' },
    { target: 'win32-x64' },
  ],
  artifacts: nativeArtifacts.map(([name, platform, arch]) => ({
    name,
    platform,
    arch,
    size: assets.get(name).length,
    sha256: digest('sha256', assets.get(name)),
  })),
};
const releaseIndexBytes = Buffer.from(`${JSON.stringify(releaseIndex, null, 2)}\n`);
assets.set('release-index.json', releaseIndexBytes);
assets.set(
  'release-index.sha256',
  Buffer.from(`${digest('sha256', releaseIndexBytes)}  release-index.json\n`),
);
function refreshChecksums() {
  const checksumLines = [...assets]
    .filter(([name]) => name !== 'SHA256SUMS')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, data]) => `${digest('sha256', data)}  ${name}`);
  assets.set('SHA256SUMS', Buffer.from(`${checksumLines.join('\n')}\n`));
}
refreshChecksums();

const requests = [];
let releaseImmutable = true;
let latestTransient404s = 1;
let webLatestTag = tag;
let webLatestTransientOldTags = 1;
let atomTag = tag;
let atomTransientOldTags = 1;
let origin = '';

function releasePayload() {
  return {
    id: 12345,
    tag_name: tag,
    draft: false,
    prerelease: false,
    immutable: releaseImmutable,
    published_at: '2026-07-26T00:00:00Z',
    assets: [...assets]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, data], index) => ({
        id: 20000 + index,
        name,
        state: 'uploaded',
        size: data.length,
        digest: `sha256:${digest('sha256', data)}`,
        browser_download_url: `${origin}/download/${encodeURIComponent(name)}`,
      })),
  };
}

const server = createServer((request, response) => {
  requests.push({
    url: request.url,
    authorization: request.headers.authorization || '',
  });
  const json = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.url === `/repos/${repository}/releases/tags/${tag}`) {
    json(200, releasePayload());
    return;
  }
  if (request.url === `/repos/${repository}/releases/latest`) {
    if (latestTransient404s > 0) {
      latestTransient404s -= 1;
      json(404, { message: 'not propagated yet' });
      return;
    }
    json(200, releasePayload());
    return;
  }
  if (request.url === `/${repository}/releases.atom`) {
    const advertisedTag = atomTransientOldTags > 0 ? 'v1.2.2' : atomTag;
    if (atomTransientOldTags > 0) atomTransientOldTags -= 1;
    response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
    response.end([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '  <entry>',
      `    <title>${advertisedTag}</title>`,
      `    <link href="${origin}/${repository}/releases/tag/${advertisedTag}"/>`,
      '  </entry>',
      '</feed>',
      '',
    ].join('\n'));
    return;
  }
  if (request.url === `/${repository}/releases/latest`) {
    const advertisedTag = webLatestTransientOldTags > 0 ? 'v1.2.2' : webLatestTag;
    if (webLatestTransientOldTags > 0) webLatestTransientOldTags -= 1;
    json(200, { tag_name: advertisedTag });
    return;
  }
  if (request.url === `/repos/${repository}/git/ref/tags/${tag}`) {
    json(200, { ref: `refs/tags/${tag}`, object: { type: 'tag', sha: tagObjectSha } });
    return;
  }
  if (request.url === `/repos/${repository}/git/tags/${tagObjectSha}`) {
    json(200, {
      tag,
      object: { type: 'commit', sha: commit },
      verification: { verified: true, reason: 'valid' },
    });
    return;
  }
  if (request.url?.startsWith('/download/')) {
    const name = decodeURIComponent(request.url.slice('/download/'.length));
    const data = assets.get(name);
    if (!data) {
      json(404, { message: 'missing asset' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': data.length,
    });
    response.end(data);
    return;
  }
  json(404, { message: 'unknown path' });
});

function runVerifier() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      verifier,
      '--repo', repository,
      '--tag', tag,
      '--commit', commit,
      '--api-base', origin,
      '--web-base', origin,
      '--attempts', '3',
      '--retry-delay-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        GH_TOKEN: 'must-not-be-used',
        GITHUB_TOKEN: 'must-not-be-used',
        IDACC_RELEASE_TOKEN: 'must-not-be-used',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

try {
  const accepted = await runVerifier();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Public release verified/);
  assert.ok(
    requests.filter((request) => request.url === `/repos/${repository}/releases/latest`).length >= 2,
    'the verifier must retry the public REST release that has not propagated yet',
  );
  assert.ok(
    requests.filter((request) => request.url === `/${repository}/releases.atom`).length >= 2,
    'the verifier must retry electron-updater releases.atom until the exact tag propagates',
  );
  assert.ok(
    requests.filter((request) => request.url === `/${repository}/releases/latest`).length >= 2,
    'the verifier must retry electron-updater web Latest until the exact tag propagates',
  );
  for (const [name] of nativeArtifacts) {
    assert.ok(
      requests.some((request) => request.url === `/download/${encodeURIComponent(name)}`),
      `the verifier must anonymously download and hash ${name}`,
    );
  }
  assert.equal(
    requests.every((request) => request.authorization === ''),
    true,
    'public completion verification must never send a maintainer credential',
  );

  requests.length = 0;
  releaseImmutable = false;
  latestTransient404s = 0;
  const mutable = await runVerifier();
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /has not locked it as immutable/);
  assert.equal(requests.every((request) => request.authorization === ''), true);

  releaseImmutable = true;
  for (const [name] of nativeArtifacts) {
    const data = assets.get(name);
    assert.ok(data);
    assets.delete(name);
    refreshChecksums();
    const missing = await runVerifier();
    assert.notEqual(missing.status, 0, `missing ${name} must fail`);
    assert.match(missing.stderr, /exact versioned consumer installer matrix differs/);
    assert.match(missing.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assets.set(name, data);
    refreshChecksums();
  }

  const validLinuxDescriptor = assets.get('latest-linux.yml');
  assets.set(
    'latest-linux.yml',
    updateYaml(
      ['ID-Agents-Control-Center-1.2.3-x86_64.AppImage'],
      'ID-Agents-Control-Center-1.2.3-x86_64.AppImage',
    ),
  );
  refreshChecksums();
  const missingDebUpdate = await runVerifier();
  assert.notEqual(missingDebUpdate.status, 0);
  assert.match(missingDebUpdate.stderr, /latest-linux\.yml exact updater file set differs/);
  assert.match(missingDebUpdate.stderr, /amd64\.deb/);
  assets.set('latest-linux.yml', validLinuxDescriptor);
  refreshChecksums();

  webLatestTag = 'v1.2.2';
  const wrongWebLatest = await runVerifier();
  assert.notEqual(wrongWebLatest.status, 0);
  assert.match(wrongWebLatest.stderr, /electron-updater web Latest is v1\.2\.2, expected v1\.2\.3/);
  webLatestTag = tag;

  atomTag = 'v1.2.2';
  const wrongAtom = await runVerifier();
  assert.notEqual(wrongAtom.status, 0);
  assert.match(wrongAtom.stderr, /releases\.atom does not yet contain/);
  atomTag = tag;
  assert.equal(requests.every((request) => request.authorization === ''), true);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

console.log('public release verifier smoke: ok');
