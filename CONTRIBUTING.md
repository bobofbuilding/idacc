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

After your change is made, ship it in **one command** with the release script. It
preflights GitHub CLI authentication and Git tag signing before changing files,
bumps the version (next patch unless an explicit version is supplied), writes the
CHANGELOG entry, typechecks, commits, creates a signed annotated tag, atomically
pushes the exact commit and tag, requires GitHub to report the signature as
verified, and dispatches the cross-platform **Production release** workflow:

```sh
scripts/release.sh "Short summary of the change for the changelog"
# explicit version:
scripts/release.sh "…" 0.2.0

# production-pipeline dry run: build, sign, attest, and retain a draft release
scripts/release.sh "…" 0.2.0 --publish=false

# safely continue the exact existing tag after an interruption or dry run
scripts/release.sh --resume 0.2.0 --publish=true
```

Run `gh auth login --hostname github.com` first and configure a Git signing key
that GitHub recognizes. The command rejects lightweight tags, unsigned annotated
tags, and the retired commit/tag-only flags. `--publish=false` is a full
production-pipeline dry run: the signed tag is pushed and every platform is built,
signed, verified, and attested, but the GitHub Release remains a draft.

Before it changes files, the command also checks that the current release frontier
has no tag without a published GitHub Release. If a dispatch, build, or publish
was interrupted after the tag was pushed, use `--resume` for that version.
Resume validates the exact signed tag again and does not dispatch a duplicate
while a run is active, after a successful dry run, or after publication. A failed
run may be safely dispatched again; the workflow compares any existing draft
assets byte-for-byte and uploads only missing assets.

The one historical exception is the audited lightweight-tag frontier from
`v0.1.620` through `v0.1.647`. It is an exact object-ID allowlist, not a reusable
version range. Do not delete, rewrite, convert, or publish those tags. See the
[legacy release cutover record](docs/RELEASE_CUTOVER.md) for its invariants and
lifecycle. Any unrecorded incomplete tag still stops a release.

Do not publish a production build by hand. Local package commands are useful for
development evidence, but only `.github/workflows/release.yml` is authorized to
assemble and publish the unified macOS, Windows, and Linux application.
