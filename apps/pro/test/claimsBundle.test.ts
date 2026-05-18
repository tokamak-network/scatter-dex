// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildClaimsBundleJson } from "../app/lib/claimsBundle";
import type { OrderRecord } from "../app/lib/orders";

function fixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "ord-id-1",
    label: "ord-7",
    side: "sell",
    pair: "ETH/USDC",
    price: "4,205",
    size: "1.0",
    status: "matching",
    nonce: 0xdeadbeefn,
    noteId: "note-abc",
    createdAt: 1747929600_000,
    claim: {
      secret: 0xc0ffee1234abcdefn,
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0x8a791620dd6260079bf849dc5567adc3f2fdc318",
      amount: (10n ** 18n) * 4205n,
      releaseTime: 1747930000n,
      leafIndex: 0,
      claimsRoot: "0x0000000000000000000000000000000000000000000000000000000000000abc",
    },
    ...overrides,
  };
}

describe("buildClaimsBundleJson", () => {
  it("round-trips every bigint through JSON.parse without precision loss", () => {
    const order = fixture();
    const json = buildClaimsBundleJson(order, { relayerUrl: "http://r:8080", chainId: 31337 });
    const parsed = JSON.parse(json);

    expect(BigInt(parsed.claim.secret)).toBe(order.claim!.secret);
    expect(BigInt(parsed.claim.amount)).toBe(order.claim!.amount);
    expect(BigInt(parsed.claim.releaseTime)).toBe(order.claim!.releaseTime);
    expect(BigInt(parsed.order.nonce)).toBe(order.nonce!);
  });

  it("emits hex with the 0x prefix (so BigInt() can read it back)", () => {
    const json = buildClaimsBundleJson(fixture(), { relayerUrl: null, chainId: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.claim.secret).toMatch(/^0x[0-9a-f]+$/);
    expect(parsed.claim.amount).toMatch(/^0x[0-9a-f]+$/);
    expect(parsed.order.nonce).toMatch(/^0x[0-9a-f]+$/);
  });

  it("preserves chainId, relayerUrl, and the kind+version header", () => {
    const json = buildClaimsBundleJson(fixture(), { relayerUrl: "http://r:8080", chainId: 31337 });
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.kind).toBe("scatter-pro-claims-bundle");
    expect(parsed.chainId).toBe(31337);
    expect(parsed.relayerUrl).toBe("http://r:8080");
    expect(typeof parsed.createdAt).toBe("string");
  });

  it("preserves order metadata required for re-display in the orders page", () => {
    const order = fixture();
    const json = buildClaimsBundleJson(order, { relayerUrl: null, chainId: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.order.id).toBe(order.id);
    expect(parsed.order.label).toBe(order.label);
    expect(parsed.order.side).toBe(order.side);
    expect(parsed.order.pair).toBe(order.pair);
    expect(parsed.order.price).toBe(order.price);
    expect(parsed.order.size).toBe(order.size);
    expect(parsed.order.noteId).toBe(order.noteId);
    expect(parsed.order.createdAtMs).toBe(order.createdAt);
  });

  it("preserves the claim recipient/token addresses untouched (no normalization)", () => {
    const order = fixture();
    const json = buildClaimsBundleJson(order, { relayerUrl: null, chainId: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.claim.recipient).toBe(order.claim!.recipient);
    expect(parsed.claim.token).toBe(order.claim!.token);
    expect(parsed.claim.leafIndex).toBe(0);
    expect(parsed.claim.claimsRoot).toBe(order.claim!.claimsRoot);
  });

  it("omits nonce + noteId cleanly when unset (no 'undefined' strings, no NaN)", () => {
    const order = fixture({ nonce: undefined, noteId: undefined });
    const json = buildClaimsBundleJson(order, { relayerUrl: null, chainId: 1 });
    const parsed = JSON.parse(json);
    expect(parsed.order.nonce).toBeUndefined();
    expect(parsed.order.noteId).toBeUndefined();
  });

  it("throws when the order carries no claim material (seeded demo rows)", () => {
    const order = fixture({ claim: undefined });
    expect(() =>
      buildClaimsBundleJson(order, { relayerUrl: null, chainId: 1 }),
    ).toThrow(/no claim material/i);
  });
});
