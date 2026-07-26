#!/usr/bin/env node
/**
 * Fail-closed verification of the public release consumers and electron-updater
 * will actually reach. Requests are deliberately unauthenticated: a release
 * that only works with a maintainer token is not a shipped consumer release.
 *
 * Usage:
 *   node scripts/verify-public-release.mjs \
 *     --repo owner/repository \
 *     --tag v1.2.3 \
 *     --commit 0123456789abcdef0123456789abcdef01234567
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/;
const SEMVER_TAG = /^v(\d+\.\d+\.\d+)$/;
const REQUIRED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
];
const REQUIRED_METADATA = [
  'SHA256SUMS',
  'release-index.json',
  'release-index.sha256',
  'latest-mac.yml',
  'latest.yml',
  'latest-linux.yml',
  'IDACC-provenance-darwin-arm64.tar.gz',
  'IDACC-provenance-darwin-x64.tar.gz',
  'IDACC-provenance-linux-x64.tar.gz',
  'IDACC-provenance-win32-x64.tar.gz',
];
const REQUIRED_INSTALLER_SUFFIXES = ['.dmg', '.zip', '.exe', '.AppImage', '.deb'];

function fail(message) {
  console.error(`public release verification failed: ${message}`);
  process.exit(1);
}

function option(name, fallback = '') {
  const positions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) positions.push(index);
  }
  if (positions.length > 1) fail(`${name} must be provided at most once`);
  if (!positions.length) return fallback;
  const value = args[positions[0] + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

const knownOptions = new Set([
  '--repo',
  '--tag',
  '--commit',
  '--api-base',
  '--web-base',
  '--attempts',
  '--retry-delay-ms',
]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (!arg.startsWith('--') || !knownOptions.has(arg)) fail(`unknown argument: ${arg}`);
  index += 1;
}

const repository = option('--repo');
const tag = option('--tag');
const expectedCommit = option('--commit');
const apiBase = option('--api-base', 'https://api.github.com').replace(/\/$/, '');
const webBase = option('--web-base', 'https://github.com').replace(/\/$/, '');
const attempts = Number(option('--attempts', '12'));
const retryDelayMs = Number(option('--retry-delay-ms', '2000'));
const repositoryMatch = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repository);
const tagMatch = SEMVER_TAG.exec(tag);

if (!repositoryMatch || repositoryMatch[2].startsWith('.') || repositoryMatch[2].endsWith('.')) {
  fail('--repo must be an exact GitHub owner/repository pair');
}
if (!tagMatch) fail('--tag must be vX.Y.Z');
if (!HEX_40.test(expectedCommit)) fail('--commit must be a full lowercase Git commit');
if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
  fail('--attempts must be an integer from 1 through 30');
}
if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
  fail('--retry-delay-ms must be an integer from 0 through 30000');
}
function absoluteHttpUrl(value, optionName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${optionName} must be an absolute HTTP(S) URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail(`${optionName} must be an absolute HTTP(S) URL without credentials, query, or fragment`);
  }
  return parsed;
}

const parsedApiBase = absoluteHttpUrl(apiBase, '--api-base');
const parsedWebBase = absoluteHttpUrl(webBase, '--web-base');
const version = tagMatch[1];
const officialGitHubApi = parsedApiBase.origin === 'https://api.github.com';
const expectedInstallers = [
  `ID-Agents-Control-Center-${version}-arm64.dmg`,
  `ID-Agents-Control-Center-${version}-x64.dmg`,
  `ID-Agents-Control-Center-${version}-arm64.zip`,
  `ID-Agents-Control-Center-${version}-x64.zip`,
  `ID-Agents-Control-Center-${version}-x64.exe`,
  `ID-Agents-Control-Center-${version}-x64.AppImage`,
  `ID-Agents-Control-Center-${version}-x64.deb`,
];
const expectedUpdaterPayloads = expectedInstallers.filter((name) => !name.endsWith('.dmg'));
const requestHeaders = Object.freeze({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'idacc-public-release-verifier',
  'X-GitHub-Api-Version': '2026-03-10',
});

function expect(condition, message) {
  if (!condition) fail(message);
}

function safeName(value, label) {
  const name = String(value || '');
  if (basename(name) !== name || !SAFE_NAME.test(name)) {
    fail(`${label} must be a safe release-asset basename`);
  }
  return name;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalSha512(value, label) {
  const digest = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) fail(`${label} has an invalid SHA-512`);
  const decoded = Buffer.from(digest, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== digest) {
    fail(`${label} must use a canonical 64-byte SHA-512`);
  }
  return digest;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(30_000, retryAfter * 1000);
  }
  return Math.min(30_000, retryDelayMs * (2 ** Math.min(attempt - 1, 4)));
}

function retryableStatus(status) {
  return status === 404
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
}

async function publicFetch(url, label, { timeoutMs = 120_000, headers = {} } = {}) {
  let lastReason = 'request did not run';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { ...requestHeaders, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastReason = error.message;
      if (attempt === attempts) break;
      await wait(retryDelay(null, attempt));
      continue;
    }
    if (response.ok) return response;
    lastReason = `HTTP ${response.status}`;
    const canRetry = retryableStatus(response.status)
      || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    await response.body?.cancel().catch(() => {});
    if (!canRetry || attempt === attempts) break;
    await wait(retryDelay(response, attempt));
  }
  fail(`${label} was not publicly available after ${attempts} attempt(s): ${lastReason}`);
}

async function publicJsonUrl(url, label, fetchOptions = {}) {
  const response = await publicFetch(url, label, fetchOptions);
  let value;
  try {
    value = await response.json();
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} returned an unexpected JSON value`);
  }
  return value;
}

async function publicJson(path, label) {
  return publicJsonUrl(`${apiBase}${path}`, label);
}

async function publicJsonUrlEventually(url, label, ready, fetchOptions = {}) {
  let lastReason = 'public state was not ready';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await publicJsonUrl(url, label, fetchOptions);
    lastReason = ready(value);
    if (!lastReason) return value;
    if (attempt < attempts) await wait(retryDelay(null, attempt));
  }
  fail(`${label} did not reach its required public state after ${attempts} attempt(s): ${lastReason}`);
}

async function publicJsonEventually(path, label, ready) {
  return publicJsonUrlEventually(`${apiBase}${path}`, label, ready);
}

async function publicTextEventually(url, label, ready, fetchOptions = {}) {
  let lastReason = 'public state was not ready';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await publicFetch(url, label, fetchOptions);
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > 5 * 1024 * 1024) {
      fail(`${label} exceeds the 5 MiB discovery-document limit`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) {
      fail(`${label} exceeds the 5 MiB discovery-document limit`);
    }
    lastReason = ready(text, response);
    if (!lastReason) return text;
    if (attempt < attempts) await wait(retryDelay(null, attempt));
  }
  fail(`${label} did not reach its required public state after ${attempts} attempt(s): ${lastReason}`);
}

function assertPublicAssetUrl(asset) {
  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    fail(`${asset.name} has an invalid browser_download_url`);
  }
  if (officialGitHubApi) {
    expect(url.protocol === 'https:' && url.hostname === 'github.com', `${asset.name} is not a public github.com download`);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      fail(`${asset.name} has a malformed public download path`);
    }
    expect(
      decodedPath === `/${repository}/releases/download/${tag}/${asset.name}`,
      `${asset.name} public download is not bound to ${repository}@${tag}`,
    );
  } else {
    expect(['http:', 'https:'].includes(url.protocol), `${asset.name} test download URL must use HTTP(S)`);
  }
}

async function downloadBuffer(asset, checksum, label, maxBytes = 20 * 1024 * 1024) {
  const response = await publicFetch(asset.browser_download_url, label);
  const chunks = [];
  let size = 0;
  const digest = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) fail(`${label} exceeds the ${maxBytes}-byte metadata limit`);
      digest.update(bytes);
      chunks.push(bytes);
    }
  } catch (error) {
    fail(`${label} public download failed: ${error.message}`);
  }
  expect(size === asset.size, `${label} public size ${size} does not match GitHub asset size ${asset.size}`);
  const actual = digest.digest('hex');
  expect(actual === asset.digest.slice('sha256:'.length), `${label} public bytes do not match GitHub's SHA-256 digest`);
  if (checksum) expect(actual === checksum, `${label} public bytes do not match SHA256SUMS`);
  return Buffer.concat(chunks);
}

async function downloadConsumerInstaller(asset, expectedSha256, expectedSha512 = '') {
  const response = await publicFetch(
    asset.browser_download_url,
    `${asset.name} consumer installer`,
    { timeoutMs: 15 * 60_000 },
  );
  const sha256Hash = createHash('sha256');
  const sha512Hash = createHash('sha512');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      sha256Hash.update(bytes);
      sha512Hash.update(bytes);
    }
  } catch (error) {
    fail(`${asset.name} consumer download failed: ${error.message}`);
  }
  expect(size === asset.size, `${asset.name} public installer size ${size} does not match GitHub asset size ${asset.size}`);
  expect(sha256Hash.digest('hex') === expectedSha256, `${asset.name} public installer does not match SHA256SUMS`);
  const actualSha512 = sha512Hash.digest('base64');
  if (expectedSha512) {
    expect(actualSha512 === expectedSha512, `${asset.name} public installer does not match its update descriptor SHA-512`);
  }
}

function decodeXmlAttribute(value, label) {
  const unknownEntity = /&(?!(?:amp|quot|apos|lt|gt);)/.exec(value);
  if (unknownEntity) fail(`${label} contains an unsupported XML entity`);
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function atomFeedHasTag(feed, expectedUrl) {
  const entries = feed.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  for (const entry of entries) {
    const links = entry.matchAll(/<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi);
    for (const link of links) {
      const href = decodeXmlAttribute(link[2], 'GitHub releases.atom link');
      let parsed;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }
      if (parsed.href === expectedUrl.href) return true;
    }
  }
  return false;
}

function parseChecksums(bytes) {
  const text = bytes.toString('utf8');
  expect(text.endsWith('\n'), 'SHA256SUMS must end with a newline');
  const checksums = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) fail('SHA256SUMS contains an invalid line');
    const name = safeName(match[2], `SHA256SUMS entry ${match[2]}`);
    expect(name !== 'SHA256SUMS', 'SHA256SUMS must not recursively list itself');
    expect(!checksums.has(name), `SHA256SUMS contains duplicate entry ${name}`);
    checksums.set(name, match[1]);
  }
  expect(checksums.size > 0, 'SHA256SUMS must not be empty');
  return checksums;
}

function parseYamlScalar(raw, label) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      fail(`${label} contains an invalid quoted YAML scalar`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) fail(`${label} contains an invalid quoted YAML scalar`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseUpdateYaml(bytes, label) {
  const document = { files: [] };
  let inFiles = false;
  let currentFile = null;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line === 'files:') {
      inFiles = true;
      currentFile = null;
      continue;
    }
    const fileStart = /^  - ([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (fileStart && inFiles) {
      currentFile = {
        [fileStart[1]]: parseYamlScalar(fileStart[2], `${label} line ${index + 1}`),
      };
      document.files.push(currentFile);
      continue;
    }
    const fileField = /^    ([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (fileField && inFiles && currentFile) {
      currentFile[fileField[1]] = parseYamlScalar(fileField[2], `${label} line ${index + 1}`);
      continue;
    }
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (topLevel) {
      inFiles = false;
      currentFile = null;
      document[topLevel[1]] = parseYamlScalar(topLevel[2], `${label} line ${index + 1}`);
      continue;
    }
    fail(`${label} contains unsupported YAML at line ${index + 1}`);
  }
  return document;
}

function sameNames(expected, actual, label) {
  const left = [...expected].sort((a, b) => a.localeCompare(b));
  const right = [...actual].sort((a, b) => a.localeCompare(b));
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) {
    const missing = left.filter((name) => !right.includes(name));
    const extra = right.filter((name) => !left.includes(name));
    fail(`${label} differs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

const release = await publicJsonEventually(
  `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  `${tag} release`,
  (candidate) => {
    if (candidate.tag_name !== tag) return `release tag is ${candidate.tag_name || 'missing'}, expected ${tag}`;
    if (candidate.draft !== false) return `${tag} is still a draft`;
    if (candidate.prerelease !== false) return `${tag} is unexpectedly a prerelease`;
    if (candidate.immutable !== true) return `${tag} is published but GitHub has not locked it as immutable`;
    if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0) return `${tag} has an invalid release ID`;
    if (!Array.isArray(candidate.assets)) return `${tag} assets are missing`;
    if (candidate.assets.some((asset) => asset?.state !== 'uploaded' || !/^sha256:[0-9a-f]{64}$/.test(String(asset?.digest || '')))) {
      return `${tag} asset digests have not finished publishing`;
    }
    return '';
  },
);
expect(release.tag_name === tag, `release tag is ${release.tag_name || 'missing'}, expected ${tag}`);
expect(release.draft === false, `${tag} is still a draft`);
expect(release.prerelease === false, `${tag} is unexpectedly a prerelease`);
expect(release.immutable === true, `${tag} is published but GitHub has not locked it as immutable`);
expect(Number.isSafeInteger(release.id) && release.id > 0, `${tag} has an invalid release ID`);
expect(Array.isArray(release.assets), `${tag} assets are missing`);

const atomUrl = new URL(`${repository}/releases.atom`, `${webBase}/`);
const updaterLatestUrl = new URL(`${repository}/releases/latest`, `${webBase}/`);
const expectedAtomTagUrl = new URL(`${repository}/releases/tag/${tag}`, `${webBase}/`);
const atomFeed = await publicTextEventually(
  atomUrl,
  'electron-updater GitHub releases.atom feed',
  (candidate, response) => {
    if (!/\bxml\b/i.test(response.headers.get('content-type') || '')) {
      return `releases.atom content type is ${response.headers.get('content-type') || 'missing'}, expected XML`;
    }
    return atomFeedHasTag(candidate, expectedAtomTagUrl)
      ? ''
      : `releases.atom does not yet contain ${expectedAtomTagUrl.href}`;
  },
  { headers: { Accept: 'application/xml, application/atom+xml, text/xml, */*' } },
);
expect(
  atomFeedHasTag(atomFeed, expectedAtomTagUrl),
  `electron-updater releases.atom does not contain ${expectedAtomTagUrl.href}`,
);
const updaterLatest = await publicJsonUrlEventually(
  updaterLatestUrl,
  'electron-updater GitHub /releases/latest discovery',
  (candidate) => (
    candidate.tag_name === tag
      ? ''
      : `electron-updater web Latest is ${candidate.tag_name || 'missing'}, expected ${tag}`
  ),
  { headers: { Accept: 'application/json' } },
);
expect(
  updaterLatest.tag_name === tag,
  `electron-updater web Latest is ${updaterLatest.tag_name || 'missing'}, expected ${tag}`,
);

