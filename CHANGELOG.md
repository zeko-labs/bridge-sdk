# @zeko-labs/bridge-sdk

## 0.3.2

### Patch Changes

- d27cbf8: Use the Zeko-hosted Mina mainnet gateway endpoints in Bridge CLI defaults and Bridge SDK examples.
  - @zeko-labs/graphql@0.3.2

## 0.3.1

### Patch Changes

- 1393724: Report bridge runtime GraphQL setup failures with the failing endpoint and query name instead of generic missing config errors.
- 1393724: Preserve withdrawal action indexes while status witnesses are still catching up so long-running bridge commands can keep tracking submitted withdrawals. Mark unwitnessed withdrawals finalised when the helper account has advanced past their index. Use the dedicated testnet Actions API endpoint so testnet bridge validation can resolve deposit and withdrawal witnesses.
  - @zeko-labs/graphql@0.3.1

## 0.3.0

### Minor Changes

- 28eed6c: Enable Mina/Zeko mainnet bridge routes, add bridge CLI route and backend health diagnostics, and use network-specific bridge history windows for SDK deposit and diagnostic lookups.

### Patch Changes

- @zeko-labs/graphql@0.3.0

## 0.2.1

### Patch Changes

- 6ce5e75: Harden bridge CLI signer/account validation, dotenv precedence, transient mutation retries, and SDK deposit queue reporting.
  - @zeko-labs/graphql@0.2.1

## 0.2.0

### Minor Changes

- 39948b6: Update bridge operation methods to require a transaction signing callback.

  This is a breaking API change for SDK consumers: deposit, withdrawal, finalization, and cancellation methods now request wallet signatures through an explicit callback while preparing bridge proofs and executable transactions.

  The Zeko GraphQL package now exposes the updated bridge schema, bridge fee fields, proving result query, and signed transferrer inputs used by deposit and withdrawal requests.

- 29eb409: Improve deposit queue handling across the bridge SDK and CLI.

  The SDK now exposes per-deposit `cancellable` state and enforces deposit finalization ordering so later deposits cannot bypass earlier non-cancellable deposits, while still allowing older cancellable deposits to be skipped.

  The CLI now follows the same queue rule, preferring cancellation for older skippable deposits and blocking finalization when an earlier non-cancellable deposit still must be resolved.

### Patch Changes

- 6b49d09: Expose `bridgeVersion` on deposit and withdrawal status records so consumers can filter legacy bridge operations that predate the current sequencer flow.
- 6ad9452: Ignore legacy testnet deposit and withdrawal actions that predate the V2 bridge index ranges.
- f0711dd: Refactor the Bridge SDK facade into focused internal modules without changing the public API.
- 2e3c7b0: Make merged archive and live withdrawal action fetching resilient when live nodes reject archive-derived action-state cursors.
- 2f0b83a: Fix bridge CLI resume/status handling and bridge SDK status edge cases.

  The CLI now resumes effectively-finalizable deposits correctly in both the long-running `bridge` flow and the account-wide `operation resume-all` flow, clears queued deposits before submitting a new high-level deposit, preserves resumed deposit targets after finalization changes the indexed status hash, uses SDK finalization indexes to avoid applying withdrawal capability results to the wrong queued item, avoids duplicate finalization submissions while status output lags after a finalization hash, renames `operation resume-user` to `operation resume-all`, honors `--timeout-slots` on both `bridge` and direct `deposit submit`, exposes poll/retry delay controls on long-running bridge commands, reports status endpoints and submit-hash visibility while waiting on withdrawal status progress, retries direct deposit submissions on recoverable backend mutation failures, and normalizes bogus status timestamps before rendering them.

  The SDK now normalizes unresolved withdrawal timestamps, treats nullable Actions API commit responses as waiting/non-finalizable status with explicit boolean status fields, reports endpoint URLs in verbose withdrawal action-source diagnostics, reports the selected index from finalization capability checks, and reports a clearer non-finalizable deposit reason when an earlier deposit must be resolved first.

- Updated dependencies [39948b6]
  - @zeko-labs/graphql@0.2.0

## 0.1.0

### Minor Changes

- e3af225: **Breaking:** `canFinalizeDeposit`, `canCancelDeposit`, and `canFinalizeWithdrawal` now return `Promise<{ available: boolean; reason: string | null }>` instead of `Promise<boolean>`.

  Fetch live withdrawal actions incrementally from the last archived action state. Reorder first-withdrawal guard for early amount check and fix uncaught InsufficientFirstWithdrawalAmountError in canFinalizeWithdrawal.

### Patch Changes

- 8084d89: Improve bridge history diagnostics, validation error reporting, and test/build wiring.
  - @zeko-labs/graphql@0.1.0

## 0.0.1

### Patch Changes

- 1045f68: Release the public `@zeko-labs/graphql` and `@zeko-labs/bridge-sdk` packages with the updated package naming, publish workflow wiring, and standalone package documentation.
- Updated dependencies [1045f68]
  - @zeko-labs/graphql@0.0.1
