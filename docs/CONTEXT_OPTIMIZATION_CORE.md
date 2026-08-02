# Core Context Optimization

IDACC includes deterministic context budgeting as an internal application capability. It is not a plugin, skill, MCP server, or package that users need to install or manage.

## Core behavior

- Only eligible `/ask` prompts are inspected.
- Exact duplicate and clearly marked background material may be compacted deterministically.
- The original user objective and active instructions remain exact.
- Prompts below the savings threshold use the direct route unchanged.
- Secrets, authentication material, wallet or key material, instruction sidecars, active patches, and validator evidence always use the direct route.
- Decisions are recorded as redacted measurements; raw prompts are not persisted by the context-budget report.
- Every supported runtime receives the same behavior because optimization occurs before provider or agent routing.

## Retired retrieval adapter

The experimental `idacc-context-retrieval` package was removed because it was not part of the dispatch path and the Manager did not advertise a retrieval-handle contract. Showing the bundled pilot in Plugins made an inactive implementation candidate look like a user-manageable feature.

IDACC does not send retrieval handles. Headroom-specific or other reversible compression remains unavailable for automatic routing unless a future implementation proves source recovery, expiry, protected-content fallback, runtime-neutral coverage, and quality gates as a true core contract.

## Validation

The context-budget smoke, retention, history-replay, dispatch, and privacy tests are the authority for this capability. Packaged-app checks also verify that the retired adapter is not shipped or synthesized in the Plugins catalog.
