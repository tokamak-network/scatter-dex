import { expect, test } from "@playwright/test";
import { ANVIL_DEFAULT, installTestWallet } from "./_helpers/test-wallet";

/**
 * Smoke for the test-wallet bridge. With `installTestWallet` set up
 * before navigation, Pay's `useWallet` finds an account on
 * `eth_accounts` immediately and renders the connected pill in the
 * header without any user interaction.
 *
 * This is the foundation other wallet-driven specs will build on.
 * Signing-side methods (`eth_sendTransaction`, `personal_sign`,
 * etc.) intentionally throw in this iteration — see the helper for
 * the follow-up that adds them.
 */
test.describe("Wallet bridge", () => {
  test("page boots into the connected state with no manual click", async ({ page }) => {
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
    });

    await page.goto("/dashboard");

    // Pay's connect pill renders the short address as
    // `0xPREFIX…SUFFIX`; anchor on the account-specific prefix /
    // suffix so the assertion fails if the page falls back to the
    // disconnected `Connect wallet` button.
    const account = ANVIL_DEFAULT.account.toLowerCase();
    const prefix = account.slice(0, 6); // "0xf39f"
    const suffix = account.slice(-4);   // "2266"
    await expect(
      page.getByText(new RegExp(`${prefix}.*${suffix}`, "i")).first(),
    ).toBeVisible();

    // Negative assertion — the disconnected `Connect wallet` button
    // must NOT be visible. Without this, a page that rendered both
    // states (e.g. a buggy hydration that flickered through the
    // disconnected path before the bridge bound) would still pass
    // the positive assertion above.
    await expect(
      page.getByRole("button", { name: /^Connect wallet$/i }),
    ).not.toBeVisible();
  });

  test("signing methods throw a recognisable error", async ({ page }) => {
    // Lock the contract: tests that need signing get a clear error
    // pointing at the helper they should extend, instead of an
    // opaque RPC failure that buries the diagnostic.
    await installTestWallet(page, {
      account: ANVIL_DEFAULT.account,
      chainId: ANVIL_DEFAULT.chainId,
    });
    await page.goto("/");

    const err = await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
      try {
        await eth.request({ method: "personal_sign", params: ["0xdead", "0x0"] });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toContain("signing follow-up");
  });
});
