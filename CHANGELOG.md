# Changelog

All notable changes to **ID Agents Control Center** are recorded here, newest
first. Versions track the desktop app (`idctl-desktop/package.json`); the
`idctl` TUI shares the same backend and version line.

Every change pushed or merged to `main` carries its version number in the commit
subject (`vX.Y.Z: …`), stamped automatically by the `commit-msg` hook — see
[CONTRIBUTING.md](CONTRIBUTING.md).

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
