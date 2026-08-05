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
verified, and dispatches the cross-platform **Production release** workflow.
Each dispatch carries a unique request ID. The command waits for the one run
bound to that request, the exact tag/head commit, and the requested publish
mode, requires terminal success, and, when publishing, requires the anonymous
public release verifier to pass before it returns:

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
that both local `git verify-tag` and GitHub recognize. The command rejects
lightweight tags, unsigned or cryptographically invalid annotated tags, and the
retired commit/tag-only flags. `--publish=false` is a full
production-pipeline dry run: the signed tag is pushed and every platform is built,
signed, verified, and attested, but the GitHub Release remains a draft.

Before it changes files, the command also checks that the current release frontier
has no tag without a published GitHub Release. If a dispatch, build, or publish
was interrupted after the tag was pushed, use `--resume` for that version.
Resume validates the exact signed tag again, waits for the exact matching active
run instead of dispatching a duplicate, and re-runs public verification for an
already published version. A failed run may be safely dispatched again; the
workflow compares any existing draft assets byte-for-byte and uploads only
missing assets.

Production fails closed unless it produces exactly seven consumer installers:
macOS arm64 and x64 DMG plus ZIP, Windows x64 EXE, and Linux x64 AppImage plus
DEB. Before publication, the workflow validates the updater descriptors against
those installer bytes. After publication, the consumer-path verifier checks the
public Atom feed and web Latest route, then anonymously downloads and hashes all
seven installers.

The protected `production` environment must include the expected signer
controls documented in
[`docs/RELEASE_PROVENANCE.md`](docs/RELEASE_PROVENANCE.md):
`MACOS_EXPECTED_TEAM_ID`, `MACOS_EXPECTED_SIGNING_IDENTITY` (the
electron-builder qualifier without the `Developer ID Application:` prefix and
ending in `(TEAMID)`), and `WINDOWS_EXPECTED_PUBLISHER_SUBJECT` (the exact full
certificate subject distinguished name).

### Owner-authorized unsigned stable releases

The repository owner may deliberately restore the legacy unsigned application
distribution model for a specific stable version. This does **not** relax source
identity, payload, provenance, updater, or public-download validation: the
release still requires an exact GitHub-verified signed annotated tag, the full
seven-installer matrix, exact Manager and Brain pins, GitHub attestations,
immutable release assets, and anonymous verification of the public Latest route.

Dispatch `Production release` from the exact `vX.Y.Z` tag with
`signing_mode=unsigned`, `publish=true`, a unique `request_id`, and
`unsigned_acknowledgement=publish-vX.Y.Z-unsigned`. In this mode macOS uses the
stable ad-hoc application identity without notarization, Windows uses SHA-256
helper verification without Authenticode, and the release notes explicitly warn
about Gatekeeper and SmartScreen. The ordinary `scripts/release.sh` path remains
signed by default and never opts into unsigned packages implicitly.

The one historical exception is the audited tag frontier from `v0.1.620`
through `v0.1.684`: 63 lightweight refs and two exact unsigned annotated refs.
It is an exact tag-object, peeled-commit, and release-identity allowlist, not a
reusable version range. Do not delete, rewrite, convert, publish, or unpublish
those historical records. See the
[legacy release cutover record](docs/RELEASE_CUTOVER.md) for its invariants and
lifecycle. Any unrecorded incomplete tag still stops a release.

Do not publish a production build by hand. Local package commands are useful for
development evidence, but only `.github/workflows/release.yml` is authorized to
assemble and publish the unified macOS, Windows, and Linux application.

### Review-channel updates

For installed-app review before a consumer release, run the **Review build**
workflow. It publishes an isolated GitHub prerelease tagged
`review-v<source-version>-<commit>` with the `review` updater descriptors and
all supported operating-system packages. Review releases do not change the
stable GitHub **Latest** release or the production `latest` update channel.

Review builds deliberately require no private signing or Apple notarization
credentials. macOS packages use a stable ad-hoc designated requirement, and all
platforms use electron-builder SHA-512 update metadata. Install the first review
package manually to bridge from an existing production or legacy build; later
review builds can update that installed review app automatically. These packages
are for owner review only and are not consumer-ready production releases.

`idctl-desktop/src-tauri` is retained only as a developer interface simulation.
It does not bundle or supervise Manager and Brain, its bundler is disabled, and
the old `tauri`, `tauri:dev`, and `tauri:build` package commands deliberately
fail. Use `npm run dev:tauri-simulation` only for UI experiments; it is never a
consumer or production distribution path.
