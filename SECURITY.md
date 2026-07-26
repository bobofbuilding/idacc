# Security Policy

## Supported Versions

This project ships continuous releases from `main` (see [CHANGELOG.md](CHANGELOG.md)
for version history). Only the latest published release is supported with
security fixes — please update before filing a report that may already be
resolved.

## Reporting a Vulnerability

Please do not open a public GitHub issue for a security vulnerability.

- Preferred: use GitHub's private vulnerability reporting for this repository
  (the **Security** tab → **Report a vulnerability**), if it is enabled.
- If that option isn't available to you, open a minimal GitHub issue stating
  that you have a security report without including exploit details, and a
  maintainer will follow up with a private channel to receive the full report.

Please include as much detail as you can: the affected component (IDACC
desktop, bundled Manager, bundled Brain, or the developer-only `idctl` client)
and version, reproduction steps, and potential impact. We will acknowledge
reports promptly and work with you on a fix and a coordinated disclosure
timeline before any public details are shared.

## Scope

This policy covers the unified IDACC consumer application, its pinned Manager
and Brain payloads, the developer-only `idctl` client, and the install/release
tooling in this repository. Vulnerabilities in third-party dependencies should
also be reported upstream if they affect this project's usage of them.
