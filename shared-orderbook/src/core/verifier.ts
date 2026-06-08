/**
 * Phase 2.5b — settlement verifier. Relayers push their settlement rows
 * to the orderbook over a signed HTTP API; until the chain confirms the
 * tx actually happened we keep those rows as `verified = 0` so the
 * `*verified` aggregates (leaderboard, network totals, volume) reject
 * unconfirmed self-reports.
 *
 * The verify job is a periodic pass that:
 *   1. Reads unverified settlements from the DB.
 *   2. Fetches `PrivateSettledAuth` event logs for the block window
 *      they span (one chain round-trip, not one per row).
 *   3. Indexes the events by `(makerNullifier, takerNullifier)`.
 *   4. For every unverified row whose nullifier pair is present in the
 *      event index AND whose tx_hash matches the event's tx hash AND
 *      whose maker/taker relayer addresses match the on-chain values,
 *      flips `verified = 1` and backfills `block_time`.
 *
 * The matching itself is a pure function — the on-chain log fetcher is
 * injected so unit tests can stub it. The runner lives next to it for
 * convenience; the actual ethers `Contract.queryFilter` call belongs in
 * the operator-side CLI / cron entry point so this package stays
 * provider-agnostic.
 */
import type { OrderbookDB } from "./db.js";
import type { StoredSettlement } from "../types/settlement.js";

/**
 * Minimal projection of a `PrivateSettledAuth` event log carrying just
 * the fields the verifier needs. `nullifier` values are hex-prefixed
 * lower-case bytes32 strings to match what relayers store in SQLite
 * (the columns are TEXT and the SDK already normalises to lower case).
 */
export interface SettledAuthEvent {
  txHash: string;
  blockNumber: number;
  blockTime?: number;
  makerNullifier: string;
  takerNullifier: string;
  makerRelayer: string;
  /** Required: `PrivateSettledAuth` always emits a `takerRelayer` (zero
   *  address on one-sided settles). Making this non-optional in the
   *  projection prevents a fetcher from accidentally dropping it and
   *  weakening the "maker/taker relayer agreement" check below. */
  takerRelayer: string;
}

export interface VerifyDecision {
  txHash: string;
  blockTime?: number;
}

export interface VerifyReport {
  matched: VerifyDecision[];
  /** Rows we looked at but didn't match — either no event, or a
   *  mismatched tx hash / relayer address (likely tampering or a
   *  different relayer claiming credit for someone else's tx). */
  unmatched: { txHash: string; reason: "no-event" | "tx-mismatch" | "relayer-mismatch" }[];
}

function normHash(h: string | undefined | null): string {
  return (h ?? "").toLowerCase();
}

function eqAddr(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Pure matching pass. Takes a batch of unverified DB rows plus the
 * event window that covers them, returns which rows can be flipped.
 * Does not touch the DB so it's trivially testable.
 */
export function matchSettlements(
  unverified: Pick<
    StoredSettlement,
    "txHash" | "makerNullifier" | "takerNullifier" | "makerRelayer" | "takerRelayer"
  >[],
  events: SettledAuthEvent[],
): VerifyReport {
  // Index events by the nullifier pair. Both nullifiers are indexed in
  // the event, so a one-shot getLogs over the block window is enough —
  // no per-row RPC fan-out.
  const byPair = new Map<string, SettledAuthEvent>();
  for (const ev of events) {
    const key = `${normHash(ev.makerNullifier)}|${normHash(ev.takerNullifier)}`;
    byPair.set(key, ev);
  }

  const matched: VerifyDecision[] = [];
  const unmatched: VerifyReport["unmatched"] = [];

  for (const row of unverified) {
    const key = `${normHash(row.makerNullifier)}|${normHash(row.takerNullifier)}`;
    const ev = byPair.get(key);
    if (!ev) {
      unmatched.push({ txHash: row.txHash, reason: "no-event" });
      continue;
    }
    if (normHash(ev.txHash) !== normHash(row.txHash)) {
      unmatched.push({ txHash: row.txHash, reason: "tx-mismatch" });
      continue;
    }
    if (!eqAddr(ev.makerRelayer, row.makerRelayer)) {
      unmatched.push({ txHash: row.txHash, reason: "relayer-mismatch" });
      continue;
    }
    if (row.takerRelayer && !eqAddr(ev.takerRelayer, row.takerRelayer)) {
      unmatched.push({ txHash: row.txHash, reason: "relayer-mismatch" });
      continue;
    }
    matched.push({ txHash: row.txHash, blockTime: ev.blockTime });
  }

  return { matched, unmatched };
}

/**
 * Fetcher contract — the CLI / cron wires this to
 * `ethers.Contract.queryFilter(PrivateSettledAuth, fromBlock, toBlock)`.
 * Tests inject a stub.
 */
export type EventFetcher = (fromBlock: number, toBlock: number) => Promise<SettledAuthEvent[]>;

/**
 * Orchestrates one verifier pass:
 *   - pulls unverified rows up to `maxBlock`
 *   - fetches events for the matching block window
 *   - matches and writes the flips back to the DB
 *
 * Returns a report so the caller can log / alert.
 */
export async function runVerifyPass(
  db: OrderbookDB,
  fetcher: EventFetcher,
  opts: { chainId: number; maxBlock?: number; limit?: number },
): Promise<{ scanned: number; flipped: number; report: VerifyReport }> {
  // Scoped to one chain: this pass's fetcher binds a single network's RPC +
  // settlement contract, so it must only pull that network's unverified rows.
  const rows = db.listUnverifiedSettlements({ chainId: opts.chainId, maxBlock: opts.maxBlock, limit: opts.limit });
  if (rows.length === 0) {
    return { scanned: 0, flipped: 0, report: { matched: [], unmatched: [] } };
  }
  const fromBlock = rows[0]!.blockNumber;
  const toBlock = rows[rows.length - 1]!.blockNumber;
  const events = await fetcher(fromBlock, toBlock);
  const report = matchSettlements(rows, events);
  const flipped = db.markSettlementsVerified(report.matched);
  return { scanned: rows.length, flipped, report };
}
