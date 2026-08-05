# IDACC runtime, local-model, authentication, and migration audit — v0.1.701

Date: 2026-08-04

## Outcome

IDACC v0.1.701 was built, signed, packaged, installed, restarted, and audited against the pre-update profile backup. The bundled Manager and Brain are healthy and attested, authenticated Manager access succeeds, the saved HR runtime/model choice survives restart, and all durable Manager and Brain records were preserved.

The installed application version is exactly `0.1.701`. Review/build suffixes are not used in the application version.

## Implemented fixes

- Added one atomic HR configuration operation for runtime, model, effort, speed, provider, and process state. It validates the reviewed baseline, preflights the destination, performs at most one rebuild, verifies the live result, and rolls back the durable configuration on failure.
- Stopped startup reconciliation from overwriting a valid saved runtime/model choice. Legacy rows with missing values are still repaired.
- Made local-runtime checks use a short, shared freshness window and a focused probe. HR now refreshes local availability when the page regains focus without waiting for unrelated subscription/CLI checks.
- Clarified local status in HR by separating backend availability from agent process state (`running` versus intentionally `parked`).
- Restored saved workers with bounded concurrency. Only the primary coordinator is awaited serially; the rest of the fleet recovers in groups of four by default.
- Removed BrowserMCP from managed attachments and pinned the supported MCP package versions.
- Migrated MCP connection material out of agent metadata. Agents now store stable connection references, while decrypted connection details exist only in the desktop/Manager process environment and the exact worker environment that needs them.
- Corrected MCP compare-and-set handling so the caller reviews and submits the safe reference snapshot while the desktop rehydrates the desired connection from its encrypted registry.
- Updated the unified capability contract to API version 6 with the atomic agent-configuration route.

## Live audit evidence

### Unified package and authentication

- Installed app: `0.1.701`
- Bundled Manager: `0.1.163`
- Bundled Brain: `0.1.8`
- Clean-profile packaged stack test: passed
- Manager and Brain identity attestation: passed
- Authenticated Manager contract, including protected MCP attach/conflict/detach: passed
- Unauthenticated `/agents` request: rejected with HTTP 401 and `authentication_required` (expected security behavior)
- Current Manager generation: no `managed_worker_auth_required`, restore failure, stack overflow, connection-closed, fatal, or default/coder drift event found

### HR runtime persistence and recovery

- `default/coder`: `claude-code-cli` / `claude-opus-4-8`, running after repeated restarts
- Metadata runtime agrees with the durable runtime: `claude-code-cli`
- Fleet after recovery: 60 running, 15 intentionally stopped, 0 starting, 0 offline
- Provider/local-agent subset: 1 running, 13 intentionally stopped
- Full worker recovery span improved from about 52.9 seconds to about 16.9 seconds in the measured restart audit

### Local model discovery

- Ollama: reachable (HTTP 200)
- Installed Ollama models: 10
- Models resident in memory during the audit: 0; this is normal on-demand unloading, not an unavailable backend
- LM Studio: not listening on port 1234; IDACC correctly reports it unavailable

### Credential and MCP migration

- Managed registry: filesystem, memory, context7, github, fetch
- Registry entries: 5 encrypted, 0 plaintext connection records, 0 floating `@latest` packages
- Agent metadata: 75 agents use safe connection references
- BrowserMCP attachments: 0
- Agent rows containing the former GitHub credential key: 0
- Agent rows containing floating `@latest`: 0

### Data preservation

Both current databases returned `ok` from SQLite integrity checks.

Manager current-versus-backup counts:

| Record group | Backup | Current |
|---|---:|---:|
| Teams | 10 | 10 |
| Agents | 75 | 75 |
| Tasks / task history | 13,844 | 13,844 |
| News / tracking items | 30,915 | 30,962 |
| Event log | 18,334 | 18,756 |
| Queries | 22,479 | 22,492 |
| Check-ins | 1,888 | 1,888 |
| Schedule definitions | 23 | 23 |
| Schedule runs | 8,185 | 8,189 |
| Control-state records | 23 | 23 |

Every Manager table present in the backup is present in the current database, and no table count decreased.

Brain durable records were also preserved or grew, including:

| Record group | Backup | Current |
|---|---:|---:|
| Agent memories | 14,708 | 14,708 |
| Entities | 6,411 | 6,416 |
| Entity edges | 183,422 | 185,010 |
| Facts | 48,342 | 49,136 |
| Text units | 24,610 | 24,611 |
| Learning tasks | 1,402 | 1,405 |
| Skill nodes | 52 | 52 |
| Skill edges | 556 | 556 |
| Timeline | 200,058 | 200,508 |

Two internal SQLite FTS index-page tables were compacted during normal index maintenance; their logical search content and all 52 skill records remain intact.

## Verification completed

- Manager typecheck passed.
- Desktop typecheck passed after the final MCP compare-and-set correction.
- Manager test suite passed: 1,644 tests passed and 84 skipped.
- Atomic configuration/auth integration tests passed.
- Runtime catalog, provider rehydration, secret redaction, secure settings vault, HR management, supervisor policy, and unified runtime contract checks passed.
- Final clean-profile packaged unified-stack test passed after installation candidate rebuild.
- Release output inspection passed: 11 production files and no source maps.
- Source diff whitespace checks passed in both repositories.

## Remaining operator actions

1. Revoke or rotate the previously stored GitHub personal access token in GitHub. IDACC removed the plaintext at-rest copies, but a local migration cannot revoke the external credential itself.
2. Start LM Studio only if it is intended to be an active local provider. Ollama is already healthy.
3. Leave the 13 parked provider agents stopped unless they are meant to consume resources continuously; their stopped state is deliberate and is now shown separately from backend availability.

## Recovery points

- Unified profile backup: `/Users/jhineline/Library/Application Support/ID Agents Control Center/profiles/default/backups/pre-v0.1.701`
- Previous installed application: `/Applications/ID Agents Control Center.app.pre-v0.1.701-mcp-cas-fix`
