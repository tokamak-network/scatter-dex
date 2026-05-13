import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { fundUsdc } from "../_helpers/fund-wallet";

/**
 * Live-stack spec for `/wallet`'s connected view. Companion to
 * `wallet.spec.ts` (the wallet-less disconnected smoke). Proves
 * the page actually reads ERC-20 balances off-chain via the
 * bridge — a regression in the per-token balance fetch loop
 * would otherwise only surface as a "shows 0 for everything"
 * UX bug that nothing in CI catches.
 *
 * What this catches: the balance row's `erc20.balanceOf(account)`
 * call breaking (provider bridge regression, ABI drift), the
 * row's loading/error state masking a real value, or the
 * `formatUnits` call rendering a non-numeric.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — /wallet connected view", () => {
  test("connected wallet renders ERC-20 balance row for funded USDC", async ({ page }) => {
    // Fund the test wallet with 100 USDC so the balance row
    // renders a non-zero, recognizable number. anvil-snapshot
    // teardown rolls this back so the next spec gets a clean
    // baseline.
    await fundUsdc({
      account: ANVIL_VERIFIED_TEST.account,
      amount: "100",
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await installTestWallet(page, {
      account: ANVIL_VERIFIED_TEST.account,
      chainId: ANVIL_VERIFIED_TEST.chainId,
      privateKey: ANVIL_VERIFIED_TEST.privateKey,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/wallet");

    // Page header renders the full account address (wallet/page.tsx:101).
    // Confirms the page got past hydration into the connected branch
    // (vs the "Connect a wallet from the header" fallback).
    await expect(
      page.getByText(ANVIL_VERIFIED_TEST.account),
    ).toBeVisible();

    // The "Refresh balances" CTA renders only in the connected
    // branch — second anchor on the page-state gate.
    await expect(
      page.getByRole("button", { name: /Refresh balances/i }),
    ).toBeVisible();

    // The token rows render through the table; USDC is in
    // LAUNCH_TOKENS so it always has a row. Anchor on the
    // formatTokenLabel symbol cell.
    await expect(
      page.getByText(/^USDC$/).first(),
    ).toBeVisible();

    // After the balance fetch settles, the row's balance cell
    // shows the formatted amount (100.0 USDC = 100000000 raw at
    // 6 decimals, formatUnits → "100.0"). Catches the row staying
    // stuck on the loading "…" placeholder or rendering "err".
    // Tolerant of trailing zeros so 100, 100.0, or 100.00 all
    // pass.
    await expect(
      page.getByText(/^100(\.0+)?$/).first(),
    ).toBeVisible({ timeout: 10_000 });

    // No "err" or loading "…" cells should remain after the
    // table settles — a regression where balanceOf throws but
    // the UI silently masks it would surface here.
    await expect(
      page.getByText(/^err$/).first(),
    ).not.toBeVisible();
  });
});
