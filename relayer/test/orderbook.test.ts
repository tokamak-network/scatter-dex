import { describe, it, expect, beforeEach } from "vitest";
import { Orderbook } from "../src/core/orderbook.js";
import { SignedOrder, Order, pairKey } from "../src/types/order.js";

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

describe("Orderbook", () => {
  let book: Orderbook;

  beforeEach(() => {
    book = new Orderbook();
  });

  it("adds an order", () => {
    const stored = book.add(makeSigned());
    expect(stored.status).toBe("pending");
    expect(book.getOrderCount()).toBe(1);
  });

  it("rejects duplicate nonce from same maker", () => {
    book.add(makeSigned({ nonce: 1n }));
    expect(() => book.add(makeSigned({ nonce: 1n }))).toThrow("duplicate nonce");
  });

  it("allows same nonce from different maker", () => {
    book.add(makeSigned({ nonce: 1n }));
    book.add(
      makeSigned({
        nonce: 1n,
        maker: "0x2222222222222222222222222222222222222222",
      })
    );
    expect(book.getOrderCount()).toBe(2);
  });

  it("cancels an order", () => {
    book.add(makeSigned({ nonce: 5n }));
    const cancelled = book.cancel(
      "0x1111111111111111111111111111111111111111",
      5n
    );
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
    expect(book.getOrderCount()).toBe(0);
  });

  it("returns null when cancelling non-existent order", () => {
    const result = book.cancel("0x1111111111111111111111111111111111111111", 99n);
    expect(result).toBeNull();
  });

  it("gets orders by maker", () => {
    book.add(makeSigned({ nonce: 1n }));
    book.add(makeSigned({ nonce: 2n }));
    const orders = book.getOrdersByMaker(
      "0x1111111111111111111111111111111111111111"
    );
    expect(orders.length).toBe(2);
  });

  it("sorts sell orders by price ascending", () => {
    // Cheaper seller first (lower sellAmount/buyAmount ratio)
    book.add(makeSigned({ nonce: 1n, sellAmount: 10n * 10n ** 18n, buyAmount: 21000n * 10n ** 18n }));
    book.add(makeSigned({
      nonce: 2n,
      maker: "0x2222222222222222222222222222222222222222",
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 22000n * 10n ** 18n,
    }));

    const pair = pairKey(
      "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    );
    const sells = book.getSellOrders(pair);
    expect(sells.length).toBe(2);
    // Second order has lower price (sells 10 for 22000 vs 21000)
    expect(sells[0].order.buyAmount).toBe(22000n * 10n ** 18n);
  });

  it("purges expired orders", () => {
    book.add(
      makeSigned({
        nonce: 1n,
        expiry: BigInt(Math.floor(Date.now() / 1000) - 1), // already expired
      })
    );
    book.add(
      makeSigned({
        nonce: 2n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), // valid
      })
    );

    const removed = book.purgeExpired();
    expect(removed).toBe(1);
    expect(book.getOrderCount()).toBe(1);
  });
});
