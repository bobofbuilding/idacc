# Dashboard Command Surface

## Status

The six-phase command-surface refactor is implemented and verified in the unified
`v0.1.685` production candidate. It becomes the in-service baseline when that signed
candidate is promoted.

| Component | Baseline | Role |
|---|---:|---|
| Unified IDACC application | `v0.1.685` production candidate | Dashboard commands, control panels, chat intents, local cache, and compatibility UI |
| Bundled Manager | `bobofbuilding/id-agents` `v0.1.145` | Fleet mutations, durable control state/events, Brain relay, and task execution |
| Bundled Brain | `v0.1.2` | Manager-event learning, task lineage, durable memory, and duplicate/no-op suppression |

This document is the maintained operating contract. The original pre-refactor audit has
been condensed because its claims about a read-only Dashboard, missing Manager routes,
and an unavailable Manager fork are no longer true.

## Product Boundary

Dashboard is the default **command entry surface**. It is not a replacement for every
dense editor in IDACC.

- Dashboard is where an operator observes the fleet, talks to `default/lead`, finds an
  action, starts work, and sees immediate acknowledgement.
- The command palette and drawer expose high-frequency controls and route advanced work
  to the owning page without losing context.
- Work, Projects, HR Manager, Capabilities, and Settings remain power-user drill-downs.
- Ordinary Dashboard chat is hardwired to `default/lead`. Explicit control intents use
  propose-then-confirm before a mutation runs.

This boundary keeps the Dashboard responsive while preserving full workflows elsewhere.

## Architecture Invariants

1. **Manager owns operational mutations.** Fleet, project, organization, task-overlay,
   plan, and Brain-control writes go through the bundled Manager.
2. **Brain traffic is Manager-mediated.** The desktop does not make direct operational
   writes to Brain. `BrainClient` uses the Manager relay.
3. **Manager is authoritative for shared control state.** Local `config.json` data is a
   recoverable cache for migrated state, not the shared source of truth.
4. **Local-only state stays local.** Window layout, transient selections, and presentation
   preferences do not need to become Brain memories. Local filesystem and git operations
   may execute in the desktop main process, but their durable operational outcomes must be
   recorded through Manager when they affect managed work.
5. **Every accepted command is observable.** The UI acknowledges dispatch immediately,
   reports terminal failure, and records a bounded control event with stable lineage.
6. **Learning is selective.** Brain retains cited decisions, commitments, outcomes, and
   useful learned artifacts. Raw transcripts, secrets, duplicate retries, and no-op churn
   are not promoted into durable memory.
7. **Compatibility is explicit.** IDACC checks the bundled Manager capability manifest and
   shows a degraded-state warning instead of silently rendering an empty fleet.

## Runtime Flow

```text
Dashboard command (palette, drawer, or confirmed chat intent)
  -> desktop IPC
    -> ManagerClient
      -> bundled Manager on its authenticated private random loopback endpoint
        -> operational mutation and/or versioned control-state write
        -> durable control/config/task event
          -> Manager event stream
            -> Brain listener
              -> timeline, entities, facts, text units, and lineage
```

The Manager contract is versioned by `CC_API_VERSION = 5` and advertises:

- `POST /control/brain`
- `POST /control-event`
- `GET|POST|DELETE /control/state/:scope/:key`
- `POST /control/memory`
- feature flags `brain-control`, `control-events`, and `control-state`

IDACC must gate dependent controls on these advertised capabilities. Legacy fallback is
read-only or explicitly degraded; it must not silently invent authoritative state.
Consumer recovery stays within the unified IDACC repair/update path and never installs or
updates Manager independently. Explicit developer connections to an external Manager are
the only supported exception.

## Implemented Surface

### Dashboard shell

- `Cmd-K` opens a searchable command palette backed by one command registry.
- A right-side drawer hosts focused controls without removing Live Coordination, activity,
  or lead chat.
- The activity feed remains the immediate execution/communication acknowledgement surface.
- Live Coordination supports the current hierarchy contract and a visible legacy fallback.

### Command palette

The registry currently covers navigation, project registration, project work dispatch,
organization routing, plans, task board, runtime/capability controls, fleet probing, fleet
refresh, and safe `/ask` or `/hey` agent routing. Search is fuzzy and keyboard-driven.

### Drawer panels

