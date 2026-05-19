// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  aggregateBySymbol,
  deriveNoteStatus,
} from "../app/lib/noteStatus";
import type { OrderRecord, OrderStatus } from "../app/lib/orders";
import type { VaultNote } from "../app/lib/vault";

function makeNote(over: Partial<VaultNote> = {}): VaultNote {
  return {
    id: "note-1",
    label: "lot-1",
    symbol: "ETH",
    amount: "1.0",
    note: {
      ownerSecret: 1n,
      token: 2n,
      amount: 10n ** 18n,
      salt: 3n,
      pubKeyAx: 4n,
      pubKeyAy: 5n,
    },
    commitment: 6n,
    leafIndex: 7,
    chainId: 31337,
    createdAt: 1000,
    ...over,
  };
}

function makeOrder(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "ord-id-1",
    label: "ord-1",
    side: "sell",
    pair: "ETH/USDC",
    price: "4205",
    size: "1.0",
    status: "matching",
    createdAt: 1000,
    ...over,
  };
}

describe("deriveNoteStatus", () => {
  it("classifies a reconciled, unreferenced note as available", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    expect(deriveNoteStatus(note, [])).toEqual({ status: "available" });
  });

  it("classifies a reconciled note funding an open `matching` order as locked", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    const order = makeOrder({ id: "o1", noteId: "n1", status: "matching" });
    const info = deriveNoteStatus(note, [order]);
    expect(info.status).toBe("locked");
    expect(info.lockedByOrder).toBe(order);
  });

  it("locks against `claimable` orders too (matching's later twin)", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    const order = makeOrder({ id: "o1", noteId: "n1", status: "claimable" });
    expect(deriveNoteStatus(note, [order]).status).toBe("locked");
  });

  it("does NOT lock against terminal-status orders (`claimed`, `cancelled`)", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    for (const status of ["claimed", "cancelled"] as OrderStatus[]) {
      const order = makeOrder({ id: "o1", noteId: "n1", status });
      expect(deriveNoteStatus(note, [order]).status).toBe("available");
    }
  });

  it("classifies a leafIndex<0 note as pending regardless of orders", () => {
    const note = makeNote({ id: "n1", leafIndex: -1 });
    const order = makeOrder({ noteId: "n1", status: "matching" });
    // leafIndex<0 short-circuits — even if an order points at it,
    // the note isn't on-chain yet so it can't be "locked"
    expect(deriveNoteStatus(note, [order])).toEqual({ status: "pending" });
  });

  it("ignores orders that reference a different noteId", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    const order = makeOrder({ id: "o1", noteId: "other", status: "matching" });
    expect(deriveNoteStatus(note, [order]).status).toBe("available");
  });

  it("labels a pending residual with its source order when commitment matches changeCommitment", () => {
    const change = makeNote({ id: "n2", commitment: 999n, leafIndex: -1 });
    const order = makeOrder({
      id: "o1",
      noteId: "parent",
      status: "matching",
      changeCommitment: 999n,
    });
    const info = deriveNoteStatus(change, [order]);
    expect(info.status).toBe("pending");
    expect(info.pendingFromOrder?.id).toBe("o1");
  });

  it("does not label a pending note when changeCommitment doesn't match", () => {
    const change = makeNote({ id: "n2", commitment: 999n, leafIndex: -1 });
    const order = makeOrder({ status: "matching", changeCommitment: 111n });
    const info = deriveNoteStatus(change, [order]);
    expect(info.status).toBe("pending");
    expect(info.pendingFromOrder).toBeUndefined();
  });

  it("does not label a pending note when source order is terminal (claimed/cancelled)", () => {
    const change = makeNote({ id: "n2", commitment: 999n, leafIndex: -1 });
    for (const status of ["claimed", "cancelled"] as OrderStatus[]) {
      const order = makeOrder({ status, changeCommitment: 999n });
      const info = deriveNoteStatus(change, [order]);
      expect(info.status).toBe("pending");
      expect(info.pendingFromOrder).toBeUndefined();
    }
  });

  it("picks the first matching order when more than one references the same note (defensive — shouldn't happen)", () => {
    const note = makeNote({ id: "n1", leafIndex: 5 });
    const o1 = makeOrder({ id: "o1", noteId: "n1", status: "matching" });
    const o2 = makeOrder({ id: "o2", noteId: "n1", status: "claimable" });
    const info = deriveNoteStatus(note, [o1, o2]);
    expect(info.status).toBe("locked");
    expect(info.lockedByOrder?.id).toBe("o1");
  });
});

describe("aggregateBySymbol", () => {
  it("returns an empty list for no notes", () => {
    expect(aggregateBySymbol([], [])).toEqual([]);
  });

  it("groups notes by symbol and splits into three buckets", () => {
    const notes: VaultNote[] = [
      makeNote({ id: "a", symbol: "ETH", amount: "1.0", leafIndex: 5 }),
      makeNote({ id: "b", symbol: "ETH", amount: "0.5", leafIndex: -1 }),
      makeNote({ id: "c", symbol: "ETH", amount: "2.0", leafIndex: 7 }),
      makeNote({ id: "d", symbol: "USDC", amount: "10000", leafIndex: 3 }),
    ];
    const orders: OrderRecord[] = [
      makeOrder({ id: "o", noteId: "c", status: "matching" }),
    ];
    expect(aggregateBySymbol(notes, orders)).toEqual([
      { symbol: "ETH", available: 1.0, locked: 2.0, pending: 0.5 },
      { symbol: "USDC", available: 10000, locked: 0, pending: 0 },
    ]);
  });

  it("sorts symbols alphabetically (stable for the panel header)", () => {
    const notes = [
      makeNote({ id: "u", symbol: "USDC", amount: "1", leafIndex: 1 }),
      makeNote({ id: "e", symbol: "ETH", amount: "1", leafIndex: 1 }),
      makeNote({ id: "d", symbol: "DAI", amount: "1", leafIndex: 1 }),
    ];
    expect(aggregateBySymbol(notes, []).map((r) => r.symbol)).toEqual([
      "DAI",
      "ETH",
      "USDC",
    ]);
  });

  it("skips notes whose amount string doesn't parse (defensive)", () => {
    const notes = [
      makeNote({ id: "ok", symbol: "ETH", amount: "1.0", leafIndex: 1 }),
      makeNote({ id: "bad", symbol: "ETH", amount: "not-a-number", leafIndex: 1 }),
    ];
    const out = aggregateBySymbol(notes, []);
    expect(out[0]!.available).toBe(1.0);
  });

  it("handles comma-separated display amounts", () => {
    const notes = [
      makeNote({ id: "x", symbol: "USDC", amount: "10,000.50", leafIndex: 1 }),
    ];
    expect(aggregateBySymbol(notes, [])[0]!.available).toBeCloseTo(10000.5);
  });
});
