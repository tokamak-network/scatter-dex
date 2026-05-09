import { expect, test } from "@playwright/test";

/** Wallet-page smoke. Wallet-less path only — when no wallet is
 *  connected the page should render the connect-first placeholder
 *  instead of erroring or blank-rendering. The connected-state row
 *  table + Send modal coverage is gated on the test-wallet bridge
 *  tracked as a follow-up alongside the existing settle / claim
 *  wallet scenarios. */
test.describe("Wallet page", () => {
  test("disconnected view renders the connect-first placeholder", async ({ page }) => {
    // Capture the navigation response so a 404 (broken route) fails
    // the test instead of being masked when the error page chrome
    // happens to also show "Connect" text.
    const response = await page.goto("/wallet");
    expect(response?.ok()).toBeTruthy();

    // Web-first `toHaveURL` auto-retries past hydration / client-side
    // redirects; a sync `page.url()` snapshot would flake on slow
    // first paint.
    await expect(page).toHaveURL(/\/wallet$/);

    await expect(
      page.getByText(/Connect a wallet from the header to see your balances/i),
    ).toBeVisible();

    // Scope the crumb assertion to the page's main region — the
    // global header nav also exposes "Dashboard" and a top-level
    // strict-mode locator would match both.
    await expect(
      page.getByRole("main").getByRole("link", { name: /^Dashboard$/ }),
    ).toBeVisible();
  });
});
