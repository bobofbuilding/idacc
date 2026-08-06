# Unified Release Provenance

ID Agents Control Center is released as one application containing three
versioned components:

- the desktop application;
- the ID Agents manager runtime; and
- the Brain runtime.

The Manager and Brain are never copied from arbitrary local working trees.
[`release/runtime-lock.json`](../release/runtime-lock.json) records the exact
repository, commit, Git tree, package-lock digest, version, entrypoint, and
service identity for each bundled runtime. The Brain entry also pins the
vendored runtime capsule, its manifest digest, and its content-tree digest.

## Reproducible staging

Use the Node and npm versions declared by `.node-version`, `packageManager`,
and `engines`. Install dependencies with `npm ci`.

The staging command requires a clean Manager checkout at the exact locked
commit and a verified Brain runtime capsule. The capsule is committed with
IDACC and materializes the locked, consumer-safe Brain subset without requiring
access to the private upstream repository:

```sh
npm run stage:runtimes --prefix idctl-desktop
npm run verify:runtimes --prefix idctl-desktop
```

Staging requires a clean application checkout by default. A developer may
create a clearly non-releasable local build while iterating:

```sh
npm run stage:runtimes --prefix idctl-desktop -- --allow-dirty-application
```

The dirty state remains recorded in the manifest. CI ignores the override and
packaged-release validation always rejects a dirty application manifest.

`stage:runtimes` exports the locked Manager commit, verifies and materializes
the Brain capsule, installs from the committed lockfiles, builds the Manager,
installs production-only runtime dependencies, rebuilds its Electron-native
dependency, and atomically replaces the staged payload. It does not run
dependency mutation commands such as `npm audit fix`.

The resulting schema-v2 runtime manifest includes:

- the desktop source commit and tree;
- the locked identity of both services;
- the Brain capsule distribution identity;
- the build toolchain and target architecture;
- a sorted inventory and SHA-256 for every runtime file or safe symlink; and
- SHA-256 tree digests for the manager, Brain, and complete runtime.

Verification rejects missing, altered, extra, or unsafe runtime content.
Staging also removes foreign-platform XMTP native binaries while retaining the
exact binding for the release target, and caps the logical Manager-plus-Brain
payload at 450 MiB. Adding a large immutable capability therefore requires an
explicit budget review rather than silently increasing every consumer
installation.

## Consumer-neutral runtime boundary

The unified application ships a deliberately small first-party runtime rather
than a copy of either source repository.

The Manager payload contains:

- the locked service entrypoint, startup/server roots, and their complete
  relative JavaScript dependency closure;
- `configs/default.yaml`, package metadata, the committed lockfile, and legal
  notices; and
- the neutral default-team skills required by that configuration: Brain,
  catalog, identity, inter-agent, task discipline, team coordination,
  bounded administration, and XMTP.

Team-building and wallet skills are optional capabilities installed into a
profile only when a consumer chooses them. They are deliberately excluded from
the immutable core runtime because they can carry broader authority than a
fresh application needs.

The Brain payload contains:

- the locked service entrypoint and the dependency closure for its service,
  cycle, listener, MCP, connector, evaluation, approval, dashboard, and core
  route roots;
- package metadata, the committed lockfile, and legal notices; and
- the connector schema plus the five versioned runtime prompts used for
  community reports, edge descriptions, fact synthesis, follow-up questions,
  and safety reports.

The vendored capsule contains only that first-party Brain runtime payload plus
its committed package metadata, lockfile, and license. Its deterministic
manifest records the exact path, mode, size, SHA-256, and Git blob identity of
every file. Capsule verification rejects missing or extra paths, symlinks, path
collisions, mode changes, digest changes, and a mismatched lock identity before
materialization.

The capsule intentionally does not embed raw private Git tree objects. Such
objects would disclose the names and hashes of omitted private siblings even
without disclosing their contents. The export tool verifies every recorded
blob against an exact clean upstream checkout when the capsule is regenerated.
For a credential-free unsigned review, the locked private commit/tree and each
recorded Git blob identity are therefore publisher assertions; the committed
capsule inventory and SHA-256 content tree remain independently reproducible
and tamper-evident. A maintainer with private-source access can repeat the
upstream comparison locally.

