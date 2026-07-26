# ID Agents Control Center — Product Spec

_Updated 2026-07-26 · reflects the unified **v0.1.685 production candidate**.
This is a page-by-page specification of the desktop application that will ship
when the signed candidate is promoted._

---

## 1. What it is

**ID Agents Control Center** is a macOS, Windows, and Linux desktop application
(Electron + React) for running a private fleet of AI agents. One installation
contains the interface, the pinned Agent Manager, and the pinned Brain. The
application verifies and supervises both services on random loopback ports and
owns their mutable data inside the active user profile; consumers do not need
to install or update either service separately.

### Architecture
- **Main process** (`src/main/*`) verifies and supervises the bundled Manager
  and Brain, holds the `ManagerClient` (HTTP), settings, keys, and OS
  integrations (file dialogs, git, local/provider discovery, and the
  Computer-Use broker). It exposes an allow-listed IPC surface to the
  sandboxed renderer via `window.idagents.call(method, …args)` → `bridge.ts`
  (Manager/Brain-proxied methods) + `main.ts appCall` (app-local methods).
- **Bundled services** run from an immutable, checksummed application payload.
  Manager and Brain state, generated work, skill catalogs, service logs, and
  automation cursors live under the active profile. Brain plans are read from
  the active profile's plan directory, and repository digestion is limited to
  projects explicitly registered in that profile; the application does not
  import an operator's home directory, current working directory, or bundled
  release sources as consumer memory. The Brain event listener is supervised
  alongside the two services. The mutation-capable bounded maintenance cycle
  defaults off and starts only after explicit Settings opt-in.
- **Profile privacy boundary:** app-owned config, goals, plans, Manager and
  Brain databases, generated state, credentials, logs, and caches are private
  to the active OS user. `workspace/` is an explicit user-content boundary:
  its root is private and new direct children inherit that protection, but
  IDACC does not traverse or rewrite ACLs inside an existing repository.
  Existing repository descendants retain their user-managed permissions, so
  their confidentiality remains the user's responsibility on every platform.
- **Renderer** (`src/renderer/*`) is the React UI. `store.ts` (`useFleet`) polls the manager every
  ~3s (agents/teams/inbox snapshot) plus a long-poll event cursor, exposing `store.{agents, teams,
  team, coordinator, events, inbox, connection, …}`. Expensive catalog and observability reads
  are coalesced behind longer caches or their own refresh cadence rather than rerunning on every
  fleet poll.
- **Holistic by default:** the app opens in an **All teams** view (`store.viewAll`, default on,
  persisted). Dashboard coordination spans every configured team, while its activity feed
  emphasizes currently active teams and its conversation is pinned to `default/lead`.
  **Action-centric pages** (Work, HR Manager, Capabilities, Computer Use) operate on one
  **active team** (`store.team`); pick a specific team from the status-bar selector (§2.2) to
  scope them. Holistic per-agent actions always carry the agent's **own** team. Counts shown are
  **running / total** agents.

---

## 2. Global UI (present on every page)

### 2.1 Sidebar navigation
Nine destinations: **Dashboard** ▦, **Inbox** ✉ (badge = pending messages), **Work** ☑,
**Projects** ◆, **HR Manager** ⛌, **Capabilities** ◫, **Identity & Keys** ⬡,
**Computer Use** 🖥, and **Settings** ⚙. Health now lives inside HR Manager as
the **Health** tab, while the legacy `health` route still opens that tab for compatibility.
The last-open view is remembered across launches (and self-update relaunches).

### 2.2 Status bar (footer)
`● <connection> · <manager URL> · view [<selector>] · <N/M> agents active · <K> teams running`.
- **Connection pill**: online / offline / connecting.
- **View selector**: defaults to **★ All teams** (holistic). Below it, every team — **active teams
  first** (≥1 running agent), then idle — each `● name running/total` or `○ name running/total · idle`.
  Choosing **All teams** sets the holistic view; choosing a team scopes the action-centric pages to
  it. (Running counts refresh every 20s via `work:teamLeads`.)
- **Counts**: in All-teams mode, running/total agents across the whole fleet + how many teams are
  running; in a single team, that team's running/total.

### 2.3 Toasts (bottom-right, global)
Long-running dispatches (compile & dispatch, fan-out, assign-to-fleet, triage) raise a toast that
shows a spinner while working and updates to **✓ result** or **⚠ error**. Toasts **live above page
routing**, so a confirmation still arrives if you navigate away (the work runs in the manager
process and is never tied to a view). Auto-dismiss after ~8s or on click.

### 2.4 Setup, prompt modal & update banner
Electron has no `window.prompt`, so text input uses an in-app modal (`usePrompt`). When a newer
release is staged, the sidebar shows **⬆ vX → vY · Restart & update**.

On a new or incomplete profile, the setup wizard verifies the bundled Manager and Brain, requires
a manager-executable runtime/model route with effective Brain MCP support, keeps Claude/Codex MCP
routes at runtime-level readiness, and requires model-specific `tools` evidence from a bounded
Ollama `/api/show` check before offering an Ollama model. Generic provider lanes and Ollama models
without deterministic tool evidence remain available for general work but are excluded from starter
setup with a clear diagnostic. Setup creates only missing neutral starter agents
(`lead`, `coder`, `researcher`). Existing starter agents are preserved. If the user explicitly
re-runs setup, IDACC first verifies the whole repair batch, then repairs stale runtime/model
assignments, missing effective Brain attachments, and stopped starters. A limited mode keeps Settings and diagnostics
available without claiming the starter workspace is ready.

### 2.5 Command palette, control drawer & receipts
**⌘/Ctrl+K** opens one fuzzy-search command palette for navigation, fleet refresh/probes,
project/work/org actions, plans, the task board, and runtime/capability controls. Focused actions
open a right-side drawer; deeper or higher-risk workflows hand off to their owning page. Unsaved
drawer edits require an explicit discard, and a running action keeps the drawer open until it
settles.

Medium/high-risk commands use propose → confirm before mutation. Every accepted command receives
an idempotency key and a bounded receipt showing running, succeeded, deferred, blocked, failed,
or timed-out state. Receipts survive page navigation and app restart, preserve recovery guidance,
and link back to the owning page. Offline or incompatible Manager capabilities block the handler
before it can mutate state.

---

## 3. Dashboard (nav: "Dashboard" ▦, route: `dashboard`)

**Purpose:** The operator's command entry surface — observe the live organization, talk to the
neutral `default/lead`, find or start a common action, and see an immediate durable acknowledgement.
Dense editors remain in Work, Projects, HR Manager, Capabilities, and Settings.

**What you can do**
- **Live Coordination**: read the primary → secondary → team-lead hierarchy, each team's worker
  state (working / idle / stopped), current task evidence, and 24h fleet token-spend summary.
  Configured stopped teams remain visible; an incompatible hierarchy contract raises a visible
  recovery warning instead of presenting an empty fleet.
