# ID Agents Control Center

ID Agents Control Center (IDACC) is a unified desktop workspace for running and
coordinating private AI-agent teams. The consumer application includes the
desktop interface, Agent manager, and Brain together; a new user does not need a
separate manager or Brain checkout.

## What ships

| Component | Responsibility | Distribution |
|---|---|---|
| IDACC desktop | Dashboard, chat, teams, tasks, goals, plans, settings, onboarding, and updates | Electron application |
| Agent manager | Runs agents, work, schedules, teams, and the control API | Immutable bundled runtime |
| Brain | Memory, learning, graph, plans framework, and dashboards | Immutable bundled runtime |

The exact Manager and Brain source commits, dependency locks, entry points, and
per-file hashes are recorded in `release/runtime-lock.json` and the generated
runtime manifest. Release builds refuse dirty or mismatched runtime sources.
That machine-readable lock is the source of truth for every release; the README
does not maintain a second, potentially stale copy of the runtime versions.

The `idctl/` terminal interface remains available for developers and advanced
operators, but it is not required for the consumer desktop application.

## Private data is not part of the application

IDACC separates immutable application code from the active profile:

- goals, plans, questions, chats, dreams, learning queues, and work records;
- Brain databases, memory, living Brain Plans, and generated state;
- Manager database, workspaces, installed skills, plugins, and configuration;
- Computer Use sessions, tokens, audit history, logs, and caches; and
- provider, RPC, MCP, and application settings.

These live under the operating system's IDACC user-data directory in
`profiles/default` (or the selected profile). They are never staged into a
release. Existing legacy `~/.config/idctl` data is copied once by versioned,
rollback-safe migrations; the original data is retained as a backup.

Release payload checks explicitly reject Brain databases, living plans, goals,
sessions, Learn material, and Electron user data. Context and Computer Use
history also have bounded age, file-count, and size retention.

## Install and first run

