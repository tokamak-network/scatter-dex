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

const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

function isStringField(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Validates and normalises an incoming settlement payload. Throws with a
 *  human-readable message on bad input — caller maps to 400. */
export function parseSettlementInsert(input: unknown): SettlementInsert {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("body must be a JSON object");
  }
  const r = input as Record<string, unknown>;

  if (!isStringField(r.txHash) || !HEX_BYTES32.test(r.txHash)) {
    throw new Error("txHash: must be a 0x-prefixed 32-byte hex string");
  }
  if (!Number.isFinite(r.blockNumber) || (r.blockNumber as number) < 0) {
    throw new Error("blockNumber: must be a non-negative number");
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
    if (!isStringField(r[f])) throw new Error(`${f}: must be a non-empty decimal string`);
  }
  for (const f of ["userMaxFeeMaker", "userMaxFeeTaker"] as const) {
    const v = r[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000) {
      throw new Error(`${f}: must be an integer in [0, 10000] (basis points)`);
    }
  }

  const out: SettlementInsert = {
    txHash: r.txHash.toLowerCase(),
    blockNumber: Number(r.blockNumber),
    makerRelayer: (r.makerRelayer as string).toLowerCase(),
    makerNullifier: r.makerNullifier as string,
    takerNullifier: r.takerNullifier as string,
    feeMaker: r.feeMaker as string,
    feeTaker: r.feeTaker as string,
    userMaxFeeMaker: r.userMaxFeeMaker as number,
    userMaxFeeTaker: r.userMaxFeeTaker as number,
  };
  if (typeof r.blockTime === "number" && Number.isFinite(r.blockTime)) {
    out.blockTime = r.blockTime;
  }
  if (r.takerRelayer) out.takerRelayer = (r.takerRelayer as string).toLowerCase();
  if (isStringField(r.makerOrderId)) out.makerOrderId = r.makerOrderId;
  if (isStringField(r.takerOrderId)) out.takerOrderId = r.takerOrderId;
  if (isStringField(r.sellToken) && HEX_ADDR.test(r.sellToken)) out.sellToken = (r.sellToken as string).toLowerCase();
  if (isStringField(r.buyToken) && HEX_ADDR.test(r.buyToken)) out.buyToken = (r.buyToken as string).toLowerCase();
  if (isStringField(r.sellAmount)) out.sellAmount = r.sellAmount;
  if (isStringField(r.buyAmount)) out.buyAmount = r.buyAmount;

  return out;
}
