/**
 * TradeHistoryStorage — per-order trade records, scoped per-wallet.
 *
 * StoredNote only captures the UTXO state (active/spent/pending). That's
 * enough for balance math, but it can't answer "what happened to this
 * commitment" — sell amount, change produced, who received what. We
 * persist a separate trade record keyed by the source note id so the
 * History screen can expand a spent note and show the full picture.
 *
 * Records are saved AFTER the relayer accepts the authorize proof, so
 * a record implies at least a submitted order. Settlement state is
 * backfilled later (future enhancement — scan SettledScatter events
 * and attach tx hash).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';

const LEGACY_PREFIX = 'scatterdex_trade_history_';
const DB_NAME = 'scatterdex_trade_history.db';
const MIGRATION_KEY = 'migrated_asyncstorage_v1';

export interface TradeClaim {
  recipient: string;      // 0x address (stealth address for stealth mode)
  amount: string;         // wei string (buyToken units)
  releaseTime: string;    // unix seconds
  ephemeralPubKey?: string;
  // NOTE: claim `secret` is intentionally NOT stored here. The authoritative
  // copy lives in PendingClaimsStorage (SecureStore, keychain-backed) —
  // writing it into TradeHistoryStorage's SQLite db would leak claim
  // authority via device backups / rooted-device reads. History is a
  // display record only; claim authority stays in SecureStore.
}

export interface TradeRecord {
  /** orderHash as decimal string — primary key */
  id: string;
  /** the spent note's id (commitment) — links Spent tab → this record */
  sourceNoteId: string;
  /** change UTXO's id, when there was a remainder */
  changeNoteId?: string;
  sellToken: string;
  sellTokenSymbol: string;
  buyToken: string;
  buyTokenSymbol: string;
  sellAmount: string;     // wei
  buyAmount: string;      // wei (gross, before relay fee)
  changeAmount: string;   // wei
  maxFeeBps: number;
  relayerAddress: string;
  relayerUrl: string;
  orderId?: string;       // returned by relayer, if any
  claims: TradeClaim[];
  /** Backfilled when we later scan SettledScatter events. */
  settleTxHash?: string;
  createdAt: number;
}

interface Row {
  id: string;
  source_note_id: string;
  change_note_id: string | null;
  sell_token: string;
  sell_token_symbol: string;
  buy_token: string;
  buy_token_symbol: string;
  sell_amount: string;
  buy_amount: string;
  change_amount: string;
  max_fee_bps: number;
  relayer_address: string;
  relayer_url: string;
  order_id: string | null;
  claims: string;
  settle_tx_hash: string | null;
  created_at: number;
}

const normalize = (address: string) => address.toLowerCase();

const sanitizeClaims = (claims: TradeClaim[]): TradeClaim[] =>
  // Defensive strip: even if a caller passes { secret } on a TradeClaim
  // (old field signature), we never persist it.
  claims.map((c) => {
    const { secret: _drop, ...rest } = c as TradeClaim & { secret?: string };
    return rest;
  });

