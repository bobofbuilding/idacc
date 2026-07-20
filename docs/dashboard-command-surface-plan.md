# Dashboard Command Surface — Refactor Plan

> Locked decisions (updated 2026-07-20): (1) the maintained
> `bobofbuilding/id-agents` fork is the compatible Manager and owns the control-event,
> Brain relay, and control-state contracts; (2) Dashboard is the default command surface,
> while Work and its tabs remain available as power-user drill-downs; (3) explicit chat
> control intents use propose-then-confirm; (4) all operational control and Brain traffic
> flows through Manager; (5) Brain stores durable decisions, commitments, outcomes, and
> cited learning artifacts, with duplicate/no-op suppression rather than raw transcript noise.
>
> Source: six-way audit + architect synthesis (workflow cc-drive-everything-audit).

---

## Implementation status (2026-07-20)

All six phases are implemented on the IDACC, compatible Manager, and Brain working
branches. The final gates cover Manager-mediated Brain access, durable control/config
events, versioned Manager control state, project/plan/task lineage, Dashboard panels,
and confirm-before-execute chat intents. The historical audit below is retained to show
the gaps this refactor closes; line numbers and the old `CC_API_VERSION=1` statement are
not descriptions of the current implementation.

---

# Refactor Plan: Dashboard as Single Command Surface, Manager as Single Mutation Path, Brain as Learned System of Record

## 1. Thesis

The Dashboard (`idctl-desktop/src/renderer/views/Dashboard.tsx`, 248 lines, currently read-mostly: CoordinationTree + activity feed + lead chat) becomes the **single command surface** — a command palette plus slide-over control panels plus the lead chat repurposed as a natural-language control channel — from which the operator drives both (a) how the control center is organized and (b) how projects are worked on. Every mutation flows through **one path**: `Dashboard control → ManagerClient (idctl/src/api/client.ts) → manager route at :4100 → event_log → brain-listener → brain`. We close the architecture's central hole — `db.events.insert` is callable *only* from internal lifecycle producers and never from an HTTP route (verified: `id-agents/src/wakeup-service/event-producer.ts:18-30`, no `events.insert` in any route handler in `agent-manager-db.ts`) — by adding **one generic brain-visible event-emit route** plus a **manager-fronted control-state store**, so that every currently-client-side mutation becomes both harness-routed and brain-learned. The brain learns automatically for everything routed through the manager, and via a single new `BrainClient` for the handful of genuinely client-local facts that must be mirrored explicitly.

## 2. The three gaps, precisely

### (a) Dashboard control gap — what you must leave the Dashboard to do

`Dashboard.tsx` calls only read IPC (CoordinationTree from `org:hierarchy` + `tasks:allTeams` + usage, `events:multi` feed, `Chat` to the resolved lead). Grep for `work:*|projects:*|brain:*|plans:*` in `Dashboard.tsx` returns nothing. To do **any** of the following the operator must leave the page:

- **Register/import/sync a project, set status/team/policy** → only on Projects page (`projects:list/save/remove/syncRoot`, `bridge.ts:551-620`).
- **Decompose / dispatch / fan-out / triage** → only in Tasks tab + Plans "Work" button (`work:decompose/createPlan/fanout/triage`, `work.ts:104-463`, wired `bridge.ts:324-346`).
- **Kanban lanes / deps / review / reconcile** → only Tasks page (`Tasks.tsx:62-96,239-428`).
- **Brain plan create / status / "Work"** → only Plans page (`brainplans.ts`, `Plans.tsx:149-410`).
- **Org config (who is primary/secondary/team lead)** → only via coordinator forms (`coordinator:set/setPrimary`, `org:setSecondaryLeads`, `bridge.ts:686-722`).
- **Settings: providers / MCP / managers / concurrency / project root** → only Settings views.
- **Git lifecycle** (commit/push/fork/clone) → only Projects page (`projects.ts:175-604`).

No drawer or command-palette primitive exists on the Dashboard (dashboard-anatomy audit).

### (b) Harness routing gap — client-side-only mutations that bypass the manager

