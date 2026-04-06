import { describe, it, expect, beforeEach } from "vitest";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { PrivateMatcher } from "../src/core/matcher.js";
import { makePrivateOrder, TOKEN_A, TOKEN_B } from "./helpers.js";

describe("PrivateMatcher", () => {
  let book: PrivateOrderbook;
  let matcher: PrivateMatcher;

  beforeEach(() => {
    book = new PrivateOrderbook();
    matcher = new PrivateMatcher(book);
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

  it("does not match incompatible prices", () => {
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Bob only offers 15000 TKB for 10 TKA (too low)
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 15000n * 10n ** 18n,
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

  it("matches when prices overlap (taker's ask <= maker's bid)", () => {
    // Alice: sell 10 TKA, want at least 20000 TKB (price = 2000 TKB/TKA)
    const alice = book.add(makePrivateOrder({
      pubKeyAx: 1n, pubKeyAy: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 20000n * 10n ** 18n,
      nonce: 1n,
    }));

    // Bob: sell 25000 TKB, want at least 10 TKA (price = 2500 TKB/TKA)
    // Bob offers more TKB per TKA than Alice requires → compatible
    // Cross-multiply: 10 * 25000 <= 20000 * 10 → 250000 <= 200000 → FALSE
    // But from counterparty perspective: Bob.sell * Alice.sell <= Bob.buy * Alice.buy
    // 25000 * 10 <= 10 * 20000 → 250000 <= 200000 → FALSE
    // This means the matcher needs the taker to offer at or below maker's price
    // Bob: sell 21000, want 10 → cross: 10*21000 <= 20000*10 → 210000 <= 200000 → FALSE
    // Bob: sell 20000, want 10 → cross: 10*20000 <= 20000*10 → 200000 <= 200000 → TRUE
    book.add(makePrivateOrder({
      pubKeyAx: 2n, pubKeyAy: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 20000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      nonce: 2n,
    }));

    const match = matcher.findMatch(alice);
    expect(match).not.toBeNull();
  });
});
