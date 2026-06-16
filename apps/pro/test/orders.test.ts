// @vitest-environment node
import { describe, expect, it } from "vitest";
import { serialize, deserialize, computeClaimedFromSpent, type OrderRecord } from "../app/lib/orders";

function fixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const claim = {
    secret: 0xc0ffee1234abcdef9876543210fedcban,
    recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    token: "0x8a791620dd6260079bf849dc5567adc3f2fdc318",
    amount: (10n ** 18n) * 1234567n,
    releaseTime: 1747930000n,
    leafIndex: 0,
    claimsRoot: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  };
  return {
    id: "ord-id-1",
    label: "ord-3",
    side: "sell",
    pair: "ETH/USDC",
    price: "4,205",
    size: "1.0",
    status: "matching",
    nonce: 0xdeadbeefcafef00dn,
    noteId: "note-abc",
    changeCommitment: 0xfeedfacecafebeefn,
    createdAt: 1747929600_000,
    claim,
    claims: [claim],
    ...overrides,
  };
}

describe("orders serialize/deserialize", () => {
  it("round-trips a fully-populated order without precision loss", () => {
    const order = fixture();
    const restored = deserialize(serialize(order));
    expect(restored).toEqual(order);
    // explicit bigint identity in case toEqual ever loosens
    expect(restored.claim!.secret).toBe(order.claim!.secret);
    expect(restored.claim!.amount).toBe(order.claim!.amount);
    expect(restored.claim!.releaseTime).toBe(order.claim!.releaseTime);
    expect(restored.nonce).toBe(order.nonce);
  });

  it("round-trips orders missing the optional nonce + noteId (seeded demo rows)", () => {
    const order = fixture({ nonce: undefined, noteId: undefined });
    const restored = deserialize(serialize(order));
    expect(restored.nonce).toBeUndefined();
    expect(restored.noteId).toBeUndefined();
  });

  it("round-trips orders with no claim material (seeded demo rows)", () => {
    const order = fixture({ claim: undefined, claims: undefined });
    const restored = deserialize(serialize(order));
    expect(restored.claim).toBeUndefined();
  });

  it("survives the JSON wire shape (structured clone via JSON)", () => {
    const order = fixture();
    const wire = serialize(order);
    const json = JSON.stringify(wire);
    const parsed = JSON.parse(json);
    const restored = deserialize(parsed);
    expect(restored).toEqual(order);
  });

  it("preserves zero bigints (no truthy-check regression)", () => {
    const order = fixture({
      claim: { ...fixture().claim!, releaseTime: 0n, amount: 0n },
      nonce: 0n,
      changeCommitment: 0n,
    });
    const restored = deserialize(serialize(order));
    expect(restored.claim!.releaseTime).toBe(0n);
    expect(restored.claim!.amount).toBe(0n);
    expect(restored.nonce).toBe(0n);
    // A zero residual commitment is legitimate (the cancel circuit
    // emits 0 when the parent note was fully spent) — a truthy
    // check on `changeCommitment` would have dropped it.
    expect(restored.changeCommitment).toBe(0n);
  });

  it("preserves all 4 OrderStatus values", () => {
    for (const status of ["matching", "claimable", "claimed", "cancelled"] as const) {
      const restored = deserialize(serialize(fixture({ status })));
      expect(restored.status).toBe(status);
    }
  });

  it("round-trips changeCommitment when present + omits cleanly when absent", () => {
    const withChange = fixture({ changeCommitment: 0x123456789abcdefn });
    expect(deserialize(serialize(withChange)).changeCommitment).toBe(0x123456789abcdefn);

    const noChange = fixture({ changeCommitment: undefined });
    expect(deserialize(serialize(noChange)).changeCommitment).toBeUndefined();
  });

  it("round-trips the full `claims` recipient list (multi-row support)", () => {
    const order = fixture({
      claims: [
        {
          secret: 1n,
          recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          amount: 100n,
          releaseTime: 1000n,
          leafIndex: 0,
          claimsRoot: "0xcc",
        },
        {
          secret: 2n,
          recipient: "0xcccccccccccccccccccccccccccccccccccccccc",
          token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          amount: 250n,
          releaseTime: 2000n,
          leafIndex: 1,
          claimsRoot: "0xcc",
        },
      ],
    });
    const restored = deserialize(serialize(order));
    expect(restored.claims).toHaveLength(2);
    expect(restored.claims![0]!.leafIndex).toBe(0);
    expect(restored.claims![1]!.leafIndex).toBe(1);
    expect(restored.claims![0]!.amount).toBe(100n);
    expect(restored.claims![1]!.amount).toBe(250n);
    expect(restored.claims![1]!.recipient).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
  });

  it("back-compat: deserialize promotes legacy singular `claim` into a singleton `claims`", () => {
    const legacy = fixture({ claims: undefined });
    const wire = serialize(legacy);
    expect(wire.claims).toBeUndefined();
    const restored = deserialize(wire);
    expect(restored.claims).toHaveLength(1);
    expect(restored.claims![0]!.secret).toBe(legacy.claim!.secret);
  });

  it("round-trips `claimedLeafIndexes` (per-recipient claim progress)", () => {
    // Multi-recipient order with partial progress — leaves 0 and 2
    // claimed, leaf 1 still open. The persistence layer has to
    // preserve the list exactly so the Claim modal can render the
    // ✓ badges back after a page reload.
    const order = fixture({
      claims: [
        { secret: 1n, recipient: "0xaa", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 0, claimsRoot: "0xcc" },
        { secret: 2n, recipient: "0xdd", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 1, claimsRoot: "0xcc" },
        { secret: 3n, recipient: "0xee", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 2, claimsRoot: "0xcc" },
      ],
      claimedLeafIndexes: [0, 2],
    });
    const restored = deserialize(serialize(order));
    expect(restored.claimedLeafIndexes).toEqual([0, 2]);
  });

  it("preserves `claimedLeafIndexes: undefined` when absent (legacy / fresh orders)", () => {
    const order = fixture({ claimedLeafIndexes: undefined });
    const restored = deserialize(serialize(order));
    expect(restored.claimedLeafIndexes).toBeUndefined();
  });
});

