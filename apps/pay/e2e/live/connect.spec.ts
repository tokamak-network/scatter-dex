import { expect, test } from "@playwright/test";
import { ANVIL_DEFAULT, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS, isStackReachable } from "../_helpers/stack";

/**
 * First live-stack scenario. Skips when dev.sh isn't running —
 * the harness's wallet-less + bridge specs stay green; the live
 * tests gate on the full stack so a fresh clone doesn't fail
 * before the developer brings the stack up.
 *
 * Boot the stack with: `bash scripts/dev.sh --apps pay --mock`.
 *
 * What this scenario asserts: with anvil + zk-relayer up, the
 * bridge's read-side passthrough lets Pay's `useWallet` hydrate
 * against real on-chain state. The dashboard's wallet pill shows
 * the connected account AND the wrong-chain banner stays hidden
 * (so chainId 31337 from the bridge matches Pay's network config).
 *
 * This proves the integration seam — bridge ↔ Pay ↔ anvil — works.
 * The follow-up specs (deposit, settle, claim, transfer-out) build
 * on top.
 */
test.describe("Live stack — wallet connect", () => {
  test.beforeEach(async () => {
    test.skip(
      !(await isStackReachable()),
      `dev.sh not running — start with: bash scripts/dev.sh --apps pay --mock\n` +
        `(checked anvil at ${DEV_STACK_ENDPOINTS.rpcUrl} and zk-relayer at ${DEV_STACK_ENDPOINTS.relayerUrl})`,
    );
  });

  test("dashboard hydrates connected against live anvil", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
      privateKey: ANVIL_DEFAULT.privateKey,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/dashboard");

    // Connected pill renders the short address (`0xPREFIX…SUFFIX`),
    // same anchor as the harness-only smoke. Reuse the prefix /
    // suffix pattern instead of `shortAddr` to keep the assertion
    // independent of the SDK helper's exact format.
    const account = ANVIL_DEFAULT.account.toLowerCase();
    const prefix = account.slice(0, 6);
    const suffix = account.slice(-4);
    await expect(
      page.getByText(new RegExp(`${prefix}.*${suffix}`, "i")).first(),
    ).toBeVisible();

    // Wrong-chain banner must be absent — its presence means the
    // bridge's chainId doesn't match `getNetworkConfig().chainId`
    // (a config-drift regression that breaks the wizard's submit
    // gating). The banner is rendered by `WrongChainBanner.tsx`
    // when `wrongChain === true`.
    await expect(
      page.getByText(/Wrong network|Switch your wallet/i),
    ).not.toBeVisible();

    // Dashboard heading present — proves we got past hydration into
    // the route's own component tree (vs being stuck on the layout
    // shell with a hydration error).
    await expect(
      page.getByRole("heading", { name: /Recent payouts/i }),
    ).toBeVisible();
  });
});
