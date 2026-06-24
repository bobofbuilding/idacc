# Changelog

All notable changes to **ID Agents Control Center** are recorded here, newest
first. Versions track the desktop app (`idctl-desktop/package.json`); the
`idctl` TUI shares the same backend and version line.

Every change pushed or merged to `main` carries its version number in the commit
subject (`vX.Y.Z: …`), stamped automatically by the `commit-msg` hook — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## [0.1.102] — 2026-06-24
- **Fix: Plans → Brain plans said "brain plans dir not found" even when configured.**
  The brain-plans reader called the projects-root detector with no argument, so it
  never consulted the **saved `projectsRoot`** (the one the Projects page sets). It now
  falls back to that setting, so the brain's live plan index loads as intended.

## [0.1.101] — 2026-06-24
- **New Dream tab (Work page).** An agent runs an offline "dream" — a reflection pass
  over its recent work and the shared brain — and returns a report with four sections:
  **Consolidation** (facts worth keeping), **Insights** (patterns), **Ideas** (proposed
  tasks/plans), and **Simulations** (speculative futures). **✦ Dream now** runs it on a
  chosen agent and saves the report as a morning digest; **Schedule nightly** sets up a
  recurring 03:00 dream. Per the research, Ideas &amp; Simulations are explicitly
  **proposals for review — nothing is auto-executed**. (Grounded in the dream-research
  brief: CLS/“sleep-time compute” consolidation + Generative-Agents reflection.)
- *Completes the Work-page overhaul: Kanban tasks, live brain Plans, Schedule cleaner,
  AI agent-chains, and Dream.*

## [0.1.100] — 2026-06-24
- **Loops can now string agents + tasks into an AI-drafted chain.** The Loops tab
  leads with **Agent chains**: describe a goal, hit **✦ Draft chain**, and an agent
  designs an ordered sequence of steps — each step = (agent + task). Review/edit the
  steps (reorder, swap the agent, rewrite the task, add/remove), then **Run** it: each
  step executes in order via `/ask`, and **every step's output is fed to the next as
  context**, with live per-step status + output. Chains are **saved and re-runnable**.
  The original single-agent recurring loop is still here, renamed **Scheduled
  objectives**.

## [0.1.99] — 2026-06-24
- **Plans now shows the brain's live plan set.** The Plans tab leads with a **Brain
  plans** section read straight from the brain's `plans/` directory (its `README.md`
  status index — DONE / PARTIAL / PENDING / ON HOLD — plus each plan file), **self-
  updating every 10s** as the brain edits its files on disk. Click any plan to read it
  inline. It's strictly read-only (the brain owns those files); your own AI-generated
  drafts live below under "Your drafts." The directory is auto-located from your
  projects root.

## [0.1.98] — 2026-06-24
- **Work page, part 1 of an overhaul:**
  - **Tasks is now a live Kanban board.** Three columns matching the manager's task
    states (To do / Doing / Done); **drag a card between columns** to change its status,
    and the board **auto-refreshes every 5s** so it stays current as agents claim and
    complete work. Search + hide-routine carry over; per-card assign and delete remain.
  - **Plans is now the first tab** of the Work page (and the default landing tab).
  - **Schedule has a one-click cleaner** — a **🧹 Clean up** button closes every
    supervision check-in still watching a finished or removed task, in bulk.
- *(Coming next in this overhaul: Plans live from the brain, AI-assisted multi-agent
  loops, and a Dream tab.)*

## [0.1.97] — 2026-06-24
- **The lead/coordinator preset now prioritizes orchestration over doing the work.**
  Applied to a lead (via the Coordinator preset button, the Team Builder's auto-wiring,
  or HR Manager → Structure/Manage), the directive now drives an explicit five-step
  loop, narrated as it goes: **1. Compress** the request to its essential intent +
  constraints, **2. Break it up** into the smallest self-contained sub-tasks, **3.
  Delegate** each to the best owner — a teammate (`/talk-to`) **or another team's lead**
  (`/ask <team>/<lead>`), **4. Summarize step by step** (compress each delegate's reply
  to 1–3 lines and post a running update as results land, not just at the end), and
  **5. Close out** with one synthesized answer. The roster-aware variant names the
  actual teammates that were created.