The staging allowlist intentionally excludes source tests and documentation,
operator plans and privileged tools, seed data, local databases and outputs,
launch configuration, organization-specific configs/plugins/skills/scripts,
and unrelated repository files. The one allowlisted Brain worker is the
bounded source-embedding refresh used by the opt-in maintenance cycle; it
mutates only the profile Brain database and remains disabled unless embedding
maintenance is explicitly enabled. Production dependencies are installed
separately from the committed lockfiles; they are not selected by the
first-party allowlist.

Before a manifest can be written, the consumer payload policy recursively
checks every first-party runtime file. It rejects:

- Bittrees- or SkillMesh-specific consumer assets, service URLs, and active
  team defaults;
- personal macOS, Linux, or Windows home-directory paths;
- environment, credential, private-key, seed-phrase, or mnemonic files and
  embedded secret material; and
- any forbidden operator, seed, or organization-specific path that reaches
  the payload.

Optional provider support may remain compiled into the generic runtime, but it
is dormant unless a consumer explicitly supplies provider configuration.
Provider endpoints have no organization-specific fallback, and signing keys
must come from the explicit process environment rather than a repository or
workspace `.env` file.

`test:release-provenance` proves that disallowed source material is not copied
by staging. `test:release-payload` independently injects organization defaults,
personal paths, hard-coded endpoints, and private-key material and proves that
the release guard rejects each case.

## Updating a runtime pin

Update a component only from its intended upstream repository:

1. select a reviewed full commit;
2. record its commit tree with `git rev-parse '<commit>^{tree}'`;
3. record the SHA-256 of `package-lock.json` exactly as committed;
4. copy the version from that commit's `package.json`;
5. for Brain, regenerate the consumer-safe runtime capsule and its per-file
   upstream audit records from that exact clean source;
6. update the matching entry and, for Brain, the capsule distribution digests
   in `release/runtime-lock.json`; and
7. run lock, capsule, and release-provenance verification.

```sh
node scripts/validate-runtime-lock.mjs \
  --manager-source /path/to/clean/manager
node scripts/runtime-source-capsule.mjs verify \
  --lock release/runtime-lock.json \
  --component brain
npm run test:release-provenance --prefix idctl-desktop
```

Maintainers performing the full private-upstream audit may additionally pass
`--brain-source /path/to/clean/brain` to `validate-runtime-lock.mjs`. That
optional audit verifies the commit-to-tree mapping directly. Source validation
deliberately fails for dirty checkouts, the wrong repository, the wrong HEAD,
an unavailable commit, a changed lockfile, or a version/tree mismatch. Capsule
validation independently fails for an altered manifest, inventory, or
payload.

## CI and production releases

`.github/workflows/ci.yml` checks out the public Manager pin, independently
verifies the committed Brain capsule, stages both components, typechecks the
application, audits every production dependency tree, builds an unpacked
application, runs the clean-stack release smoke test, and uploads short-lived
provenance evidence.

Windows builds discover the installed Visual Studio Roslyn compiler through
`vswhere` and require its Roslyn Compiler component plus the .NET Framework 4.8
targeting pack. They compile both app-owned native helpers twice from the
committed C# source with deterministic path mapping, require byte-identical
output, load-test the privacy helper under Windows PowerShell 5.1, and record
the exact source/compiler/binary identities in the build evidence. Compiler
identity covers the complete selected Roslyn directory and each explicit .NET
Framework reference assembly, as well as the `csc.exe` version and digest.
Production packaging Authenticode-signs the Job Host and verifies its exact publisher
alongside the desktop executable and installer; unsigned CI builds remain
pinned to the deterministic binary digest.

### Credential-free unsigned review builds

`.github/workflows/review-build.yml` is a deliberately separate review-only
path. It uses GitHub's scoped automatic `github.token` to read the public IDACC
and Manager repositories and to write only the pending/final review status on
the exact IDACC commit; checkout credential persistence is disabled and the
workflow has no release-write permission. It verifies the vendored Brain
capsule and materializes it independently in the runtime-source job and in
every native matrix job. No user-supplied or private runtime-source credential,
signing credential, notarization credential, or GitHub Release publishing
credential is used.

The runtime-source job installs the capsule's production dependencies, checks
the syntax of its first-party modules, and starts the Brain service against a
temporary clean state directory to verify its readiness endpoint. It does not
claim to run the excluded private upstream test suite. Each native job then
stages the exact Manager and capsule-backed Brain payload, verifies the unified
runtime, audits shipped dependencies, and exercises clean-profile Manager and
Brain startup from the packaged application.