const rowToRecord = (r: Row): TradeRecord => {
  let claims: TradeClaim[] = [];
  try { claims = JSON.parse(r.claims) as TradeClaim[]; } catch { /* corrupt row — surface as empty */ }
  const rec: TradeRecord = {
    id: r.id,
    sourceNoteId: r.source_note_id,
    sellToken: r.sell_token,
    sellTokenSymbol: r.sell_token_symbol,
    buyToken: r.buy_token,
    buyTokenSymbol: r.buy_token_symbol,
    sellAmount: r.sell_amount,
    buyAmount: r.buy_amount,
    changeAmount: r.change_amount,
    maxFeeBps: r.max_fee_bps,
    relayerAddress: r.relayer_address,
    relayerUrl: r.relayer_url,
    claims,
    createdAt: r.created_at,
  };
  if (r.change_note_id != null) rec.changeNoteId = r.change_note_id;
  if (r.order_id != null) rec.orderId = r.order_id;
  if (r.settle_tx_hash != null) rec.settleTxHash = r.settle_tx_hash;
  return rec;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS trade_records (
      wallet TEXT NOT NULL,
      id TEXT NOT NULL,
      source_note_id TEXT NOT NULL,
      change_note_id TEXT,
      sell_token TEXT NOT NULL,
      sell_token_symbol TEXT NOT NULL,
      buy_token TEXT NOT NULL,
      buy_token_symbol TEXT NOT NULL,
      sell_amount TEXT NOT NULL,
      buy_amount TEXT NOT NULL,
      change_amount TEXT NOT NULL,
      max_fee_bps INTEGER NOT NULL,
      relayer_address TEXT NOT NULL,
      relayer_url TEXT NOT NULL,
      order_id TEXT,
      claims TEXT NOT NULL,
      settle_tx_hash TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, id)
    );
    CREATE INDEX IF NOT EXISTS idx_trade_wallet_source_note ON trade_records(wallet, source_note_id);
    -- order_id index anticipates the SettledScatter backfill path
    -- (see createdAt doc above) that will look up records by relayer
    -- orderId to attach settleTxHash.
    CREATE INDEX IF NOT EXISTS idx_trade_wallet_order ON trade_records(wallet, order_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  await migrateFromAsyncStorage(db);
  return db;
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndInit().catch((err) => {
      // Reset so a retry can re-attempt; otherwise the whole feature
      // stays broken for the session on a transient init failure.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** One-shot: copy legacy AsyncStorage JSON blobs into SQLite, drop the keys.
 *  Idempotent — gated by a `meta` row so subsequent opens are no-ops. */
async function migrateFromAsyncStorage(db: SQLite.SQLiteDatabase): Promise<void> {
  const done = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    MIGRATION_KEY,
  );
  if (done) return;

  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(LEGACY_PREFIX));
  if (keys.length === 0) {
    await db.runAsync('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', MIGRATION_KEY, '1');
    return;
  }

  const pairs = await AsyncStorage.multiGet(keys);
  await db.withTransactionAsync(async () => {
    for (const [key, raw] of pairs) {
      if (!raw) continue;
      const wallet = key.slice(LEGACY_PREFIX.length);
      let records: TradeRecord[] = [];
      try { records = JSON.parse(raw) as TradeRecord[]; } catch { continue; }
      for (const rec of records) {
        await insertRecord(db, wallet, { ...rec, claims: sanitizeClaims(rec.claims) });
      }
    }
    await db.runAsync('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', MIGRATION_KEY, '1');
  });
  // Drop legacy keys only after the transaction commits.
  await AsyncStorage.multiRemove(keys);
}

async function insertRecord(db: SQLite.SQLiteDatabase, wallet: string, rec: TradeRecord): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO trade_records (
       wallet, id, source_note_id, change_note_id,
       sell_token, sell_token_symbol, buy_token, buy_token_symbol,
       sell_amount, buy_amount, change_amount, max_fee_bps,
       relayer_address, relayer_url, order_id, claims,
       settle_tx_hash, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    wallet,
    rec.id,
    rec.sourceNoteId,
    rec.changeNoteId ?? null,
    rec.sellToken,
    rec.sellTokenSymbol,
    rec.buyToken,
    rec.buyTokenSymbol,
    rec.sellAmount,
    rec.buyAmount,
    rec.changeAmount,
    rec.maxFeeBps,
    rec.relayerAddress,
    rec.relayerUrl,
    rec.orderId ?? null,
    JSON.stringify(rec.claims),
    rec.settleTxHash ?? null,
    rec.createdAt,
  );
}

export const TradeHistoryStorage = {
  async append(address: string, record: TradeRecord): Promise<void> {
    const db = await getDb();
    const sanitized: TradeRecord = { ...record, claims: sanitizeClaims(record.claims) };
    await insertRecord(db, normalize(address), sanitized);
  },

  async getAll(address: string): Promise<TradeRecord[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      'SELECT * FROM trade_records WHERE wallet = ? ORDER BY created_at ASC',
      normalize(address),
    );
    return rows.map(rowToRecord);
  },

  /** Find the trade record whose `sourceNoteId` matches — lets the
   *  History screen show trade details for a Spent note. */
  async getBySourceNoteId(
    address: string,
    sourceNoteId: string,
  ): Promise<TradeRecord | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>(
      'SELECT * FROM trade_records WHERE wallet = ? AND source_note_id = ? LIMIT 1',
      normalize(address),
      sourceNoteId,
    );
    return row ? rowToRecord(row) : null;
  },

  async setSettleTxHash(
    address: string,
    id: string,
    settleTxHash: string,
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'UPDATE trade_records SET settle_tx_hash = ? WHERE wallet = ? AND id = ?',
      settleTxHash,
      normalize(address),
      id,
    );
  },

  async clear(address: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM trade_records WHERE wallet = ?', normalize(address));
  },
};
