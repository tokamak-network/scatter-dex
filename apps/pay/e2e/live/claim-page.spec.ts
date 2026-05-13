import { expect, test } from "../_helpers/live-test";
import { ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
import { DEV_STACK_ENDPOINTS } from "../_helpers/stack";
import { verifyTestWallet } from "../_helpers/verify-wallet";
import { buildClaimUrlFragment } from "../_helpers/claim-package";

/**
 * Live-stack smokes for `/claim`. Two surfaces the page can show
 * without a valid claim package in the URL fragment:
 *
 *   - No `#fragment` present at all → "Open the original message
 *     you received…" warning (apps/pay/app/claim/page.tsx:303-307).
 *   - Fragment present but malformed → "Could not read this claim
 *     link: <err>" surfacing the decodeClaimPackage failure
 *     (page.tsx:257-260).
 *
 * Catches: route-crash regressions on the bad-input paths, and any
 * silent change to the URL contract that would otherwise let a
 * recipient hit /claim and see a blank page.
 *
 * The success path (valid package → claim button → on-chain tx)
 * needs a settled claims group on anvil first, which means either
 * a live wizard settle (folder picker + sign popup, currently
 * unautomatable) or a helper that calls `scatterDirect` with a
 * real authorize proof. Both land in follow-ups; this spec stays on
 * the read-side surface.
 *
 * Boot: `bash ./scripts/start-e2e-env.sh`. Skips otherwise.
 */
test.describe("Live stack — /claim route", () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test("missing claim fragment shows the 'open the original message' warning", async ({ page }) => {
    // Hit /claim without an `id` or a `#` fragment — the page
    // renders its `parsed === null` branch.
    await page.goto("/claim");

    await expect(
      page.getByText(/Open the original message you received/i),
    ).toBeVisible();
  });

  test("malformed claim fragment surfaces a decode error", async ({ page }) => {
    // `not-a-valid-package` is base64url-safe but doesn't decode
    // into a v1 ClaimPackage, so decodeClaimPackage throws and
    // page.tsx routes into the `parseError` branch.
    await page.goto("/claim?id=test#not-a-valid-package");

    await expect(
      page.getByText(/Could not read this claim link/i),
    ).toBeVisible();
  });

  test("valid claim fragment renders the recipient + amount header without a parse error", async ({ page }) => {
    // Build a structurally-valid v1 ClaimPackage recipient'd to the
    // installed test wallet. The fragment passes `isClaimPackage`,
    // so the page enters its happy-path render even though the
    // claimsRoot doesn't match an on-chain settled group. The page's
    // alreadyClaimed probe will eventually resolve to undefined /
    // false against the missing group — that's downstream of these
    // assertions which fire on the pre-probe header.
    const { href } = buildClaimUrlFragment({
      recipient: ANVIL_VERIFIED_TEST.account,
    });
    await page.goto(href);

    // Page renders the amount + token symbol header. The "1 USDC"
    // copy is constructed from pkg.amount + pkg.tokenSymbol + pkg.
    // tokenDecimals — its appearance confirms decodeClaimPackage
    // succeeded and the page is in the parsed branch (not the
    // parseError fallback).
    await expect(
      page.getByText(/1.*USDC/i).first(),
    ).toBeVisible();

    // The recipient address renders in the "🔒 Funds can only go
    // to <addr>" lock banner (claim/page.tsx:290-296). Asserting
    // on the full address (case-insensitive — the page renders the
    // checksummed mixed-case form) confirms the page actually
    // read pkg.recipient out of the decoded fragment, not just
    // that decode succeeded.
    await expect(
      page.getByText(new RegExp(ANVIL_VERIFIED_TEST.account, "i")).first(),
    ).toBeVisible();

    // The `parseError` banner from the earlier test must NOT be
    // present — a regression that broke decodeClaimPackage's happy
    // path would flip this assertion immediately.
    await expect(
      page.getByText(/Could not read this claim link/i),
    ).not.toBeVisible();

    // No "open the original message" warning either — that branch
    // only fires when `parsed === null`, which would mean the
    // fragment was empty.
    await expect(
      page.getByText(/Open the original message you received/i),
    ).not.toBeVisible();
  });
});
