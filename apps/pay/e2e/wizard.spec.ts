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

    // The Stepper renders each label as a `<button>` numbered
    // `1 Template` … `5 Review & sign`. Anchor by role on both
    // endpoints so the assertion covers the two ends of the stepper
    // — a generic `getByText(/Template/i)` matches the step-1
    // heading too and would stay green even if the Stepper itself
    // failed to render.
    await expect(
      page.getByRole("button", { name: /1\s*Template/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /5\s*Review & sign/i }),
    ).toBeVisible();
  });
});
