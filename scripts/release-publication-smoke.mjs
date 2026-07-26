#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateLegacyReleaseCutover,
  validateLegacyReleaseCutover,
} from './lib/legacy-release-cutover.mjs';
import {
  compareTags,
  semverTags,
  unpublishedFrontierTags,
} from './lib/release-publication.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = JSON.parse(readFileSync(join(root, 'release', 'legacy-release-cutover.json'), 'utf8'));
const clone = (value) => structuredClone(value);
const exactRefs = marker.legacyTags.map(({ tag, targetCommit }) => ({
  tag,
  objectId: targetCommit,
  objectType: 'commit',
}));
const exactReleaseRecords = marker.legacyTags.map(({ tag, release }) => ({
  tag,
  release: release.state === 'absent'
    ? null
    : {
        tag_name: tag,
        id: release.id,
        published_at: release.publishedAt,
        draft: false,
        prerelease: false,
      },
}));

validateLegacyReleaseCutover(marker);
assert.equal(marker.schemaVersion, 2);
assert.equal(marker.legacyTags.length, 28);
assert.equal(marker.legacyTags[0].tag, 'v0.1.620');
assert.equal(marker.legacyTags.at(-1).tag, 'v0.1.647');
assert.deepEqual(
  marker.legacyTags.filter(({ release }) => release.state === 'absent').map(({ tag }) => tag),
  ['v0.1.622', 'v0.1.624', 'v0.1.625'],
);
assert.equal(marker.legacyTags.filter(({ release }) => release.state === 'published-non-latest').length, 25);
assert.equal(compareTags('v0.1.647', 'v0.1.619'), 28);

const active = evaluateLegacyReleaseCutover(marker, {
  repository: 'bobofbuilding/idacc',
  latestPublishedTag: 'v0.1.619',
  tagRefs: exactRefs,
  releaseRecords: exactReleaseRecords,
});
assert.equal(active.active, true);
assert.equal(active.changelogBaselineTag, 'v0.1.619');
assert.equal(active.firstCanonicalVersionMustExceed, 'v0.1.647');
assert.deepEqual(active.allowTags, marker.legacyTags.map(({ tag }) => tag));
assert.equal(active.legacyTagCount, 28);
assert.equal(active.publishedNonLatestReleaseCount, 25);
assert.equal(active.absentReleaseCount, 3);

const tags = [
  'v0.1.20',
  ...marker.legacyTags.map(({ tag }) => tag),
  'v0.1.648',
  'v1.0.0-rc.1',
  'notes',
];
const releases = [{ tag_name: 'v0.1.619', draft: false }];
assert.deepEqual(semverTags(['v0.1.20', 'v0.1.637', 'v0.1.637', 'notes']), ['v0.1.20', 'v0.1.637']);
assert.deepEqual(
  unpublishedFrontierTags(tags, releases, { allowTags: active.allowTags }),
  ['v0.1.648'],
  'only the exact recorded historical tags may cross the unpublished frontier',
);

const dormant = evaluateLegacyReleaseCutover(marker, {
  repository: 'bobofbuilding/idacc',
  latestPublishedTag: 'v0.1.685',
  tagRefs: exactRefs,
  releaseRecords: exactReleaseRecords,
});
assert.equal(dormant.active, false);
assert.deepEqual(dormant.allowTags, []);
assert.equal(dormant.changelogBaselineTag, 'v0.1.685');

const missing = exactRefs.slice(1);
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: missing,
    releaseRecords: exactReleaseRecords,
  }),
  /v0\.1\.620 is missing/,
);

const annotated = clone(exactRefs);
annotated[4].objectType = 'tag';
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: annotated,
    releaseRecords: exactReleaseRecords,
  }),
  /v0\.1\.624 is tag; expected the recorded lightweight tag/,
);

const rewritten = clone(exactRefs);
rewritten[8].objectId = 'f'.repeat(40);
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: rewritten,
    releaseRecords: exactReleaseRecords,
  }),
  /v0\.1\.628 resolves to/,
);

assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'someone/else',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: exactReleaseRecords,
  }),
  /repository someone\/else does not match/,
);
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.630',
    tagRefs: exactRefs,
    releaseRecords: exactReleaseRecords,
  }),
  /recorded as published-non-latest but GitHub reports it as Latest/,
);
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.618',
    tagRefs: exactRefs,
    releaseRecords: exactReleaseRecords,
  }),
  /predates recorded baseline/,
);

const absentPublished = clone(exactReleaseRecords);
absentPublished[2].release = {
  tag_name: 'v0.1.622',
  id: 999,
  published_at: '2026-07-26T00:00:00Z',
  draft: false,
  prerelease: false,
};
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: absentPublished,
  }),
  /v0\.1\.622 must remain absent/,
);

const publishedMissing = clone(exactReleaseRecords);
publishedMissing[0].release = null;
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: publishedMissing,
  }),
  /v0\.1\.620 must remain a published GitHub Release/,
);

const releaseIdChanged = clone(exactReleaseRecords);
releaseIdChanged[1].release.id += 1;
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: releaseIdChanged,
  }),
  /v0\.1\.621 release id is/,
);

const publishedAtChanged = clone(exactReleaseRecords);
publishedAtChanged.at(-1).release.published_at = '2026-07-26T00:00:00Z';
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: publishedAtChanged,
  }),
  /v0\.1\.647 published_at is/,
);

const drafted = clone(exactReleaseRecords);
drafted[3].release.draft = true;
assert.throws(
  () => evaluateLegacyReleaseCutover(marker, {
    repository: 'bobofbuilding/idacc',
    latestPublishedTag: 'v0.1.619',
    tagRefs: exactRefs,
    releaseRecords: drafted,
  }),
  /v0\.1\.623 must remain published and non-prerelease/,
);

const nonContiguous = clone(marker);
nonContiguous.legacyTags[10].tag = 'v0.1.999';
assert.throws(() => validateLegacyReleaseCutover(nonContiguous), /must be v0\.1\.630/);

const expanded = clone(marker);
expanded.extraAllowedRange = true;
assert.throws(() => validateLegacyReleaseCutover(expanded), /top-level fields/);

const relaxed = clone(marker);
relaxed.invariants.doNotDeleteOrRewriteTags = false;
assert.throws(() => validateLegacyReleaseCutover(relaxed), /doNotDeleteOrRewriteTags must remain true/);

const broadenedAbsent = clone(marker);
broadenedAbsent.legacyTags[2].release.id = 1;
assert.throws(() => validateLegacyReleaseCutover(broadenedAbsent), /absent release fields are invalid/);

const weakenedPublishedIdentity = clone(marker);
delete weakenedPublishedIdentity.legacyTags[0].release.id;
assert.throws(() => validateLegacyReleaseCutover(weakenedPublishedIdentity), /published release fields are invalid/);

console.log('✓ release publication and legacy cutover smoke test passed');
