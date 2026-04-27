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
 *  categories from zk-relayer/src/types/authorize-order.ts. Exported so
 *  UI code can stay in lockstep with the poll loop's view of "still
 *  cancellable" without forking the membership list. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'accepted', 'retrying', 'matched', 'settling',
]);

/** Subset of LIVE_STATUSES the user is allowed to cancel from the UI.
 *  `matched`/`settling` are intentionally excluded — by the time the
 *  status reaches them the on-chain settle is already racing the cancel,
 *  and a cancel that loses the race produces a stuck nonce-nullifier
 *  burn with nothing on the other side. */
export const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'accepted', 'retrying',
]);

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'settled', 'failed', 'dead_letter', 'cancelled', 'expired',
]);

/** Polling cadence. Two phases so the happy path feels instant but idle
 *  orders don't hammer the relayer for minutes. Per design §3.2. */
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 5_000;
const FAST_WINDOW_MS = 30_000;
/** Cadence used when no rows are eligible for polling. The loop keeps
 *  waking up at this interval (instead of stopping entirely) so that a
 *  newly-registered order can join the queue without needing the
 *  subscriber to manually re-arm the timer. 30 s is roughly battery-
 *  invisible and well below the relayer's settlement budget. */
const IDLE_POLL_MS = 30_000;
/** Cap on how far back the poll loop reaches when picking rows to refresh.
 *  The relayer remains the sole source of truth for status — we never
 *  client-side rewrite a row to `expired` just because polling has been
 *  going on for a while. The previous 5-min hard expiry was masking
 *  legitimately-pending orders (whose on-chain expiry is 24 h by default)
 *  as "expired" and hiding the Cancel button for them. The cap here is
 *  generous so a forgotten order eventually drops out of the poll fan-out
 *  even if the relayer never produces a terminal status (e.g. relayer
 *  data loss); it should be longer than any realistic on-chain expiry. */
const MAX_POLL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Network-error backoff, per design §3.2. Each consecutive network
 *  failure advances through this schedule; a success resets. */
const NETWORK_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];

/** Cap on parallel relayer requests per tick. Without this a burst of
 *  N pending orders fans out to N concurrent fetches, congesting the
 *  React Native bridge on mobile. */
const POLL_CHUNK_SIZE = 8;

/** Throttle for the "still polling" heartbeat write. The full-row update
 *  fires immediately whenever the relayer reports an actual change; this
 *  knob only governs the no-op tick that just bumps last_polled_at to
 *  prove liveness. 60 s keeps SQLite I/O quiet without losing the signal. */
const HEARTBEAT_WRITE_INTERVAL_MS = 60_000;

/** SQL fragment shared by the poll loop, list endpoint, and prune so the
 *  set of "still in flight" statuses stays in sync. */
const LIVE_SQL = "last_polled_status NOT IN ('settled', 'failed', 'dead_letter', 'cancelled', 'expired')";

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
  /** Decimal nonce that was bound into the authorize circuit. Required
   *  by CancelService to derive `oldNonceNullifier = Poseidon(TAG_NONCE_NULL,
   *  secret, nonce)`. The relayer doesn't echo the nonce back on the
   *  status endpoint, so we must persist it locally at submit time —
   *  without it, the cancel UI cannot reconstruct the nullifier and the
   *  Cancel button has no live order to act on. Optional for backwards
   *  compat with rows written before this field landed (those orders
   *  simply won't be cancellable from this build). */
  nonce?: string;
  /** EdDSA Ax used at submit time. Lets History match a pending order
   *  back to its escrow note without trusting the relayer to repeat it. */
  pubKeyAx?: string;
  /** Local id of the escrow note this order spent. The Cancel button
   *  uses this to recover the exact `secret` / `salt` (and therefore the
   *  matching `oldNullifier`) — `pubKeyAx + sellToken` collides on a
   *  wallet that holds multiple WETH escrows, picking the first match
   *  generated a proof against an already-spent nullifier and reverted
   *  with `NullifierAlreadySpent` at settle time. */
  sourceNoteId?: string;
  /** Decimals for `sellToken` / `buyToken`, captured at submit time so
   *  the Pending tab can format `sellAmount` / `buyAmount` correctly for
   *  non-18-decimal tokens (e.g. USDC=6). Without these the History row
   *  rendered USDC values as `0.000000000001 USDC`. */
  sellTokenDecimals?: number;
  buyTokenDecimals?: number;
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
/** Gate set by `pausePoll()` / cleared by `resumePoll()`. Checked in
 *  every path that would otherwise start a timer (`startPollLoop` on
 *  a new subscriber, `handleAppStateChange` on foreground resume,
 *  `startTimer` itself). Without this gate, a callsite pausing the
 *  loop around a critical fetch could be defeated by an unrelated
 *  subscription/AppState transition that races the pause. */
