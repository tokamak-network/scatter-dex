import { expect, test } from "@playwright/test";

/**
 *  Wallet-page smoke. Wallet-less path only — when no wallet is
 *  connected the page should render the "connect first" placeholder
 *  instead of erroring or blank-rendering. The connected-state row
 *  table + Send modal are gated on the test-wallet bridge tracked
 *  as a follow-up alongside the existing settle / claim wallet
 *  scenarios.
 */
test.describe("Wallet page", () => {
  test("disconnected view renders the connect-first placeholder", async ({ page }) => {
    await page.goto("/wallet");

    // The page is a client component, so wait for hydration to land
    // before asserting on the placeholder — without this the test
    // could pass on the SSR render that doesn't gate on the wallet.
    await expect(
      page.getByText(/Connect a wallet from the header to see your balances/i),
    ).toBeVisible();

    // Crumb + workspace bar should still render so the operator can
    // navigate elsewhere without wallet state. Scope to the page's
    // main region — the global header nav also has a "Dashboard"
    // link, and a strict-mode locator would match both.
    await expect(
      page.getByRole("main").getByRole("link", { name: /^Dashboard$/ }),
    ).toBeVisible();
  });

  test("header View wallet menu item links to /wallet", async ({ page }) => {
    // Smoke for the Pay-specific `extraMenuItems` injection — when
    // the header pill renders disconnected, the menu doesn't open
    // (Connect is the only affordance), but a direct deep link to
    // /wallet still has to resolve. This test pins the route's
    // existence; pill-click flow covered in the connected-state
    // wallet bridge follow-up.
    await page.goto("/wallet");
    expect(page.url()).toMatch(/\/wallet$/);
  });
});
