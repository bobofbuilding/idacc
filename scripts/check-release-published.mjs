#!/usr/bin/env node
/**
 * Release publish guard: a tag pushed to origin (and the CHANGELOG/commit that name it)
 * is a promise, not a release. scripts/release.sh pushes the tag (step 3) before it builds
 * and publishes the GitHub release (steps 4-5); if either of those later steps fails or is
 * skipped, the tag/commit/CHANGELOG can all agree on a version that has no matching GitHub
 * release (this is what happened to v0.1.637). This script checks the GitHub API for a
 * non-draft release matching a tag, so that gap can be caught automatically instead of
 * discovered later by hand.
 *
 *   node scripts/check-release-published.mjs <version-or-tag> [--repo owner/repo]
 *
 * Exit codes: 0 published, 1 missing/draft, 2 usage error.
 * GITHUB_API_BASE can override the API root (used by the smoke test to point at a local mock).
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseOwnerRepo(remoteUrl) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl || '');
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function normalizeTag(versionOrTag) {
  const v = String(versionOrTag || '').trim();
  return v.startsWith('v') ? v : `v${v}`;
}

/** @returns {Promise<{published: boolean, reason: string}>} */
export async function checkReleasePublished(ownerRepo, tag, {
  fetchImpl = fetch,
  apiBase = 'https://api.github.com',
  token = '',
} = {}) {
  const url = `${apiBase}/repos/${ownerRepo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'idacc-release-published-check',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers });
  if (res.status === 404) {
    return { published: false, reason: `no GitHub release found for ${tag} (${ownerRepo})` };
  }
  if (!res.ok) {
    return { published: false, reason: `GitHub API returned ${res.status} checking ${tag} (${ownerRepo})` };
  }
  const body = await res.json();
  if (body.draft) {
    return { published: false, reason: `${tag} has only a draft release (${ownerRepo}); it was never published` };
  }
  return { published: true, reason: `${tag} has a published GitHub release (${ownerRepo})` };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const repoFlagIndex = args.indexOf('--repo');
  const explicitRepo = repoFlagIndex >= 0 ? args[repoFlagIndex + 1] : '';

  if (!positional.length) {
    console.error('usage: scripts/check-release-published.mjs <version-or-tag> [--repo owner/repo]');
    process.exit(2);
  }

  const tag = normalizeTag(positional[0]);
  let ownerRepo = explicitRepo;
  if (!ownerRepo) {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    ownerRepo = parseOwnerRepo(remoteUrl);
  }
  if (!ownerRepo) {
    console.error('could not determine owner/repo; pass --repo owner/repo');
    process.exit(2);
  }

  const apiBase = process.env.GITHUB_API_BASE || 'https://api.github.com';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.IDACC_RELEASE_TOKEN || '';
  let result;
  try {
    result = await checkReleasePublished(ownerRepo, tag, { apiBase, token });
  } catch (err) {
    console.error(`release publish check failed: could not reach GitHub API (${err.message})`);
    process.exit(1);
  }

  if (!result.published) {
    console.error(`release publish check failed: ${result.reason}`);
    process.exit(1);
  }
  console.log(`✓ ${result.reason}`);
  // fetch's keep-alive socket can otherwise hold the event loop open past a clean exit.
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
