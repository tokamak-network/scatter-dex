import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";
import { fundUsdc } from "../_helpers/fund-wallet";
import { driveWizardToStep4 } from "../_helpers/wizard-driver";

/**
 * Live-stack spec: click the DepositButton on step 4 and confirm
 * the deposit flow actually starts — proves the wizard →
 * realDeposit pipeline is wired end-to-end (UI click,
 * AbortController spawn, DepositPhase state transition,
 * DepositProgress mount).
 *
 * Scope cap: asserts the deposit flow REACHED the proving phase
 * but does NOT wait for the on-chain confirmation. Groth16 proof
 * gen for `deposit.circom` runs ~3-10s in headless Chromium, and
 * the on-chain confirmation adds another second or two — pulling
 * the full path into every test run trades walltime for marginal
 * extra regression coverage. A future
 * `payout-wizard-deposit-complete.spec.ts` can opt into the
 * full-flow assertion when it's worth the budget.
 *
 * What this catches: regressions where the click hook is dropped,
 * the AbortController setup throws, the phase state machine fails
 * to advance past `preparing`, or the proof worker crashes loading
 * the wasm/zkey. Each would surface here as a missing/error phase
 * before the proving step.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — deposit flow starts", () => {
  test("click DepositButton — DepositProgress shows the proving phase", async ({ page }) => {
    await verifyTestWallet({
      account: ANVIL_VERIFIED_TEST.account,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    // DeployLocal mints USDC only to anvil #0-#4; the verified test
    // wallet is anvil #5 (per-account state isolation, see PR
    // #727), so top it up before the deposit click. Without this
    // the deposit call reverts on transferFrom (insufficient
    // balance) before reaching the proving phase. The live-test
    // fixture (`anvil-snapshot.ts`) reverts this mint at teardown
    // so the next spec starts from the same clean baseline.
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
    await page.goto("/payouts/new");
    await driveWizardToStep4(page, { amount: "1" });

    // Trigger the deposit. DepositButton labels itself
    // `Deposit <amount> <token>` (see FundsStep.tsx:74-77); the
    // amount is locale-formatted so we anchor on `Deposit … USDC`.
    await page.getByRole("button", { name: /Deposit.*USDC/i }).first().click();

    // DepositProgress renders the current phase copy from
    // DEPOSIT_PHASE_COPY (page.tsx:1998). `Generating deposit
    // proof…` (`proving` phase) holds for the full ZK proof
    // duration, which is the longest in the pipeline and the
    // cleanest signal that the click successfully kicked off the
    // flow. 30s timeout covers browser-warmup variance.
    //
    // The copy appears in both the panel heading and the message
    // line — `.first()` picks one cleanly.
    await expect(
      page.getByText(/Generating deposit proof/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The error phase shouldn't fire. If it does, surface it with
    // a more useful anchor than a generic Playwright timeout.
    await expect(
      page.getByText(/Deposit failed/i),
    ).not.toBeVisible();
  });
});
