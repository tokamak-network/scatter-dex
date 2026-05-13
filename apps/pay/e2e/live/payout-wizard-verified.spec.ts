import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";

/**
 * Live-stack payout-wizard spec for a *verified* wallet — the
 * complement to `payout-wizard.spec.ts`'s unverified-gate smoke.
 * Confirms that once `IdentityGate.isVerified(account)` flips true,
 * Pay drops the gate modal and the wizard's step 1 (Category) is
 * reachable.
 *
 * Why this surface matters: every Pay write flow (deposit, settle,
 * claim, transfer-out) sits behind the wizard. The unverified-gate
 * spec proves the gate engages; this one proves it *disengages* on
 * the legitimate path, so a regression that left the modal stuck
 * even for verified wallets would surface as a CI failure instead
 * of a "Pay is unusable" Slack ping.
 *
 * The actual deposit / settle / claim button clicks need a wizard
 * driver helper that fills steps 2-3 and waits on tx confirmations
 * — that work lands in a follow-up PR; this spec just proves the
 * wizard's verified-entry surface is alive.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh` (or `bash scripts/dev.sh
 * --apps pay --mock`). Skips otherwise.
 */
test.describe("Live stack — payout wizard (verified wallet)", () => {
  test("verified wallet sees the wizard step 1 (Category) instead of the gate", async ({ page }) => {
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

    // The category buttons render in step 1 — Payroll is the first
    // entry. Visibility here means the gate let us through; same
    // anchor as the wallet-less `wizard.spec.ts` so a regression
    // in either path catches.
    await expect(
      page.getByRole("button", { name: /Payroll/i }).first(),
    ).toBeVisible();

    // The Stepper is the second proof point — its presence confirms
    // we're inside the wizard layout, not stuck on a fallback view
    // that happened to render the word "Payroll" elsewhere.
    await expect(
      page.getByRole("button", { name: /1\s*Category/i, current: "step" }),
    ).toBeVisible();

    // The "Verify your identity" modal must NOT be visible — its
    // presence is the exact regression this spec exists to catch.
    // Anchor on the heading copy used in IdentityGateModal.
    await expect(
      page.getByRole("heading", { name: /Verify your identity/i }),
    ).not.toBeVisible();
  });
});
