import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrivateOrderDB } from "../src/core/db.js";
import { makePrivateOrder } from "./helpers.js";
import type { StoredPrivateOrder } from "../src/types/order.js";
import fs from "fs";
import path from "path";

const TEST_DB_PATH = path.join(process.cwd(), "test-zk-relayer.db");

function makeStored(overrides = {}): StoredPrivateOrder {
  return {
    order: makePrivateOrder(overrides),
    status: "pending",
    submittedAt: Date.now(),
  };
}

describe("PrivateOrderDB", () => {
  let db: PrivateOrderDB;

  beforeEach(() => {
    // Clean up any leftover test DB
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
    db = new PrivateOrderDB(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
  });

  it("saves and loads pending orders", () => {
    const stored = makeStored({ pubKeyAx: 1n, nonce: 1n });
    db.save(stored);

    const pending = db.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].order.pubKeyAx).toBe(1n);
    expect(pending[0].order.nonce).toBe(1n);
    expect(pending[0].status).toBe("pending");
  });

  it("round-trips bigint fields correctly", () => {
    const stored = makeStored({
      pubKeyAx: 123456789012345678901234567890n,
      nonce: 42n,
      sellAmount: 10n ** 18n,
      ownerSecret: 999999999999999n,
    });
    db.save(stored);

    const loaded = db.loadPending();
    expect(loaded[0].order.pubKeyAx).toBe(123456789012345678901234567890n);
    expect(loaded[0].order.nonce).toBe(42n);
    expect(loaded[0].order.sellAmount).toBe(10n ** 18n);
    expect(loaded[0].order.ownerSecret).toBe(999999999999999n);
  });

  it("saves and retrieves claims", () => {
    const stored = makeStored({ pubKeyAx: 1n, nonce: 1n });
    stored.order.claims = [
      { secret: 100n, recipient: 200n, token: 300n, amount: 400n, releaseTime: 500n },
      { secret: 600n, recipient: 700n, token: 800n, amount: 900n, releaseTime: 1000n },
    ];
    db.save(stored);

    const loaded = db.loadPending();
    expect(loaded[0].order.claims).toHaveLength(2);
    expect(loaded[0].order.claims[0].secret).toBe(100n);
    expect(loaded[0].order.claims[1].amount).toBe(900n);
  });

  it("updates order status", () => {
    const stored = makeStored({ pubKeyAx: 1n, nonce: 1n });
    db.save(stored);

    db.updateStatus(1n, 1n, "settled", "0xabc123");

    const loaded = db.getOrderByPubKeyNonce(1n, 1n);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("settled");
    expect(loaded!.settleTxHash).toBe("0xabc123");
  });

  it("hasOrder checks existence", () => {
    db.save(makeStored({ pubKeyAx: 1n, nonce: 1n }));
    expect(db.hasOrder(1n, 1n)).toBe(true);
    expect(db.hasOrder(1n, 2n)).toBe(false);
  });

  it("counts orders by pubkey", () => {
    db.save(makeStored({ pubKeyAx: 1n, nonce: 1n }));
    db.save(makeStored({ pubKeyAx: 1n, nonce: 2n }));
    db.save(makeStored({ pubKeyAx: 2n, nonce: 3n }));

    expect(db.countOrdersByPubKey(1n)).toBe(2);
    expect(db.countOrdersByPubKey(2n)).toBe(1);
    expect(db.countOrdersByPubKey(3n)).toBe(0);
  });

  it("paginates orders by pubkey", () => {
    for (let i = 0; i < 5; i++) {
      const s = makeStored({ pubKeyAx: 1n, nonce: BigInt(i) });
      s.submittedAt = Date.now() + i; // ensure ordering
      db.save(s);
    }

    const page1 = db.getOrdersByPubKey(1n, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = db.getOrdersByPubKey(1n, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = db.getOrdersByPubKey(1n, { limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });

  it("filters by status", () => {
    const s1 = makeStored({ pubKeyAx: 1n, nonce: 1n });
    db.save(s1);
    const s2 = makeStored({ pubKeyAx: 1n, nonce: 2n });
    db.save(s2);

    db.updateStatus(1n, 1n, "settled");

    const pending = db.getOrdersByPubKey(1n, { status: "pending", limit: 10, offset: 0 });
    expect(pending).toHaveLength(1);
    expect(pending[0].order.nonce).toBe(2n);

    const settled = db.getOrdersByPubKey(1n, { status: "settled", limit: 10, offset: 0 });
    expect(settled).toHaveLength(1);
    expect(settled[0].order.nonce).toBe(1n);
  });
});
