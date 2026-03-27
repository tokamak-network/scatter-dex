export interface ClaimInfo {
  claimHash: string; // bytes32
  amount: bigint;
  releaseDelay: bigint; // seconds
}

export interface Order {
  maker: string; // address
  sellToken: string; // address
  buyToken: string; // address
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint; // basis points
  expiry: bigint; // unix timestamp
  nonce: bigint;
  claims: ClaimInfo[];
}

export interface SignedOrder {
  order: Order;
  signature: string; // bytes
}

export type OrderStatus = "pending" | "matched" | "settled" | "cancelled" | "expired";

export interface StoredOrder extends SignedOrder {
  status: OrderStatus;
  submittedAt: number;
  matchId?: string;
  settleTxHash?: string;
}

// Token pair key: "0xTokenA-0xTokenB" (lowercase, sorted)
export function pairKey(tokenA: string, tokenB: string): string {
  const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${a}-${b}`;
}

// Parse order from JSON (string amounts → BigInt)
export function parseOrder(raw: any): Order {
  return {
    maker: raw.maker,
    sellToken: raw.sellToken,
    buyToken: raw.buyToken,
    sellAmount: BigInt(raw.sellAmount),
    buyAmount: BigInt(raw.buyAmount),
    maxFee: BigInt(raw.maxFee),
    expiry: BigInt(raw.expiry),
    nonce: BigInt(raw.nonce),
    claims: (raw.claims || []).map((c: any) => ({
      claimHash: c.claimHash,
      amount: BigInt(c.amount),
      releaseDelay: BigInt(c.releaseDelay),
    })),
  };
}

// EIP-712 typed data for order signing/verification
export const EIP712_DOMAIN = {
  name: "ScatterSettlement",
  version: "1",
};

export const EIP712_TYPES = {
  ClaimInfo: [
    { name: "claimHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "releaseDelay", type: "uint256" },
  ],
  Order: [
    { name: "maker", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "claims", type: "ClaimInfo[]" },
  ],
};
