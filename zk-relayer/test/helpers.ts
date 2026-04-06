import type { PrivateOrder } from "../src/types/order.js";
import type { ClaimLeafData } from "../src/core/zk-prover.js";

const TOKEN_A = BigInt("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const TOKEN_B = BigInt("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

let nonceCounter = 1n;

export function makePrivateOrder(overrides: Partial<PrivateOrder> = {}): PrivateOrder {
  const nonce = nonceCounter++;
  return {
    sellToken: TOKEN_A,
    buyToken: TOKEN_B,
    sellAmount: 10n * 10n ** 18n,
    buyAmount: 21000n * 10n ** 18n,
    maxFee: 60n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    nonce,
    pubKeyAx: 1000n + nonce, // unique per order
    pubKeyAy: 2000n + nonce,
    sigS: 3000n,
    sigR8x: 4000n,
    sigR8y: 5000n,
    ownerSecret: 100n,
    balance: 100n * 10n ** 18n,
    salt: 200n,
    leafIndex: 0,
    claims: makeClaims(),
    ...overrides,
  };
}

export function makeClaims(count = 1): ClaimLeafData[] {
  return Array.from({ length: count }, (_, i) => ({
    secret: BigInt(9000 + i),
    recipient: BigInt("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
    token: TOKEN_B,
    amount: 21000n * 10n ** 18n / BigInt(count),
    releaseTime: BigInt(Math.floor(Date.now() / 1000) + 3600),
  }));
}

export { TOKEN_A, TOKEN_B };
