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
  'requireExactTagObjects',
  'requireExactReleaseStates',
]);
const LIGHTWEIGHT_TAG_KEYS = new Set(['tag', 'kind', 'targetCommit', 'release']);
const ANNOTATED_TAG_KEYS = new Set([
  'tag',
  'kind',
  'tagObject',
  'targetCommit',
  'signatureState',
  'release',
]);
const ABSENT_RELEASE_KEYS = new Set(['state']);
const PUBLISHED_RELEASE_KEYS = new Set(['state', 'id', 'publishedAt']);
const RELEASE_RECORD_KEYS = new Set(['tag', 'release']);
const PUBLISHED = 'published';
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
  return tag.slice(1).split('.').map(BigInt);
}

export function validateLegacyReleaseCutover(marker) {
  if (!objectHasExactKeys(marker, TOP_LEVEL_KEYS)) {
    fail('top-level fields do not match the version 3 schema');
  }
  if (marker.schemaVersion !== 3) fail(`unsupported schemaVersion ${String(marker.schemaVersion)}`);
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
    fail('invariants do not match the version 3 schema');
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
    fail('the version 3 cutover must describe one forward contiguous patch range');
  }
  const expectedLength = cutoffPatch - baselinePatch;
  if (BigInt(marker.legacyTags.length) !== expectedLength) {
    fail(`legacyTags must contain exactly ${expectedLength} contiguous tags`);
  }

  marker.legacyTags.forEach((entry, index) => {
    const expectedTag = `v${baselineMajor}.${baselineMinor}.${baselinePatch + BigInt(index) + 1n}`;
    if (entry.tag !== expectedTag) {
      fail(`legacyTags[${index}] must be ${expectedTag}, got ${String(entry.tag)}`);
    }
    if (entry.kind === 'lightweight') {
      if (!objectHasExactKeys(entry, LIGHTWEIGHT_TAG_KEYS)) {
        fail(`${entry.tag} lightweight tag fields are invalid`);
      }
    } else if (entry.kind === 'annotated') {
      if (!objectHasExactKeys(entry, ANNOTATED_TAG_KEYS)) {
        fail(`${entry.tag} annotated tag fields are invalid`);
      }
      if (!SHA1.test(entry.tagObject || '')) {
        fail(`${entry.tag} tagObject must be a 40-character lowercase Git object ID`);
      }
      if (entry.signatureState !== 'unsigned') {
        fail(`${entry.tag} annotated signatureState must remain unsigned`);
      }
    } else {
      fail(`${entry.tag} kind must be lightweight or annotated`);
    }
    if (!SHA1.test(entry.targetCommit || '')) fail(`${entry.tag} targetCommit must be a 40-character lowercase Git object ID`);
    if (entry.release?.state === ABSENT) {
      if (!objectHasExactKeys(entry.release, ABSENT_RELEASE_KEYS)) {
        fail(`${entry.tag} absent release fields are invalid`);
      }
    } else if (entry.release?.state === PUBLISHED) {
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
      fail(`${entry.tag} release state must be ${PUBLISHED} or ${ABSENT}`);
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
    if (legacy.kind === 'lightweight') {
      if (actual.objectType !== 'commit') {
        fail(`${legacy.tag} is ${actual.objectType || 'an unknown type'}; expected the recorded lightweight tag`);
      }
      if (
        actual.objectId !== legacy.targetCommit
        || actual.targetCommit !== legacy.targetCommit
      ) {
        fail(`${legacy.tag} resolves to ${actual.objectId || 'nothing'}; expected ${legacy.targetCommit}`);
      }
      continue;
    }
    if (actual.objectType !== 'tag') {
      fail(`${legacy.tag} is ${actual.objectType || 'an unknown type'}; expected the recorded annotated tag`);
    }
    if (actual.objectId !== legacy.tagObject) {
      fail(`${legacy.tag} tag object is ${actual.objectId || 'nothing'}; expected ${legacy.tagObject}`);
    }
    if (actual.targetCommit !== legacy.targetCommit) {
      fail(`${legacy.tag} peels to ${actual.targetCommit || 'nothing'}; expected ${legacy.targetCommit}`);
    }
    if (actual.signatureState !== legacy.signatureState) {
      fail(`${legacy.tag} signature state is ${actual.signatureState || 'unknown'}; expected ${legacy.signatureState}`);
    }
  }
}

function validateLegacyReleaseStates(marker, releaseRecords) {
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
  }
}

