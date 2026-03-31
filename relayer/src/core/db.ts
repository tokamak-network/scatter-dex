import Database from "better-sqlite3";
import path from "path";
import { StoredOrder, Order, ClaimInfo, OrderStatus } from "../types/order.js";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "relayer.db");

export class OrderDB {
  private db: Database.Database;
  private insertOrder!: ReturnType<Database.Database["prepare"]>;
  private insertClaim!: ReturnType<Database.Database["prepare"]>;
  private deleteClaims!: ReturnType<Database.Database["prepare"]>;
  private updateStatusStmt!: ReturnType<Database.Database["prepare"]>;

  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.insertOrder = this.db.prepare(`
      INSERT OR REPLACE INTO orders
        (maker, nonce, sell_token, buy_token, sell_amount, buy_amount, max_fee, expiry, signature, status, fee_mode, settle_tx, submitted_at)
      VALUES
        (@maker, @nonce, @sellToken, @buyToken, @sellAmount, @buyAmount, @maxFee, @expiry, @signature, @status, @feeMode, @settleTx, @submittedAt)
    `);
    this.insertClaim = this.db.prepare(`
      INSERT OR REPLACE INTO claims (maker, nonce, idx, claim_hash, amount, release_delay)
      VALUES (@maker, @nonce, @idx, @claimHash, @amount, @releaseDelay)
    `);
    this.deleteClaims = this.db.prepare(`DELETE FROM claims WHERE maker = @maker AND nonce = @nonce`);
    this.updateStatusStmt = this.db.prepare(`
      UPDATE orders SET status = @status, settle_tx = COALESCE(@settleTx, settle_tx)
      WHERE maker = @maker AND nonce = @nonce
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        maker       TEXT NOT NULL,
        nonce       TEXT NOT NULL,
        sell_token  TEXT NOT NULL,
        buy_token   TEXT NOT NULL,
        sell_amount TEXT NOT NULL,
        buy_amount  TEXT NOT NULL,
        max_fee     TEXT NOT NULL,
        expiry      TEXT NOT NULL,
        signature   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        fee_mode    TEXT,
        settle_tx   TEXT,
        submitted_at INTEGER NOT NULL,
        PRIMARY KEY (maker, nonce)
      );

      CREATE TABLE IF NOT EXISTS claims (
        maker        TEXT NOT NULL,
        nonce        TEXT NOT NULL,
        idx          INTEGER NOT NULL,
        claim_hash   TEXT NOT NULL,
        amount       TEXT NOT NULL,
        release_delay TEXT NOT NULL,
        PRIMARY KEY (maker, nonce, idx),
        FOREIGN KEY (maker, nonce) REFERENCES orders(maker, nonce) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(sell_token, buy_token);
    `);
  }

  save(stored: StoredOrder): void {
    const { order, signature, status, submittedAt, feeMode, settleTxHash } = stored;
    const maker = order.maker.toLowerCase();
    const nonce = order.nonce.toString();

    const txn = this.db.transaction(() => {
      this.insertOrder.run({
        maker,
        nonce,
        sellToken: order.sellToken.toLowerCase(),
        buyToken: order.buyToken.toLowerCase(),
        sellAmount: order.sellAmount.toString(),
        buyAmount: order.buyAmount.toString(),
        maxFee: order.maxFee.toString(),
        expiry: order.expiry.toString(),
        signature,
        status,
        feeMode: feeMode ?? null,
        settleTx: settleTxHash ?? null,
        submittedAt,
      });

      this.deleteClaims.run({ maker, nonce });
      order.claims.forEach((c, idx) => {
        this.insertClaim.run({
          maker,
          nonce,
          idx,
          claimHash: c.claimHash,
          amount: c.amount.toString(),
          releaseDelay: c.releaseDelay.toString(),
        });
      });
    });

    txn();
  }

  updateStatus(maker: string, nonce: bigint, status: OrderStatus, settleTxHash?: string): void {
    this.updateStatusStmt.run({
      maker: maker.toLowerCase(),
      nonce: nonce.toString(),
      status,
      settleTx: settleTxHash ?? null,
    });
  }

  loadPending(): StoredOrder[] {
    const rows = this.db.prepare(`
      SELECT * FROM orders WHERE status = 'pending'
    `).all() as any[];

    return rows.map((row) => this.rowToStoredOrder(row));
  }

  private rowToStoredOrder(row: any): StoredOrder {
    const claimRows = this.db.prepare(`
      SELECT * FROM claims WHERE maker = @maker AND nonce = @nonce ORDER BY idx
    `).all({ maker: row.maker, nonce: row.nonce }) as any[];

    const claims: ClaimInfo[] = claimRows.map((c: any) => ({
      claimHash: c.claim_hash,
      amount: BigInt(c.amount),
      releaseDelay: BigInt(c.release_delay),
    }));

    const order: Order = {
      maker: row.maker,
      sellToken: row.sell_token,
      buyToken: row.buy_token,
      sellAmount: BigInt(row.sell_amount),
      buyAmount: BigInt(row.buy_amount),
      maxFee: BigInt(row.max_fee),
      expiry: BigInt(row.expiry),
      nonce: BigInt(row.nonce),
      claims,
    };

    return {
      order,
      signature: row.signature,
      status: row.status as OrderStatus,
      submittedAt: row.submitted_at,
      feeMode: row.fee_mode ?? undefined,
      settleTxHash: row.settle_tx ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