let paused = false;

async function pollOnce(): Promise<void> {
  if (pollActive) return; // previous tick still in flight
  pollActive = true;
  try {
    const db = await getDb();
    // Pull only rows we'll actually poll: still LIVE per the relayer's
    // FSM and submitted within the poll-age window. Status itself stays
    // the relayer's call — we never rewrite a row to 'expired' locally,
    // since that masked legitimately-pending orders whose on-chain
    // expiry hadn't elapsed yet.
    const rows = await db.getAllAsync<Row>(
      `SELECT * FROM pending_orders WHERE ${LIVE_SQL} AND submitted_at > ?`,
      Date.now() - MAX_POLL_AGE_MS,
    );
    if (rows.length === 0) return;

    // Chunk the fan-out so a queue of 50 in-flight orders doesn't open
    // 50 simultaneous fetches over the RN bridge.
    let networkFailed = false;
    const walletsTouched = new Set<string>();
    for (let i = 0; i < rows.length; i += POLL_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + POLL_CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (row) => {
          const resp = await RelayerApiService.getAuthorizeOrderStatus(
            row.nullifier,
            row.relayer_url,
          );
          return { row, resp };
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          networkFailed = true;
          continue;
        }
        const { row, resp } = result.value;
        if (!resp) continue; // 404 or malformed — leave for a later tick
        const changed = await applyStatus(db, row, resp);
        if (changed) walletsTouched.add(row.wallet_address);
      }
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
    // Heartbeat write so the prune/debug path can tell the row is being
    // actively polled — but throttled to once per HEARTBEAT_WRITE_INTERVAL_MS
    // because, on a queue with N pending orders, the unthrottled version
    // costs N writes per tick × 0.5–2 ticks/sec. SQLite is fine with that
    // on desktop; on mobile it shows up in battery profiles.
    if (Date.now() - row.last_polled_at >= HEARTBEAT_WRITE_INTERVAL_MS) {
      await db.runAsync(
        'UPDATE pending_orders SET last_polled_at = ? WHERE wallet_address = ? AND nullifier = ?',
        Date.now(),
        row.wallet_address,
        row.nullifier,
      );
    }
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
  // AppState subscription is independent of the timer — we want to keep
  // hearing 'active' transitions even while the timer is paused so we
  // know when to wake back up.
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', handleAppStateChange);
  }
  // Honour the current foreground state on first start; if the app was
  // launched while backgrounded (rare but possible on cold boot from a
  // notification) we shouldn't immediately spin up the timer. Respect
  // the `paused` gate so a new subscriber can't race past pausePoll().
  if (AppState.currentState === 'active' && !paused) startTimer();
}

function startTimer(): void {
  if (pollTimer !== null) return;
  if (paused) return;
  // Schedule via setTimeout so the cadence can shift (fast → slow, or
  // network backoff) without a stop/restart cycle.
  const tick = async () => {
    if (pollTimer === null) return; // stopped while awaiting
    await pollOnce();
    if (pollTimer === null) return;
    const nextMs = await nextDelayMs();
    // Re-check after the second await — stopTimer() between the two
    // awaits would otherwise be silently re-armed by the next line.
    if (pollTimer === null) return;
    pollTimer = setTimeout(tick, nextMs);
  };
  pollTimer = setTimeout(tick, FAST_POLL_MS);
}

