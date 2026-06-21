# Changelog

All notable changes to **ID Agents Control Center** are recorded here, newest
first. Versions track the desktop app (`idctl-desktop/package.json`); the
`idctl` TUI shares the same backend and version line.

Every change pushed or merged to `main` carries its version number in the commit
subject (`vX.Y.Z: …`), stamped automatically by the `commit-msg` hook — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## [0.1.47] — 2026-06-21
- The folder picker (Add from GitHub's "Clone & add", Import folder, Browse,
  change-root) now **opens at your standard projects folder** by default — so
  new clones and imports land alongside the rest instead of wherever the dialog
  last was. Falls back to the auto-detected workspace projects root.

## [0.1.46] — 2026-06-21
- **Sync the Projects page from your id-agents workspace.** New "⟳ Sync
  workspace" button auto-discovers the projects folder
  (`$ID_WORKSPACE_DIR/projects`, detected from the manager's launchd config) and
  tracks each subfolder as a project — pulling **name + description from the
  README**, the **git remote as a link**, and a `workspace` tag. The merge is
  additive and idempotent: it dedupes by folder, adopts a same-named manual
  entry, and never overwrites your edits or deletes anything.
- On first run with no projects yet, the page **auto-syncs** the detected
  workspace, so it's populated out of the box. The root is shown with a
  "change…" link to point it elsewhere.
- Git tracking now only treats a folder as a repo when it's the repo's **own
  root** — a plain folder nested inside a larger repo no longer borrows the
  enclosing repo's branch/status/remote.
- Standard install: an `io.bittrees.projects-sync` launchd agent keeps the
  tracker in sync with the workspace folder on a schedule, so a fresh idagents
  install has its projects tracked without opening the app.

## [0.1.45] — 2026-06-20
- **Add a project straight from a GitHub URL.** New "⤓ Add from GitHub" on the
  Projects page: paste a repo URL, pick where to clone it, and the app **clones
  the repo** (SSH first, HTTPS fallback) and **auto-fills the name, description,
  and tags** — description + topics + primary language come from the GitHub API
  (using your configured token for private repos), falling back to the README.
- **✨ Refine with lead** button on the project form routes the
  description/tags through your team lead, which can use its GitHub tools to
  write a cleaner summary — handy for repos with no GitHub description/topics.
- The cloned folder is wired in immediately, so the new project shows git
  tracking (branch, ahead/behind/fork, fetch/pull/…) the moment you save.

## [0.1.44] — 2026-06-20
- Projects page now tracks **folders and git repos**. Each project can point at a
  local folder; for git repos it shows the **branch and whether you're up to date,
  ahead, behind, or a customized fork** (ahead/behind measured vs the relevant
  remote's main branch — upstream's for forks), plus an "uncommitted" flag.
- One-click **git commands** per project (fetch / pull / status / log / diff) with
  inline output, an "open folder", and a "remote ↗" link.
- **Import folder…** (and a Browse + Read-README button on the form) pulls a folder
  in and **auto-fills the name and description from its README**.

## [0.1.43] — 2026-06-20
- Tasks page overhaul. **Fixed broken actions** — the buttons sent malformed
  commands (`/task <id> claim`, `/task <id> complete`, `/task add …`) that the
  manager ignored; they now use the correct verbs (`create`/`done`/`assign`/
  `status`/`remove`). Added: search, status filter (all/open/done), a **hide
  routine** toggle that hides the noisy heartbeat tasks, an **Age** column,
  open/done counts, per-task **assign-to-agent**, **Done/Reopen**, **Delete**
  (with confirm), and a **Clear completed** bulk action.

## [0.1.42] — 2026-06-20
- Chat: the selected agent now **persists** — it's saved per-team and restored
  when you return to Chat (or restart the app), instead of resetting to the lead
  every time you navigate away.

## [0.1.41] — 2026-06-20
- Dashboard layout: the agents table now sizes to its content (all columns show,
  no horizontal scroll on open) and the **Activity feed absorbs the horizontal
  stretch** when you widen the window.
- Activity lines carry more context: each query now shows the **kind of response**
  (message / heartbeat / error / code / question) and a **preview of the reply**
  text — e.g. `coder replied · message · "Sent reply to remote"`.

## [0.1.40] — 2026-06-20
- Dashboard, Chat, and Teams now list the team's **coordinator (lead) first**.
  In Chat the lead is also **auto-selected** as the message target (falling back
  to it on a team switch), so you can start typing to the lead immediately.

## [0.1.39] — 2026-06-20
- Update prompt repositioned to the **bottom-left of the sidebar, under Settings**
  — a small card (`⬆ vCURRENT → vNEW` + Restart & update + ✕) pinned to the
  sidebar's bottom.

## [0.1.38] — 2026-06-20
- Update prompt moved into the **status bar** as a compact chip (`⬆ vCURRENT →
  vNEW · Restart · ✕`), just left of the "● online" pill, instead of a floating
  corner toast.

## [0.1.37] — 2026-06-20
- Self-update **now relaunches** after applying. The freshly-swapped (unsigned)
  bundle carried a `com.apple.quarantine` xattr that made macOS silently refuse to
  reopen it; the apply helper now strips quarantine, has a robust `open` fallback,
  always runs the relaunch (no early `set -e` exit), and logs to
  `staged-update/apply-update.log`.
- The "update available" notice is now a **bottom-corner toast** (styled like a
  tile) that shows **vCURRENT → vNEW** with **Update & restart** / **Later**,
  instead of a top banner.

## [0.1.36] — 2026-06-20
- Dashboard **Activity** feed is now readable: agent ids resolve to **names** and
  events render as plain English ("coder replied", "lead is thinking",
  "researcher went offline") instead of `query:delivered agent_178…`. The panel
  is wider, rows wrap to show the full line, and live events show a relative time.

## [0.1.35] — 2026-06-20
- Settings → Self-update: removed the **manifest URL** field. Updates come from
  the app's GitHub releases; the self-hosted-manifest override was an unused
  advanced option that just cluttered the tile (still settable via config for
  anyone who genuinely self-hosts an update feed).

## [0.1.34] — 2026-06-20
- Dashboard: the model dropdown now **probes every backing provider on entry** and
  offers the full live model list per runtime — the free-text **"custom…"** entry
  has been removed (no more typing model ids by hand).

## [0.1.33] — 2026-06-20
- Runtime picker (Dashboard + Teams): the **claude-sdk** runtime
  (`claude-agent-sdk`) is now only offered when an **Anthropic API backend is
  live** — i.e. an `anthropic` inference backend is enabled, has a key (config or
  env), and last Connect&sync returned live. It's the only runtime that uses the
  metered Anthropic API, so without a working key it's hidden. An agent already on
  that runtime keeps it regardless.

## [0.1.32] — 2026-06-20
- Dashboard: switching an agent's **runtime** now picks a compatible model for
  the new runtime, **auto-opens the model dropdown** to fine-tune, and
  **auto-rebuilds** the agent — with no confirmation popup. Changing the **model**
  also rebuilds automatically. (The destructive delete still confirms.)

## [0.1.31] — 2026-06-20
- Teams: moved the **Lead hierarchy** card to the bottom of the page, below the
  team list, add-agent, and relay sections.

## [0.1.30] — 2026-06-20
- Settings now opens with a **Hardware** card — the commanded machine's compute
  spec (chip/CPU, CPU + GPU cores, unified/RAM, free-of-total disk, platform),
  the same machine local-model size warnings are checked against.
- Moved the **Lead hierarchy** tile from Settings to the **Teams** page, where it
  sits with the rest of team/coordinator management.

## [0.1.29] — 2026-06-20
- Local LLM stacks: simplified the row UI — dropped the always-visible command +
  copy button. **Install / Uninstall** is one click; the exact command is revealed
  only at the confirm step before it runs in your Terminal.

## [0.1.28] — 2026-06-20
- Local Models: each model now shows its **download size, parameters and context
  window**, with a per-model **⚠ warning** when it's too large for the commanded
  machine's RAM/disk (the manager host's CPU/RAM/free-disk is shown above the
  list). One-click **Download** and **Remove** for models.
