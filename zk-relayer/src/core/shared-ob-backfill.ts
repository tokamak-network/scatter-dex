/**
 * One-shot reconciler: pulls settlement rows from shared-OB that this
 * relayer participated in but doesn't have locally, and reinserts them
 * into `settlement_history` + `fee_history`.
 *
 * Use case: the relayer's local DB was reset (or rows manually
 * deleted) before the push-outbox shipped, so analytics under-reports
 * by exactly those rows. The push-outbox prevents future drift in
 * the *other* direction (local → shared-OB); this module closes the
 * historical gap in this direction (shared-OB → local).
 *
 * Triggered via `POST /api/admin/push-outbox/backfill-from-shared-ob`.
 * Not a background loop — re-running it idempotently is safe (the
 * insert path uses INSERT OR IGNORE on tx_hash so a re-run after a
 * partial reset is a no-op for rows already restored).
 */

import type { PrivateOrderDB } from "./db.js";
import type { SharedOrderbookClient } from "./shared-orderbook-client.js";
import { createLogger } from "./logger.js";
import { eqAddr } from "../lib/address.js";

const log = createLogger("shared-ob-backfill");

const PAGE_SIZE = 200;
// Bound the scan so a misconfigured caller (since=0 on a huge history)
// doesn't lock up the worker thread. Realistic operator history fits
// in a handful of pages; this just guarantees the call returns.
const MAX_PAGES = 50;

export interface BackfillResult {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
  pages: number;
}

export interface BackfillDeps {
  db: PrivateOrderDB;
  sharedClient: Pick<SharedOrderbookClient, "fetchSettlementsForAddress">;
  ownAddress: string;
}

export async function backfillFromSharedOb(
  deps: BackfillDeps,
  opts: { since?: number } = {},
): Promise<BackfillResult> {
  const ourAddr = deps.ownAddress;
  const result: BackfillResult = { scanned: 0, inserted: 0, skipped: 0, errors: 0, pages: 0 };

  // The API contract takes `since` as **unix-ms** to stay consistent
  // with every other admin endpoint (settlement_history filters,
  // /history/fees, etc.) — but shared-OB's GET /api/settlements
  // expects **unix-seconds** (its parseSinceQuery floors at 1e9).
  // Convert here so callers can keep using one unit; reject NaN/Inf/
  // negative so a typo doesn't silently scan from epoch.
  let sinceSeconds: number | undefined;
  if (opts.since !== undefined) {
    if (!Number.isFinite(opts.since) || opts.since < 0) {
      throw new Error(`backfill: invalid 'since' value ${opts.since} — expected non-negative unix-ms`);
    }
    sinceSeconds = Math.floor(opts.since / 1000);
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await deps.sharedClient.fetchSettlementsForAddress(ourAddr, {
      since: sinceSeconds,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    result.pages++;
    if (rows.length === 0) break;
    for (const row of rows) {
      result.scanned++;
      try {
        if (insertIfMissing(deps.db, row, ourAddr)) {
          result.inserted++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.errors++;
        log.warn("backfill row failed", {
          tx: typeof row.txHash === "string" ? row.txHash.slice(0, 18) + "..." : "?",
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Hitting the page cap means we successfully drained MAX_PAGES *
  // PAGE_SIZE rows AND the last page was full — there may be more
  // historical rows we didn't reach. Surface as a warning the
  // operator can act on (re-run with a tighter `since`).
  if (result.pages === MAX_PAGES && result.scanned === MAX_PAGES * PAGE_SIZE) {
    log.warn("backfill hit page cap — older rows may not have been scanned", {
      scanned: result.scanned,
      pageCap: MAX_PAGES,
    });
  }

  log.info("backfill complete", { ...result });
  return result;
}

/** Returns true if a new row was inserted, false if the local DB
 *  already had it (the caller increments skipped). Throws on
 *  structurally invalid payloads. */
function insertIfMissing(
  db: PrivateOrderDB,
  row: Record<string, unknown>,
  ourAddr: string,
): boolean {
  const txHash = readString(row, "txHash");
  if (!txHash) throw new Error("row missing txHash");
  if (db.getSettlementByTxHash(txHash)) return false;

  const maker = readString(row, "makerRelayer");
  const taker = readString(row, "takerRelayer");
  const isMaker = !!maker && eqAddr(maker, ourAddr);
  const isTaker = !!taker && eqAddr(taker, ourAddr);
  if (!isMaker && !isTaker) {
    // The shared-OB filter returned us under `submitter` only — this
    // node submitted but neither side was our user. Nothing fee-wise
    // accrued to us; skip rather than fabricate a row.
    return false;
  }

  const sellToken = readString(row, "sellToken") ?? null;
  const buyToken = readString(row, "buyToken") ?? null;
  const sellAmount = readString(row, "sellAmount") ?? null;
  const buyAmount = readString(row, "buyAmount") ?? null;
  const feeMaker = readString(row, "feeMaker");
  const feeTaker = readString(row, "feeTaker");
  const blockNumber = readNumber(row, "blockNumber");

  // scatterDirectAuth on shared-OB: taker_relayer is NULL. Single fee
  // row tagged 'scatterDirect', in the sellToken (which equals the
  // buyToken for same-token Pay).
  const isScatterDirect = !taker;

  // Build the fees array based on which side(s) we held. Matches the
  // attribution the live submitter path uses in authorize-submitter.ts.
  const fees: Array<{ side: "maker" | "taker" | "scatterDirect"; token: string; amountWei: string }> = [];
  if (isScatterDirect && isMaker && sellToken && feeMaker && BigInt(feeMaker) > 0n) {
    fees.push({ side: "scatterDirect", token: sellToken, amountWei: feeMaker });
  } else {
    if (isMaker && buyToken && feeMaker && BigInt(feeMaker) > 0n) {
      fees.push({ side: "maker", token: buyToken, amountWei: feeMaker });
    }
    if (isTaker && sellToken && feeTaker && BigInt(feeTaker) > 0n) {
      // Taker's fee accrues in the taker's buyToken, which from the
      // row's perspective is sellToken (maker's sell = taker's buy).
      fees.push({ side: "taker", token: sellToken, amountWei: feeTaker });
    }
  }

  // For settlement_history, prefer the side we held:
  //  - submitter (isMaker, single-relayer or cross-relayer maker): use maker's sell leg
  //  - cross-relayer counterparty (isTaker only): use taker's sell leg = row.buyToken/buyAmount
  // settlement_history is INSERT OR IGNORE on tx_hash so a single row
  // is correct even when both sides were us (single-relayer match) —
  // the per-side fee accrual is what splits the credit.
  const rowSellToken = isMaker ? sellToken : buyToken;
  const rowSellAmount = isMaker ? sellAmount : buyAmount;
  const rowBuyToken = isMaker ? buyToken : sellToken;
  const rowBuyAmount = isMaker ? buyAmount : sellAmount;

  db.recordSettlementEvent({
    txHash,
    type: isScatterDirect ? "scatterDirectAuth" : "settleAuth",
    status: "confirmed",
    blockNumber,
    sellToken: rowSellToken,
    buyToken: rowBuyToken,
    sellAmount: rowSellAmount,
    buyAmount: rowBuyAmount,
    counterparty: !isMaker && isTaker,
    fees: fees.length > 0 ? fees : undefined,
  });
  return true;
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(row: Record<string, unknown>, key: string): number | undefined {
  const v = row[key];
  return typeof v === "number" ? v : undefined;
}