## [0.1.96] — 2026-06-24
- **Skills are now auto-categorized, so the catalog's tag search actually works.**
  Skills created in other sessions land in the library with no `metadata.tags`, so
  the Capabilities → Skills tag filter was empty for them. Now any untagged skill is
  automatically tagged on catalog load:
  - **AI batch categorization** — one `/ask` to a running agent tags every untagged
    skill at once from a controlled category vocabulary (research, coding, messaging,
    wallet, onchain, knowledge, …); falls back to an **offline keyword heuristic**
    when no agent is up, so it always produces tags.
  - **App-side overlay** — derived tags are cached in the control center's settings
    and merged into the catalog display + tag search; the skill's `SKILL.md` is never
    modified. Auto-tags are shown with an `auto` style; **↻ re-categorize** re-runs it.
  - The existing **search box + tag-chip filter** now spans both frontmatter and
    auto‑derived tags, so every skill is findable by tag.

## [0.1.95] — 2026-06-24
- **Internal:** added a unit test for the AI Team Builder's design sanitization
  (`sanitizeDesignedTeam` — drops off‑list runtime/model/skill picks, dedupes agent
  names, guarantees exactly one lead). Also consolidated the two `0.1.88` changelog
  entries below: the AI Team Builder and the interactive Inbox both shipped as
  `v0.1.88` (two commits stamped the same version), so they're now one entry.

## [0.1.94] — 2026-06-24
- **Local‑model concurrency now persists across manager restarts.** Your chosen
  “parallel local inferences” value is saved in the app and **re‑applied to the
  manager automatically every time the app connects** — including after the manager
  restarts — so it sticks without needing the `LOCAL_MODEL_CONCURRENCY` env var.

## [0.1.93] — 2026-06-24
- **No more false “health probe failed” on freshly‑built agents.** A just‑spawned
  agent needs a second or two to bind its HTTP server, so the onboarding probe used
  to fire too early and red‑flag a perfectly healthy agent (`request to …/talk
  failed`). The probe now retries for a short startup grace (~12s) before declaring a
  failure, so it only reports agents that are actually unreachable.

## [0.1.92] — 2026-06-24
- **Tune local‑model parallelism + fix a local‑agent deadlock.** Local (`ollama`)
  agents share one model server, so the manager runs them through a concurrency gate
  (cloud runtimes like codex/claude always parallelize). Two changes:
  - **Settings → Local models** now has a **“parallel local inferences”** control —
    raise how many ollama agents run at once (1–16, applies live) when your hardware
    can handle it, with a live `running · queued` readout. *(Needs a manager that
    exposes the control.)*
  - **Deadlock fix:** an ollama agent that's *blocked delegating* to another ollama
    agent now frees its slot while it waits, so a local coordinator can hand work to a
    local teammate instead of the two wedging on the single slot until a timeout.

## [0.1.91] — 2026-06-23
- **Start, stop, probe, and rebuild whole teams.** In HR Manager → Structure, click
  a team (in the graph or **Manage** in the team list) to open its panel, then act on
  **every agent at once**: **▶ Start all**, **■ Stop all**, **◇ Probe**, **↻ Rebuild
  all**. Start/stop/rebuild fan out per agent (best‑effort — a failure is reported and
  the rest still run); Probe health‑checks the team in one call. Stop and Rebuild ask
  for a one‑click confirm since they interrupt running agents; results show
  `done/total ✓` with any failures named.

## [0.1.90] — 2026-06-23
- **Lead hierarchy is now an actionable cross‑team coordinator table.** Instead of a
  static list (which rendered a broken `team/` entry for any team whose coordinator
  was unset), each team now shows a **coordinator picker** (choose the lead from that
  team’s agents) and a **make‑primary** button — set or change any team’s coordinator
  and promote one to the primary cross‑team lead, right from HR Manager → Structure.

## [0.1.89] — 2026-06-23
- **HR Manager refactored into four focused tabs + a live team graph.** The page is
  now organized around the things you actually do — **Structure / Build / Manage /
  Route** — instead of one long scroll.
  - **Structure:** a **live, interactive hierarchy graph** — one column per team, the
    lead on top (⭑ = primary cross‑team coordinator) and its workers below, with
    status dots and runtimes. **Click any agent or team** to open an inline panel:
    edit its **goals & instructions** (Coordinator preset, **✦ AI draft**, Save &
    rebuild), **reassign team**, **rebuild**, or jump to its routing. Selecting an
    agent in another team focuses that team automatically.
  - **Build:** the AI Team Builder + templates. **Manage:** the per‑agent
    instructions editor (now with **✦ AI draft**). **Route:** cross‑team relay +
    per‑agent overrides.
  - **AI assistance at every level** — drafting goals/instructions anywhere via
    **✦ AI draft** (dispatches to your team’s coordinator), plus the existing AI
    Team Builder. *(AI‑assist needs a running agent; you’ll be told if none is up.)*

