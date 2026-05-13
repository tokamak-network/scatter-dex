import { test as baseTest } from "@playwright/test";
import { DEV_STACK_ENDPOINTS, isStackReachable } from "./stack";

/**
 * `test` flavour for the `e2e/live/` specs that require dev.sh to be
 * running. Auto-skips when the stack isn't reachable so a fresh clone
 * (where only the wallet-less specs and bridge unit tests run) still
 * passes without surfacing a wall of skips with copy-pasted skip
 * messages.
 *
 * Import this `test` (instead of `@playwright/test`'s) in any spec
 * under `e2e/live/`. The check runs once per test (matches the prior
 * `test.beforeEach` pattern); making it `auto: true` means a future
 * live spec doesn't have to repeat the skip block.
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
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