- Local LLM stacks: **clickable Install / Uninstall** — opens the command in your
  Terminal (visible and abortable; nothing runs silently), app-only stacks link
  to their download — instead of copy-only. Plus a **port-collision ⚠** when a
  stack's default port is already in use on the machine or shared by another stack.

## [0.1.27] — 2026-06-20
- New **Local LLM stacks** catalog (Settings) — 21 self-hostable serving stacks
  from [awesome-llm-services](https://github.com/av/awesome-llm-services) you can
  run next to Ollama (llama.cpp, vLLM, mistral.rs, MLX, LM Studio, KoboldCpp…),
  each with its default port, OpenAI-compat, a copy-able install command and docs
  link. "Scan running" reuses discovery to flag which are live.
- Local Models card is now a browsable **model catalog** — ~50 Ollama-pullable
  models (Qwen3, Llama, Gemma 3, Phi-4-mini, Qwen2.5-Coder, DeepSeek-R1, vision,
  embeddings…) with size/params/capability tags, search + filters, one-click
  download and installed detection.

## [0.1.26] — 2026-06-20
- Fix: the **ollama** runtime's model picker no longer offers cloud (e.g.
  OpenRouter) models — only models from local providers, so you can't select a
  model the local harness can't load (which previously failed with
  "model not found" at probe/run time).