## [0.1.88] — 2026-06-23
- **The Teams page is now the “HR Manager” page.** Same spot in the sidebar and the
  same underlying team data — just renamed (nav label + page heading) to reflect that
  it manages the agent workforce.
- **One AI Team Builder replaces “Import from spec” + “Onboard agents.”** A single
  flow now builds teams and agents end to end:
  - **Describe in plain English or paste a spec** — a live deterministic parse drafts
    the roster as you type; **✦ Build with AI** designs it from messy or high‑level
    input.
  - **AI designs the whole roster** — each agent comes back with a suggested runtime,
    model, skills, and one ★ lead, grounded by the runtimes/models/skills actually
    available (off‑list picks are dropped, nothing is invented).
  - **Rich per‑agent review** — name · runtime · model · role, with an expandable row
    for each agent’s persona and per‑agent skills; shared MCP / heartbeat / wallet /
    probe apply to the batch.
  - **Build in one pass** via `onboard:run`, which now carries each agent’s persona,
    with a live per‑agent checklist. Targets a new or existing team.
  - **Auto‑wiring** — after the agents land, the ★ lead is made the primary
    coordinator and gets the delegate‑to‑teammates preset, and the team’s cross‑team
    relay policy is applied (each shown as its own checklist row). The coordinator and
    rebuild calls are team‑scoped so wiring a brand‑new team works even when it isn’t
    the active one.
- **The Inbox is interactive — reply to or dismiss what’s waiting.** Each item now
  has an inline reply box (⌘/Ctrl+Enter to send) and a **Dismiss** button; both
  clear the item from the manager’s pending queue. Previously the Inbox was
  read‑only, so anything parked there was stuck.
- **AI Team Builder / “Ask AI to parse” no longer clog your Inbox.** They were
  sending the design/parse prompt to the manager’s human inbox (awaiting *you*),
  so they never auto‑answered. They now dispatch to a team **agent** via `/ask` and
  read its reply directly — nothing lands in your Inbox. If no agent is running,
  you get a clear “onboard an agent first” message instead of a silent park.

## [0.1.87] — 2026-06-23
- **Add Agent is now one streamlined “Onboard agents” flow.** The inline add‑agent
  form on the Teams page is gone; the **Onboard agents** button opens a single modal
  that does everything:
  - **Assign to a team** — pick an existing team or **＋ new team…** (created on the
    first spawn). After onboarding, the app switches to that team.
  - **Create multiple agents at once** — add as many agent rows as you want and
    onboard the whole batch in one pass, with a per‑agent ✓/✗ result list.
  - **Per‑agent runtime + model** — every agent picks its own inference runtime and
    model; shared skills / MCP / heartbeat / wallet / probe apply to the batch.
  - Reserved command words and duplicate names are caught before any spawn.

## [0.1.86] — 2026-06-23
- **Each chat is now its own conversation — no more cross‑chat “creep.”** Every
  message a chat sends now carries that chat’s id as a conversation key, so the
  agent resumes only *that* chat’s thread instead of whatever it last worked on.
  Previously all chats to the same agent shared one rolling context, so a reply in
  one chat could continue an unrelated task from another. *(Requires a manager +
  agents that thread the conversation id and resume per chat; without them the id
  is simply ignored and behavior is unchanged.)*

## [0.1.85] — 2026-06-23
- **Imported agents now keep their full description, not just the one‑line role.**
  The spec parser now captures each agent’s complete description (the `Role:` line
  **plus** the richer sentences under it), and that text is sent as the agent’s
  **persona** — it becomes the agent’s actual operating instructions, not just a
  peer‑discovery blurb. (Previously the importer sent neither role nor description as
  the persona, so imported agents started with no real mandate.)
  - The Import modal now shows an **editable description box** per agent (in addition
    to the one‑line role), pre‑filled from the spec; “✦ Ask AI to parse” returns a
    description too.
  - Inline markdown (`**bold**`, `` `code` ``) is cleaned out of the persona text, and
    the role/description length caps are now applied uniformly across the paste, AI,
    and manual‑edit paths. *(Requires a manager that accepts `roleBody` on spawn.)*