const latest = await publicJsonEventually(
  `/repos/${repository}/releases/latest`,
  'GitHub Latest release',
  (candidate) => (
    candidate.id === release.id
      && candidate.tag_name === tag
      && candidate.draft === false
      && candidate.prerelease === false
      && candidate.immutable === true
      ? ''
      : `GitHub Latest is ${candidate.tag_name || 'missing'}, expected public immutable ${tag}`
  ),
);
expect(latest.id === release.id && latest.tag_name === tag, `GitHub Latest is ${latest.tag_name || 'missing'}, expected ${tag}`);
expect(latest.draft === false && latest.prerelease === false && latest.immutable === true, 'GitHub Latest is not a public immutable production release');

const tagRef = await publicJson(
  `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  `${tag} Git ref`,
);
expect(tagRef.object?.type === 'tag' && HEX_40.test(String(tagRef.object?.sha || '')), `${tag} is not an annotated Git tag object`);
const tagObject = await publicJson(
  `/repos/${repository}/git/tags/${tagRef.object.sha}`,
  `${tag} annotated tag`,
);
expect(tagObject.tag === tag, `annotated tag object names ${tagObject.tag || 'missing'}, expected ${tag}`);
expect(tagObject.object?.type === 'commit', `${tag} does not directly target a commit`);
expect(tagObject.object?.sha === expectedCommit, `${tag} targets ${tagObject.object?.sha || 'missing'}, expected ${expectedCommit}`);
expect(tagObject.verification?.verified === true, `${tag} signature is not GitHub-verified`);
expect(tagObject.verification?.reason === 'valid', `${tag} signature verification reason is not valid`);

const assets = new Map();
for (const rawAsset of release.assets) {
  const name = safeName(rawAsset?.name, `release asset ${rawAsset?.name || '(missing)'}`);
  expect(!assets.has(name), `${tag} has duplicate asset ${name}`);
  expect(rawAsset.state === 'uploaded', `${name} is not fully uploaded`);
  expect(Number.isSafeInteger(rawAsset.size) && rawAsset.size > 0, `${name} has an invalid size`);
  expect(/^sha256:[0-9a-f]{64}$/.test(String(rawAsset.digest || '')), `${name} is missing GitHub's SHA-256 digest`);
  assertPublicAssetUrl(rawAsset);
  assets.set(name, rawAsset);
}
expect(assets.size > 0, `${tag} has no public assets`);
for (const name of REQUIRED_METADATA) expect(assets.has(name), `${tag} is missing ${name}`);
sameNames(
  expectedInstallers,
  [...assets.keys()].filter((name) => REQUIRED_INSTALLER_SUFFIXES.some((suffix) => name.endsWith(suffix))),
  `${tag} exact versioned consumer installer matrix`,
);

