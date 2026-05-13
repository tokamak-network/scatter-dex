import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";

/**
 * Live-stack spec for `/identity` — Pay's zk-X509 verification
 * dashboard. The page reads the on-chain identity state via
 * `useIdentityStatus()` and renders one of several branches
 * (unverified / verified / expiring / expired / error). This spec
 * covers the verified branch end-to-end against a live anvil:
 * `verifyTestWallet` flips the on-chain flag, the page polls + the
 * hooks resolve to `state.kind === "verified"`, and the "✓ Verified"
 * status line + "Refresh status" CTA render.
 *
 * What this catches: a regression in the identity-status hook's
 * provider read (would surface as a stuck "loading" state), a UI
 * branch swap that hid the verified copy behind a misnamed kind,
 * or a registry-listing regression that broke the "Trusted
 * authorities" panel.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — /identity route", () => {
  test("verified wallet sees ✓ Verified status + Refresh status CTA", async ({ page }) => {
    await verifyTestWallet({
      account: ANVIL_VERIFIED_TEST.account,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await installTestWallet(page, {
      ...ANVIL_VERIFIED_TEST,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/identity");

    // Page heading renders — confirms route entered the connected
    // branch (not a wallet-gated fallback).
    await expect(
      page.getByRole("heading", { name: /^Identity$/i }),
    ).toBeVisible();

    // The connected wallet address is surfaced in the "Your status"
    // panel (page.tsx:118-119). Sanity check that the page actually
    // bound to the installed account.
    await expect(
      page.getByText(ANVIL_VERIFIED_TEST.account),
    ).toBeVisible();

    // The "✓ Verified" status copy fires only for `state.kind ===
    // "verified"` (page.tsx:257). 10s timeout covers the
    // useIdentityStatus polling delay on first load — the hook
    // fires an on-chain read against the IdentityGate before
    // resolving its initial state.
    await expect(
      page.getByText(/✓ Verified/),
    ).toBeVisible({ timeout: 10_000 });

    // "Refresh status" CTA renders on every kind; absence here
    // would mean the section template itself broke.
    await expect(
      page.getByRole("button", { name: "Refresh status", exact: false }),
    ).toBeVisible();

    // The "Trusted authorities" panel renders the IdentityGate
    // registries the page admin-reads. Asserting on its heading
    // catches a regression in `useIdentityGateAdmin` that broke
    // the registry listing.
    await expect(
      page.getByRole("heading", { name: /^Trusted authorities$/i }),
    ).toBeVisible();
  });
});
