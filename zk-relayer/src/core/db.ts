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
  // [R-6] Authorize order statements
  private upsertAuthOrder: ReturnType<Database.Database["prepare"]>;
  private updateAuthStatus: ReturnType<Database.Database["prepare"]>;
  private deleteAuthOrder: ReturnType<Database.Database["prepare"]>;
  private selectPendingAuth: ReturnType<Database.Database["prepare"]>;
  private purgeAuthNonPending: ReturnType<Database.Database["prepare"]>;
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

    this.insertOrder = this.db.prepare(`
      INSERT OR REPLACE INTO private_orders
        (pub_key_ax, pub_key_ay, nonce, sell_token, buy_token, sell_amount, buy_amount,
         max_fee, expiry, sig_s, sig_r8x, sig_r8y, owner_secret, balance, salt, leaf_index,
         status, settle_tx, submitted_at, new_salt, expected_change_commitment)
      VALUES
        (@pubKeyAx, @pubKeyAy, @nonce, @sellToken, @buyToken, @sellAmount, @buyAmount,
         @maxFee, @expiry, @sigS, @sigR8x, @sigR8y, @ownerSecret, @balance, @salt, @leafIndex,
         @status, @settleTx, @submittedAt, @newSalt, @expectedChangeCommitment)
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

    // [R-6] Authorize order prepared statements
    this.upsertAuthOrder = this.db.prepare(
      "INSERT OR REPLACE INTO authorize_orders (nullifier, status, submitted_at, order_json, pub_key_ax, pub_key_ay, settle_tx) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateAuthStatus = this.db.prepare(
      "UPDATE authorize_orders SET status = ?, settle_tx = ? WHERE nullifier = ?",
    );
    this.deleteAuthOrder = this.db.prepare("DELETE FROM authorize_orders WHERE nullifier = ?");
    this.selectPendingAuth = this.db.prepare(
      "SELECT nullifier, status, submitted_at as submittedAt, order_json as orderJson, pub_key_ax as pubKeyAx, pub_key_ay as pubKeyAy, settle_tx as settleTx FROM authorize_orders WHERE status = 'pending'",
    );
    this.purgeAuthNonPending = this.db.prepare(
      "DELETE FROM authorize_orders WHERE status != 'pending' OR CAST(json_extract(order_json, '$.publicSignals.expiry') AS INTEGER) < ?",
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

    // [R-6] Authorize orders persistence — survive relayer restarts
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
    this.upsertAuthOrder.run([nullifier, status, submittedAt, orderJson, pubKeyAx ?? null, pubKeyAy ?? null, settleTx ?? null]);
  }

  updateAuthorizeOrderStatus(nullifier: string, status: string, settleTx?: string | null): void {
    this.updateAuthStatus.run([status, settleTx ?? null, nullifier]);
  }

  deleteAuthorizeOrder(nullifier: string): void {
    this.deleteAuthOrder.run(nullifier);
  }

  loadPendingAuthorizeOrders(): Array<{ nullifier: string; status: string; submittedAt: number; orderJson: string; pubKeyAx: string | null; pubKeyAy: string | null; settleTx: string | null }> {
    return this.selectPendingAuth.all({}) as any[];
  }

  purgeNonPendingAuthorizeOrdersDB(): number {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = this.purgeAuthNonPending.run(nowSeconds);
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