- **Lead chat**: manage multiple saved conversations with `default/lead`, focus one on a registered
  project, attach files, generate images, and watch query-scoped work activity. Team-specific chat
  and routing changes belong in HR Manager.
- **Confirmed chat controls**: propose `/dispatch`, `/project new`, `/promote-lead`, or `/triage`;
  inspect the exact impact and risk; then Confirm or Decline. Malformed reserved control syntax and
  attachment-bearing control commands are rejected locally and never fall through as ordinary
  agent messages.
- **Activity feed**: review recent Manager events, task state, cross-team communications, and Inbox
  needs across active teams, newest first. Expand long messages, copy the full message, and open
  recognized public addresses in their explorer.
- **Command surface**: use ⌘/Ctrl+K and the focused Project driver, Organization, Plans, Board, and
  Control center drawers described in §2.5. Advanced work always has an owning-page handoff.

**Data & actions:** `org:hierarchy`, `usage`, `events:multi`, `tasks:allTeams`, `news:allTeams`,
the shared fleet/Inbox store, Chat routes from §4, `manager:capabilities`, and the Manager-backed
drawer commands for project, organization, plan, task-lane, provider, and concurrency state, plus
read-only MCP catalog inspection.

**Known issues / polish**
- None outstanding for the v0.1.685 command-surface design. Fleet liveness is labeled **Probe
  all agents (health check)** in the palette/Health surface; provider model refresh belongs to
  Settings. Catalog reads are coalesced (runtime models use a five-minute cache), and Dashboard
  activity/usage use independent 15-second refreshes rather than the fleet's ~3-second poll.
- The narrower Dashboard controls are intentional: high-impact or highly detailed edits continue
  on the owning page with their full previews and guards.

---

## 4. Chat (embedded in Dashboard)

**Purpose:** A multi-session conversational workspace pinned to the neutral
`default/lead` on Dashboard. Optionally scope a conversation to a project, attach files, and watch
the lead's live tool/file activity stream. The composer also generates images and can auto-save
clear plan-request replies into Work › Plans.

**What you can do**
- Compose & send (Enter sends, Shift+Enter newline) to `default/lead`. Use HR Manager and the
  owning team workflows for team-specific routing.
- **Focus on a project** (dropdown) — adds a `[Focus: …]` context line and sets the attachment
  destination; banner with **open ↗** to Finder.
- **Attach files** (📎 / paste / drop) — chips with remove; land in `<project>/uploads` or the
  agent's workspace.
- **Generate an image** from the same composer (conservative local intent-detection; only when an
  image-capable provider is configured; routes to local/free first). Renders inline with model + cost.
- **Auto-save a reply as a Plan** when the message reads as a plan request.
- **Live "behind the scenes" feed** while a dispatch runs (tool/file steps + delegations,
  elapsed timer); a collapsible trace persists with the finished reply.
- **Sessions:** open/rename/delete chats, ＋ New, unread dots, auto-titled from the first message.
- **Resumable dispatches:** the exact Manager query ID is persisted before the composer unlocks.
  Polling continues while Dashboard is mounted and resumes for every saved in-flight chat when
  Dashboard or the application reopens; a backgrounded reply then lands in the right chat with an
  unread badge. Transient failures auto-retry, and a sustained outage posts one soft notice without
  discarding the recovery handle.

**Data & actions:** `chats:list/get/save/patch/remove/inflight/markRead/unreadCount`,
`chat:genTitle/pickFiles/saveFiles/savePasted`, `dispatch:start` + `query:poll`, `activity:get`,
`image:models/generate/read`, `projects:list`, `project:openFolder`, `plans:save`,
`App navigation:teams:route`.

**Known issues / polish**
- The dead `endRef` path is removed, plan auto-save uses a conservative explicit plan-intent
  heuristic, and reserved Dashboard control commands cannot leak into ordinary chat when malformed.
- Reply delivery, the agent's own activity, and the delegation strand are query-ID scoped. Broader
  Manager events remain available in Dashboard activity, but Chat intentionally excludes them from
  reply annotations so concurrent work can never be attributed by a timestamp guess.
- Message appends, title/focus changes, reply delivery, and system notices use targeted
  read-merge-write patches so concurrent updates do not overwrite one another. Delete is
  single-flight, rechecks after confirmation, and explicitly warns when a pending reply would be
  discarded.

---

## 5. Inbox (nav: "Inbox" ✉, route: `inbox`)

**Purpose:** The one place you answer things that are blocked on **you** — multiple-choice task
decisions raised by agents, and direct questions the manager is blocked on.

**What you can do**
- **Decisions needed** (shown when present): each blocker question from a task renders its prompt +
  the agent/task it concerns + **clickable option buttons**. Picking one delivers your answer to the
  blocked agent (`/ask <agent>`) and clears the question; **Skip** dismisses without answering. These
  are an app-side queue (`questions:*`), populated by Work › Tasks "⚠ Surface blockers".
- **Manager inbox**: each item the manager is blocked on, with an inline **reply** box (⌘/Ctrl+Enter
  to send) and **Dismiss**. The header reads "N waiting on your reply", or "nothing needs a reply
  right now" when empty (with "You're all caught up").

**Data & actions:** `questions:list/add/remove`, `dispatch` (deliver answers), `inbox:respond`,
`inbox:dismiss`; nav badge = `store.inbox.length`.

**Known issues / polish:** none outstanding (the misleading "manager is blocked" empty-state header
was corrected in v0.1.116).

---

## 6. Work (nav: "Work" ☑, route: `tasks`)

A tabbed workspace: **Plans · Tasks · Schedule · Loops · Dream** (default: Plans).

### 6.1 Work › Plans
**Purpose:** Two plan sets under one organizer — **Brain plans** (the live plan set the brain
maintains on disk) and **Your drafts** (local AI-generated plans you can version & revise).

**What you can do**
- **Compact organizer bar**: search, sort, lifecycle counts, a **Completed** reveal, and an optional
  **Filters** tray for grouping, plan status chips (pending/partial/paused/done), draft status chips,
  and draft tags. **Request plan** (top) → an agent drafts Markdown → saved as a draft.
- **Drafts**: compact scan rows plus open/rename/status, browse & **restore past versions**,
  **revise with AI** (each revision = a new version + changelog note); promoting a draft writes the
  live Brain plan and removes the draft copy so the plan does not appear twice.
- **Brain plan actions** (per row): **Work / Continue / Resume** runs the guarded plan work path
  that audits status, surfaces blockers to Inbox when needed, and delegates remaining work; the
  **Status** menu writes guarded Pending/Partial/Paused/Done lifecycle changes back to the brain
  README.
- **Lead delegation**: after audit and blocker scan, clear plans are handed to the primary lead to
  decompose, prune already-done work, and delegate scoped objectives to the right team leads; if no
  primary lead is online, the fallback decomposes once, partitions dependency clusters across active
  team leads, creates work cards, and dispatches them.

