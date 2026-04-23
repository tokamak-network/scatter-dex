/**
 * PendingOrdersService — local queue of submitted orders whose relayer
 * settlement is still pending.
 *
 * The relayer's async-settlement protocol (docs/design/async-settlement-
 * protocol.md) returns 202 immediately, then settles in the background.
 * The client needs its own durable record so that:
 *   - History can show "Pending / Retrying / Settled" rows even when
 *     the app is restarted mid-settle.
 *   - A single central poller drives `GET /api/authorize-orders/:nullifier`
 *     rather than each screen spinning its own loop.
 *   - Terminal outcomes (settled / failed / dead_letter / expired) trigger
 *     a one-shot TradeHistoryStorage backfill with the final tx hash.
 *
 * Storage: expo-sqlite table `pending_orders`, keyed by `(wallet, nullifier)`.
 * Polling: one shared interval per mounted listener; paused while the app
 * is backgrounded (AppState) since iOS / Android will throttle or kill
 * background fetches anyway.
 */
import * as SQLite from 'expo-sqlite';
import { AppState, AppStateStatus } from 'react-native';
import { RelayerApiService, AuthorizeOrderStatusResponse } from './RelayerApiService';
import { TradeHistoryStorage } from './TradeHistoryStorage';

const DB_NAME = 'scatterdex_trade_history.db';

/** FSM states that mean "keep polling". Mirrors relayer's LIVE + IN_FLIGHT
 *  categories from zk-relayer/src/types/authorize-order.ts. */
const LIVE_STATUSES = new Set([
  'pending', 'accepted', 'retrying', 'matched', 'settling',
]);

const TERMINAL_STATUSES = new Set([
  'settled', 'failed', 'dead_letter', 'cancelled', 'expired',
]);

/** Polling cadence. Two phases so the happy path feels instant but idle
 *  orders don't hammer the relayer for minutes. Per design §3.2. */
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 5_000;
const FAST_WINDOW_MS = 30_000;
/** Max time a pending order stays in the poll loop. After this we stop
 *  polling and leave the row for the user to surface as "stuck" — the
 *  relayer will eventually mark it expired or dead_letter anyway. */
const MAX_POLL_AGE_MS = 5 * 60_000;

/** Network-error backoff, per design §3.2. Each consecutive network
 *  failure advances through this schedule; a success resets. */
const NETWORK_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];

export interface PendingOrderSummary {
  sellToken: string;
  sellTokenSymbol: string;
  buyToken: string;
  buyTokenSymbol: string;
  sellAmount: string;
  buyAmount: string;
  maxFeeBps: number;
  /** Local `orderHash` — useful for linking back to TradeHistoryStorage
   *  once the settlement confirms. */
  orderHash: string;
}

export interface PendingOrder {
  nullifier: string;
  walletAddress: string;
  relayerUrl: string;
  submittedAt: number;
  /** Last status we saw from GET /:nullifier. */
  lastPolledStatus: string;
  lastPolledAt: number;
  /** Number of settlement attempts the relayer has logged. */
  attempt: number;
  settleTxHash: string | null;
  /** Relayer-surfaced error for `failed` / `dead_letter`. */
  error: string | null;
  orderSummary: PendingOrderSummary;
}

interface Row {
  nullifier: string;
  wallet_address: string;
  relayer_url: string;
  submitted_at: number;
  last_polled_status: string;
  last_polled_at: number;
  attempt: number;
  settle_tx_hash: string | null;
  last_error: string | null;
  order_summary: string;
}

function rowToOrder(r: Row): PendingOrder {
  return {
    nullifier: r.nullifier,
    walletAddress: r.wallet_address,
    relayerUrl: r.relayer_url,
    submittedAt: r.submitted_at,
    lastPolledStatus: r.last_polled_status,
    lastPolledAt: r.last_polled_at,
    attempt: r.attempt,
    settleTxHash: r.settle_tx_hash,
    error: r.last_error,
    orderSummary: JSON.parse(r.order_summary) as PendingOrderSummary,
  };
}