## [0.1.84] — 2026-06-23
- **Import a team from a pasted spec.** New **“↥ Import from spec”** button on the
  Teams page: paste a free‑form team description (e.g. a “Recommended Agent Creations
  For \`brain\`” list) and it auto‑detects the team name and each agent, then spawns
  them into a new team in one click — the team is created on the first spawn.
  - **Deterministic parser** extracts the team + agents (name + role) live as you
    paste; for messy formats, **“✦ Ask AI to parse”** dispatches the prose to your
    team’s lead for strict JSON and falls back to the deterministic parse on failure.
  - Every detected agent shows in an **editable, reviewable list** (rename, fix role,
    remove) with **runtime + model pickers** applied to the whole import.
  - Guards from an adversarial review: prose bullets are no longer mistaken for agents,
    reserved command words (`status`, `team`, `verify`, …) are caught **before** any
    spawn, the team name is no longer pulled from stray “…for …” prose, a partial
    import leaves only the failures queued so re‑clicking Create retries just those,
    and the app only switches to the new team when an agent actually landed there.

## [0.1.83] — 2026-06-23
- **Local models (Ollama) can now use MCP servers.** Previously MCP attach was
  Claude/Codex‑only — local models had no way to call MCP tools. The manager now
  runs an agentic tool‑calling loop for Ollama (connect attached MCP servers →
  expose their tools → call/observe/continue), so a tool‑capable local model (qwen3,
  qwen2.5, llama3.1+, etc.) can actually use them. The control center now offers
  **Attach MCP** for Ollama agents; a model without tool support degrades gracefully
  to plain text. *(Requires a manager that includes the Ollama tool loop.)*

## [0.1.82] — 2026-06-23
- **Reassign an agent to another team.** Each agent in Teams now has a *“reassign
  to…”* picker — pick a team and the agent moves there (the manager rebuilds it
  under the new team, carrying its wallet, subscriptions, check-ins, and history).
  Refuses a name that already exists in the target team.
- **Delete an empty team.** Teams with **zero agents** (except `default`) now show a
  **Delete** button; the manager refuses to delete `default` or any team that still
  has agents. Remove its agents first (or move them out), then delete.
- **Activity log keeps correct times across restarts.** The live fleet feed was
  stamping most of the re-fetched backlog with the current time after a restart, so
  everything collapsed to the same age (e.g. “18s”). It now uses each event’s real
  occurred-at time, so ages are accurate and survive an update + relaunch.
- **Reopens where you left it.** The app now restores its window **position, size,
  and maximized state**, and the **last page** you were on — including after a
  self-update relaunch. (Falls back to centered if the saved spot is off-screen.)

## [0.1.81] — 2026-06-23
- **Chat live activity recovers after a manager restart.** The inline "what the
  agent is doing" feed (tool/file steps) polls the manager's per-agent activity
  ring. If the manager restarted mid-dispatch, its in-memory ring reset *below* the
  chat's cursor, so the feed froze showing only "<agent> working… Ns" with no steps.
  The poll now detects when the ring is behind its cursor and resyncs to the tail, so
  the agent's ongoing actions stream again. (Pairs with the matching `/events` cursor
  fix.)
- **Each activity / behind-the-scenes step now shows its time.** Every live tool/file
  step and delegation line — and the captured trace on a finished reply — is prefixed
  with the clock time (HH:MM:SS) it happened, so you can see *when* each action ran,
  not just the running elapsed counter.

## [0.1.80] — 2026-06-23
- **Background updates now ping you system‑wide.** The app already checked for
  updates in the background (on launch, every few hours, and on window focus) and
  showed a sidebar “Restart & update” chip — but you'd only really notice it on the
  Settings page. Now, the first time a background check downloads a new version, you
  get a native **macOS notification** (“Update ready — v0.1.x downloaded, restart to
  apply”); clicking it brings the app forward. Fires once per version, even when the
  app is unfocused or minimized.

## [0.1.79] — 2026-06-23
- **Agent identity lives on the Identity & Keys page now.** The per‑agent onchain
  identity (ENS / ID‑chain domain, OWS wallet, and **Register identity** /
  **Provision wallet** actions) moved off the Teams › Cross‑team relay panel and
  onto **Identity & Keys**, alongside that agent's Safe account and session keys —
  one place for an agent's identity. The Teams page keeps the per‑agent relay
  overrides (it's no longer cluttered with identity rows).

## [0.1.78] — 2026-06-23
- **Honest about manager compatibility.** Some panels (skills install/create/
  uninstall, plugins, MCP attach, per‑agent instructions, runtime switch, cross‑team
  relay delegates) call manager endpoints that a stock or older upstream id-agents
  may not expose. When such an action hits a 404, the app now shows a clear
  *“… requires a newer id-agents manager”* message instead of a raw
  `POST /… → 404`, and the rest of the app keeps working. No functional change
  against a manager that already has those routes.
- **README:** added a **Manager compatibility** section documenting which features
  need which manager routes, and marked the Identity & Keys panel as running on a
  simulated key provider today (real OWS / Safe‑4337 signing is the planned swap).

## [0.1.77] — 2026-06-23
- **Desktop team creation now uses a full Create team modal.** Operators can pick
  the default template, a library team template, or a deployable server config,
  validate the slugged team name, preview deploy preflight details when
  supported, and see install/deploy progress while the new team starts.

## [0.1.76] — 2026-06-23
- **Desktop Teams now has a real agent onboarding wizard.** The new flow reuses
  shared onboarding logic for preflight, spawn, MCP attach, rebuild, and health
  probe steps, with a checklist and retry support for failed post-spawn steps.

## [0.1.75] — 2026-06-23
- **Teams now shows each agent’s onchain identity inline.** Per-agent rows display
  the ID-chain domain, OWS wallet, and Safe account status, with one-click
  identity registration and wallet provisioning from the Teams page.

## [0.1.74] — 2026-06-23
- **Critical fix: blessing an agent for Computer Use no longer breaks it.** The
  Computer Use tool was registered under the name `computer-use`, which **Claude Code
  reserves** — so once you blessed a Claude agent, *every* request to it failed with
  “failed” / “Claude Code produced an empty result.” The tool is now `mac-control`,
  and the app detects + cleans up the old broken name. **If an agent of yours is
  currently failing, re-bless or remove it once in the Computer Use tab to fix it.**
- **Computer Use: stronger per-agent security.** Each blessed agent now gets its
  own private token (instead of one shared key), and the controller identifies the
  caller by that token rather than a self-reported name — so one agent can’t act as
  another, and removing an agent immediately revokes its access. Re-bless any agent
  you’d previously granted Computer Use (one click) to issue its new token.

## [0.1.73] — 2026-06-23
- **Computer Use: you don’t have to approve *everything* anymore.** A new risk
  classifier means you can turn **off** “Approve every action” and the agent runs
  ordinary clicks/moves/typing on its own — but the app **still holds the risky
  ones** for your OK: destructive keyboard shortcuts (Quit, Empty Trash) and
  dangerous typed commands (`rm -rf`, `sudo`, `drop table`, `--force`, …). The
  approval prompt now tells you *why* something was flagged. Supervised
  (approve-everything) remains the default and recommended mode.
- Stronger guidance to the agent: the type/key tools now explicitly say never to
  type credentials and that dangerous commands will be held for you.

## [0.1.72] — 2026-06-23
- **Computer Use can now DRIVE your Mac — safely.** A blessed Claude/codex agent can
  move the mouse, click, type, scroll, and drag on your primary display (not just
  see it), all through the in-app broker. This is the input release, and it ships
  with its full safety net on by default:
  - **Approve every action (supervised mode, default on):** the agent is *held* on
    each click/keystroke until you press **Allow** (or **Deny**) in the app. Turn it
    off only when you trust a task.
  - **PANIC** — a red button **and** a global hotkey (**⌘⌥⇧P**) that instantly stops
    everything from anywhere, even if the app isn't focused.
  - **Pause** blocks the agent without disarming; **Disarm** ends the session and
    releases any held mouse button.
  - Input also requires **Accessibility** permission (one-click Open Settings +
    Relaunch), and the agent must **screenshot first** so every action is anchored
    to something you can see.
  - Every action is in the **activity log** (and Chat); **keystrokes are recorded as
    a length only** — never the literal text — so secrets you type never hit disk.
  - Hardened across two adversarial review rounds before release.

## [0.1.71] — 2026-06-23
- **New: Computer Use (watch your Mac live + let an agent see your screen).** A new
  **Computer Use** tab streams your primary display live inside the app, and you can
  **bless** a Claude/codex agent to let it take screenshots of your Mac (so it can
  see what you see while helping). This first release is **watch + screenshot only**
  — mouse/keyboard control, live take-over, and a panic kill-switch are coming next.
  - **Safety is built in.** Disarmed by default (the agent can’t even screenshot
    until you press **Arm**); only agents you explicitly bless can reach it; the
    capture runs through a loopback-only, token-authed in-app controller that
    rejects cross-origin/rebinding probes; the live capture only runs while the tab
    is open; and on-screen text is treated as **data, never instructions**.
  - Screen Recording permission is detected with one-click **Open Settings** +
    **Relaunch** helpers. No native modules, so nothing extra to install.

## [0.1.70] — 2026-06-22
- **Chat replies survive long tasks, navigating away, and restarts.** Dispatches
  are now resumable: the in-flight query is persisted on the chat, and the chat
  resumes polling when you come back to it — instead of giving up with “timed
  out waiting for reply” and losing the answer. Switching pages and returning no
  longer wipes the live activity; it re-attaches and the reply lands when ready.
  Replies always land in the **right** chat (with an unread badge if you’ve moved
  on), and **every** waiting chat resumes after a restart — not just the last one
  you had open. (Replaces the single fixed-timeout long-poll with a renderer-owned
  resumable poll loop; while the manager is reachable it never abandons a running
  task — it defers to the manager’s own result/expiry — and a brief outage just
  keeps waiting with a soft notice instead of dropping the reply.)
- **More reliable delegation.** The Coordinator preset now tells the lead to
  prefer synchronous \`/talk-to\` (the manager handles the wait) over hand-rolled
  async polling, which could hang waiting for a teammate that never woke.
- **Sturdier composer + plans.** The composer is locked while a reply is in
  flight so a fast double-press can’t fire two dispatches (or two billed image
  generations); a plan request still auto-saves to **Work › Plans** even when its
  reply lands after you navigated away or restarted; and the per-reply “behind
  the scenes” trace is captured per dispatch.

## [0.1.69] — 2026-06-22
- **Readable supervision check-ins.** The check-in list no longer shows cryptic
  `chk_…` ids. Each row now reads **“Watching: <task title> · <owner> · every
  10m · checked 6× · next in 3m”** with the live status, sorted active-first.
  A header flags any check-in still watching finished work (“⚠ N watching
  finished work”), each active one gets a **Close** button, and closed ones are
  dimmed with their reason. (The manager now resolves each check-in’s linked
  task title/owner; older managers degrade to “a delegated task”.)

## [0.1.68] — 2026-06-22
- **Coordinator preset no longer leaves stale “doing” tasks.** When the lead
  delegated synchronously it was auto-attaching a tracked task that never closed
  (a sync reply doesn’t mark its own task done), so the board filled with
  perpetual “doing” rows. The Coordinator preset now tells the lead to skip the
  tracked task for synchronous delegations (it gets the reply inline; the live
  activity feed already shows the hand-off) and to reserve — and close —
  tracked tasks only for async hand-offs.

## [0.1.67] — 2026-06-22
- **Settings re-checks for updates on open.** The Self-update card now kicks a
  fresh check whenever you open Settings, so it never shows a stale “latest”
  version (previously it showed the last cached check until the next interval /
  focus re-check or a manual “Check now”).

## [0.1.66] — 2026-06-22
- **Chat survives an agent restart.** Dispatches now auto-retry transient
  failures — the target agent briefly rebuilding, the manager restarting, or a
  network blip — with a “reconnecting…” note, instead of surfacing a hard
  “agent failed” / “fetch failed”. Timeouts (work still in flight) are not
  retried. If it still can’t connect after retries, the error explains it
  plainly (the agent may be restarting).

## [0.1.65] — 2026-06-22
- **Make the lead actually coordinate its team.** New **Teams → Agent
  instructions** section: a persistent per-agent system-prompt directive with a
  one-click **Coordinator preset**. Apply it to your lead and it delegates
  implementation to `coder` and research to `researcher` (via the inter-agent
  skill), then synthesizes their results — instead of doing everything itself.
  Verified live: the lead delegated to both teammates and reported who did what.
  The directive survives rebuilds (stored as a per-agent sidecar). “Save &
  rebuild” applies it. (The lead *could* delegate before — it has the
  inter-agent skill — but nothing *instructed* it to; this fixes that.)

## [0.1.64] — 2026-06-22
- **Paste images & files into chat.** Paste a screenshot or a copied file
  straight into the message box and it’s attached (alongside the 📎 button),
  then sent into the focused project / agent workspace on Send like any other
  attachment. Plain-text paste is unaffected. 25 MB per item.

## [0.1.63] — 2026-06-22
- **Local image generation (free) — preferred over the cloud.** Image creation
  in chat now uses a **local image server first**, falling back to the cloud
  (OpenRouter) only if none is set or it’s unreachable. Settings → Inference has
  a **Local image generator** card: point it at Automatic1111 / Forge (Stable
  Diffusion WebUI on `:7860`, started with `--api`) or a LocalAI-style OpenAI
  images API (`:8080`), or click **Detect** to find one on localhost. Supports
  both the `/sdapi/v1/txt2img` and `/v1/images/generations` APIs. (Note: the
  Claude/ChatGPT/Cursor subscriptions and Ollama models are text/vision-only and
  can’t generate images — a local image server or the cloud are the options.)

## [0.1.62] — 2026-06-22
- **Cleaner composer.** Removed the helper hint line under the chat input
  (image/plan/live-feed tips); the behavior is unchanged.

## [0.1.61] — 2026-06-22
- **Chat auto-scrolls to follow new activity.** The thread now stays pinned to
  the latest as replies and the live “working” feed stream in, so you don’t have
  to scroll down to keep up. Scrolling up to read history pauses the follow (it
  won’t yank you back down); sending a message or opening a chat re-pins to the
  bottom.

## [0.1.60] — 2026-06-22
- **Live agent activity streamed into chat.** While an agent works on your
  message, the chat now shows what it’s actually doing — files it creates/edits,
  commands it runs, searches, web fetches, and work it delegates to other
  agents — as an inline “working · live” feed (Claude-app style), with an
  elapsed timer. A compact record of the steps is kept with the finished reply.
  (Agents stream their tool/file steps to the manager; needs the local manager +
  a one-time agent rebuild to light up — claude-code agents today.)

## [0.1.59] — 2026-06-22
- **Unread badges on Chat & Inbox.** The Chat nav item now shows a count when an
  agent reply lands in a thread you haven’t viewed; opening the thread (or the
  Chat view, for the most recent) clears it. Unread threads are also marked with
  a ● in the chat switcher. The Inbox badge (pending manager questions) is
  unchanged. Both are scoped to the active team.

## [0.1.58] — 2026-06-22
- **Select & copy chat text + spellcheck.** Chat messages — both what you type
  and the agent’s replies (plus the live trace and generated-image captions) —
  are now selectable, so you can highlight and copy them. The composer is
  spellchecked, and a right-click menu offers spelling suggestions / Add to
  Dictionary plus Cut/Copy/Paste/Select All. App chrome (nav, buttons) stays
  unselectable for the native feel.

## [0.1.57] — 2026-06-22
- **Ask for a plan in Chat → it auto-saves to Plans.** When a chat message
  clearly asks for a plan (“draft a plan for…”, “/plan …”), the agent’s reply is
  also saved to **Work › Plans** with an auto-titled entry — a chat line
  confirms the save. Conservative detection (won’t fire on “planet”/“planner” or
  “according to plan”).
- **Live “behind the scenes” feed in Chat.** While an agent works, the reply
  bubble shows an elapsed timer plus a live activity feed built from the fleet
  event stream — including work the lead farms out to other agents, so you can
  see things running **in parallel**. A compact trace is kept with the finished
  reply (expand “behind the scenes”).
- **Auto-decompose work on assign.** New **⚡ Assign work to fleet** in the Tasks
  tab: describe an objective, the lead splits it into concrete sub-tasks (each
  owned by the best-suited agent, with dependencies), you review/adjust owners,
  then **Create & dispatch** — independent tasks are farmed out in parallel and
  dependents follow their prerequisites. Every sub-task appears in the Tasks
  view with live status, so parallel execution is visible.

## [0.1.56] — 2026-06-22
- **New Plans tab in Work.** Request a plan and an agent drafts it (Markdown),
  saved to the Plans tab. **Generate** new plans right from there (objective +
  agent), **update** an existing plan with instructions — each update is a new
  **version** with a **changelog** entry — and browse/restore-view past
  versions. Rename, set status (draft/active/done/archived), delete. Plans are
  stored per-plan under `~/.config/idctl/plans/`.

## [0.1.55] — 2026-06-22
- **Unified composer — one Send, no 🎨 button.** The composer now auto-decides
  between chat and image generation from your prompt. A clear image request
  ("generate an image of…", "draw a logo…", or a leading `/image …`) generates
  an image; everything else goes to the agent. The decision is a **free, local**
  heuristic (no metered API), it defaults to chat so it never spends on image
  generation by accident, and chat continues to run on your **subscription /
  local** agent runtime. (Image generation itself still uses OpenRouter — the
  only image-capable provider configured.)

## [0.1.54] — 2026-06-22
- **Image generation: no more model picker.** The model is now auto-selected
  from your prompt (a higher-quality model when the prompt asks for it —
  photorealistic / detailed / logo / 4k — otherwise the fast, cheap default).
- **Chats are only saved once they have a real message** — empty "New chat"
  shells aren't cached, and leftover empties are pruned from the list.
- **Chat titles are auto-generated** from the opening message by a local Ollama
  model (free, no cloud cost), with the first-message text as an instant
  fallback. Renaming still locks the title.

## [0.1.53] — 2026-06-22
- Renamed the **Tasks** nav item + page heading to **Work** — it now covers
  Tasks, Schedule, and Loops under one inclusive title. (The first tab is still
  "Tasks".)

## [0.1.52] — 2026-06-22
- **Tasks page is now tabbed: Tasks · Schedule · Loops.** The Schedule page is
  folded in as a tab (no more separate nav item; heartbeats + supervision live
  there). **New Loops tab** — build a recurring *objective* for an agent
  (objective + cadence) that the manager runs on a schedule (24/7, even when the
  app is closed), with a tracker (status, last run, Run-now, pause/resume).
- **Health page now lists the whole fleet, grouped by team**, with running
  agents at the top of each group and the active team first (e.g. "41 agents ·
  41 running"). Probe stays scoped to the active team.
- **Chat sessions are auto-named** (a default that the first message refines)
  and the name is editable any time — renaming locks it.
- **Editing a project now opens in place** — the form expands at the card you're
  editing instead of jumping to the top of the page.

## [0.1.51] — 2026-06-22
- Update checks now also fire **when you focus the app window** (debounced to
  once per 5 min), so a release cut while the app is open surfaces the
  "Restart & update" chip in seconds instead of waiting up to the periodic
  timer. Default check interval lowered 12h → 4h as a backstop.

## [0.1.50] — 2026-06-22
- **Chat is now saved and resumable.** Every conversation is a persisted session
  (one JSON file under `~/.config/idctl/chats/`), so threads survive navigation
  and restarts. A **session switcher** + **＋ New** in the header let you jump
  back to any past chat; each remembers its own title, agent, and focused
  project. Rename inline, delete with the ✕. Auto-saves as you go.
- **Generate images in chat.** A 🎨 button turns the composer text into an image
  via your OpenRouter provider (model picker — default `gemini-2.5-flash-image`),
  renders it inline, and **caches it** under `chats/images/` so it persists with
  the thread. Cost is shown per image. Images load as data URLs (CSP-safe); the
  reader is locked to the cache directory.

## [0.1.49] — 2026-06-21
- **Chat: focus on a project.** A new "focus" dropdown scopes the conversation
  to a tracked project — its name, folder path, and repo are sent to the agent
  as context with every message, so it knows what you're working on. The
  selection persists per team, and the focused project's path shows under the
  header with an "open ↗".
- **Chat: attach images and files.** A 📎 button in the composer opens a
  multi-file picker; selected files are copied (binary-safe) into the focused
  project's `uploads/` folder — or the target agent's workspace if no project is
  focused — and their paths are included in the message so the agent can read
  them (images included). Attachments show as removable chips before sending.

## [0.1.48] — 2026-06-21
- Self-update: a build that was already downloaded in a previous session now
  surfaces the "Restart & update" chip **immediately on launch**, instead of
  waiting for the next online re-check (which could fail offline and hide a
  ready update). The chip appears whenever a staged build is newer than the
  running one.

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