These write only to `~/.config/idctl/config.json` via `saveSettings` (`idctl/src/settings/store.ts:14`, no `fetch`/manager refs) or local fs, and never reach :4100. Confirmed in the `bridge.ts` `call()` dispatcher (lines 685-724) and METHODS map (line 192):

| Mutation | IPC method | Sink | File |
|---|---|---|---|
| Project CRUD/sync | `projects:save/remove/syncRoot/detectRoot` | config.json | `bridge.ts:551-620`; `schema.ts:123-147` |
| Per-project team + autoCommit | `projects:save` (ProjectEntry.team/autoCommit) | config.json | `schema.ts:132,139-144` |
| Coordinators / primary / secondary | `coordinator:set/setPrimary`, `org:setSecondaryLeads` | config.json | `bridge.ts:696-722` |
| OrgSync flags | `org:setConfig` | config.json | `bridge.ts:715-722` |
| Task lanes / deps / review | `tasks:setLane/setDeps/setReview` | config.json | `bridge.ts:285-292` |
| Skill auto-tags | `skills:autoTags` | config.json | `bridge.ts` (METHODS) |
| MCP profiles | `mcp:add/remove` | config.json | `bridge.ts` (METHODS) |
| Providers | `providers:add/remove/setDefault/toggle` | config.json | `bridge.ts` (METHODS) |
| Managers list | (settings) | config.json | `schema.ts` |
| AI draft plans | `plans:save/remove` | `~/.config/idctl/plans/*.json` | `planstore.ts:11-92` |
| Brain plan files + status | `brain:createPlan/setPlanStatus` | brain repo disk + git (out-of-band, not via :4100) | `brainplans.ts:122-201` |
| Dream reports | `dreams:save` | `<config>/dreams/*.json` | `dreamstore.ts:13-23,64-73` |
| Blocker questions | `questions:add` | questionstore JSON | (Tasks reconcile, `Tasks.tsx:312-428`) |
| Loops, subscriptions | (stores) | local JSON | `loopstore.ts`, `subscriptions.ts` |
| Git ops | `project:git/commit/fork/cloneGithub/...` | direct git/GitHub API from main process | `projects.ts:175-604` |

**Additionally** — even mutations that *do* route through the manager emit no event: `setAgentInstructions`, `setAgentModel/Runtime/Mcp/Delegates`, `moveAgent`, `spawnAgent`, `setTeamDelegates`, `deployTeam`, `syncTeam`, `setLocalConcurrency`, library install, and **task creation (`POST /tasks`)** all persist server-side but call no producer (`agent-manager-db.ts` config write handlers have no `events.insert`; only claim/done emit). So they are harness-routed but **not** learned.

### (c) Brain learning gap — what the brain never learns

`brain-connector.json:1-38` defines exactly one live feed: the manager `/events` stream (the `tasks`/`queries` feeds are `placeholder:true`, unimplemented). The brain-listener converts only the fixed lifecycle topic set (`event-producer.ts:18-30`: `task:claimed/completed`, `query:delivered/failed/expired`, `checkin:*`). The CC makes exactly **one** direct brain write — `orgSync.writeOrgToBrain` → `POST :4200/memory/team-instructions` (verified `orgSync.ts:148-167`) — and one direct read (`/memory/shared`). Therefore the brain **never learns**:

- Any config in (b): provider routing, MCP servers, managers, project roots, project↔team bindings, autoCommit policy, skill tags.
- **Project as an entity** — there is no project node; the brain cannot correlate tasks/dispatches/spend back to a project (`schema.ts:125` "not a manager concept").
- **Task DAG / lanes / review / blocker questions** — app-side overlays (`bridge.ts:285-292`); the brain's task timeline lacks the dependency graph and human-decision points.
- **Who-drives-what changes** — coordinator promotions reach the brain only as a lossy 5-minute `org:hierarchy` keyed-memory *snapshot* (`orgSync.ts:148-167`), no per-change event/provenance.
- **Brain plan lifecycle** — create/status changes are disk+git writes (`brainplans.ts:122-201`), no event, no `/timeline`, no `/text-units/ingest`; learned only incidentally if the brain re-reads its repo.
- **Dream reports** — the dispatch is a visible query, but the saved digest is never POSTed to `/text-units/ingest` (`dreamstore.ts`).
- **AI draft plans + revisions**, loops, subscriptions, plan↔task↔project lineage.
- **Config/lifecycle mutations that route through the manager** (instructions, model, spawn, deploy, concurrency) — server-side but event-silent (gap b tail).

