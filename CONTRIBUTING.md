# Contributing

## Versioning — every change on `main` carries its version number

The product version lives in [`idctl-desktop/package.json`](idctl-desktop/package.json)
(the `idctl` TUI shares the same line). Every commit pushed or merged to `main`
must include that version in its subject, e.g.:

```
v0.1.17: Capabilities: remove skills — delete from library + uninstall from agents
```

This is enforced automatically by a `commit-msg` git hook — you don't write the
`vX.Y.Z:` prefix yourself; the hook prepends it from `package.json`. Enable it
once after cloning:

```sh
sh scripts/setup-hooks.sh      # sets core.hooksPath = scripts/hooks
# (equivalently: git config core.hooksPath scripts/hooks)
```

The hook is idempotent (a subject that already starts with `vX…` is left
untouched, so `--amend` is safe) and never blocks a commit.

## Cutting a new version

After your change is made, ship it in **one command** with the release script — it
bumps the version (next patch, following the last release), writes the CHANGELOG
entry, typechecks, commits + tags + pushes, builds the macOS app, and publishes the
GitHub release:

```sh
scripts/release.sh "Short summary of the change for the changelog"
# explicit version:    scripts/release.sh "…" 0.2.0
# commit/tag/push only: scripts/release.sh "…" --commit   (no build/publish)
# finish a pushed but unpublished tag: scripts/release.sh --resume 0.2.0
```

Before it changes files, the release command checks that every existing `vX.Y.Z`
tag has a published GitHub Release. If a previous build or publish was interrupted
after pushing its tag, the command refuses to create another version; check out the
tag and use `--resume` to build and publish that exact version. `--commit` remains
an explicit commit/tag/push-only mode, but its deferred tag must be resumed before
the next version is cut.

Or do it by hand:

1. Bump `version` in `idctl-desktop/package.json` (and keep `idctl` in step if
   you ship it too).
2. Make your change and commit — the hook stamps the new version onto the subject.
3. Add an entry to [`CHANGELOG.md`](CHANGELOG.md) under a new `## [x.y.z]` heading.
4. Push to `main`. Tag the release `vX.Y.Z` if you publish a build.

That keeps `git log`, the changelog, and any release tags all agreeing on which
version each change belongs to.
