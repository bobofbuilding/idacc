# Identity & Keys page gaps

## Delivered

1. **Bind an existing wallet.** The Account card now accepts a validated 20-byte EVM address and binds it through `identity:bindWallet`. The bridge writes only `ows_address` and `ows_wallet` metadata through the manager API; it does not create, import, or retain a signing secret. The same handler is available in the Tauri adapter.
2. **Per-chain address and status card.** The page iterates all `EXECUTION_CHAINS`, showing the controller EOA, Safe address, Safe deployment state, and the best matching enabled RPC health result. A disabled or unmatched RPC is marked unverified. The controller EOA is explicitly presented as the same address on every EVM chain.
3. **Custody/storage status.** Operational Chain Access now states that RPC secrets use Electron `safeStorage` encryption and wallet keys remain with the external OWS CLI, never in IDACC state or `localStorage`.

## Deferred backend follow-up

`AgentAccount` currently reports Safe deployment for one `chainId`. The new table displays that known state and labels the other execution chains as unverified rather than inferring deployment. A future manager/key-provider read must return Safe deployment state per chain to verify those rows.

## Validation

- `cd idctl-desktop && npm run typecheck` completed with zero TypeScript errors.
- A targeted scan of the new wallet-bind paths found no acceptance or persistence of secret signing material.
