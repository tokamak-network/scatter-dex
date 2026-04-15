/**
 * Settlement records — written by relayers via POST /api/settlements after a
 * successful settle tx, joined opportunistically with still-present
 * OrderSummary rows for token/amount snapshotting. See
 * docs/design/relayer-pages-redesign.md §7.
 *
 * `verified` stays 0 until a future verify job (Phase 2.5b) confirms the
 * on-chain receipt and `PrivateSettledAuth` event. Reads in Phase 2.5c
 * choose whether to expose unverified rows.
 */

export interface SettlementInsert {
  txHash: string;
  blockNumber: number;
  blockTime?: number; // optional — relayer doesn't always know yet
  makerRelayer: string;
  takerRelayer?: string;
  makerOrderId?: string;
  takerOrderId?: string;
  makerNullifier: string;
  takerNullifier: string;
  feeMaker: string;
  feeTaker: string;
  userMaxFeeMaker: number;
  userMaxFeeTaker: number;
  // Optional snapshot fields — server fills these from the orders table
  // when present, but accepts overrides for direct-auth paths that don't
  // have a maker order in the shared orderbook.
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
}

export interface StoredSettlement extends SettlementInsert {
  submitter: string;
  verified: boolean;
  createdAt: number;
}

export interface SettlementListFilter {
  relayer?: string;       // matches submitter OR makerRelayer OR takerRelayer
  pair?: [string, string]; // [tokenA, tokenB] sorted, both directions counted
  since?: number;          // unix seconds
  limit?: number;
  offset?: number;
}

/** Per-token totals — same shape used by per-relayer + network read APIs. */
export interface TokenVolumeRow {
  token: string;       // 0x-prefixed lowercase address
  totalSell: string;   // sum of sell_amount as a decimal string (BigInt-summed)
  totalBuy: string;    // sum of buy_amount
  sellCount: number;   // rows where this token appears as sellToken
  buyCount: number;    // rows where this token appears as buyToken
}

export interface RelayerSettlementStats {
  address: string;          // lowercased input
  txCount: number;          // total settlements where the relayer is submitter, maker, or taker
  txCountVerified: number;  // subset with verified=1
  volumeByToken: TokenVolumeRow[];
  pairs: Array<{ sellToken: string; buyToken: string; count: number }>;
  /**
   * Mean effective fee in bps (fee_token_amount × 10000 / buy_amount),
   * averaged across every side the relayer participated in. Both sides
   * of every row contribute. `null` when no rows have a non-zero buy.
   *
   * NB: this is the realised fee rate, not the design-doc "take ratio
   * over the user-signed cap". A separate metric for cap-utilisation can
   * be added in 3a/3b once the leaderboard view defines what it wants.
   */
  avgFeeBps: number | null;
  /**
   * Verified-fraction of all rows. `null` until at least one row is
   * verified — pre-2.5b that's the entire window, so the dashboard
   * shouldn't render a misleading "0%".
   */
  successRate: number | null;
  /**
   * Newest activity timestamp using `COALESCE(block_time, created_at)`
   * from the newest matching row. `block_time` is used whenever present
   * regardless of `verified` (so the field works pre-2.5b), falling back
   * to the server-clock `created_at` for rows without a block time yet.
   * `null` only when no rows exist.
   */
  lastSettleAt: number | null;
}

export interface NetworkSettlementTotals {
  txCount: number;
  txCountVerified: number;
  volumeByToken: TokenVolumeRow[];
  activePairs: number;
  activeRelayers: number;
  lastSettleAt: number | null;
}

const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^\d+$/;

