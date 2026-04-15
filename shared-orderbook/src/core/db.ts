import Database from "better-sqlite3";
import { config } from "../config.js";
import type { OrderSummary, OrderStatus, StoredOrder, MatchResult } from "../types/order.js";
import type {
  SettlementInsert,
  StoredSettlement,
  SettlementListFilter,
  TokenVolumeRow,
  RelayerSettlementStats,
  NetworkSettlementTotals,
} from "../types/settlement.js";

export class OrderbookDB {
  private db: Database.Database;

  // Prepared statements
  private stmtInsertOrder!: Database.Statement;
  private stmtGetOrder!: Database.Statement;
  private stmtUpdateStatus!: Database.Statement;
  private stmtDeleteOrder!: Database.Statement;
  private stmtListOpen!: Database.Statement;
  private stmtListByPair!: Database.Statement;
  private stmtListByRelayer!: Database.Statement;
  private stmtCountByRelayer!: Database.Statement;
  private stmtPurgeExpired!: Database.Statement;
  private stmtInsertMatch!: Database.Statement;
  private stmtGetMatchJoin!: Database.Statement;
  private stmtListMatchesJoin!: Database.Statement;
  private stmtInsertSettlement!: Database.Statement;
  private stmtGetSettlement!: Database.Statement;

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
    `);
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
        verified, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
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
      Math.floor(Date.now() / 1000),
    );
    return result.changes > 0;
  }

  getSettlement(txHash: string): StoredSettlement | null {
    const row = this.stmtGetSettlement.get(txHash.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.rowToSettlement(row) : null;
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
  private aggregateSettlementRows(rows: Record<string, unknown>[]): {
    tokenAgg: Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>;
    pairAgg: Map<string, { sellToken: string; buyToken: string; count: number }>;
    txCountVerified: number;
    lastSettleAt: number | null;
  } {
    const tokenAgg = new Map<string, { sell: bigint; buy: bigint; sellCount: number; buyCount: number }>();
    const pairAgg = new Map<string, { sellToken: string; buyToken: string; count: number }>();
    let txCountVerified = 0;
    let lastSettleAt: number | null = null;

    for (const r of rows) {
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
      if (sellToken) {
        const cur = tokenAgg.get(sellToken) ?? { sell: 0n, buy: 0n, sellCount: 0, buyCount: 0 };
        if (sellAmount) cur.sell += BigInt(sellAmount);
        cur.sellCount++;
        tokenAgg.set(sellToken, cur);
      }
      if (buyToken) {
        const cur = tokenAgg.get(buyToken) ?? { sell: 0n, buy: 0n, sellCount: 0, buyCount: 0 };
        if (buyAmount) cur.buy += BigInt(buyAmount);
        cur.buyCount++;
        tokenAgg.set(buyToken, cur);
      }
      if (sellToken && buyToken) {
        const key = `${sellToken}-${buyToken}`;
        const cur = pairAgg.get(key) ?? { sellToken, buyToken, count: 0 };
        cur.count++;
        pairAgg.set(key, cur);
      }
    }
    return { tokenAgg, pairAgg, txCountVerified, lastSettleAt };
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
    const args = typeof since === "number" ? [a, a, a, since] : [a, a, a];
    const rows = this.db.prepare(
      `SELECT * FROM settlements WHERE (submitter = ? OR maker_relayer = ? OR taker_relayer = ?) ${sinceClause}`,
    ).all(...args) as Record<string, unknown>[];

    const { tokenAgg, pairAgg, txCountVerified, lastSettleAt } = this.aggregateSettlementRows(rows);

    // Mean realised fee bps across both sides of every row the relayer
    // participated in. Only sides with non-zero buy amount + non-zero cap
    // contribute (zero buy = degenerate, zero cap = no signed bound to
    // measure against).
    let feeBpsNum = 0;
    let feeBpsDen = 0;
    const accumulateSide = (feeStr: string | null, buyStr: string | null, capBps: number | null): void => {
      if (!feeStr || !buyStr || !capBps) return;
      const buy = BigInt(buyStr);
      if (buy === 0n) return;
      feeBpsNum += Number((BigInt(feeStr) * 10_000n) / buy);
      feeBpsDen += 1;
    };
    for (const r of rows) {
      accumulateSide(r.fee_maker as string | null, r.buy_amount as string | null, (r.user_maxfee_maker as number | null) ?? null);
      accumulateSide(r.fee_taker as string | null, r.buy_amount as string | null, (r.user_maxfee_taker as number | null) ?? null);
    }

    return {
      address: a,
      txCount: rows.length,
      txCountVerified,
      volumeByToken: this.materialiseTokenVolume(tokenAgg),
      pairs: Array.from(pairAgg.values()).sort((x, y) => y.count - x.count),
      avgFeeBps: feeBpsDen > 0 ? feeBpsNum / feeBpsDen : null,
      // Until at least one row is verified, the ratio is unknown — return
      // null rather than a misleading 0 so the dashboard can render
      // "pending verification" instead of "0% success".
      successRate: txCountVerified > 0 ? txCountVerified / rows.length : null,
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
         COUNT(DISTINCT sell_token || '-' || buy_token) AS active_pairs,
         COUNT(DISTINCT submitter) AS distinct_submitters
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
    // the four columns we need are loaded.
    const rows = this.db.prepare(
      `SELECT sell_token, buy_token, sell_amount, buy_amount, verified, block_time, created_at FROM settlements ${where}`,
    ).all(...args) as Record<string, unknown>[];
    const { tokenAgg } = this.aggregateSettlementRows(rows);

    return {
      txCount: counters.tx_count as number,
      txCountVerified: counters.tx_count_verified as number,
      volumeByToken: this.materialiseTokenVolume(tokenAgg),
      activePairs: counters.active_pairs as number,
      activeRelayers: relayerCount.c,
      lastSettleAt: (counters.last_settle_at as number | null) ?? null,
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
