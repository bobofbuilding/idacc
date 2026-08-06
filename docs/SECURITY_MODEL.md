# IDACC local security model

IDACC is a single-user desktop application. Its Electron renderer, Manager, and
Brain run under the same operating-system account and store state in that
account's private application profile.

## Protected boundaries

- Manager and Brain bind only to ephemeral `127.0.0.1` ports; they are not
  reachable from another host.
- The desktop creates fresh in-memory credentials on every launch. Privileged
  Manager administration routes require the Manager-only bearer credential,
  while Manager-to-Brain requests use a separate shared credential.
- Neither credential is written to the desktop's ambient process environment.
  Unrelated provider tools, Git hooks, diagnostics, model servers, and
  user-configured subprocesses launch from an environment with IDACC runtime
  bearer credentials removed.
- The Manager administration credential is never given to Brain, app-owned
  Brain companions, the renderer, or spawned agents.
- The narrower Brain credential is given to Brain, Manager, and the app-owned
  listener/maintenance companions. For an agent whose configured skills include
  Brain, Manager deliberately carries it only inside that worker's private MCP
  attachment configuration and the auto-attached Brain MCP process environment;
  it is never a standalone `BRAIN_TOKEN` in the worker environment. It is not
  placed in the renderer payload, process arguments, or stack status. The
  curated MCP exposes Brain reads plus bounded feedback and approval requests;
  it does not expose Brain's broad internal mutation routes.
- Profile directories and secret-bearing files are created with owner-only
  permissions where the operating system supports POSIX modes.
- The renderer is sandboxed, has no Node integration, and can use only the
  allowlisted IPC bridge from the trusted application document.
- Linux review and production entry points enable Electron's sandbox before
  bundled application modules load and fail closed if a sandbox-disabling
  switch is present. The Debian installer uses its pinned user-namespace probe
  to configure the Chromium sandbox helper and conditionally installs the
  pinned AppArmor profile when AppArmor is enabled with the supported ABI;
  release gates inspect those files and scripts from the built package.
- Bundled Manager and Brain files are verified against the signed application's
  runtime manifest before either service starts.
- Managed roots and their descendants have an operating-system lifetime
  boundary independent of the root's continued health: retained process groups
  on POSIX and kill-on-close Job Objects on Windows. A replacement is not
  started unless cleanup of the prior boundary is confirmed.
- Quit, relaunch, and update installation share one early shutdown coordinator.
  It rejects new renderer work, stops background loops, and completes bounded
  process-tree cleanup before Electron hands control to the operating system or
  updater.

## Same-user trust boundary

Loopback binding and random ports are not a sandbox against other software
running as the same operating-system user. Some read and normal operational
Manager routes, and some Brain read routes, intentionally remain available to
local agents without the desktop's administration bearer. A hostile same-user
process can inspect local processes, connect to loopback services, or read files
that the operating system account itself can read.

Accordingly, IDACC does not claim isolation from malicious software already
executing as the same user. Do not run untrusted local programs, skills,
plugins, MCP servers, model servers, or agent runtimes in an IDACC profile. Use
a separate operating-system account, virtual machine, or container boundary
when mutually untrusted workloads must share a computer.

Random ports prevent stale developer services and accidental fixed-port
collisions from impersonating the bundled stack. They are not an authentication
mechanism.

## External services and extensions

Provider CLIs, model servers, MCP servers, WalletConnect, RPC endpoints, skills,
and plugins are outside the signed core application once a user enables or
installs them. IDACC preserves explicit configuration and applies its own
permission checks where available, but users must review those components and
their network/data policies independently.

Live root-Safe signing is disabled until the user explicitly configures a root
authority. Local mock identity state is simulation data and cannot authorize an
on-chain transaction.

## Reporting a vulnerability

Do not include credentials, private profile data, wallet material, or personal
paths in a public report. Provide the affected IDACC version, operating system,
reproduction steps using synthetic data, and the expected versus observed
boundary.
