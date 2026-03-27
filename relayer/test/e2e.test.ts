import { describe, it, expect, beforeEach } from "vitest";
import { ethers } from "ethers";
import { Orderbook } from "../src/core/orderbook.js";
import { Matcher } from "../src/core/matcher.js";
import { Order, SignedOrder, EIP712_DOMAIN, EIP712_TYPES, parseOrder } from "../src/types/order.js";
import { isValidSignature } from "../src/core/signer.js";

const CHAIN_ID = 31337n;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

async function signOrder(wallet: ethers.Wallet, order: Order): Promise<string> {
  const domain = { ...EIP712_DOMAIN, chainId: CHAIN_ID, verifyingContract: CONTRACT };
  return wallet.signTypedData(domain, EIP712_TYPES, {
    ...order,
    claims: order.claims.map((c) => ({
      claimHash: c.claimHash,
      amount: c.amount,
      releaseDelay: c.releaseDelay,
    })),
  });
}

describe("E2E: Order lifecycle", () => {
  let book: Orderbook;
  let matcher: Matcher;
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  beforeEach(() => {
    book = new Orderbook();
    matcher = new Matcher(book);
  });

  it("full flow: sign → verify → add → match", async () => {
    // Alice: sell 10 TKA for 21000 TKB
    const aliceOrder: Order = {
      maker: alice.address,
      sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      maxFee: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 1n,
      claims: [{
        claimHash: "0x" + "aa".repeat(32),
        amount: 21000n * 10n ** 18n,
        releaseDelay: 10800n, // 3 hours
      }],
    };

    // Bob: sell 21000 TKB for 10 TKA
    const bobOrder: Order = {
      maker: bob.address,
      sellToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      buyToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      maxFee: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 1n,
      claims: [{
        claimHash: "0x" + "bb".repeat(32),
        amount: 10n * 10n ** 18n,
        releaseDelay: 14400n, // 4 hours
      }],
    };

    // 1. Sign orders
    const aliceSig = await signOrder(alice, aliceOrder);
    const bobSig = await signOrder(bob, bobOrder);

    // 2. Verify signatures
    expect(isValidSignature(aliceOrder, aliceSig, CHAIN_ID, CONTRACT)).toBe(true);
    expect(isValidSignature(bobOrder, bobSig, CHAIN_ID, CONTRACT)).toBe(true);

    // 3. Add to orderbook
    const storedAlice = book.add({ order: aliceOrder, signature: aliceSig });
    const storedBob = book.add({ order: bobOrder, signature: bobSig });

    expect(book.getOrderCount()).toBe(2);

    // 4. Match
    const match = matcher.findMatch(storedAlice);
    expect(match).not.toBeNull();
    expect(match!.taker).toBe(storedBob);

    // 5. After settlement, remove from book
    book.remove(match!.maker.order);
    book.remove(match!.taker.order);
    expect(book.getOrderCount()).toBe(0);
  });

  it("JSON round-trip: parseOrder preserves BigInt correctly", async () => {
    const order: Order = {
      maker: alice.address,
      sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      maxFee: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 1n,
      claims: [{
        claimHash: "0x" + "cc".repeat(32),
        amount: 21000n * 10n ** 18n,
        releaseDelay: 3600n,
      }],
    };

    // Simulate JSON serialization (what the frontend sends)
    const json = {
      maker: order.maker,
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      maxFee: order.maxFee.toString(),
      expiry: order.expiry.toString(),
      nonce: order.nonce.toString(),
      claims: order.claims.map((c) => ({
        claimHash: c.claimHash,
        amount: c.amount.toString(),
        releaseDelay: c.releaseDelay.toString(),
      })),
    };

    // Parse back
    const parsed = parseOrder(json);
    expect(parsed.sellAmount).toBe(order.sellAmount);
    expect(parsed.buyAmount).toBe(order.buyAmount);
    expect(parsed.maxFee).toBe(order.maxFee);
    expect(parsed.claims[0].amount).toBe(order.claims[0].amount);

    // Sign original and verify with parsed — should be identical
    const sig = await signOrder(alice, order);
    expect(isValidSignature(parsed, sig, CHAIN_ID, CONTRACT)).toBe(true);
  });

  it("order cancel prevents matching", async () => {
    const aliceOrder: Order = {
      maker: alice.address,
      sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      sellAmount: 10n * 10n ** 18n,
      buyAmount: 21000n * 10n ** 18n,
      maxFee: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 1n,
      claims: [{
        claimHash: "0x" + "dd".repeat(32),
        amount: 21000n * 10n ** 18n,
        releaseDelay: 3600n,
      }],
    };

    const aliceSig = await signOrder(alice, aliceOrder);
    book.add({ order: aliceOrder, signature: aliceSig });

    // Cancel before Bob submits
    book.cancel(alice.address, 1n);
    expect(book.getOrderCount()).toBe(0);

    // Bob submits — no match
    const bobOrder: Order = {
      maker: bob.address,
      sellToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      buyToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sellAmount: 21000n * 10n ** 18n,
      buyAmount: 10n * 10n ** 18n,
      maxFee: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 1n,
      claims: [{
        claimHash: "0x" + "ee".repeat(32),
        amount: 10n * 10n ** 18n,
        releaseDelay: 3600n,
      }],
    };

    const bobSig = await signOrder(bob, bobOrder);
    const storedBob = book.add({ order: bobOrder, signature: bobSig });

    const match = matcher.findMatch(storedBob);
    expect(match).toBeNull();
  });
});
