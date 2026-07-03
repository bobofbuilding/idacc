Task: coordination-validation-audit-2026-07-03

Scope:
- Verify whether the primary lead, team leads, and secondary validators are wired as intended.
- Verify whether agent instruction sidecars reflect the current hierarchy and active Work goals.
- Patch any hard guardrail gap found during the audit.

Findings:
- Primary lead routing is active in the generated org sidecar: `default/lead` delegates execution only to non-default team leads.
- Team leads are instructed to break scoped objectives into member-owned tasks, collect results, and relay completed work to `default/coder` plus `default/researcher`.
- Secondary validation is active for the default team: the manager reports the validator recommendation loop enabled for `coder,researcher -> lead`.
- Instruction sidecars are syncing through Org Sync. The release build runs Org Sync on boot/every five minutes, and Work goal save/remove triggers no-rebuild instruction sync so active goal memory reaches the sidecars without waiting for the timer.
- Live default-team task data shows the expected pattern: lead-owned coordination tasks, member/validator child tasks, and completed coder/researcher validation tasks.

Guardrail fix:
- Patched the forked `id-agents` manager so the validator recommendation loop can only run after a task is actually `done` with `completed_at` set. This prevents assignment/start/status paths from creating premature validator recommendation traffic or stale lead drafts.

Remaining operational note:
- The manager source has been rebuilt successfully. The running manager process must restart before the new validator-loop guard is live in the daemon process.