Review packages use a prerelease identity, are unsigned and unnotarized, keep
self-update disabled, exclude updater descriptors and blockmaps, and are
uploaded only as a short-lived Actions artifact. This path does not create or
publish a GitHub Release, move `Latest`, or satisfy the signed consumer-release
gates.

The Manager source repository is public; the Brain source repository is
private. CI, unsigned review builds, and production packaging do not require a
private runtime-source credential. They use the exact public Manager pin and
the digest-pinned vendored Brain capsule. Private Brain access is needed only
when a maintainer intentionally regenerates the capsule or repeats the optional
full-upstream audit. Published installers contain the verified Manager and
Brain runtime payloads, and a downloaded application never needs
source-repository access to start, onboard, update, or use the unified stack.

The only supported production entrypoint is:

```sh
scripts/release.sh "Meaningful release summary" X.Y.Z --publish=true
```

Release preparation also enforces the
[legacy release cutover record](RELEASE_CUTOVER.md). The fixed record preserves
the exact `v0.1.620` through `v0.1.684` refs—63 lightweight and two unsigned
annotated tag objects—and the mixed GitHub Release state found by the
2026-07-26 audit: 62 exact published release identities and three exact absent
releases (`v0.1.622`, `v0.1.624`, and `v0.1.625`). It does not authorize
another range or state transition: a missing, changed, converted, unexpectedly
published, unexpectedly unpublished, or additional incomplete ref fails
closed. GitHub Latest and the changelog baseline remain `v0.1.619`; `v0.1.684`
is the historical version floor that the first canonical signed release must
exceed.

The command preflights `gh` authentication and Git signing, creates a signed
annotated tag for the exact application commit, requires `git verify-tag` to
cryptographically validate it under the local Git trust configuration before
any push, pushes the commit and tag atomically, requires the GitHub Git Data API to report
`verification.verified=true`, and dispatches `.github/workflows/release.yml`
with explicit `version`, `publish`, and unique `request_id` inputs. It then
finds the one workflow run bound to that request, the exact tag/head commit,
and the requested publish mode; waits for that run to reach terminal
`success`; and, for `publish=true`, runs the unauthenticated public release and
updater verifier before returning. It never builds or publishes a local
platform-specific artifact. The safe resume form is
`scripts/release.sh --resume X.Y.Z --publish=true`. Resume applies the same
exact-run binding and wait, and an already published version is not reported
as successful until the public verifier passes again.

Use `--publish=false` for a production-pipeline dry run. It still creates the
immutable signed tag and runs every native build, signing, verification,
provenance, and attestation gate, but retains a draft GitHub Release. Resume
does not duplicate an active or already-completed run. If a failed run left a
partial draft, the workflow compares existing assets byte-for-byte and uploads
only missing assets; published assets are immutable.

Draft promotion never trusts the draft's own mutable checksums as evidence of
origin. The workflow resolves the signed tag to its exact commit, selects a
completed successful workflow run whose `head_sha` is that commit, and requires
that run's unexpired, immutable `idacc-assembled-release` artifact. Promotion
downloads that artifact by its exact run ID and artifact ID, rechecks their API
association, validates the embedded release-index commit, and compares the
complete draft asset set byte-for-byte with the immutable artifact before
publishing. A missing or expired artifact disables the fast promotion path and
causes a full native rebuild; any draft mismatch fails closed.

`.github/workflows/release.yml` accepts only an existing immutable, signed
annotated `vX.Y.Z` tag whose version matches the application and whose
signature GitHub verifies. Lightweight and unsigned tags fail before checkout.
The IDACC repository must also provide `RELEASE_ADMIN_TOKEN` as a
**repository-level Actions secret**. It must be a fine-grained personal access
token or GitHub App token selected only for the IDACC repository with
read-only `Administration` access. GitHub's workflow token does not expose that
permission. The dedicated credential is used only to confirm that
GitHub-enforced immutable releases are enabled; release creation and asset
writes continue to use the workflow token.

The protected `production` environment must provide the signing and
notarization secrets:

- `MACOS_DEVELOPER_ID_P12`;
- `MACOS_DEVELOPER_ID_PASSWORD`;
- `MACOS_EXPECTED_TEAM_ID`;
- `MACOS_EXPECTED_SIGNING_IDENTITY`;
- `APPLE_API_KEY_P8`;
- `APPLE_API_KEY_ID`; and
- `APPLE_API_ISSUER`;
- `WINDOWS_CODESIGN_P12`; and
- `WINDOWS_CODESIGN_PASSWORD`; and
- `WINDOWS_EXPECTED_PUBLISHER_SUBJECT`.