function validateCanonicalLatestTag(latestPublishedTag, tagRefs, canonicalTagVerification) {
  const remoteRef = tagRefs.find((entry) => entry.tag === latestPublishedTag);
  if (!remoteRef) {
    fail(`${latestPublishedTag} is GitHub Latest but has no remote tag ref`);
  }
  if (remoteRef.objectType !== 'tag') {
    fail(`${latestPublishedTag} must be an annotated tag; lightweight canonical release tags are not allowed`);
  }
  if (!canonicalTagVerification || canonicalTagVerification.tag !== latestPublishedTag) {
    fail(`${latestPublishedTag} is missing GitHub tag signature verification`);
  }
  if (canonicalTagVerification.objectType !== 'tag') {
    fail(`${latestPublishedTag} must be an annotated tag; GitHub reports a ${canonicalTagVerification.objectType || 'missing'} ref`);
  }
  if (
    !SHA1.test(canonicalTagVerification.objectId || '')
    || canonicalTagVerification.objectId !== remoteRef.objectId
  ) {
    fail(`${latestPublishedTag} GitHub tag object does not match the remote tag ref`);
  }
  if (canonicalTagVerification.annotatedTagName !== latestPublishedTag) {
    fail(`${latestPublishedTag} annotated tag object names ${canonicalTagVerification.annotatedTagName || 'nothing'}`);
  }
  if (canonicalTagVerification.targetObjectType !== 'commit') {
    fail(`${latestPublishedTag} annotated tag must directly target a commit`);
  }
  if (
    !SHA1.test(canonicalTagVerification.targetCommit || '')
    || canonicalTagVerification.targetCommit !== remoteRef.targetCommit
  ) {
    fail(`${latestPublishedTag} GitHub-verified target does not match the remote peeled commit`);
  }
  if (
    canonicalTagVerification.verified !== true
    || canonicalTagVerification.verificationReason !== 'valid'
  ) {
    fail(
      `${latestPublishedTag} must have a valid GitHub-verified signature; verification is `
      + `${canonicalTagVerification.verified === true ? 'verified' : 'unverified'} `
      + `(${canonicalTagVerification.verificationReason || 'unknown reason'})`,
    );
  }
}

export function evaluateLegacyReleaseCutover(markerInput, {
  repository,
  latestPublishedTag,
  tagRefs,
  releaseRecords,
  canonicalTagVerification = null,
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
  validateLegacyReleaseStates(marker, releaseRecords);

  const baselineComparison = compareTags(latestPublishedTag, marker.baselinePublishedTag);
  const cutoffComparison = compareTags(latestPublishedTag, marker.firstCanonicalVersionMustExceed);
  if (baselineComparison < 0) {
    fail(`GitHub latest ${latestPublishedTag} predates recorded baseline ${marker.baselinePublishedTag}`);
  }
  if (baselineComparison > 0 && cutoffComparison < 0) {
    fail(`${latestPublishedTag} is inside the recorded legacy range and cannot be GitHub Latest`);
  }

  // The exact cutoff may be GitHub Latest while the first canonical release is
  // being prepared. Once a version above the cutoff is Latest, the exception
  // automatically becomes dormant and cannot authorize any future tag gap.
  const active = baselineComparison === 0 || cutoffComparison === 0;
  if (!active) {
    validateCanonicalLatestTag(latestPublishedTag, tagRefs, canonicalTagVerification);
  }
  return {
    active,
    allowTags: active ? marker.legacyTags.map((entry) => entry.tag) : [],
    baselinePublishedTag: marker.baselinePublishedTag,
    changelogBaselineTag: latestPublishedTag,
    firstCanonicalVersionMustExceed: marker.firstCanonicalVersionMustExceed,
    legacyTagCount: marker.legacyTags.length,
    publishedReleaseCount: marker.legacyTags.filter((entry) =>
      entry.release.state === PUBLISHED).length,
    absentReleaseCount: marker.legacyTags.filter((entry) => entry.release.state === ABSENT).length,
  };
}
