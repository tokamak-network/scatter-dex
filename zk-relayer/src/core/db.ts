import Database from "better-sqlite3";
import path from "path";
import type { StoredPrivateOrder, PrivateOrder, PrivateOrderStatus } from "../types/order.js";
import type { ClaimLeafData } from "./zk-prover.js";

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
  private insertOrder: ReturnType<Database.Database["prepare"]>;
  private insertClaim: ReturnType<Database.Database["prepare"]>;
  private deleteClaims: ReturnType<Database.Database["prepare"]>;
  private updateStatusStmt: ReturnType<Database.Database["prepare"]>;
  private selectPending: ReturnType<Database.Database["prepare"]>;
  private selectClaims: ReturnType<Database.Database["prepare"]>;
  private selectExists: ReturnType<Database.Database["prepare"]>;
  private selectByPubKey: ReturnType<Database.Database["prepare"]>;
  private selectByPubKeyStatus: ReturnType<Database.Database["prepare"]>;
  private selectByPubKeyNonce: ReturnType<Database.Database["prepare"]>;
  private countByPubKey: ReturnType<Database.Database["prepare"]>;
  private countByPubKeyStatus: ReturnType<Database.Database["prepare"]>;
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

  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.insertOrder = this.db.prepare(`
      INSERT OR REPLACE INTO private_orders
        (pub_key_ax, pub_key_ay, nonce, sell_token, buy_token, sell_amount, buy_amount,
         max_fee, expiry, sig_s, sig_r8x, sig_r8y, owner_secret, balance, salt, leaf_index,
         status, settle_tx, submitted_at)
      VALUES
        (@pubKeyAx, @pubKeyAy, @nonce, @sellToken, @buyToken, @sellAmount, @buyAmount,
         @maxFee, @expiry, @sigS, @sigR8x, @sigR8y, @ownerSecret, @balance, @salt, @leafIndex,
         @status, @settleTx, @submittedAt)
    `);
    this.insertClaim = this.db.prepare(`
      INSERT OR REPLACE INTO private_claims (pub_key_ax, nonce, idx, secret, recipient, token, amount, release_time)
      VALUES (@pubKeyAx, @nonce, @idx, @secret, @recipient, @token, @amount, @releaseTime)
    `);
    this.deleteClaims = this.db.prepare(`DELETE FROM private_claims WHERE pub_key_ax = @pubKeyAx AND nonce = @nonce`);
    this.updateStatusStmt = this.db.prepare(`
      UPDATE private_orders SET status = @status, settle_tx = COALESCE(@settleTx, settle_tx), cross_relayer = COALESCE(@crossRelayer, cross_relayer),
        settled_at = CASE WHEN @status = 'settled' AND settled_at IS NULL THEN @settledAt ELSE settled_at END
      WHERE pub_key_ax = @pubKeyAx AND nonce = @nonce
    `);
    this.selectPending = this.db.prepare(`
      SELECT * FROM private_orders WHERE status = 'pending' ORDER BY submitted_at ASC
    `);
    this.selectClaims = this.db.prepare(`
      SELECT * FROM private_claims WHERE pub_key_ax = @pubKeyAx AND nonce = @nonce ORDER BY idx
    `);
    this.selectExists = this.db.prepare(`
      SELECT 1 FROM private_orders WHERE pub_key_ax = @pubKeyAx AND nonce = @nonce LIMIT 1
    `);
    this.selectByPubKey = this.db.prepare(`
      SELECT * FROM private_orders WHERE pub_key_ax = @pubKeyAx ORDER BY submitted_at DESC LIMIT @limit OFFSET @offset
    `);
    this.selectByPubKeyStatus = this.db.prepare(`
      SELECT * FROM private_orders WHERE pub_key_ax = @pubKeyAx AND status = @status ORDER BY submitted_at DESC LIMIT @limit OFFSET @offset
    `);
    this.selectByPubKeyNonce = this.db.prepare(`
      SELECT * FROM private_orders WHERE pub_key_ax = @pubKeyAx AND nonce = @nonce LIMIT 1
    `);
    this.countByPubKey = this.db.prepare(`
      SELECT COUNT(*) as total FROM private_orders WHERE pub_key_ax = @pubKeyAx
    `);
    this.countByPubKeyStatus = this.db.prepare(`
      SELECT COUNT(*) as total FROM private_orders WHERE pub_key_ax = @pubKeyAx AND status = @status
    `);
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

    // Migration: relayer_meta key-value store (uptime tracking, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relayer_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  save(stored: StoredPrivateOrder): void {
    const { order, status, submittedAt, settleTxHash } = stored;
    const pubKeyAx = order.pubKeyAx.toString();
    const nonce = order.nonce.toString();

    const txn = this.db.transaction(() => {
      this.insertOrder.run({
        pubKeyAx,
        pubKeyAy: order.pubKeyAy.toString(),
        nonce,
        sellToken: order.sellToken.toString(),
        buyToken: order.buyToken.toString(),
        sellAmount: order.sellAmount.toString(),
        buyAmount: order.buyAmount.toString(),
        maxFee: order.maxFee.toString(),
        expiry: order.expiry.toString(),
        sigS: order.sigS.toString(),
        sigR8x: order.sigR8x.toString(),
        sigR8y: order.sigR8y.toString(),
        ownerSecret: order.ownerSecret.toString(),
        balance: order.balance.toString(),
        salt: order.salt.toString(),
        leafIndex: order.leafIndex,
        status,
        settleTx: settleTxHash ?? null,
        submittedAt,
      });

      this.deleteClaims.run({ pubKeyAx, nonce });
      order.claims.forEach((c, idx) => {
        this.insertClaim.run({
          pubKeyAx,
          nonce,
          idx,
          secret: c.secret.toString(),
          recipient: c.recipient.toString(),
          token: c.token.toString(),
          amount: c.amount.toString(),
          releaseTime: c.releaseTime.toString(),
        });
      });
    });

    txn();
  }

  updateStatus(pubKeyAx: bigint, nonce: bigint, status: PrivateOrderStatus, settleTxHash?: string, crossRelayer?: boolean): void {
    this.updateStatusStmt.run({
      pubKeyAx: pubKeyAx.toString(),
      nonce: nonce.toString(),
      status,
      settleTx: settleTxHash ?? null,
      crossRelayer: crossRelayer ? 1 : 0,
      settledAt: status === "settled" ? Date.now() : null,
    });
  }

  hasOrder(pubKeyAx: bigint, nonce: bigint): boolean {
    return !!this.selectExists.get({ pubKeyAx: pubKeyAx.toString(), nonce: nonce.toString() });
  }

  loadPending(): StoredPrivateOrder[] {
    const rows = this.selectPending.all({}) as OrderRow[];
    return rows.map((row) => this.rowToStored(row));
  }

  private rowToStored(row: OrderRow): StoredPrivateOrder {
    const claimRows = this.selectClaims.all({
      pubKeyAx: row.pub_key_ax,
      nonce: row.nonce,
    }) as ClaimRow[];

    const claims: ClaimLeafData[] = claimRows.map((c) => ({
      secret: BigInt(c.secret),
      recipient: BigInt(c.recipient),
      token: BigInt(c.token),
      amount: BigInt(c.amount),
      releaseTime: BigInt(c.release_time),
    }));

    const order: PrivateOrder = {
      sellToken: BigInt(row.sell_token),
      buyToken: BigInt(row.buy_token),
      sellAmount: BigInt(row.sell_amount),
      buyAmount: BigInt(row.buy_amount),
      maxFee: BigInt(row.max_fee),
      expiry: BigInt(row.expiry),
      nonce: BigInt(row.nonce),
      pubKeyAx: BigInt(row.pub_key_ax),
      pubKeyAy: BigInt(row.pub_key_ay),
      sigS: BigInt(row.sig_s),
      sigR8x: BigInt(row.sig_r8x),
      sigR8y: BigInt(row.sig_r8y),
      ownerSecret: BigInt(row.owner_secret),
      balance: BigInt(row.balance),
      salt: BigInt(row.salt),
      leafIndex: row.leaf_index,
      claims,
    };

    return {
      order,
      status: row.status as PrivateOrderStatus,
      submittedAt: row.submitted_at,
      settleTxHash: row.settle_tx ?? undefined,
      crossRelayer: row.cross_relayer === 1 ? true : undefined,
    };
  }

  getOrdersByPubKey(pubKeyAx: bigint, opts: { status?: PrivateOrderStatus; limit: number; offset: number }): StoredPrivateOrder[] {
    const pk = pubKeyAx.toString();
    const rows = opts.status
      ? this.selectByPubKeyStatus.all({ pubKeyAx: pk, status: opts.status, limit: opts.limit, offset: opts.offset }) as OrderRow[]
      : this.selectByPubKey.all({ pubKeyAx: pk, limit: opts.limit, offset: opts.offset }) as OrderRow[];
    return rows.map((row) => this.rowToStored(row));
  }

  getOrderByPubKeyNonce(pubKeyAx: bigint, nonce: bigint): StoredPrivateOrder | null {
    const row = this.selectByPubKeyNonce.get({
      pubKeyAx: pubKeyAx.toString(),
      nonce: nonce.toString(),
    }) as OrderRow | undefined;
    if (!row) return null;
    return this.rowToStored(row);
  }

  countOrdersByPubKey(pubKeyAx: bigint, status?: PrivateOrderStatus): number {
    const pk = pubKeyAx.toString();
    const result = status
      ? this.countByPubKeyStatus.get({ pubKeyAx: pk, status }) as { total: number }
      : this.countByPubKey.get({ pubKeyAx: pk }) as { total: number };
    return result.total;
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
    const total = (this.statsTotalOrders.get() as { count: number }).count;
    const settled = (this.statsSettledOrders.get() as { count: number }).count;
    const crossRelayer = (this.statsCrossRelayer.get() as { count: number }).count;
    const tradeTotal = (this.statsTotalTradeOffers.get() as { count: number }).count;
    const tradeSettled = (this.statsSettledTradeOffers.get() as { count: number }).count;
    const avgRow = this.statsAvgSettleTime.get() as { avg_ms: number | null };
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
    const rows = this.statsSettledVolume.all() as Array<{ sell_token: string; count: number; amounts: string }>;
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

  close(): void {
    this.db.close();
  }
}