**Data & actions:** `brain:plans/plan/setPlanStatus`, `plans:*` (draft store), `work:decompose`,
`work:createPlan` (lane + dispatch), `work:teamLeads`, `work:fanout`, `dispatch`.

### 6.2 Work › Tasks (the Kanban)
**Purpose:** A drag-and-drop board over the manager's tasks, with richer lanes than the manager's
three statuses (`todo|doing|done`) via an app-side **lane overlay**.

**Board layout (8 lanes in 3 groups):**
- **Adjustment Loop** (full-width band on top): Needs Adjustment · Under Review · Rework.
- Below, side by side: **Waiting Areas** (⅓ width): Backlog · Holding Pattern — and **Main Flow**
  (⅔ width): To Do · Doing · Done.
- Lanes map onto the real status (`backlog/holding/todo→todo`, `doing/needs-adjustment/under-review/
  rework→doing`, `done→done`). The board scrolls sideways on narrow windows.

**What you can do**
- **Drag a card between lanes** — saves the lane overlay and sets the mapped status if it changed.
  Cards **auto-reposition** as agents claim/complete work (5s poll).
- **Richer cards**: an **● working** green pulse when an agent has actively claimed it, plus a
  timeline — *created Xm ago · working Xm · done Xm ago* (exact timestamps on hover);
  assigned-but-not-started reads *◴ queued*. Inline owner/assign dropdown (stopped agents marked
  `· stopped`).
- **⚖ Triage To Do (N)** — the lead reviews every **unassigned** task in the To-Do lane, assigns
  each to the best-fit **active** agent, and dispatches it (Backlog/Holding are left alone). An
  **auto** checkbox keeps the lead doing this for new unassigned To-Do tasks (~90s throttle).
- **⚡ Assign work to fleet** — describe an objective → the lead decomposes it into sub-tasks
  (owners + dependencies), preview/edit owners → **Decompose for <team>** then create + dispatch
  (independent tasks run in parallel; dependents follow). Normal assignment scopes and proposal
  owner dropdowns show execution targets rather than coordinators/default validators; use **⇄ Fan
  out to N teams** to hand the same objective to other teams' active leads for delegation.
- **⚠ Surface blockers** — the lead surfaces task decisions that need **your** call as
  option-questions in the **Inbox**.
- **Done auto-archives** (hidden by default) with a **show archived (N)** toggle and a Done-lane
  reveal; **Clear archived** permanently deletes completed ones; **hide routine** toggle; search.
- **+ New task**.

**Auto-route to active agents:** decomposition/assignment/triage route only to **running** agents
(the lead is told never to assign a `[STOPPED]` agent; stopped owners are reassigned at dispatch;
teams with no running agent are reported and skipped).

**Data & actions:** `tasks:lanes/setLane`, `remote` (`/task …`), `work:decompose/createPlan/
fanout/teamLeads/triage`, `questions:add`, `dispatch`.

### 6.3 Work › Schedule
**Purpose:** Per-agent **heartbeats** (interval self-checks) and a **supervision check-ins** tracker
(auto-created watchers that ping a delegator about a tracked task on a cadence).
**What you can do:** set/enable/update a heartbeat interval (1m–24h) and its internal self-check
objective per agent, pause/resume, or disable it; see status (♥ on / paused / ⚠ missed / ⚠ last run
failed); view check-ins with cadence & fire counts, **Close** one, or **🧹 Clean up N** stale ones
(watching finished/removed tasks).
**Data & actions:** `schedules` (`/schedule list`), `checkins`, `addHeartbeat`, `pause/resume/
removeSchedule`, `checkins:close`.
**Polish:** the page says the Manager *may* auto-close a supervision check-in when completion is
observed; it never promises that every check-in closes automatically. Heartbeat objectives are
editable. Close, disable, and bulk cleanup use preview confirmation, re-read the exact schedule or
check-in set after confirmation, and fail closed if state changed or cannot be verified. Scheduled
self-check definitions persist across restarts, but the bundled Manager dispatches them only while
the unified IDACC application is running.

### 6.4 Work › Loops
**Purpose:** **Agent chains** (an AI-drafted sequential agent→task pipeline; each step's output
feeds the next; runs on demand while the app is open) **and** **Scheduled objectives** (one agent
runs a fixed objective on a persistent calendar cadence through the bundled Manager while IDACC is
running; the definition resumes after restart).
**What you can do:** draft a chain from a goal (✦ Draft chain), edit/reorder/add/remove steps, save,
run (per-step live status + output, stops on failure), load/delete saved chains; create scheduled
objectives (agent + objective + cadence + time), Run now, pause/resume/delete.
**Data & actions:** `loops:list/get/save/remove`, `dispatch`, `schedules`, `addCalendarCheckin`,
`pause/resume/removeSchedule`.
**Polish:** the builder and tracker label the on-demand/persistent-cadence distinction directly.
Editor, AI-import, legacy-load, run, schedule, and profile-store paths share one 20-step limit; the
store rejects oversized writes instead of silently truncating them. Run-now failures identify the
exact step or `team/agent`, and every scheduled mutation rechecks the current row after confirmation.
Dream schedules are excluded from the Scheduled objectives table.

### 6.5 Work › Dream
**Purpose:** Have an agent run an offline "dream" — a reflection over recent work + the brain/memory
— returning a Markdown report (Consolidation / Insights / Ideas / Simulations), saved as a digest.
**What you can do:** pick an agent + optional focus → **✦ Dream now** (saved + opened); configure a
recurring Dream's time and days; create, edit, pause/resume, or delete that schedule inline; see each
matching schedule with active/paused, timezone, last-run, and last-status evidence; browse/expand/
delete saved dreams.
Saved reports render their Markdown headings, emphasis, inline code, bullets, and numbered lists as
readable content.
**Data & actions:** `dreams:list/get/save/remove/archiveScheduled`, `dispatch`, `schedules`,
`addCalendarCheckin`, `pause/resume/removeSchedule`.
**Polish:** completed scheduled reports are joined from the durable agent news history using the
schedule receipt's exact Manager query ID, then saved idempotently in the active profile's Dream
archive. The background reconciler imports reports completed while the Dream view was closed and
reconciles any durable pre-shutdown completion after the unified stack restarts. Dream cadence
definitions persist across app restarts; they do not claim to execute while IDACC is closed.

---

## 7. Projects (nav: "Projects" ◆, route: `projects`)

**Purpose:** A local project tracker (status/description/team/tags/links/notes) with live git state
and one-click git ops. IDACC can detect the workspace root, but adding its subfolders to the tracker
is an explicit, previewed **Sync workspace** action.

