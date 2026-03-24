# @zeko-labs/bridge-sdk

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
