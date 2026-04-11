import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { makePrivateOrder, resetNonceCounter } from "./helpers.js";

describe("Admin API — cancelAll (orderbook drain)", () => {
  let book: PrivateOrderbook;

  beforeEach(() => {
    book = new PrivateOrderbook();
    resetNonceCounter();
  });

  it("cancels all pending orders and returns count", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    book.add(makePrivateOrder({ pubKeyAx: 2n, nonce: 2n }));
    book.add(makePrivateOrder({ pubKeyAx: 3n, nonce: 3n }));
    expect(book.getOrderCount()).toBe(3);

    const cancelled = book.cancelAll();
    expect(cancelled).toBe(3);
    expect(book.getOrderCount()).toBe(0);
  });

  it("returns 0 when no orders are pending", () => {
    expect(book.cancelAll()).toBe(0);
    expect(book.getOrderCount()).toBe(0);
  });

  it("skips already cancelled orders", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    book.add(makePrivateOrder({ pubKeyAx: 2n, nonce: 2n }));
    book.cancel(1n, 1n);
    expect(book.getOrderCount()).toBe(1);

    const cancelled = book.cancelAll();
    expect(cancelled).toBe(1);
    expect(book.getOrderCount()).toBe(0);
  });

  it("is idempotent — second drain returns 0", () => {
    book.add(makePrivateOrder({ pubKeyAx: 1n, nonce: 1n }));
    book.cancelAll();
    expect(book.cancelAll()).toBe(0);
  });
});

describe("Admin API — isPaused module", () => {
  it("isPaused exports a boolean function", async () => {
    // Mock config to avoid requiring RELAYER_PRIVATE_KEY env var
    vi.doMock("../src/config.js", () => ({
      config: { adminApiKey: null, relayerFee: 0 },
      updateRelayerFee: vi.fn(),
    }));
    const { isPaused } = await import("../src/routes/admin.js");
    expect(typeof isPaused).toBe("function");
    // Default state (no DB) — not paused
    expect(isPaused()).toBe(false);
    vi.doUnmock("../src/config.js");
  });
});
