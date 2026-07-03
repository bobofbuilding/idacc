# idctl — ID Agents Control Center

A standalone, reactive **terminal app** for the
[id-agents](https://github.com/idchain-world/id-agents) manager. No browser. It's a
pure HTTP client of the manager daemon on `:4100` — it never edits the id-agents
repo, so it's safe to run alongside a running team. It ships as a single
self-contained binary (no Node required to run it).

> This is the TUI half of [id-agent-control-center](../README.md); the
> [`../idctl-desktop`](../idctl-desktop) sibling is the Electron GUI and shares
> this backend.

Headline features, plus everything the manager exposes:

- **Live fleet dashboard** — every agent's status / runtime / model, refreshed
  continuously, with a live activity feed off the manager's `/events` stream.
- **Talk to the manager** — a conversational chat that dispatches to the team's
  manager agent (`lead`) and streams the reply, so it can fan work out to the
  workers and answer you.
- **Settings** — connect managers and inference backends (Ollama, LM Studio,
  any OpenAI-compatible server, Anthropic, OpenAI), discover their models, and
  assign a model to an agent — all from the TUI. See [Inference backends](#inference-backends).

## Install (download & run, no Node)

> Prebuilt binaries are published as GitHub Releases. Until a release is cut for
> this repo, [build from source](#run-from-source) or [build the binaries
> yourself](#build-the-standalone-binaries). Point the installer at any repo with
> `IDCTL_REPO=owner/repo`.

```bash
# One-liner installer (downloads the right binary for your OS/arch):
curl -fsSL https://github.com/bobofbuilding/id-agent-control-center/releases/latest/download/install.sh | sh
idctl --help
```

The installer drops a self-contained `idctl` into `~/.local/bin`. macOS binaries
are ad-hoc codesigned; the installer clears the download quarantine.

**macOS app (double-click).** `npm run build:app` produces
`dist/ID Agents Control Center.app` — a real `.app` bundle (Dock/Finder/Launchpad
icon, the Bob brand icon) with the standalone binary bundled inside. Double-click
opens the TUI in a Terminal window; drag it to `/Applications` like any app. No
Node, no install step. (Ad-hoc signed; for public distribution, sign with a
Developer ID + notarize so Gatekeeper opens it without a right-click → Open.)

## Run from source

```bash
cd idctl
npm install            # first time only
npm start              # launch the TUI (needs a real terminal)

# one-shot, scriptable snapshot (no TTY needed — great for pipes/CI):
npm run status
npm run status -- --json
idctl --team skillmesh # pin a team   ·   idctl --manager http://127.0.0.1:4100
```

## Build the standalone binaries

Binaries are produced with [bun](https://bun.sh)'s `--compile` (build-time only;
the binary is dependency-free). idctl is pure-ESM, so this is the one packager
that handles its top-level-await deps + inline-WASM and cross-compiles every
target from one host.

```bash
curl -fsSL https://bun.sh/install | bash      # one-time build tool
bun install
npm run build:bin                              # → dist/idctl-<os>-<arch> (all targets)
npm run build:bin -- darwin-arm64              # or just one target
# macOS Gatekeeper: codesign --deep --force --options runtime \
#   --entitlements build/entitlements.plist --sign - dist/idctl-darwin-*
cd dist && shasum -a 256 idctl-* > SHASUMS256.txt
```

`npm run build:mjs` produces a Node-20+ fallback (`dist/idctl.mjs`) for users who
already have Node.

## Keys

| Key | Action |
|-----|--------|
| `1`–`9` / `0` / `Tab` | switch view (`0` = Settings) |
| `r` | force refresh |
| `t` | switch team |
| `?` | help overlay |
| `q` / `Ctrl-C` | quit |

Per-view:

- **Dashboard** — `↑↓` pick an agent, `Enter` for the action menu (start / stop /
  rebuild / probe / change model / delete). Destructive actions confirm.
- **Chat** — type to the manager, `Enter` to send, `@name …` to address a
  specific agent (`@*` broadcasts), `Esc` to drop to navigation, `i` to type
  again.
- **Inbox** — questions the manager is blocked on; `Enter` to answer.
- **Tasks** — `n` new · `c` claim · `a` assign · `d` done.
- **Health** — `p` probe all · `Enter` probe selected.
- **Identity & Keys** — per agent: ENS / ID Chain / OWS wallet, plus a **Safe
  smart account** and scoped **ERC-4337 session keys**. `g` register · `c` create
  account · `D` deploy · `k` issue a scoped/expiring session key · `x` revoke.
  Backed by a pluggable `KeyProvider` — a persisted local **mock** today (so the
  flow is testable with no bundler/testnet), swappable for a real Safe4337 +
  bundler provider with no view changes.
- **Schedule** — `Enter` toggles an agent's heartbeat; check-ins on the right.
- **Config** — `s` sync · `D` deploy active team (confirmed) · `N` new team (from
  the default template) · `L` load an existing/other team · `t` switch.
- **All Teams** — cross-team health (online/offline + runtime mix per team);
  `Enter` makes that team active and opens it in the Dashboard.
- **Settings** (`0`) — `m`/`p`/`a` switch panes. **Managers**: `Enter` connects
  to a saved manager · `n`/`e`/`x`. **Providers**: `Enter` probes a backend
  (liveness + model discovery) · `n`/`e`/`x` · `space` enable · `d` default.
  **Assign**: pick a discovered model, then an agent — `Enter` assigns (restart
  to apply), `R` assigns and restarts now.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `MANAGER_URL` | `http://127.0.0.1:4100` | manager daemon base URL |
| `ID_TEAM` | *(manager default)* | active team (sent as `X-Id-Team`) |
| `IDCTL_CONFIG` | `~/.config/idctl/config.json` | config file path |
| `IDCTL_REFRESH_MS` | `3000` | fleet poll interval |

Connection precedence: `--manager`/`--team` flags → `MANAGER_URL`/`ID_TEAM` env →
the saved default manager profile → built-in `http://127.0.0.1:4100`. `localhost`
is normalized to `127.0.0.1` to dodge the macOS IPv6 (`::1`) trap where another
dev server can shadow the manager on the same port.

```bash
idctl config     # show the resolved config path + saved profiles
idctl init       # create an empty config file
```

### Config file

Stored at `~/.config/idctl/config.json` (XDG; same on macOS & Linux), directory
`0700`, file `0600`. Holds `managers[]` (name/url/team/apiKey) and `providers[]`
(name/kind/baseUrl/apiKey/enabled/default). API keys are plaintext at `0600`
(like aws/gh) and may instead come from env: `IDCTL_<NAME>_API_KEY`, or the
standard `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Keys are masked in all output.

### Inference backends

The Settings → Providers pane probes each backend for liveness and lists its
models (verified shapes):

| kind | endpoint | model id | auth |
|------|----------|----------|------|
| `ollama` | `GET {base}/api/tags` | `.models[].name` | none |
| `lmstudio` | `GET {base}/v1/models` | `.data[].id` | none |
| `openai-compatible` | `GET {base}/v1/models` | `.data[].id` | Bearer (if key) |
| `anthropic` | `GET {base}/v1/models` | `.data[].id` | `x-api-key` + `anthropic-version` |
| `openai` | `GET {base}/v1/models` | `.data[].id` | Bearer |

The Assign pane writes the chosen model onto an agent via the manager
(`POST /agents/:id/model`). **Three limits the manager imposes over HTTP, surfaced
inline:** a model change is not live until the agent **restarts**; only local
runtime-backed agents (`type: claude`, incl. `ollama`) accept a model; and idctl
cannot change an agent's **runtime** or the manager's **`OLLAMA_BASE_URL`** —
those are creation-time / manager-env concerns.

## Teams

idctl ships **scoped to the default team** — the team id-agents ships in the repo
(`configs/default.yaml`: `coder` + `researcher`). Out of the box it shows only
that team, not whatever else a manager happens to have. Two config fields drive
this (`config.json`):

| field | default | meaning |
|-------|---------|---------|
| `defaultTeam` | `default` | team idctl scopes to on startup |
| `knownTeams` | `["default"]` | teams shown in the switcher / All Teams; `null` = show all |

Adding teams (all over the manager's existing HTTP API — no repo edits):

- **Switch / reveal** — press `t`; `a` toggles "show all" so you can pick any
  team the manager has (e.g. `skillmesh`) and add it to your known list.
- **New team** — Config view → `N`: type a name; idctl runs `/deploy <name>`,
  which the manager resolves to `configs/<name>.yaml` or, when absent, **clones
  `configs/default.yaml`** with that name — a fresh `coder`+`researcher` team.
- **Load team** — Config view → `L`: pick an existing manager team (reveal, no
  redeploy) or a server-side config (`/deploy <config>`, e.g. `skillmesh-team`).

To present every team unconditionally, set `knownTeams` to `null` in the config.

## Self-update

idctl keeps itself current. While the TUI is running, a background check (every
`checkIntervalHours`, default 12) notices a newer GitHub release and shows a
status-bar banner; with `autoUpgrade` on (default) it downloads + verifies the
new binary and stages it. Applying the staged update still requires the explicit
upgrade/restart action. Only compiled binaries self-update; running from source
(tsx) is a no-op.

```bash
idctl upgrade            # check, download, verify, stage (applied next launch)
idctl upgrade --check    # report only; exit 10 if an update is available
```

`update` config block (in `config.json`):

| field | default | meaning |
|-------|---------|---------|
| `autoUpgrade` | `true` | download and stage a found update; applying it is explicit |
| `updateRepo` | `bobofbuilding/id-agent-control-center` | GitHub `owner/name` to poll |
| `updateManifestUrl` | *(unset)* | self-hosted `version.json` URL; used instead of GitHub |
| `checkIntervalHours` | `12` | background check cadence |

Safety: the download is **sha256-verified** against `SHASUMS256.txt` (and
checked for a valid Mach-O/ELF magic) before anything is staged; the swap is an
atomic rename with the old binary kept as `.idctl.bak`; the new binary must pass
a 5-second health probe or it's **rolled back**; a read-only install dir fails
before the live binary is touched (with a `sudo` / reinstall hint); and re-exec
is triple-guarded against loops. The version is embedded at build time
(`build/gen-version.mjs` → `src/version.ts`) since a binary can't read
`package.json`. For air-gapped/self-hosted setups, point `updateManifestUrl` at
a static `version.json` instead of GitHub.

## Architecture

```
 idctl (Ink/React TUI)            id-agents manager daemon :4100
 ┌───────────────────┐  HTTP      ┌──────────────────────────────┐
 │ useManager store  │──/agents──▶│  /agents /teams /tasks        │
 │  · snapshot poll  │──/events──▶│  /events  (live cursor)       │
 │  · event cursor   │──/remote──▶│  /remote  → /ask /sync /deploy │
 │  · inbox poll     │──/query───▶│  /query/:id?wait=30 (longpoll) │
 │ 10 views          │──/talk────▶│  /manager/inbox/{pending,respond}
 │ + Settings        │──model────▶│  POST /agents/:id/model
 └─────────┬─────────┘            └──────────────────────────────┘
           │ probe (discovery)
           ▼
   Ollama · LM Studio · OpenAI-compatible · Anthropic · OpenAI
```

All daemon access is funneled through `src/api/client.ts` (`ManagerClient`).
The reactive store (`src/store/useManager.ts`) owns the polling/streaming loops;
views just read its state. The settings subsystem lives under `src/settings/`
(`schema`, `paths`, `store`, `ProviderClient`, `assign`); self-update under
`src/update/` (`check`, `download`, `stage`, `apply`, `useUpdate`); packaging
under `build/`.

## Smoke tests

```bash
npm run smoke            # render every view against the live manager
npm run smoke:dispatch   # round-trip a trivial /ask to the manager agent
npm run smoke:providers  # probe local/cloud backends via ProviderClient
```

> Requires the manager daemon to be up. If it isn't:
> `cd ../id-agents && node dist/start-agent-manager.js`
