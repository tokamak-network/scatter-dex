import { expect, test } from "../_helpers/live-test";
import { ANVIL_DEFAULT, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";

/**
 * Live-stack payout-wizard identity gate smoke.
 *
 * Pay gates `/payouts/new` behind zk-X509 verification (see
 * `apps/pay/app/_lib/identityGuard.ts`): an unverified wallet sees a
 * "Verify your identity" dialog instead of the wizard. This spec
 * confirms that gate engages correctly when a funded-but-unverified
 * anvil wallet visits the route — without it, a regression that
 * silently lets unverified wallets through into the wizard (or
 * crashes during hydration) wouldn't fail CI.
 *
 * Out of scope: driving the wizard past the gate — that needs a
 * zk-X509 mock or a verified-wallet helper. Lands separately
 * alongside the wizard-step / deposit-flow specs the gate currently
 * blocks. The manual settle path remains
 * `docs/operations/qa-pay-weth-transferout.md`.
 *
 * Boot: `bash scripts/dev.sh --apps pay --mock`. Skips otherwise so
 * a fresh clone doesn't fail before the stack is up.
 */
test.describe("Live stack — payout wizard identity gate", () => {
  test("unverified wallet hits the verify-your-identity gate", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
      privateKey: ANVIL_DEFAULT.privateKey,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/payouts/new");

    // Identity gate copy is the most stable anchor for the unverified
    // surface — it's the heading on both the inline guard panel AND
    // the dialog it spawns, so the regex matches whichever one renders
    // first. (See `apps/pay/app/_components/IdentityGate.tsx`.)
    await expect(
      page.getByText(/Verify your identity/i).first(),
    ).toBeVisible();

    // The wizard's Stepper must NOT have rendered — its presence
    // would mean the gate let an unverified wallet through, which is
    // the compliance regression this spec exists to catch.
    await expect(
      page.getByRole("button", { name: /1\s*Category/i }),
    ).toHaveCount(0);

    // Top nav still hydrates with the connected address (proves the
    // bridge passthrough survives the gate — a regression that broke
    // hydration during gating would also break the dashboard).
    const account = ANVIL_DEFAULT.account.toLowerCase();
    const prefix = account.slice(0, 6);
    const suffix = account.slice(-4);
    await expect(
      page.getByText(new RegExp(`${prefix}.*${suffix}`, "i")).first(),
    ).toBeVisible();

    // Wrong-chain banner stays absent — same regression check as
    // `connect.spec.ts`. The identity gate is a frequent source of
    // chain-id drift bugs (the verify path reads the chain id
    // independently from the wizard).
    await expect(
      page.getByText(/Wrong chain|Switch to/i),
    ).not.toBeVisible();
  });
});
