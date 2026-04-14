import { describe, it, expect, beforeEach } from "vitest";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { PrivateMatcher } from "../src/core/matcher.js";
import { makePrivateOrder, resetNonceCounter, TOKEN_A, TOKEN_B } from "./helpers.js";

describe("PrivateMatcher", () => {
  let book: PrivateOrderbook;
  let matcher: PrivateMatcher;

  beforeEach(() => {
    book = new PrivateOrderbook();
    matcher = new PrivateMatcher(book);
    resetNonceCounter();
  });

  it("matches compatible orders", () => {
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    const match = matcher.findMatch(alice);
    expect(match).not.toBeNull();
    expect(match!.maker.order.pubKeyAx).toBe(1n);
    expect(match!.taker.order.pubKeyAx).toBe(2n);
  });

  it("does not match incompatible prices (amount sufficient but price too low)", () => {
    // Alice: sell 10 TKA, want 21000 TKB (price = 2100 TKB/TKA)
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Bob offers only 19000 TKB for 10 TKA (price = 1900 TKB/TKA — below Alice's 2100)
    // Price: 10 * 19000 >= 21000 * 10 → 190000 >= 210000 → FALSE (price too low)
    // Amount: 19000 < 21000 → also fails (insufficient amount)
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 19000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    expect(matcher.findMatch(alice)).toBeNull();
  });

  it("does not match same pubkey (self-trade)", () => {
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n, // same key
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    expect(matcher.findMatch(alice)).toBeNull();
  });

  it("does not match expired orders", () => {
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
      expiry: BigInt(Math.floor(Date.now() / 1000) - 1), // already expired
    }));

    expect(matcher.findMatch(alice)).toBeNull();
  });

  it("does not match wrong token pair", () => {
    const TOKEN_C = BigInt("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");

    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_C, buyToken: TOKEN_A,
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    expect(matcher.findMatch(alice)).toBeNull();
  });

  it("matches at exact price boundary", () => {
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 20000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Exact match: 10 * 20000 >= 20000 * 10 → TRUE
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 20000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    const match = matcher.findMatch(alice);
    expect(match).not.toBeNull();
    expect(match!.maker.order.pubKeyAx).toBe(1n);
    expect(match!.taker.order.pubKeyAx).toBe(2n);
  });

  it("matches when taker offers better price", () => {
    // Alice: sell 10 TKA, want 20000 TKB (price = 2000 TKB/TKA)
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 20000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Bob: sell 25000 TKB, want 10 TKA (price = 2500 TKB/TKA — better for Alice)
    // 10 * 25000 >= 20000 * 10 → 250000 >= 200000 → TRUE
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 25000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    const match = matcher.findMatch(alice);
    expect(match).not.toBeNull();
  });

  // ── Fee-aware matching ─────────────────────────────────────────
  //
  // Guards against the bug where the matcher used the bare amount
  // check `taker.sellAmount >= maker.buyAmount`, which let 1:1 matches
  // through that then reverted at settle with ClaimsCapExceeded
  // (settle.circom §8c: totalLockedMaker + feeTokenMaker ≤ takerSell,
  // and feeTokenMaker can be up to takerSell × taker.maxFee / 10000).
  // Under the [2026-04-14 fee-semantics redesign] each side's fee is
  // drawn from their *own* receive (totalLocked ≥ buyAmount − feeToken),
  // so the matcher reduces to `counterpartySell ≥ buyAmount`. The fee
  // no longer requires the taker to oversell.
  describe("fee-aware amount check", () => {
    it("matches 1:1 amounts even when maxFee > 0 (fee comes from receive side)", () => {
      const maker = book.add(makePrivateOrder({
        pubKeyAx: 1n, pubKeyAy: 1n,
        sellToken: TOKEN_A, buyToken: TOKEN_B,
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        maxFee: 30n,
        nonce: 1n,
      }));
      book.add(makePrivateOrder({
        pubKeyAx: 2n, pubKeyAy: 2n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 21000n * 10n ** 18n,
        buyAmount: 10n * 10n ** 18n,
        maxFee: 30n,
        nonce: 2n,
      }));
      expect(matcher.findMatch(maker)).not.toBeNull();
    });

    it("rejects when taker.sellAmount is below maker.buyAmount", () => {
      // Worst-case headroom is no longer required, but a literal price
      // shortfall must still be rejected.
      const maker = book.add(makePrivateOrder({
        pubKeyAx: 1n, pubKeyAy: 1n,
        sellToken: TOKEN_A, buyToken: TOKEN_B,
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        maxFee: 30n,
        nonce: 1n,
      }));
      book.add(makePrivateOrder({
        pubKeyAx: 2n, pubKeyAy: 2n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 20999n * 10n ** 18n,  // 1 short
        buyAmount: 10n * 10n ** 18n,
        maxFee: 30n,
        nonce: 2n,
      }));
      expect(matcher.findMatch(maker)).toBeNull();
    });

    it("matches 1:1 when maxFee is 0 on both sides", () => {
      const maker = book.add(makePrivateOrder({
        pubKeyAx: 1n, pubKeyAy: 1n,
        sellToken: TOKEN_A, buyToken: TOKEN_B,
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        maxFee: 0n,
        nonce: 1n,
      }));
      book.add(makePrivateOrder({
        pubKeyAx: 2n, pubKeyAy: 2n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 21000n * 10n ** 18n,
        buyAmount: 10n * 10n ** 18n,
        maxFee: 0n,
        nonce: 2n,
      }));
      expect(matcher.findMatch(maker)).not.toBeNull();
    });
  });
});