The brain **already exposes** all write endpoints needed (`POST /timeline`, `/facts(/bulk)`, `/entities(/bulk)`, `/memory/:agentId`, `/text-units/ingest`) — no new brain endpoint is required, only CC/manager wiring.

## 3. Target design

### UI pattern — "drive everything" from the Dashboard

Three composable primitives, added without removing the existing read surface (CoordinationTree + activity + chat stay):

1. **Command palette** (`Cmd-K`) — `idctl-desktop/src/renderer/views/dashboard/CommandPalette.tsx`. A fuzzy-searchable registry of every control action (the union of `work:*`, `projects:*`, `org:*`, `coordinator:*`, `brain:*`, `tasks:*`, settings writes). Each entry is a `{ id, label, group, run(ctx) }` descriptor in a shared `idctl-desktop/src/renderer/dashboard/commands.ts` registry, so the palette and the slide-over panels share one source of truth. Selecting an action either runs it directly or opens its panel.

2. **Slide-over control panels** (drawer primitive) — `idctl-desktop/src/renderer/views/dashboard/ControlDrawer.tsx` + panels in `idctl-desktop/src/renderer/views/dashboard/panels/`:
   - `ProjectDriverPanel.tsx` — the end-to-end project controller: register/import → assign team+lead+policy → decompose → review proposal → dispatch/fan-out → watch (board filtered to project) → adjust (reconcile/redispatch). **Composes existing IPC** (`projects:syncRoot/save`, `work:decompose/createPlan/fanout/triage`, `tasks:*`, `project:commit`) — does not reimplement.
   - `OrgPanel.tsx` — drive who-leads-what (`coordinator:*`, `org:setSecondaryLeads`, `org:setConfig`, `org:sync`).
   - `ControlCenterPanel.tsx` — drive how the CC works (providers, MCP, managers, concurrency, project root).
   - `PlansPanel.tsx` — brain-plan create/status/Work + draft plans.
   - `BoardPanel.tsx` — Kanban lanes/deps/review/reconcile, project-scoped.
   - Existing `Projects.tsx`, `Tasks.tsx`, `Plans.tsx` remain as full-page drill-downs the panels deep-link to.

3. **Chat as control channel** — extend the existing `Chat` on the Dashboard with a slash-intent layer: operator types `/project new …`, `/dispatch …`, `/promote-lead …`; an intent parser (`idctl-desktop/src/renderer/dashboard/chatIntents.ts`) maps to the same `commands.ts` descriptors, with a **confirm-before-execute** step (a proposal card the operator approves), so the chat free-text path and the palette path converge on one routed mutation.

### Data flow (the invariant)

```
Dashboard control (palette / panel / chat-intent)
  → IPC call() (bridge.ts)
    → ManagerClient method (idctl/src/api/client.ts)        ← single mutation path
      → manager route :4100 (config write OR control-event emit)
        → db.events.insert (NEW generic producer)
          → GET /events stream
            → brain-listener.mjs (NEW control:* branch)
              → brain :4200 (/timeline + /facts + /entities)
```

Client-local durable facts are mirrored explicitly via `BrainClient` (`idctl/src/api/brain.ts`), whose desktop transport is hardwired to the Manager relay. The current `orgSync` inline `fetch` to `:4200` (`orgSync.ts:152`) is replaced by manager passthrough, eliminating the lone ad-hoc back-channel.

## 4. Harness changes (manager-side, in id-agents)

> **Off-limits note:** the manager lives in `id-agents` and is the brain-connected daemon. Per the user's own memory (`feedback_keep_tooling_in_brain_cc.md`: "No push access to id-agents repo; put agent-driving tooling in brain/control-center/"), assume **the id-agents repo cannot be pushed**. So each harness change below ships **app-side first** with a manager-route upgrade as an optional follow-on, and the plan never *blocks* on an id-agents merge.

Minimal manager additions (if/when id-agents is editable):

