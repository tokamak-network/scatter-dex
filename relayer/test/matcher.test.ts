import { describe, it, expect, beforeEach } from "vitest";
import { Orderbook } from "../src/core/orderbook.js";
import { Matcher } from "../src/core/matcher.js";
import { SignedOrder, Order } from "../src/types/order.js";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    maker: "0x1111111111111111111111111111111111111111",
    sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    sellAmount: 10n * 10n ** 18n,
    buyAmount: 21000n * 10n ** 18n,
    maxFee: 30n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    nonce: 1n,
    claims: [
      {
        claimHash: "0x" + "ab".repeat(32),
        amount: 21000n * 10n ** 18n,
        releaseDelay: 3600n,
      },
    ],
    ...overrides,
  };
}

function makeSigned(overrides: Partial<Order> = {}): SignedOrder {
  return {
    order: makeOrder(overrides),
    signature: "0x" + "00".repeat(65),
  };
}

describe("Matcher", () => {
  let book: Orderbook;
  let matcher: Matcher;

  beforeEach(() => {
    book = new Orderbook();
    matcher = new Matcher(book);
  });

  it("matches compatible orders", () => {
    // Alice sells 10 TKA for 21000 TKB
    const alice = book.add(
      makeSigned({
        maker: "0x1111111111111111111111111111111111111111",
        sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        nonce: 1n,
        claims: [{
          claimHash: "0x" + "aa".repeat(32),
          amount: 21000n * 10n ** 18n,
          releaseDelay: 3600n,
        }],
      })
    );

    // Bob sells 21000 TKB for 10 TKA (exact match)
    book.add(
      makeSigned({
        maker: "0x2222222222222222222222222222222222222222",
        sellToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        buyToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sellAmount: 21000n * 10n ** 18n,
        buyAmount: 10n * 10n ** 18n,
        nonce: 1n,
        claims: [{
          claimHash: "0x" + "bb".repeat(32),
          amount: 10n * 10n ** 18n,
          releaseDelay: 3600n,
        }],
      })
    );

    const match = matcher.findMatch(alice);
    expect(match).not.toBeNull();
    expect(match!.maker.order.maker.toLowerCase()).toBe(
      "0x1111111111111111111111111111111111111111"
    );
    expect(match!.taker.order.maker.toLowerCase()).toBe(
      "0x2222222222222222222222222222222222222222"
    );
  });

  it("does not match incompatible prices", () => {
    // Alice sells 10 TKA for 21000 TKB
    const alice = book.add(
      makeSigned({
        maker: "0x1111111111111111111111111111111111111111",
        sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        nonce: 1n,
      })
    );

    // Bob only offers 15000 TKB for 10 TKA (too low)
    book.add(
      makeSigned({
        maker: "0x2222222222222222222222222222222222222222",
        sellToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        buyToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sellAmount: 15000n * 10n ** 18n,
        buyAmount: 10n * 10n ** 18n,
        nonce: 1n,
      })
    );

    const match = matcher.findMatch(alice);
    expect(match).toBeNull();
  });

  it("does not match same maker", () => {
    const alice = book.add(
      makeSigned({
        maker: "0x1111111111111111111111111111111111111111",
        sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        sellAmount: 10n * 10n ** 18n,
        buyAmount: 21000n * 10n ** 18n,
        nonce: 1n,
      })
    );

    // Same maker on opposite side
    book.add(
      makeSigned({
        maker: "0x1111111111111111111111111111111111111111",
        sellToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        buyToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sellAmount: 21000n * 10n ** 18n,
        buyAmount: 10n * 10n ** 18n,
        nonce: 2n,
      })
    );

    const match = matcher.findMatch(alice);
    expect(match).toBeNull();
  });
});