**What you can do:** browse/filter by status (with counts); see & change the workspace root;
**⟳ Sync workspace** (additive/idempotent discovery); **⤓ Add from GitHub** (clone SSH→HTTPS,
auto-fill from GitHub API + README); **Import folder…**; create/edit projects; per-card quick
status; delete (folder left intact); **✨ Refine with lead** (AI description+tags); per-project git
panel — status badge (branch, ahead/behind, fork, dirty), **open ↗**, and whitelisted git actions
(**fetch / pull / status / log / diff**) streamed into a `<pre>`, plus **remote ↗**.

**Data & actions:** `projects:list/save/remove/detectRoot/syncRoot`, `project:git/gitRun/readme/
pickFolder/openFolder/cloneGithub/githubMeta`, `dispatch:start/query:poll`.

**Polish:** Project-team AI helpers are pinned to the selected project's team, git fan-out ignores stale
loads after newer project snapshots arrive, removed rows close their inline panels, and crowded project
headers wrap long names/actions instead of overflowing. Deleting the last tracker row now remains
deleted on reload; IDACC reports the detected workspace for review and never silently auto-syncs it
back. A later explicit **Sync workspace** can intentionally re-add folders that still exist.

---

## 8. Health (HR Manager tab: "Health"; legacy route: `health`)

**Purpose:** Fleet health — reported token-throughput telemetry + a cross-team roster
with on-demand liveness probes.

**What you can do:** read the **throughput gauge** (fresh sample only when manager telemetry is less
than 15m old; otherwise 24h average), **24h / 7d** windows (reported tokens, turns, avg/turn, avg
tok/s), and **per-agent/per-model 24h** breakdown; browse the **all-teams roster** (grouped, active
team first, "N/M up"); **Probe all** / per-row **Probe** → a results panel with pass/fail, duration,
and errors.

**Data & actions:** `usage` (`/usage`, null when absent), `agents:allTeams`, `probeAll/probeOne`.

**Polish:** token numbers are manager-reported harness performance telemetry for trends, not provider
billing invoices. Provider invoices remain provider-owned; IDACC does not estimate or reconcile them
from heterogeneous subscription, API, and local-runtime token reports. The source is labeled
**harness telemetry**, and stale last-turn samples remain visible but no longer drive the live gauge. The model-lanes
panel uses aligned runtime/type/models/source/checked columns plus the same Settings availability gate
as the per-agent Harness dropdown: unavailable curated fallback harnesses are hidden unless already
assigned, synced API/provider lanes are selectable through the manager `provider-api` harness, and
unsynced API lanes stay visible but disabled until **Connect & sync** succeeds. The per-agent Model
dropdown follows the effective staged Harness catalog: changing Harness
resets the staged model to a valid option for that harness, and stale saved cross-harness model values
show as drift instead of selectable options.
The per-agent **Speed** picker appears only for Claude Code runtimes. **Standard** explicitly disables
Claude Code fast mode for that managed agent; **Fast (Opus · usage credits)** requests Claude Code's
supported fast service tier after the reviewed rebuild. Fast retains the supported Opus model's
quality and capabilities and does not lower the separately selected reasoning effort, but Claude Code
can switch a different configured model to a supported Opus model. Fast costs more per token, requires
a compatible Claude Code release, billed usage credits (extra usage), and any organization approval,
and can fall back to standard speed when unavailable or rate-limited. Those model, billing,
eligibility, and fallback effects are stated in the picker and again in the apply confirmation before
IDACC writes the preference.
Roster color and Probe-all eligibility use exact Manager lifecycle states plus structured health.
Explicit unhealthy evidence wins over an optimistic lifecycle label; PID alone is never liveness
proof, and the remote fallback requires both a recent last-seen timestamp and a recent successful
probe. Probe-all blocks if the complete current fleet cannot be re-read. An unfamiliar status
remains **unknown** and is never guessed to mean running.

---

## 9. Identity & Keys (nav: "Identity & Keys" ⬡, route: `identity`)

**Purpose:** Manage each agent's onchain identity (ENS/ID-chain domain + OWS/provider wallet) and
its ERC-4337 smart account, including time-boxed, scope-limited **session keys**. Today it can run
against a mock provider ("Base Sepolia (mock)") while keeping the same UI contract for a real
Safe4337 + bundler path. The page also shows the enabled agent chain RPCs from Settings as the
chain allowlist a granted key can use once a live signing provider is wired.

**What you can do:** pick an agent; see identity (domain/wallet), idempotently **Register identity**,
**Provision wallet**; review Brain controller sync; **Verify live evidence** through configured RPCs
(Ethereum ENS resolver/address binding plus deployed bytecode for the Agent Safe and declared
metadata contracts); review onchain metadata standard coverage for ENSIP-24,
ERC-8004, ERC-8048 / ERC-721T, ERC-8049, and B20 `extraMetadata`; review **Operational Chain
Access** from Settings RPCs without exposing RPC keys; see the Safe account (deployed vs
counterfactual, address, owner), **Create account**, **Deploy**; list **session keys** (scope,
address, time-remaining / revoked / expired), **Revoke**; **Issue a session key** by scope preset
(registry-write / skill-publish / payments / full) + TTL preset (1h / 24h / 7d / 30d / until revoked).

**Data & actions:** `keys:caps/presets/list/ensure/deploy/issue/revoke`, `evmRpc:list`,
`identity:register/verifyEvidence`, `wallet:provision`.

Every identity, wallet, account, session-key, authority-revocation, and live-signing write reports
an inline **Action failed** or operation-specific error with its recovery context; write failures
are no longer swallowed.

**Guardrails:** controller-wallet precedence is OWS address, generic provider-wallet metadata,
legacy SkillMesh provider metadata, then address-shaped OWS wallet. The standards panel is read-only
and recognizes common manager metadata fields for ENSIP-24 arbitrary resolver data, ERC-8004 agent
registry/agentURI/agentWallet evidence, ERC-8048/ERC-721T token-level context/endpoints, ERC-8049
contract-level metadata, and B20 `extraMetadata` without dumping raw resolver bytes, contract bytes,
or issuer-defined metadata blobs into the UI. Live reads verify the configured RPC chain, ENS
registry → deployed resolver → EVM address path, and runtime bytecode at the selected/declared
contracts; they do not equate deployed bytecode with conformance to a particular metadata ABI.
Operational Chain Access is read-only: it mirrors enabled Settings RPC networks, key-source labels,
last probe status/block, and mock-vs-live signing mode. RPC secrets remain encrypted in the main
process and a mock key provider still means no IDACC transaction broadcast, even when chain RPCs are
configured.

**Polish:** Register re-reads the current Manager row and returns a visible no-op when a public domain
already exists, so it cannot submit a duplicate registration transaction. A Manager identity record
is labeled as declared until the live ENS resolver address matches the selected controller or Agent
Safe; resolving an address with no comparison target is not marked verified. Verified controller
signatures are discarded after recovery and only their short-lived proof timestamps remain. ENS
address binding and deployed-contract evidence are live-verifiable, but neither generic bytecode nor
an ENS address record proves draft metadata-standard conformance. Standard-specific external
verification for ENSIP-24, ERC-8004, ERC-8048/ERC-721T, ERC-8049, and B20 requires canonical targets,
versioned ABI/interface contracts, and subject bindings from the Manager/backend before those
individual claims can be marked verified. Manifest hashes, metadata-hook trust, and runtime signatures
remain external trust claims until the Manager supplies a versioned attestation schema and trust roots.

