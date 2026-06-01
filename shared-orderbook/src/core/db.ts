import Database from "better-sqlite3";
import { clampLimit } from "@scatter-dex/types";
import { config } from "../config.js";
import type { OrderSummary, OrderStatus, StoredOrder, MatchResult } from "../types/order.js";
import type {
  SettlementInsert,
  SettlementType,
  StoredSettlement,
  SettlementListFilter,
  TokenVolumeRow,
  RelayerSettlementStats,
  NetworkSettlementTotals,
  LeaderboardRow,
  LeaderboardMetric,
} from "../types/settlement.js";
import type {
  KycSubmission,
  KycStatus,
  KycSubmissionInsert,
  KycSubmissionUpdate,
  KycListFilter,
} from "../types/kyc.js";
import type { RootCaRecord } from "../types/ca.js";

export class OrderbookDB {
  private db: Database.Database;

  // Prepared statements
  private stmtInsertOrder!: Database.Statement;
  private stmtGetOrder!: Database.Statement;
  private stmtUpdateStatus!: Database.Statement;
  private stmtDeleteOrder!: Database.Statement;
  private stmtListOpen!: Database.Statement;
  private stmtListAll!: Database.Statement;
  private stmtListByStatus!: Database.Statement;
  private stmtCountByStatus!: Database.Statement;
  private stmtListByPair!: Database.Statement;
  private stmtListByRelayer!: Database.Statement;
  private stmtCountByRelayer!: Database.Statement;
  private stmtPurgeExpired!: Database.Statement;
  private stmtInsertMatch!: Database.Statement;
  private stmtGetMatchJoin!: Database.Statement;
  private stmtListMatchesJoin!: Database.Statement;
  private stmtInsertSettlement!: Database.Statement;
  private stmtGetSettlement!: Database.Statement;
  private stmtInsertKyc!: Database.Statement;
  private stmtGetKycById!: Database.Statement;
  private stmtGetKycByWallet!: Database.Statement;
  private stmtUpdateKycFiles!: Database.Statement;
  private stmtUpdateKycStatus!: Database.Statement;
  private stmtListKycAll!: Database.Statement;
  private stmtListKycByStatus!: Database.Statement;
  private stmtDeactivateRootCa!: Database.Statement;
  private stmtUpsertRootCa!: Database.Statement;
  private stmtGetActiveRootCa!: Database.Statement;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createTables();
    this.prepareStatements();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        relayer TEXT NOT NULL,
        relayer_url TEXT NOT NULL,
        sell_token TEXT NOT NULL,
        buy_token TEXT NOT NULL,
        sell_amount TEXT NOT NULL,
        buy_amount TEXT NOT NULL,
        min_fill_amount TEXT NOT NULL DEFAULT '0',
        max_fee INTEGER NOT NULL,
        expiry INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        match_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(sell_token, buy_token);
      CREATE INDEX IF NOT EXISTS idx_orders_relayer ON orders(relayer, created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(expiry);

      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        maker_id TEXT NOT NULL REFERENCES orders(id),
        taker_id TEXT NOT NULL REFERENCES orders(id),
        settling_relayer TEXT NOT NULL,
        pair TEXT NOT NULL,
        price TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Phase 2.5a: relayer-pushed settlement records. See
      -- docs/design/relayer-pages-redesign.md §7.1. Soft-references the
      -- orders table so matched orders can be pruned without losing
      -- settlement history; nullifiers are required so the verify job
      -- (Phase 2.5b) can link rows to PrivateSettledAuth events keyed by
      -- nullifier.
      CREATE TABLE IF NOT EXISTS settlements (
        tx_hash            TEXT PRIMARY KEY,
        block_number       INTEGER NOT NULL,
        block_time         INTEGER,
        submitter          TEXT NOT NULL,
        maker_relayer      TEXT NOT NULL,
        taker_relayer      TEXT,
        maker_order_id     TEXT,
        taker_order_id     TEXT,
        maker_nullifier    TEXT NOT NULL,
        taker_nullifier    TEXT NOT NULL,
        sell_token         TEXT,
        buy_token          TEXT,
        sell_amount        TEXT,
        buy_amount         TEXT,
        fee_maker          TEXT NOT NULL,
        fee_taker          TEXT NOT NULL,
        user_maxfee_maker  INTEGER NOT NULL,
        user_maxfee_taker  INTEGER NOT NULL,
        verified           INTEGER NOT NULL DEFAULT 0,
        type               TEXT,
        created_at         INTEGER NOT NULL
      );

      -- Composite secondary key is block_number (not block_time) so
      -- listSettlements' ORDER BY block_number DESC can stream straight
      -- off the index without a filesort. block_time is nullable in
      -- Phase 2.5a (verify job backfills it), so it's a poor sort key.
      CREATE INDEX IF NOT EXISTS idx_settle_submitter   ON settlements(submitter, block_number);
      CREATE INDEX IF NOT EXISTS idx_settle_maker       ON settlements(maker_relayer, block_number);
      CREATE INDEX IF NOT EXISTS idx_settle_taker       ON settlements(taker_relayer, block_number);
      CREATE INDEX IF NOT EXISTS idx_settle_pair        ON settlements(sell_token, buy_token, block_number);
      CREATE INDEX IF NOT EXISTS idx_settle_block       ON settlements(block_number);
      CREATE INDEX IF NOT EXISTS idx_settle_nullifier_m ON settlements(maker_nullifier);
      CREATE INDEX IF NOT EXISTS idx_settle_nullifier_t ON settlements(taker_nullifier);

      -- Expression index so "since" filters on COALESCE(block_time,
      -- created_at) >= ? (used by listSettlements, getNetworkSettlementTotals,
      -- getLeaderboard) can be served by an index rather than a table scan.
      -- SQLite expression indexes require the filter expression to match
      -- verbatim — keep these in sync with the WHERE clauses.
      CREATE INDEX IF NOT EXISTS idx_settle_time_coalesce
        ON settlements(COALESCE(block_time, created_at));

      -- Relayer operator KYC onboarding (Stage 1). Submissions arrive on the
      -- public POST /api/kyc/submit endpoint; an admin reviews them (PR2) and
      -- a cert is issued (PR3). The wallet is stored lowercased so the status
      -- lookup and re-submission path are case-insensitive. The uploaded
      -- video / ID document live on disk under config.kycUploadDir/<id>/ —
      -- only their paths are kept here.
      CREATE TABLE IF NOT EXISTS kyc_submissions (
        id          TEXT PRIMARY KEY,
        wallet      TEXT NOT NULL,
        email       TEXT,
        video_path  TEXT,
        id_doc_path TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        notes       TEXT,
        created_at  INTEGER NOT NULL,
        reviewed_at INTEGER
      );

      -- Lookup by wallet (status endpoint + re-submission) and the admin
      -- review queue (status, newest-first).
      CREATE INDEX IF NOT EXISTS idx_kyc_wallet ON kyc_submissions(wallet, created_at);
      CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_submissions(status, created_at);

      -- Public Root CA certificates (operator onboarding X.509 anchor). Only
      -- the public DER is stored — the CA private key never reaches the
      -- server. One row is active=1 at a time (the current Root CA);
      -- superseded certs are kept (active=0) as history. Keyed by the cert's
      -- sha256 fingerprint (hex).
      CREATE TABLE IF NOT EXISTS root_ca (
        fingerprint  TEXT PRIMARY KEY,
        der          BLOB NOT NULL,
        common_name  TEXT,
        organization TEXT,
        country      TEXT,
        not_after    INTEGER,
        created_at   INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_root_ca_active ON root_ca(active, created_at);
    `);

    // Lightweight ALTER for pre-byApp databases — adds the `type`
    // column to settlements tables that were created before the
    // column existed. SQLite has no `IF NOT EXISTS` on ALTER, so we
    // probe column metadata first via better-sqlite3's `.pragma()`
    // helper. Rows that pre-date the change keep NULL — the byApp
    // aggregator treats those as "unknown" and skips them instead
    // of fabricating a Pay/Pro attribution.
    const columns = this.db.pragma("table_info(settlements)") as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "type")) {
      this.db.exec("ALTER TABLE settlements ADD COLUMN type TEXT");
    }
  }

  private prepareStatements(): void {
    this.stmtInsertOrder = this.db.prepare(`
      INSERT INTO orders (id, relayer, relayer_url, sell_token, buy_token,
        sell_amount, buy_amount, min_fill_amount, max_fee, expiry, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `);

    this.stmtGetOrder = this.db.prepare(`SELECT * FROM orders WHERE id = ?`);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE orders SET status = ?, match_id = ? WHERE id = ?
    `);

    this.stmtDeleteOrder = this.db.prepare(`DELETE FROM orders WHERE id = ?`);

    this.stmtListOpen = this.db.prepare(`
      SELECT * FROM orders WHERE status = 'open' ORDER BY created_at ASC LIMIT ? OFFSET ?
    `);
    // Status-bucket queries used by the new /api/orders?status=... view.
    // listAll keeps the original ordering shape (open-first) so the
    // "All" tab in the UI doesn't look randomly shuffled — terminal
    // rows fall to the bottom by created_at DESC instead of intermixing.
    this.stmtListAll = this.db.prepare(`
      SELECT * FROM orders
      ORDER BY
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT ? OFFSET ?
    `);
    this.stmtListByStatus = this.db.prepare(`
      SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);
    this.stmtCountByStatus = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM orders GROUP BY status
    `);

    // UNION ALL instead of OR — lets SQLite use idx_orders_pair on each branch
    this.stmtListByPair = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM orders WHERE status = 'open' AND sell_token = ? AND buy_token = ?
        UNION ALL
        SELECT * FROM orders WHERE status = 'open' AND sell_token = ? AND buy_token = ?
      ) ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    this.stmtListByRelayer = this.db.prepare(`
      SELECT * FROM orders WHERE relayer = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.stmtCountByRelayer = this.db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE relayer = ? AND status = 'open'
    `);

    this.stmtPurgeExpired = this.db.prepare(`
      UPDATE orders SET status = 'expired' WHERE status = 'open' AND expiry <= ?
    `);

    this.stmtInsertMatch = this.db.prepare(`
      INSERT INTO matches (match_id, maker_id, taker_id, settling_relayer, pair, price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetMatchJoin = this.db.prepare(`
      SELECT m.match_id, m.settling_relayer, m.pair, m.price, m.created_at as match_created_at,
             mk.id as mk_id, mk.relayer as mk_relayer, mk.relayer_url as mk_relayer_url,
             mk.sell_token as mk_sell_token, mk.buy_token as mk_buy_token,
             mk.sell_amount as mk_sell_amount, mk.buy_amount as mk_buy_amount,
             mk.min_fill_amount as mk_min_fill_amount, mk.max_fee as mk_max_fee,
             mk.expiry as mk_expiry, mk.created_at as mk_created_at,
             tk.id as tk_id, tk.relayer as tk_relayer, tk.relayer_url as tk_relayer_url,
             tk.sell_token as tk_sell_token, tk.buy_token as tk_buy_token,
             tk.sell_amount as tk_sell_amount, tk.buy_amount as tk_buy_amount,
             tk.min_fill_amount as tk_min_fill_amount, tk.max_fee as tk_max_fee,
             tk.expiry as tk_expiry, tk.created_at as tk_created_at
      FROM matches m
      JOIN orders mk ON mk.id = m.maker_id
      JOIN orders tk ON tk.id = m.taker_id
      WHERE m.match_id = ?
    `);

    // duplicate tx_hash → no-op; safe for relayer client retries.
    this.stmtInsertSettlement = this.db.prepare(`
      INSERT OR IGNORE INTO settlements (
        tx_hash, block_number, block_time, submitter,
        maker_relayer, taker_relayer, maker_order_id, taker_order_id,
        maker_nullifier, taker_nullifier,
        sell_token, buy_token, sell_amount, buy_amount,
        fee_maker, fee_taker, user_maxfee_maker, user_maxfee_taker,
        verified, type, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `);

    this.stmtGetSettlement = this.db.prepare(`SELECT * FROM settlements WHERE tx_hash = ?`);

    this.stmtListMatchesJoin = this.db.prepare(`
      SELECT m.match_id, m.settling_relayer, m.pair, m.price, m.created_at as match_created_at,
             mk.id as mk_id, mk.relayer as mk_relayer, mk.relayer_url as mk_relayer_url,
             mk.sell_token as mk_sell_token, mk.buy_token as mk_buy_token,
             mk.sell_amount as mk_sell_amount, mk.buy_amount as mk_buy_amount,
             mk.min_fill_amount as mk_min_fill_amount, mk.max_fee as mk_max_fee,
             mk.expiry as mk_expiry, mk.created_at as mk_created_at,
             tk.id as tk_id, tk.relayer as tk_relayer, tk.relayer_url as tk_relayer_url,
             tk.sell_token as tk_sell_token, tk.buy_token as tk_buy_token,
             tk.sell_amount as tk_sell_amount, tk.buy_amount as tk_buy_amount,
             tk.min_fill_amount as tk_min_fill_amount, tk.max_fee as tk_max_fee,
             tk.expiry as tk_expiry, tk.created_at as tk_created_at
      FROM matches m
      JOIN orders mk ON mk.id = m.maker_id
      JOIN orders tk ON tk.id = m.taker_id
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `);

    this.stmtInsertKyc = this.db.prepare(`
      INSERT INTO kyc_submissions
        (id, wallet, email, video_path, id_doc_path, status, notes, created_at, reviewed_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
    `);

    this.stmtGetKycById = this.db.prepare(`SELECT * FROM kyc_submissions WHERE id = ?`);

    // Newest submission for a wallet — drives the public status endpoint and
    // the re-submission path (refresh a still-pending row instead of piling
    // up duplicates).
    this.stmtGetKycByWallet = this.db.prepare(
      `SELECT * FROM kyc_submissions WHERE wallet = ? ORDER BY created_at DESC LIMIT 1`,
    );

    this.stmtUpdateKycFiles = this.db.prepare(`
      UPDATE kyc_submissions
         SET email = ?, video_path = ?, id_doc_path = ?, created_at = ?
       WHERE id = ?
    `);

    this.stmtUpdateKycStatus = this.db.prepare(`
      UPDATE kyc_submissions SET status = ?, notes = ?, reviewed_at = ? WHERE id = ?
    `);

    // Admin review queue (PR2). Two fixed shapes — all rows vs one status
    // bucket — so they pre-prepare cleanly (cf. stmtListAll/stmtListByStatus
    // for orders) rather than compiling inline per call.
    this.stmtListKycAll = this.db.prepare(
      `SELECT * FROM kyc_submissions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.stmtListKycByStatus = this.db.prepare(
      `SELECT * FROM kyc_submissions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );

    this.stmtDeactivateRootCa = this.db.prepare(`UPDATE root_ca SET active = 0 WHERE active = 1`);
    // Re-publishing the same cert (same fingerprint) reactivates + refreshes
    // its row rather than erroring.
    this.stmtUpsertRootCa = this.db.prepare(`
      INSERT INTO root_ca (fingerprint, der, common_name, organization, country, not_after, created_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(fingerprint) DO UPDATE SET
        der = excluded.der,
        common_name = excluded.common_name,
        organization = excluded.organization,
        country = excluded.country,
        not_after = excluded.not_after,
        created_at = excluded.created_at,
        active = 1
    `);
    this.stmtGetActiveRootCa = this.db.prepare(
      `SELECT * FROM root_ca WHERE active = 1 ORDER BY created_at DESC LIMIT 1`,
    );
  }

  insertOrder(o: OrderSummary): void {
    this.stmtInsertOrder.run(
      o.id, o.relayer, o.relayerUrl,
      o.sellToken, o.buyToken,
      o.sellAmount, o.buyAmount, o.minFillAmount,
      o.maxFee, o.expiry, o.createdAt,
    );
  }

  getOrder(id: string): StoredOrder | null {
    const row = this.stmtGetOrder.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToStoredOrder(row) : null;
  }

  updateStatus(id: string, status: OrderStatus, matchId?: string): void {
    this.stmtUpdateStatus.run(status, matchId ?? null, id);
  }

  /** Expire specific orders by ID (synced from in-memory purge) */
  expireByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const txn = this.db.transaction(() => {
      for (const id of ids) {
        this.stmtUpdateStatus.run("expired", null, id);
      }
    });
    txn();
  }

  deleteOrder(id: string): boolean {
    const result = this.stmtDeleteOrder.run(id);
    return result.changes > 0;
  }

  listOpen(limit = 100, offset = 0): StoredOrder[] {
    const rows = this.stmtListOpen.all(limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.rowToStoredOrder(r));
  }

  /** Used by the status-aware /api/orders route. Empty `status` →
   *  return every row (terminal + open) sorted open-first. A defined
   *  status is forwarded as-is so the SDK / UI keep one query
   *  surface for both the bucket tabs and the legacy "open" view. */
  listAll(limit = 100, offset = 0, status?: OrderStatus): StoredOrder[] {
    const rows = status
      ? (this.stmtListByStatus.all(status, limit, offset) as Record<string, unknown>[])
      : (this.stmtListAll.all(limit, offset) as Record<string, unknown>[]);
    return rows.map(r => this.rowToStoredOrder(r));
  }

  /** Per-status counts for the UI's tab labels (`All (5) · Open (3)
   *  · Expired (1) · …`). Returned as a partial map so a missing
   *  bucket reads as 0 client-side. */
  countByStatus(): Partial<Record<OrderStatus, number>> {
    const rows = this.stmtCountByStatus.all() as Array<{ status: string; count: number }>;
    const out: Partial<Record<OrderStatus, number>> = {};
    for (const r of rows) out[r.status as OrderStatus] = r.count;
    return out;
  }

  listByPair(tokenA: string, tokenB: string, limit = 100, offset = 0): StoredOrder[] {
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();
    const rows = this.stmtListByPair.all(a, b, b, a, limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.rowToStoredOrder(r));
  }

  listByRelayer(relayer: string, limit = 100, offset = 0): StoredOrder[] {
    const rows = this.stmtListByRelayer.all(relayer.toLowerCase(), limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.rowToStoredOrder(r));
  }

  countByRelayer(relayer: string): number {
    const row = this.stmtCountByRelayer.get(relayer.toLowerCase()) as { count: number };
    return row.count;
  }

  purgeExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.stmtPurgeExpired.run(now);
    return result.changes;
  }

  insertMatch(m: MatchResult): void {
    this.stmtInsertMatch.run(
      m.matchId, m.maker.id, m.taker.id,
      m.settlingRelayer, m.pair, m.price, m.createdAt,
    );
  }

  getMatch(matchId: string): MatchResult | null {
    const row = this.stmtGetMatchJoin.get(matchId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMatchResult(row);
  }

  listMatches(limit = 50, offset = 0): MatchResult[] {
    const rows = this.stmtListMatchesJoin.all(limit, offset) as Record<string, unknown>[];
    return rows.map(row => this.rowToMatchResult(row));
  }

  private rowToMatchResult(row: Record<string, unknown>): MatchResult {
    return {
      matchId: row.match_id as string,
      maker: {
        id: row.mk_id as string,
        relayer: row.mk_relayer as string,
        relayerUrl: row.mk_relayer_url as string,
        sellToken: row.mk_sell_token as string,
        buyToken: row.mk_buy_token as string,
        sellAmount: row.mk_sell_amount as string,
        buyAmount: row.mk_buy_amount as string,
        minFillAmount: row.mk_min_fill_amount as string,
        maxFee: row.mk_max_fee as number,
        expiry: row.mk_expiry as number,
        createdAt: row.mk_created_at as number,
      },
      taker: {
        id: row.tk_id as string,
        relayer: row.tk_relayer as string,
        relayerUrl: row.tk_relayer_url as string,
        sellToken: row.tk_sell_token as string,
        buyToken: row.tk_buy_token as string,
        sellAmount: row.tk_sell_amount as string,
        buyAmount: row.tk_buy_amount as string,
        minFillAmount: row.tk_min_fill_amount as string,
        maxFee: row.tk_max_fee as number,
        expiry: row.tk_expiry as number,
        createdAt: row.tk_created_at as number,
      },
      settlingRelayer: row.settling_relayer as string,
      pair: row.pair as string,
      price: row.price as string,
      createdAt: row.match_created_at as number,
    };
  }

  /** Record match atomically: update both orders + insert match */
  recordMatch(match: MatchResult): void {
    const txn = this.db.transaction(() => {
      this.updateStatus(match.maker.id, "matched", match.matchId);
      this.updateStatus(match.taker.id, "matched", match.matchId);
      this.insertMatch(match);
    });
    txn();
  }

  /** Load all open orders from DB (for in-memory orderbook restoration) */
  loadAllOpen(): StoredOrder[] {
    const rows = this.db.prepare(
      `SELECT * FROM orders WHERE status = 'open' ORDER BY created_at ASC`,
    ).all() as Record<string, unknown>[];
    return rows.map(r => this.rowToStoredOrder(r));
  }

  /**
   * Insert a settlement record. Submitter is taken from the authenticated
   * relayer (not the payload) so a relayer cannot attribute settlements to
   * someone else. When the maker order is still in the orders table, its
   * sell/buy token + amount are snapshotted onto the row so reads stay
   * fast even after the order is pruned.
   *
   * Returns true if a row was inserted, false if it was a no-op (duplicate
   * tx_hash already stored — the same relayer retrying or a backfill
   * crossing a push).
   */
  insertSettlement(submitter: string, payload: SettlementInsert): boolean {
    // Snapshot from the maker order if still present and not overridden.
    let sellToken = payload.sellToken;
    let buyToken = payload.buyToken;
    let sellAmount = payload.sellAmount;
    let buyAmount = payload.buyAmount;
    // Snapshot any field the client omitted, not just the tokens — a
    // client that supplies tokens but omits amounts (or vice versa) still
    // benefits from filling in the gaps from the still-present order row.
    if (payload.makerOrderId && (!sellToken || !buyToken || !sellAmount || !buyAmount)) {
      const makerOrder = this.getOrder(payload.makerOrderId);
      if (makerOrder) {
        sellToken ??= makerOrder.order.sellToken;
        buyToken ??= makerOrder.order.buyToken;
        sellAmount ??= makerOrder.order.sellAmount;
        buyAmount ??= makerOrder.order.buyAmount;
      }
    }
    const result = this.stmtInsertSettlement.run(
      payload.txHash,
      payload.blockNumber,
      payload.blockTime ?? null,
      submitter.toLowerCase(),
      payload.makerRelayer.toLowerCase(),
      payload.takerRelayer ? payload.takerRelayer.toLowerCase() : null,
      payload.makerOrderId ?? null,
      payload.takerOrderId ?? null,
      payload.makerNullifier,
      payload.takerNullifier,
      sellToken ? sellToken.toLowerCase() : null,
      buyToken ? buyToken.toLowerCase() : null,
      sellAmount ?? null,
      buyAmount ?? null,
      payload.feeMaker,
      payload.feeTaker,
      payload.userMaxFeeMaker,
      payload.userMaxFeeTaker,
      payload.type ?? null,
      Math.floor(Date.now() / 1000),
    );
    return result.changes > 0;
  }

  getSettlement(txHash: string): StoredSettlement | null {
    const row = this.stmtGetSettlement.get(txHash.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.rowToSettlement(row) : null;
  }

  /**
   * Count of rows still marked verified=0. Cheap scalar — uses the
   * partial index implicit in SQLite's `COUNT(*)` over a `WHERE`. The
   * `/api/admin/verify-stats` endpoint reports this so an operator can
   * alert on "unverified backlog grew past N" without paying for a
   * full list scan.
   */
  countUnverifiedSettlements(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM settlements WHERE verified = 0`).get() as { c: number };
    return row.c;
  }

  /**
   * Phase 2.5b verify job: pull rows still marked verified=0, optionally
   * older than `maxBlock` (so an in-flight chain tail isn't re-checked
   * on every pass). Ordered by block_number ASC so the job processes
   * the oldest unverified rows first — verified=0 rows can pile up
   * during a chain re-org without starving the queue.
   */
  listUnverifiedSettlements(opts: { maxBlock?: number; limit?: number } = {}): StoredSettlement[] {
    const where: string[] = ["verified = 0"];
    const params: unknown[] = [];
    if (typeof opts.maxBlock === "number") {
      where.push("block_number <= ?");
      params.push(opts.maxBlock);
    }
    const limit = Math.min(opts.limit ?? 500, 5000);
    const sql = `SELECT * FROM settlements WHERE ${where.join(" AND ")} ORDER BY block_number ASC, tx_hash ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSettlement(r));
  }

  /**
   * Bulk-mark settlements verified=1. When the verifier supplies a
   * `blockTime` (resolved from on-chain log metadata), it OVERWRITES
   * any relayer-reported value — the on-chain timestamp is canonical,
   * and a stale relayer-supplied value would skew `since` filters /
   * `lastSettleAt` metrics. Rows where the verifier didn't compute a
   * timestamp keep whatever block_time was already there. Runs as a
   * single sqlite transaction so a crash mid-batch doesn't leave the
   * table half-updated. Returns the number of rows actually flipped.
   */
  markSettlementsVerified(entries: { txHash: string; blockTime?: number }[]): number {
    if (entries.length === 0) return 0;
    const stmtBoth = this.db.prepare(
      `UPDATE settlements SET verified = 1, block_time = ? WHERE tx_hash = ? AND verified = 0`,
    );
    const stmtOnly = this.db.prepare(
      `UPDATE settlements SET verified = 1 WHERE tx_hash = ? AND verified = 0`,
    );
    let flipped = 0;
    const txn = this.db.transaction(() => {
      for (const e of entries) {
        const txHash = e.txHash.toLowerCase();
        const result =
          typeof e.blockTime === "number"
            ? stmtBoth.run(e.blockTime, txHash)
            : stmtOnly.run(txHash);
        flipped += result.changes;
      }
    });
    txn();
    return flipped;
  }

  /**
   * Read API used by Phase 2.5c. Filters compose with AND (relayer matches
   * any of submitter/maker/taker; pair matches either direction).
   */
  listSettlements(filter: SettlementListFilter = {}): StoredSettlement[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.relayer) {
      const r = filter.relayer.toLowerCase();
      where.push("(submitter = ? OR maker_relayer = ? OR taker_relayer = ?)");
      params.push(r, r, r);
    }
    if (filter.pair) {
      const [a, b] = [filter.pair[0].toLowerCase(), filter.pair[1].toLowerCase()];
      where.push("((sell_token = ? AND buy_token = ?) OR (sell_token = ? AND buy_token = ?))");
      params.push(a, b, b, a);
    }
    if (typeof filter.since === "number") {
      // block_time is nullable in Phase 2.5a (verify job backfills it).
      // Without COALESCE, fresh rows pushed before the verifier ran would
      // be invisible to "recent settlements" queries — fall back to
      // created_at (server clock) so they still appear.
      where.push("COALESCE(block_time, created_at) >= ?");
      params.push(filter.since);
    }
    const limit = Math.min(filter.limit ?? 100, 500);
    const offset = filter.offset ?? 0;
    // Dynamic WHERE — better-sqlite3 caches by SQL text so the up-to-8
    // concrete shapes get reused. The other queries in this class are
    // pre-prepared because their shape is fixed; this one isn't.
    const sql = `SELECT * FROM settlements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY block_number DESC, tx_hash ASC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSettlement(r));
  }

  private rowToSettlement(row: Record<string, unknown>): StoredSettlement {
    return {
      txHash: row.tx_hash as string,
      blockNumber: row.block_number as number,
      blockTime: (row.block_time as number | null) ?? undefined,
      submitter: row.submitter as string,
      makerRelayer: row.maker_relayer as string,
      takerRelayer: (row.taker_relayer as string | null) ?? undefined,
      makerOrderId: (row.maker_order_id as string | null) ?? undefined,
      takerOrderId: (row.taker_order_id as string | null) ?? undefined,
      makerNullifier: row.maker_nullifier as string,
      takerNullifier: row.taker_nullifier as string,
      sellToken: (row.sell_token as string | null) ?? undefined,
      buyToken: (row.buy_token as string | null) ?? undefined,
      sellAmount: (row.sell_amount as string | null) ?? undefined,
      buyAmount: (row.buy_amount as string | null) ?? undefined,
      feeMaker: row.fee_maker as string,
      feeTaker: row.fee_taker as string,
      userMaxFeeMaker: row.user_maxfee_maker as number,
      userMaxFeeTaker: row.user_maxfee_taker as number,
      verified: ((row.verified as number) ?? 0) === 1,
      type: (row.type as SettlementType | null) ?? undefined,
      createdAt: row.created_at as number,
    };
  }

  /**
   * Walks a row set once and accumulates token + pair aggregates plus a
   * couple of running counters. Shared by getRelayerSettlementStats and
   * getNetworkSettlementTotals so the two endpoints' arithmetic can never
   * drift. BigInt sums are done in Node because sqlite SUM() over TEXT
   * columns silently coerces to double — accuracy matters for token
   * amounts that exceed 2^53.
   */
  private aggregateSettlementRows(rows: Iterable<Record<string, unknown>>): {
    tokenAgg: Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>;
    /** Same shape as `tokenAgg`, restricted to rows where `verified=1`.
     *  Surfaced separately because relayer-pushed rows arrive as
     *  unverified by default — a malicious relayer can otherwise
     *  inflate `volumeByToken` and the leaderboard by posting fake
     *  rows with itself as `makerRelayer` (security review #36). */
    tokenAggVerified: Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>;
    pairAgg: Map<string, { sellToken: string; buyToken: string; count: number }>;
    pairAggVerified: Map<string, { sellToken: string; buyToken: string; count: number }>;
    txCount: number;
    txCountVerified: number;
    lastSettleAt: number | null;
  } {
    let txCount = 0;
    const tokenAgg = new Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>();
    const tokenAggVerified = new Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>();
    const pairAgg = new Map<string, { sellToken: string; buyToken: string; count: number }>();
    const pairAggVerified = new Map<string, { sellToken: string; buyToken: string; count: number }>();
    let txCountVerified = 0;
    let lastSettleAt: number | null = null;

    // Hoisted out of the loop — defining a closure per row materially
    // hurts perf on relayer histories with tens of thousands of rows
    // (each closure boxes the captured locals into a fresh frame).
    // `bumpToken` is now a pure function over its arguments.
    const bumpToken = (
      target: Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>,
      sellToken: string | null,
      buyToken: string | null,
      sellAmount: string | null,
      buyAmount: string | null,
    ): void => {
      if (sellToken) {
        const cur = target.get(sellToken) ?? { sell: 0n, buy: 0n, sellCount: 0, buyCount: 0 };
        if (sellAmount) cur.sell += BigInt(sellAmount);
        cur.sellCount++;
        target.set(sellToken, cur);
      }
      if (buyToken) {
        const cur = target.get(buyToken) ?? { sell: 0n, buy: 0n, sellCount: 0, buyCount: 0 };
        if (buyAmount) cur.buy += BigInt(buyAmount);
        cur.buyCount++;
        target.set(buyToken, cur);
      }
    };

    for (const r of rows) {
      txCount++;
      const verified = ((r.verified as number) ?? 0) === 1;
      if (verified) txCountVerified++;
      // Track newest activity preferring block_time, falling back to
      // created_at so freshly-pushed (unverified) rows still drive the
      // dashboard's "last settle" display in the pre-2.5b window.
      const ts = (r.block_time as number | null) ?? (r.created_at as number);
      if (ts !== null && (lastSettleAt === null || ts > lastSettleAt)) lastSettleAt = ts;

      const sellToken = r.sell_token as string | null;
      const buyToken = r.buy_token as string | null;
      const sellAmount = r.sell_amount as string | null;
      const buyAmount = r.buy_amount as string | null;
      bumpToken(tokenAgg, sellToken, buyToken, sellAmount, buyAmount);
      if (verified) bumpToken(tokenAggVerified, sellToken, buyToken, sellAmount, buyAmount);

      if (sellToken && buyToken) {
        const key = `${sellToken}-${buyToken}`;
        const cur = pairAgg.get(key) ?? { sellToken, buyToken, count: 0 };
        cur.count++;
        pairAgg.set(key, cur);
        if (verified) {
          const curV = pairAggVerified.get(key) ?? { sellToken, buyToken, count: 0 };
          curV.count++;
          pairAggVerified.set(key, curV);
        }
      }
    }
    return { tokenAgg, tokenAggVerified, pairAgg, pairAggVerified, txCount, txCountVerified, lastSettleAt };
  }

  private materialiseTokenVolume(
    tokenAgg: Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>,
  ): TokenVolumeRow[] {
    return Array.from(tokenAgg.entries()).map(([token, v]) => ({
      token,
      totalSell: v.sell.toString(),
      totalBuy: v.buy.toString(),
      sellCount: v.sellCount,
      buyCount: v.buyCount,
    }));
  }

  /**
   * Per-relayer aggregate stats across all settlements where the relayer
   * appears as submitter, maker, or taker. Used by GET /api/relayers/:addr/stats.
   */
  getRelayerSettlementStats(addr: string, since?: number): RelayerSettlementStats {
    const a = addr.toLowerCase();
    const sinceClause = typeof since === "number" ? "AND COALESCE(block_time, created_at) >= ?" : "";
    // UNION (not UNION ALL) deduplicates rows that match more than one
    // role — it's common for the submitter to also be the maker. SQLite
    // can satisfy each branch from idx_settle_submitter/_maker/_taker
    // individually, which a single OR-across-3-cols cannot.
    const branchSql = (col: string) =>
      `SELECT * FROM settlements WHERE ${col} = ? ${sinceClause}`;
    const sql = `${branchSql("submitter")} UNION ${branchSql("maker_relayer")} UNION ${branchSql("taker_relayer")}`;
    const args = typeof since === "number" ? [a, since, a, since, a, since] : [a, a, a];
    // .iterate() streams rows so a relayer with millions of settlements
    // doesn't OOM the Node heap; .all() materialises the whole set first.
    const rowIter = this.db.prepare(sql).iterate(...args) as Iterable<Record<string, unknown>>;

    // Tee the iterator: aggregate runs the main pass, then the fee-bps
    // pass needs the raw rows again. Materialising once is unavoidable
    // here because we need both. To still bound memory, we collect into
    // an array but the row set is already pre-filtered to one relayer.
    const rows: Record<string, unknown>[] = [];
    for (const r of rowIter) rows.push(r);

    const { tokenAgg, tokenAggVerified, pairAgg, pairAggVerified, txCount, txCountVerified, lastSettleAt } =
      this.aggregateSettlementRows(rows);

    // Mean realised fee bps across both sides of every row the relayer
    // participated in. Only sides with present fee + buy > 0 contribute
    // (zero buy is degenerate). user_maxfee is *not* a gate — 0 bps is a
    // valid signed cap and dropping those rows would silently bias the
    // average toward higher-fee orders.
    let feeBpsNum = 0;
    let feeBpsDen = 0;
    const accumulateSide = (feeStr: string | null, buyStr: string | null): void => {
      if (!feeStr || !buyStr) return;
      const buy = BigInt(buyStr);
      if (buy === 0n) return;
      feeBpsNum += Number((BigInt(feeStr) * 10_000n) / buy);
      feeBpsDen += 1;
    };
    for (const r of rows) {
      accumulateSide(r.fee_maker as string | null, r.buy_amount as string | null);
      accumulateSide(r.fee_taker as string | null, r.buy_amount as string | null);
    }

    return {
      address: a,
      txCount,
      txCountVerified,
      volumeByToken: this.materialiseTokenVolume(tokenAgg),
      volumeByTokenVerified: this.materialiseTokenVolume(tokenAggVerified),
      pairs: Array.from(pairAgg.values()).sort((x, y) => y.count - x.count),
      pairsVerified: Array.from(pairAggVerified.values()).sort((x, y) => y.count - x.count),
      avgFeeBps: feeBpsDen > 0 ? feeBpsNum / feeBpsDen : null,
      // Until at least one row is verified, the ratio is unknown — return
      // null rather than a misleading 0 so the dashboard can render
      // "pending verification" instead of "0% success".
      successRate: txCountVerified > 0 ? txCountVerified / txCount : null,
      lastSettleAt,
    };
  }

  /**
   * Network-wide totals across all settlements. The cheap counters are
   * pushed into SQL (COUNT, COUNT-DISTINCT, MAX) so we don't ship every
   * row to Node just to count it; only the volume aggregation needs JS
   * (BigInt sums on TEXT columns).
   */
  getNetworkSettlementTotals(since?: number): NetworkSettlementTotals {
    const where = typeof since === "number" ? "WHERE COALESCE(block_time, created_at) >= ?" : "";
    const args: unknown[] = typeof since === "number" ? [since] : [];

    const counters = this.db.prepare(
      `SELECT
         COUNT(*) AS tx_count,
         COUNT(*) FILTER (WHERE verified = 1) AS tx_count_verified,
         MAX(COALESCE(block_time, created_at)) AS last_settle_at,
         -- Normalise (sell_token, buy_token) so (A→B) and (B→A) collapse
         -- into one pair, matching the unordered semantics that
         -- SettlementListFilter.pair already uses on reads.
         COUNT(DISTINCT MIN(sell_token, buy_token) || '-' || MAX(sell_token, buy_token)) AS active_pairs
       FROM settlements ${where}`,
    ).get(...args) as Record<string, unknown>;

    // activeRelayers: a relayer can appear as submitter / maker / taker.
    // UNION across the three columns and DISTINCT-count, all in one query
    // rather than pulling every row to Node. The taker branch keeps NULLs
    // out via an additional predicate so they don't get DISTINCT-counted
    // against actual addresses.
    const takerExtra = where ? "AND taker_relayer IS NOT NULL" : "WHERE taker_relayer IS NOT NULL";
    const relayerCount = this.db.prepare(
      `SELECT COUNT(DISTINCT addr) AS c FROM (
         SELECT submitter AS addr FROM settlements ${where}
         UNION SELECT maker_relayer FROM settlements ${where}
         UNION SELECT taker_relayer FROM settlements ${where} ${takerExtra}
       )`,
    ).get(...args, ...args, ...args) as { c: number };

    // Volume-by-token still walks rows for accurate BigInt sums, but only
    // the columns we need are loaded — and we stream via .iterate() so a
    // table with millions of rows doesn't OOM the Node heap.
    const rows = this.db.prepare(
      `SELECT sell_token, buy_token, sell_amount, buy_amount, verified, block_time, created_at FROM settlements ${where}`,
    ).iterate(...args) as Iterable<Record<string, unknown>>;
    const { tokenAgg, tokenAggVerified } = this.aggregateSettlementRows(rows);

    return {
      txCount: counters.tx_count as number,
      txCountVerified: counters.tx_count_verified as number,
      volumeByToken: this.materialiseTokenVolume(tokenAgg),
      volumeByTokenVerified: this.materialiseTokenVolume(tokenAggVerified),
      activePairs: counters.active_pairs as number,
      activeRelayers: relayerCount.c,
      lastSettleAt: (counters.last_settle_at as number | null) ?? null,
    };
  }

  /**
   * Top-N relayers ranked by `metric`, computed entirely in SQL so no row
   * data is materialised in Node. UNION ALL across submitter / maker /
   * taker (a relayer counts once per role per row), then GROUP BY +
   * ORDER BY metric DESC + LIMIT.
   *
   * Available metrics:
   *   - "count"          → total tx_count (any role; deduped per tx_hash per addr)
   *   - "verifiedCount"  → subset where verified=1
   *   - "successRate"    → verifiedCount / txCount; ties broken by txCount
   *                        and only relayers with at least one verified tx
   *                        appear (a relayer with 0 settlements has no rate)
   */
  getLeaderboard(
    metric: LeaderboardMetric = "count",
    sinceSec?: number,
    limit = 50,
  ): LeaderboardRow[] {
    const where = typeof sinceSec === "number" ? "AND COALESCE(block_time, created_at) >= ?" : "";
    const args: unknown[] = typeof sinceSec === "number" ? [sinceSec, sinceSec, sinceSec] : [];
    const cappedLimit = clampLimit(limit, 500, 50);

    const orderBy = metric === "verifiedCount"
      ? "tx_count_verified DESC, tx_count DESC"
      : metric === "successRate"
      ? "(CAST(tx_count_verified AS REAL) / tx_count) DESC, tx_count DESC"
      : "tx_count DESC";
    const havingForRate = metric === "successRate" ? "HAVING tx_count_verified > 0" : "";

    // UNION ALL — per-addr DISTINCT(tx_hash) below makes a relayer in
    // two roles on the same tx still count once. Each branch anchors on
    // its NOT-NULL role column (submitter / maker_relayer are NOT NULL
    // by schema; taker_relayer is nullable so its branch already filters)
    // — using a real anchor predicate avoids the `WHERE 1=1` hack.
    const sql = `
      WITH appearances AS (
        SELECT submitter AS addr, tx_hash, verified, COALESCE(block_time, created_at) AS ts
          FROM settlements WHERE submitter IS NOT NULL ${where}
        UNION ALL
        SELECT maker_relayer AS addr, tx_hash, verified, COALESCE(block_time, created_at) AS ts
          FROM settlements WHERE maker_relayer IS NOT NULL ${where}
        UNION ALL
        SELECT taker_relayer AS addr, tx_hash, verified, COALESCE(block_time, created_at) AS ts
          FROM settlements WHERE taker_relayer IS NOT NULL ${where}
      )
      SELECT
        addr,
        COUNT(DISTINCT tx_hash) AS tx_count,
        COUNT(DISTINCT CASE WHEN verified = 1 THEN tx_hash END) AS tx_count_verified,
        MAX(ts) AS last_settle_at
      FROM appearances
      GROUP BY addr
      ${havingForRate}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...args, cappedLimit) as Record<string, unknown>[];
    return rows.map((r) => ({
      address: r.addr as string,
      txCount: r.tx_count as number,
      txCountVerified: r.tx_count_verified as number,
      lastSettleAt: (r.last_settle_at as number | null) ?? null,
    }));
  }

  // ── Relayer operator KYC onboarding (Stage 1) ──────────────────────────

  /** Insert a fresh KYC submission. `wallet` is lowercased by the caller. */
  insertKycSubmission(s: KycSubmissionInsert): void {
    this.stmtInsertKyc.run(s.id, s.wallet, s.email, s.videoPath, s.idDocPath, s.createdAt);
  }

  /**
   * Refresh a still-pending submission's files / email / timestamp when the
   * same wallet re-submits. Status stays 'pending'; the review clock resets
   * via created_at so a re-submit goes to the back of the admin queue.
   */
  updateKycFiles(id: string, u: KycSubmissionUpdate, resubmittedAt: number): void {
    this.stmtUpdateKycFiles.run(u.email, u.videoPath, u.idDocPath, resubmittedAt, id);
  }

  /** Admin review action (PR2): set status + optional notes + reviewed_at. */
  updateKycStatus(id: string, status: KycStatus, notes: string | null, reviewedAt: number): boolean {
    const result = this.stmtUpdateKycStatus.run(status, notes, reviewedAt, id);
    return result.changes > 0;
  }

  getKycById(id: string): KycSubmission | null {
    const row = this.stmtGetKycById.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToKyc(row) : null;
  }

  /** Newest submission for a wallet (case-insensitive), or null. */
  getKycByWallet(wallet: string): KycSubmission | null {
    const row = this.stmtGetKycByWallet.get(wallet.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.rowToKyc(row) : null;
  }

  /** Admin review queue (PR2). Optional status filter, newest-first. */
  listKycSubmissions(filter: KycListFilter = {}): KycSubmission[] {
    // clampLimit truncates + bounds to [1, 500]; without it a negative limit
    // reaches SQLite as "no limit" and returns the whole table.
    const limit = clampLimit(filter.limit, 500, 100);
    const rawOffset = Math.trunc(Number(filter.offset ?? 0));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const rows = filter.status
      ? (this.stmtListKycByStatus.all(filter.status, limit, offset) as Record<string, unknown>[])
      : (this.stmtListKycAll.all(limit, offset) as Record<string, unknown>[]);
    return rows.map((r) => this.rowToKyc(r));
  }

  private rowToKyc(row: Record<string, unknown>): KycSubmission {
    return {
      id: row.id as string,
      wallet: row.wallet as string,
      email: (row.email as string | null) ?? null,
      videoPath: (row.video_path as string | null) ?? null,
      idDocPath: (row.id_doc_path as string | null) ?? null,
      status: row.status as KycStatus,
      notes: (row.notes as string | null) ?? null,
      createdAt: row.created_at as number,
      reviewedAt: (row.reviewed_at as number | null) ?? null,
    };
  }

  // ── Public Root CA storage ─────────────────────────────────────────────

  /**
   * Publish a Root CA: deactivate the current active cert and upsert this one
   * as the single active row, in one transaction. Re-publishing the same
   * fingerprint reactivates + refreshes that row; superseded certs are kept
   * (active=0) as history.
   */
  saveRootCa(rec: RootCaRecord): void {
    const txn = this.db.transaction(() => {
      this.stmtDeactivateRootCa.run();
      this.stmtUpsertRootCa.run(
        rec.fingerprint,
        rec.der,
        rec.commonName,
        rec.organization,
        rec.country,
        rec.notAfter,
        rec.createdAt,
      );
    });
    txn();
  }

  /** The current active Root CA, or null if none has been published. */
  getActiveRootCa(): RootCaRecord | null {
    const row = this.stmtGetActiveRootCa.get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      fingerprint: row.fingerprint as string,
      der: row.der as Buffer,
      commonName: (row.common_name as string | null) ?? null,
      organization: (row.organization as string | null) ?? null,
      country: (row.country as string | null) ?? null,
      notAfter: (row.not_after as number | null) ?? null,
      createdAt: row.created_at as number,
    };
  }

  /** Truncate the settlements table — for tests only. Faster than dropping
   *  and recreating, and keeps the indexes warm. */
  _resetSettlementsForTests(): void {
    this.db.exec("DELETE FROM settlements");
  }

  close(): void {
    this.db.close();
  }

  private rowToStoredOrder(row: Record<string, unknown>): StoredOrder {
    return {
      order: {
        id: row.id as string,
        relayer: row.relayer as string,
        relayerUrl: row.relayer_url as string,
        sellToken: row.sell_token as string,
        buyToken: row.buy_token as string,
        sellAmount: row.sell_amount as string,
        buyAmount: row.buy_amount as string,
        minFillAmount: row.min_fill_amount as string,
        maxFee: row.max_fee as number,
        expiry: row.expiry as number,
        createdAt: row.created_at as number,
      },
      status: row.status as OrderStatus,
      matchId: (row.match_id as string) ?? undefined,
    };
  }
}
