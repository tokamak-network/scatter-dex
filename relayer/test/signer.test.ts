import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { Order, EIP712_DOMAIN, EIP712_TYPES } from "../src/types/order.js";
import { verifyOrderSignature, isValidSignature } from "../src/core/signer.js";

const CHAIN_ID = 31337n;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

function makeOrder(maker: string): Order {
  return {
    maker,
    sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    sellAmount: 10n * 10n ** 18n,
    buyAmount: 21000n * 10n ** 18n,
    maxFee: 30n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    nonce: 1n,
    claims: [
      {
        claimHash: "0x" + "ab".repeat(32),
        amount: 21000n * 10n ** 18n,
        releaseDelay: 3600n,
      },
    ],
  };
}

async function signOrder(wallet: ethers.Wallet, order: Order): Promise<string> {
  const domain = {
    ...EIP712_DOMAIN,
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT,
  };

  return wallet.signTypedData(domain, EIP712_TYPES, {
    ...order,
    claims: order.claims.map((c) => ({
      claimHash: c.claimHash,
      amount: c.amount,
      releaseDelay: c.releaseDelay,
    })),
  });
}

describe("Signer", () => {
  const wallet = ethers.Wallet.createRandom();

  it("verifies a valid signature", async () => {
    const order = makeOrder(wallet.address);
    const sig = await signOrder(wallet, order);

    const recovered = verifyOrderSignature(order, sig, CHAIN_ID, CONTRACT);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("isValidSignature returns true for valid sig", async () => {
    const order = makeOrder(wallet.address);
    const sig = await signOrder(wallet, order);

    expect(isValidSignature(order, sig, CHAIN_ID, CONTRACT)).toBe(true);
  });

  it("isValidSignature returns false for wrong maker", async () => {
    const order = makeOrder("0x0000000000000000000000000000000000000001");
    const sig = await signOrder(wallet, order);

    // Signature is from wallet, but order.maker is different
    expect(isValidSignature(order, sig, CHAIN_ID, CONTRACT)).toBe(false);
  });

  it("isValidSignature returns false for tampered order", async () => {
    const order = makeOrder(wallet.address);
    const sig = await signOrder(wallet, order);

    // Tamper with amount
    const tampered = { ...order, sellAmount: 999n * 10n ** 18n };
    expect(isValidSignature(tampered, sig, CHAIN_ID, CONTRACT)).toBe(false);
  });

  it("isValidSignature returns false for wrong chain", async () => {
    const order = makeOrder(wallet.address);
    const sig = await signOrder(wallet, order);

    expect(isValidSignature(order, sig, 1n, CONTRACT)).toBe(false);
  });
});