---

## 10. HR Manager (nav: "HR Manager" ⛌, route: `teams`)

**Purpose:** The org-design surface — create teams & agents, shape hierarchy (coordinator/lead,
primary cross-team lead), edit per-agent instructions, and govern cross-team delegation. (File:
`Teams.tsx`; page title "HR Manager".)

**Ownership:** The person using IDACC owns staffing, instruction-drafting, and hierarchy decisions.
The app does not assume an organization-specific legal, HR, or escalation team; optional specialist
teams can be added explicitly when a workspace needs them.

**What you can do** — four top-level tabs: **Structure · Health · Build · Manage**, plus header
**+ From template** and **✦ Build a team**.
- **AI Team Builder** (describe/paste a spec → live deterministic parse → **✦ Build with AI**
  (`team:designAI`, constrained to Settings-available harnesses, synced API provider lanes, models, and skills) → editable roster (per-agent ★lead,
  name, runtime, model, role, persona/instructions, skill chips) → fleet-wide options (multiple
  MCP servers, shared skills, heartbeat, OWS wallet, probe-after) → **Build** for a new team or
  **Build + merge** for an existing target (sequential `onboard:run` with duplicate names skipped,
  explicit **One new agent** reset for single-agent adds, automatic runtime/model verification that
  refreshes every manager-assignable subscription CLI (including Claude Code, Codex, and Grok
  Build) and live-probes local plus selected API provider lanes before confirmation, then rechecks
  only the subscription runtimes in the pending batch before any spawn, requires the connected manager's
  side-effect-free runtime preflight to resolve the exact runtime/model pair and verify it on the manager
  host, repeats that check at each onboarding boundary, a live checklist, then optional
  coordinator/default-primary + instructions + relay wiring) → per-agent **↻ retry**).
  Fresh installs never infer that an offline local server is usable from cached model metadata:
  Ollama and LM Studio lanes require a successful recent loopback probe, and rows remain unassigned with
  an actionable Settings handoff when no manager-executable runtime is ready. Team creation remains
  disabled while readiness is unresolved; curated model names and a paid web subscription are not
  execution evidence without the corresponding installed, authenticated CLI. If the bundled Manager
  cannot satisfy the current preflight contract, the build remains blocked and the UI hands off to
  the single verified IDACC application update path instead of creating a partial team. Team
  building changes only the reviewed roster: it preserves coordinators, lead instructions, and
  relay policy, then hands routing review to the one authoritative **Manage > Hierarchy** editor.
- **Create team from template/config** (+ From template): pick source (default template / library
  template / saved config), name it, debounced **Preflight** preview, create.
- **Structure**: live **team graph** (lead-on-top, click to select/switch), **⭑ make primary lead**,
  selected-agent panel (reassign team, routing, rebuild, goals/instructions editor with preset +
  ✦ AI draft + save & rebuild), selected-team panel (build/add, relay, **Start/Stop/Probe/Rebuild
  all**), teams table (switch/manage/delete empty non-default), lead-hierarchy coordinators.
  Structure now treats `/teams` as team-existence authority: all-agent roster groups can populate
  member rows only for teams still present in the current team list, successful team deletes are
  tombstoned locally, and Structure plus Manage routing overview hide the manager-reserved empty
  `public` namespace until it contains actual public-agent registrations.
- **Hierarchy configuration is independent from process liveness**: any current roster member can
  be selected as a team coordinator, including a newly created or stopped agent. Non-running leads
  remain visibly marked and cannot receive execution work until started; org sync persists their
  role and defers their rebuild instead of preventing the organization from being configured.
- **Health**: the former top-level Health page embedded between Structure and Build. It owns token
  throughput, all-team fleet roster, liveness probes, runtime/model draft changes, and read-only
  model-lane evidence in the same HR context as team structure and staffing.
- **Build**: one-click builder for a new team or direct merge of reviewed new agent rows into an
  existing team; the compact Team maintenance row handles rename/merge for already-created source
  teams through the manager-backed `/agents/:id/team` move route, scoped to the source team and able
  to create an empty target team only for reviewed rename actions.
- **Manage**: merged management + routing workspace. **Team ops** owns lifecycle-only controls
  (Probe/Start/Stop/Rebuild/Delete empty teams); **Overview** shows cross-team relay at a glance;
  **Hierarchy** owns coordinators, default-primary review, team relay, per-agent relay overrides,
  protected default validators, additional default-team validators, coverage, and org sync.

**Data & actions:** `agents:allTeams`, `runtime:models`, `librarySkills`, `providers:list`,
`teamConfig`, `setTeamDelegates`, `setAgentDelegates`, `agent:getInstructions/setInstructions`,
`rebuildAgent`, `ai:draft`, `team:designAI`, `onboard:run`, `coordinator:hierarchy/set/setPrimary`,
`agent:move`, `team:lifecycle/probe/delete`, `libraryTeams`, `configs`, `team:preflight/install`,
`deployTeam`.

**Polish:** the duplicate Builder relay/coordinator editor has been removed. **Manage > Hierarchy**
is the single routing authority, and per-agent rows now distinguish inherited team policy (including
its effective value), explicit all/selected policies, and an explicit blocked override. Coordinator
and primary-lead writes report confirmed persistence, compatibility blocks, and Manager failures
instead of silently no-oping. AI drafting still requires an active HR-capable agent; when none is
available the control is disabled with that dependency shown.

---

## 11. Capabilities (nav: "Capabilities" ◫, route: `modules`)

**Purpose:** One workbench to extend what agents can *do* — register/test/attach **MCP** tool-servers,
browse/create/install **Skills**, inspect/digest neutral **Plugins** — applied across a multi-agent
selection in the active team.

**What you can do**
- **Shared header**: team dropdown + an **"apply to" agent chip row**. Skills/plugins default to all
  in scope; MCP starts with no selected targets so tool-server attachment is always explicit. Runtime
  support is advisory, so local/API/subscription runtimes can receive neutral MCP/skill/plugin metadata
  while execution adapters remain explicit.
- **MCP servers**: compact server table (server/endpoint, attached `have/target`, status, actions),
  per-row **Attach / Detach / Test / ✕**, **Rebuild <targets>**, and a hidden **Add server** panel
  for catalog/custom MCP profiles. The reference/test `everything` server is parked and filtered from
  settings/attach payloads so it cannot be bulk-attached to production agents. `mcp:list` and
  `mcp:test` stay read-only; only add/remove emit cross-page sync. Removing a registry profile first
  re-verifies, detaches, and rebuilds every current agent copy across teams; the catalog entry is
  deleted only after all copies are clean.