1. **Generic brain-visible event-emit route** — `POST /control-event` in `agent-manager-db.ts` (register beside `/capabilities` at line 2729), admin/loopback-gated, body `{ topic, subject, actor, data }`, calling `db.events.insert` with a constrained `control:*` / `config:*` namespace. Add the topics to `expandTopicAliases`. This single route turns **any** Dashboard action into a brain event.
2. **Config-write events** — after the DB write in each existing handler (`/agents/:id/{model,runtime,instructions,mcp,delegates,team,metadata}`, `/teams/:name/delegates`, `/agents/spawn`, `/tasks`, `/deploy`, `/sync`), call the new emit helper (`config:agent-updated`, `config:team-updated`, `agent:spawned`, `task:created`, `team:deployed`). No new client surface — already-routed controls become learned.
3. **Manager-fronted control-state store** — `POST/GET /control/state/:scope/:key` (`scope=global|team|project`) persisted to a new `control_state` table, mirrored to the brain via the manager's **existing private `postBrain()`** primitive (`agent-manager-db.ts:1604-1856`). Migrate coordinators/primary/secondary, `projects[]`, `taskLanes/taskDeps/taskReview` here.
4. **Brain memory passthrough** — `POST /control/memory` forwarding to brain via `postBrain()`, so `orgSync.ts:152`'s direct `:4200` write becomes harness-mediated.
5. **Manifest bump** — add routes to `id-agents/src/control-center/manifest.ts` `CC_ROUTES`, add features `control-events`, `control-state`, and `brain-relay` to `CC_FEATURES`, and bump `CC_API_VERSION` to 4. The Dashboard gates new panels on `client.capabilities()`, degrading gracefully on a stock manager via the existing `requireRoute()` pattern.

**Selected implementation:** the app-side direct fallback is not used by the desktop app. `BrainClient` keeps a transport abstraction for isolated tests and non-desktop consumers, while IDACC installs the Manager transport before operational calls.

## 5. Brain wiring — how every control action is recorded

| Action class | Recording mechanism | Implementation |
|---|---|---|
| Task claim/done, query terminal, checkin | **Event-derived (already works)** | unchanged `event-producer.ts` → brain-listener |
| Config writes routed through manager (instructions/model/spawn/deploy/concurrency) | **Event-derived (new)** | emit `config:*`/`agent:*`/`team:*` from handlers (§4.2); add `control:*` branch in `brain-listener.mjs` `handleEvent()` writing `/timeline`+`/facts` |
| Project register/update/assign | **Event-derived (new)** | route `projects:save` through `/control/state/project/*` or emit `project:*` (§4.1/4.3); brain builds project entity + project→team→lead edges |
| Org/coordinator changes | **Event-derived (new)** + keep snapshot | emit `control:org-changed {before,after,actor}` per `coordinator:set/setPrimary/setSecondaryLeads`, giving timeline+provenance instead of the lossy 5-min snapshot; keep `writeOrgToBrain` for the rendered chart |
| Task DAG / lanes / review | **Explicit memory write** | when `work:createPlan` dispatches, mirror `taskDeps`/`taskLanes` to brain `/memory` (project-keyed) the way `orgSync` mirrors the hierarchy; or migrate to `/control/state` (§4.3) |
| Brain plan create/status | **Explicit memory write** | in `brainplans.ts` after disk/git, POST `/timeline` + `/facts (entity=plan:<file>, field=status)` + `/text-units/ingest` of body on create |
| Dream reports | **Explicit memory write** | in the `dreamstore.saveDream` call site, POST report to `/text-units/ingest` (`source_kind='idagents-dream'`, metadata `{agent,team,focus}`) |
| Blocker questions | **Explicit memory write** | `questions:add` → POST `/timeline` decision-point tied to project/plan |
| Plan↔task↔project lineage | **Event-derived** | tag `/task create` with `--project <id> --plan <num>` (manager metadata field) so brain builds project→plan→task→agent graph |
| Genuinely client-only (window prefs) | **Explicit memory write** | `BrainClient.memory()` mirror, or accept as un-learned by design |

