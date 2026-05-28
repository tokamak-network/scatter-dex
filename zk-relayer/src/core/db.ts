import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("db");
// Private-flow types removed with the tracker #29 cleanup. Authorize-flow
// row shapes are inlined below.

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "zk-relayer.db");

/** Non-negative decimal integer (wei) — the canonical wire format
 *  for token amounts that exceed JS's safe-integer range. */
export function isWeiString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v);
}

interface OrderRow {
  pub_key_ax: string;
  pub_key_ay: string;
  nonce: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  buy_amount: string;
  max_fee: string;
  expiry: string;
  sig_s: string;
  sig_r8x: string;
  sig_r8y: string;
  owner_secret: string;
  balance: string;
  salt: string;
  leaf_index: number;
  status: string;
  settle_tx: string | null;
  cross_relayer: number;
  submitted_at: number;
  new_salt: string | null;
  expected_change_commitment: string | null;
}

/** Row returned by the async-settlement queue statements. Fields are
 *  aliased to camelCase in the SELECTs so consumers don't need a second
 *  mapping layer. */
export interface AuthorizeOrderRow {
  nullifier: string;
  status: string;
  submittedAt: number;
  updatedAt: number;
  attempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  settleTx: string | null;
  pubKeyAx: string | null;
  pubKeyAy: string | null;
  orderJson: string;
}

// Keep the persisted error short — SQLite has no hard limit but callers
// serialise these into JSON responses and log lines; a runaway stack
// trace blows up both.
const MAX_ERR_LEN = 512;

/** Grace period before a terminal authorize_orders row is purged. The
 *  mobile pending-orders poll loop needs to GET /:nullifier and observe
 *  the terminal status (settled / failed / dead_letter / expired /
 *  cancelled) at least once before the row vanishes; otherwise the
 *  client never learns the outcome from the relayer side. 1 hour is
 *  far longer than the mobile poll cadence (max 30 s idle) plus the
 *  in-flight retry budget (~7 min), so any reasonable client has
 *  observed the transition by the time deletion fires. */
// Authorize-order rows are kept indefinitely. The previous design
// trimmed terminal rows after a 1h grace window and stood up a
// parallel `authorize_orders_archive` table to keep the operator
// drawer's Sender + raw-body lookups working past the purge — two
// places to read, schema duplication, archive-write on every status
// flip. Operator visibility for any past order is a stronger
// requirement than a slightly leaner live table; the matching-path
// queries already filter by status via the idx_ao_status index so
// purging buys little. Drop the second table and stop purging by
// default.
//
// The env stays as an opt-in for relayers that genuinely need disk
// pressure management. Default `0` means "never purge."
/** Read the AUTHORIZE_ORDER_RETENTION_MS env every time so tests
 *  (and runtime reloads) can flip it without re-importing. Returns
 *  0 for "never purge" (the default). Anything else must be a
 *  whole-number positive ms count — non-integers / NaN collapse to
 *  the safe-default 0. */
function readRetentionMs(): number {
  const raw = process.env.AUTHORIZE_ORDER_RETENTION_MS;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 0;
}
function truncErr(err: string): string {
  return err.length > MAX_ERR_LEN ? err.slice(0, MAX_ERR_LEN - 1) + "…" : err;
}

/** Lowercase hex strings (addresses + tx hashes) so equality checks
 *  and the UNIQUE(tx_hash) constraint don't split rows by casing.
 *  null/undefined pass through unchanged so optional fields stay
 *  optional in callers. */
function lowerHex<T extends string | null | undefined>(v: T): T {
  return (typeof v === "string" ? v.toLowerCase() : v) as T;
}

/** Compute multiple p-percentiles (0–100) over an unsorted sample
 *  in one pass: sorts a copy of `values` once, then indexes the
 *  requested ranks. Returns null entries for an empty sample so
 *  callers can render "no data yet" rather than a misleading 0.
 *  Doesn't mutate the input. */
function percentiles(
  values: number[],
  ps: number[],
): Array<number | null> {
  if (values.length === 0) return ps.map(() => null);
  const sorted = [...values].sort((a, b) => a - b);
  return ps.map((p) => {
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  });
}

export interface TradeOfferRow {
  id: number;
  direction: "sent" | "received";
  peer_relayer: string;
  maker_pub_key: string;
  maker_nonce: string;
  taker_pub_key: string;
  taker_nonce: string;
  status: string;
  tx_hash: string | null;
  reason: string | null;
  created_at: number;
}

export interface TradeOfferQueryOpts {
  limit: number;
  offset: number;
  direction?: "sent" | "received";
  status?: string;
  peer?: string;
  since?: number;
}

export interface PeerStatsRow {
  peer: string;
  sent: number;
  received: number;
  settled: number;
  rejected: number;
  errored: number;
  lastAt: number | null;
}

/** Persisted settlement event — written after a successful on-chain
 *  settlement so dashboards can query history without the live
 *  rolling-window metrics. */
export interface SettlementHistoryRow {
  id: number;
  tx_hash: string;
  type: "settleAuth" | "scatterDirectAuth";
  status: "confirmed" | "failed";
  block_number: number | null;
  gas_cost_eth: string | null;
  sell_token: string | null;
  buy_token: string | null;
  /** Notional flowing on each leg of the trade, as decoded from the
   *  submitted authorize public signals. Stored as decimal wei strings
   *  so BigInt arithmetic round-trips without precision loss. Null on
   *  rows recorded before the columns existed (pre-analytics) — those
   *  rows still count toward fill counts but are skipped by volume
   *  aggregates. */
  sell_amount: string | null;
  buy_amount: string | null;
  error_reason: string | null;
  /** Wall-clock milliseconds from worker claim to confirmation.
   *  Null on rows recorded before the column existed. */
  duration_ms: number | null;
  /** 1 when this row reflects the *counterparty* side of a cross-
   *  relayer match the local node didn't submit on-chain (the peer
   *  submitted; we recorded our own leg locally so the leaderboard
   *  reflects our participation). 0 for submitter rows. Backed by a
   *  `NOT NULL DEFAULT 0` column so older rows read as `0`, not
   *  null — the type matches the SQL shape. */
  counterparty: 0 | 1;
  created_at: number;
}

/** Per-side fee accrued by this relayer at a settlement. One row per
 *  side (maker/taker) for two-sided settles; one row total for
 *  scatterDirectAuth. */
export interface FeeAccrualRow {
  id: number;
  tx_hash: string;
  side: "maker" | "taker" | "scatterDirect";
  token: string;
  amount_wei: string;
  block_number: number | null;
  created_at: number;
}

/** Caller-supplied payload for `recordSettlementEvent`. The DB fills
 *  in the auto-incrementing id and the canonical `created_at`
 *  timestamp. */
export interface SettlementEventInput {
  txHash: string;
  type: SettlementHistoryRow["type"];
  status: SettlementHistoryRow["status"];
  blockNumber?: number | null;
  gasCostEth?: string | null;
  sellToken?: string | null;
  buyToken?: string | null;
  /** Decimal-wei notional for the maker leg of the trade. Optional —
   *  callers that don't yet have the decoded amount handy leave it
   *  undefined and the row stores NULL (the analytics aggregate skips
   *  those rows in its volume sum). */
  sellAmount?: string | null;
  buyAmount?: string | null;
  errorReason?: string | null;
  /** Settlement duration in ms (worker claim → on-chain confirmation).
   *  Optional — recorded when known; older callers without timing
   *  data leave it undefined and the row stores NULL. */
  durationMs?: number | null;
  /** True when this row reflects the *counterparty* side of a cross-
   *  relayer match the local node didn't submit on-chain. Without
   *  this row the local leaderboard would credit the match entirely
   *  to the submitting peer even though we held one of the orders.
   *  Submitter rows leave this undefined / false. */
  counterparty?: boolean;
  fees?: Array<{
    side: FeeAccrualRow["side"];
    token: string;
    amountWei: string;
  }>;
}

export interface HistoryQueryOpts {
  limit: number;
  offset: number;
  type?: SettlementHistoryRow["type"];
  status?: SettlementHistoryRow["status"];
}

export interface FeeHistoryQueryOpts {
  limit: number;
  offset: number;
  token?: string;
  since?: number;
}

interface ClaimRow {
  pub_key_ax: string;
  nonce: string;
  idx: number;
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  release_time: string;
}

