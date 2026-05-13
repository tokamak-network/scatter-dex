import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";
import { fundUsdc } from "../_helpers/fund-wallet";
import { driveWizardToStep4 } from "../_helpers/wizard-driver";

/**
 * Live-stack spec: drive the wizard's deposit flow end-to-end —
 * click DepositButton, wait for the ZK proof + on-chain confirm to
 * land, and assert the `Deposited` terminal phase appears. Builds
 * on `payout-wizard-deposit-start.spec.ts` (proves the proving
 * phase fires); this one closes the loop on the tx side.
 *
 * What this catches that the start-only spec doesn't: any
 * regression after proving — calldata encoding mistakes, gas
 * estimate failures, approve-then-deposit nonce sequencing, or any
 * DepositPhase transition that loses the txHash mid-flight.
 *
 * Cost: ~25-40s walltime — Groth16 proof gen for deposit.circom +
 * one anvil block. Worth it for a single happy-path spec; the
 * anvil-snapshot/revert in live-test cleans up afterward so the
 * next spec is unaffected.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — deposit flow completes", () => {
  // Default test timeout (30s) is tight given the proof gen + tx
  // confirm tail. Bump for this spec only — the rest of the suite
  // stays on the snappy default.
  test.setTimeout(90_000);

  test("click DepositButton — DepositProgress reaches the Deposited terminal phase", async ({ page }) => {
    await verifyTestWallet({
      account: ANVIL_VERIFIED_TEST.account,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
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

    await page.getByRole("button", { name: /Deposit.*USDC/i }).first().click();

    // Terminal happy phase is `done` → DEPOSIT_PHASE_COPY.done =
    // `Deposited` (page.tsx:2005). DepositProgress prefixes the
    // panel heading with `✓ ` (page.tsx:2040) for the done state.
    // Anchor on `✓ Deposited` — the bare word "deposited" also
    // appears in the wizard's static copy ("already-deposited
    // notes …") so /Deposited/i would false-positive.
    //
    // 60s budget covers Groth16 proof gen (~3-15s) + anvil mine.
    await expect(
      page.getByText(/✓ Deposited/).first(),
    ).toBeVisible({ timeout: 60_000 });

    // `Deposit failed` must NOT appear at any point — its presence
    // is the exact regression class this spec exists to catch.
    await expect(
      page.getByText(/Deposit failed/i),
    ).not.toBeVisible();

    // The `done` phase exposes the truncated txHash inline (first
    // 18 chars + ellipsis, page.tsx:2047). Asserting on the `0x`
    // prefix confirms a real on-chain receipt — not just a UI
    // success state that forgot to surface the tx.
    await expect(
      page.getByText(/0x[0-9a-f]{14,}…/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
