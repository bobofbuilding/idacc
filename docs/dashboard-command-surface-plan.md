# Dashboard Command Surface

## Status

The six-phase command-surface refactor is released and in service.

| Component | Baseline | Role |
|---|---:|---|
| IDACC | `v0.1.648` | Dashboard commands, control panels, chat intents, local cache, and compatibility UI |
| Compatible Manager | `bobofbuilding/id-agents` `v0.1.111` | Fleet mutations, durable control state/events, Brain relay, and task execution |
| Brain | `d51f88e740e465b1865eba10fc980d31637f0c82` | Manager-event learning, task lineage, durable memory, and duplicate/no-op suppression |

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
   plan, and Brain-control writes go through the compatible Manager.
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
7. **Compatibility is explicit.** IDACC checks the Manager capability manifest and shows a
   degraded-state warning instead of silently rendering an empty fleet.

## Runtime Flow

```text
Dashboard command (palette, drawer, or confirmed chat intent)
  -> desktop IPC
    -> ManagerClient
      -> compatible Manager :4100
        -> operational mutation and/or versioned control-state write
        -> durable control/config/task event
          -> Manager event stream
            -> Brain listener
              -> timeline, entities, facts, text units, and lineage
```

The Manager contract is versioned by `CC_API_VERSION = 4` and advertises:

- `POST /control/brain`
- `POST /control-event`
- `GET|POST|DELETE /control/state/:scope/:key`
- `POST /control/memory`
- feature flags `brain-control`, `control-events`, and `control-state`

IDACC must gate dependent controls on these advertised capabilities. Legacy fallback is
read-only or explicitly degraded; it must not silently invent authoritative state.

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

All retryable writes use stable idempotency keys. Versioned control-state writes reject
stale updates; the desktop refreshes before retrying instead of overwriting concurrent work.

## Reliability Contract

- A button shows a pending state immediately and remains scoped to that invocation.
- Concurrent commands do not share a single global busy flag unless they mutate the same
  versioned resource.
- A Manager timeout is not success. The client reconciles by idempotency key before retrying.
- A rate-limit or provider-capacity failure keeps the task alive and uses the runtime
  fallback policy; it does not create a duplicate task.
- Deferred capacity is represented as deferred work, not a human blocker, unless a real
  authorization or missing-input decision is required.
- A failed Brain write does not erase a successful Manager mutation. It is retried from the
  durable event stream.
- Missing or incompatible Manager capabilities produce a visible compatibility notice with
  the required Manager version and recovery action.
- Duplicate and no-op control events are suppressed before durable learning.

## Verification Matrix

| Gate | Current coverage | Required result |
|---|---|---|
| Command discovery and chat parsing | `npm run test:dashboard-command-surface` | Core commands rank correctly; supported intents parse; ordinary chat is not promoted |
| Dashboard hierarchy compatibility | `npm run test:dashboard-coordination` | Current and legacy hierarchy data render without hiding an active fleet |
| Manager Brain transport | `idctl` `brainTransport.test.ts` | Relay is installed, direct desktop transport is absent, retries preserve idempotency |
| Manager control contract | Manager relay/control-state tests | API v4 routes validate input, redact secrets, enforce versions, and persist state |
| Brain learning | Brain listener tests | Control/task events create bounded, cited, deduplicated learning artifacts |
| Desktop integrity | `npm run typecheck && npm run build` | Renderer and main process compile and package cleanly |

## Remaining Gaps

These are follow-up improvements, not blockers to the released command surface.

### P1 - End-to-end compatibility gate

IDACC tests its client and the Manager tests its routes, but the release process does not yet
boot the exact packaged IDACC/Manager/Brain trio and execute a complete command-to-learning
journey. Add a release smoke that creates a temporary project, dispatches one task, observes
the control event, verifies Brain lineage, then cleans up by idempotency key.

**Done when:** a version mismatch or missing route fails release validation before an app is
published.

### P1 - Command completion receipts

The activity feed acknowledges operations, but commands do not share one durable receipt
shape across palette, drawer, chat, and owner-page handoffs.

**Fix:** standardize `{ commandId, idempotencyKey, state, resourceRefs, startedAt,
finishedAt, error, recovery }` and render it consistently.

**Done when:** an operator can move between Dashboard and Work and still identify the same
in-flight or failed operation without relying on message text.

### P1 - Drawer interruption safety

The drawer now traps focus, closes on Escape, restores focus to its trigger, and exposes
modal semantics. It still needs a shared unsaved-change and in-flight-mutation dismissal
guard across its independently owned panels.

**Done when:** a drawer cannot be dismissed silently while it has unsaved edits or an
in-flight mutation; the operator can explicitly discard or keep working.

### P2 - Project progress summary

Project driver shows recent tasks but not a normalized plan/objective progress rollup.

**Fix:** derive counts from Manager lineage (`project -> plan -> task`) and show working,
deferred, blocked, failed, and complete states with a direct Work handoff.

### P2 - Full browser-level interaction coverage

The current command-surface smoke validates registry and parser behavior, not rendered focus,
confirmation, concurrency, or recovery states.

**Fix:** add Playwright coverage for `Cmd-K`, drawer lifecycle, confirm/decline, concurrent
commands, Manager timeout reconciliation, and legacy compatibility notices.

### P2 - Command registry metadata

Command handlers are shared by palette and drawers, but ownership, required Manager features,
risk level, confirmation policy, and expected receipt type are not represented uniformly.

**Fix:** extend command descriptors with `ownerView`, `requiredFeatures`, `risk`,
`confirmation`, and `receiptKind`; use the metadata for gating and documentation checks.

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
