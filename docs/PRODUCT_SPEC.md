# ID Agents Control Center — Product Spec

_Updated 2026-07-01 · reflects app **v0.1.396**. This is a page-by-page specification of
the desktop app as it actually ships today, produced by reviewing every page._

---

## 1. What it is

**ID Agents Control Center** is a macOS desktop app (Electron + React) — a mouse-and-keyboard
GUI for running a fleet of AI agents. It is a **control client**, not the engine: all agents,
state, identity, and workspaces live in the **id-agents manager daemon** (a local HTTP server at
`http://127.0.0.1:4100`). The app is to the manager what Lens/kubectl is to Kubernetes — it reads
and drives, it never owns the runtime.

### Architecture
- **Main process** (`src/main/*`) holds the `ManagerClient` (HTTP), settings, keys, and OS
  integrations (file dialogs, git, Ollama, subscriptions CLIs, Computer-Use broker). It exposes an
  allow-listed IPC surface to the renderer via `window.idagents.call(method, …args)` →
  `bridge.ts` (manager-proxied methods) + `main.ts appCall` (app-local methods; falls through to
  the bridge).
- **Renderer** (`src/renderer/*`) is the React UI. `store.ts` (`useFleet`) polls the manager every
  ~3s (agents/teams/inbox snapshot) plus a long-poll event cursor, exposing `store.{agents, teams,
  team, coordinator, events, inbox, connection, …}`.
- **Holistic by default (v0.1.119+):** the app opens in an **All teams** view — the Dashboard
  and activity feed show every team's fleet at once (`store.viewAll`, default on, persisted).
  **Action-centric pages** (Work, Chat, HR Manager, Capabilities, Computer Use) still operate on
  one **active team** (`store.team`); pick a specific team from the status-bar selector (§2.2) to
  scope them. In All-teams mode, per-agent Dashboard actions route to each agent's **own** team.
  Counts shown are **running / total** agents.

---

## 2. Global UI (present on every page)

### 2.1 Sidebar navigation
Ten destinations: **Dashboard** ▦, **Inbox** ✉ (badge = pending messages), **Work** ☑,
**Projects** ◆, **HR Manager** ⛌, **Capabilities** ◫, **Identity & Keys** ⬡,
**Computer Use** 🖥, **Settings** ⚙, and **Wiki** ▤. Health now lives inside HR Manager as
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

### 2.4 Prompt modal & update banner
Electron has no `window.prompt`, so text input uses an in-app modal (`usePrompt`). When a newer
release is staged, the sidebar shows **⬆ vX → vY · Restart & update**.

---

## 3. Dashboard (nav: "Dashboard" ▦, route: `dashboard`)

**Purpose:** The operator's home — a live surface over the fleet with inline runtime/model switching
and lifecycle actions, beside a real-time activity feed and a detail panel. **Holistic by default**:
shows every team's agents grouped by team (each group headed `team · N/M running`), or just the
active team when one is selected in the status bar. Per-agent actions route to that agent's own team.

**What you can do**
- Header summary: read-only `talk to` target showing the routed team lead; routing edits belong in
  HR Manager Manage, not Dashboard.
- **Probe runtimes** (header) — re-query each runtime's provider to refresh model lists.
- **Agent grid**, grouped by team in All-teams mode (lead pinned first within each group): name,
  status (colored dot), runtime, model, port, actions.
  Click a row to select it (populates the detail panel).
- **Runtime dropdown** (local agents only): switch runtime or a synced API provider lane →
  auto-picks a compatible model → rebuilds. Remote agents show a static runtime label.
- **Model dropdown**: pick from the runtime's models (+ current); selecting rebuilds immediately. A
  model/runtime mismatch is flagged `⚠` with a tooltip.
- **Actions** (⋯) per agent: Start, Stop, Rebuild, Probe, Delete (Delete confirms; working files
  kept).
- **Activity feed** (aside): all live fleet events, newest first, topic-chip + plain-English
  description (agent ids → names) + relative age; live count in the header.