Use [Download the latest IDACC release](https://github.com/bobofbuilding/idacc/releases/latest)
to open the verified public release and choose the installer for your platform.

Production releases provide:

- macOS DMG and ZIP for Apple Silicon and Intel;
- Windows x64 NSIS installer; and
- Linux x64 AppImage and Debian package.

Download the artifact for the current release, install it normally, and open
IDACC. On first launch, IDACC:

1. verifies and starts its bundled Manager and Brain on private random loopback
   ports;
2. lets you connect an existing subscription CLI, a local model server, or an
   API provider, while clearly identifying which verified routes can expose the
   Brain MCP required by the starter workspace. Claude/Codex routes are proven
   at the runtime level; each Ollama starter model must report `tools` through
   the bounded native `/api/show` check. Other provider models remain available
   for general agents but are not presented as starter-ready without
   deterministic tool-capability evidence;
3. validates the live model route before creating anything;
4. preserves existing agents and creates only missing starter roles; and
5. verifies the lead, coder, researcher, hierarchy, instructions, and health
   gates before declaring the workspace ready.

If a provider or service is unavailable, setup remains retryable and can enter
limited mode so Settings and diagnostics stay accessible.

The bundled Manager, Brain, listener, agents, and scheduled workers are
supervised children of IDACC and stop when the application exits. Recurring
work resumes from profile-owned state on the next launch; IDACC does not install
a background daemon or promise execution while the application is closed.

IDACC allows one consumer application instance per operating-system user. It
acquires that lock before selecting or migrating a profile. Opening IDACC again
restores and focuses the existing window; the secondary process does not touch
profile data. During quit, restart, or update installation, new work is refused
and admitted startup/background work shares a 45-second drain deadline. If
cleanup cannot be confirmed, IDACC stays open and offers a guarded retry instead
of forcing an exit or applying an update over live local services.

Provider subscription CLIs are intentionally not bundled. IDACC can detect and
open visible vendor install/sign-in flows, but provider credentials stay with
the provider tooling. API secrets entered in IDACC are handled in the desktop
main process and encrypted with secure operating-system credential storage;
IDACC refuses Electron's weak Linux `basic_text` fallback.

## One update authority

IDACC, Manager, and Brain update together. There is no standalone Manager
installer or background Manager updater in the application.

The desktop updater:

- reads only the compiled `bobofbuilding/idacc` GitHub release feed;
- rejects downgrade and prerelease updates;
- verifies electron-builder hashes and platform signatures where supported;
- when auto-download is off, requires **Check IDACC** followed by the explicit
  **Download update** action and reports download progress;
- shares concurrent download requests and drains an active download before
  application shutdown; and
- installs only after the user chooses **Restart & update**.

macOS and Windows production jobs require signing credentials and verify the
resulting signatures. macOS additionally requires notarization, Gatekeeper
acceptance, and staple validation. Linux artifacts ship with release checksums,
SBOMs, and build-provenance attestations. Linux in-app replacement is available
only for the AppImage build; Debian-package installs update through the system
package manager or by installing the newer `.deb`.

Linux review and production builds enable Electron's sandbox before bundled
application modules load and refuse to continue when `--no-sandbox` or
`--disable-setuid-sandbox` is present. On hosts without usable unprivileged user
namespaces, use the Debian package: its pinned install script configures the
Chromium sandbox helper and, when AppArmor is enabled with the supported ABI,
its pinned AppArmor profile for that host. Release automation extracts and
verifies both the AppImage launcher and the Debian package policy.

## Main features

- live fleet health, activity, routing, and Manager chat;
- team creation, hierarchy, delegation, and independent validation roles;
- Inbox, Tasks, Work, schedules, recurring check-ins, goals, and Brain Plans;
- Brain memory, learning, graph, dashboards, and governed promotion into work;
- local, subscription, and API model routes with live assignment preflight;
- skills, portable plugins, MCP servers, scoped keys, wallets, and chain RPCs;
- macOS Computer Use with explicit authority, supervision, panic controls, and
  retained local audit records; and
- automatic crash recovery, bounded logs, limited mode, and clean-profile
  diagnostics.

Computer Use input control is currently macOS-only. Windows and Linux builds
remain fully usable for the other features and report that capability as
unavailable instead of failing startup.

## Development

The pinned toolchain is Node 22.17 and npm 10.9.

```bash
npm ci --prefix idctl
npm ci --prefix idctl-desktop
npm run typecheck --prefix idctl-desktop
npm run build --prefix idctl-desktop
```

The normal development build can run without staged runtimes. A distributable
build requires a clean Manager checkout matching `release/runtime-lock.json`.
The exact Brain runtime is already committed as a verified, consumer-safe
capsule, so building does not require a Brain checkout or private
runtime-source credential:

```bash
node scripts/validate-runtime-lock.mjs \
  --manager-source .runtime-sources/manager

IDACC_MANAGER_SOURCE="$PWD/.runtime-sources/manager" \
npm run stage:runtimes --prefix idctl-desktop

npm run build:release --prefix idctl-desktop
npm run verify:runtimes --prefix idctl-desktop
```

Publishers with private Brain access can optionally add
`--brain-source .runtime-sources/brain` to the validation command to compare
the capsule with its pinned upstream revision.

Native packages must be built on their target operating system because the
Manager includes a native SQLite module. The production workflow rebuilds it for
each Electron/OS/architecture combination before packaging. Windows builds
also require Visual Studio Build Tools with the Roslyn Compiler component and
.NET Framework 4.8 targeting pack; the build discovers them through `vswhere`
and verifies byte-identical native-helper output.

Useful release gates include:

```bash
npm run test:release-provenance --prefix idctl-desktop
npm run test:release-platform-config --prefix idctl-desktop
npm run test:unified-stack-policy --prefix idctl-desktop
npm run test:unified-stack-integration --prefix idctl-desktop
npm run test:release-payload --prefix idctl-desktop
```

See `docs/RELEASE_PROVENANCE.md` for the immutable build, SBOM, checksum,
attestation, signing, and publishing process.

## Architecture

```text
┌──────────────── unified IDACC application ────────────────┐
│ React renderer → narrow IPC bridge → Electron main       │
│                                      │                    │
│                   verified random loopback services       │
│                         ├─ Agent manager                  │
│                         ├─ Brain                          │
│                         ├─ Brain event listener           │
│                         └─ opt-in scheduled Brain cycle   │
└───────────────────────────────────────────────────────────┘
                         │
             app-owned profile (outside the bundle)
  goals · plans · memory · databases · skills · cursors · logs
```

The renderer is sandboxed with Node integration disabled and a restrictive
content-security policy. IPC accepts only the main trusted local document.
Bundled runtime files are checked against the manifest digest compiled into the
application and then re-hashed in full before either child process starts.
Manager control routes also require an in-memory bearer credential in addition
to loopback/admin checks; that credential is never passed to Brain, companions,
or agents. A separate Brain credential is scoped to Manager's Brain transport,
the app-owned Brain companions, and the curated MCP attachment for agents
configured with the Brain skill.

IDACC is a single-user local application, not a sandbox against hostile
software already running as the same operating-system user. Random loopback
ports prevent accidental service collisions; they are not authentication.
Normal agent-facing Manager operations and some Brain reads remain available to
local agents. See the [local security model](docs/SECURITY_MODEL.md) for the
precise trust boundary and guidance for isolating mutually untrusted workloads.

## License

Licensed under the MIT License. See `LICENSE`.
