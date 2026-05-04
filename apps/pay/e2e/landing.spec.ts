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

    // The call-to-action that gates the full app — if it disappears,
    // the dashboard route is unreachable from the landing.
    const cta = page.getByRole("link", { name: /Start a payout|Open dashboard|Dashboard/i });
    await expect(cta.first()).toBeVisible();
  });

  test("dashboard route mounts without a wallet", async ({ page }) => {
    // Regression smoke for the wallet-less render path — a wallet
    // throw at module load would surface as an unhandled promise
    // rejection here. Workspace bar should always render.
    await page.goto("/dashboard");
    await expect(page.getByText(/Workspace|Notes folder|Connect/i).first()).toBeVisible();
  });
});
