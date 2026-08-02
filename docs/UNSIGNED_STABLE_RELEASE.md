# IDACC unsigned stable release

This owner-authorized stable release restores the unsigned distribution model
used by earlier public IDACC builds while retaining the current unified release
validation, provenance, updater-integrity, and cross-platform packaging gates.

The source tag is cryptographically signed and bound to the exact merged `main`
commit. The seven installer packages are not signed with Apple Developer ID or
Windows Authenticode certificates, and the macOS packages are not notarized.
macOS Gatekeeper and Windows SmartScreen may therefore display an operating
system warning before first launch.

The release contains IDACC, Agent Manager, and Brain as one application. It does
not contain a maintainer's goals, memory, projects, credentials, local database,
or application profile. Update descriptors and SHA-256/SHA-512 records bind the
public updater channel to the exact installer bytes in this release.
