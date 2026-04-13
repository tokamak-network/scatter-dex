/**
 * @scatter-dex/types — Shared type definitions between
 * shared-orderbook server and zk-relayer.
 */

// ─── Order Summary (public listing on shared orderbook) ───

/**
 * Public order summary posted by relayers to the shared orderbook.
 * Contains NO owner-identifying fields: no EdDSA public key coordinate,
 * no user-visible nonce. Cross-relayer matching uses the opaque `id`
 * (see OFFER_HANDLE_RE) which the maker's relayer resolves internally.
 */
export interface OrderSummary {
  /** Opaque offer handle (matches {@link OFFER_HANDLE_RE}). Also used
   *  as the target in `TradeOfferRequest.offerHandle`. */
  id: string;
  relayer: string;       // relayer Ethereum address (lowercase)
  relayerUrl: string;    // relayer REST endpoint
  sellToken: string;     // token address (0x-prefixed hex, lowercase)
  buyToken: string;      // token address (0x-prefixed hex, lowercase)
  sellAmount: string;    // wei string
  buyAmount: string;     // wei string
  minFillAmount: string; // minimum fill amount (wei string)
  maxFee: number;        // fee in basis points
  expiry: number;        // unix timestamp (seconds)
  createdAt: number;     // unix timestamp (seconds)
}

// ─── Shared Orderbook types ───

export type OrderStatus = "open" | "matched" | "cancelled" | "expired";

export interface StoredOrder {
  order: OrderSummary;
  status: OrderStatus;
  matchId?: string;
}

export interface ServerMatchResult {
  matchId: string;
  maker: OrderSummary;
  taker: OrderSummary;
  settlingRelayer: string;  // maker's relayer address (Phase 1: maker's relayer settles)
  pair: string;
  price: string;
  createdAt: number;
}

// ─── Trade Offer types (cross-relayer settlement) ───

export interface TradeOfferRequest {
  /** Opaque handle identifying the maker's order on the shared orderbook.
   *  The maker's relayer resolves this internally to its (pubKeyAx, nonce)
   *  entry — those values never cross the network. */
  offerHandle: string;
  takerOrder: Record<string, unknown>;
}

export interface TradeOfferResponse {
  status: "rejected" | "settled";
  txHash?: string;
  reason?: string;
}

// ─── WebSocket broadcast events ───

export type BroadcastEvent =
  | { type: "order:new"; order: OrderSummary }
  | { type: "order:cancelled"; orderId: string; relayer: string }
  | { type: "order:expired"; orderId: string }
  | { type: "relayer:registered"; relayer: string; url: string }
  | { type: "relayer:offline"; relayer: string };

// ─── Helpers ───

/** Token pair key: sorted lowercase addresses joined with "-" */
export function pairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Offer handle: opaque 32-byte hex identifier used on the shared
 *  orderbook. Unlinkable to the user's EdDSA public key. */
export const OFFER_HANDLE_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate a "tokenA-tokenB" pair string (both must be valid 0x addresses) */
export function isValidPair(pair: string): [string, string] | null {
  // Ethereum addresses = 42 chars (0x + 40 hex), so split at index 42 is safe
  const a = pair.slice(0, 42);
  const b = pair.slice(43);
  if (pair[42] !== "-") return null;
  if (!ETH_ADDRESS_RE.test(a) || !ETH_ADDRESS_RE.test(b)) return null;
  return [a, b];
}
