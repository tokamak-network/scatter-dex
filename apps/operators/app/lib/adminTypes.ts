/** Shared response shapes for the relayer's `/api/admin/*` endpoints,
 *  consumed by multiple operator-app pages. Lives in the app rather
 *  than `@zkscatter/sdk` because these are wire-format types for the
 *  relayer's HTTP admin surface — the SDK proper deals in on-chain
 *  contract types. Keep this file dependency-free (no React, no
 *  ethers) so every page can import it cheaply. */

/** One row from `GET /api/admin/history`. Mirrors the
 *  `settlement_history` schema on the relayer side; field names use
 *  snake_case to match the JSON response verbatim — converting on
 *  the client would just add a copy without typing benefit. */
export interface SettlementRow {
  id: number;
  tx_hash: string;
  type: "settleAuth" | "scatterDirectAuth";
  status: "confirmed" | "failed";
  block_number: number | null;
  gas_cost_eth: string | null;
  sell_token: string | null;
  buy_token: string | null;
  /** Decimal-wei notional for each leg of the trade. Null on rows
   *  recorded before these columns existed (pre-analytics) and on
   *  rows back-filled from shared-OB when the indexer didn't have
   *  the amount. Render "—" for null. */
  sell_amount: string | null;
  buy_amount: string | null;
  /** Per-token fee accrual for this tx, attached by /api/admin/history.
   *  Multiple entries when a same-relayer match credited fees in two
   *  different tokens (one per side). Empty array on failed rows or
   *  rows whose fee accruals never persisted.
   *
   *  Optional because an older relayer the dashboard happens to be
   *  connected to won't include the field; consumers should treat
   *  `undefined` and `[]` identically (default to "—"). */
  fees?: Array<{ token: string; amountWei: string }>;
  error_reason: string | null;
  created_at: number;
}

/** Decoded `settleAuth` / `scatterDirectAuth` public signals, returned
 *  by `GET /api/admin/orders/by-tx/{txHash}/proof`. Structurally
 *  identical to `zk-relayer/src/core/decode-settlement.ts`'s
 *  `AuthorizeProofSignals` — duplicated as a wire type rather than
 *  imported because the operators app does not share a tsconfig path
 *  with the zk-relayer workspace. If the proof tuple ever grows,
 *  both sides update. */
export interface AuthorizeProofSignals {
  pubKeyBind: string;
  commitmentRoot: string;
  nullifier: string;
  nonceNullifier: string;
  newCommitment: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: number;
  expiry: string;
  claimsRoot: string;
  totalLocked: string;
  relayer: string;
  orderHash: string;
  tier: number;
}
