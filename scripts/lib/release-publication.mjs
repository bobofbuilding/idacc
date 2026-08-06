export const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
export const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

export function semverTags(tags) {
  return [...new Set(tags.filter((tag) => SEMVER_TAG.test(tag)))].sort(compareTags);
}

export function compareTags(a, b) {
  const left = a.slice(1).split('.').map(BigInt);
  const right = b.slice(1).split('.').map(BigInt);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function isSemverTagGreater(candidate, baseline) {
  if (!SEMVER_TAG.test(candidate) || !SEMVER_TAG.test(baseline)) return false;
  return compareTags(candidate, baseline) > 0;
}

export function incrementSemverPatch(version) {
  if (!PLAIN_SEMVER.test(version)) return '';
  const [major, minor, patch] = version.split('.');
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
}

// Only the live release frontier blocks a new release. Older tags predate this
// guard and may be intentionally tag-only history; a new tag beyond the newest
// published release, however, is always an incomplete current release.
export function unpublishedFrontierTags(tags, releases, { allowTags = [] } = {}) {
  const publishedTags = new Set(
    releases
      .filter((release) => (
        release
        && release.draft === false
        && release.prerelease === false
        && typeof release.tag_name === 'string'
      ))
      .map((release) => release.tag_name),
  );
  const allowed = new Set(allowTags);
  const latestPublishedTag = semverTags([...publishedTags]).at(-1);
  return semverTags(tags).filter((tag) =>
    !publishedTags.has(tag)
    && !allowed.has(tag)
    && (!latestPublishedTag || compareTags(tag, latestPublishedTag) > 0),
  );
}