All explicit writes go through **one** new `idctl/src/api/brain.ts` `BrainClient` (wrapping `/timeline`, `/facts(/bulk)`, `/entities(/bulk)`, `/memory/:agentId`, `/text-units/ingest`, with the same `managerUrl`-style config + 2.5s timeouts as `orgSync`). `orgSync.writeOrgToBrain`/`brainInstructions` (`orgSync.ts:148-167,122-135`) refactor onto it, removing the ad-hoc inline fetch.

## 6. Phased implementation plan

> Ordered by value/risk. The maintained Manager fork is available, so the implementation
> uses Manager-mediated Brain transport from Phase 1 and adds the durable Manager contracts
> in Phases 4–5. Release cadence is intentionally separate from these implementation gates.

### Phase 1 — BrainClient + close the explicit-write learning gap (highest value, lowest risk)
- **Goal:** every existing client-side mutation becomes brain-learned through the Manager relay, with zero UI restructure. The app never needs a direct operational connection to `:4200`.
- **Files:**
  - **New** `idctl/src/api/brain.ts` — `BrainClient` (timeline/facts/entities/memory/text-units) with a Manager-installed transport and stable idempotency keys across retries.
  - `idctl-desktop/src/main/orgSync.ts` — refactor `writeOrgToBrain`/`brainInstructions` onto `BrainClient`; add per-change `control:org-changed` timeline write in the `coordinator:*`/`org:setSecondaryLeads` paths.
  - `idctl-desktop/src/main/bridge.ts` — in the `call()` dispatcher (lines 685-724) for `coordinator:set/setPrimary`, `org:setSecondaryLeads`, `org:setConfig`, `projects:save/remove`, `tasks:setLane/setDeps/setReview`, and METHODS entries `providers:*`/`mcp:*`, append a `BrainClient.timeline()/facts()` mirror after `saveSettings`.
  - `idctl-desktop/src/main/brainplans.ts:122-201` — after disk/git, BrainClient `/timeline`+`/facts`+`/text-units/ingest`.
  - `idctl-desktop/src/main/dreamstore.ts` (save call site) — BrainClient `/text-units/ingest`.
- **Acceptance:** flip a provider default + promote a coordinator + mark a brain plan DONE from the existing UI → Manager acknowledges the relay and all three appear in brain `/timeline` and as facts within seconds.

### Phase 2 — Dashboard command palette + control drawer scaffold (UI primitive, read-safe)
- **Goal:** add `Cmd-K` palette + slide-over drawer to the Dashboard, wired to a shared command registry, with no new mutations yet (registry initially routes to existing pages/IPC).
- **Files:**
  - **New** `idctl-desktop/src/renderer/dashboard/commands.ts` (registry), `idctl-desktop/src/renderer/views/dashboard/CommandPalette.tsx`, `idctl-desktop/src/renderer/views/dashboard/ControlDrawer.tsx`.
  - `idctl-desktop/src/renderer/views/Dashboard.tsx:172-248` — mount palette + drawer; keep CoordinationTree/activity/chat.
  - `idctl-desktop/src/renderer/store.ts` — expose drawer/palette state if needed.
- **Acceptance:** `Cmd-K` opens, searching "dispatch"/"promote"/"register project" surfaces actions; selecting opens the drawer or deep-links the existing page. No behavior regressions on the read surface.

### Phase 3 — ProjectDriverPanel + OrgPanel (drive projects & org from the Dashboard)
- **Goal:** the operator completes the full project lifecycle and org changes without leaving the Dashboard, every action brain-learned via Phase 1 wiring.
- **Files:**
  - **New** `idctl-desktop/src/renderer/views/dashboard/panels/ProjectDriverPanel.tsx` — composes `projects:syncRoot/save`, `work:decompose` (`work.ts:104-150`), `work:createPlan` (`work.ts:168-297`), `work:fanout`/`triage`, board filtered to project's team, `project:commit`.
  - **New** `idctl-desktop/src/renderer/views/dashboard/panels/OrgPanel.tsx` — `coordinator:*`, `org:setSecondaryLeads/setConfig/sync`.
  - `idctl-desktop/src/renderer/dashboard/commands.ts` — register these panels.
  - `idctl/src/settings/schema.ts:123-147` — add `lead` + `policy` to `ProjectEntry`; `idctl-desktop/src/main/work.ts` `decompose/createPlan/triage` resolve lead from project, not just team coordinator.
