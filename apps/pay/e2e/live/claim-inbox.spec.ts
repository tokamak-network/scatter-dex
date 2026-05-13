import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";

/**
 * Live-stack smoke for the claims `/inbox` route. Two states the
 * page can show:
 *   - Folder not picked: a banner asking the user to pick a working
 *     folder. This is the state a Playwright spec naturally lands
 *     on, because the File System Access dialog the dashboard's
 *     "Pick folder" button opens can't be driven by Playwright.
 *   - Folder picked + empty: the textarea for pasting a claim link
 *     + the "No saved claims yet" empty-list copy.
 *
 * This spec covers the no-folder state only — that's all a stock
 * Playwright run can reach today. The folder-ready empty-list copy,
 * the paste-an-invalid-link parse-error surface, and a successful
 * claim entry parse all land in a follow-up that ships a Playwright
 * folder-picker stub (out of scope for this PR).
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — /inbox claim route", () => {
  test("no-folder inbox shows the folder-pick banner with the connected wallet", async ({ page }) => {
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
    await page.goto("/inbox");

    // The folder-required panel is the page's no-folder fallback —
    // copy lives at apps/pay/app/inbox/page.tsx:110-114. Catches a
    // regression where the inbox tries to render the list (and
    // crashes on `loadClaimInbox()`) before the folder is ready.
    await expect(
      page.getByText(/Pick a working folder first/i),
    ).toBeVisible();

    // Page heading still renders even without a folder — proves the
    // route didn't fall into an error boundary.
    await expect(
      page.getByRole("heading", { name: /^Inbox$/i }),
    ).toBeVisible();

    // Top nav still hydrates with the connected address (sanity
    // check that wallet bridge survives a /inbox load).
    const account = ANVIL_VERIFIED_TEST.account.toLowerCase();
    const prefix = account.slice(0, 6);
    const suffix = account.slice(-4);
    await expect(
      page.getByText(new RegExp(`${prefix}.*${suffix}`, "i")).first(),
    ).toBeVisible();
  });
});
