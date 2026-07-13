export const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

export function semverTags(tags) {
  return [...new Set(tags.filter((tag) => SEMVER_TAG.test(tag)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function compareTags(a, b) {
  const left = a.slice(1).split('.').map(Number);
  const right = b.slice(1).split('.').map(Number);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// Only the live release frontier blocks a new release. Older tags predate this
// guard and may be intentionally tag-only history; a new tag beyond the newest
// published release, however, is always an incomplete current release.
export function unpublishedFrontierTags(tags, releases, { allowTags = [] } = {}) {
  const publishedTags = new Set(
    releases
      .filter((release) => release && !release.draft && typeof release.tag_name === 'string')
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
