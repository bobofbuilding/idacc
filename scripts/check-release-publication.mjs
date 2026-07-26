#!/usr/bin/env node
/**
 * Stops release version drift: every pushed vX.Y.Z tag must have a published
 * GitHub Release. It is deliberately independent of the workflow dispatcher
 * so it can detect interrupted or publish=false production runs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateLegacyReleaseCutover,
  readLegacyReleaseCutover,
} from './lib/legacy-release-cutover.mjs';
import {
  compareTags,
  SEMVER_TAG,
  unpublishedFrontierTags,
} from './lib/release-publication.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cutoverPath = join(root, 'release', 'legacy-release-cutover.json');
const args = process.argv.slice(2);
const allowTags = [];
let requireTag = '';
let jsonOutput = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--allow-tag') {
    const tag = args[++index];
    if (!SEMVER_TAG.test(tag || '')) fail(`--allow-tag requires a semver tag, got ${tag || '(missing)'}`);
    allowTags.push(tag);
  } else if (arg === '--require-tag') {
    const tag = args[++index];
    if (!SEMVER_TAG.test(tag || '')) fail(`--require-tag requires a semver tag, got ${tag || '(missing)'}`);
    requireTag = tag;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--help') {
    console.log('usage: node scripts/check-release-publication.mjs [--allow-tag vX.Y.Z] [--require-tag vX.Y.Z] [--json]');
    process.exit(0);
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

function fail(message) {
  console.error(`release publication check failed: ${message}`);
  process.exit(1);
}

function git(argsForGit) {
  const result = spawnSync('git', argsForGit, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr.trim() || `git ${argsForGit.join(' ')} failed`);
  return result.stdout.trim();
}

function repository() {
  if (process.env.IDACC_RELEASE_REPOSITORY) return process.env.IDACC_RELEASE_REPOSITORY;
  const origin = git(['remote', 'get-url', 'origin']);
  const match = origin.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (!match) fail(`cannot determine GitHub repository from origin ${origin}; set IDACC_RELEASE_REPOSITORY=owner/repo`);
  return match[1];
}

function githubApi() {
  const base = (process.env.IDACC_RELEASE_API_BASE || 'https://api.github.com').replace(/\/$/, '');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'idacc-release-publication-check' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.IDACC_RELEASE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return { base, headers };
}

async function githubRelease(repo, path, { allowNotFound = false } = {}) {
  const { base, headers } = githubApi();
  let response;
  try {
    response = await fetch(`${base}/repos/${repo}/releases${path}`, { headers });
  } catch (error) {
    fail(`could not query GitHub releases for ${repo}: ${error.message}`);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const tokenHint = response.status === 403 ? '; GitHub denied or rate-limited the request—set GH_TOKEN and retry' : '';
    fail(`GitHub releases query for ${repo} returned HTTP ${response.status}${tokenHint}`);
  }
  const release = await response.json();
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    fail(`GitHub releases query for ${repo} returned an unexpected payload`);
  }
  return release;
}

async function latestReleaseFor(repo) {
  const release = await githubRelease(repo, '/latest', { allowNotFound: true });
  return release ? [release] : [];
}

async function githubReleases(repo) {
  const { base, headers } = githubApi();
  const releases = [];
  for (let page = 1; page <= 100; page += 1) {
    let response;
    try {
      response = await fetch(
        `${base}/repos/${repo}/releases?per_page=100&page=${page}`,
        { headers },
      );
    } catch (error) {
      fail(`could not query GitHub release inventory for ${repo}: ${error.message}`);
    }
    if (!response.ok) {
      const tokenHint = response.status === 403
        ? '; GitHub denied or rate-limited the request—set GH_TOKEN and retry'
        : '';
      fail(`GitHub release inventory for ${repo} returned HTTP ${response.status}${tokenHint}`);
    }
    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) {
      fail(`GitHub release inventory for ${repo} returned an unexpected payload`);
    }
    releases.push(...pageReleases);
    if (pageReleases.length < 100) return releases;
  }
  fail(`GitHub release inventory for ${repo} exceeded the 10,000-release safety bound`);
}

async function githubCanonicalTagVerification(repo, tag) {
  const { base, headers } = githubApi();
  async function githubGitObject(path, description) {
    let response;
    try {
      response = await fetch(`${base}/repos/${repo}${path}`, { headers });
    } catch (error) {
      fail(`could not query GitHub ${description} for ${repo}: ${error.message}`);
    }
    if (!response.ok) {
      const tokenHint = response.status === 403
        ? '; GitHub denied or rate-limited the request—set GH_TOKEN and retry'
        : '';
      fail(`GitHub ${description} query for ${repo} returned HTTP ${response.status}${tokenHint}`);
    }
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`GitHub ${description} query for ${repo} returned an unexpected payload`);
    }
    return value;
  }

  const ref = await githubGitObject(
    `/git/ref/tags/${encodeURIComponent(tag)}`,
    `tag ref ${tag}`,
  );
  const objectType = ref.object?.type;
  const objectId = ref.object?.sha;
  if (objectType !== 'tag') {
    return {
      tag,
      objectId,
      objectType,
    };
  }
  const tagObject = await githubGitObject(
    `/git/tags/${encodeURIComponent(objectId)}`,
    `annotated tag object ${tag}`,
  );
  return {
    tag,
    objectId,
    objectType,
    annotatedTagName: tagObject.tag,
    targetObjectType: tagObject.object?.type,
    targetCommit: tagObject.object?.sha,
    verified: tagObject.verification?.verified,
    verificationReason: tagObject.verification?.reason,
  };
}

function remoteTagRefs() {
  const refs = new Map();
  const peeled = new Map();
  const output = git(['ls-remote', '--tags', 'origin']);
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]+)\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (!match) continue;
    const [, objectId, tag, peeledSuffix] = match;
    if (peeledSuffix) peeled.set(tag, objectId);
    else refs.set(tag, objectId);
  }
  return [...refs].map(([tag, objectId]) => {
    const targetCommit = peeled.get(tag);
    if (!targetCommit) {
      return {
        tag,
        objectId,
        objectType: 'commit',
        targetCommit: objectId,
      };
    }
    const tagObject = git(['cat-file', '-p', objectId]);
    const signatureState = /-----BEGIN [^-]+-----/.test(tagObject)
      ? 'signed'
      : 'unsigned';
    return {
      tag,
      objectId,
      objectType: 'tag',
      targetCommit,
      signatureState,
    };
  });
}

// A release checkout may be shallow or long-lived. Fetch tag objects, then
// compare against origin's current refs so a deleted or rewritten legacy tag
// cannot be hidden by a stale local checkout.
git(['fetch', '--quiet', 'origin', '--tags']);
const tagRefs = remoteTagRefs();
const tags = tagRefs.map((entry) => entry.tag);
if (requireTag && !tags.includes(requireTag)) fail(`${requireTag} does not exist on origin`);
const repo = repository();
const latestRelease = await latestReleaseFor(repo);
const releaseInventory = await githubReleases(repo);
const stablePublishedRelease = (release) => Boolean(
  release
  && release.draft === false
  && release.prerelease === false,
);
const latestPublished = latestRelease.find(stablePublishedRelease);
const latestPublishedTag = latestPublished?.tag_name;
if (latestPublishedTag && !tags.includes(latestPublishedTag)) {
  fail(`GitHub latest ${latestPublishedTag} does not exist on origin`);
}
let cutover;
let marker;
const releasesByTag = new Map();
for (const release of releaseInventory) {
  const tag = release?.tag_name;
  if (typeof tag !== 'string' || !tag) continue;
  if (releasesByTag.has(tag)) {
    fail(`GitHub release inventory contains duplicate tag ${tag}`);
  }
  releasesByTag.set(tag, release);
}
async function releaseForTag(tag) {
  return releasesByTag.get(tag) || null;
}
try {
  marker = readLegacyReleaseCutover(cutoverPath);
  const canonicalTagVerification = (
    SEMVER_TAG.test(latestPublishedTag || '')
    && compareTags(latestPublishedTag, marker.firstCanonicalVersionMustExceed) > 0
  )
    ? await githubCanonicalTagVerification(repo, latestPublishedTag)
    : null;
  const releaseRecords = await Promise.all(marker.legacyTags.map(async ({ tag }) => ({
    tag,
    release: await releaseForTag(tag),
  })));
  cutover = evaluateLegacyReleaseCutover(marker, {
    repository: repo,
    latestPublishedTag,
    tagRefs,
    releaseRecords,
    canonicalTagVerification,
  });
} catch (error) {
  fail(error.message);
}

const effectiveAllowTags = [...new Set([...cutover.allowTags, ...allowTags])];
const candidates = unpublishedFrontierTags(tags, latestRelease, { allowTags: effectiveAllowTags });

const missing = [];
if (latestRelease.length) {
  for (const tag of candidates) {
    const release = await releaseForTag(tag);
    if (!stablePublishedRelease(release)) missing.push(tag);
  }
} else {
  missing.push(...candidates);
}

if (requireTag && !stablePublishedRelease(await releaseForTag(requireTag))) {
  fail(`${requireTag} has no published GitHub Release`);
}
if (missing.length) {
  fail(`pushed version tag(s) without a published GitHub Release: ${missing.join(', ')}. Repair the oldest gap with scripts/release.sh --resume <version> before cutting another version.`);
}

const state = {
  repository: repo,
  latestPublishedTag,
  changelogBaselineTag: cutover.changelogBaselineTag,
  firstCanonicalVersionMustExceed: cutover.firstCanonicalVersionMustExceed,
  semverTagCount: tags.filter((tag) => SEMVER_TAG.test(tag)).length,
  cutover: {
    active: cutover.active,
    baselinePublishedTag: cutover.baselinePublishedTag,
    legacyTagCount: cutover.legacyTagCount,
    publishedReleaseCount: cutover.publishedReleaseCount,
    absentReleaseCount: cutover.absentReleaseCount,
  },
};
if (jsonOutput) {
  console.log(JSON.stringify(state));
} else {
  if (cutover.active) {
    console.log(`✓ audited legacy cutover allows ${cutover.legacyTagCount} exact historical ref(s) after ${cutover.baselinePublishedTag}`);
  }
  console.log(`✓ legacy release state verified: ${cutover.publishedReleaseCount} published, ${cutover.absentReleaseCount} absent`);
  console.log(`✓ release publication parity verified for ${state.semverTagCount} semver tag(s); changelog baseline ${state.changelogBaselineTag}`);
}