function stopTimer(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function stopPollLoop(): void {
  stopTimer();
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
         WHERE ${LIVE_SQL} AND submitted_at > ?
         ORDER BY submitted_at DESC LIMIT 1`,
      Date.now() - MAX_POLL_AGE_MS,
    );
    // Empty queue (or every live row already aged past MAX_POLL_AGE_MS) →
    // fall back to the idle cadence so we're not waking the loop every 5 s
    // for nothing. A fresh `track()` call still fires `pollOnce()`
    // immediately, so user-visible latency is unaffected.
    if (!row) return IDLE_POLL_MS;
    const age = Date.now() - row.submitted_at;
    return age < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  } catch {
    return SLOW_POLL_MS;
  }
}

function handleAppStateChange(state: AppStateStatus): void {
  if (state === 'active') {
    // Foreground: restart the timer so we resume on the normal cadence,
    // and fire one immediate batch tick because while we were in the
    // background the relayer may have finished several orders. Respect
    // the `paused` gate — a critical fetch may be in flight and
    // expecting the loop to stay down.
    if (listeners.size > 0 && !paused) {
      startTimer();
      void pollOnce();
    }
    return;
  }
  // background / inactive: tear the timer down. iOS / Android throttle
  // background JS work unpredictably anyway, and an unkilled setTimeout
  // here keeps fetch attempts firing on whatever sparse cadence the OS
  // grants us — which burns battery and produces uneven status jumps
  // when we come back. The AppState listener stays alive so the next
  // 'active' transition can wake us back up.
  stopTimer();
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

  /** Optimistically mark an order as cancelled locally — called from
   *  the History screen right after `cancelPrivate` mines so the UI
   *  reflects the user's just-confirmed action without waiting for the
   *  relayer's `PrivateCancel` indexer to catch up (which can lag by
   *  one block + RPC poll cadence, plenty of time for a user to wonder
   *  "did it work?"). The next relayer poll will overwrite this with
   *  the canonical 'cancelled' status anyway, so the optimistic write
   *  is safe. */
  async markCancelledLocally(walletAddress: string, nullifier: string, txHash: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE pending_orders
          SET last_polled_status = 'cancelled',
              last_polled_at     = ?,
              settle_tx_hash     = ?
        WHERE wallet_address = ? AND nullifier = ?`,
      Date.now(),
      txHash,
      normalize(walletAddress),
      nullifier,
    );
    notify(normalize(walletAddress));
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
           WHERE wallet_address = ? AND ${LIVE_SQL}
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

  /** Pause the poll loop. Used by OrderService.execute around the
   *  `submitAuthorizeOrder` fetch so the poll's concurrent requests
   *  don't starve the NSURLSession connection pool (iOS caps at 6
   *  concurrent hosts) and push the submit past its fetch timeout.
   *
   *  Sets the `paused` gate so that racing callers (new subscriber,
   *  AppState 'active' transition) can't re-arm the timer until
   *  `resumePoll()`. Idempotent.
   *
   *  Caveat: a `pollOnce()` already in progress when this fires keeps
   *  running to completion — this is about blocking FUTURE ticks, not
   *  cancelling in-flight fetches. Aborting mid-tick would require an
   *  AbortController plumbed through fetchWithTimeout; follow-up work
   *  if the in-flight window turns out to matter. */
  pausePoll(): void {
    paused = true;
    stopTimer();
  },

  /** Resume the poll loop. Clears the pause gate and starts the timer
   *  if the usual subscriber + AppState foreground conditions are met.
   *  Idempotent — a no-subscribers or backgrounded caller just clears
   *  the gate without starting anything, which is the desired state. */
  resumePoll(): void {
    paused = false;
    if (listeners.size === 0) return;
    if (AppState.currentState !== 'active') return;
    startTimer();
  },

  /** Test helper — force a synchronous tick. */
  async _pollNow(): Promise<void> {
    await pollOnce();
  },

  LIVE_STATUSES,
  TERMINAL_STATUSES,
};