- **Acceptance:** from the Dashboard, register a workspace folder → assign team+lead+policy → decompose an objective → review proposal → dispatch → watch tasks land in CoordinationTree filtered to that project. Brain timeline shows project entity + dispatches correlated to it.

### Phase 4 — Manager control-event + config-event routes (route through the harness)
- **Goal:** add durable control/config event production so manager-routed mutations become event-derived learning as well as acknowledged explicit writes.
- **Files:**
  - `id-agents/src/agent-manager-db.ts` — add `POST /control-event` (near line 2729); emit config events from existing `/agents/:id/*`, `/teams/:name/delegates`, `/agents/spawn`, `/tasks`, `/deploy`, `/sync` handlers.
  - `id-agents/src/wakeup-service/event-producer.ts:18-30` — add `control:*`/`config:*` producers.
  - `workspace/projects/brain/brain-listener.mjs` (`handleEvent`) — add `control:*` branch → `/timeline`+`/facts`.
  - `idctl/src/api/client.ts` — `emitControlEvent(topic,subject,data)` for durable event production alongside the Manager Brain relay.
  - `id-agents/src/control-center/manifest.ts` — bump `CC_API_VERSION` to 4 and add routes/features.
- **Acceptance:** a config change emits a `config:*` row in `GET /events`; brain-listener converts it to a bounded timeline/fact update. Duplicate idempotency keys do not produce duplicate events.

### Phase 5 — Manager control-state store + project/lineage entities (single source of truth)
- **Goal:** migrate `projects[]`, coordinators, `taskDeps/taskLanes/taskReview` out of config.json into manager-side `control_state`, with project + plan↔task lineage as first-class.
- **Files:**
  - `id-agents/src/agent-manager-db.ts` — `POST/GET /control/state/:scope/:key` + `control_state` table; project entity + `project:*` events; `--project`/`--plan` metadata on `/tasks`.
  - `idctl/src/api/client.ts` — control-state CRUD + `createTask` (currently unwrapped, `POST /tasks`).
  - `idctl-desktop/src/main/bridge.ts`, `work.ts` — read/write via manager; config.json becomes a cache mirror.
  - `idctl-desktop/src/main/orgSync.ts:152` — replace direct `:4200` write with `POST /control/memory` passthrough.
- **Acceptance:** delete `~/.config/idctl/config.json` and the project registry/org/lanes survive (rehydrated from the manager); brain shows project→plan→task→agent graph.

### Phase 6 (optional) — Chat-as-control + remaining panels
- **Goal:** natural-language control via chat intents (confirm-before-execute), plus PlansPanel/BoardPanel/ControlCenterPanel folded in.
- **Files:** **new** `idctl-desktop/src/renderer/dashboard/chatIntents.ts`; extend `Chat.tsx`; remaining panels under `views/dashboard/panels/`.
- **Acceptance:** typing `/dispatch "build X" to research` in chat produces a proposal card → approve → routed mutation appears in brain timeline; declining executes nothing.

## 7. Resolved decisions and remaining release decision

1. **Manager ownership:** `bobofbuilding/id-agents` is the maintained compatible fork. It owns control state, control/config events, and the Brain relay.
2. **Single mutation path:** operational mutations and Brain traffic go through Manager. `config.json` is a recoverable cache mirror, not the source of truth for migrated control state.
3. **Surface boundary:** Dashboard is the default command surface; Projects, Work, Tasks, and Plans remain power-user drill-downs.
4. **Chat autonomy:** explicit slash control intents always render a confirmation card before mutation. Ordinary chat remains pinned to `default/lead`.
5. **Learning quality:** Brain retains cited durable decisions, commitments, outcomes, and learning artifacts. Duplicate and no-op windows suppress low-value repetition; raw transcripts are not mirrored as durable memory.

The remaining operational choice is release cadence: publish the completed phases as one coordinated compatibility release, or preserve six separately versioned release milestones. The implementation and verification do not depend on that choice.