| Panel | Dashboard capabilities | Owning-page handoff |
|---|---|---|
| Project driver | Create/select project, choose folder, assign team/lead/policy, decompose, review, dispatch, triage, watch project tasks | Projects and Work for full repository/task lifecycle |
| Organization | Assign non-default team lead, configure secondary scope, synchronize Manager and Brain | HR Manager for full roster and hierarchy management |
| Plans | Create Brain plan, inspect plans/drafts, update plan status | Work for detailed progress, recovery, and execution |
| Board | Inspect open work and change lane overlays | Work for dependencies, review, reconcile, and bulk operations |
| Control center | Toggle providers, set local concurrency, inspect MCP catalog | Settings and Capabilities for complete configuration |

The narrower panel scope is deliberate. Mutation-heavy or high-risk flows keep their richer
validation and previews on the owning page.

### Chat control

The confirmed intent parser supports:

- `/dispatch "objective" to team`
- `/project new "name" for team`
- `/promote-lead agent for team`
- `/triage team`

`/ask` and `/hey` remain communication commands rather than control intents. Unsupported
free text stays in ordinary `default/lead` chat and must not be inferred as an unconfirmed
mutation.

## Persistence And Learning

| State or event | Authority | Brain behavior |
|---|---|---|
| Projects and project routing | Manager control state | Project entity/facts plus project-to-team lineage |
| Organization and coordinators | Manager control state | Change event plus synchronized hierarchy memory |
| Task lanes, dependencies, and review overlays | Manager control state | Bounded control event tied to the task |
| Brain plans and draft-plan status | Manager-mediated plan/control write | Plan timeline/facts/text unit as appropriate |
| Task creation, claim, completion, query terminal state | Manager task/event store | Event-derived task/query timeline and learned outcome |
| Provider, runtime, MCP, and concurrency changes | Manager or recorded control mutation | Redacted config/control event; no secret values |
| Window and transient UI preferences | Desktop only | Not learned |

Every Dashboard invocation receives a stable idempotency key before confirmation or
execution. The key remains attached to its bounded receipt and is forwarded to operation
routes that accept invocation metadata. Versioned control-state writes reject stale
updates; the desktop refreshes before retrying instead of overwriting concurrent work.

## Reliability Contract

- A button shows a pending state immediately and remains scoped to that invocation.
- Concurrent commands do not share a single global busy flag unless they mutate the same
  versioned resource.
- A Manager timeout is not success. Its receipt remains visible and cannot be dismissed
  while the original request can still reconcile. A late result updates that same receipt;
  after an application interruption, the receipt requires owner-page verification before
  a new command is issued.
- A rate-limit or provider-capacity failure keeps the task alive and uses the runtime
  fallback policy; it does not create a duplicate task.
- Deferred capacity is represented as deferred work, not a human blocker, unless a real
  authorization or missing-input decision is required.
- A failed Brain write does not erase a successful Manager mutation. It is retried from the
  durable event stream.
- Missing or incompatible bundled Manager capabilities produce a visible compatibility
  notice with the required unified IDACC version and repair/update action.
- Duplicate and no-op control events are suppressed before durable learning.

## Verification Matrix

| Gate | Current coverage | Required result |
|---|---|---|
| Command registry, receipts, and chat parsing | `npm run test:dashboard-command-surface` | Metadata validates; commands rank; intents parse; confirmation, compatibility, isolation, bounded durability, deferred outcomes, and timeout recovery hold |
| Rendered command interaction | `npm run test:dashboard-rendered` | Real React palette/drawer renders preserve focus, confirm or decline explicitly, protect dirty/running work, and expose terminal receipts |
| Dashboard hierarchy compatibility | `npm run test:dashboard-coordination` | Current and legacy hierarchy data render without hiding an active fleet |
| Manager Brain transport | `idctl` `brainTransport.test.ts` | Relay is installed, direct desktop transport is absent, retries preserve idempotency |
| Manager control contract | Manager relay/control-state tests | API v5 routes validate input, redact secrets, enforce versions, and persist state |
| Brain learning | Brain listener tests | Control/task events create bounded, cited, deduplicated learning artifacts |
| Desktop integrity | `npm run typecheck && npm run build` | Renderer and main process compile and package cleanly |

## Completed Design Gaps

