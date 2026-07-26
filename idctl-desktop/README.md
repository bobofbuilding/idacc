# ID Agents Control Center — desktop

This package is the supported consumer desktop application. It combines the
React/Electron interface, pinned Agent manager, and pinned Brain into one
installable application.

For product behavior, privacy boundaries, supported platforms, and the full
release workflow, see the repository [README](../README.md) and
[release-provenance guide](../docs/RELEASE_PROVENANCE.md).

## Development

From the repository root:

```bash
npm ci --prefix idctl
npm ci --prefix idctl-desktop
npm run typecheck --prefix idctl-desktop
npm run start --prefix idctl-desktop
```

`npm start` creates a development bundle. It does not require a staged Manager
or Brain.

## Distributable builds

Release packaging requires clean source checkouts matching
`../release/runtime-lock.json`. Stage those exact sources first:

```bash
IDACC_MANAGER_SOURCE="$PWD/.runtime-sources/manager" \
IDACC_BRAIN_SOURCE="$PWD/.runtime-sources/brain" \
npm run stage:runtimes --prefix idctl-desktop

npm run verify:runtimes --prefix idctl-desktop
npm run build:release --prefix idctl-desktop
```

Native packages must be built on their target operating system:

```bash
# macOS (requires Developer ID and notarization credentials)
npm run release:mac --prefix idctl-desktop

# Windows (requires Authenticode credentials)
npm run release:win --prefix idctl-desktop

# Linux
npm run release:linux --prefix idctl-desktop
```

The AppImage target supports the unified in-app updater. Debian packages are
updated through the system package manager or by installing the next `.deb`;
the application reports that distinction instead of offering an unsupported
self-replacement.

The production GitHub workflow builds macOS arm64/x64, Windows x64, and Linux
x64 independently, verifies the clean-profile Manager/Brain startup, and
publishes only after every signing, payload, checksum, SBOM, and provenance gate
passes.

## Runtime and profile boundary

`resources/idacc-runtime` is generated and immutable. Its manifest is hashed
into the desktop main bundle, and every staged runtime file is re-hashed before
either service starts.

At runtime, all mutable state is redirected to the active IDACC profile:

- Manager database, workspaces, skills, plugins, and configuration;
- Brain database, memory, living plans, and generated state;
- goals, local plans, chats, questions, learning records, and caches; and
- credentials, Computer Use state/audits, and service logs.

No profile data belongs in the application bundle or a release artifact.

## Process architecture

```text
React renderer
    │ trusted, allowlisted IPC
Electron main
    ├── verified Agent manager child ── random 127.0.0.1 port
    │       └── Brain-skilled agents ── private stdio MCP ──────┐
    ├── verified Brain child ────────── random 127.0.0.1 port ◀─┤
    ├── managed event listener ──────── Manager events → Brain ┤
    └── scheduled Brain cycle ───────── non-overlapping one-shot┘

Profile-owned Manager skills ────────── Brain searchable skill index
```

The renderer is sandboxed with Node integration disabled. Manager control
operations require a per-launch in-memory bearer that is never sent to Brain,
companions, or agents. A separate Brain credential is confined to Manager's
Brain transport, app-owned companions, and the private MCP process attached only
to agents configured with the Brain skill. Core services and the continuous
listener are supervised with health/liveness checks, bounded logs, restart
backoff, a crash fuse, and graceful shutdown. POSIX services run in app-owned
process groups; Windows services run inside per-service Job Objects whose
kernel-enforced lifetime remains bounded even if a service or the desktop
process crashes. A single-instance lock is acquired before profile selection,
migration, or crash-state persistence. A secondary launch never starts services
or mutates a profile; it restores and focuses the existing primary window unless
that instance is already shutting down. Every quit, relaunch, and update-install
path passes through one early shutdown gate before Electron is allowed to exit.
New work is refused synchronously, and already-admitted startup/background work
shares a 45-second aggregate drain deadline before process trees stop. A missed
deadline fails closed into a generic Retry Shutdown dialog; no force-exit,
restart, or update bypass is offered. The deterministic
maintenance cycle is off on a fresh profile and starts only after explicit
opt-in in Settings. Once enabled, its schedule is stored in the profile and
can be changed or disabled without disabling event learning.

During an orderly quit, IDACC confirms that every bundled process group has
stopped before Electron exits. On POSIX, bundled roots also watch the desktop
parent and request self-shutdown after an abrupt parent exit; this is a
best-effort safeguard rather than the Windows Job Object's kernel guarantee.
Manager schedules and the opt-in maintenance cycle run only while IDACC is
open, then resume from profile-owned state after the next launch. The consumer
application does not install a separate background service.

Loopback services share the current operating-system user's trust boundary;
random ports do not isolate IDACC from hostile same-user processes. The exact
protected and intentionally agent-accessible surfaces are documented in the
repository's [local security model](../docs/SECURITY_MODEL.md).

## Key verification commands

```bash
npm run typecheck
npm run test:profile-migrations
npm run test:brain-plans-profile
npm run test:consumer-onboarding
npm run test:consumer-onboarding-integration
npm run test:unified-stack-policy
npm run test:unified-stack-integration
npm run test:runtime-profile-isolation
npm run test:legacy-manager-updater-retired
npm run test:release-provenance
npm run test:release-platform-config
```
