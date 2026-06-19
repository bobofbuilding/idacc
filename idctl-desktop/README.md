# ID Agents Control Center — Desktop (GUI)

A real **mouse + keyboard desktop application** (Electron) for the id-agents
manager — a window you click around, not a terminal. Live fleet dashboard,
conversational manager chat, team management, inbox, and more.

It **reuses the idctl backend unchanged**: the manager API client, settings,
and key-management logic all run in Electron's main process (Node, no CORS,
secrets off the UI) and are exposed to the React window over a small, allow-listed
IPC bridge (`window.idagents.call(...)`).

## Run from source

```bash
cd idctl-desktop
npm install      # first time
npm start        # build + launch the window
```

## Build the standalone app (download & double-click)

```bash
npm run dist     # → release/mac-arm64/ID Agents Control Center.app  (.app, Bob icon)
npm run dmg      # → a .dmg installer (drag-to-Applications)
```

The `.app` bundles Electron + the UI, so it runs with no Node and no install —
double-click it like any consumer Mac app. It carries the Bob brand icon
(`build/icon.icns`, generated from `assets/icon-source.jpg`).

> Ad-hoc/local build. For public distribution, sign with an Apple Developer ID
> and notarize (set the `CSC_*` env vars and remove `CSC_IDENTITY_AUTO_DISCOVERY=false`).

## Architecture

```
 React renderer (DOM, mouse+keyboard)         Electron main (Node)            manager :4100
 ┌───────────────────────────┐  IPC          ┌──────────────────────┐  HTTP  ┌──────────────┐
 │ App shell · sidebar nav    │──call(...)──▶ │ bridge.ts            │──────▶ │ /agents      │
 │ Dashboard · Chat · Teams   │               │  reuses idctl        │        │ /events      │
 │ Capabilities · Settings …  │ ◀──result──── │  ManagerClient       │ ◀───── │ /remote …    │
 └───────────────────────────┘               └──────────────────────┘        └──────────────┘
```

- `src/main/` — Electron main + IPC bridge (imports the idctl `ManagerClient`).
- `src/preload/` — `contextBridge` exposing `window.idagents`.
- `src/renderer/` — React UI (`store.ts` live hook, `views/*`), `styles.css`.
- `scripts/build.mjs` — esbuild bundles main/preload/renderer.

## Views

All panels are wired:

- **Dashboard** — live fleet + activity feed + agent detail; validate runtime ↔
  model pairings and switch a running agent's runtime/model in place.
- **Chat** — talk to the team's `lead` manager agent; streams the reply.
- **Inbox** — answer questions the manager is blocked on.
- **Tasks** — create / claim / assign / complete tasks.
- **Health** — probe agent liveness.
- **Identity & Keys** — per‑agent ENS / ID Chain / OWS wallet, Safe smart
  account, and scoped (optionally non‑expiring) ERC‑4337 session keys.
- **Schedule** — per‑agent heartbeat intervals and recurring calendar check‑ins.
- **Teams** — switch, create from the default template, an add‑agent form, and
  cross‑team relay policy (with per‑agent overrides).
- **Capabilities** — attach MCP servers (catalog + live connection Test); a
  searchable, tag‑filtered **skill catalog** that follows the
  [agentskills.io](https://agentskills.io) `SKILL.md` standard, including a
  **create‑skill** form (name/description/tags/license/compatibility/allowed‑tools
  + Markdown body); and a plugins view showing each plugin's provider. Install or
  assign to one or many agents/teams.
- **Settings** — connect managers and inference backends (Ollama, LM Studio, any
  OpenAI‑compatible server, Anthropic, OpenAI) with live model discovery;
  Subscriptions (runtime OAuth sign‑in status); and Self‑update.

Sibling project [`../idctl`](../idctl) is the terminal (TUI) build of the same
control center and shares the backend. The upstream platform this drives is
[id-agents](https://github.com/idchain-world/id-agents).
