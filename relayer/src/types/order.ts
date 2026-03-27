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

const MAX_CLAIMS = 10;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// Parse and validate order from JSON (string amounts → BigInt)
export function parseOrder(raw: Record<string, unknown>): Order {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid order");

  const maker = raw.maker as string;
  const sellToken = raw.sellToken as string;
  const buyToken = raw.buyToken as string;

  if (!ADDRESS_RE.test(maker)) throw new Error("invalid maker address");
  if (!ADDRESS_RE.test(sellToken)) throw new Error("invalid sellToken address");
  if (!ADDRESS_RE.test(buyToken)) throw new Error("invalid buyToken address");
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) throw new Error("sellToken == buyToken");

  const sellAmount = BigInt(raw.sellAmount as string);
  const buyAmount = BigInt(raw.buyAmount as string);
  if (sellAmount <= BigInt(0)) throw new Error("sellAmount must be > 0");
  if (buyAmount <= BigInt(0)) throw new Error("buyAmount must be > 0");

  const claims = raw.claims as Array<Record<string, unknown>>;
  if (!Array.isArray(claims) || claims.length === 0 || claims.length > MAX_CLAIMS) {
    throw new Error(`claims must be 1-${MAX_CLAIMS}`);
  }

  return {
    maker,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    maxFee: BigInt(raw.maxFee as string),
    expiry: BigInt(raw.expiry as string),
    nonce: BigInt(raw.nonce as string),
    claims: claims.map((c) => {
      if (!BYTES32_RE.test(c.claimHash as string)) throw new Error("invalid claimHash");
      const amount = BigInt(c.amount as string);
      if (amount <= BigInt(0)) throw new Error("claim amount must be > 0");
      return {
        claimHash: c.claimHash as string,
        amount,
        releaseDelay: BigInt(c.releaseDelay as string),
      };
    }),
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