`MACOS_EXPECTED_TEAM_ID` is the exact 10-character Apple team identifier.
`MACOS_EXPECTED_SIGNING_IDENTITY` is the exact electron-builder identity
qualifier: omit the `Developer ID Application:` prefix and end the value with
`(TEAMID)`. `WINDOWS_EXPECTED_PUBLISHER_SUBJECT` is the signing certificate's
exact full subject distinguished name, not only its common name. Production
preflight, packaging, and post-build verification fail closed when the
configured identity, packaged publisher, or actual signer differs.

The workflow signs and notarizes the application bundle, signs the outer DMG,
submits that DMG to Apple's notary service, staples its ticket, and validates
both its code signature and Gatekeeper acceptance. DMG updater metadata is
disabled because stapling changes the disk-image bytes; the signed and
notarized ZIP remains the macOS auto-update payload. The workflow also runs the
packaged clean-profile smoke test and emits this exact consumer installer
matrix:

- macOS arm64 DMG and ZIP;
- macOS x64 DMG and ZIP;
- Windows x64 EXE; and
- Linux x64 AppImage and DEB.

The Linux packaging gate extracts the actual AppImage, requires the exact
lockfile-pinned conditional launcher, and verifies that its packaged main
process starts with the matching fail-closed sandbox policy. It also inspects
the actual Debian data and control archives, requiring the exact root-owned
Chromium helper path, deterministic user-namespace/setuid post-install policy,
and pinned AppArmor profile before either artifact can be published.

Those seven installers are accompanied by:

- platform update descriptors and blockmaps;
- `SHA256SUMS`;
- one `release-manifest.json` per platform and architecture;
- a deterministic `release-index.json` mapping every artifact to its platform,
  architecture, runtime tree digest, and source manifest digest;
- the runtime lock and runtime manifest;
- a CycloneDX 1.6 SBOM; and
- third-party license notices.

SBOM and notice generation starts from the committed production lockfiles but
includes a package only when its directory exists in the exact installed tree
used for that native build. It also applies the desktop package's explicit
platform exclusions. Optional packages for another operating system or
architecture, excluded native bindings, and dev-only dependencies are therefore
not claimed as shipped; present transitive production packages remain included.
The resulting inventory is sorted by package identity for deterministic output.

The aggregate index is produced only after all native jobs have generated and
validated their own metadata:

```sh
node scripts/merge-release-metadata.mjs \
  --metadata metadata/darwin-arm64 \
  --metadata metadata/darwin-x64 \
  --metadata metadata/win32-x64 \
  --metadata metadata/linux-x64 \
  --output release-index
```

The merger rejects altered metadata, checksum disagreement, duplicate target
or artifact names, differing runtime locks, or differing application/component
provenance. Reversing its input order produces the same index bytes.

GitHub build-provenance and SBOM attestations are created before assets are
uploaded. An existing asset is accepted only when its bytes exactly match the
newly assembled output, and published releases cannot gain missing assets. The
workflow validates the complete seven-installer matrix and updater descriptor
semantics before publication, including the exact macOS ZIP, Windows EXE, and
Linux AppImage-plus-DEB records, their primary payloads, sizes, hashes, and
AppImage blockmap metadata. It downloads the release again and verifies every
checksum before the optional publish step.

A publish is complete only after the final job verifies the release through
GitHub's unauthenticated public API and public download URLs. It requires the
exact signed tag and commit to be GitHub-verified, public, immutable, and
`Latest`; verifies the public release Atom feed and web `/releases/latest`
discovery routes point to that tag; matches the complete asset set to
`SHA256SUMS` and GitHub's published digests; validates the release index and
all platform targets; and anonymously downloads and hashes all seven consumer
installers. It also validates the macOS, Windows, and Linux updater descriptors
and checks every referenced update payload's size, SHA-256, and SHA-512. No
maintainer credential is sent by this consumer-path verification.

Production workflows never use `--allow-dirty-application`; that switch exists
only for clearly marked local developer staging. CI and packaged-release
validation reject dirty application provenance.

Local capsule regeneration or the optional upstream audit fails while a
developer's Brain working tree contains changes. Manager staging likewise
requires a clean exact checkout. Those are intentional release boundaries; CI,
review, and production packaging verify the committed capsule and never read a
developer's Brain working tree.
