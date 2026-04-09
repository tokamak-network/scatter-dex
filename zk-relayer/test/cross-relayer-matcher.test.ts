import { describe, it, expect, beforeEach } from "vitest";
import { PrivateMatcher } from "../src/core/matcher.js";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { RemoteOrderStore } from "../src/core/remote-orderbook.js";
import type { PrivateOrder, StoredPrivateOrder, OrderSummary } from "../src/types/order.js";
import { isCrossRelayerMatch } from "../src/types/order.js";

const TOKEN_A = BigInt("0x" + "aa".repeat(20));
const TOKEN_B = BigInt("0x" + "bb".repeat(20));
const TOKEN_A_HEX = "0x" + "aa".repeat(20);
const TOKEN_B_HEX = "0x" + "bb".repeat(20);

function makeLocalOrder(overrides: Partial<PrivateOrder> = {}): PrivateOrder {
  return {
    sellToken: overrides.sellToken ?? TOKEN_A,
    buyToken: overrides.buyToken ?? TOKEN_B,
    sellAmount: overrides.sellAmount ?? 1000n,
    buyAmount: overrides.buyAmount ?? 2000n,
    maxFee: overrides.maxFee ?? 30n,
    expiry: overrides.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: overrides.nonce ?? 1n,
    pubKeyAx: overrides.pubKeyAx ?? 111n,
    pubKeyAy: overrides.pubKeyAy ?? 222n,
    sigS: 0n, sigR8x: 0n, sigR8y: 0n,
    ownerSecret: 999n, balance: 5000n, salt: 888n, leafIndex: 0,
    newSalt: 777n, expectedChangeCommitment: 666n,
    claims: [{ secret: 1n, recipient: 2n, token: TOKEN_A, amount: 100n, releaseTime: 0n }],
  };
}

function makeRemoteOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? "0xremoterelayer-1",
    relayer: overrides.relayer ?? "0xremoterelayer",
    relayerUrl: overrides.relayerUrl ?? "http://remote:3002",
    nonce: overrides.nonce ?? "1",
    pubKeyAx: overrides.pubKeyAx ?? "99999",
    sellToken: overrides.sellToken ?? TOKEN_B_HEX,
    buyToken: overrides.buyToken ?? TOKEN_A_HEX,
    sellAmount: overrides.sellAmount ?? "2000",
    buyAmount: overrides.buyAmount ?? "1000",
    minFillAmount: "0",
    maxFee: overrides.maxFee ?? 30,
    expiry: overrides.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

describe("PrivateMatcher — cross-relayer matching", () => {
  let orderbook: PrivateOrderbook;
  let remoteStore: RemoteOrderStore;
  let matcher: PrivateMatcher;

  beforeEach(() => {
    orderbook = new PrivateOrderbook(1000);
    remoteStore = new RemoteOrderStore();
    matcher = new PrivateMatcher(orderbook, remoteStore);
    matcher.setRelayerAddress("0xlocalrelayer");
  });

  it("returns null when no match exists", () => {
    const order = makeLocalOrder();
    const stored: StoredPrivateOrder = { order, status: "pending", submittedAt: Date.now() };
    expect(matcher.findMatchIncludingRemote(stored)).toBeNull();
  });

  it("prefers local match over remote match", () => {
    // Add a local counterparty
    const counterparty = makeLocalOrder({
      sellToken: TOKEN_B, buyToken: TOKEN_A,
      sellAmount: 2000n, buyAmount: 1000n,
      nonce: 2n, pubKeyAx: 333n, pubKeyAy: 444n,
    });
    orderbook.add(counterparty);

    // Also add a remote counterparty
    remoteStore.add(makeRemoteOrder());

    // New order should match locally
    const newOrder = makeLocalOrder();
    const stored = orderbook.add(newOrder);
    const result = matcher.findMatchIncludingRemote(stored);

    expect(result).not.toBeNull();
    expect(isCrossRelayerMatch(result!)).toBe(false); // local match
  });

  it("falls back to remote match when no local match", () => {
    // Only remote counterparty available
    remoteStore.add(makeRemoteOrder());

    const newOrder = makeLocalOrder();
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    const result = matcher.findMatchIncludingRemote(stored);

    expect(result).not.toBeNull();
    expect(isCrossRelayerMatch(result!)).toBe(true);
    if (isCrossRelayerMatch(result!)) {
      expect(result.localSide).toBe("taker");
      expect(result.remoteOrder.relayer).toBe("0xremoterelayer");
    }
  });

  it("skips own relayer's remote orders", () => {
    // Remote order from our own relayer — should be skipped
    remoteStore.add(makeRemoteOrder({ relayer: "0xlocalrelayer" }));

    const newOrder = makeLocalOrder();
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    const result = matcher.findMatchIncludingRemote(stored);

    expect(result).toBeNull();
  });

  it("skips expired remote orders", () => {
    remoteStore.add(makeRemoteOrder({
      expiry: Math.floor(Date.now() / 1000) - 100,
    }));

    const newOrder = makeLocalOrder();
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    // The expired order won't even be in the store (add filters it)
    expect(matcher.findMatchIncludingRemote(stored)).toBeNull();
  });

  it("skips price-incompatible remote orders", () => {
    // Remote wants to sell 1000 for 5000 (price too high for our buyer)
    remoteStore.add(makeRemoteOrder({
      sellToken: TOKEN_B_HEX, buyToken: TOKEN_A_HEX,
      sellAmount: "1000", buyAmount: "5000",
    }));

    // Local sells A for B: 1000 for 2000
    const newOrder = makeLocalOrder({
      sellAmount: 1000n, buyAmount: 2000n,
    });
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    expect(matcher.findMatchIncludingRemote(stored)).toBeNull();
  });

  it("matches when remote no longer in store", () => {
    remoteStore.add(makeRemoteOrder({ id: "will-remove" }));
    remoteStore.remove("will-remove");

    const newOrder = makeLocalOrder();
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    expect(matcher.findMatchIncludingRemote(stored)).toBeNull();
  });

  it("works without remote orderbook (null)", () => {
    const localOnlyMatcher = new PrivateMatcher(orderbook, null);
    const newOrder = makeLocalOrder();
    const stored: StoredPrivateOrder = { order: newOrder, status: "pending", submittedAt: Date.now() };
    expect(localOnlyMatcher.findMatchIncludingRemote(stored)).toBeNull();
  });
});
