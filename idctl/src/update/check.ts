/**
 * Update check. Steady-state cost is zero GitHub-API usage: a cheap
 * github.com/.../releases/latest redirect poll reads the tag from the Location
 * header (not api.github.com, so no 60/hr primary-limit charge); api.github.com
 * is only hit (ETag-conditional) when a newer tag actually exists. A self-hosted
 * version.json manifest is supported as a fallback. A cooldown (check.json)
 * keeps polling infrequent.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { checkCacheFile, updateStateDir } from './paths.ts';
import { detectPlatform, isCompiledBinary } from './platform.ts';
import { isNewer } from './version.ts';
import { IDCTL_VERSION } from '../version.ts';
import { DEFAULT_UPDATE_REPO } from '../settings/schema.ts';
import type { CheckResult, UpdateInfo } from './types.ts';

const UA = `idctl/${IDCTL_VERSION}`;

interface CheckCache {
  etag?: string;
  lastCheck?: number;
  lastTag?: string;
}

function readCache(): CheckCache {
  try {
    return JSON.parse(readFileSync(checkCacheFile(), 'utf8')) as CheckCache;
  } catch {
    return {};
  }
}
function writeCache(c: CheckCache): void {
  try {
    mkdirSync(updateStateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(checkCacheFile(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
}

export interface CheckOpts {
  repo?: string;
  manifestUrl?: string;
  intervalHours: number;
  force?: boolean;
}

export async function checkForUpdate(opts: CheckOpts): Promise<CheckResult> {
  const now = Date.now();
  if (!isCompiledBinary()) return { status: 'skipped', reason: 'dev-mode', checkedAt: now };

  const cache = readCache();
  if (!opts.force && cache.lastCheck && now - cache.lastCheck < opts.intervalHours * 3600_000) {
    return { status: 'skipped', reason: 'cooldown', checkedAt: cache.lastCheck };
  }

  try {
    const info = opts.manifestUrl
      ? await checkManifest(opts.manifestUrl, cache)
      : await checkGitHub(opts.repo ?? DEFAULT_UPDATE_REPO, cache);
    writeCache({ ...cache, lastCheck: now, lastTag: info?.tag ?? cache.lastTag });
    if (!info || !isNewer(info.version, IDCTL_VERSION)) {
      return { status: 'up-to-date', current: IDCTL_VERSION, checkedAt: now };
    }
    return { status: 'available', current: IDCTL_VERSION, info, checkedAt: now };
  } catch (e) {
    writeCache({ ...cache, lastCheck: now }); // back off even on error
    return { status: 'error', message: e instanceof Error ? e.message : String(e), checkedAt: now };
  }
}

async function checkGitHub(repo: string, cache: CheckCache): Promise<UpdateInfo | null> {
  // 1. Cheap redirect poll — no api.github.com rate-limit cost.
  const r = await fetch(`https://github.com/${repo}/releases/latest`, {
    redirect: 'manual',
    headers: { 'User-Agent': UA },
  });
  const loc = r.headers.get('location') ?? '';
  const tag = loc.split('/tag/')[1];
  if (!tag) throw new Error('could not resolve latest tag (no releases yet?)');
  if (!isNewer(tag, IDCTL_VERSION)) return null;

  // 2. Newer exists → one authoritative API call for assets[] (ETag-conditional).
  const api = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(cache.etag ? { 'If-None-Match': cache.etag } : {}),
    },
  });
  if (api.status === 304) return null;
  if (!api.ok) throw new Error(`github api ${api.status}`);
  cache.etag = api.headers.get('etag') ?? cache.etag;
  const rel = (await api.json()) as {
    tag_name?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (rel.draft || rel.prerelease) return null;

  const plat = detectPlatform();
  const asset = (rel.assets ?? []).find((a) => a.name === plat.assetName);
  if (!asset) throw new Error(`no asset "${plat.assetName}" in ${rel.tag_name}`);
  const sums = (rel.assets ?? []).find((a) => a.name === 'SHASUMS256.txt');
  return {
    version: tag.replace(/^v/, ''),
    tag,
    notesUrl: rel.html_url,
    assetUrl: asset.browser_download_url,
    shasumsUrl: sums?.browser_download_url,
  };
}

async function checkManifest(url: string, cache: CheckCache): Promise<UpdateInfo | null> {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, ...(cache.etag ? { 'If-None-Match': cache.etag } : {}) },
  });
  if (r.status === 304) return null;
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  cache.etag = r.headers.get('etag') ?? cache.etag;
  const m = (await r.json()) as {
    version: string;
    tag?: string;
    notes_url?: string;
    assets?: { os: string; arch: string; libc?: string | null; url: string; sha256?: string }[];
  };
  if (!isNewer(m.version, IDCTL_VERSION)) return null;
  const plat = detectPlatform();
  const a = (m.assets ?? []).find(
    (x) => x.os === plat.os && x.arch === plat.arch && (x.libc ? (x.libc === 'musl') === plat.musl : true),
  );
  if (!a) throw new Error(`manifest has no asset for ${plat.assetName}`);
  return { version: m.version, tag: m.tag ?? `v${m.version}`, notesUrl: m.notes_url, assetUrl: a.url, sha256: a.sha256 };
}
