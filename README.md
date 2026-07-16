# ID Agents Control Center

A standalone **control center** for an [id-agents](https://github.com/idchain-world/id-agents)
manager — the multi‑agent orchestration platform that runs a team of AI coding
agents (Claude Code CLI, OpenAI Codex, Cursor CLI, …) as real processes behind a
daemon on `:4100`.

This repo ships **two front‑ends over the same backend**, so you can drive a
running fleet visually instead of by chat command:

| Package | What it is | Build target |
|---|---|---|
| [`idctl-desktop/`](idctl-desktop) | A **desktop GUI** — a real mouse‑and‑keyboard window (Electron + React). | `ID Agents Control Center.app` |
| [`idctl/`](idctl) | A **terminal app** — a reactive full‑screen TUI (no browser, single binary). | `idctl` (bun‑compiled) |

Both are **pure HTTP clients** of the manager daemon. They never edit the
id-agents repo or touch its database directly, so they're safe to run alongside a
live team. They share one backend layer (the manager API client, settings, and
key management), so a feature added once shows up in both shells.

---

## How this relates to `id-agents` (the difference)

**`id-agents` is the platform. This is the control surface for it.** The split is
the same one you see between a server and its admin client:

> control‑center is to id-agents what `kubectl`/Lens is to Kubernetes, or
> `psql`/a database GUI is to Postgres — a decoupled client you point at a
> running instance, not the instance itself.

| | **[id-agents](https://github.com/idchain-world/id-agents)** (upstream) | **id-agent-control-center** (this repo) |
|---|---|---|
| **Role** | The orchestration **platform / server** | A **control client** for it |
| **Runs the agents?** | Yes — spawns & supervises each agent as a real OS process (Claude Code / Codex / Cursor) | No — it only observes and commands a running manager |
| **Owns state?** | Yes — the manager daemon (`:4100`), SQLite DB, agent workspaces, the task/scheduling engine, onchain identity & wallets | No — keeps only its own local UI config (`~/.config/idctl/config.json`); reads everything else live from the manager |
| **Primary interface** | Headless: chat CLI, Telegram, SSH, `/remote` + `/tasks` REST | Visual: a clickable desktop window **and** a keyboard‑driven TUI |
| **Talks to it via** | — | The manager's HTTP API (`/agents`, `/events`, `/remote`, `/query`, …) on `:4100` |
| **Touches the id-agents repo?** | It *is* the repo | Never — read/command only, safe to run against a live fleet |

In short: install and run a team with **id-agents**, then open
**id-agent-control-center** to watch and steer it.

> **Manager compatibility.** The control center talks to the manager purely over
> HTTP and never modifies it — but some panels call manager endpoints that a
> **stock or older upstream id-agents may not expose yet**: skills
> install/create/uninstall, plugins, MCP attach, per‑agent instructions, runtime
> switch, cross‑team relay delegates, and local‑model usage/activity. Against a
> manager without those routes, the affected actions report *"requires a newer
> id-agents manager"* and the rest of the app keeps working — the live dashboard,
> manager chat, teams, tasks, health, schedule, and identity panels run against
> any current manager. Point it at a manager that includes those routes to use
> the full feature set. Settings keeps manager connection, local runtime,
> inference-backend, and compatibility checks in the relevant cards instead of a
> separate first-run checkpoint; if a manager extension route is missing, use the
> manager diagnostics exposed there to capture the manager URL, reported API
> version, extension id, missing features, and missing routes before updating or
> swapping the manager.

### What the control center adds on top of the raw manager

The manager exposes the capability; the control center makes it *operable* —
discoverable, clickable, and validated — and layers on operator conveniences the
headless platform doesn't ship a UI for:

- **Live fleet dashboard** — every agent's status / runtime / model, polled
  continuously, with a live activity feed off the manager's `/events` stream.
- **Manager chat** — a conversational pane that dispatches to the team's `lead`
  agent and streams the reply (so it can fan work out to the workers).
- **Teams** — switch teams, create a team from the default template, an
  **add‑agent** form, and **cross‑team relay** policy (which teams an agent may
  delegate to via `/ask <team>/<agent>`), with per‑agent overrides.
- **Capabilities** — attach **MCP servers** (from a curated catalog, with a live
  connection **Test**), install **skills**, and view **plugins**, assignable to
  one or many agents/teams at once. *(Needs a manager exposing the library/MCP
  endpoints — see Manager compatibility above.)*
- **Inference backends** — connect Ollama, LM Studio, any OpenAI‑compatible
  server, Anthropic, or OpenAI; **discover their models live**; validate runtime ↔
  model pairings and switch a running agent's runtime/model from the dashboard.
- **Subscriptions** — see and refresh the OAuth sign‑in state of the runtimes
  that use your *subscription* (Claude / ChatGPT) rather than a metered API key.
- **Inbox · Tasks · Health · Schedule · Identity & Keys** — answer questions the
  manager is blocked on; create/claim/assign/complete tasks; probe agent health;
  manage heartbeats and recurring calendar check‑ins; and per‑agent ENS / ID Chain
  / OWS wallet, Safe smart account, and scoped (optionally non‑expiring) ERC‑4337
  session keys. *(Identity & Keys runs on a simulated key provider today — the
  real OWS / Safe‑4337 signing backend is the planned swap.)*
- **Self‑update** — the desktop app can check a release manifest, stage an update,
  and relaunch into the new version.

---

## Quick start

The supported macOS install builds IDACC, installs the app in `~/Applications`,
installs or safely updates the compatible manager fork beside this checkout,
and keeps that manager running as a per-user service:

```bash
git clone https://github.com/bobofbuilding/idacc.git ~/Projects/idacc-stack/idacc
cd ~/Projects/idacc-stack/idacc
node scripts/install-idacc-stack.mjs
```

The installer requires Node.js 20 or newer. It preserves existing IDACC
settings, refuses dirty or foreign manager checkouts, performs only
fast-forward manager updates, atomically replaces the app bundle, and refuses
to take over an unknown process on the manager port. Preview every action first
with `node scripts/install-idacc-stack.mjs --dry-run`.

After launch, open Settings and confirm the Connection, Local models &
backends, and Inference backends cards. The app can observe a stock manager,
but the full downloadable control-center experience needs a manager that
advertises the Control Center extension contract via `GET /capabilities`. Some
panels need those manager routes — see **[Manager compatibility](#how-this-relates-to-id-agents-the-difference)** above.

### Desktop GUI

```bash
cd idctl-desktop
npm install        # first time
npm start          # build + launch the window

npm run dist       # → release/.../ID Agents Control Center.app  (double‑clickable)
```

### Terminal TUI

```bash
cd idctl
npm install        # first time
npm start          # launch the TUI (needs a real terminal)
npm run status     # one‑shot, scriptable snapshot (no TTY needed)
```

> The two packages live as **siblings** in this repo on purpose: `idctl-desktop`
> imports the shared backend from `../idctl/src/…`. Keep them side‑by‑side.

### Install or update only the manager source

If you want a local manager checkout that matches the maintained IDACC-compatible
fork, use the guarded installer:

```bash
node scripts/install-id-agents-manager.mjs --project-dir ~/Projects/idacc-stack
```

This installs or fast-forwards `~/Projects/idacc-stack/id-agents` from
`https://github.com/bobofbuilding/id-agents.git`. It refuses to overwrite a
non-empty non-git folder, refuses dirty worktrees, refuses foreign remotes unless
you pass `--allow-foreign`, and uses `git merge --ff-only` so local commits are
not rewritten. Preview first with:

```bash
node scripts/install-id-agents-manager.mjs --project-dir ~/Projects/idacc-stack --dry-run
```

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MANAGER_URL` | `http://127.0.0.1:4100` | manager daemon base URL |
| `ID_TEAM` | *(manager default)* | active team (sent as `X-Id-Team`) |
| `IDCTL_CONFIG` | `~/.config/idctl/config.json` | UI config file path |
| `IDCTL_REFRESH_MS` | `3000` | fleet poll interval |

No secrets are baked into the repo. Manager URLs, teams, and any API keys you
enter are stored only in your local `~/.config/idctl/config.json` (file mode
`0600`), never in the source tree.

---

## Architecture

```
 Desktop GUI (Electron)              Terminal TUI (idctl)
 ┌──────────────────────┐           ┌──────────────────────┐
 │ React renderer (DOM)  │           │ Ink renderer (TTY)    │
 │   App · views/*       │           │   App · views/*       │
 └─────────┬────────────┘           └─────────┬────────────┘
           │ IPC bridge                        │
 ┌─────────▼────────────┐           ┌─────────▼────────────┐
 │ Electron main (Node)  │           │ idctl process (Node)  │
 └─────────┬────────────┘           └─────────┬────────────┘
           │                                   │
           └───────────── shared backend ──────┘
                  idctl/src: ManagerClient · settings · keys
                                   │ HTTP
                          ┌────────▼─────────┐
                          │  id-agents        │
                          │  manager  :4100   │   ← separate repo (upstream)
                          └──────────────────┘
```

- `idctl/src/api`, `idctl/src/settings`, `idctl/src/keys` — the shared backend:
  the manager HTTP client, inference‑backend/provider settings, and the pluggable
  `KeyProvider`. Imported by **both** shells.
- `idctl-desktop/src/{main,preload,renderer}` — Electron main + IPC bridge +
  React UI. The backend runs in the main process (Node, no CORS, secrets off the
  UI) and is exposed to the window over a small allow‑listed bridge.
- `idctl/src/{app,components,views,cli.tsx}` — the Ink TUI.
- `idctl-desktop/src-tauri` + `idctl-desktop/src/tauri` — an **experimental,
  parked** Tauri shell (the renderer is transport‑pluggable). Electron is the
  supported desktop build today.

See each package's own README ([`idctl-desktop`](idctl-desktop/README.md) ·
[`idctl`](idctl/README.md)) for keybindings, build details, and inference‑backend
setup.

---

## Acknowledgements & license

Built for and against the [id-agents](https://github.com/idchain-world/id-agents)
manager by [idchain-world](https://github.com/idchain-world). This is an
independent client; it depends on a running manager but vendors none of its code.

Licensed under the MIT License — see [LICENSE](LICENSE).
