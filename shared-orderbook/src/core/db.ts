import Database from "better-sqlite3";
import { config } from "../config.js";
import type { OrderSummary, OrderStatus, StoredOrder, MatchResult } from "../types/order.js";

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