- **Detail panel**: status, runtime, model, port, skill chips, working directory.

**Data & actions:** `info`/`agents`/`teams`/`events` (store poll); `runtime:models`,
`providers:list`, `runtime:probe`, `setAgentRuntime`; `remote` for `/model`, `/agent … rebuild|
start|stop|probe`, `/delete`.

**Known issues / polish**
- Two unrelated operations both say "Probe" (header = provider model probe; ⋯ = agent liveness probe).
- Errors are surfaced two ways on one page (transient busy-string banner vs `window.alert`).
- `runtime:models` re-fetches on every 3s poll (minor IPC churn).
- Mismatch warning is heuristic; unknown runtimes never warn.

---

## 4. Chat (nav: "Chat" ✦, route: `chat`)

**Purpose:** A multi-session conversational workspace for talking to the fleet — message any agent
(default: the team coordinator), optionally scope to a project, attach files, and watch the agent's
live tool/file activity stream. The composer also generates images and can auto-save plan-style
replies into Work › Plans.

**What you can do**
- Compose & send (Enter sends, Shift+Enter newline); **target any agent** from the Address sidebar;
  view the coordinator marker there; routing changes hand off to HR Manager Manage.
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
- **Resumable dispatches:** a reply keeps polling across navigation and app restart, lands in the
  right chat with an unread badge; transient failures auto-retry; a sustained outage posts one
  soft notice and keeps polling.

**Data & actions:** `chats:list/get/save/patch/remove/inflight/markRead/unreadCount`,
`chat:genTitle/pickFiles/saveFiles/savePasted`, `dispatch:start` + `query:poll`, `activity:get`,
`image:models/generate/read`, `projects:list`, `project:openFolder`, `plans:save`,
`App navigation:teams:route`.

**Known issues / polish**
- "untitled chat" placeholder copy vs always-auto-named sessions (cosmetic).
- `endRef` dead code; `persist()`/`patch()` overlap.
- Plan auto-save heuristic can false-positive.
- Concurrent dispatches can misattribute the live delegation trace (no queryId on the event log) —
  acknowledged in code.

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
  (independent tasks run in parallel; dependents follow). Or **⇄ Fan out to N teams** to hand the
  same objective to other teams' active leads.
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
**What you can do:** set/enable/update a heartbeat interval per agent (1m–24h), pause/resume,
disable; see status (♥ on / paused / ⚠ missed / ⚠ last run failed); view check-ins with cadence &
fire counts, **Close** one, or **🧹 Clean up N** stale ones (watching finished/removed tasks).
**Data & actions:** `schedules` (`/schedule list`), `checkins`, `addHeartbeat`, `pause/resume/
removeSchedule`, `checkins:close`.
**Polish:** auto-close copy slightly overpromises; heartbeat message is fixed; no confirm on disable/cleanup.

### 6.4 Work › Loops
**Purpose:** **Agent chains** (an AI-drafted sequential agent→task pipeline; each step's output
feeds the next; runs on demand while the app is open) **and** **Scheduled objectives** (one agent
runs a fixed objective on a calendar cadence via the manager — runs 24/7 even when the app is closed).
**What you can do:** draft a chain from a goal (✦ Draft chain), edit/reorder/add/remove steps, save,
run (per-step live status + output, stops on failure), load/delete saved chains; create scheduled
objectives (agent + objective + cadence + time), Run now, pause/resume/delete.
**Data & actions:** `loops:list/get/save/remove`, `dispatch`, `schedules`, `addCalendarCheckin`,
`pause/resume/removeSchedule`.
**Polish:** chains-vs-scheduled distinction is fine-print; draft caps 12 vs store caps 20; Run-now is
serial with generic failure.

