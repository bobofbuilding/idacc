import { readFileSync } from 'node:fs';
import { compareTags, SEMVER_TAG } from './release-publication.mjs';

const SHA1 = /^[0-9a-f]{40}$/;
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'repository',
  'recordedAt',
  'baselinePublishedTag',
  'firstCanonicalVersionMustExceed',
  'reason',
  'invariants',
  'legacyTags',
]);
const INVARIANT_KEYS = new Set([
  'doNotDeleteOrRewriteTags',
  'requireLightweightTagTargets',
  'requireExactReleaseStates',
]);
const TAG_KEYS = new Set(['tag', 'kind', 'targetCommit', 'release']);
const ABSENT_RELEASE_KEYS = new Set(['state']);
const PUBLISHED_RELEASE_KEYS = new Set(['state', 'id', 'publishedAt']);
const RELEASE_RECORD_KEYS = new Set(['tag', 'release']);
const PUBLISHED_NON_LATEST = 'published-non-latest';
const ABSENT = 'absent';

function objectHasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function fail(message) {
  throw new Error(`legacy release cutover is invalid: ${message}`);
}

function versionParts(tag) {
  return tag.slice(1).split('.').map(Number);
}

export function validateLegacyReleaseCutover(marker) {
  if (!objectHasExactKeys(marker, TOP_LEVEL_KEYS)) {
    fail('top-level fields do not match the version 2 schema');
  }
  if (marker.schemaVersion !== 2) fail(`unsupported schemaVersion ${String(marker.schemaVersion)}`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(marker.repository || '')) fail('repository must be owner/repo');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marker.recordedAt || '')) fail('recordedAt must be YYYY-MM-DD');
  if (!SEMVER_TAG.test(marker.baselinePublishedTag || '')) fail('baselinePublishedTag must be vX.Y.Z');
  if (!SEMVER_TAG.test(marker.firstCanonicalVersionMustExceed || '')) {
    fail('firstCanonicalVersionMustExceed must be vX.Y.Z');
  }
  if (typeof marker.reason !== 'string' || marker.reason.trim().length < 20) {
    fail('reason must explain the historical exception');
  }
  if (!objectHasExactKeys(marker.invariants, INVARIANT_KEYS)) {
    fail('invariants do not match the version 2 schema');
  }
  for (const key of INVARIANT_KEYS) {
    if (marker.invariants[key] !== true) fail(`${key} must remain true`);
  }
  if (!Array.isArray(marker.legacyTags) || marker.legacyTags.length === 0) {
    fail('legacyTags must be a non-empty array');
  }

  const [baselineMajor, baselineMinor, baselinePatch] = versionParts(marker.baselinePublishedTag);
  const [cutoffMajor, cutoffMinor, cutoffPatch] = versionParts(marker.firstCanonicalVersionMustExceed);
  if (baselineMajor !== cutoffMajor || baselineMinor !== cutoffMinor || cutoffPatch <= baselinePatch) {
    fail('the version 2 cutover must describe one forward contiguous patch range');
  }
  const expectedLength = cutoffPatch - baselinePatch;
  if (marker.legacyTags.length !== expectedLength) {
    fail(`legacyTags must contain exactly ${expectedLength} contiguous tags`);
  }

  marker.legacyTags.forEach((entry, index) => {
    if (!objectHasExactKeys(entry, TAG_KEYS)) fail(`legacyTags[${index}] fields are invalid`);
    const expectedTag = `v${baselineMajor}.${baselineMinor}.${baselinePatch + index + 1}`;
    if (entry.tag !== expectedTag) {
      fail(`legacyTags[${index}] must be ${expectedTag}, got ${String(entry.tag)}`);
    }
    if (entry.kind !== 'lightweight') fail(`${entry.tag} kind must remain lightweight`);
    if (!SHA1.test(entry.targetCommit || '')) fail(`${entry.tag} targetCommit must be a 40-character lowercase Git object ID`);
    if (entry.release?.state === ABSENT) {
      if (!objectHasExactKeys(entry.release, ABSENT_RELEASE_KEYS)) {
        fail(`${entry.tag} absent release fields are invalid`);
      }
    } else if (entry.release?.state === PUBLISHED_NON_LATEST) {
      if (!objectHasExactKeys(entry.release, PUBLISHED_RELEASE_KEYS)) {
        fail(`${entry.tag} published release fields are invalid`);
      }
      if (!Number.isSafeInteger(entry.release.id) || entry.release.id <= 0) {
        fail(`${entry.tag} release id must be a positive integer`);
      }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(entry.release.publishedAt || '')) {
        fail(`${entry.tag} publishedAt must be a UTC GitHub timestamp`);
      }
    } else {
      fail(`${entry.tag} release state must be ${PUBLISHED_NON_LATEST} or ${ABSENT}`);
    }
  });

  return marker;
}

