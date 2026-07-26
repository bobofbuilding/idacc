# Headroom Backend Contract Candidate

IDACC now has a core deterministic context-budget layer. Headroom remains a candidate core compression engine until a runtime-neutral retrieval contract is proven without enlarging the unified runtime unnecessarily or narrowing the platform to one runtime family.

## Minimal-Change Path

1. Keep live `/ask` dispatch on the existing manager route.
2. Measure current behavior with hidden context-budget stats and local chat-history replay.
3. Bundle and smoke-test an optional `idacc-context-retrieval` resolver candidate as a pilot adapter.
4. Package that resolver as an IDACC portable plugin: Skill instructions for every local runtime, stdio MCP for tool-capable runtimes, a native Claude plugin adapter for Claude-family runtimes, and direct fallback for every runtime.
5. Treat native-plugin-only routing as pilot-scoped because native id-agents plugin loaders are runtime-specific.
6. Treat MCP resolver routing as a broader pilot surface for MCP-capable runtimes, while keeping Skill/direct fallback for runtimes without a resolver surface.
7. Promote Headroom retrieval-handle routing only when `/capabilities` can report the contract and every dispatch has direct fallback.

## Required Runtime Contract

- The manager or agent environment must advertise a context-retrieval capability before IDACC sends retrieval handles.
- A compressed prompt must include a stable retrieval handle, a source hash, an expiry, and a fallback summary.
- The agent must be able to resolve the handle before acting, or IDACC must keep the prompt on the direct route.
- Protected content classes stay direct: secrets, auth material, wallet/key material, instruction sidecars, active patches, and validator evidence.
- Every routed prompt must produce an audit record with token estimates, transform class, retrieval capability state, and fallback route.
- Persistent memory, Brain sync, task orchestration, goals, plans, schedules, routing, keys, and wallet flows must stay outside the retrieval plugin contract.

## Runtime Coverage Decision

- `idacc-context-retrieval` portable plugin package: valid as a neutral package only because it declares Skill, MCP, native plugin, and direct-fallback adapters.
- `idacc-context-retrieval` native plugin adapter: valid as a Claude-family pilot resolver.
- `idacc-context-retrieval` MCP: the same guarded resolver exposed through a runtime-neutral tool boundary for Claude, Codex, and Ollama.
- Headroom MCP: a separate compression-engine candidate surface when the Headroom CLI/proxy is installed and smoke-tested.
- Manager retrieval contract: required before core activation because it lets IDACC feature-detect bundled support and keep explicit developer connections to older external Managers on direct routing.
- Direct deterministic fallback: remains universal for all runtimes and protected content.

Native-plugin-only routing is not core-ready because it would exclude Codex, cursor-cli, Ollama, and future runtimes. MCP closes much of that gap for Claude, Codex, and Ollama, while Skill/direct fallback covers cursor-cli and unsupported future runtimes. The bundled portable plugin validates the shape of a guarded retrieval contract; it is not the final platform-wide dependency by itself.

## Validation Gates

- Historical chat replay shows savings without exposing or persisting raw chat text.
- Deterministic smoke tests continue to prove protected-content direct fallback.
- A retrieval resolver smoke test proves portable manifest adapter coverage, store, resolve, hash-match, expiry, protected-content reject, direct fallback, and MCP tool listing/calls.
- Manager `/capabilities` reports the retrieval contract version before IDACC enables handle routing.
- Quality review compares original objective, compressed prompt, resolved context, and final response for drift.

## Current Decision

The portable resolver path is validated for pilot work, not core activation. IDACC now bundles an `idacc-context-retrieval` candidate and smoke tests that verify portable adapter coverage, resolver instructions, source-hash checks, expiry, protected-content rejection, and stdio MCP tool calls. The core Headroom path still requires manager-advertised retrieval support plus direct fallback, so token compression does not block AI orchestration, local LLMs, or persistent memory features.
