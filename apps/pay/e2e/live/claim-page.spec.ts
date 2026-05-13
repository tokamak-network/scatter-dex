import { expect, test } from "../_helpers/live-test";
import { ANVIL_DEFAULT, ANVIL_VERIFIED_TEST, installTestWallet } from "../_helpers/test-wallet";
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

  test("recipient-mismatch fragment surfaces the 'switch wallets' banner", async ({ page }) => {
    // Build a claim package bound to anvil #0 (ANVIL_DEFAULT) but
    // install anvil #5 (ANVIL_VERIFIED_TEST) as the connected
    // wallet. The /claim page's `wrongRecipient` branch
    // (page.tsx:421-425) renders a warning naming the package's
    // recipient. Catches: a regression that silently let any
    // wallet submit a claim — the wallet/recipient binding is
    // load-bearing for the per-claim secret model.
    const { href } = buildClaimUrlFragment({
      recipient: ANVIL_DEFAULT.account,
    });
    await page.goto(href);

    await expect(
      page.getByText(/switch wallets to claim/i),
    ).toBeVisible();
  });

  test("future releaseTime renders the ⏳ Locked-until copy", async ({ page }) => {
    // Same fragment shape as the happy-path spec but releaseTime
    // ~1 hour in the future. Page's `isAvailable` branch
    // (page.tsx:319-322) flips from ✓ Available to ⏳ Available
    // from <stamp>. Catches: any regression that flipped the
    // comparison direction (would credit locked claims as
    // available, surfacing the claim button before the on-chain
    // releaseTime check would reject the tx).
    const ONE_HOUR_IN_SECONDS = 60 * 60;
    const future = Math.floor(Date.now() / 1000) + ONE_HOUR_IN_SECONDS;
    const { href } = buildClaimUrlFragment({
      recipient: ANVIL_VERIFIED_TEST.account,
      releaseTimeUnix: future,
    });
    await page.goto(href);

    await expect(
      page.getByText(/⏳ Available from/),
    ).toBeVisible();

    // The ✓ Available copy must NOT render — both branches share
    // the prefix `Available`, so explicit checkmark anchoring
    // catches a regression where the future timestamp slipped
    // into the available branch.
    await expect(
      page.getByText(/✓ Available to claim now/),
    ).not.toBeVisible();
  });

  test("wrong-chain fragment surfaces the 'Wrong Pay deployment' banner", async ({ page }) => {
    // Build a fragment with chainId = 1 (mainnet) while the Pay
    // build targets 31337 (anvil). The /claim page's wrongAppChain
    // branch (page.tsx:368-376) renders a terminal warning BEFORE
    // the wallet-connect prompt — protects recipients from being
    // sent through MetaMask only to be told to switch deployments
    // afterward. Catches: any regression that lets a cross-chain
    // link pass the gate (e.g. compare-by-string flip).
    const { href } = buildClaimUrlFragment({
      recipient: ANVIL_VERIFIED_TEST.account,
      chainId: 1,
    });
    await page.goto(href);

    await expect(
      page.getByText(/Wrong Pay deployment/i),
    ).toBeVisible();

    // The "targets chain N but the link is for chain M" explanation
    // — anchors on "chain 1" (the package's chainId). `\b` word
    // boundary prevents a false-positive match on "chain 10" /
    // "chain 137" if the page ever rendered the wrong value.
    await expect(
      page.getByText(/link is for chain 1\b/i),
    ).toBeVisible();

    // The banner is terminal — it bails BEFORE the wallet-connect
    // prompt (page.tsx:368-377 early-returns). Asserting the
    // Connect wallet button is absent locks in that early-return
    // contract; a regression that moved the chain check below
    // wallet-connect would surface here.
    await expect(
      page.getByRole("button", { name: "Connect wallet", exact: false }),
    ).not.toBeVisible();
  });
});