export class PrivateOrderDB {
  private db: Database.Database;
  private insertClaimsRoot: ReturnType<Database.Database["prepare"]>;
  private selectClaimsRoot: ReturnType<Database.Database["prepare"]>;
  private insertTradeOffer: ReturnType<Database.Database["prepare"]>;
  private selectTradeOffers: ReturnType<Database.Database["prepare"]>;
  // Filtered + aggregate trade-offer queries for the operator
  // Cross-relayer view. Single statement per query shape, with
  // optional filters expressed as `(@param IS NULL OR col = @param)`
  // — SQLite optimises the no-op branches once params are bound,
  // so the route keeps SQL static instead of string-concatenating.
  private selectTradeOffersFiltered: ReturnType<Database.Database["prepare"]>;
  private countTradeOffersFiltered: ReturnType<Database.Database["prepare"]>;
  private selectPeerStats: ReturnType<Database.Database["prepare"]>;
  private statsTotalOrders: ReturnType<Database.Database["prepare"]>;
  private statsSettledOrders: ReturnType<Database.Database["prepare"]>;
  private statsTotalTradeOffers: ReturnType<Database.Database["prepare"]>;
  private statsSettledTradeOffers: ReturnType<Database.Database["prepare"]>;
  private statsAvgSettleTime: ReturnType<Database.Database["prepare"]>;
  private statsSettledVolume: ReturnType<Database.Database["prepare"]>;
  private upsertMeta: ReturnType<Database.Database["prepare"]>;
  private selectMeta: ReturnType<Database.Database["prepare"]>;
  // [R-6] Authorize order statements
  private upsertAuthOrder: ReturnType<Database.Database["prepare"]>;
  private updateAuthStatus: ReturnType<Database.Database["prepare"]>;
  private deleteAuthOrder: ReturnType<Database.Database["prepare"]>;
  private selectPendingAuth: ReturnType<Database.Database["prepare"]>;
  private purgeAuthNonPending: ReturnType<Database.Database["prepare"]>;
  // Async-settlement queue statements
  private selectAuthByNullifier: ReturnType<Database.Database["prepare"]>;
  private insertAcceptedAuth: ReturnType<Database.Database["prepare"]>;
  private claimSettlementJob: ReturnType<Database.Database["prepare"]>;
  private markAuthSettled: ReturnType<Database.Database["prepare"]>;
  private markAuthFailed: ReturnType<Database.Database["prepare"]>;
  private scheduleAuthRetry: ReturnType<Database.Database["prepare"]>;
  private deferAcceptedAuth: ReturnType<Database.Database["prepare"]>;
  private resetOrphanedSettlingAuth: ReturnType<Database.Database["prepare"]>;
  private markAuthDeadLetter: ReturnType<Database.Database["prepare"]>;
  private sweepExpiredAuth: ReturnType<Database.Database["prepare"]>;
  private setAuthTxHash: ReturnType<Database.Database["prepare"]>;
  // [R-2] Pending TX tracking
  private insertPendingTx: ReturnType<Database.Database["prepare"]>;
  private deletePendingTx: ReturnType<Database.Database["prepare"]>;
  private selectPendingTxs: ReturnType<Database.Database["prepare"]>;
  // Settlement / fee history
  private insertSettlementEvent: ReturnType<Database.Database["prepare"]>;
  private insertFeeAccrual: ReturnType<Database.Database["prepare"]>;
  private selectSettlementHistory: ReturnType<Database.Database["prepare"]>;
  private selectSettlementHistoryByType: ReturnType<Database.Database["prepare"]>;
  private selectSettlementHistoryByStatus: ReturnType<Database.Database["prepare"]>;
  private selectSettlementHistoryByTypeStatus: ReturnType<Database.Database["prepare"]>;
  private countSettlementHistory: ReturnType<Database.Database["prepare"]>;
  private countSettlementHistoryByType: ReturnType<Database.Database["prepare"]>;
  private countSettlementHistoryByStatus: ReturnType<Database.Database["prepare"]>;
  private countSettlementHistoryByTypeStatus: ReturnType<Database.Database["prepare"]>;
  private selectSettlementHistoryRange: ReturnType<Database.Database["prepare"]>;
  private selectFeeHistory: ReturnType<Database.Database["prepare"]>;
  private selectFeeHistoryByToken: ReturnType<Database.Database["prepare"]>;
  private selectSettlementByTxHash: ReturnType<Database.Database["prepare"]>;
  private selectFeesByTxHash: ReturnType<Database.Database["prepare"]>;
  private selectAuthOrdersBySettleTx: ReturnType<Database.Database["prepare"]>;
  private selectSettlementBucketRows: ReturnType<Database.Database["prepare"]>;
  private sumFeeHistoryByToken: ReturnType<Database.Database["prepare"]>;
  private sumVolumeByToken: ReturnType<Database.Database["prepare"]>;
  // Settlement push outbox
  private upsertPushOutbox: ReturnType<Database.Database["prepare"]>;
  private selectPendingPushes: ReturnType<Database.Database["prepare"]>;
  private markPushSucceededStmt: ReturnType<Database.Database["prepare"]>;
  private markPushFailedStmt: ReturnType<Database.Database["prepare"]>;
  private countPushOutbox: ReturnType<Database.Database["prepare"]>;