- **Skills**: catalog cards (license, install `have/target`, tags incl. **auto-categorized**),
  **Install / Uninstall** per selection, two-step **delete**, search + tag filter, batch
  offline deterministic **auto-categorize** plus explicitly confirmed **AI re-tag…** (the only path
  that may use billable model capacity), **Create skill**, low-noise Brain skill count/sync chip,
  and explicit **Preview & sync** for Brain catalog writes. Brain-wide Health/Fleet/Agents/Graph
  review states guard the Brain launchers but do not render as Skills-tab notices.
- **Brain dashboard popouts**: Fleet, Health, Skills, Learning, Agents, and Graph are treated as
  read-only observation surfaces. They lead with `/fleet-report`'s IDACC manager authority when live,
  fall back to Brain cache only with explicit cache/partial warnings, expose redacted optional-provider
  identity evidence and advertised-skill summaries, and avoid dashboard-side
  approval/replay POST controls.
  Brain Agents now mirrors the Identity & Keys controller-wallet precedence (`ows_address`, then
  optional provider wallet address, then address-shaped OWS wallet) and shows per-agent total ETH
  gas spend vs last-24h ETH gas from Brain timeline transaction/gas evidence.
  The Brain listener snapshots every manager team into team-qualified cache rows, retires
  no-longer-live rows as stale, and `/fleet-report` excludes stale rows when comparing live manager
  totals against Brain cache, so duplicate bare-name agents do not create false drift.
  Organization-specific integrations are treated as optional providers/plugins: neutral agents do not
  receive provider keys or env vars unless that provider is explicitly attached or opted into.
  IDACC GUI examples, HR first-run lead presets, manager recommendation hints, and Brain table labels
  use generic provider language; generic provider-wallet metadata is first-class while legacy provider
  metadata remains read-only compatible.
- **Brain Graph**: `/graph/app/data` is a sanitized node-link snapshot. Entity data is reduced to
  safe matching/display fields; live lifecycle, provider/plugin address, and skill counts come only from
  the unambiguous `/fleet-report` overlay; raw metadata, private keys, creator keys, auth tokens,
  wallet secrets, and MCP env values are not exposed.
- **Plugins**: compact active-package table (package, kind, reach, action). Instruction-only wrappers
  can be **Digest** after a fresh-read guard, then disappear from Plugins and live in Skills; a small
  **In Skills** count shows what moved. Tool-bearing/hybrid packages stay here until reviewed adapters exist.

**Data & actions:** `mcp:list/add/remove/test`, `librarySkills`, `libraryPlugins`,
`libraryPluginInspections`, `skills:autoTags/categorize`, `createSkill`, `projectPluginSkill`,
`deleteSkill`, `installSkill/uninstallSkill`, `setAgentMcp`, `rebuildAgent`.

**Polish:** **Rebuild** remains available for selected agents after detaching the final MCP server.
Attach/detach sends the freshly read prior server set as a compare-and-swap precondition, so a
concurrent capability edit is rejected for refresh instead of being overwritten. Secret-bearing
MCP rows are compared in redacted renderer form but reconciled and committed with exact unredacted
Manager state in the main process. Multi-target MCP writes restore confirmed earlier writes if a
later target fails, without overwriting a target that changed again. Registry deletion re-checks
the complete fleet after deletion and restores the catalog row if an attachment appears or fleet
verification fails. Opening the page categorizes locally and cannot invoke a model; possible model
cost is disclosed before the operator-confirmed AI refinement action.

---

## 12. Computer Use (nav: "Computer Use" 🖥, route: `computer`)

**Purpose:** Let a blessed agent with a Manager-executable MCP runtime see your Mac's screen and drive mouse+keyboard,
watched live in-app, routed through an in-app **broker** that only acts while **ARMED**. Disarmed by
default; gated on macOS Screen Recording + Accessibility; per-action approval, pause, and panic stop.
Screen Recording and Accessibility stay strict hard gates. Input Monitoring and Automation are
best-effort macOS TCC readbacks: when macOS blocks inspection or Automation has not recorded a
target app yet, the permissions card shows an amber manual-verification state instead of a red
denial. If the operator verifies the IDACC app directly in macOS Settings, the row can be marked
verified locally; that is a UI readback override only and does not weaken the Screen Recording or
Accessibility gates.

**What you can do:** **Arm/Disarm** (Arm blesses the currently-attached agents across HR-synced
teams); **Pause/Resume**;
**PANIC** (■, never blocked, global hotkey ⌘⌥⇧P); choose any connected display and watch its
**live view**; manage **Permissions** (Open Settings / Relaunch / Re-check); **Bless / Repair /
Remove** one or more
capable agents from any HR Manager team (attaches the bundled `mac-control` MCP server + rebuilds
that agent in its own team); read the **Activity log** (last 40,
blocked actions flagged); toggle **Safety → "Approve every action"** (supervised default-on; in
autonomous mode risky actions — Trash, ⌘Q, destructive shell — are still held); respond to
**approval prompts** (Allow/Deny, 60s auto-decline).

**Data & actions:** `cu:permissions/status/attached/audit/arm/disarm/pause/setSupervised/panic/
confirm/watch/setDisplay/openPermission/relaunch/attach/detach`, `rebuildAgent`; push events `onComputerFrame/
Pending/Panic`; 2.5s poll.

**Polish:** bless eligibility uses the shared runtime capability table and requires both a current
Manager harness and native MCP support. A failed initial rebuild automatically revokes/rolls back the
attachment; every existing attachment also has a visible **Repair** action that refreshes its scoped
token before rebuilding. An interrupted multi-team armed-set refresh disarms the broker. Display
selection declines pending actions and resets the coordinate anchor; every action is bound to the
same Agent, display ID, geometry, and fresh screenshot before and after approval. Screenshot edge
coordinates cannot map onto an adjacent display, and coordinate-free scroll first moves to the
selected frame's center.
The bounded ~2.2fps live pane still uses React frame state.

---

## 13. Settings (nav: "Settings" ⚙, route: `settings`)

**Purpose:** The infrastructure control panel — the machine, the connection, the AI backends/
subscriptions/local models/image servers, and self-update. (Team composition is configured in HR
Manager; this is the plumbing.)

**What you can do** (by card):
- **Hardware**: read-only host compute (chip, cores, GPU, memory, disk) — used for local-model fit
  warnings.
- **Connection**: manager URL, active team, read-only coordinator status, and an HR Manager Manage
  handoff for hierarchy/routing changes.
- **Manager/local/backend diagnostics**: manager extension compatibility,
  open-or-pinned provider routing, local runtime readiness, backend readiness, and contextual fixes
  live in the cards that own those systems instead of a separate first-run checkpoint.
