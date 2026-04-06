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

    // Bob: sell 21000 TKB, want 11 TKA (price = 1909 TKB/TKA — worse than Alice's 2100)
    // Amount sufficient (21000 >= 21000, 10 >= 11 fails → also caught by amount check)
    // Price: 10 * 21000 <= 21000 * 11 → 210000 <= 231000 → TRUE (price ok)
    // But amount: alice.sell(10) < bob.buy(11) → fails
    // To isolate price: Bob wants 10 TKA but offers only 19000 TKB
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 19000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));
    // Price: 10 * 19000 <= 21000 * 10 → 190000 <= 210000 → TRUE
    // Amount: 19000 < 21000 → fails (Alice wants 21000 but Bob only offers 19000)

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
    // Alice: sell 10 TKA, want 20000 TKB
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 20000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Bob: sell 20000 TKB, want 10 TKA (exact match)
    // Cross-multiply: 10 * 20000 <= 20000 * 10 → 200000 <= 200000 → TRUE
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
});