const checksumAsset = assets.get('SHA256SUMS');
const checksumBytes = await downloadBuffer(checksumAsset, '', 'SHA256SUMS');
const checksums = parseChecksums(checksumBytes);
sameNames(
  [...checksums.keys(), 'SHA256SUMS'],
  assets.keys(),
  `${tag} release asset set versus SHA256SUMS`,
);
for (const [name, checksum] of checksums) {
  const asset = assets.get(name);
  expect(asset.digest === `sha256:${checksum}`, `${name} GitHub digest does not match SHA256SUMS`);
}

const indexAsset = assets.get('release-index.json');
const indexBytes = await downloadBuffer(
  indexAsset,
  checksums.get('release-index.json'),
  'release-index.json',
);
const indexChecksumAsset = assets.get('release-index.sha256');
const indexChecksumBytes = await downloadBuffer(
  indexChecksumAsset,
  checksums.get('release-index.sha256'),
  'release-index.sha256',
);
const indexChecksumMatch = /^([0-9a-f]{64}) {2}release-index\.json\n?$/.exec(indexChecksumBytes.toString('utf8'));
expect(Boolean(indexChecksumMatch), 'release-index.sha256 must contain one canonical release-index.json checksum');
expect(indexChecksumMatch[1] === sha256(indexBytes), 'release-index.sha256 does not match release-index.json');
let releaseIndex;
try {
  releaseIndex = JSON.parse(indexBytes.toString('utf8'));
} catch (error) {
  fail(`release-index.json is invalid JSON: ${error.message}`);
}
expect(releaseIndex.schemaVersion === 1, 'release-index.json schemaVersion must be 1');
expect(releaseIndex.application?.version === version, `release index version is ${releaseIndex.application?.version || 'missing'}, expected ${version}`);
expect(releaseIndex.application?.commit === expectedCommit, `release index commit is ${releaseIndex.application?.commit || 'missing'}, expected ${expectedCommit}`);
expect(Array.isArray(releaseIndex.releases), 'release index releases must be an array');
sameNames(REQUIRED_TARGETS, releaseIndex.releases.map((entry) => entry?.target), 'release index target set');
expect(Array.isArray(releaseIndex.artifacts) && releaseIndex.artifacts.length > 0, 'release index artifacts must be non-empty');
const indexedNames = new Set();
for (const indexed of releaseIndex.artifacts) {
  const name = safeName(indexed?.name, `release-index artifact ${indexed?.name || '(missing)'}`);
  expect(!indexedNames.has(name), `release index contains duplicate artifact ${name}`);
  indexedNames.add(name);
  expect(assets.has(name), `release-index artifact ${name} is not a release asset`);
  expect(indexed.sha256 === checksums.get(name), `release-index SHA-256 does not match SHA256SUMS for ${name}`);
  expect(indexed.size === assets.get(name).size, `release-index size does not match GitHub for ${name}`);
}
for (const name of expectedInstallers) {
  expect(indexedNames.has(name), `release index is missing consumer installer ${name}`);
}