export function readLegacyReleaseCutover(path) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  return validateLegacyReleaseCutover(marker);
}

function validateLegacyTagRefs(marker, tagRefs) {
  const refs = new Map(tagRefs.map((entry) => [entry.tag, entry]));
  for (const legacy of marker.legacyTags) {
    const actual = refs.get(legacy.tag);
    if (!actual) fail(`${legacy.tag} is missing; historical tags must not be deleted`);
    if (actual.objectType !== 'commit') {
      fail(`${legacy.tag} is ${actual.objectType || 'an unknown type'}; expected the recorded lightweight tag`);
    }
    if (actual.objectId !== legacy.targetCommit) {
      fail(`${legacy.tag} resolves to ${actual.objectId || 'nothing'}; expected ${legacy.targetCommit}`);
    }
  }
}

function validateLegacyReleaseStates(marker, latestPublishedTag, releaseRecords) {
  if (!Array.isArray(releaseRecords)) fail('releaseRecords must be an array');
  if (releaseRecords.length !== marker.legacyTags.length) {
    fail(`releaseRecords must contain exactly ${marker.legacyTags.length} entries`);
  }
  const records = new Map();
  for (const [index, record] of releaseRecords.entries()) {
    if (!objectHasExactKeys(record, RELEASE_RECORD_KEYS)) {
      fail(`releaseRecords[${index}] fields are invalid`);
    }
    if (records.has(record.tag)) fail(`releaseRecords contains duplicate ${String(record.tag)}`);
    records.set(record.tag, record.release);
  }

  for (const legacy of marker.legacyTags) {
    if (!records.has(legacy.tag)) fail(`releaseRecords is missing ${legacy.tag}`);
    const actual = records.get(legacy.tag);
    if (legacy.release.state === ABSENT) {
      if (actual !== null) {
        fail(`${legacy.tag} must remain absent from GitHub Releases`);
      }
      continue;
    }
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      fail(`${legacy.tag} must remain a published GitHub Release`);
    }
    if (actual.tag_name !== legacy.tag) {
      fail(`${legacy.tag} release endpoint returned ${String(actual.tag_name || '(missing tag)')}`);
    }
    if (actual.draft !== false || actual.prerelease !== false) {
      fail(`${legacy.tag} must remain published and non-prerelease`);
    }
    if (actual.id !== legacy.release.id) {
      fail(`${legacy.tag} release id is ${String(actual.id)}; expected ${legacy.release.id}`);
    }
    if (actual.published_at !== legacy.release.publishedAt) {
      fail(`${legacy.tag} published_at is ${String(actual.published_at)}; expected ${legacy.release.publishedAt}`);
    }
    if (latestPublishedTag === legacy.tag) {
      fail(`${legacy.tag} is recorded as published-non-latest but GitHub reports it as Latest`);
    }
  }
}

export function evaluateLegacyReleaseCutover(markerInput, {
  repository,
  latestPublishedTag,
  tagRefs,
  releaseRecords,
}) {
  const marker = validateLegacyReleaseCutover(markerInput);
  if (repository !== marker.repository) {
    fail(`repository ${repository || '(missing)'} does not match ${marker.repository}`);
  }
  if (!SEMVER_TAG.test(latestPublishedTag || '')) {
    fail('GitHub latest must be the published semver release recorded by the cutover');
  }
  if (!Array.isArray(tagRefs)) fail('tagRefs must be an array');

  validateLegacyTagRefs(marker, tagRefs);
  validateLegacyReleaseStates(marker, latestPublishedTag, releaseRecords);

  const baselineComparison = compareTags(latestPublishedTag, marker.baselinePublishedTag);
  const cutoffComparison = compareTags(latestPublishedTag, marker.firstCanonicalVersionMustExceed);
  if (baselineComparison < 0) {
    fail(`GitHub latest ${latestPublishedTag} predates recorded baseline ${marker.baselinePublishedTag}`);
  }
  if (baselineComparison > 0 && cutoffComparison <= 0) {
    fail(`${latestPublishedTag} is inside the recorded legacy range and cannot be GitHub Latest`);
  }

  const active = baselineComparison === 0;
  return {
    active,
    allowTags: active ? marker.legacyTags.map((entry) => entry.tag) : [],
    baselinePublishedTag: marker.baselinePublishedTag,
    changelogBaselineTag: active ? marker.baselinePublishedTag : latestPublishedTag,
    firstCanonicalVersionMustExceed: marker.firstCanonicalVersionMustExceed,
    legacyTagCount: marker.legacyTags.length,
    publishedNonLatestReleaseCount: marker.legacyTags.filter((entry) =>
      entry.release.state === PUBLISHED_NON_LATEST).length,
    absentReleaseCount: marker.legacyTags.filter((entry) => entry.release.state === ABSENT).length,
  };
}
