import { expect, test } from "@playwright/test";

test.describe("Landing page", () => {
  test("renders hero + key calls-to-action", async ({ page }) => {
    await page.goto("/");

    // Hero copy is the single most stable identifier the marketing
    // page commits to — anchor on it rather than a tag class so a
    // styling refactor doesn't break the smoke.
    await expect(
      page.getByRole("heading", { name: /Send payroll, grants, and bonuses/i }),
    ).toBeVisible();

    // Both hero CTAs — "Try a sample payout" routes into the wizard,
    // "See dashboard" into the dashboard. Anchor on both so a regression
    // that drops one but not the other is caught (a single-CTA assertion
    // would be satisfied by the always-present header `Dashboard` nav).
    await expect(
      page.getByRole("link", { name: /Try a sample payout/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /See dashboard/i }),
    ).toBeVisible();
  });

  test("dashboard route mounts without a wallet", async ({ page }) => {
    // Regression smoke for the wallet-less render path — a wallet
    // throw at module load would surface as an unhandled promise
    // rejection here. Anchor on the `Recent payouts` heading because
    // it's rendered only by the dashboard route's own component tree;
    // the previous `Workspace|Notes folder|Connect` selector matched
    // strings that survive a client-side crash in the dashboard
    // (header nav + workspace bar render in the layout shell).
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: /Recent payouts/i }),
    ).toBeVisible();
  });
});