describe("computeClaimedFromSpent (authoritative reconcile)", () => {
  function threeLeaf(overrides: Partial<OrderRecord> = {}): OrderRecord {
    return fixture({
      status: "claimable",
      claims: [
        { secret: 1n, recipient: "0xaa", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 0, claimsRoot: "0xcc" },
        { secret: 2n, recipient: "0xdd", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 1, claimsRoot: "0xcc" },
        { secret: 3n, recipient: "0xee", token: "0xbb", amount: 100n, releaseTime: 1000n, leafIndex: 2, claimsRoot: "0xcc" },
      ],
      claimedLeafIndexes: undefined,
      ...overrides,
    });
  }

  it("(authoritative) sets the claimed set to confirmed-spent, deduped + sorted, partial → claimable", () => {
    const upd = computeClaimedFromSpent(threeLeaf(), [2, 0], true);
    expect(upd).toEqual({ claimedLeafIndexes: [0, 2], status: "claimable" });
  });

  it("promotes claimable→claimed once every leaf is spent (both modes)", () => {
    expect(computeClaimedFromSpent(threeLeaf({ claimedLeafIndexes: [0] }), [0, 1, 2], true)).toEqual({
      claimedLeafIndexes: [0, 1, 2],
      status: "claimed",
    });
    // add-only mode also promotes — merged covers all, every leaf is genuine.
    expect(computeClaimedFromSpent(threeLeaf({ claimedLeafIndexes: [0, 1] }), [2], false)).toEqual({
      claimedLeafIndexes: [0, 1, 2],
      status: "claimed",
    });
  });

  it("(authoritative) SELF-HEALS: drops a stale leaf the chain doesn't confirm, demoting a falsely-claimed order", () => {
    // The bug case: an older build wrongly recorded leaf 0 and the order got
    // promoted to `claimed`, but the chain only confirms leaf 1 spent.
    const upd = computeClaimedFromSpent(
      threeLeaf({ status: "claimed", claimedLeafIndexes: [0, 1] }),
      [1],
      true,
    );
    expect(upd).toEqual({ claimedLeafIndexes: [1], status: "claimable" });
  });

  it("(non-authoritative) NEVER demotes a claimed order or drops a recorded leaf on a partial result", () => {
    // Same stale input, but the indexer was down (RPC fallback) — a missing
    // leaf may just be a failed probe, so add-only: keep [0,1], stay claimed.
    expect(
      computeClaimedFromSpent(threeLeaf({ status: "claimed", claimedLeafIndexes: [0, 1] }), [1], false),
    ).toBeNull();
  });

  it("never touches a non-reconcilable order (matching / cancelled)", () => {
    expect(computeClaimedFromSpent(threeLeaf({ status: "cancelled" }), [0, 1, 2], true)).toEqual({
      claimedLeafIndexes: [0, 1, 2],
      status: "cancelled",
    });
    expect(computeClaimedFromSpent(threeLeaf({ status: "matching" }), [0], true)).toEqual({
      claimedLeafIndexes: [0],
      status: "matching",
    });
  });

  it("returns null when the persisted set + status are already correct", () => {
    expect(computeClaimedFromSpent(threeLeaf({ claimedLeafIndexes: [0, 1] }), [0, 1], true)).toBeNull();
  });

  it("ignores spent leaves outside the claims list", () => {
    const upd = computeClaimedFromSpent(threeLeaf(), [0, 1, 2, 7], true);
    expect(upd).toEqual({ claimedLeafIndexes: [0, 1, 2], status: "claimed" });
  });

  it("dedups repeated spent leaves", () => {
    expect(computeClaimedFromSpent(threeLeaf(), [1, 1], true)).toEqual({
      claimedLeafIndexes: [1],
      status: "claimable",
    });
  });

  it("rewrites a dirty persisted array clean (out-of-range / duplicate entries dropped)", () => {
    // prior [0,9] vs new [0] — the raw arrays differ, so it WRITES the cleaned
    // [0] (drops the out-of-range 9) rather than no-oping on a normalised match.
    expect(computeClaimedFromSpent(threeLeaf({ claimedLeafIndexes: [0, 9] }), [0], true)).toEqual({
      claimedLeafIndexes: [0],
      status: "claimable",
    });
    expect(computeClaimedFromSpent(threeLeaf({ claimedLeafIndexes: [0, 0] }), [0], true)).toEqual({
      claimedLeafIndexes: [0],
      status: "claimable",
    });
  });

  it("returns null for an order with no claims", () => {
    expect(computeClaimedFromSpent(fixture({ claim: undefined, claims: [] }), [0], true)).toBeNull();
  });
});
