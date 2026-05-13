import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";

/**
 * Live-stack smoke for `/address-book`. The page reads from
 * `zkscatter-wallets.json` in the user-picked notes folder; like
 * `/inbox`, the folder picker can't be driven by Playwright, so
 * the natural spec target is the no-folder state — `WorkspaceBar`
 * surfaces the "Pick folder" CTA, and the address-book content
 * stays gated behind `folder.ready`.
 *
 * What this catches: route-crash regressions on the address-book
 * page that would only surface for users without an active folder,
 * and any change to the WorkspaceBar's no-folder copy that breaks
 * the "Pick folder" affordance.
 */
test.describe("Live stack — /address-book route", () => {
  test("no-folder address book shows the heading + WorkspaceBar prompt", async ({ page }) => {
    await installTestWallet(page, {
      ...ANVIL_VERIFIED_TEST,
      rpcUrl: DEV_STACK_ENDPOINTS.rpcUrl,
    });
    await page.goto("/address-book");

    // Page heading renders even when the folder isn't picked —
    // proves the route didn't fall into an error boundary.
    await expect(
      page.getByRole("heading", { name: /^Address book$/i }),
    ).toBeVisible();

    // WorkspaceBar's "No notes folder selected" copy +
    // "Pick folder" CTA both render in the no-folder branch
    // (apps/pay/app/_components/WorkspaceBar.tsx:135-145).
    await expect(
      page.getByText(/No notes folder selected/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pick folder", exact: false }),
    ).toBeVisible();

    // The folder-gated content (search input + "Reading your
    // address book…" placeholder) all hide behind `folder.ready`
    // (page.tsx:85). Asserting BOTH are absent locks in the gate
    // — a regression that flipped it on the search-input side
    // wouldn't slip past a single placeholder assertion.
    await expect(
      page.getByText(/Reading your address book/i),
    ).not.toBeVisible();
    await expect(
      page.getByPlaceholder(/Search by name, address/i),
    ).not.toBeVisible();
  });
});