- **Self-update**: IDACC, Agent manager, and Brain have one versioned application update authority.
  The card shows the bundled component versions and live readiness, checks only the compiled
  `bobofbuilding/idacc` release feed, and never offers a separate Manager install or update action.
  electron-builder metadata verifies downloaded bytes, macOS/Windows production releases require
  platform signatures, downgrades and prereleases are rejected, and applying a staged build still
  requires the explicit **Restart & update** action. The installer is not started until the
  application-wide shutdown coordinator has quiesced UI mutations, stopped background loops, and
  completed bounded Manager/Brain process-tree cleanup. Linux AppImage builds support that
  replacement path; Debian packages direct the user to the system package manager instead.
- **Managed subscription sign-ins**: CLI OAuth/device/browser flows (no API key) for `claude-*`,
  `codex`, `cursor-cli`, `grok`, Antigravity `agy`, `copilot`, `kiro-cli`, `kimi-cli`, and legacy `q`
  only when installed. Rows distinguish
  status-inspectable CLIs from TUI-owned account state, auto-detect installed binaries after a
  visible installer handoff, show safe account labels from provider status/cache metadata when
  available, label live CLI-confirmed rows as signed in, label cache-evidence rows as account linked
  with a status-not-live caveat, hide uninstalled legacy-only rows, auto-expire account-flow notices,
  auto-check account status plus model freshness on Settings open/focus and every 5 minutes while
  mounted, warm the runtime model/freshness routes without silently installing or upgrading vendor
  CLIs,
  and keep managed account launches inside the Settings row even when the vendor CLI owns the final
  TUI/device-flow prompt. Sign out is shown only for installed/linked providers with a reviewed
  logout command. API-key and metered-provider accounts, including Perplexity, stay under
  **Inference backends** rather than the subscription sign-in card.
  Agent Harness pickers only offer manager-executable runtimes that Settings can currently prove
  through sign-in, route-ready API backend, or synced local-backend evidence; existing assigned
  runtimes remain visible as the current value for review. The bundled Manager includes executable
  harnesses for Grok Build, Antigravity, GitHub Copilot, Kiro, and Kimi Code, so each becomes
  selectable only after its corresponding installed/account-readiness evidence is available.
  Legacy Amazon Q remains a linked/current-only lane because the bundled Manager does not expose a
  Q harness. Synced API/cloud provider lanes
  such as OpenRouter and NVIDIA are selectable in Health and HR Manager Build via the manager
  `provider-api` harness; synced local OpenAI-compatible lanes such as LM Studio use the same
  provider-specific route and are never translated to the incompatible generic Ollama harness.
  Unsynced provider lanes remain disabled until their model list is refreshed.
  Agent Model pickers are keyed to the currently
  staged harness model catalog, so switching to Kiro, Codex, Claude Code, or a local harness cannot
  carry a stale model from the previous harness forward as a valid choice. Gemini CLI
  `oauth-personal` evidence is not part of managed sign-in availability because consumer Gemini Code
  Assist / Google AI Pro / Ultra OAuth is deprecated in Gemini CLI; use the Google Gemini API preset
  under Inference backends instead. Antigravity CLI is managed from Settings as the consumer
  subscription successor and is offered as an agent harness only after its live model probe confirms
  that the installed CLI is ready.
- **Local models & backends**: compact four-cell status summary for Ollama, routing, installed
  stacks, and catalog state; primary **Check catalog**, **Scan running**, and **Stack setup** actions;
  guarded next-step setup; quiet local concurrency when manager data is available; passive Ollama
  installed chips with explicit remove review; actionable update rows only when catalog digests
  change; and a searchable **catalog** with capability filters, Gemma 4 MLX entries, and hardware
  fit-warnings.
- **Agent chain RPCs**: EVM JSON-RPC endpoints agents may use when they hold an active granted key;
  keys are encrypted and the Identity page mirrors the enabled chain allowlist without exposing
  secrets.
- **Local image generator**: URL + API style (Stable Diffusion WebUI / OpenAI Images API),
  **Scan local**, Save/Clear, explicit saved-vs-draft state, configured loopback provider detection
  for alternate LocalAI-style ports, and local-first in-chat images with image-capable API backend
  fallback.
- **Local LLM stacks**: starter-first curated list with compact primary filters, an optional tag
  dropdown for advanced filters, **Scan running**, primary **Install** actions for command-backed
  start-here/easy/guided/advanced stacks, reviewed Run-in-Terminal/Uninstall actions, setup notes,
  docs ↗, host-platform and unresolved-template guards for advanced stacks such as vLLM and TGI,
  Docker readiness checks before container commands, `python3 -m pip` Python stack commands, Start
  actions and mapped-host-port detection for existing stopped containers such as LocalAI, LM Studio
  Start server handoff through its `lms server start` CLI when installed,
  live/configured/shared-default port warnings with alternate-port hints, local backend presets for
  shared-port stacks such as LocalAI, MLX, and TGI, automatic conflict-safe install command rewrites
  for Docker `-p`, `--port`, and `--tcp` port flags, automatic pending backend rows for installed
  local provider stacks even before their API server is running, automatic backend add/upgrade for
  matching live backend presets after a scan or after an Install/Start follow-up scan, concrete
  unavailable-install labels such as `Linux host required`, `choose model first`, or `manual setup`,
  and row-level **Add backend** as a fallback once a scanned local server is live.
- **Ollama catalog checks**: Settings performs a read-only public Ollama library scan on startup
  and every six hours while mounted. It compares installed `/api/tags` digests with public tag
  digests, surfaces explicit **Update** actions for changed installed tags, and lists newly
  discovered public tags outside the curated local catalog without automatically pulling them.
- **Inference backends**: provider table (★ default, enable, key badge, status, model list,
  **Connect & sync**, searchable Health model selection, ✕), API/cloud-focused **Add a backend**
  catalog or custom API endpoint, provider-specific key requirements, NVIDIA API Catalog preset
  models, pending installed local stack rows, successful local Connect & sync promotion to enabled,
  startable unreachable local-stack rows such as LM Studio, and cloud keys auto-detected from env,
  including `PERPLEXITY_API_KEY` for Perplexity. Local server setup belongs to Local LLM stacks above.
- **Local backend readiness**: a local provider that answers but returns no model list is displayed as
  `live · no models` and is not route-ready until a probe/sync produces at least one model. Local
  stack port warnings suppress a stack's own configured/discovered port so an installed LocalAI-style
  backend does not warn against itself.

**Data & actions:** `app:hardware`, `manager:capabilities`, `app:version`, `unifiedStack:status`,
`update:status/check/getSettings/setSettings`, `subs:status/signin/signout/install`, `manager:localConcurrency/
setLocalConcurrency`, `ollama:tags/catalogCheck/pull/remove`, `evmRpc:list/save/remove/probe`,
`image:getServer/setServer/detectServer`,
`app:runInTerminal`, `providers:list/add/remove/setDefault/toggle/connect/discover`.