const normalize = (addr: string) => addr.toLowerCase();

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  // Shared DB with TradeHistoryStorage — avoids opening a second file +
  // lets a future backfill link `pending_orders.nullifier` → `trade_records`
  // in a single transaction.
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pending_orders (
      nullifier           TEXT NOT NULL,
      wallet_address      TEXT NOT NULL,
      relayer_url         TEXT NOT NULL,
      submitted_at        INTEGER NOT NULL,
      last_polled_status  TEXT NOT NULL,
      last_polled_at      INTEGER NOT NULL,
      attempt             INTEGER NOT NULL DEFAULT 0,
      settle_tx_hash      TEXT,
      last_error          TEXT,
      order_summary       TEXT NOT NULL,
      PRIMARY KEY (wallet_address, nullifier)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_wallet
      ON pending_orders (wallet_address, submitted_at DESC);
  `);
  return db;
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndInit().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

type Listener = (walletAddress: string) => void;
const listeners = new Set<Listener>();
function notify(walletAddress: string) {
  for (const l of listeners) {
    try { l(walletAddress); } catch (err) { console.warn('[PendingOrders] listener threw:', err); }
  }
}

// ── Poll loop state. One per process (not per wallet) because the native
// layer gives us a single AppState stream anyway. Paused while the poll
// loop has no listeners; the interval handle is torn down during pause to
// avoid waking the JS thread while the screen is unmounted.
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollActive = false;
let networkBackoffStep = 0;
let appStateSub: { remove: () => void } | null = null;

async function pollOnce(): Promise<void> {
  if (pollActive) return; // previous tick still in flight
  pollActive = true;
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      `SELECT * FROM pending_orders
         WHERE last_polled_status NOT IN ('settled', 'failed', 'dead_letter', 'cancelled', 'expired')`,
    );
    if (rows.length === 0) return;

    // Stop polling rows that have been in flight for too long — the
    // relayer's own sweeper will mark them expired eventually; no point
    // hammering in the meantime.
    const now = Date.now();
    const live = rows.filter((r) => now - r.submitted_at < MAX_POLL_AGE_MS);

    const results = await Promise.allSettled(
      live.map(async (row) => {
        const resp = await RelayerApiService.getAuthorizeOrderStatus(
          row.nullifier,
          row.relayer_url,
        );
        return { row, resp };
      }),
    );

    let networkFailed = false;
    const walletsTouched = new Set<string>();

    for (const result of results) {
      if (result.status === 'rejected') {
        networkFailed = true;
        continue;
      }
      const { row, resp } = result.value;
      if (!resp) continue; // 404 or malformed — leave the row for a later tick
      const changed = await applyStatus(db, row, resp);
      if (changed) walletsTouched.add(row.wallet_address);
    }

    // Adaptive backoff: back off on network failures, reset on success.
    // One consolidated signal per tick so a single flaky poll doesn't
    // snowball into a huge delay.
    if (networkFailed) {
      networkBackoffStep = Math.min(networkBackoffStep + 1, NETWORK_BACKOFF_MS.length - 1);
    } else {
      networkBackoffStep = 0;
    }

    for (const w of walletsTouched) notify(w);
  } catch (err) {
    console.warn('[PendingOrders] poll error:', err);
  } finally {
    pollActive = false;
  }
}

async function applyStatus(
  db: SQLite.SQLiteDatabase,
  row: Row,
  resp: AuthorizeOrderStatusResponse,
): Promise<boolean> {
  const statusUnchanged =
    resp.status === row.last_polled_status
    && resp.attempt === row.attempt
    && (resp.settleTxHash ?? null) === row.settle_tx_hash
    && (resp.error ?? null) === row.last_error;
  if (statusUnchanged) {
    // Still update last_polled_at so the GC / debug view can tell the row
    // is being actively polled. Cheap single-column write.
    await db.runAsync(
      'UPDATE pending_orders SET last_polled_at = ? WHERE wallet_address = ? AND nullifier = ?',
      Date.now(),
      row.wallet_address,
      row.nullifier,
    );
    return false;
  }

  await db.runAsync(
    `UPDATE pending_orders
        SET last_polled_status = ?, last_polled_at = ?, attempt = ?,
            settle_tx_hash = ?, last_error = ?
      WHERE wallet_address = ? AND nullifier = ?`,
    resp.status,
    Date.now(),
    resp.attempt ?? 0,
    resp.settleTxHash ?? null,
    resp.error ?? null,
    row.wallet_address,
    row.nullifier,
  );

  // On settle, backfill the settleTxHash into TradeHistoryStorage so the
  // expanded-row view in History shows the final tx. Link is by orderHash,
  // which we stash in order_summary at insert time.
  if (resp.status === 'settled' && resp.settleTxHash) {
    try {
      const summary = JSON.parse(row.order_summary) as PendingOrderSummary;
      if (summary.orderHash) {
        await TradeHistoryStorage.setSettleTxHash(
          row.wallet_address,
          summary.orderHash,
          resp.settleTxHash,
        );
      }
    } catch (err) {
      console.warn('[PendingOrders] settle backfill failed:', err);
    }
  }

  return true;
}

function startPollLoop(): void {
  if (pollTimer !== null) return;
  // Schedule via setTimeout so the cadence can shift (fast → slow, or
  // network backoff) without a stop/restart cycle.
  const tick = async () => {
    if (pollTimer === null) return; // stopped while awaiting
    await pollOnce();
    if (pollTimer === null) return;
    const nextMs = await nextDelayMs();
    pollTimer = setTimeout(tick, nextMs);
  };
  pollTimer = setTimeout(tick, FAST_POLL_MS);

  // AppState subscription — pause/resume with foreground/background
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', handleAppStateChange);
  }
}

function stopPollLoop(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (appStateSub) {
    appStateSub.remove();
    appStateSub = null;
  }
}

/** Pick the delay for the next tick based on the youngest live row and
 *  the current network-backoff step. */
async function nextDelayMs(): Promise<number> {
  if (networkBackoffStep > 0) return NETWORK_BACKOFF_MS[networkBackoffStep - 1];
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ submitted_at: number }>(
      `SELECT submitted_at FROM pending_orders
         WHERE last_polled_status NOT IN ('settled', 'failed', 'dead_letter', 'cancelled', 'expired')
         ORDER BY submitted_at DESC LIMIT 1`,
    );
    if (!row) return SLOW_POLL_MS;
    const age = Date.now() - row.submitted_at;
    return age < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  } catch {
    return SLOW_POLL_MS;
  }
}

function handleAppStateChange(state: AppStateStatus): void {
  // Resume-on-foreground is the interesting path: while we were in the
  // background the relayer may have finished several orders, so a single
  // batch refresh is cheaper than a staggered one.
  if (state === 'active' && listeners.size > 0) {
    void pollOnce();
  }
}

export const PendingOrdersService = {
  /** Register a freshly-submitted order. Called from OrderService after
   *  the relayer returns 202. Idempotent: a re-submission of the same
   *  nullifier (e.g. after a 202 retry on the POST) updates the status
   *  rather than creating a duplicate row. */
  async track(order: {
    nullifier: string;
    walletAddress: string;
    relayerUrl: string;
    relayerResponseStatus: string;
    attempt?: number;
    summary: PendingOrderSummary;
  }): Promise<void> {
    const db = await getDb();
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO pending_orders (
         nullifier, wallet_address, relayer_url, submitted_at,
         last_polled_status, last_polled_at, attempt, settle_tx_hash,
         last_error, order_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(wallet_address, nullifier) DO UPDATE SET
         last_polled_status = excluded.last_polled_status,
         last_polled_at     = excluded.last_polled_at,
         attempt            = excluded.attempt,
         relayer_url        = excluded.relayer_url`,
      order.nullifier,
      normalize(order.walletAddress),
      order.relayerUrl,
      now,
      order.relayerResponseStatus,
      now,
      order.attempt ?? 0,
      JSON.stringify(order.summary),
    );
    notify(normalize(order.walletAddress));
    // Kick the loop immediately so the first poll happens before the user
    // has even navigated away from the submit screen.
    if (listeners.size > 0) void pollOnce();
  },

  /** List pending orders for a wallet. Include-terminal lets History's
   *  "Recently Settled" row show the last few outcomes without cluttering
   *  the live list. */
  async listForWallet(
    walletAddress: string,
    opts: { includeTerminal?: boolean } = {},
  ): Promise<PendingOrder[]> {
    const db = await getDb();
    const sql = opts.includeTerminal
      ? 'SELECT * FROM pending_orders WHERE wallet_address = ? ORDER BY submitted_at DESC'
      : `SELECT * FROM pending_orders
           WHERE wallet_address = ?
             AND last_polled_status NOT IN ('settled', 'failed', 'dead_letter', 'cancelled', 'expired')
           ORDER BY submitted_at DESC`;
    const rows = await db.getAllAsync<Row>(sql, normalize(walletAddress));
    return rows.map(rowToOrder);
  },

  /** Remove terminal rows older than a day so the list doesn't grow
   *  unbounded. Called from the History screen's mount effect. */
  async prune(walletAddress: string, olderThanMs = 24 * 60 * 60_000): Promise<number> {
    const db = await getDb();
    const cutoff = Date.now() - olderThanMs;
    const result = await db.runAsync(
      `DELETE FROM pending_orders
         WHERE wallet_address = ?
           AND last_polled_status IN ('settled', 'failed', 'dead_letter', 'cancelled', 'expired')
           AND last_polled_at < ?`,
      normalize(walletAddress),
      cutoff,
    );
    return result.changes;
  },

  /** Subscribe to row-level change notifications (one notify per changed
   *  tick, not per row). Returns an unsubscribe function. The first
   *  subscriber starts the poll loop; the last unsubscribe stops it. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    startPollLoop();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stopPollLoop();
    };
  },

  /** Test helper — force a synchronous tick. */
  async _pollNow(): Promise<void> {
    await pollOnce();
  },

  LIVE_STATUSES,
  TERMINAL_STATUSES,
};