  constructor(dbPath = DB_PATH) {
    // [L-8] For production with sensitive data, consider replacing better-sqlite3
    // with @journeyapps/sqlcipher or migrating to PostgreSQL with TDE.
    // Current threat model: DB file permissions (M-10) protect against
    // unauthorized reads; encryption-at-rest adds defense-in-depth.
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.migrate();

    // [M-10] Restrict DB file permissions to owner-only (600).
    // Runs AFTER migrate() so WAL/SHM files (created by first write) are also covered.
    try {
      fs.chmodSync(dbPath, 0o600);
      if (fs.existsSync(`${dbPath}-wal`)) fs.chmodSync(`${dbPath}-wal`, 0o600);
      if (fs.existsSync(`${dbPath}-shm`)) fs.chmodSync(`${dbPath}-shm`, 0o600);
    } catch (e) {
      log.warn("[M-10] Failed to set DB permissions", {
        err: e instanceof Error ? e.message : String(e),
      });
    }

    // Private-flow CRUD prepared statements (insertOrder, insertClaim,
    // deleteClaims, updateStatusStmt, selectPending, selectClaims,
    // selectExists, selectByPubKey, selectByPubKeyStatus, selectByPubKeyNonce,
    // countByPubKey, countByPubKeyStatus) were removed with the tracker #29
    // cleanup. The on-disk `private_orders` / `private_claims` tables remain
    // in the schema for backward-compat with existing operator DBs.
    this.insertClaimsRoot = this.db.prepare(`
      INSERT OR IGNORE INTO settled_claims_roots (claims_root, settled_at) VALUES (@claimsRoot, @settledAt)
    `);
    this.selectClaimsRoot = this.db.prepare(`
      SELECT 1 FROM settled_claims_roots WHERE claims_root = @claimsRoot LIMIT 1
    `);
    this.insertTradeOffer = this.db.prepare(`
      INSERT INTO trade_offers (direction, peer_relayer, maker_pub_key, maker_nonce, taker_pub_key, taker_nonce, status, tx_hash, reason, created_at)
      VALUES (@direction, @peerRelayer, @makerPubKey, @makerNonce, @takerPubKey, @takerNonce, @status, @txHash, @reason, @createdAt)
    `);
    this.selectTradeOffers = this.db.prepare(`
      SELECT * FROM trade_offers ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
    `);
    // Single filtered query — every optional filter is applied via
    // `(@param IS NULL OR col = @param)` so the prepared plan stays
    // stable regardless of which filters the caller chose. SQLite
    // optimises the no-op branches away once the params are bound.
    this.selectTradeOffersFiltered = this.db.prepare(`
      SELECT * FROM trade_offers
       WHERE (@direction IS NULL OR direction = @direction)
         AND (@status IS NULL OR status = @status)
         AND (@peer IS NULL OR peer_relayer = @peer)
         AND created_at >= @since
       ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
    `);
    // Companion count query for the same filter — used by the
    // route to surface a total-records value separate from the
    // current page's row count, so paginated UIs can render
    // accurate page counts.
    this.countTradeOffersFiltered = this.db.prepare(`
      SELECT COUNT(*) as count FROM trade_offers
       WHERE (@direction IS NULL OR direction = @direction)
         AND (@status IS NULL OR status = @status)
         AND (@peer IS NULL OR peer_relayer = @peer)
         AND created_at >= @since
    `);
    // Per-peer aggregate. SUM(CASE …) gives one row per peer with
    // counters split by direction and outcome. Ordered by total
    // activity (most-engaged peers first) so the operator sees the
    // ones that matter at the top.
    this.selectPeerStats = this.db.prepare(`
      SELECT peer_relayer as peer,
             SUM(CASE WHEN direction = 'sent'     THEN 1 ELSE 0 END) as sent,
             SUM(CASE WHEN direction = 'received' THEN 1 ELSE 0 END) as received,
             SUM(CASE WHEN status    = 'settled'  THEN 1 ELSE 0 END) as settled,
             SUM(CASE WHEN status    = 'rejected' THEN 1 ELSE 0 END) as rejected,
             SUM(CASE WHEN status    = 'error'    THEN 1 ELSE 0 END) as errored,
             MAX(created_at) as lastAt
        FROM trade_offers
       WHERE created_at >= @since
       GROUP BY peer_relayer
       ORDER BY (sent + received) DESC, lastAt DESC
    `);
    // Stats are sourced from `settlement_history` and `trade_offers` —
    // the canonical persisted records of relayer activity. The prior
    // `private_orders`-based queries returned zeros because that table
    // is dead-letter only post-S-M14 (the live flow purges through
    // `authorize_orders` and the per-row settlement event is what gets
    // persisted long-term).
    //   - totalOrders / settledOrders count attempts vs confirmations
    //     in settlement_history (every submitted settle gets a row).
    //   - avgSettleTimeMs uses the duration_ms column populated by the
    //     submitter (worker claim → on-chain confirmation).
    //   - crossRelayerSettled and trade-offer counts come from
    //     trade_offers, the cross-relayer audit trail.
    this.statsTotalOrders = this.db.prepare("SELECT COUNT(*) as count FROM settlement_history");
    this.statsSettledOrders = this.db.prepare("SELECT COUNT(*) as count FROM settlement_history WHERE status = 'confirmed'");
    // crossRelayerSettled and settledTradeOffers are the same query —
    // a trade_offer that reached `status='settled'` *is* a cross-relayer
    // settlement. Prepared once, reused for both fields in
    // `getRelayerStats()` so the API surface stays explicit while the
    // SQL doesn't run twice.
    this.statsTotalTradeOffers = this.db.prepare("SELECT COUNT(*) as count FROM trade_offers");
    this.statsSettledTradeOffers = this.db.prepare("SELECT COUNT(*) as count FROM trade_offers WHERE status = 'settled'");
    this.statsAvgSettleTime = this.db.prepare(
      "SELECT AVG(duration_ms) as avg_ms FROM settlement_history WHERE status = 'confirmed' AND duration_ms IS NOT NULL",
    );
    // Per-token settled count plus the actual sell-leg notional sum.
    // sell_amount was added by the analytics migration; pre-migration
    // rows still have NULL and are skipped by the sum so a partial
    // history doesn't underreport "0 volume" while there are real
    // post-migration settles to count. GROUP_CONCAT keeps the SQL
    // BigInt-safe — SUM() would coerce to JS number and lose
    // precision for >2^53 totals (16 WETH at 18 decimals overflows).
    //
    // Sell-only per-relayer attribution: each settlement_history row
    // represents ONE local order's sell-leg. A cross-token swap is
    // recorded as TWO rows when both orders are local to this relayer
    // (one per side, each with its own sellToken/sellAmount), or as
    // ONE row when the counterparty relayer owns the other side
    // (that peer records its own sell-leg in its own DB). Either way,
    // network-wide each side of each trade is counted exactly once —
    // no double-count. See `authorize-submitter.ts:submitAuthSettle`
    // for the writer-side rule, and `authorize-cross-relayer-matcher.ts`
    // counterparty path for the cross-relayer half.
    //
    // The prior UNION-ed buy_token leg (gated on `type='settleAuth'`)
    // double-counted in the single-relayer-match case where one row
    // carried both maker and taker amounts — the buy leg was a
    // second pseudo-row for the same trade. Removed now that each
    // sell-leg lives in its own row.
    this.statsSettledVolume = this.db.prepare(
      `SELECT sell_token,
              COUNT(*) AS count,
              COALESCE(GROUP_CONCAT(sell_amount), '') AS amounts
         FROM settlement_history
        WHERE status = 'confirmed'
          AND sell_token IS NOT NULL
          AND sell_amount IS NOT NULL
        GROUP BY sell_token`,
    );
    this.upsertMeta = this.db.prepare(
      "INSERT OR REPLACE INTO relayer_meta (key, value) VALUES (@key, @value)",
    );
    this.selectMeta = this.db.prepare("SELECT value FROM relayer_meta WHERE key = @key");

    // [R-6] Authorize order prepared statements
    // `updated_at` must be written on every status mutation or the
    // terminal-retention grace window in purgeAuthNonPending gets the
    // wrong cutoff: a row stuck at updated_at=0 is "older than 1h ago"
    // forever, so it gets purged on the next sweep and mobile sees 404
    // instead of the terminal status.
    this.upsertAuthOrder = this.db.prepare(
      "INSERT OR REPLACE INTO authorize_orders (nullifier, status, submitted_at, updated_at, order_json, pub_key_ax, pub_key_ay, settle_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateAuthStatus = this.db.prepare(
      "UPDATE authorize_orders SET status = ?, settle_tx = ?, updated_at = ? WHERE nullifier = ?",
    );
    this.deleteAuthOrder = this.db.prepare("DELETE FROM authorize_orders WHERE nullifier = ?");
    // Restore every still-live order on boot (accepted/retrying/settling for
    // the new FSM, plus legacy 'pending' rows that pre-date the migration).
    // The in-memory map needs all of them so cross-token matching can find
    // them as counterparties.
    // `matched` is a legacy in-flight status that pre-dates the async FSM.
    // Include it on restore so a relayer restarted mid-match doesn't orphan
    // a live counterparty (the post-boot reset re-normalises 'settling' →
    // 'accepted', but 'matched' must be visible to pubKey-slot accounting).
    this.selectPendingAuth = this.db.prepare(
      `SELECT nullifier, status, submitted_at as submittedAt, order_json as orderJson,
              pub_key_ax as pubKeyAx, pub_key_ay as pubKeyAy, settle_tx as settleTx
         FROM authorize_orders
        WHERE status IN ('pending', 'accepted', 'retrying', 'settling', 'matched')`,
    );
    // Purge only terminal rows, and only after the TERMINAL_RETENTION_MS
    // grace window has elapsed since the last status mutation. This
    // guarantees the mobile poll loop has time to GET /:nullifier and
    // observe the final outcome before the row disappears; otherwise the
    // next poll returns 404 and local state sticks on 'accepted' until
    // the client-side MAX_POLL_AGE_MS fallback.
    //
    // We intentionally do **not** delete live-but-circuit-expired rows
    // here — `sweepExpiredAuth` promotes those to the terminal 'expired'
    // status, which then qualifies them for the grace-windowed delete
    // above. Deleting them directly raced the sweeper and (more
    // importantly) violated the "never purge in-flight rows" invariant
    // that the mobile status contract depends on.
    this.purgeAuthNonPending = this.db.prepare(
      `DELETE FROM authorize_orders
         WHERE status NOT IN ('pending', 'accepted', 'retrying', 'settling', 'matched')
           AND updated_at < ?`,
    );

    // ── Async-settlement queue statements ──────────────────────────
    // Full-row lookup for the idempotency check on POST.
    this.selectAuthByNullifier = this.db.prepare(
      `SELECT nullifier, status, submitted_at as submittedAt, updated_at as updatedAt,
              attempt, next_retry_at as nextRetryAt, last_error as lastError,
              settle_tx as settleTx, pub_key_ax as pubKeyAx, pub_key_ay as pubKeyAy,
              order_json as orderJson
         FROM authorize_orders WHERE nullifier = ?`,
    );

    // Seed a new order. Distinct from upsertAuthOrder because we must
    // reject duplicates at the DB layer (the idempotency check feeds off
    // the error — not a WHERE-clause race).
    this.insertAcceptedAuth = this.db.prepare(
      `INSERT INTO authorize_orders
         (nullifier, status, submitted_at, updated_at, attempt, next_retry_at,
          order_json, pub_key_ax, pub_key_ay)
       VALUES (?, 'accepted', ?, ?, 0, NULL, ?, ?, ?)`,
    );

    // Atomic "claim one ready job": flip accepted/retrying → settling and
    // return the row. RETURNING requires SQLite ≥ 3.35 (better-sqlite3
    // bundles ≥ 3.45). Single-statement so the select-then-update race is
    // impossible even across worker concurrency > 1.
    this.claimSettlementJob = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'settling', updated_at = ?, next_retry_at = NULL
        WHERE nullifier = (
          SELECT nullifier FROM authorize_orders
           WHERE status IN ('accepted', 'retrying')
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY COALESCE(next_retry_at, submitted_at) ASC
           LIMIT 1
        )
      RETURNING nullifier, status, submitted_at as submittedAt, updated_at as updatedAt,
                attempt, next_retry_at as nextRetryAt, last_error as lastError,
                settle_tx as settleTx, pub_key_ax as pubKeyAx,
                pub_key_ay as pubKeyAy, order_json as orderJson`,
    );

    this.markAuthSettled = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'settled', settle_tx = ?, updated_at = ?,
              next_retry_at = NULL, last_error = NULL
        WHERE nullifier = ?`,
    );
    this.markAuthFailed = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'failed', last_error = ?, updated_at = ?,
              next_retry_at = NULL
        WHERE nullifier = ?`,
    );
    this.markAuthDeadLetter = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'dead_letter', last_error = ?, updated_at = ?,
              next_retry_at = NULL
        WHERE nullifier = ?`,
    );
    this.scheduleAuthRetry = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'retrying', attempt = ?, next_retry_at = ?,
              last_error = ?, updated_at = ?
        WHERE nullifier = ?`,
    );
    // "Defer without penalty" — cross-token orders whose counterparty
    // hasn't shown up yet aren't failing, so we keep status='accepted' and
    // don't bump attempt. Only next_retry_at + updated_at move, which keeps
    // the partial index happy and makes GET /:nullifier still report
    // status='accepted' (not 'retrying') to the client.
    this.deferAcceptedAuth = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'accepted', next_retry_at = ?, updated_at = ?
        WHERE nullifier = ?`,
    );
    this.resetOrphanedSettlingAuth = this.db.prepare(
      `UPDATE authorize_orders SET status = 'accepted', updated_at = ?
        WHERE status = 'settling'`,
    );
    this.setAuthTxHash = this.db.prepare(
      `UPDATE authorize_orders SET settle_tx = ?, updated_at = ? WHERE nullifier = ?`,
    );

    // Bulk-expire orders whose circuit expiry has passed without settlement.
    // `publicSignals.expiry` is seconds-since-epoch; updated_at is ms.
    this.sweepExpiredAuth = this.db.prepare(
      `UPDATE authorize_orders
          SET status = 'expired', updated_at = ?, next_retry_at = NULL
        WHERE status IN ('accepted', 'settling', 'retrying')
          AND CAST(json_extract(order_json, '$.publicSignals.expiry') AS INTEGER) < ?`,
    );

    // [R-2] Pending TX tracking
    this.insertPendingTx = this.db.prepare(
      "INSERT OR IGNORE INTO pending_txs (tx_hash, label, created_at) VALUES (@txHash, @label, @createdAt)",
    );
    this.deletePendingTx = this.db.prepare("DELETE FROM pending_txs WHERE tx_hash = @txHash");
    this.selectPendingTxs = this.db.prepare("SELECT * FROM pending_txs ORDER BY created_at ASC");

    // Settlement / fee history. UNIQUE on tx_hash means re-records (e.g.
    // worker re-running after a transient DB failure) silently no-op
    // instead of producing dupes.
    this.insertSettlementEvent = this.db.prepare(`
      INSERT OR IGNORE INTO settlement_history
        (tx_hash, type, status, block_number, gas_cost_eth, sell_token, buy_token, sell_amount, buy_amount, error_reason, duration_ms, counterparty, created_at)
      VALUES
        (@txHash, @type, @status, @blockNumber, @gasCostEth, @sellToken, @buyToken, @sellAmount, @buyAmount, @errorReason, @durationMs, @counterparty, @createdAt)
    `);
    this.insertFeeAccrual = this.db.prepare(`
      INSERT INTO fee_history (tx_hash, side, token, amount_wei, block_number, created_at)
      VALUES (@txHash, @side, @token, @amountWei, @blockNumber, @createdAt)
    `);
    // Four selects + four counts so the route can apply each filter
    // combo without resorting to dynamic SQL string concat.
    this.selectSettlementHistory = this.db.prepare(
      `SELECT * FROM settlement_history ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.selectSettlementHistoryByType = this.db.prepare(
      `SELECT * FROM settlement_history WHERE type = @type ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.selectSettlementHistoryByStatus = this.db.prepare(
      `SELECT * FROM settlement_history WHERE status = @status ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.selectSettlementHistoryByTypeStatus = this.db.prepare(
      `SELECT * FROM settlement_history WHERE type = @type AND status = @status ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.countSettlementHistory = this.db.prepare("SELECT COUNT(*) as count FROM settlement_history");
    this.countSettlementHistoryByType = this.db.prepare(
      "SELECT COUNT(*) as count FROM settlement_history WHERE type = @type",
    );
    this.countSettlementHistoryByStatus = this.db.prepare(
      "SELECT COUNT(*) as count FROM settlement_history WHERE status = @status",
    );
    this.countSettlementHistoryByTypeStatus = this.db.prepare(
      "SELECT COUNT(*) as count FROM settlement_history WHERE type = @type AND status = @status",
    );
    // CSV export: time-range scan with optional type/status filters
    // applied via NULL-aware predicates so a single statement covers
    // every filter combination. ORDER BY ASC because compliance
    // exports are read chronologically. No LIMIT — the route streams
    // via .iterate() to keep memory bounded regardless of row count.
    this.selectSettlementHistoryRange = this.db.prepare(
      `SELECT * FROM settlement_history
        WHERE created_at >= @since
          AND created_at < @until
          AND (@type IS NULL OR type = @type)
          AND (@status IS NULL OR status = @status)
        ORDER BY created_at ASC, id ASC`,
    );
    this.selectFeeHistory = this.db.prepare(
      `SELECT * FROM fee_history WHERE created_at >= @since ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.selectFeeHistoryByToken = this.db.prepare(
      `SELECT * FROM fee_history WHERE token = @token AND created_at >= @since ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.selectSettlementByTxHash = this.db.prepare(
      `SELECT * FROM settlement_history WHERE tx_hash = @txHash LIMIT 1`,
    );
    this.selectFeesByTxHash = this.db.prepare(
      `SELECT * FROM fee_history WHERE tx_hash = @txHash ORDER BY id ASC`,
    );
    // Order-processing detail for the /orders/detail debug view —
    // matches authorize_orders rows whose settle_tx == this settlement
    // tx hash. settleAuth produces 2 rows (maker + taker); scatterDirectAuth
    // produces 1. Same camelCase aliases as selectAuthByNullifier.
    //
    // settle_tx writes (markAuthorizeOrderSettled / setAuthTxHash /
    // updateAuthStatus) currently store the hash verbatim, while
    // settlement_history.tx_hash is lowercased on insert. Compare via
    // LOWER(settle_tx) so a checksummed settle_tx still joins. Caller
    // is responsible for passing the lowercase form via lowerHex().
    this.selectAuthOrdersBySettleTx = this.db.prepare(
      `SELECT nullifier, status, submitted_at as submittedAt, updated_at as updatedAt,
              attempt, next_retry_at as nextRetryAt, last_error as lastError,
              settle_tx as settleTx, pub_key_ax as pubKeyAx, pub_key_ay as pubKeyAy,
              order_json as orderJson
         FROM authorize_orders WHERE LOWER(settle_tx) = @txHash ORDER BY submitted_at ASC`,
    );
    // Settlement-bucket scan: range query over settlement_history
    // by created_at, projecting only the columns the bucketer needs.
    // Inclusive `until` so an event whose created_at lands exactly
    // on the upper boundary still counts in the most recent bucket.
    this.selectSettlementBucketRows = this.db.prepare(
      `SELECT status, gas_cost_eth, duration_ms, created_at
         FROM settlement_history
        WHERE created_at >= @since AND created_at <= @until`,
    );
    // Per-token totals via row iteration. SQLite's SUM uses INTEGER
    // and would lose precision on amounts > 2^63; GROUP_CONCAT into a
    // single string would balloon memory once history grows. Streaming
    // rows in token order lets the caller reduce in JS bigint without
    // ever materialising the full set in either layer.
    this.sumFeeHistoryByToken = this.db.prepare(`
      SELECT token, amount_wei
        FROM fee_history
       WHERE created_at >= @since
         AND (@until = 0 OR created_at < @until)
       ORDER BY token
    `);
    // Streamed per-token notional rows for the analytics aggregate.
    // Confirmed-only so failed/reverted attempts don't inflate volume.
    // Sell and buy legs are emitted as separate rows tagged by `leg`
    // so getVolumeTotals can produce a per-token total that combines
    // both sides (a USDC→TON trade contributes to USDC sell totals
    // and TON buy totals — both are valid relayer "throughput").
    this.sumVolumeByToken = this.db.prepare(`
      SELECT sell_token AS token, 'sell' AS leg, sell_amount AS amount
        FROM settlement_history
       WHERE status = 'confirmed'
         AND created_at >= @since
         AND (@until = 0 OR created_at < @until)
         AND sell_token IS NOT NULL
         AND sell_amount IS NOT NULL
      UNION ALL
      SELECT buy_token AS token, 'buy' AS leg, buy_amount AS amount
        FROM settlement_history
       WHERE status = 'confirmed'
         AND created_at >= @since
         AND (@until = 0 OR created_at < @until)
         AND buy_token IS NOT NULL
         AND buy_amount IS NOT NULL
       ORDER BY token, leg
    `);

    // Settlement push outbox. INSERT-OR-IGNORE on tx_hash so a duplicate
    // enqueue (live-push wrapper enqueues, then on-restart replay also
    // enqueues) is a no-op rather than overwriting attempt counters.
    this.upsertPushOutbox = this.db.prepare(`
      INSERT OR IGNORE INTO settlement_push_outbox
        (tx_hash, payload_json, attempts, created_at)
      VALUES (@txHash, @payloadJson, 0, @createdAt)
    `);
    // Pending = not yet pushed. `last_attempt_at IS NULL OR <= cutoff`
    // implements a simple backoff window — a row that failed seconds
    // ago shouldn't immediately get hammered again on the next tick.
    this.selectPendingPushes = this.db.prepare(`
      SELECT tx_hash, payload_json, attempts
        FROM settlement_push_outbox
       WHERE pushed_at IS NULL
         AND (last_attempt_at IS NULL OR last_attempt_at <= @cutoff)
       ORDER BY created_at ASC
       LIMIT @limit
    `);
    this.markPushSucceededStmt = this.db.prepare(`
      UPDATE settlement_push_outbox
         SET pushed_at = @now,
             last_attempt_at = @now,
             last_error = NULL,
             attempts = attempts + 1
       WHERE tx_hash = @txHash
    `);
    this.markPushFailedStmt = this.db.prepare(`
      UPDATE settlement_push_outbox
         SET last_attempt_at = @now,
             last_error = @error,
             attempts = attempts + 1
       WHERE tx_hash = @txHash
    `);
    this.countPushOutbox = this.db.prepare(`
      SELECT
        COUNT(*)                                      AS total,
        COUNT(*) FILTER (WHERE pushed_at IS NULL)     AS pending,
        COUNT(*) FILTER (WHERE pushed_at IS NOT NULL) AS pushed,
        MAX(attempts)                                 AS maxAttempts
      FROM settlement_push_outbox
    `);
  }

  /** Record a settlement (success or failure) plus any per-side fees
   *  in a single transaction. Idempotent on tx_hash — safe to call
   *  twice if the worker recovers a tx after a process restart.
   *
   *  All hex identifiers (tx_hash, token addresses) are normalised to
   *  lowercase on insert so a checksummed-vs-lowercase mismatch can't
   *  bypass the UNIQUE(tx_hash) idempotency check or split a token's
   *  fee totals across two rows. Query callers apply the same
   *  normalisation via `lowerHex`. */
  recordSettlementEvent(input: SettlementEventInput): void {
    const createdAt = Date.now();
    const txHash = lowerHex(input.txHash) as string;
    const sellToken = lowerHex(input.sellToken ?? null);
    const buyToken = lowerHex(input.buyToken ?? null);
    const insertAll = this.db.transaction((evt: SettlementEventInput) => {
      const result = this.insertSettlementEvent.run({
        txHash,
        type: evt.type,
        status: evt.status,
        blockNumber: evt.blockNumber ?? null,
        gasCostEth: evt.gasCostEth ?? null,
        sellToken,
        buyToken,
        sellAmount: evt.sellAmount ?? null,
        buyAmount: evt.buyAmount ?? null,
        errorReason: evt.errorReason ? truncErr(evt.errorReason) : null,
        durationMs: evt.durationMs ?? null,
        counterparty: evt.counterparty ? 1 : 0,
        createdAt,
      });
      if (result.changes === 0 || !evt.fees?.length) return;
      for (const fee of evt.fees) {
        this.insertFeeAccrual.run({
          txHash,
          side: fee.side,
          token: lowerHex(fee.token) as string,
          amountWei: fee.amountWei,
          blockNumber: evt.blockNumber ?? null,
          createdAt,
        });
      }
    });
    insertAll(input);
  }

  /** Page through settlement history (newest first). Filter by type
   *  and/or status. Returns rows + total count for pagination UIs. */
  getSettlementHistory(opts: HistoryQueryOpts): {
    rows: SettlementHistoryRow[];
    total: number;
  } {
    const params = { limit: opts.limit, offset: opts.offset };
    let rows: SettlementHistoryRow[];
    let total: number;
    if (opts.type && opts.status) {
      rows = this.selectSettlementHistoryByTypeStatus.all({
        ...params,
        type: opts.type,
        status: opts.status,
      }) as SettlementHistoryRow[];
      total = (this.countSettlementHistoryByTypeStatus.get({
        type: opts.type,
        status: opts.status,
      }) as { count: number }).count;
    } else if (opts.type) {
      rows = this.selectSettlementHistoryByType.all({
        ...params,
        type: opts.type,
      }) as SettlementHistoryRow[];
      total = (this.countSettlementHistoryByType.get({
        type: opts.type,
      }) as { count: number }).count;
    } else if (opts.status) {
      rows = this.selectSettlementHistoryByStatus.all({
        ...params,
        status: opts.status,
      }) as SettlementHistoryRow[];
      total = (this.countSettlementHistoryByStatus.get({
        status: opts.status,
      }) as { count: number }).count;
    } else {
      rows = this.selectSettlementHistory.all(params) as SettlementHistoryRow[];
      total = (this.countSettlementHistory.get({}) as { count: number }).count;
    }
    return { rows, total };
  }

  /** Stream settlement_history rows in chronological order for a time
   *  window. Used by the CSV export route — the iterator keeps memory
   *  bounded even if the window covers millions of rows.
   *
   *  `since` is inclusive, `until` is exclusive. `type` / `status` are
   *  optional; pass `undefined` to skip the filter. */
  *iterateSettlementHistoryRange(opts: {
    since: number;
    until: number;
    type?: SettlementHistoryRow["type"];
    status?: SettlementHistoryRow["status"];
  }): Iterable<SettlementHistoryRow> {
    const params = {
      since: opts.since,
      until: opts.until,
      type: opts.type ?? null,
      status: opts.status ?? null,
    };
    yield* this.selectSettlementHistoryRange.iterate(params) as Iterable<SettlementHistoryRow>;
  }

  /** Single settlement + its fee rows + the authorize_orders rows that
   *  ended up at this settlement tx (one for scatterDirectAuth, two —
   *  maker + taker — for settleAuth). Powers the /orders/detail debug
   *  view, which needs the per-order `attempt` / `last_error` /
   *  `next_retry_at` to explain why a settlement looks the way it does.
   *  Returns null when the tx isn't in settlement_history; the
   *  `processing` array can be empty even on a hit (settle_tx wasn't
   *  written, the row was purged after the terminal-retention window,
   *  or this settle_tx pre-dates the indexer migration). */
  /** Time-bucketed settlement aggregates for the SLA / performance
   *  dashboard. Returns one entry per bucket starting at `since`,
   *  spanning `bucketMs` milliseconds each. Each bucket carries:
   *  - `settled` / `failed` row counts
   *  - average gas across the confirmed rows (ETH, parsed via parseFloat)
   *  - p50 / p95 / p99 latency in ms (only over rows with non-null
   *    duration_ms; `null` when the bucket has no measured row).
   *
   *  Buckets with no rows are returned as zero-count gaps so the
   *  caller can render a continuous time series without filling in
   *  missing slots client-side. */
  getSettlementBuckets(opts: {
    since: number;
    bucketMs: number;
    until?: number;
  }): Array<{
    bucketStart: number;
    settled: number;
    failed: number;
    avgGasEth: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  }> {
    const until = opts.until ?? Date.now();
    if (opts.bucketMs <= 0 || until <= opts.since) return [];
    const numBuckets = Math.ceil((until - opts.since) / opts.bucketMs);
    // Cap to prevent runaway responses if the caller passes a tiny
    // bucket size against a long window. 1024 keeps the response
    // serialisable and the SVG charts on the operator side renderable.
    if (numBuckets > 1024) return [];
    const out = Array.from({ length: numBuckets }, (_, i) => ({
      bucketStart: opts.since + i * opts.bucketMs,
      settled: 0,
      failed: 0,
      gasSum: 0,
      gasCount: 0,
      durations: [] as number[],
    }));
    // Stream rows via iterate() so a long window (7d) over a
    // populous history doesn't materialise the whole result in
    // memory before bucketing — we only ever hold the per-bucket
    // accumulators plus one row at a time.
    const iter = this.selectSettlementBucketRows.iterate({
      since: opts.since,
      until,
    }) as Iterable<{
      status: string;
      gas_cost_eth: string | null;
      duration_ms: number | null;
      created_at: number;
    }>;
    for (const r of iter) {
      // Clamp idx so an event at exactly @until (now reachable via
      // the inclusive filter above) lands in the last bucket
      // instead of one past it.
      const rawIdx = Math.floor((r.created_at - opts.since) / opts.bucketMs);
      const idx = Math.min(numBuckets - 1, rawIdx);
      if (idx < 0) continue;
      const b = out[idx];
      if (r.status === "confirmed") {
        b.settled++;
        const g = parseFloat(r.gas_cost_eth ?? "");
        if (Number.isFinite(g)) {
          b.gasSum += g;
          b.gasCount++;
        }
        if (r.duration_ms != null) b.durations.push(r.duration_ms);
      } else if (r.status === "failed") {
        b.failed++;
      }
    }
    return out.map((b) => {
      // Compute p50/p95/p99 in a single sort instead of three
      // independent in-place sorts of the same buffer.
      const [p50, p95, p99] = percentiles(b.durations, [50, 95, 99]);
      return {
        bucketStart: b.bucketStart,
        settled: b.settled,
        failed: b.failed,
        avgGasEth: b.gasCount > 0 ? b.gasSum / b.gasCount : null,
        p50Ms: p50,
        p95Ms: p95,
        p99Ms: p99,
      };
    });
  }

  getSettlementByTxHash(
    txHash: string,
  ): {
    settlement: SettlementHistoryRow;
    fees: FeeAccrualRow[];
    processing: AuthorizeOrderRow[];
  } | null {
    const lowered = lowerHex(txHash);
    const settlement = this.selectSettlementByTxHash.get({ txHash: lowered }) as
      | SettlementHistoryRow
      | undefined;
    if (!settlement) return null;
    const fees = this.selectFeesByTxHash.all({ txHash: lowered }) as FeeAccrualRow[];
    const processing = this.selectAuthOrdersBySettleTx.all({
      txHash: lowered,
    }) as AuthorizeOrderRow[];
    return { settlement, fees, processing };
  }

  getFeeHistory(opts: FeeHistoryQueryOpts): FeeAccrualRow[] {
    const since = opts.since ?? 0;
    const params = { limit: opts.limit, offset: opts.offset, since };
    const token = opts.token ? lowerHex(opts.token) : undefined;
    if (token) {
      return this.selectFeeHistoryByToken.all({
        ...params,
        token,
      }) as FeeAccrualRow[];
    }
    return this.selectFeeHistory.all(params) as FeeAccrualRow[];
  }

  /** Per-token aggregate: bigint sum of amount_wei and row count.
   *  Bounded by `since` (default 0 = all time). Rows are streamed
   *  via better-sqlite3's iterator so the JS heap holds at most one
   *  row at a time even when history runs to millions. Malformed
   *  amount_wei values are counted but excluded from the sum, so a
   *  single bad row never breaks the aggregate. */
  getFeeTotals(
    since = 0,
    until = 0,
  ): Array<{ token: string; count: number; totalWei: string }> {
    const result: Array<{ token: string; count: number; totalWei: string }> = [];
    let current: { token: string; count: number; total: bigint } | null = null;
    const flush = () => {
      if (current) {
        result.push({
          token: current.token,
          count: current.count,
          totalWei: current.total.toString(),
        });
      }
    };
    for (const row of this.sumFeeHistoryByToken.iterate({ since, until }) as Iterable<{
      token: string;
      amount_wei: string;
    }>) {
      if (!current || current.token !== row.token) {
        flush();
        current = { token: row.token, count: 0, total: 0n };
      }
      try {
        current.total += BigInt(row.amount_wei);
      } catch {
        // Malformed row — count it but skip the sum contribution.
      }
      current.count++;
    }
    flush();
    return result;
  }

  // ─── Settlement push outbox ───────────────────────────────────
  //
  // Enqueue every confirmed settlement so a background worker can
  // retry the shared-OB push if the live fire-and-forget attempt
  // drops (transient network, indexer restart, etc). Local DB is
  // the trusted source; this outbox lets shared-OB catch up.

  /** Enqueue a settlement-push payload for delivery. No-op if the
   *  tx_hash is already in the outbox (covers duplicate enqueues from
   *  e.g. the live-push wrapper + a recovery sweep). */
  enqueueSettlementPush(txHash: string, payload: unknown): void {
    this.upsertPushOutbox.run({
      txHash: lowerHex(txHash) as string,
      payloadJson: JSON.stringify(payload),
      createdAt: Date.now(),
    });
  }

  /** Claim up to `limit` outbox rows that are pending and past the
   *  per-row backoff cutoff. Returns the raw payload so the worker
   *  can pass it back through `sharedClient.pushSettlement`. */
  getPendingSettlementPushes(
    limit: number,
    backoffMs: number,
  ): Array<{ txHash: string; payload: unknown; attempts: number }> {
    const rows = this.selectPendingPushes.all({
      cutoff: Date.now() - backoffMs,
      limit,
    }) as Array<{ tx_hash: string; payload_json: string; attempts: number }>;
    const out: Array<{ txHash: string; payload: unknown; attempts: number }> = [];
    for (const r of rows) {
      try {
        out.push({ txHash: r.tx_hash, payload: JSON.parse(r.payload_json), attempts: r.attempts });
      } catch {
        // Corrupt JSON — mark as failed so it doesn't keep tripping
        // the worker forever, but keep the row for forensics.
        this.markPushFailedStmt.run({
          txHash: r.tx_hash,
          now: Date.now(),
          error: "payload_json parse failed",
        });
      }
    }
    return out;
  }

  markSettlementPushSucceeded(txHash: string): void {
    this.markPushSucceededStmt.run({
      txHash: lowerHex(txHash) as string,
      now: Date.now(),
    });
  }

  markSettlementPushFailed(txHash: string, error: string): void {
    this.markPushFailedStmt.run({
      txHash: lowerHex(txHash) as string,
      now: Date.now(),
      // Bound the error string so a noisy stack trace can't blow up
      // the row size — the operator only needs the leading signal.
      error: error.slice(0, 500),
    });
  }

  getSettlementPushOutboxStats(): {
    total: number;
    pending: number;
    pushed: number;
    maxAttempts: number;
  } {
    const row = this.countPushOutbox.get({}) as {
      total: number;
      pending: number;
      pushed: number;
      maxAttempts: number | null;
    };
    return {
      total: row.total,
      pending: row.pending,
      pushed: row.pushed,
      maxAttempts: row.maxAttempts ?? 0,
    };
  }

  /** Sum per-token notional from confirmed settlements in [since, until).
   *  `until = 0` means "no upper bound". Sell and buy legs are summed
   *  separately so a USDC→TON trade contributes to both tokens'
   *  throughput. Rows without amount data (pre-migration) are skipped.
   *  Returns one entry per token actually settled in-window. */
  getVolumeTotals(
    since = 0,
    until = 0,
  ): Array<{
    token: string;
    sellFills: number;
    buyFills: number;
    totalSellWei: string;
    totalBuyWei: string;
  }> {
    const result: Array<{
      token: string;
      sellFills: number;
      buyFills: number;
      totalSellWei: string;
      totalBuyWei: string;
    }> = [];
    let current: {
      token: string;
      sellFills: number;
      buyFills: number;
      totalSell: bigint;
      totalBuy: bigint;
    } | null = null;
    const flush = () => {
      if (current) {
        result.push({
          token: current.token,
          sellFills: current.sellFills,
          buyFills: current.buyFills,
          totalSellWei: current.totalSell.toString(),
          totalBuyWei: current.totalBuy.toString(),
        });
      }
    };
    for (const row of this.sumVolumeByToken.iterate({ since, until }) as Iterable<{
      token: string;
      leg: "sell" | "buy";
      amount: string;
    }>) {
      if (!current || current.token !== row.token) {
        flush();
        current = {
          token: row.token,
          sellFills: 0,
          buyFills: 0,
          totalSell: 0n,
          totalBuy: 0n,
        };
      }
      try {
        const amt = BigInt(row.amount);
        if (row.leg === "sell") {
          current.totalSell += amt;
          current.sellFills++;
        } else {
          current.totalBuy += amt;
          current.buyFills++;
        }
      } catch {
        // Malformed amount — count nothing for this row.
      }
    }
    flush();
    return result;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS private_orders (
        pub_key_ax    TEXT NOT NULL,
        pub_key_ay    TEXT NOT NULL,
        nonce         TEXT NOT NULL,
        sell_token    TEXT NOT NULL,
        buy_token     TEXT NOT NULL,
        sell_amount   TEXT NOT NULL,
        buy_amount    TEXT NOT NULL,
        max_fee       TEXT NOT NULL,
        expiry        TEXT NOT NULL,
        sig_s         TEXT NOT NULL,
        sig_r8x       TEXT NOT NULL,
        sig_r8y       TEXT NOT NULL,
        owner_secret  TEXT NOT NULL,
        balance       TEXT NOT NULL,
        salt          TEXT NOT NULL,
        leaf_index    INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        settle_tx     TEXT,
        cross_relayer INTEGER NOT NULL DEFAULT 0,
        submitted_at  INTEGER NOT NULL,
        PRIMARY KEY (pub_key_ax, nonce)
      );

      CREATE TABLE IF NOT EXISTS private_claims (
        pub_key_ax    TEXT NOT NULL,
        nonce         TEXT NOT NULL,
        idx           INTEGER NOT NULL,
        secret        TEXT NOT NULL,
        recipient     TEXT NOT NULL,
        token         TEXT NOT NULL,
        amount        TEXT NOT NULL,
        release_time  TEXT NOT NULL,
        PRIMARY KEY (pub_key_ax, nonce, idx),
        FOREIGN KEY (pub_key_ax, nonce) REFERENCES private_orders(pub_key_ax, nonce) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_po_status ON private_orders(status, submitted_at);
      CREATE INDEX IF NOT EXISTS idx_po_pair ON private_orders(sell_token, buy_token);
      CREATE INDEX IF NOT EXISTS idx_po_pubkey ON private_orders(pub_key_ax, submitted_at);

      -- Track claims roots from settlements this relayer has processed.
      -- Used to reject gasless claim requests for orders settled by other relayers.
      CREATE TABLE IF NOT EXISTS settled_claims_roots (
        claims_root   TEXT PRIMARY KEY,
        settled_at    INTEGER NOT NULL
      );

      -- Cross-relayer Trade Offer audit trail
      CREATE TABLE IF NOT EXISTS trade_offers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        direction     TEXT NOT NULL,          -- 'sent' or 'received'
        peer_relayer  TEXT NOT NULL,          -- counterparty relayer address
        maker_pub_key TEXT NOT NULL,
        maker_nonce   TEXT NOT NULL,
        taker_pub_key TEXT NOT NULL,
        taker_nonce   TEXT NOT NULL,
        status        TEXT NOT NULL,          -- 'settled', 'rejected', 'error'
        tx_hash       TEXT,
        reason        TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_to_created ON trade_offers(created_at);
      CREATE INDEX IF NOT EXISTS idx_to_direction ON trade_offers(direction, created_at);
      CREATE INDEX IF NOT EXISTS idx_to_peer ON trade_offers(peer_relayer, created_at);
    `);

    // Migration: add cross_relayer column to existing databases
    try {
      this.db.exec(`ALTER TABLE private_orders ADD COLUMN cross_relayer INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }

    // Migration: add settled_at column for settlement time tracking
    try {
      this.db.exec(`ALTER TABLE private_orders ADD COLUMN settled_at INTEGER`);
    } catch { /* column already exists */ }

    // Persist newSalt / expectedChangeCommitment so restart-recovered orders
    // can still compute/validate the correct change commitment during settlement.
    try {
      this.db.exec(`ALTER TABLE private_orders ADD COLUMN new_salt TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE private_orders ADD COLUMN expected_change_commitment TEXT`);
    } catch { /* column already exists */ }

    // Migration: relayer_meta key-value store (uptime tracking, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relayer_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // [R-6] Authorize orders persistence — survive relayer restarts.
    // Async-settlement FSM: accepted → settling → retrying → settled | failed
    // | dead_letter; orderly parallel states: cancelled | expired. Legacy
    // values ('pending', 'matched') remain readable for one release.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorize_orders (
        nullifier     TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'pending',
        submitted_at  INTEGER NOT NULL,
        settle_tx     TEXT,
        pub_key_ax    TEXT,
        pub_key_ay    TEXT,
        order_json    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ao_status ON authorize_orders(status);
    `);

    // Drop the old archive table from any DB that still has it
    // (deployments that booted on the previous PR's schema), but
    // migrate any rows it holds back into the live table FIRST so
    // operators don't lose the past-order history they were
    // keeping in the archive. INSERT OR IGNORE so a row that's
    // already present in live (re-init after partial migration)
    // doesn't error on the PRIMARY KEY.
    //
    // We check `sqlite_master` before running the INSERT so this
    // path is silent on fresh DBs (no archive table to query). A
    // log.warn on real failure surfaces the issue without aborting
    // startup — the operator can re-run by hand if needed.
    try {
      const hasArchive = this.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type='table' AND name='authorize_orders_archive'`,
        )
        .get();
      if (hasArchive) {
        this.db.exec(`
          INSERT OR IGNORE INTO authorize_orders (
            nullifier, status, submitted_at, settle_tx,
            pub_key_ax, pub_key_ay, order_json
          )
          SELECT
            nullifier, status, submitted_at, settle_tx,
            pub_key_ax, pub_key_ay, order_json
          FROM authorize_orders_archive
        `);
        this.db.exec(`DROP TABLE IF EXISTS authorize_orders_archive`);
      }
    } catch (err) {
      // Surface the failure so an operator can re-run the migration
      // by hand instead of silently losing history. Startup keeps
      // going — the archive is informational data only.
      // eslint-disable-next-line no-console
      console.warn(
        "[db migration] failed to drain authorize_orders_archive into live table",
        err,
      );
    }

    // Async-settlement extensions. Each column is added via idempotent
    // ALTER so existing relayer DBs upgrade on first boot.
    //
    //   attempt       — number of settlement attempts; incremented on each
    //                   retry scheduling. Crosses MAX_ATTEMPTS → dead_letter.
    //   next_retry_at — epoch-ms when the order is eligible for the next
    //                   settlement attempt. NULL when not currently scheduled
    //                   (either settling, terminal, or just accepted — the
    //                   worker treats NULL + 'accepted' as "ready now").
    //   last_error    — most recent settlement error text; surfaced via
    //                   GET /:nullifier when status is failed | dead_letter.
    //   updated_at    — epoch-ms of last status mutation. Powers the status
    //                   endpoint's updatedAt field without a separate log.
    try { this.db.exec(`ALTER TABLE authorize_orders ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE authorize_orders ADD COLUMN next_retry_at INTEGER`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE authorize_orders ADD COLUMN last_error TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE authorize_orders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

    // Queue-lookup index: the worker asks "which orders are ready to run?"
    // against (status IN ('accepted','retrying'), next_retry_at <= now).
    // Partial index keeps it tight — terminal rows don't pollute it.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ao_queue
        ON authorize_orders (status, next_retry_at)
        WHERE status IN ('accepted', 'retrying');
    `);

    // [R-2] Pending TX tracking for receipt recovery on restart
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_txs (
        tx_hash    TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Persistent settlement & fee history. Powers /api/relayer/history
    // so the operator dashboard can show real numbers instead of the
    // rolling-window metrics. One row per settlement attempt; fees
    // are recorded per side in fee_history. fee_history.tx_hash is a
    // logical reference to settlement_history.tx_hash (enforced by
    // recordSettlementEvent inserting both in one transaction), not
    // a SQL FOREIGN KEY — settlement_history rows are never deleted,
    // and skipping the constraint avoids cascade-on-detach surprises
    // if a future migration trims old history.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash       TEXT NOT NULL UNIQUE,
        type          TEXT NOT NULL,
        status        TEXT NOT NULL,
        block_number  INTEGER,
        gas_cost_eth  TEXT,
        sell_token    TEXT,
        buy_token     TEXT,
        error_reason  TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sh_created ON settlement_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sh_type_created ON settlement_history(type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sh_status_created ON settlement_history(status, created_at DESC);
    `);
    // Migration: add duration_ms (settlement latency, ms from worker
    // claim to confirmation). Idempotent ALTER so existing operator
    // DBs upgrade in place. Used by the SLA / performance buckets
    // endpoint for p50/p95/p99 latency.
    try {
      this.db.exec(`ALTER TABLE settlement_history ADD COLUMN duration_ms INTEGER`);
    } catch { /* column already exists */ }
    // Migration: maker-leg notional, populated by recordSettlementEvent
    // callers that have the decoded public signals (authorize-submitter).
    // The /api/admin/history/volume aggregate sums these to surface
    // per-token throughput in the operators analytics page; rows from
    // before this column existed report fills but contribute 0 to volume.
    try {
      this.db.exec(`ALTER TABLE settlement_history ADD COLUMN sell_amount TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE settlement_history ADD COLUMN buy_amount TEXT`);
    } catch { /* column already exists */ }
    // Migration: counterparty flag. 1 marks rows the local relayer did
    // NOT submit on-chain but participated in as the counterparty side
    // of a cross-relayer match (the peer submitted; we observed the
    // settle through the trade-offer response and recorded our own
    // leg locally so the leaderboard reflects our participation).
    // Column is `NOT NULL DEFAULT 0`, so pre-existing rows auto-fill
    // as 0 (submitter side) when the ALTER runs — no NULLs ever stored.
    // SQLite has no BOOLEAN — INTEGER 0/1 is the conventional shape.
    try {
      this.db.exec(`ALTER TABLE settlement_history ADD COLUMN counterparty INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fee_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash       TEXT NOT NULL,
        side          TEXT NOT NULL,
        token         TEXT NOT NULL,
        amount_wei    TEXT NOT NULL,
        block_number  INTEGER,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fh_token_created ON fee_history(token, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fh_tx ON fee_history(tx_hash);
    `);

    // Outbox for shared-OB settlement pushes. The live push path is
    // fire-and-forget — a transient shared-OB outage silently drops
    // the notification, and the leaderboard (which sources from
    // shared-OB) then under-reports until the next push succeeds.
    // Persisting the payload here lets a background worker retry until
    // shared-OB acknowledges the row. tx_hash is PK so the live push +
    // worker re-attempt converge on the same row.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_push_outbox (
        tx_hash         TEXT PRIMARY KEY,
        payload_json    TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_error      TEXT,
        pushed_at       INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spo_pending ON settlement_push_outbox(pushed_at, last_attempt_at);
    `);
  }


  /** Record a claims root from a settlement this relayer processed. */
  saveSettledClaimsRoot(claimsRoot: string): void {
    this.insertClaimsRoot.run({ claimsRoot: claimsRoot.toLowerCase(), settledAt: Date.now() });
  }

  /** Check if a claims root was settled by this relayer. */
  hasSettledClaimsRoot(claimsRoot: string): boolean {
    return !!this.selectClaimsRoot.get({ claimsRoot: claimsRoot.toLowerCase() });
  }

  // ─── Trade Offer audit trail ───

  recordTradeOffer(params: {
    direction: "sent" | "received";
    peerRelayer: string;
    makerPubKey: string;
    makerNonce: string;
    takerPubKey: string;
    takerNonce: string;
    status: "settled" | "rejected" | "error";
    txHash?: string;
    reason?: string;
  }): void {
    this.insertTradeOffer.run({
      direction: params.direction,
      peerRelayer: params.peerRelayer.toLowerCase(),
      makerPubKey: params.makerPubKey,
      makerNonce: params.makerNonce,
      takerPubKey: params.takerPubKey,
      takerNonce: params.takerNonce,
      status: params.status,
      txHash: params.txHash ?? null,
      reason: params.reason ?? null,
      createdAt: Date.now(),
    });
  }

  getTradeOffers(limit = 50, offset = 0): TradeOfferRow[] {
    return this.selectTradeOffers.all({ limit, offset }) as TradeOfferRow[];
  }

  /** Filtered Trade Offer query for the operator Cross-relayer view.
   *  Every filter is optional; an unset filter is passed as `null`
   *  and matched permissively in SQL. `peer` is lowercased for the
   *  same casing-safety reason every hex column gets in this file. */
  getTradeOffersFiltered(opts: TradeOfferQueryOpts): TradeOfferRow[] {
    return this.selectTradeOffersFiltered.all({
      limit: opts.limit,
      offset: opts.offset,
      direction: opts.direction ?? null,
      status: opts.status ?? null,
      peer: opts.peer ? lowerHex(opts.peer) : null,
      since: opts.since ?? 0,
    }) as TradeOfferRow[];
  }

  /** Total-records count for the same filter combo as
   *  `getTradeOffersFiltered`. Powers the paginated UI's "page X
   *  of N" indicator. Limit/offset are intentionally absent here
   *  — `since` and the three optional filters fully determine the
   *  set being counted. */
  countTradeOffers(opts: Omit<TradeOfferQueryOpts, "limit" | "offset">): number {
    const row = this.countTradeOffersFiltered.get({
      direction: opts.direction ?? null,
      status: opts.status ?? null,
      peer: opts.peer ? lowerHex(opts.peer) : null,
      since: opts.since ?? 0,
    }) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Per-peer aggregate of trade-offer activity since `since`
   *  (default: all time). Surfaces sent/received counts plus
   *  settled/rejected/error split so an operator can spot a peer
   *  that's repeatedly rejecting. Sorted most-engaged-first.
   *  Note: `peer` is the lowercase form (matches the storage
   *  contract of `recordTradeOffer`); callers comparing against
   *  user input should lowercase that input first. */
  getPeerStats(since = 0): PeerStatsRow[] {
    // SQL aliases (peer / sent / received / …) already match
    // PeerStatsRow's field names, so a direct cast is enough — no
    // intermediate map required.
    return this.selectPeerStats.all({ since }) as PeerStatsRow[];
  }

  /** Get relayer performance statistics for dashboard/profile. */
  /** Stats are aggregated from `settlement_history` (full-table COUNTs
   *  + AVG over `duration_ms`) and `trade_offers`. Both `/api/admin/status`
   *  and `/metrics` poll this on a tight cadence; cache the result for
   *  a few seconds so we're not repeating the aggregate scan back-to-back
   *  as the table grows. The TTL is short enough that staleness is
   *  invisible to a refreshing operator console. */
  private statsCache: { at: number; value: ReturnType<PrivateOrderDB["getRelayerStats"]> } | null = null;
  private static STATS_TTL_MS = 5_000;

  getRelayerStats(): {
    totalOrders: number;
    settledOrders: number;
    successRate: number;
    crossRelayerSettled: number;
    totalTradeOffers: number;
    settledTradeOffers: number;
    avgSettleTimeMs: number | null;
    uptimeSince: number | null;
  } {
    const now = Date.now();
    if (this.statsCache && now - this.statsCache.at < PrivateOrderDB.STATS_TTL_MS) {
      return this.statsCache.value;
    }
    const total = (this.statsTotalOrders.get({}) as { count: number }).count;
    const settled = (this.statsSettledOrders.get({}) as { count: number }).count;
    const tradeTotal = (this.statsTotalTradeOffers.get({}) as { count: number }).count;
    const tradeSettled = (this.statsSettledTradeOffers.get({}) as { count: number }).count;
    // Trade offers reach `status='settled'` only via cross-relayer
    // settlement; reuse the same count rather than running it twice.
    const crossRelayer = tradeSettled;
    const avgRow = this.statsAvgSettleTime.get({}) as { avg_ms: number | null };
    const avgSettleTimeMs = avgRow.avg_ms !== null ? Math.round(avgRow.avg_ms) : null;

    const startedAtRaw = this.getMeta("started_at");
    const startedAt = startedAtRaw !== null ? Number(startedAtRaw) : NaN;

    const value = {
      totalOrders: total,
      settledOrders: settled,
      successRate: total > 0 ? Math.round((settled / total) * 100) : 0,
      crossRelayerSettled: crossRelayer,
      totalTradeOffers: tradeTotal,
      settledTradeOffers: tradeSettled,
      avgSettleTimeMs,
      uptimeSince: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
    };
    this.statsCache = { at: now, value };
    return value;
  }

  /** Get per-token settled volume breakdown (BigInt-safe, SQL-grouped).
   *  Tokens already stored lowercased via lowerHex in recordSettlementEvent,
   *  so the row's sell_token is returned as-is — the prior `BigInt(...)`
   *  reformat was a leftover from when the column held checksummed
   *  addresses and would now strip canonical lowercase to the same
   *  string, just slower.
   *
   *  Per-token shape since the buy-leg UNION (see `statsSettledVolume`
   *  prep): `amounts` is a comma-joined string of EITHER `sell_amount`
   *  (always) OR `buy_amount` (only for `type='settleAuth'` rows where
   *  the buy leg is a genuinely different token movement). NULLs are
   *  skipped at the SQL layer. `''` means "no rows", which
   *  `split(",").filter(Boolean)` handles cleanly without a sentinel
   *  BigInt parse. The outer `sellToken` field name is preserved as
   *  the wire contract — its value can be a buy-leg token but the
   *  consumers (`/api/relayer/stats`, Prometheus labels) gate on the
   *  field name, not the literal "sell" semantic. */
  getSettledVolume(): Array<{ sellToken: string; count: number; totalVolume: string }> {
    const rows = this.statsSettledVolume.all({}) as Array<{ sell_token: string; count: number; amounts: string }>;
    return rows.map((r) => {
      const total = r.amounts
        .split(",")
        .filter(Boolean)
        .reduce((sum, a) => {
          try { return sum + BigInt(a); } catch { return sum; }
        }, 0n);
      return {
        sellToken: r.sell_token,
        count: r.count,
        totalVolume: total.toString(),
      };
    });
  }

  setMeta(key: string, value: string): void {
    this.upsertMeta.run({ key, value });
  }

  getMeta(key: string): string | null {
    const row = this.selectMeta.get({ key }) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Per-token claim-reminder thresholds (wei strings, keyed by
   *  lowercase token address). Stored as a single JSON blob in
   *  relayer_meta. Returns `{}` if the blob is missing or corrupt
   *  — a bad value loses the config but doesn't kill the monitor. */
  getClaimThresholds(): Record<string, string> {
    const raw = this.getMeta("claim_thresholds_json");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          // Apply the same wire-format guard as the setter so a
          // corrupt/legacy blob can't surface a value that later
          // crashes BigInt() in the claim-monitor probe loop.
          if (isWeiString(v)) out[k.toLowerCase()] = v;
        }
        return out;
      }
    } catch {
      /* fall through */
    }
    return {};
  }

  setClaimThresholds(thresholds: Record<string, string>): void {
    const normalised: Record<string, string> = {};
    for (const [k, v] of Object.entries(thresholds)) {
      if (!isWeiString(v)) continue;
      normalised[k.toLowerCase()] = v;
    }
    this.setMeta("claim_thresholds_json", JSON.stringify(normalised));
  }

  // ─── [R-6] Authorize order persistence ───

  saveAuthorizeOrder(nullifier: string, status: string, submittedAt: number, orderJson: string, pubKeyAx?: string | null, pubKeyAy?: string | null, settleTx?: string | null): void {
    // Seed `updated_at` to `submittedAt` so the terminal-retention
    // cutoff in purgeAuthNonPending has a meaningful baseline for rows
    // that never transition (they'd only be purged once their circuit
    // expiry lapses, which is the intended behaviour).
    this.upsertAuthOrder.run([nullifier, status, submittedAt, submittedAt, orderJson, pubKeyAx ?? null, pubKeyAy ?? null, settleTx ?? null]);
  }

  updateAuthorizeOrderStatus(nullifier: string, status: string, settleTx?: string | null): void {
    // Stamp `updated_at` on every status mutation — including legacy
    // call sites like the cross-relayer matcher's 'settled' write —
    // so a future opt-in purgeAuthNonPending sweep has a meaningful
    // baseline. The default config keeps every row forever
    // (TERMINAL_RETENTION_MS = 0).
    this.updateAuthStatus.run([status, settleTx ?? null, Date.now(), nullifier]);
  }

  deleteAuthorizeOrder(nullifier: string): void {
    this.deleteAuthOrder.run(nullifier);
  }

  loadPendingAuthorizeOrders(): Array<{ nullifier: string; status: string; submittedAt: number; orderJson: string; pubKeyAx: string | null; pubKeyAy: string | null; settleTx: string | null }> {
    return this.selectPendingAuth.all({}) as any[];
  }

  purgeNonPendingAuthorizeOrdersDB(): number {
    // retention <= 0 means "never purge" — short-circuit before
    // computing the cutoff. The previous shape (`Date.now() - 0`)
    // resolved to `Date.now()`, which the SQL then matched against
    // `updated_at < ?` and deleted everything, defeating the
    // "default = forever" intent entirely.
    const retentionMs = readRetentionMs();
    if (retentionMs <= 0) return 0;
    const terminalCutoffMs = Date.now() - retentionMs;
    const result = this.purgeAuthNonPending.run([terminalCutoffMs]);
    return result.changes;
  }

  // ─── Async-settlement queue API ────────────────────────────────

  /** Full row lookup keyed by nullifier. Used by the idempotency check
   *  on POST and by the status GET endpoint. */
  getAuthorizeOrder(nullifier: string): AuthorizeOrderRow | null {
    return (this.selectAuthByNullifier.get(nullifier) as AuthorizeOrderRow | undefined) ?? null;
  }

  /** Insert a fresh order as 'accepted'. Throws on nullifier collision —
   *  the caller catches and resolves via the idempotency path. */
  insertAcceptedOrder(params: {
    nullifier: string;
    submittedAt: number;
    orderJson: string;
    pubKeyAx?: string | null;
    pubKeyAy?: string | null;
  }): void {
    this.insertAcceptedAuth.run([
      params.nullifier,
      params.submittedAt,
      params.submittedAt, // updated_at = submitted_at at creation
      params.orderJson,
      params.pubKeyAx ?? null,
      params.pubKeyAy ?? null,
    ]);
  }

  /** Atomic dequeue: the next accepted/retrying order whose schedule is
   *  due becomes 'settling' and is returned. Null when the queue is empty. */
  claimNextSettlementJob(): AuthorizeOrderRow | null {
    const now = Date.now();
    return (this.claimSettlementJob.get([now, now]) as AuthorizeOrderRow | undefined) ?? null;
  }

  markAuthorizeOrderSettled(nullifier: string, txHash: string): void {
    this.markAuthSettled.run([txHash, Date.now(), nullifier]);
  }

  markAuthorizeOrderFailed(nullifier: string, error: string): void {
    this.markAuthFailed.run([truncErr(error), Date.now(), nullifier]);
  }


  markAuthorizeOrderDeadLetter(nullifier: string, error: string): void {
    this.markAuthDeadLetter.run([truncErr(error), Date.now(), nullifier]);
  }

  scheduleAuthorizeOrderRetry(params: {
    nullifier: string;
    attempt: number;
    nextRetryAt: number;
    error: string;
  }): void {
    this.scheduleAuthRetry.run([
      params.attempt,
      params.nextRetryAt,
      truncErr(params.error),
      Date.now(),
      params.nullifier,
    ]);
  }

  /** Defer an accepted order that isn't ready to settle (e.g. cross-token
   *  waiting for a counterparty). Status stays 'accepted' and attempt is
   *  untouched — this is not a retry, just rescheduling. */
  deferAcceptedAuthorizeOrder(nullifier: string, nextRetryAt: number): void {
    this.deferAcceptedAuth.run([nextRetryAt, Date.now(), nullifier]);
  }

  /** Persist the broadcast tx hash even before confirmation so a crash
   *  mid-wait leaves enough trail to recover the receipt on restart. */
  recordAuthorizeOrderTxHash(nullifier: string, txHash: string): void {
    this.setAuthTxHash.run([txHash, Date.now(), nullifier]);
  }

  /** Reset orphaned 'settling' rows to 'accepted' on relayer boot. The
   *  worker that was driving them was killed mid-flight; the queue claim
   *  is the only place that should set 'settling', and only one process
   *  may hold the DB at a time, so anything left in this state at boot
   *  is by definition orphaned.
   *
   *  On-chain idempotency (the nullifier was either spent or it wasn't)
   *  means a retried submit either succeeds or reverts cleanly; the
   *  classifier promotes a revert to terminal `failed`. Receipt-based
   *  recovery for the "tx broadcast but receipt missing" case is handled
   *  separately by the pending_txs table (R-2).
   *
   *  Returns the count of rows reset (for boot-time logging). */
  resetOrphanedSettlingOrders(): number {
    return this.resetOrphanedSettlingAuth.run([Date.now()]).changes;
  }

  /** Bulk-mark any in-flight order whose circuit expiry has passed.
   *  Called by the expiry sweeper; returns the affected row count. */
  sweepExpiredAuthorizeOrders(): number {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = this.sweepExpiredAuth.run([Date.now(), nowSeconds]);
    return result.changes;
  }

  // ─── Pending TX tracking (R-2) ───

  savePendingTx(txHash: string, label: string): void {
    this.insertPendingTx.run({ txHash: txHash.toLowerCase(), label, createdAt: Date.now() });
  }

  removePendingTx(txHash: string): void {
    this.deletePendingTx.run({ txHash: txHash.toLowerCase() });
  }

  getPendingTxs(): Array<{ tx_hash: string; label: string; created_at: number }> {
    return this.selectPendingTxs.all({}) as Array<{ tx_hash: string; label: string; created_at: number }>;
  }

  close(): void {
    this.db.close();
  }
}
