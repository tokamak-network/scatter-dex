/**
 * Drains `settlement_push_outbox` against the shared-OB indexer.
 *
 * The live push (set up in index.ts) is fire-and-forget so a confirmed
 * settle doesn't block on indexer latency. That speed comes at a cost:
 * a transient shared-OB outage silently swallows the notification and
 * the leaderboard then under-reports until the next push happens to
 * succeed. This worker closes the gap by replaying any outbox row the
 * indexer hasn't acknowledged.
 *
 * Design notes:
 *  - tx_hash is the outbox PK, so re-enqueues are idempotent and the
 *    live wrapper + this worker can both write the same row safely.
 *  - The shared-OB `POST /api/settlements` endpoint is itself
 *    idempotent on tx_hash, so a successful push that was logged as a
 *    failure on the client side (e.g. response read timeout) is also
 *    safe to retry.
 *  - Per-row backoff is enforced in SQL via `last_attempt_at <= cutoff`
 *    so a long-pending row doesn't get hammered on every tick.
 */

import type { PrivateOrderDB } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("settlement-push-worker");

export const DEFAULT_TICK_INTERVAL_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_RETRY_BACKOFF_MS = 30_000;

export interface SettlementPusher {
  pushSettlement(payload: unknown): Promise<boolean>;
}

export interface SettlementPushWorkerDeps {
  db: PrivateOrderDB;
  pusher: SettlementPusher;
  tickIntervalMs?: number;
  batchSize?: number;
  retryBackoffMs?: number;
}

export class SettlementPushWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly tickIntervalMs: number;
  private readonly batchSize: number;
  private readonly retryBackoffMs: number;

  constructor(private readonly deps: SettlementPushWorkerDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    // Defer to next tick so the first push doesn't race with index.ts
    // wiring (the pusher is set up just before this.start()).
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    // Don't keep the event loop alive just for outbox draining — the
    // HTTP server is the canonical liveness anchor.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight tick so shutdown can assume the worker
    // isn't mid-write to the outbox.
    while (this.running) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Public for tests. Drains one batch of pending rows. */
  async tick(): Promise<{ attempted: number; pushed: number; failed: number }> {
    if (this.running || this.stopped) return { attempted: 0, pushed: 0, failed: 0 };
    this.running = true;
    let pushed = 0;
    let failed = 0;
    try {
      const rows = this.deps.db.getPendingSettlementPushes(this.batchSize, this.retryBackoffMs);
      for (const row of rows) {
        if (this.stopped) break;
        try {
          const ok = await this.deps.pusher.pushSettlement(row.payload);
          if (ok) {
            this.deps.db.markSettlementPushSucceeded(row.txHash);
            pushed++;
          } else {
            this.deps.db.markSettlementPushFailed(row.txHash, "pushSettlement returned false");
            failed++;
          }
        } catch (err) {
          this.deps.db.markSettlementPushFailed(
            row.txHash,
            err instanceof Error ? err.message : String(err),
          );
          failed++;
        }
      }
      if (rows.length > 0) {
        log.info("drain tick", { attempted: rows.length, pushed, failed });
      }
      return { attempted: rows.length, pushed, failed };
    } catch (err) {
      log.error("tick failed", { err: err instanceof Error ? err.message : String(err) });
      return { attempted: 0, pushed, failed };
    } finally {
      this.running = false;
    }
  }
}