The following items were previously tracked as partial or missing. They are now part of
the production command-surface contract and its focused verification gates.

## Continuous-Improvement Workflow

The bundled Manager now exposes a versioned `task-workflow.v1` contract while retaining the legacy `todo`, `doing`, and `done` wire statuses. IDACC reads the richer lifecycle directly and maps `triage_required` and `validation_pending` to Under Review, `blocked`, `stalled`, and `failed` to Holding, and validated terminal states to Done.

The Work task board now provides:

- persisted recovery actions for blocked and stalled work;
- visible lifecycle state and blocker/validator context on task cards;
- workflow outcome metrics for validation, cycle time, recovery, and reusable Brain knowledge;
- manager-authoritative assignment IDs and delegation lineage rather than app-side ownership inference.

New dispatches must preserve goal, owner, expected output, acceptance, provenance, validation, scope, timing, and fallback data. Incomplete contracts enter triage instead of starting. Brain outputs remain private promotion candidates until evidence, reviewer, confidence, expiry, and validation requirements pass.

### Completed - End-to-end compatibility gate

The release process now stages the exact pinned IDACC/Manager/Brain trio,
verifies the immutable runtime manifest, boots it against a clean temporary
profile, exercises Manager-to-Brain MCP and listener learning, and fails before
publication when a service identity, version, route, cursor, or runtime file is
wrong.

### Completed - Command completion receipts

Palette, confirmed Dashboard chat, and drawer mutations now use the shared, bounded,
durable receipt shape `{ commandId, idempotencyKey, state, resourceRefs, startedAt,
finishedAt, error, recovery }`. Receipts are globally rendered outside individual views,
survive navigation and application restart through a bounded local cache, classify
deferred work separately, retain unknown timeout outcomes for late reconciliation, and
link failures or recovery states to the owning page.

### Completed - Drawer interruption safety

Every panel reports dirty and in-flight state to one drawer lifecycle guard. Escape,
backdrop, close button, and owner-page handoffs all use the same guarded path. Dirty work
requires an explicit **Discard changes** or **Keep working** choice; running work cannot be
discarded until it settles. Focus is trapped while open and restored to a stable trigger,
including drawers launched from the command palette.

### Completed - Project progress summary

Project driver derives a normalized rollup from Manager task lineage and shows working,
deferred, blocked, failed, complete, and plan counts with a direct Work handoff.

### Completed - Rendered interaction coverage

A dependency-free hidden Electron smoke renders the real React command palette, control
drawer, panels, and global receipts. It verifies palette focus, confirm/decline, exactly-once
invocation, focus containment/restoration, dirty Escape and close-button protection, and
in-flight backdrop protection. The focused command-surface smoke separately exercises
concurrent receipt isolation, same-key deduplication, compatibility gating, deferred
outcomes, bounded persistence, timeout recovery, and late reconciliation.

### Completed - Command registry metadata

Every palette descriptor, Dashboard chat proposal, and drawer mutation descriptor declares
`ownerView`, `requiredFeatures`, `risk`, `confirmation`, and `receiptKind`. The shared
executor validates known owners and Manager features, blocks offline or incompatible
operations before their handler runs, and requires confirmation for medium/high-risk
commands. Harmless drawer-opening commands remain distinct from the mutations inside them.

## Definition Of Done For Future Commands

A new Dashboard command is complete only when it:

1. Is registered once and is discoverable by intent-oriented search terms.
2. Names its owner page and required Manager features.
3. Uses Manager authority for shared operational state.
4. Has an idempotency key and a durable receipt or event.
5. Shows pending, success, deferred, blocked, and failed states without ambiguous text.
6. Preserves project/plan/task/agent lineage where work is created.
7. Records only redacted, useful Brain learning.
8. Has parser/registry coverage and, for interactive behavior, a rendered UI test.

## Historical Rationale

Before `v0.1.647`, Dashboard was primarily Live Coordination, activity, and lead chat;
projects, task overlays, plans, and organization state were mostly local or accessible only
from separate pages. The compatible Manager did not yet expose durable control-state,
control-event, and Brain-relay contracts. That design caused state drift, weak lineage, and
silent compatibility failures.

The released architecture closes those structural gaps while keeping Work and the other
owner pages available for deeper operations. Future changes should update this document's
status, verification matrix, and remaining-gap list instead of appending a second historical
plan.
