/**
 * SettlementWorker — consumes the async-settlement queue and drives each
 * accepted/retrying order through submitScatterDirectAuth (same-token) or
 * findMatch + submitAuthSettle (cross-token).
 *
 * Error classification:
 *   - permanent (revert / nonce / invalid args) → mark `failed`, no retry.
 *   - transient (timeout / 5xx / connection reset) → schedule next retry
 *     per SETTLEMENT_RETRY_SCHEDULE_MS; after MAX_SETTLEMENT_ATTEMPTS the
 *     order lands in `dead_letter` for manual inspection.
 *   - unknown  → one retry as a safety net, then `failed`.
 *
 * Concurrency is 1 — matches the relayer-wide `withTxLock` so lifting the
 * limit is a follow-up that pairs with the nonce manager (design §2.6).
 *
 * See docs/design/async-settlement-protocol.md §2.2 + §2.5.
 */

import type { PrivateOrderDB, AuthorizeOrderRow } from "./db.js";
import type { AuthorizeSubmitter } from "./authorize-submitter.js";
import type {
  AuthorizeOrderFile,
  AuthorizeMatch,
  StoredAuthorizeOrder,
} from "../types/authorize-order.js";
import type { SharedOrderbookClient } from "./shared-orderbook-client.js";

export const SETTLEMENT_RETRY_SCHEDULE_MS = [
  2_000, 8_000, 30_000, 120_000, 300_000,
] as const;
export const MAX_SETTLEMENT_ATTEMPTS = SETTLEMENT_RETRY_SCHEDULE_MS.length;

/** How long to park a cross-token order that found no counterparty. Not a
 *  retry (attempt isn't bumped) — the worker just re-checks later in case
 *  a matching order has been posted since. Cross-relayer match callbacks
 *  will also re-queue the order by calling `insertAcceptedOrder`-adjacent
 *  code paths, so this is a safety net for POST-only deployments. */
export const NO_MATCH_REPOLL_MS = 30_000;

/** Hard cap on how many jobs a single tick will drain. Without this, a
 *  burst of N accepted orders blocks one tick for N × per-job latency,
 *  starving other intervals (purge, expiry sweeper). The next tick picks
 *  up where this one left off, so the cap costs at most pollIntervalMs of
 *  added latency per cap-sized batch. */
export const MAX_JOBS_PER_TICK = 10;

// Mirrors tx-retry.ts. Duplicated deliberately — the worker decides retry
// *scheduling* (minutes-scale), whereas tx-retry decides retry *within one
// call* (seconds-scale). Sharing the strings but not the behaviour.
const PERMANENT_PATTERNS = [
  "revert",
  "execution reverted",
  "insufficient funds",
  "nonce too low",
  "replacement fee too low",
  "invalid argument",
  "invalid address",
  "unpredictable_gas_limit",
];
const TRANSIENT_PATTERNS = [
  "timeout",
  "econnrefused",
  "econnreset",
  "enotfound",
  "socket hang up",
  "network error",
  "bad response",
  "missing response",
  "server error",
  "502",
  "503",
  "429",
];

export type SettleErrorKind = "permanent" | "transient" | "unknown";

export function classifySettleError(err: unknown): SettleErrorKind {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();
  if (PERMANENT_PATTERNS.some((p) => msg.includes(p))) return "permanent";
  if (TRANSIENT_PATTERNS.some((p) => msg.includes(p))) return "transient";
  return "unknown";
}

export interface SettlementWorkerDeps {
  db: PrivateOrderDB;
  submitter: AuthorizeSubmitter;
  /** In-memory snapshot map — required for cross-token matching, since
   *  findMatch scans live StoredAuthorizeOrder entries (not DB rows). */
  authorizeOrders: Map<string, StoredAuthorizeOrder>;
  /** findMatch(incoming) from routes/authorize-orders.ts. */
  findMatch: (incoming: StoredAuthorizeOrder) => AuthorizeMatch | null;
  /** Per-pubKey pending-count decrement — keep MAX_ORDERS_PER_PUBKEY
   *  semantics intact when a terminal state is reached by the worker. */
  decPubKeyCount: (ax: string, ay: string) => void;
  /** Optional — cancel listings from the shared orderbook on settle. */
  sharedClient?: SharedOrderbookClient | null;
  nullifierToOfferHandle: (nullifierDecimal: string) => string;
  /** Fee in bps applied to settlement. Worker holds a getter (not a fixed
   *  value) so a live admin fee-update is picked up on the next tick
   *  without a restart. */
  getFeeBps: () => bigint;
  /** Poll cadence. 500 ms is tight enough that POST→settle feels
   *  immediate under normal load; tests pass a smaller value. */
  pollIntervalMs?: number;
}

