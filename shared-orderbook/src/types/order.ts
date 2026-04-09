/**
 * Order summary — the public subset posted by relayers.
 * No secrets (ownerSecret, salt, balance, EdDSA keys, claims).
 */
export interface OrderSummary {
  id: string;            // "{relayerAddress}-{nonce}" unique composite key
  relayer: string;       // relayer Ethereum address (lowercase)
  relayerUrl: string;    // relayer REST endpoint
  nonce: string;         // order nonce (unique per relayer)
  sellToken: string;     // token address (0x-prefixed hex)
  buyToken: string;      // token address (0x-prefixed hex)
  sellAmount: string;    // wei string
  buyAmount: string;     // wei string
  minFillAmount: string; // minimum fill amount (wei string)
  maxFee: number;        // fee in basis points
  expiry: number;        // unix timestamp (seconds)
  createdAt: number;     // unix timestamp (seconds)
}

export type OrderStatus = "open" | "matched" | "cancelled" | "expired";

export interface StoredOrder {
  order: OrderSummary;
  status: OrderStatus;
  matchId?: string;
}

export interface MatchResult {
  matchId: string;
  maker: OrderSummary;
  taker: OrderSummary;
  settlingRelayer: string;  // maker's relayer address (Phase 1: maker's relayer settles)
  pair: string;             // e.g. "0xabc-0xdef"
  price: string;            // taker.sellAmount / taker.buyAmount as string
  createdAt: number;
}

export interface MatchNotification {
  matchId: string;
  maker: { id: string; relayer: string; relayerUrl: string };
  taker: { id: string; relayer: string; relayerUrl: string };
  settlingRelayer: string;
  pair: string;
  price: string;
}

// Token pair key: sorted lowercase addresses joined with "-"
export function pairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validate a "tokenA-tokenB" pair string (both must be valid addresses) */
export function isValidPair(pair: string): [string, string] | null {
  // Ethereum addresses contain hex chars, no "-" — safe to split on first "-" at index 42
  const a = pair.slice(0, 42);
  const b = pair.slice(43);
  if (pair[42] !== "-") return null;
  if (!ETH_ADDRESS_RE.test(a) || !ETH_ADDRESS_RE.test(b)) return null;
  return [a, b];
}

export function parseOrderSummary(
  raw: Record<string, unknown>,
  relayer: string,
  relayerUrl: string,
): OrderSummary {
  const sellToken = String(raw.sellToken ?? "");
  const buyToken = String(raw.buyToken ?? "");
  const sellAmount = String(raw.sellAmount ?? "");
  const buyAmount = String(raw.buyAmount ?? "");
  const minFillAmount = String(raw.minFillAmount ?? "0");
  const maxFee = Number(raw.maxFee);
  const expiry = Number(raw.expiry);
  const nonce = String(raw.nonce ?? "");

  if (!ETH_ADDRESS_RE.test(sellToken)) throw new Error("invalid sellToken address");
  if (!ETH_ADDRESS_RE.test(buyToken)) throw new Error("invalid buyToken address");
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) throw new Error("sellToken == buyToken");

  if (!sellAmount || BigInt(sellAmount) <= 0n) throw new Error("sellAmount must be > 0");
  if (!buyAmount || BigInt(buyAmount) <= 0n) throw new Error("buyAmount must be > 0");
  if (minFillAmount && BigInt(minFillAmount) < 0n) throw new Error("minFillAmount must be >= 0");

  if (!Number.isFinite(maxFee) || maxFee < 0) throw new Error("maxFee must be >= 0");
  if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("invalid expiry");
  if (!nonce) throw new Error("missing nonce");

  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now) throw new Error("order already expired");

  const id = `${relayer.toLowerCase()}-${nonce}`;

  return {
    id,
    relayer: relayer.toLowerCase(),
    relayerUrl,
    nonce,
    sellToken: sellToken.toLowerCase(),
    buyToken: buyToken.toLowerCase(),
    sellAmount,
    buyAmount,
    minFillAmount: minFillAmount || "0",
    maxFee,
    expiry,
    createdAt: now,
  };
}