### 6.5 Work › Dream
**Purpose:** Have an agent run an offline "dream" — a reflection over recent work + the brain/memory
— returning a Markdown report (Consolidation / Insights / Ideas / Simulations), saved as a digest.
**What you can do:** pick an agent + optional focus → **✦ Dream now** (saved + opened); **Schedule
nightly** (03:00 daily calendar check-in); browse/expand/delete saved dreams.
**Data & actions:** `dreams:list/get/save/remove`, `dispatch`, `addCalendarCheckin`.
**Polish:** scheduled nightly dreams deliver to chat and are **not** saved into this tab's list (only
manual dreams persist); nightly time/cadence hard-coded; report shown as raw markdown in `<pre>`.

---

## 7. Projects (nav: "Projects" ◆, route: `projects`)

**Purpose:** A local project tracker (status/description/team/tags/links/notes) with live git state
and one-click git ops, auto-discovered from the id-agents workspace folder.

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
headers wrap long names/actions instead of overflowing.

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

**Polish:** token numbers are manager-reported harness telemetry for trends, not provider billing
invoices; stale last-turn samples remain visible but no longer drive the live gauge. The model-lanes
panel uses aligned runtime/type/models/source/checked columns plus the same Settings availability gate
as the per-agent Harness dropdown: unavailable curated fallback harnesses are hidden unless already
assigned, synced API/provider lanes are selectable through the manager `provider-api` harness, and
unsynced API lanes stay visible but disabled until **Connect & sync** succeeds. The per-agent Model
dropdown follows the effective staged Harness catalog: changing Harness
resets the staged model to a valid option for that harness, and stale saved cross-harness model values
show as drift instead of selectable options.
"Running" is a status-string regex (non-matching healthy statuses show red).

---

## 9. Identity & Keys (nav: "Identity & Keys" ⬡, route: `identity`)

**Purpose:** Manage each agent's onchain identity (ENS/ID-chain domain + OWS/provider wallet) and
its ERC-4337 smart account, including time-boxed, scope-limited **session keys**. Today it can run
against a mock provider ("Base Sepolia (mock)") while keeping the same UI contract for a real
Safe4337 + bundler path. The page also shows the enabled agent chain RPCs from Settings as the
chain allowlist a granted key can use once a live signing provider is wired.

**What you can do:** pick an agent; see identity (domain/wallet), **Register identity**, **Provision
wallet**; review Brain controller sync; review onchain metadata standard coverage for ENSIP-24,
ERC-8004, ERC-8048 / ERC-721T, ERC-8049, and B20 `extraMetadata`; review **Operational Chain
Access** from Settings RPCs without exposing RPC keys; see the Safe account (deployed vs
counterfactual, address, owner), **Create account**, **Deploy**; list **session keys** (scope,
address, time-remaining / revoked / expired), **Revoke**; **Issue a session key** by scope preset
(registry-write / skill-publish / payments / full) + TTL preset (1h / 24h / 7d / 30d / until revoked).

**Data & actions:** `keys:caps/presets/list/ensure/deploy/issue/revoke`, `evmRpc:list`,
`identity:register`, `wallet:provision`.

**Guardrails:** controller-wallet precedence is OWS address, generic provider-wallet metadata,
legacy SkillMesh provider metadata, then address-shaped OWS wallet. The standards panel is read-only
and recognizes common manager metadata fields for ENSIP-24 arbitrary resolver data, ERC-8004 agent
registry/agentURI/agentWallet evidence, ERC-8048/ERC-721T token-level context/endpoints, ERC-8049
contract-level metadata, and B20 `extraMetadata` without dumping raw resolver bytes, contract bytes,
or issuer-defined metadata blobs into the UI. Live resolver/contract reads and manifest/runtime
signature verification remain pending checks.
Operational Chain Access is read-only: it mirrors enabled Settings RPC networks, key-source labels,
last probe status/block, and mock-vs-live signing mode. RPC secrets remain encrypted in the main
process and a mock key provider still means no IDACC transaction broadcast, even when chain RPCs are
configured.

**Polish:** Register has no idempotency guard; standards coverage currently reads manager metadata
and controller evidence only, so live chain reads still need a backend contract before the page can
mark those standards as externally verified.

---

## 10. HR Manager (nav: "HR Manager" ⛌, route: `teams`)

