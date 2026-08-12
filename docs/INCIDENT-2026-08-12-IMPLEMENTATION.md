# IDACC incident implementation log — 2026-08-12

This source-only log reconciles the two contemporaneous reports. The installed
application restart and changing bootstrap counts were caused by a separate,
authorized recovery task sharing the same profile; they are not classified as
an unrequested Manager restart. The storage confirmation bypass, missing
cross-task lease, unbounded retention, stale terminal delegation lock, and
prose-only lead dispatch were real defects.

## Source changes

- Storage governor: profile/category accounting, 30-day bounded daily trend,
  total/workspace/backup budgets, low-disk admission gates, and Settings
  visibility.
- Brain snapshots: three-copy + aggregate-byte policy, prune-before-snapshot,
  and full-copy free-space reserve.
- Migration/workspace lifecycle: seven-day cooling-off candidates and typed
  retention inventory for temporary files, build caches, dependencies, browser
  runtimes, outputs, and uploads. These remain review-only; active workspaces
  are never removed by a raw filesystem job.
- Consent: main-process, expiring single-use operation leases with target
  summaries, durable cancellation/completion receipts, and an exclusive
  profile lease across renderer reloads and local builds.
- Delegation: all primary-lead fan-out now creates a Manager-backed parent
  task before it can report a prompted lead; a missing task receipt is failure.
  A terminal task can no longer block a new plan.

## Acceptance mapping

1. `storage-governor-smoke` records a bounded 30-day history.
2. Idle slope is reported from daily samples; retention data is bounded.
3. Backup policy enforces three copies and aggregate bytes before snapshots.
4. `storage-lifecycle-smoke` verifies cooling-off candidates become reviewable,
   never silently deleted.
5. The same smoke inventories all required typed workspace classes.
6. Backup admission rejects low-space full copies before SQLite writes them.
7. `storage-operation-lease-smoke` verifies expiry/restart becomes cancellation.
8. The operation-lease smoke rejects concurrent control attempts.
9. `storage-recovery-smoke` preserves active values while recovering retired history.
10. Storage recovery retains verified backups and emits operation/deletion receipts.

Remaining follow-up: controlled, task-aware retirement UI for eligible workspace
candidates; it requires Manager task-state evidence and explicit approval.
