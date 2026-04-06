import { describe, it, expect, beforeEach } from "vitest";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { pairKey } from "../src/types/order.js";
import { makePrivateOrder, resetNonceCounter, TOKEN_A, TOKEN_B } from "./helpers.js";

describe("PrivateOrderbook", () => {
  let book: PrivateOrderbook;

  beforeEach(() => {
    book = new PrivateOrderbook();
    resetNonceCounter();
  });

  it("adds and retrieves orders", () => {
    const order = makePrivateOrder({ pubKeyAx: 1n, nonce: 1n });
    book.add(order);
    expect(book.getOrderCount()).toBe(1);

    const orders = book.getOrdersByPubKey(1n);
    expect(orders).toHaveLength(1);
    expect(orders[0].order.nonce).toBe(1n);
  });

  it("rejects duplicate nonce", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    expect(() => book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }))).toThrow("duplicate nonce");
  });

  it("allows same nonce from different pubkeys", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, pubKeyAy: 1n, nonce: 1n }));
    book.add(makePrivateOrder({ pubKeyAx: 2n, pubKeyAy: 2n, nonce: 1n }));
    expect(book.getOrderCount()).toBe(2);
  });

  it("removes orders", () => {
    const order = makePrivateOrder({ pubKeyAx: 1n, nonce: 1n });
    book.add(order);
    expect(book.getOrderCount()).toBe(1);

    book.remove(order);
    expect(book.getOrderCount()).toBe(0);
  });

  it("cancels orders", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    const cancelled = book.cancel(1n, 1n);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
    expect(book.getOrderCount()).toBe(0);
  });

  it("returns null when cancelling non-existent order", () => {
    expect(book.cancel(999n, 999n)).toBeNull();
  });

  it("hasNonce detects existing orders", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 42n }));
    expect(book.hasNonce(1n, 42n)).toBe(true);
    expect(book.hasNonce(1n, 43n)).toBe(false);
  });

  it("purges expired orders", () => {
    book.add(makePrivateOrder({
      pubKeyAx: 1n, nonce: 1n,
      expiry: BigInt(Math.floor(Date.now() / 1000) - 1),
    }));
    book.add(makePrivateOrder({
      pubKeyAx: 2n, nonce: 2n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    }));

    const removed = book.purgeExpired();
    expect(removed).toBe(1);
    expect(book.getOrderCount()).toBe(1);
  });

  it("respects max size", () => {
    const small = new PrivateOrderbook(2);
    small.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    small.add(makePrivateOrder({ pubKeyAx: 2n, nonce: 2n }));
    expect(() => small.add(makePrivateOrder({ pubKeyAx: 3n, nonce: 3n }))).toThrow("orderbook full");
  });

  it("separates sell and buy sides", () => {
    // Sell side: sellToken < buyToken
    book.add(makePrivateOrder({
      pubKeyAx: 1n, nonce: 1n,
      sellToken: TOKEN_A, buyToken: TOKEN_B,
    }));
    // Buy side: sellToken > buyToken
    book.add(makePrivateOrder({
      pubKeyAx: 2n, nonce: 2n,
      sellToken: TOKEN_B, buyToken: TOKEN_A,
    }));

    const pair = pairKey(TOKEN_A, TOKEN_B);

    expect(book.getSellOrders(pair)).toHaveLength(1);
    expect(book.getBuyOrders(pair)).toHaveLength(1);
  });
});