**Polish:** managed sign-in no longer assumes success on a timer: the vendor flow stays pending until
the user selects **I've finished — re-check**, then IDACC forces a status refresh and reports
confirmed, not-yet-visible, or status-unavailable evidence. A staged unified update exposes
**Restart & update**, rechecks the exact staged version after confirmation, and applies IDACC,
Manager, and Brain together. Local concurrency running/queued counts refresh every three seconds
while Settings is visible, refresh on focus, and have a manual **Refresh** action with freshness/
unavailable evidence. Clipboard fallbacks confirm successful copy; when clipboard access is
unavailable, the full command or diagnostic report remains visible for manual selection.

---

## 14. Cross-cutting concepts

- **Scope is explicit**: Dashboard observation is holistic across current teams and its chat is
  pinned to `default/lead`. Work fan-out and HR Health can span teams. Action-centric editors use
  the active `store.team`; switch it with the status-bar selector. Per-agent holistic actions carry
  the agent's own team explicitly rather than borrowing the selected team.
- **Runtimes**: `claude-*`, `codex`, `cursor-cli`, `grok`, `antigravity`, `copilot`, `kiro-cli`,
  `kimi-cli`, and `ollama` are bundled Manager harnesses. Managed subscription harnesses become
  assignable only when Settings can prove the installed account route is ready. Legacy `q` remains
  linked/current-only because it has no bundled Manager harness. `ollama` / local servers and metered API providers are
  configured in Settings → Inference. MCP works where a runtime/tool harness supports it; skills and
  portable plugin packages are assigned as neutral metadata with Skill/MCP/native/direct-fallback
  adapters deciding execution.
- **Active-agent routing**: assignment, decomposition, triage, and fan-out target only **running**
  agents; stopped agents are skipped and reported.
- **Cross-team fan-out**: an objective can be handed to several teams' active leads at once
  (`work:fanout` → `/ask <team>/<lead>`), each running it independently and in parallel.

### Release process (operator note)
Run `scripts/release.sh "Meaningful summary" X.Y.Z --publish=true`. This is the
only production release path: it preflights GitHub authentication and signing,
updates both application manifests and the changelog, commits, creates a signed
annotated `vX.Y.Z` tag, atomically pushes the exact commit and tag, requires
GitHub signature verification, and dispatches the cross-platform **Production
release** workflow. The workflow builds, signs, verifies, attests, and assembles
the unified macOS, Windows, and Linux application. Use `--publish=false` for the
same production gates with a retained draft, and
`scripts/release.sh --resume X.Y.Z --publish=true` to continue safely without
duplicate publication. Lightweight or unsigned tags and local direct publishing
are rejected. The audited legacy cutover preserves the exact lightweight
and annotated `v0.1.620` through `v0.1.684` refs as immutable history. Its
schema-v3 record binds 63 exact lightweight refs, two exact unsigned annotated
tag objects, 62 exact published release identities, and 3 absent releases
(`v0.1.622`, `v0.1.624`, and `v0.1.625`). It fails closed if any tag object,
peeled target, signature state, or recorded release identity/state changes, or
if another incomplete tag appears. While the cutover is active, the current
published frontier `v0.1.684` is the changelog baseline. The first canonical
signed release must be greater than `v0.1.684`.
The app self-updates from the verified GitHub release feed. The retained Tauri
frontend is labeled and gated as a developer-only interface simulation; its
production package commands fail because it does not bundle or supervise
Manager and Brain.

---

## 15. v0.1.685 design closeout

The earlier review backlog has been reconciled against the production candidate. These items are
implemented and covered by focused smoke or rendered-interaction tests:

| Area | Completed behavior |
|---|---|
| Dashboard command surface | ⌘/Ctrl+K registry, guarded drawers, confirmed chat mutations, capability gating, idempotency, durable receipts, owner-page recovery, and rendered focus/interruption coverage |
| Dashboard / Health refresh | Fleet probes are clearly labeled as health checks; provider model refresh lives in Settings; catalog reads are coalesced and observability uses an independent cadence |
| Identity & Keys | Mutation failures surface inline with recovery context; Register is an idempotent no-op for an existing domain; live ENS resolver/address and deployed-contract evidence is available through configured RPCs |
| Capabilities | Rebuild remains available after the final MCP detach; MCP writes use fresh compare-and-swap state; registry removal cleans every agent copy before deletion; first-load categorization is offline |
| Computer Use | Bless eligibility uses declared MCP/harness capabilities; failed wiring rolls back with visible Repair; the armed set is re-synchronized; any connected display can be selected |
| Projects | Deletion is Manager-authoritative and guarded; reload never silently re-adds deleted rows; workspace discovery requires explicit previewed Sync |
| Work › Dream | Recurring schedules are configurable and managed inline; completed scheduled output is reconciled by exact query ID into the profile Dream archive; reports render readable Markdown |
| Work › Schedule / Loops | Heartbeat objectives are editable; schedule/check-in writes are freshness-guarded and confirmed; every loop path shares the 20-step bound; scheduled cadence copy reflects the bundled Manager lifecycle |
| Settings | Unified **Restart & update** revalidates the staged version; managed sign-in waits for explicit user completion before a forced recheck; concurrency counts refresh live; clipboard/manual-command handoffs always show truthful confirmation |
| HR Manager | Builder owns roster construction only; **Manage > Hierarchy** is the single routing authority and distinguishes inherited, explicit, and blocked relay state |
| Chat | Dead scroll-ref code is removed; plan detection is conservative; malformed or attachment-bearing reserved control commands fail locally; reply, activity, and delegation annotations are exact-query scoped; concurrent writes and deletion are guarded |
| First-run setup | Existing starter agents are preserved; stale assignments and stopped starters are repaired only inside an explicit, batch-verified setup run |
| Unified runtime lifecycle | Manager, Brain, listener, and cycle roots use retained POSIX process-group ownership or Windows Job Objects; a root crash cannot orphan descendants, failed cleanup blocks replacement, and every quit/relaunch/update path runs through one early graceful-shutdown coordinator |

The remaining external and intentional scope boundaries are documented here so they are not
mistaken for incomplete consumer design work:

| Area | External or intentional scope boundary |
|---|---|
| Identity & Keys | Draft ENSIP-24, ERC-8004, ERC-8048/ERC-721T, ERC-8049, and B20 conformance stays declared until the Manager/backend supplies canonical targets, versioned interfaces, subject bindings, and trust roots. Manifest hashes, metadata-hook trust, and runtime signatures likewise require a versioned external attestation contract |
| Health | Throughput is Manager harness performance telemetry. Provider invoices remain provider-owned and are not inferred from heterogeneous runtime token reports |
| Context compression | The optional Headroom retrieval resolver is a validated pilot, not a core route. Production uses deterministic direct routing and protected-content fallback until the Manager advertises a versioned resolve-before-act contract and quality gates pass |

_These boundaries do not prevent the unified application, Manager, Brain, local goals, or deterministic
context path from operating as documented in v0.1.685._
