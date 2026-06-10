# Bridge SDK Agent Notes

Start bridge investigations here before correlating through the CLI. The CLI wraps this SDK, so SDK behavior is the source signal for endpoint, witness, queue, and finalization failures.

## How To Run

- Run all Moon tasks from the repo root. Inspect `packages/bridge-sdk/moon.yml` before running tasks.
- Use `moon run bridge-sdk:test -f`, `moon run bridge-sdk:typecheck -f`, `moon run bridge-sdk:lint -f`, and `moon run bridge-sdk:build -f` for local gates.
- For a focused SDK test file, first make sure workspace dependencies are built with `moon run graphql:build -f`, then use `pnpm --dir packages/bridge-sdk exec vitest run test/<file>.test.ts`. Do not add unsupported Vitest flags such as `--runInBand`.
- SDK examples read `MINA_PRIVATE_KEY`, not `ZEKO_BRIDGE_MINA_PRIVATE_KEY`.
- When using the repo-root `.env`, map the key only for the current command: `set -a; source .env; set +a; MINA_PRIVATE_KEY="$ZEKO_BRIDGE_MINA_PRIVATE_KEY" moon run bridge-sdk:canFinalizeDeposit -f`.
- Common live examples:
  - `moon run bridge-sdk:canFinalizeDeposit -f`
  - `moon run bridge-sdk:finalizeDeposit -f`
  - `moon run bridge-sdk:diagnoseHistory -f`
  - `moon run bridge-sdk:canFinalizeWithdrawal -f`
  - `moon run bridge-sdk:finalizeWithdrawal -f`
- Use `diagnoseHistory` when archive actions and actions API witnesses disagree. It separates Mina/Zeko archive action discovery from actions API witness lookup.
- Do not print private keys. Report public keys, operation IDs, transaction hashes, endpoints, GraphQL operation names, and Ray IDs instead.