**Purpose:** The org-design surface — create teams & agents, shape hierarchy (coordinator/lead,
primary cross-team lead), edit per-agent instructions, and govern cross-team delegation. (File:
`Teams.tsx`; page title "HR Manager".)

**Owner:** `legal/hr-manager` owns the HR Manager page's staffing workflows, instruction-drafting
behavior, and future page optimization proposals. Escalate legal-team policy or personnel-process
questions through `legal/general-counsel`.

**What you can do** — four top-level tabs: **Structure · Health · Build · Manage**, plus header
**+ From template** and **✦ Build a team**.
- **AI Team Builder** (describe/paste a spec → live deterministic parse → **✦ Build with AI**
  (`team:designAI`, constrained to Settings-available harnesses, synced API provider lanes, models, and skills) → editable roster (per-agent ★lead,
  name, runtime, model, role, persona/instructions, skill chips) → fleet-wide options (multiple
  MCP servers, shared skills, heartbeat, OWS wallet, probe-after) → opt-in coordination preset (off by default, with an extra
  primary-route warning for default-team wiring) + cross-team relay → **Build** for a new team or
  **Build + merge** for an existing target (sequential `onboard:run` with duplicate names skipped,
  explicit **One new agent** reset for single-agent adds, automatic runtime/model verification that
  live-probes selected API provider lanes before confirmation, a live checklist, then optional
  coordinator/default-primary + instructions + relay wiring) → per-agent **↻ retry**).
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

**Polish:** relay UI + coordinator preset are reimplemented in two places (drift risk); per-agent
"inherit" vs explicit-empty is ambiguous in the displayed mode; AI draft/design require a running
agent (fresh team fails with no guidance); `makePrimary` can silently no-op.

---

## 11. Capabilities (nav: "Capabilities" ◫, route: `modules`)

**Purpose:** One workbench to extend what agents can *do* — register/test/attach **MCP** tool-servers,
browse/create/install **Skills**, inspect/digest neutral **Plugins** — applied across a multi-agent
selection in the active team.

**What you can do**
- **Shared header**: team dropdown + an **"apply to" agent chip row** (default = all in scope; click
  to make an explicit set; all/none). Runtime support is advisory, so local/API/subscription
  runtimes can receive neutral MCP/skill/plugin metadata while execution adapters remain explicit.
- **MCP servers**: compact server table (server/endpoint, attached `have/target`, status, actions),
  per-row **Attach / Detach / Test / ✕**, **Rebuild <targets>**, and a hidden **Add server** panel
  for catalog/custom MCP profiles. `mcp:list` and `mcp:test` stay read-only; only add/remove emit
  cross-page sync.
- **Skills**: catalog cards (license, install `have/target`, tags incl. **auto-categorized**),
  **Install / Uninstall** per selection, two-step **delete**, search + tag filter, batch
  **auto-categorize** (+ ↻ re-categorize), **Create skill**, low-noise Brain skill count/sync chip,
  and explicit **Preview & sync** for Brain catalog writes. Brain-wide Health/Fleet/Agents/Graph
  review states guard the Brain launchers but do not render as Skills-tab notices.
- **Brain dashboard popouts**: Fleet, Health, Skills, Learning, Agents, and Graph are treated as
  read-only observation surfaces. They lead with `/fleet-report`'s IDACC manager authority when live,
  fall back to Brain cache only with explicit cache/partial warnings, expose redacted optional-provider
  evidence such as SkillMesh plugin identity and advertised-skill summaries, and avoid dashboard-side
  approval/replay POST controls.
  Brain Agents now mirrors the Identity & Keys controller-wallet precedence (`ows_address`, then
  optional provider wallet address, then address-shaped OWS wallet) and shows per-agent total ETH
  gas spend vs last-24h ETH gas from Brain timeline transaction/gas evidence.
  The Brain listener snapshots every manager team into team-qualified cache rows, retires
  no-longer-live rows as stale, and `/fleet-report` excludes stale rows when comparing live manager
  totals against Brain cache, so duplicate bare-name agents do not create false drift.
  SkillMesh is treated as a bundled optional provider/plugin: neutral agents do not receive SkillMesh
  keys or env vars unless the SkillMesh plugin/provider is attached or explicit opt-in env is set.
  IDACC GUI examples, HR first-run lead presets, manager recommendation hints, and Brain table labels
  no longer present SkillMesh as a built-in core team or identity pillar; generic provider-wallet
  metadata is first-class while legacy SkillMesh metadata remains read-only compatible.
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

