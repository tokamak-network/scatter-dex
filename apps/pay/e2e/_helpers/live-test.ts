import { test as baseTest } from "@playwright/test";
import { DEV_STACK_ENDPOINTS, isStackReachable } from "./stack";
import { revertAnvil, snapshotAnvil } from "./anvil-snapshot";

/**
 * `test` flavour for the `e2e/live/` specs that require dev.sh to be
 * running. Auto-skips when the stack isn't reachable so a fresh clone
 * (where only the wallet-less specs and bridge unit tests run) still
 * passes without surfacing a wall of skips with copy-pasted skip
 * messages.
 *
 * Also takes an anvil snapshot before each spec and reverts on
 * teardown. Specs that mutate on-chain state (verifyTestWallet,
 * fundUsdc, deposit txs, etc.) get a clean slate per test without
 * the previous test's leftovers — `setVerified` flips, token
 * balances, claim nullifiers all roll back. The snapshot/revert
 * pair is anvil-global, so live specs MUST run under a single
 * worker (see anvil-snapshot.ts module doc).
 *
 * Import this `test` (instead of `@playwright/test`'s) in any spec
 * under `e2e/live/`. The fixture runs once per test (auto: true).
 */
export const test = baseTest.extend<{ liveStack: void }>({
  liveStack: [
    async ({}, use, testInfo) => {
      if (!(await isStackReachable())) {
        testInfo.skip(
          true,
          `dev.sh not running — start with: bash scripts/dev.sh --apps pay --mock\n` +
            `(checked anvil at ${DEV_STACK_ENDPOINTS.rpcUrl} and zk-relayer at ${DEV_STACK_ENDPOINTS.relayerUrl})`,
        );
      }
      const snapshotId = await snapshotAnvil();
      try {
        await use();
      } finally {
        await revertAnvil(snapshotId);
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
