# IDACC unsigned stable release

This owner-authorized stable release restores the unsigned distribution model
used by earlier public IDACC builds while retaining the current unified release
validation, provenance, updater-integrity, and cross-platform packaging gates.

## Recorded owner authorization

On 2026-08-12, the repository owner authorized unsigned **stable** IDACC
application packages for every supported platform. This authorization remains
in effect for future stable releases unless the owner explicitly revokes or
supersedes it in this source-controlled record. Each release must still use an
exact GitHub-verified signed source tag, the full installer matrix, immutable
release assets, updater-descriptor verification, and the explicit unsigned
publication acknowledgement required by the Production release workflow.

The source tag is cryptographically signed and bound to the exact merged `main`
commit. The seven installer packages are not signed with Apple Developer ID or
Windows Authenticode certificates, and the macOS packages are not notarized.
macOS Gatekeeper and Windows SmartScreen may therefore display an operating
system warning before first launch.

The release contains IDACC, Agent Manager, and Brain as one application. It does
not contain a maintainer's goals, memory, projects, credentials, local database,
or application profile. Update descriptors and SHA-256/SHA-512 records bind the
public updater channel to the exact installer bytes in this release.