**Polish:** the Rebuild button disappears after detaching the *last* server (can't trigger the
rebuild that applies it); `setAgentMcp` is a wholesale replace (can clobber concurrent changes);
removing a registry entry doesn't detach it from agents; auto-categorize makes a billable call on
first load.

---

## 12. Computer Use (nav: "Computer Use" 🖥, route: `computer`)

**Purpose:** Let a "blessed" Claude/codex agent see your Mac's screen and drive mouse+keyboard,
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
**PANIC** (■, never blocked, global hotkey ⌘⌥⇧P); watch the **live view** of the primary display;
manage **Permissions** (Open Settings / Relaunch / Re-check); **Bless / Remove** one or more
capable agents from any HR Manager team (attaches the bundled `mac-control` MCP server + rebuilds
that agent in its own team); read the **Activity log** (last 40,
blocked actions flagged); toggle **Safety → "Approve every action"** (supervised default-on; in
autonomous mode risky actions — Trash, ⌘Q, destructive shell — are still held); respond to
**approval prompts** (Allow/Deny, 60s auto-decline).

**Data & actions:** `cu:permissions/status/attached/audit/arm/disarm/pause/setSupervised/panic/
confirm/watch/openPermission/relaunch/attach/detach`, `rebuildAgent`; push events `onComputerFrame/
Pending/Panic`; 2.5s poll.

**Polish:** bless eligibility is runtime-name regex; attach-then-rebuild-fail leaves an agent
blessed-but-not-wired (only the `⚠` text signals it); primary-display only; per-frame React state churn.

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
- **Self-update**: version, status, **auto-download** toggle, **Check now**. Background checks
  can stage newer builds, but applying a staged build requires the explicit Restart & update action;
  stale/consumed staged zips are gated during status, check, staging, and apply.
- **Managed subscription sign-ins**: CLI OAuth/device/browser flows (no API key) for `claude-*`,
  `codex`, `cursor-cli`, `grok`, Antigravity `agy`, `copilot`, `kiro-cli`, and legacy `q` only when installed. Rows distinguish
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
  runtimes remain visible as the current value for review. Linked managed subscription CLIs without
  a manager adapter, such as Grok Build, Antigravity, Copilot, Kiro, and legacy Q, show in Health as
  adapter-needed read-only lanes instead of selectable harnesses. Synced API/cloud provider lanes
  such as OpenRouter and NVIDIA are selectable in Health and HR Manager Build via the manager
  `provider-api` harness; unsynced API lanes remain disabled until their model list is refreshed.
  Agent Model pickers are keyed to the currently
  staged harness model catalog, so switching to Kiro, Codex, Claude Code, or a local harness cannot
  carry a stale model from the previous harness forward as a valid choice. Gemini CLI
  `oauth-personal` evidence is not part of managed sign-in availability because consumer Gemini Code
  Assist / Google AI Pro / Ultra OAuth is deprecated in Gemini CLI; use the Google Gemini API preset
  under Inference backends instead. Antigravity CLI is managed from Settings as the consumer
  subscription successor, but is not offered as an agent harness until the manager exposes an
  Antigravity adapter.
- **Local models & backends**: compact model/backend status, live local API chips, visible installed
  stack chips loaded on Settings open, one **Scan running** action, guarded next-step setup,
  **View stack setup** handoff, local concurrency (1–16), Ollama
  installed chips with reviewed **Update** re-pull actions, **Download** by id (streamed progress),
  and a searchable **catalog** with capability filters, Gemma 4 MLX entries, and hardware
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
  actions and mapped-host-port detection for existing stopped containers such as LocalAI,
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
  and cloud keys auto-detected from env, including `PERPLEXITY_API_KEY` for Perplexity. Local server
  setup belongs to Local LLM stacks above.
