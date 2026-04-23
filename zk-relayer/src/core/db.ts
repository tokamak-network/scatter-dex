import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
// Private-flow types removed with the tracker #29 cleanup. Authorize-flow
// row shapes are inlined below.

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "zk-relayer.db");

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
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
function truncErr(err: string): string {
  return err.length > MAX_ERR_LEN ? err.slice(0, MAX_ERR_LEN - 1) + "…" : err;
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
  private statsTotalOrders: ReturnType<Database.Database["prepare"]>;
  private statsSettledOrders: ReturnType<Database.Database["prepare"]>;
  private statsCrossRelayer: ReturnType<Database.Database["prepare"]>;
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
      console.warn(`[M-10] Failed to set DB permissions: ${e instanceof Error ? e.message : e}`);
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
      SELECT * FROM trade_offers ORDER BY created_at DESC LIMIT @limit OFFSET @offset
    `);
    this.statsTotalOrders = this.db.prepare("SELECT COUNT(*) as count FROM private_orders");
    this.statsSettledOrders = this.db.prepare("SELECT COUNT(*) as count FROM private_orders WHERE status = 'settled'");
    this.statsCrossRelayer = this.db.prepare("SELECT COUNT(*) as count FROM private_orders WHERE status = 'settled' AND cross_relayer = 1");
    this.statsTotalTradeOffers = this.db.prepare("SELECT COUNT(*) as count FROM trade_offers");
    this.statsSettledTradeOffers = this.db.prepare("SELECT COUNT(*) as count FROM trade_offers WHERE status = 'settled'");
    this.statsAvgSettleTime = this.db.prepare(
      "SELECT AVG(settled_at - submitted_at) as avg_ms FROM private_orders WHERE status = 'settled' AND settled_at IS NOT NULL",
    );
    this.statsSettledVolume = this.db.prepare(
      `SELECT sell_token, COUNT(*) as count, GROUP_CONCAT(sell_amount) as amounts
       FROM private_orders WHERE status = 'settled' GROUP BY sell_token`,
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

  /** Get relayer performance statistics for dashboard/profile. */
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
    const total = (this.statsTotalOrders.get({}) as { count: number }).count;
    const settled = (this.statsSettledOrders.get({}) as { count: number }).count;
    const crossRelayer = (this.statsCrossRelayer.get({}) as { count: number }).count;
    const tradeTotal = (this.statsTotalTradeOffers.get({}) as { count: number }).count;
    const tradeSettled = (this.statsSettledTradeOffers.get({}) as { count: number }).count;
    const avgRow = this.statsAvgSettleTime.get({}) as { avg_ms: number | null };
    const avgSettleTimeMs = avgRow.avg_ms !== null ? Math.round(avgRow.avg_ms) : null;

    const startedAtRaw = this.getMeta("started_at");
    const startedAt = startedAtRaw !== null ? Number(startedAtRaw) : NaN;

    return {
      totalOrders: total,
      settledOrders: settled,
      successRate: total > 0 ? Math.round((settled / total) * 100) : 0,
      crossRelayerSettled: crossRelayer,
      totalTradeOffers: tradeTotal,
      settledTradeOffers: tradeSettled,
      avgSettleTimeMs,
      uptimeSince: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
    };
  }

  /** Get per-token settled volume breakdown (BigInt-safe, SQL-grouped). */
  getSettledVolume(): Array<{ sellToken: string; count: number; totalVolume: string }> {
    const rows = this.statsSettledVolume.all({}) as Array<{ sell_token: string; count: number; amounts: string }>;
    return rows.map((r) => {
      const total = r.amounts.split(",").reduce((sum, a) => sum + BigInt(a), 0n);
      const tokenBig = BigInt(r.sell_token);
      return {
        sellToken: "0x" + tokenBig.toString(16).padStart(40, "0"),
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
    // so terminal rows get their 1h grace window in purgeAuthNonPending.
    this.updateAuthStatus.run([status, settleTx ?? null, Date.now(), nullifier]);
  }

  deleteAuthorizeOrder(nullifier: string): void {
    this.deleteAuthOrder.run(nullifier);
  }

  loadPendingAuthorizeOrders(): Array<{ nullifier: string; status: string; submittedAt: number; orderJson: string; pubKeyAx: string | null; pubKeyAy: string | null; settleTx: string | null }> {
    return this.selectPendingAuth.all({}) as any[];
  }

  purgeNonPendingAuthorizeOrdersDB(): number {
    const terminalCutoffMs = Date.now() - TERMINAL_RETENTION_MS;
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