## [0.1.25] — 2026-06-20
- New **Discover local servers** (Settings → Inference backends) — scan localhost
  for running LLM servers (Ollama, LM Studio, llama.cpp, vLLM, Jan, …) and add
  them as inference backends in one click, with their model list. Hardened to
  ignore non-LLM services on the same ports.

## [0.1.24] — 2026-06-20
- Subscriptions: the **OpenAI (ChatGPT)** tile now shows the connected email and
  plan (decoded from the codex OAuth token), matching the Claude and Cursor tiles.

## [0.1.23] — 2026-06-20
- Capabilities: attaching MCP servers / skills / plugins is now **gated to the
  runtimes that can use them** — incompatible agents are shown disabled (with a
  reason) and skipped by apply/attach/install actions, instead of silently doing
  nothing. (MCP: Claude + Codex runtimes; local models gain it once the
  tool-calling loop ships.)

## [0.1.22] — 2026-06-19
- Subscriptions: the "Install…" action for a missing CLI (e.g. Cursor) now opens
  your Terminal and runs the vendor's official installer (falling back to copying
  the command if Terminal automation is blocked), then re-checks — instead of
  surfacing a "sign-in failed" message.

## [0.1.21] — 2026-06-19
- UI: the Settings → Inference backends card now grows to fit its content
  (its bottom help text was getting clipped below the tile on long pages).
- Subscriptions: when a CLI isn't installed (e.g. Cursor's `cursor-agent`), the
  row now says "CLI not installed" with an install hint instead of a silent
  OAuth failure.

## [0.1.20] — 2026-06-19
- New **Projects** page — track projects locally (name, status, description,
  team link, tags, links, notes) with status filters; stored in your config.
- Capabilities → MCP servers: a bigger **catalog** — Playwright, Browser MCP,
  Fetch, Context7, Tavily, Exa, Firecrawl, Notion, Figma, Slack — and the
  Brave Search entry repointed to its current official package.

## [0.1.19] — 2026-06-19
- Settings → Inference backends: a **provider catalog** — pick Groq, OpenRouter,
  Together, Mistral, DeepSeek, xAI, Fireworks, Cerebras, Gemini, DeepInfra,
  Nebius, Perplexity, or a local server (vLLM / llama.cpp / LocalAI / Jan) and
  its endpoint is filled in; Connect & sync discovers the live model list.
- Settings → **Local models (Ollama)**: list installed models and **download** a
  new one with live streamed progress (Ollama `/api/pull`).
- Settings → Subscriptions: add **Cursor** (`cursor-agent`) alongside Claude and
  ChatGPT.

## [0.1.18] — 2026-06-19
- UI: fix tiles/cards being compressed below their content on long pages — every
  view now keeps cards at their natural height and scrolls instead of clipping
  buttons/info (was previously fixed only for the Capabilities/Teams views).

## [0.1.17] — 2026-06-19
- Capabilities → Skills: **remove skills** — delete a skill from the library
  (two-step inline confirm) and uninstall a skill from the selected agents.

## [0.1.16] — 2026-06-19
- Self-update: treat a GitHub `releases/latest` **404 as "up to date"** (no
  published releases) instead of surfacing it as an error.

## [0.1.15] — 2026-06-19
- Health: **local-model (Ollama) token throughput gauge** plus 24-hour and
  7-day token-usage averages, with a per-agent breakdown. Cloud API runtimes are
  intentionally excluded.

## [0.1.14] — 2026-06-19
- Capabilities → Plugins: the **provider column is now a clickable link** that
  opens the source/homepage in the system browser.

## [0.1.13] — 2026-06-19
- Capabilities → Skills becomes a **searchable, tag-filtered catalog** with a
  **Create-skill** form following the [agentskills.io](https://agentskills.io)
  `SKILL.md` standard.
- Capabilities → Plugins: shows each plugin's **provider** (author / source).

## [0.1.12] — 2026-06-19
- Initial public release: the ID Agents Control Center desktop GUI (`idctl-desktop`)
  and terminal TUI (`idctl`) — a standalone control client for an
  [id-agents](https://github.com/idchain-world/id-agents) manager.

[0.1.22]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.22
[0.1.21]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.21
[0.1.20]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.20
[0.1.19]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.19
[0.1.18]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.18
[0.1.17]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.17
[0.1.16]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.16
[0.1.15]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.15
[0.1.14]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.14
[0.1.13]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.13
[0.1.12]: https://github.com/bobofbuilding/id-agent-control-center/releases/tag/v0.1.12
