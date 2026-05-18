// @vitest-environment node
import { describe, expect, it } from "vitest";
import { serialize, deserialize, type OrderRecord } from "../app/lib/orders";

function fixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
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
    createdAt: 1747929600_000,
    claim: {
      secret: 0xc0ffee1234abcdef9876543210fedcban,
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0x8a791620dd6260079bf849dc5567adc3f2fdc318",
      amount: (10n ** 18n) * 1234567n,
      releaseTime: 1747930000n,
      leafIndex: 0,
      claimsRoot: "0x0000000000000000000000000000000000000000000000000000000000000abc",
    },
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
    const order = fixture({ claim: undefined });
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
    });
    const restored = deserialize(serialize(order));
    expect(restored.claim!.releaseTime).toBe(0n);
    expect(restored.claim!.amount).toBe(0n);
    expect(restored.nonce).toBe(0n);
  });

  it("preserves all 4 OrderStatus values", () => {
    for (const status of ["matching", "claimable", "claimed", "cancelled"] as const) {
      const restored = deserialize(serialize(fixture({ status })));
      expect(restored.status).toBe(status);
    }
  });
});
