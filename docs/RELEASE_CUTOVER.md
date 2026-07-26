# Legacy Release Cutover

The public GitHub release frontier was audited on 2026-07-26. Origin contains
28 lightweight tags created by the retired local release path, `v0.1.620`
through `v0.1.647`. The GitHub Releases API has a mixed historical state for
that exact set:

- 25 tags have published releases that are not GitHub Latest; and
- `v0.1.622`, `v0.1.624`, and `v0.1.625` have no GitHub Release.

These tags and release objects are historical records, not the canonical
signed release lineage. They must not be deleted, rewritten, converted to
annotated tags, unpublished, republished, or otherwise normalized.
[`release/legacy-release-cutover.json`](../release/legacy-release-cutover.json)
records each permitted tag's exact commit object ID and exact release state.
Published entries are additionally bound to their GitHub release ID and
publication timestamp. The record deliberately contains no range wildcard: a
ref is exempted only when its name, lightweight type, target commit, and
recorded release state all match.

## Guard behavior

`scripts/check-release-publication.mjs` reads the fixed cutover record and
compares it with origin and the GitHub Releases API.

While GitHub Latest remains `v0.1.619`, the guard:

1. requires all 28 recorded refs to exist on origin with their recorded object
   type and commit;
2. requires the 25 recorded releases to remain published, non-prerelease,
   non-draft, non-Latest, and identical by release ID and publication time;
3. requires the three recorded absent releases to remain absent;
4. exempts only those exact refs from the incomplete-release frontier; and
5. fails for any additional incomplete version tag, including `v0.1.648`.

The first canonical release must therefore be greater than `v0.1.647`, use the
signed annotated tag path, and complete the production workflow. During that
release, the changelog range begins at the last published release,
`v0.1.619`, not at the newest historical lightweight tag. The operator's
release summary remains the first changelog item, followed by unique commit
subjects from the complete published range.

After a canonical version greater than `v0.1.647` becomes GitHub Latest, the
frontier exemption becomes dormant automatically and the newest published tag
becomes the next changelog baseline. The guard continues to verify every
historical tag and release identity: published records must stay published
with the same ID and publication time, and absent records must stay absent.

## Failure handling

Do not repair a guard failure by force-pushing, deleting, recreating,
publishing, unpublishing, or republishing a historical tag or release. Stop and
compare origin and the GitHub Releases API with the schema-v2 cutover record.
An unexpected current signed tag must be completed with:

```sh
scripts/release.sh --resume X.Y.Z --publish=true
```

Changes to the cutover record require explicit release review because they
change the public-history trust boundary. The focused regression checks are:

```sh
node scripts/release-publication-smoke.mjs
node scripts/release-publication-cli-smoke.mjs
node scripts/release-command-smoke.mjs
```