const updaterReferences = new Map();
for (const descriptorName of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
  const descriptorAsset = assets.get(descriptorName);
  const descriptorBytes = await downloadBuffer(
    descriptorAsset,
    checksums.get(descriptorName),
    descriptorName,
  );
  const descriptor = parseUpdateYaml(descriptorBytes, descriptorName);
  expect(descriptor.version === version, `${descriptorName} version is ${descriptor.version || 'missing'}, expected ${version}`);
  expect(Array.isArray(descriptor.files) && descriptor.files.length > 0, `${descriptorName} has no updater files`);
  const descriptorFiles = new Map();
  for (const rawFile of descriptor.files) {
    const name = safeName(rawFile?.url, `${descriptorName} file ${rawFile?.url || '(missing)'}`);
    expect(!descriptorFiles.has(name), `${descriptorName} contains duplicate file ${name}`);
    const digest = canonicalSha512(rawFile.sha512, `${descriptorName} ${name}`);
    const size = Number(rawFile.size);
    expect(Number.isSafeInteger(size) && size > 0, `${descriptorName} ${name} has an invalid size`);
    if (name.endsWith('.AppImage')) {
      const blockMapSize = Number(rawFile.blockMapSize);
      expect(
        Number.isSafeInteger(blockMapSize) && blockMapSize > 0 && blockMapSize < size - 4,
        `${descriptorName} ${name} has an invalid embedded blockMapSize`,
      );
    } else {
      expect(rawFile.blockMapSize == null, `${descriptorName} ${name} must not claim an embedded block map`);
    }
    expect(assets.has(name), `${descriptorName} references missing public asset ${name}`);
    expect(assets.get(name).size === size, `${descriptorName} size does not match GitHub for ${name}`);
    expect(checksums.has(name), `${descriptorName} ${name} is missing from SHA256SUMS`);
    const previous = updaterReferences.get(name);
    if (previous) {
      expect(previous.sha512 === digest && previous.size === size, `update descriptors conflict for ${name}`);
    } else {
      updaterReferences.set(name, { sha512: digest, size });
    }
    descriptorFiles.set(name, { sha512: digest, size });
  }
  const primaryName = safeName(descriptor.path, `${descriptorName} path`);
  expect(descriptorFiles.has(primaryName), `${descriptorName} path does not select one of its file records`);
  expect(
    canonicalSha512(descriptor.sha512, `${descriptorName} primary`) === descriptorFiles.get(primaryName).sha512,
    `${descriptorName} path and SHA-512 select different records`,
  );

  const names = [...descriptorFiles.keys()];
  const descriptorExpectation = descriptorName === 'latest-mac.yml'
    ? {
        files: [
          `ID-Agents-Control-Center-${version}-arm64.zip`,
          `ID-Agents-Control-Center-${version}-x64.zip`,
        ],
        primary: `ID-Agents-Control-Center-${version}-x64.zip`,
      }
    : descriptorName === 'latest.yml'
      ? {
          files: [`ID-Agents-Control-Center-${version}-x64.exe`],
          primary: `ID-Agents-Control-Center-${version}-x64.exe`,
        }
      : {
          files: [
            `ID-Agents-Control-Center-${version}-x64.AppImage`,
            `ID-Agents-Control-Center-${version}-x64.deb`,
          ],
          primary: `ID-Agents-Control-Center-${version}-x64.AppImage`,
        };
  sameNames(descriptorExpectation.files, names, `${descriptorName} exact updater file set`);
  expect(
    primaryName === descriptorExpectation.primary,
    `${descriptorName} primary path is ${primaryName}, expected ${descriptorExpectation.primary}`,
  );
}

sameNames(
  expectedUpdaterPayloads,
  updaterReferences.keys(),
  'electron-updater consumer payload set',
);
for (const name of expectedInstallers) {
  await downloadConsumerInstaller(
    assets.get(name),
    checksums.get(name),
    updaterReferences.get(name)?.sha512 || '',
  );
}

console.log(
  `Public release verified: ${repository}@${tag} is Latest, immutable, GitHub-signed at ${expectedCommit}, with ${assets.size} exact asset(s) and ${updaterReferences.size} downloadable updater payload(s).`,
);
