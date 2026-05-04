import { expect, test } from "@playwright/test";

/**
 * Wallet-less smoke for the wizard's first screen. The full settle
 * flow needs a connected wallet + workspace folder + relayer; that
 * work is gated on a test-wallet bridge follow-up. This spec only
 * confirms the wizard mounts and the static template chooser is
 * present so a regression in `payouts/new/page.tsx`'s top-level
 * render fails CI loudly.
 */
test.describe("Payout wizard — entry screen", () => {
  test("renders without a wallet", async ({ page }) => {
    await page.goto("/payouts/new");

    // Step 1 picks a template (payroll / grants / bonus / contractor).
    // The first option's heading copy is the most stable anchor.
    const templateCard = page
      .getByRole("button", { name: /Payroll|Grants|Bonus|Contractor/i })
      .first();
    await expect(templateCard).toBeVisible();

    // The Stepper renders all five stage labels (`STEPPER_LABELS`) —
    // an early render error would drop the whole header. Anchor on
    // "Template" + "Review & sign" so the assertion covers the two
    // ends of the stepper, not just one button that happens to be
    // visible during a partial render.
    await expect(page.getByText(/Template/i).first()).toBeVisible();
    await expect(page.getByText(/Review & sign/i).first()).toBeVisible();
  });
});