function isStringField(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNonNegativeBigInt(v: unknown): boolean {
  if (!isStringField(v)) return false;
  if (!DECIMAL_RE.test(v)) return false;
  // Cheap shape check above; BigInt() wouldn't throw on "0" or huge values
  // but DECIMAL_RE already rules out signs / exponents / hex.
  return true;
}

/** Validates and normalises an incoming settlement payload. Throws with a
 *  human-readable message on bad input — caller maps to 400. Optional
 *  fields, when *present*, are also validated: silently dropping a
 *  bad-but-present field would mask client bugs. */
export function parseSettlementInsert(input: unknown): SettlementInsert {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("body must be a JSON object");
  }
  const r = input as Record<string, unknown>;

  if (!isStringField(r.txHash) || !HEX_BYTES32.test(r.txHash)) {
    throw new Error("txHash: must be a 0x-prefixed 32-byte hex string");
  }
  if (!Number.isSafeInteger(r.blockNumber) || (r.blockNumber as number) < 0) {
    throw new Error("blockNumber: must be a non-negative integer");
  }
  if (!isStringField(r.makerRelayer) || !HEX_ADDR.test(r.makerRelayer)) {
    throw new Error("makerRelayer: must be a 0x-prefixed 20-byte address");
  }
  if (r.takerRelayer !== undefined && (!isStringField(r.takerRelayer) || !HEX_ADDR.test(r.takerRelayer))) {
    throw new Error("takerRelayer: must be a 0x-prefixed address when provided");
  }
  for (const f of ["makerNullifier", "takerNullifier"] as const) {
    if (!isStringField(r[f])) throw new Error(`${f}: must be a non-empty string`);
  }
  for (const f of ["feeMaker", "feeTaker"] as const) {
    if (!isNonNegativeBigInt(r[f])) {
      throw new Error(`${f}: must be a non-negative decimal string`);
    }
  }
  for (const f of ["userMaxFeeMaker", "userMaxFeeTaker"] as const) {
    const v = r[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000) {
      throw new Error(`${f}: must be an integer in [0, 10000] (basis points)`);
    }
  }

  // Optional snapshot fields — when *present*, validate them. Silently
  // dropping a bad-but-present token field would mask client bugs.
  if (r.blockTime !== undefined) {
    if (!Number.isSafeInteger(r.blockTime) || (r.blockTime as number) < 0) {
      throw new Error("blockTime: must be a non-negative integer (unix seconds)");
    }
  }
  if (r.sellToken !== undefined && (!isStringField(r.sellToken) || !HEX_ADDR.test(r.sellToken))) {
    throw new Error("sellToken: must be a 0x-prefixed 20-byte address when provided");
  }
  if (r.buyToken !== undefined && (!isStringField(r.buyToken) || !HEX_ADDR.test(r.buyToken))) {
    throw new Error("buyToken: must be a 0x-prefixed 20-byte address when provided");
  }
  if (r.sellAmount !== undefined && !isNonNegativeBigInt(r.sellAmount)) {
    throw new Error("sellAmount: must be a non-negative decimal string when provided");
  }
  if (r.buyAmount !== undefined && !isNonNegativeBigInt(r.buyAmount)) {
    throw new Error("buyAmount: must be a non-negative decimal string when provided");
  }

  const out: SettlementInsert = {
    txHash: r.txHash.toLowerCase(),
    blockNumber: r.blockNumber as number,
    makerRelayer: (r.makerRelayer as string).toLowerCase(),
    makerNullifier: r.makerNullifier as string,
    takerNullifier: r.takerNullifier as string,
    feeMaker: r.feeMaker as string,
    feeTaker: r.feeTaker as string,
    userMaxFeeMaker: r.userMaxFeeMaker as number,
    userMaxFeeTaker: r.userMaxFeeTaker as number,
  };
  if (typeof r.blockTime === "number") out.blockTime = r.blockTime;
  if (r.takerRelayer) out.takerRelayer = (r.takerRelayer as string).toLowerCase();
  if (isStringField(r.makerOrderId)) out.makerOrderId = r.makerOrderId;
  if (isStringField(r.takerOrderId)) out.takerOrderId = r.takerOrderId;
  if (r.sellToken) out.sellToken = (r.sellToken as string).toLowerCase();
  if (r.buyToken) out.buyToken = (r.buyToken as string).toLowerCase();
  if (r.sellAmount) out.sellAmount = r.sellAmount as string;
  if (r.buyAmount) out.buyAmount = r.buyAmount as string;

  return out;
}
