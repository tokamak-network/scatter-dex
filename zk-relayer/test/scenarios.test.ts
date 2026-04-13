/**
 * Comprehensive scenario tests covering user & relayer perspectives.
 * Based on docs/test-scenarios.md.
 *
 * Implemented: U1-U4, U8, R1, R4, R5, R7, E2-E5, E7-E8, price, cleanup
 * TODO (require on-chain/integration): U5, U6, U7, R2, R3, R6, E1, E6
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PrivateOrderbook } from "../src/core/orderbook.js";
import { PrivateMatcher } from "../src/core/matcher.js";
import { RemoteOrderStore } from "../src/core/remote-orderbook.js";
import type { PrivateOrder, StoredPrivateOrder, OrderSummary } from "../src/types/order.js";
import { isCrossRelayerMatch } from "../src/types/order.js";

const TOKEN_A = BigInt("0x" + "aa".repeat(20));
const TOKEN_B = BigInt("0x" + "bb".repeat(20));
const TOKEN_A_HEX = "0x" + "aa".repeat(20);
const TOKEN_B_HEX = "0x" + "bb".repeat(20);
const MAX_ORDERBOOK = 1000;

let nonceCounter = 1n;
function nextNonce(): bigint { return nonceCounter++; }

function makeOrder(overrides: Partial<PrivateOrder> = {}): PrivateOrder {
  return {
    sellToken: overrides.sellToken ?? TOKEN_A,
    buyToken: overrides.buyToken ?? TOKEN_B,
    sellAmount: overrides.sellAmount ?? 1000n,
    buyAmount: overrides.buyAmount ?? 2000n,
    maxFee: overrides.maxFee ?? 0n,
    expiry: overrides.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: overrides.nonce ?? nextNonce(),
    pubKeyAx: overrides.pubKeyAx ?? 111n,
    pubKeyAy: overrides.pubKeyAy ?? 222n,
    sigS: 0n, sigR8x: 0n, sigR8y: 0n,
    ownerSecret: 999n, balance: 5000n, salt: 888n, leafIndex: 0,
    newSalt: 777n, expectedChangeCommitment: 666n,
    claims: [{ secret: 1n, recipient: 2n, token: TOKEN_A, amount: 500n, releaseTime: 0n }],
  };
}

function makeRemote(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? `0xremote-${nextNonce()}`,
    relayer: overrides.relayer ?? "0xremoterelayer",
    relayerUrl: overrides.relayerUrl ?? "http://remote:3002",
    nonce: overrides.nonce ?? String(nextNonce()),
    pubKeyAx: overrides.pubKeyAx ?? "99999",
    sellToken: overrides.sellToken ?? TOKEN_B_HEX,
    buyToken: overrides.buyToken ?? TOKEN_A_HEX,
    sellAmount: overrides.sellAmount ?? "2000",
    buyAmount: overrides.buyAmount ?? "1000",
    minFillAmount: "0",
    maxFee: overrides.maxFee ?? 0,
    expiry: overrides.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

let orderbook: PrivateOrderbook;
let remoteStore: RemoteOrderStore;
let matcher: PrivateMatcher;

beforeEach(() => {
  nonceCounter = 1n;
  orderbook = new PrivateOrderbook(MAX_ORDERBOOK);
  remoteStore = new RemoteOrderStore();
  matcher = new PrivateMatcher(orderbook, remoteStore);
  matcher.setRelayerAddress("0xlocalrelayer");
});

// ─── User Scenarios ─────────────────────────────────────

describe("User Scenarios", () => {
  describe("U1: Local match — order added, matched, removed", () => {
    it("maker+taker match and both are removed from orderbook", () => {
      const maker = makeOrder({ pubKeyAx: 100n });
      const taker = makeOrder({
        pubKeyAx: 200n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });

      orderbook.add(maker);
      const storedTaker = orderbook.add(taker);

      const match = matcher.findMatch(storedTaker);
      expect(match).not.toBeNull();

      // Simulate settlement: remove matched orders
      orderbook.remove(match!.maker.order);
      orderbook.remove(match!.taker.order);

      // Verify orderbook is empty
      expect(orderbook.getByPubKeyAndNonce(100n, maker.nonce)).toBeNull();
      expect(orderbook.getByPubKeyAndNonce(200n, taker.nonce)).toBeNull();
    });
  });

  describe("U2: Cross-relayer — local taker matches remote maker", () => {
    it("returns CrossRelayerMatch with correct sides and relayer", () => {
      remoteStore.add(makeRemote());
      const taker = makeOrder();
      const stored: StoredPrivateOrder = { order: taker, status: "pending", submittedAt: Date.now() };
      const result = matcher.findMatchIncludingRemote(stored);

      expect(result).not.toBeNull();
      expect(isCrossRelayerMatch(result!)).toBe(true);
      if (isCrossRelayerMatch(result!)) {
        expect(result.localSide).toBe("taker");
        expect(result.remoteOrder.relayer).toBe("0xremoterelayer");
      }
    });
  });

  describe("U3: Expired order — not matched", () => {
    it("expired maker is skipped during matching", () => {
      orderbook.add(makeOrder({
        pubKeyAx: 100n,
        expiry: BigInt(Math.floor(Date.now() / 1000) - 100),
      }));
      const taker = makeOrder({
        pubKeyAx: 200n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      const stored = orderbook.add(taker);
      expect(matcher.findMatch(stored)).toBeNull();
    });
  });

  describe("U4: Cancelled order — removed from matching", () => {
    it("cancelled maker cannot be matched", () => {
      const maker = makeOrder({ pubKeyAx: 100n });
      orderbook.add(maker);
      orderbook.cancel(100n, maker.nonce);

      const taker = makeOrder({
        pubKeyAx: 200n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      const stored = orderbook.add(taker);
      expect(matcher.findMatch(stored)).toBeNull();
    });
  });

  describe("U8: Order signed for wrong relayer", () => {
    it.todo("rejected at EdDSA verification — requires integration test with poseidon hash");
    // This test requires actually computing Poseidon(9) hashes with different relayer
    // addresses and verifying EdDSA signature mismatch. Cannot be done at unit level
    // without importing circomlibjs.
  });
});

// ─── Relayer Scenarios ──────────────────────────────────

describe("Relayer Scenarios", () => {
  describe("R1: Local match — same relayer for both sides", () => {
    it("returns PrivateMatch (not CrossRelayerMatch)", () => {
      const maker = makeOrder({ pubKeyAx: 100n });
      const taker = makeOrder({
        pubKeyAx: 200n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      orderbook.add(maker);
      const stored = orderbook.add(taker);

      const result = matcher.findMatchIncludingRemote(stored);
      expect(result).not.toBeNull();
      expect(isCrossRelayerMatch(result!)).toBe(false);
      // Local match → caller uses (selfAddr, selfAddr) for fee split
    });
  });

  describe("R4: Trade Offer — maker cancelled before arrival", () => {
    it("getByPubKeyAndNonce returns null for cancelled order", () => {
      const maker = makeOrder({ pubKeyAx: 100n });
      orderbook.add(maker);
      orderbook.cancel(100n, maker.nonce);
      expect(orderbook.getByPubKeyAndNonce(100n, maker.nonce)).toBeNull();
    });
  });

  describe("R5: Shared orderbook server down — null remote", () => {
    it("matcher works with null remote orderbook", () => {
      const localMatcher = new PrivateMatcher(orderbook, null);
      const order = makeOrder();
      const stored: StoredPrivateOrder = { order, status: "pending", submittedAt: Date.now() };
      expect(localMatcher.findMatchIncludingRemote(stored)).toBeNull();
    });
  });

  describe("R7: Reactive matching — remote order triggers local match", () => {
    it("existing local order matches newly arrived remote order", () => {
      const taker = makeOrder({ pubKeyAx: 100n });
      orderbook.add(taker);

      // Remote maker arrives
      remoteStore.add(makeRemote());

      // Matcher finds cross-relayer match
      const stored = orderbook.getByPubKeyAndNonce(100n, taker.nonce);
      expect(stored).not.toBeNull();
      const result = matcher.findMatchIncludingRemote(stored!);
      expect(result).not.toBeNull();
      expect(isCrossRelayerMatch(result!)).toBe(true);
    });
  });
});

// ─── Edge Cases ─────────────────────────────────────────

describe("Edge Cases", () => {
  describe("E2: Expired remote order — skipped at add", () => {
    it("RemoteOrderStore rejects expired orders", () => {
      remoteStore.add(makeRemote({
        expiry: Math.floor(Date.now() / 1000) - 100,
      }));
      expect(remoteStore.size).toBe(0);
    });
  });

  describe("E3: Fee validation — matcher does not check fee", () => {
    it("matcher ignores maxFee (validation is at submission + contract level)", () => {
      const maker = makeOrder({ pubKeyAx: 100n, maxFee: 0n });
      const taker = makeOrder({
        pubKeyAx: 200n, maxFee: 0n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      orderbook.add(maker);
      const stored = orderbook.add(taker);
      // Matcher doesn't enforce fee — contract does
      expect(matcher.findMatch(stored)).not.toBeNull();
    });
  });

  describe("E4: Self-trade prevention — same EdDSA key rejected", () => {
    it("orders with identical pubKeyAx+pubKeyAy are not matched", () => {
      const maker = makeOrder({ pubKeyAx: 100n, pubKeyAy: 200n });
      const taker = makeOrder({
        pubKeyAx: 100n, pubKeyAy: 200n, // SAME KEY
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      orderbook.add(maker);
      const stored = orderbook.add(taker);
      expect(matcher.findMatch(stored)).toBeNull();
    });
  });

  describe("E5: Own relayer orders skipped in remote matching", () => {
    it("remote orders from own relayer address are not matched", () => {
      remoteStore.add(makeRemote({ relayer: "0xlocalrelayer" }));
      const taker = makeOrder();
      const stored: StoredPrivateOrder = { order: taker, status: "pending", submittedAt: Date.now() };
      expect(matcher.findMatchIncludingRemote(stored)).toBeNull();
    });
  });

  describe("E7: Nonce reuse after cancellation", () => {
    it("cancelled nonce can be reused for new order", () => {
      const nonce = nextNonce();
      const order1 = makeOrder({ nonce, pubKeyAx: 100n });
      orderbook.add(order1);
      orderbook.cancel(100n, nonce);

      const order2 = makeOrder({ nonce, pubKeyAx: 100n });
      const stored = orderbook.add(order2);
      expect(stored.status).toBe("pending");
    });
  });

  describe("E8: Multiple orders same user different nonces", () => {
    it("same pubkey can have multiple pending orders", () => {
      const n1 = nextNonce(), n2 = nextNonce();
      orderbook.add(makeOrder({ nonce: n1, pubKeyAx: 100n }));
      orderbook.add(makeOrder({ nonce: n2, pubKeyAx: 100n }));

      expect(orderbook.getByPubKeyAndNonce(100n, n1)).not.toBeNull();
      expect(orderbook.getByPubKeyAndNonce(100n, n2)).not.toBeNull();
    });
  });

  describe("Price incompatibility", () => {
    it("expensive maker does not match cheap taker", () => {
      // Maker wants 5000 B for 1000 A (expensive ask)
      orderbook.add(makeOrder({
        pubKeyAx: 100n, sellAmount: 1000n, buyAmount: 5000n,
      }));
      // Taker offers 2000 B for 1000 A (low bid)
      const taker = makeOrder({
        pubKeyAx: 200n,
        sellToken: TOKEN_B, buyToken: TOKEN_A,
        sellAmount: 2000n, buyAmount: 1000n,
      });
      const stored = orderbook.add(taker);
      expect(matcher.findMatch(stored)).toBeNull();
    });
  });

  describe("Remote order store lifecycle", () => {
    it("purgeExpired removes nothing when all active", () => {
      remoteStore.add(makeRemote({ expiry: Math.floor(Date.now() / 1000) + 3600 }));
      expect(remoteStore.purgeExpired()).toBe(0);
      expect(remoteStore.size).toBe(1);
    });

    it("removeByRelayer cleans up only target relayer", () => {
      remoteStore.add(makeRemote({ id: "r1-1", relayer: "0xrelayerA" }));
      remoteStore.add(makeRemote({ id: "r1-2", relayer: "0xrelayerA" }));
      remoteStore.add(makeRemote({ id: "r2-1", relayer: "0xrelayerB" }));
      remoteStore.removeByRelayer("0xrelayerA");
      expect(remoteStore.size).toBe(1);
      expect(remoteStore.get("r2-1")).toBeDefined();
    });
  });
});