export class SettlementWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: SettlementWorkerDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight tick to drain so tests + shutdown can assume
    // the queue is quiescent after `await stop()`.
    while (this.running) {
      await sleep(10);
    }
  }

  /** Drain every ready job serially. Public for tests — production only
   *  calls it via the timer. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      let drained = 0;
      while (!this.stopped && drained < MAX_JOBS_PER_TICK) {
        const job = this.deps.db.claimNextSettlementJob();
        if (!job) return;
        await this.handleJob(job);
        drained++;
      }
    } catch (err) {
      // A thrown error here is not one of the per-job outcomes (those are
      // caught inside handleJob); it indicates a bug in the worker itself.
      console.error("[settlement-worker] unexpected tick error:", err);
    } finally {
      this.running = false;
    }
  }

  private async handleJob(job: AuthorizeOrderRow): Promise<void> {
    let order: AuthorizeOrderFile;
    try {
      const stored = this.deps.authorizeOrders.get(job.nullifier);
      order = stored ? stored.order : (JSON.parse(job.orderJson) as AuthorizeOrderFile);
    } catch {
      this.deps.db.markAuthorizeOrderFailed(job.nullifier, "corrupt order_json");
      console.error(
        `[settlement-worker] ${job.nullifier.slice(0, 12)}… corrupt order_json; marked failed`,
      );
      return;
    }

    const ps = order.publicSignals;
    const sameToken = BigInt(ps.sellToken) === BigInt(ps.buyToken);
    if (sameToken) {
      await this.settleSameToken(job, order);
    } else {
      await this.settleCrossToken(job, order);
    }
  }

  private async settleSameToken(job: AuthorizeOrderRow, order: AuthorizeOrderFile): Promise<void> {
    const stored = this.deps.authorizeOrders.get(job.nullifier);
    if (stored) stored.status = "matched";
    try {
      const txHash = await this.deps.submitter.submitScatterDirectAuth(order, this.deps.getFeeBps());
      this.deps.db.markAuthorizeOrderSettled(job.nullifier, txHash);
      if (stored) {
        stored.status = "settled";
        stored.settleTxHash = txHash;
      }
      this.releasePubKeySlot(job, stored);
      console.log(
        `[settlement-worker] scatter ${job.nullifier.slice(0, 12)}… settled tx=${txHash}`,
      );
    } catch (err) {
      this.handleSettleError(job, err, stored);
    }
  }

  private async settleCrossToken(job: AuthorizeOrderRow, order: AuthorizeOrderFile): Promise<void> {
    const stored = this.deps.authorizeOrders.get(job.nullifier);
    if (!stored) {
      // The in-memory snapshot went missing (e.g. a purge race). Without it
      // we can't match — defer and wait for the POST handler or cross-relayer
      // service to re-seed it.
      this.deps.db.deferAcceptedAuthorizeOrder(job.nullifier, Date.now() + NO_MATCH_REPOLL_MS);
      return;
    }

    const match = this.deps.findMatch(stored);
    if (!match) {
      // No counterparty yet. Park — not a failure.
      this.deps.db.deferAcceptedAuthorizeOrder(job.nullifier, Date.now() + NO_MATCH_REPOLL_MS);
      return;
    }

    match.maker.status = "matched";
    match.taker.status = "matched";
    const makerN = match.maker.order.publicSignals.nullifier;
    const takerN = match.taker.order.publicSignals.nullifier;

    try {
      const txHash = await this.deps.submitter.submitAuthSettle(match, this.deps.getFeeBps(), {
        makerOrderId: this.deps.nullifierToOfferHandle(makerN),
        takerOrderId: this.deps.nullifierToOfferHandle(takerN),
      });

      this.deps.db.markAuthorizeOrderSettled(makerN, txHash);
      this.deps.db.markAuthorizeOrderSettled(takerN, txHash);

      match.maker.status = "settled";
      match.maker.settleTxHash = txHash;
      if (match.maker.pubKeyAx && match.maker.pubKeyAy) {
        this.deps.decPubKeyCount(match.maker.pubKeyAx, match.maker.pubKeyAy);
      }
      match.taker.status = "settled";
      match.taker.settleTxHash = txHash;
      if (match.taker.pubKeyAx && match.taker.pubKeyAy) {
        this.deps.decPubKeyCount(match.taker.pubKeyAx, match.taker.pubKeyAy);
      }

      if (this.deps.sharedClient) {
        const sc = this.deps.sharedClient;
        void sc.cancelOrder(this.deps.nullifierToOfferHandle(makerN)).catch(() => {});
        void sc.cancelOrder(this.deps.nullifierToOfferHandle(takerN)).catch(() => {});
      }

      console.log(
        `[settlement-worker] settleAuth ${makerN.slice(0, 12)}…/${takerN.slice(0, 12)}… tx=${txHash}`,
      );
    } catch (err) {
      // Revert both ends back to pending so a subsequent match attempt can
      // re-pair them. The counterparty stays in its own accepted queue row;
      // only the job we claimed is re-scheduled / failed.
      match.maker.status = "pending";
      match.taker.status = "pending";
      this.handleSettleError(job, err, stored);
    }
  }

  private handleSettleError(
    job: AuthorizeOrderRow,
    err: unknown,
    stored: StoredAuthorizeOrder | undefined,
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = classifySettleError(err);

    if (kind === "permanent") {
      this.deps.db.markAuthorizeOrderFailed(job.nullifier, msg);
      // Mirror the durable FSM in-memory. Using 'cancelled' here would
      // diverge from the persisted row and confuse GET fallbacks / metrics
      // that bucket by status.
      if (stored) stored.status = "failed";
      this.releasePubKeySlot(job, stored);
      console.error(
        `[settlement-worker] ${job.nullifier.slice(0, 12)}… permanent failure: ${msg}`,
      );
      return;
    }

    // Unknown → one safety retry. Transient → full schedule.
    const budget = kind === "transient" ? MAX_SETTLEMENT_ATTEMPTS : 1;
    const nextAttempt = job.attempt + 1;

    if (nextAttempt > budget) {
      if (kind === "transient") {
        this.deps.db.markAuthorizeOrderDeadLetter(job.nullifier, msg);
        if (stored) stored.status = "dead_letter";
      } else {
        this.deps.db.markAuthorizeOrderFailed(job.nullifier, msg);
        if (stored) stored.status = "failed";
      }
      this.releasePubKeySlot(job, stored);
      console.error(
        `[settlement-worker] ${job.nullifier.slice(0, 12)}… exhausted ${kind} retries: ${msg}`,
      );
      return;
    }

    // Index into SETTLEMENT_RETRY_SCHEDULE_MS by (nextAttempt - 1). Clamp in
    // the unknown-safety-retry case which runs with budget = 1.
    const idx = Math.min(nextAttempt - 1, SETTLEMENT_RETRY_SCHEDULE_MS.length - 1);
    const delay = SETTLEMENT_RETRY_SCHEDULE_MS[idx];
    this.deps.db.scheduleAuthorizeOrderRetry({
      nullifier: job.nullifier,
      attempt: nextAttempt,
      nextRetryAt: Date.now() + delay,
      error: msg,
    });
    // Mirror the durable 'retrying' state in-memory so matching/polling
    // code paths that read the map see the same FSM slice as the DB.
    if (stored) stored.status = "retrying";
    console.warn(
      `[settlement-worker] ${job.nullifier.slice(0, 12)}… ${kind} error, retry ${nextAttempt} in ${delay}ms: ${msg}`,
    );
  }

  /** Decrement the per-pubKey pending counter on a terminal outcome.
   *  Prefers the in-memory entry's keys (authoritative) but falls back to
   *  the DB row if the map has been evicted. */
  private releasePubKeySlot(job: AuthorizeOrderRow, stored: StoredAuthorizeOrder | undefined): void {
    const ax = stored?.pubKeyAx ?? job.pubKeyAx;
    const ay = stored?.pubKeyAy ?? job.pubKeyAy;
    if (ax && ay) this.deps.decPubKeyCount(ax, ay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