- **Local backend readiness**: a local provider that answers but returns no model list is displayed as
  `live · no models` and is not route-ready until a probe/sync produces at least one model. Local
  stack port warnings suppress a stack's own configured/discovered port so an installed LocalAI-style
  backend does not warn against itself.

**Data & actions:** `app:hardware`, `manager:capabilities`, `app:version`, `update:status/check/
getSettings/setSettings`, `subs:status/signin/signout/install`, `manager:localConcurrency/
setLocalConcurrency`, `ollama:tags/catalogCheck/pull/remove`, `evmRpc:list/save/remove/probe`,
`image:getServer/setServer/detectServer`,
`app:runInTerminal`, `providers:list/add/remove/setDefault/toggle/connect/discover`.

**Polish:** signin success is assumed after a 4s recheck (slow OAuth leaves the card stale);
concurrency running/queued figures are a snapshot; clipboard fallbacks fail silently.

---

## 14. Cross-cutting concepts

- **Active-team scoping**: everything is scoped to `store.team`; switch via the status-bar selector.
- **Runtimes**: `claude-*`, `codex`, `cursor-cli`, and `ollama` are manager-executable harnesses today.
  Grok, Antigravity, Copilot, Kiro, and legacy `q` are managed subscription CLI lanes that can be linked
  in Settings and reviewed in Health, but they stay adapter-needed until the manager ships matching
  harnesses. `ollama` / local servers and metered API providers are
  configured in Settings → Inference. MCP works where a runtime/tool harness supports it; skills and
  portable plugin packages are assigned as neutral metadata with Skill/MCP/native/direct-fallback
  adapters deciding execution.
- **Active-agent routing**: assignment, decomposition, triage, and fan-out target only **running**
  agents; stopped agents are skipped and reported.
- **Cross-team fan-out**: an objective can be handed to several teams' active leads at once
  (`work:fanout` → `/ask <team>/<lead>`), each running it independently and in parallel.

### Release process (operator note)
Bump `idctl-desktop/package.json` + lockfile → CHANGELOG `## [X.Y.Z]` → commit + tag `vX.Y.Z` +
push (SSH) → `cd idctl-desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` → ditto-zip the
arm64 asset → publish **directly** with the deployer PAT and assign an ops-lead follow-up task
(local tool `.iacc-publish/release-publish.py X.Y.Z`). The app self-updates from GitHub
`releases/latest`; local release zips are deleted after upload verification because GitHub releases
are the durable archive.

---

## 15. Polish backlog (prioritized, from this review)

**Should fix (user-facing correctness/UX)**
1. Identity & Keys: write actions silently swallow errors → add error surfacing.
2. Capabilities: Rebuild affordance disappears after detaching the last MCP server → keep it when a
   detach is pending.
3. Capabilities: `setAgentMcp` wholesale-replace can clobber concurrent changes → guard like
   `cu:attach`.
4. Computer Use: "bless applies on next Arm" copy contradicts re-sync-while-armed behavior → fix copy.
5. Projects: deleting all projects silently repopulates on next load (auto-sync) → gate first-run
   auto-sync so it doesn't undo deletions.
6. Dashboard: two different "Probe" meanings → relabel one.

**Nice to have**
- Dashboard/Health: throttle re-fetches that run on every 3s poll.
- Work › Dream: scheduled nightly dreams don't appear in the saved list; render markdown (not `<pre>`).
- Settings: add "Restart & apply now"; confirm signin instead of timed recheck.
- HR Manager: de-duplicate the two relay pickers / coordinator presets; clarify inherit-vs-blocked.
- Chat: remove dead `endRef`; tighten the plan auto-save heuristic.

_None of the above are regressions; they're refinements surfaced by the page-by-page review._
