import { expect, type Page } from "@playwright/test";

/**
 * Drive the `/payouts/new` wizard from step 1 (Category) through to
 * step 4 (Funds) with minimal valid input — what live-stack specs
 * targeting the deposit / settle surfaces typically need before
 * they can assert anything meaningful.
 *
 * Stays read-side: the driver doesn't click the Deposit / Sign
 * buttons. Specs that need to exercise those add their own assertions
 * on top of the post-condition (page is on step 4 with a recipient
 * row + a far-future claim time loaded). The flow has no folder-
 * picking dependency for steps 1-4 — only step 5 (Sign) needs a
 * notes folder, which the file-system-access dialog can't be driven
 * from Playwright without a heavier stub.
 *
 * Step blocks (from `apps/pay/app/payouts/new/page.tsx:1875`):
 *  - 1 → 2: none (category selection auto-advances label/token defaults)
 *  - 2 → 3: none (defaults pre-filled by category)
 *  - 3 → 4: needs ≥1 recipient row + claimFrom set + buffer passed
 *           + no CSV validation errors
 *  - 4 → 5: needs relayer pick + covered sourcePick — out of scope here
 */

export interface DriveOptions {
  /** Category id to pick on step 1. Defaults to "Payroll" — its
   *  fixture is the simplest (no reason/proposal field on step 3). */
  category?: "Payroll" | "Grants" | "Bonus" | "Contractor";
  /** Recipient address that receives the test amount. Defaults to
   *  anvil #1 — has tokens already, won't clash with the verified
   *  test wallet (anvil #5). */
  recipientAddress?: string;
  /** Amount in the wizard's selected token, as a decimal string.
   *  Defaults to "1" (enough to trigger a real shortfall on a fresh
   *  vault so step 4's DepositButton lights up). */
  amount?: string;
  /** Recipient label / id (the wizard's `identifierLabel` field —
   *  "Employee" for Payroll, "Recipient" for Grants, etc.). The
   *  driver doesn't care what's there, only that the column exists. */
  recipientLabel?: string;
}

const ANVIL_ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Returns an ISO-flavoured `datetime-local` string ~10 minutes from
 *  now — comfortably above the wizard's `CLAIM_FROM_BUFFER_MINUTES`
 *  (1 minute) so spec walltime can't push the value into the past
 *  mid-run, but not so far ahead that it reads like a production
 *  schedule. */
function bufferedClaimFrom(): string {
  const t = new Date(Date.now() + 10 * 60_000);
  // datetime-local expects `YYYY-MM-DDTHH:mm:ss` in the browser's
  // local timezone. Node and the headless Chromium share that tz,
  // so a manual format from local components avoids the
  // toISOString UTC offset that would land back in the past after
  // the input's timezone shift on the wizard's `min` check.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T` +
    `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
  );
}

export async function driveWizardToStep4(
  page: Page,
  opts: DriveOptions = {},
): Promise<void> {
  const category = opts.category ?? "Payroll";
  const recipientAddress = opts.recipientAddress ?? ANVIL_ACCOUNT_1;
  const amount = opts.amount ?? "1";
  const recipientLabel = opts.recipientLabel ?? "alice";

  // Step 1 — pick category. The category buttons render their name
  // alongside tagline + body, so `exact: false` substring-matches on
  // the accessible name rather than requiring the full DOM text.
  // `.first()` disambiguates if the category name appears elsewhere
  // (e.g. inside the wizard's prefill label).
  await page.getByRole("button", { name: category, exact: false }).first().click();
  await page.getByRole("button", { name: /^Next/ }).click();

  // Step 2 — Token / label panel. Defaults are pre-filled by the
  // category, so just advance.
  await expect(page.getByRole("heading", { name: /^Token$/i })).toBeVisible();
  await page.getByRole("button", { name: /^Next/ }).click();

  // Step 3 — Recipients. The CSV textarea is the canonical input
  // path (an alternative spreadsheet view exists; the driver sticks
  // with CSV because it's a single fill+blur). Format follows the
  // hint line above the textarea: `<identifier>,<address>,<amount>`.
  //
  // The textarea's placeholder embeds the category's identifier
  // label (`employee` for Payroll, `recipient` for Grants, etc.)
  // followed by `,address,amount` — anchor on that suffix so the
  // selector survives a category swap without coupling to the
  // current category's exact identifier word.
  await expect(page.getByRole("heading", { name: /^Recipients$/i })).toBeVisible();
  await page.getByPlaceholder(/,address,amount/i).fill(`${recipientLabel},${recipientAddress},${amount}`);

  // Claim schedule — `datetime-local` input. Set the value via JS
  // evaluate instead of Playwright's `.fill()` — `.fill()` validates
  // against the input's `step={1}` attribute and rejects
  // intermittently with "Malformed value" depending on how it
  // resolves second-precision formats. Setting `.value` directly +
  // dispatching `input`/`change` sidesteps that validator while
  // still triggering the React onChange handler the wizard relies on.
  const claimFromValue = bufferedClaimFrom();
  await page
    .locator('input[type="datetime-local"]')
    .first()
    .evaluate((el, value) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      // If the platform ever drops the prototype's value setter we
      // want the spec to fail loud here with a useful message — not
      // silently no-op and then time out later on a still-disabled
      // Next button. (Gemini PR #732 review.)
      if (!setter) {
        throw new Error("HTMLInputElement.prototype.value setter not found");
      }
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, claimFromValue);

  // Advance to step 4. The Next button stays disabled until both
  // recipient + claimFrom are valid, so Playwright's auto-retry on
  // .click() naturally waits for the gate to lift.
  await page.getByRole("button", { name: /^Next/ }).click();

  // Post-condition: the Funds panel mounted. Anchor by its heading.
  await expect(page.getByRole("heading", { name: /^Funds$/i })).toBeVisible();
}
