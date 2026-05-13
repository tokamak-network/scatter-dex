import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";
import { driveWizardToStep4 } from "../_helpers/wizard-driver";

/**
 * Live-stack spec: drive the payout wizard from step 1 through to
 * step 4 (Funds), then assert the DepositButton renders with the
 * correct shortfall state. Builds on `payout-wizard-verified.spec.ts`
 * (verified wallet, gate disengaged) and exercises the seam between
 * the wizard's recipient/claimFrom inputs and the funds panel.
 *
 * Scope cap: the actual deposit click + tx confirmation needs a
 * relayer pick + DEX router setup + tx wait — separate spec. This
 * one proves the wizard reaches step 4 with a real shortfall, which
 * is the precondition for that deeper flow.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — payout wizard funds step", () => {
  test("wizard drives 1→4 and DepositButton lights up on shortfall", async ({ page }) => {
    await verifyTestWallet({
      account: ANVIL_VERIFIED_TEST.account,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await installTestWallet(page, {
      account: ANVIL_VERIFIED_TEST.account,
      chainId: ANVIL_VERIFIED_TEST.chainId,
      privateKey: ANVIL_VERIFIED_TEST.privateKey,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/payouts/new");

    // Drive through to step 4 with the default Payroll category +
    // 1 USDC to anvil #1.
    await driveWizardToStep4(page, { amount: "1" });

    // At step 4 the Stepper highlights "4 Funds" active. Same
    // aria-current anchor used in the verified-wallet smoke.
    await expect(
      page.getByRole("button", { name: /4\s*Funds/i, current: "step" }),
    ).toBeVisible();

    // DepositButton appears with copy `Deposit <amount> <token>`.
    // Fresh test wallet has no vault notes for USDC, so the run's
    // 1 USDC shortfall is exactly the deposit prompt. Anchor on the
    // "Deposit ... USDC" pattern, not a literal — the button shows
    // a derived amount that includes formatting (e.g. "1.00 USDC").
    await expect(
      page.getByRole("button", { name: /Deposit.*USDC/i }).first(),
    ).toBeVisible();

    // Wrong-chain banner must not appear — same regression check as
    // the unverified + connect specs. Chain-id drift is the most
    // common config issue and worth re-asserting once we're deep
    // into a wizard run.
    await expect(
      page.getByText(/Wrong chain|Switch to/i),
    ).not.toBeVisible();
  });
});
