/**
 * HTTP routes for the Half-proof (trustless) order submission path.
 *
 * POST /api/authorize-orders — submit a pre-generated authorize.circom
 *   proof + public signals. The relayer validates, stores, and matches.
 *
 * Unlike POST /api/private-orders (which receives raw secrets), this
 * endpoint receives only a Groth16 proof + 14 public signals + raw
 * signal array. The relayer never touches the user's witness.
 */

import { Router, Request, Response, RequestHandler } from "express";
import {
  validateAuthorizeOrder,
  isTokenCompatible,
  isPriceCompatible,
  publicSignalToAddress,
  isLiveStatus,
  isInFlightStatus,
  isTerminalStatus,
  type AuthorizeOrderFile,
  type AuthorizePublicSignals,
  type StoredAuthorizeOrder,
  type AuthorizeMatch,
} from "../types/authorize-order.js";
import type { AuthorizeSubmitter } from "../core/authorize-submitter.js";
import type { PrivateOrderDB, AuthorizeOrderRow } from "../core/db.js";
import type { SharedOrderbookClient } from "../core/shared-orderbook-client.js";
import { config } from "../config.js";
import { recordOrderSubmitted } from "../core/metrics.js";
import { isSanctionedById } from "../core/sanctions-list.js";

/**
 * [R-6] In-memory cache backed by SQLite. On startup, pending orders
 * are reloaded from DB so they survive relayer restarts.
 */
export const authorizeOrders = new Map<string, StoredAuthorizeOrder>();
/** Pending-order count per pubKey (key = "pubKeyAx:pubKeyAy"). O(1) lookup. */
const pendingCountByPubKey = new Map<string, number>();

// Same-token orders settle via `scatterDirectAuth` and never participate
// in cross-token matching, so they are excluded from this index.
const ordersByPair = new Map<string, Set<string>>();

// Directional `(sell, buy)` key — distinct from the sorted/hex `pairKey`
// in `types/authorize-order.ts` because matching here transposes
// (taker.sell == maker.buy). Inputs may be hex addresses or decimal
// signal strings; BigInt normalises both forms to a common key.
function directedPairKey(sellToken: string, buyToken: string): string {
  return `${BigInt(sellToken).toString()}:${BigInt(buyToken).toString()}`;
}

function indexAuthorizeOrder(nullifier: string, order: AuthorizeOrderFile): void {
  const ps = order.publicSignals;
  if (BigInt(ps.sellToken) === BigInt(ps.buyToken)) return;
  const key = directedPairKey(ps.sellToken, ps.buyToken);
  let bucket = ordersByPair.get(key);
  if (!bucket) {
    bucket = new Set();
    ordersByPair.set(key, bucket);
  }
  bucket.add(nullifier);
}

function unindexAuthorizeOrder(nullifier: string, order: AuthorizeOrderFile): void {
  const ps = order.publicSignals;
  if (BigInt(ps.sellToken) === BigInt(ps.buyToken)) return;
  const key = directedPairKey(ps.sellToken, ps.buyToken);
  const bucket = ordersByPair.get(key);
  if (!bucket) return;
  bucket.delete(nullifier);
  if (bucket.size === 0) ordersByPair.delete(key);
}

// Caller still filters by status/expiry/price.
export function* lookupAuthorizeOrdersByCounterPair(
  counterSellToken: string,
  counterBuyToken: string,
): Generator<[string, StoredAuthorizeOrder]> {
  const key = directedPairKey(counterBuyToken, counterSellToken);
  const bucket = ordersByPair.get(key);
  if (!bucket) return;
  for (const nullifier of bucket) {
    const stored = authorizeOrders.get(nullifier);
    if (stored) yield [nullifier, stored];
  }
}
const MAX_AUTHORIZE_ORDERS = 10_000;
const MAX_ORDERS_PER_PUBKEY = 50;
const MAX_EXPIRY_DURATION_SECS = 24 * 60 * 60; // 24 hours
let _db: PrivateOrderDB | null = null;

// BabyJub field elements are at most 254 bits (~77 decimal digits).
// Reject oversized strings before BigInt parsing to prevent CPU DoS.
const MAX_PUBKEY_LEN = 80;

export function pubKeyId(ax: string, ay: string): string {
  if (ax.length > MAX_PUBKEY_LEN || ay.length > MAX_PUBKEY_LEN) {
    throw new RangeError("pubKey value too large");
  }
  return `${BigInt(ax).toString()}:${BigInt(ay).toString()}`;
}

function incPubKeyCount(ax: string, ay: string): void {
  const id = pubKeyId(ax, ay);
  pendingCountByPubKey.set(id, (pendingCountByPubKey.get(id) ?? 0) + 1);
}

/**
 * The shared-orderbook id we publish for an authorize order is the bytes32
 * hex form of its nullifier (decimal-string form lives in `authorizeOrders`).
 * Deterministic derivation lets cleanup paths cancel the listing without
 * any side-table — survives relayer restarts and matches the publish-time
 * `offerHandle` derivation below.
 */
export function nullifierToOfferHandle(nullifierDecimal: string): string {
  return "0x" + BigInt(nullifierDecimal).toString(16).padStart(64, "0");
}

/** HTTP code for an idempotent replay of an already-known nullifier.
 *   terminal (settled/failed/expired/cancelled) → 200 (final answer)
 *   in-progress (live or in-flight)              → 202
 *   dead_letter                                  → 409 (give-up, surface)
 *  Per docs/design/async-settlement-protocol.md §2.4. */
function idempotencyHttpCode(status: string): number {
  if (status === "dead_letter") return 409;
  // dead_letter is in TERMINAL_STATUSES (it's a final outcome) but the
  // wire contract maps it to 409, not 200 — handled above.
  if (isTerminalStatus(status)) return 200;
  return 202;
}

/** The async-FSM path writes submitted_at/updated_at in epoch-ms
 *  (`Date.now()`), but legacy 'pending' rows written before the migration
 *  used `saveAuthorizeOrder(nowSeconds)`. Normalise at the read boundary
 *  without rewriting historic DB rows: anything below ~Sep-2001 in ms
 *  (10^12) must be a seconds value and gets scaled up. */
function normalizeEpochMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/** Build the status payload shape returned by POST (idempotent) and GET.
 *  `order` is optional — the caller has it cheap from the in-memory cache;
 *  when absent we fall back to parsing the DB blob. */
function buildStatusReply(row: AuthorizeOrderRow, order: AuthorizeOrderFile | null) {
  return {
    status: row.status,
    submittedAt: normalizeEpochMs(row.submittedAt),
    updatedAt: normalizeEpochMs(row.updatedAt || row.submittedAt),
    attempt: row.attempt,
    settleTxHash: row.settleTx ?? null,
    error: row.lastError ?? null,
    expiresAt: order ? Number(order.publicSignals.expiry) : null,
  };
}

function safeParseOrder(json: string): AuthorizeOrderFile | null {
  try { return JSON.parse(json) as AuthorizeOrderFile; } catch { return null; }
}

export function decPubKeyCount(ax: string, ay: string): void {
  const id = pubKeyId(ax, ay);
  const count = (pendingCountByPubKey.get(id) ?? 0) - 1;
  if (count <= 0) pendingCountByPubKey.delete(id);
  else pendingCountByPubKey.set(id, count);
}

let _sharedClient: SharedOrderbookClient | null = null;

export function createAuthorizeOrderRoutes(
  submitter: AuthorizeSubmitter,
  writeLimiter?: RequestHandler,
  relayerAddress?: string,
  readLimiter?: RequestHandler,
  db?: PrivateOrderDB,
  sharedClient?: SharedOrderbookClient | null,
  authWriteLimiter?: RequestHandler,
): Router {
  _sharedClient = sharedClient ?? null;
  // [R-6] Persist authorize orders to SQLite
  if (db) {
    _db = db;
    const rows = db.loadPendingAuthorizeOrders();
    let restored = 0;
    for (const row of rows) {
      try {
        // Validate the nullifier shape upfront. Cleanup paths (purge,
        // drain, post-settle) call `nullifierToOfferHandle(row.nullifier)`
        // without a try/catch, so a corrupt key in this Map would take
        // down the whole sweep on the first bad entry.
        if (typeof row.nullifier !== "string" || !/^[0-9]+$/.test(row.nullifier)) {
          throw new Error(`invalid nullifier shape: ${JSON.stringify(row.nullifier)}`);
        }
        const orderObj = JSON.parse(row.orderJson) as AuthorizeOrderFile;
        // Legacy 'pending' rows were persisted in epoch-seconds; new rows
        // under the async FSM use epoch-ms. Normalise on restore so the
        // in-memory map stays in a single unit regardless of which
        // generation the row came from.
        authorizeOrders.set(row.nullifier, {
          order: orderObj,
          status: row.status as StoredAuthorizeOrder["status"],
          submittedAt: normalizeEpochMs(row.submittedAt),
          pubKeyAx: row.pubKeyAx,
          pubKeyAy: row.pubKeyAy,
          settleTxHash: row.settleTx ?? undefined,
        });
        indexAuthorizeOrder(row.nullifier, orderObj);
        // Rebuild the per-pubKey pending counter so MAX_ORDERS_PER_PUBKEY
        // can't be bypassed by restarting the relayer. Only live-queue and
        // in-flight rows hold a slot; terminal statuses have already
        // released theirs.
        if ((isLiveStatus(row.status) || isInFlightStatus(row.status)) && row.pubKeyAx && row.pubKeyAy) {
          incPubKeyCount(row.pubKeyAx, row.pubKeyAy);
        }
        restored++;
      } catch (err) {
        console.error(`[R-6] Skipping corrupt authorize order ${row.nullifier}:`, err);
        db.deleteAuthorizeOrder(row.nullifier);
      }
    }
    if (restored > 0) {
      console.log(`[R-6] Restored ${restored} pending authorize orders from DB`);
    }
  }
  const router = Router();

  // POST /api/authorize-orders — submit a Half-proof order
  if (writeLimiter) router.post("/", writeLimiter);
  if (authWriteLimiter) router.post("/", authWriteLimiter);
  router.post("/", (async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;

      // ── 1. Parse the incoming order ──
      const order: AuthorizeOrderFile = {
        proof: body.proof as AuthorizeOrderFile["proof"],
        publicSignals: body.publicSignals as AuthorizePublicSignals,
        publicSignalsArray: body.publicSignalsArray as string[],
        // tier is optional during the multi-tier rollout. The
        // validator below rejects any value outside {16, 64, 128};
        // missing means legacy client and falls back to tier 16 in
        // the consumer (see tierForOrder).
        tier: body.tier as AuthorizeOrderFile["tier"],
      };

      // ── 2. Validate structure + public signals ──
      const nowSeconds = Math.floor(Date.now() / 1000);
      const addr = relayerAddress ?? submitter.getAddress();
      const error = validateAuthorizeOrder(order, addr, nowSeconds);
      if (error) {
        // SPIKE diagnostic: surface why validation rejected the body so the
        // mobile-side `Aborted` diagnosis isn't blocked on opaque 400s.
        console.log(`[diag-auth] VALIDATION_400 reason="${error}" proof_keys=${
          Object.keys(order.proof ?? {}).join(",")
        } ps_keys=${
          Object.keys(order.publicSignals ?? {}).join(",")
        } psa_len=${order.publicSignalsArray?.length ?? "n/a"}`);
        res.status(400).json({ error });
        return;
      }

      const nullifier = order.publicSignals.nullifier;
      const pollUrl = `/api/authorize-orders/${nullifier}`;

      // ── 3. Idempotency — same nullifier maps to one outcome forever.
      // Read the DB row (durable across restarts; the in-memory map is a
      // cache). Re-verifying the proof on every retry would let an attacker
      // force CPU work just by replaying old payloads — design §2.4.
      const existing = _db?.getAuthorizeOrder(nullifier) ?? null;
      if (existing) {
        // A replayed POST may carry a different `order` body than the one
        // originally persisted (same nullifier is the only invariant).
        // Deriving expiresAt from the stored blob keeps the idempotent
        // response faithful to the persisted contract; fall back to the
        // just-validated request value only if the blob can't be parsed.
        const persistedOrder = safeParseOrder(existing.orderJson);
        const reply = buildStatusReply(existing, persistedOrder ?? order);
        const code = idempotencyHttpCode(existing.status);
        res.status(code).json({ ...reply, nullifier, pollUrl });
        return;
      }
      // In-memory fallback for setups without a DB. Status is whatever the
      // worker last set; the in-memory record always has at least 'pending'.
      const cached = authorizeOrders.get(nullifier);
      if (cached) {
        // `cached.submittedAt` is epoch-ms under the async FSM (the
        // seconds-based legacy path is gone below). Reply in the same
        // unit as the DB-backed path above.
        res.status(202).json({
          status: cached.status,
          submittedAt: cached.submittedAt,
          updatedAt: cached.submittedAt,
          attempt: 0,
          settleTxHash: cached.settleTxHash ?? null,
          error: null,
          expiresAt: Number(cached.order.publicSignals.expiry),
          nullifier,
          pollUrl,
        });
        return;
      }

      // ── 4. Size cap — prevent unbounded memory growth ──
      if (authorizeOrders.size >= MAX_AUTHORIZE_ORDERS) {
        res.status(503).json({ error: "Authorize order store full. Try again later." });
        return;
      }

      // ── 4a. Max expiry duration — prevent long-lived spam orders ──
      const expiry = Number(order.publicSignals.expiry);
      if (expiry - nowSeconds > MAX_EXPIRY_DURATION_SECS) {
        res.status(400).json({ error: `Expiry too far in future (max ${MAX_EXPIRY_DURATION_SECS}s)` });
        return;
      }

      // ── 4b. Verify pubKey via pubKeyBind (compliance — mandatory) ──
      const pubKeyAx = body.pubKeyAx as string | undefined;
      const pubKeyAy = body.pubKeyAy as string | undefined;
      if (!pubKeyAx || !pubKeyAy) {
        res.status(400).json({ error: "pubKeyAx and pubKeyAy are required for compliance" });
        return;
      }
      const { poseidonHash: poseidonHashFn } = await import("../core/zk-prover.js");
      const computed = await poseidonHashFn([BigInt(pubKeyAx), BigInt(pubKeyAy), BigInt(order.publicSignals.nullifier)]);
      if (computed.toString() !== order.publicSignals.pubKeyBind) {
        res.status(400).json({ error: "pubKey does not match pubKeyBind in proof" });
        return;
      }

      // Normalize pubKey once and reuse for sanctions + per-pubKey rate limit
      // (both keyed on the same `{ax}:{ay}` bigint-normalized id).
      const pkId = pubKeyId(pubKeyAx, pubKeyAy);

      // ── 4c. [R-10] Sanctions check — reject orders from blocked pubKeys ──
      if (isSanctionedById(pkId)) {
        res.status(403).json({ error: "Order rejected: pubKey is on sanctions list" });
        return;
      }

      // ── 4d. Per-pubKey order limit — optimistic increment before any await ──
      if ((pendingCountByPubKey.get(pkId) ?? 0) >= MAX_ORDERS_PER_PUBKEY) {
        res.status(429).json({ error: `Too many pending orders for this pubKey (max ${MAX_ORDERS_PER_PUBKEY})` });
        return;
      }
      incPubKeyCount(pubKeyAx, pubKeyAy);

      // ── 5. Persist as 'accepted' and seed the in-memory match cache.
      // The settlement worker (core/settlement-worker.ts) picks the row up
      // from the queue; this handler returns immediately.
      const submittedAtMs = Date.now();
      try {
        _db?.insertAcceptedOrder({
          nullifier,
          submittedAt: submittedAtMs,
          orderJson: JSON.stringify(order),
          pubKeyAx,
          pubKeyAy,
        });
      } catch (err) {
        // Lost the unique-constraint race against a concurrent submit.
        // Restore the per-pubKey slot we optimistically claimed and route
        // through the idempotency path so the response is consistent.
        decPubKeyCount(pubKeyAx, pubKeyAy);
        const row = _db?.getAuthorizeOrder(nullifier);
        if (row) {
          const reply = buildStatusReply(row, order);
          res.status(idempotencyHttpCode(row.status)).json({ ...reply, nullifier, pollUrl });
          return;
        }
        throw err;
      }

      // Keep the in-memory timestamp in epoch-ms to match what
      // `insertAcceptedOrder` persists. The design doc (§2.1) and every
      // other consumer (worker retry scheduling, GET response, FSM
      // transitions) talks in ms; flooring to seconds here previously
      // created a unit mismatch between freshly-submitted orders and rows
      // restored from the DB.
      const stored: StoredAuthorizeOrder = {
        order,
        status: "accepted",
        submittedAt: submittedAtMs,
        pubKeyAx,
        pubKeyAy,
      };
      authorizeOrders.set(nullifier, stored);
      indexAuthorizeOrder(nullifier, order);
      recordOrderSubmitted();

      console.log(
        `[authorize-orders] Accepted: sell=${order.publicSignals.sellToken} ` +
        `buy=${order.publicSignals.buyToken} ` +
        `amount=${order.publicSignals.sellAmount} ` +
        `nullifier=${nullifier.slice(0, 18)}...` +
        ` pubKey=${pubKeyAx.slice(0, 12)}...`,
      );

      // ── 5b. Publish cross-token orders to the shared orderbook so
      // counterparty relayers can find them. Same-token (scatter) doesn't
      // need a counterparty, so we skip the publish to keep the OB clean.
      const isSameToken = BigInt(order.publicSignals.sellToken) === BigInt(order.publicSignals.buyToken);
      if (!isSameToken && _sharedClient) {
        const ps = order.publicSignals;
        const offerHandle = nullifierToOfferHandle(nullifier);
        // Fire-and-forget — don't block the 202. Errors are logged by the
        // shared-OB client; a publish failure just means cross-relayer
        // visibility is delayed, not that the order is lost.
        void _sharedClient.postOrder({
          id: offerHandle,
          sellToken: publicSignalToAddress(ps.sellToken),
          buyToken: publicSignalToAddress(ps.buyToken),
          sellAmount: ps.sellAmount,
          buyAmount: ps.buyAmount,
          minFillAmount: ps.buyAmount,
          maxFee: Number(ps.maxFee),
          expiry: Number(ps.expiry),
        }).catch((err) => {
          console.warn("[authorize-orders] shared-OB publish failed:", err instanceof Error ? err.message : err);
        });
      }

      res.status(202).json({
        status: "accepted",
        submittedAt: submittedAtMs,
        updatedAt: submittedAtMs,
        attempt: 0,
        settleTxHash: null,
        error: null,
        expiresAt: Number(order.publicSignals.expiry),
        nullifier,
        pollUrl,
      });
    } catch (err: unknown) {
      console.error("[authorize-orders] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }) as RequestHandler);

  // GET /api/authorize-orders/:nullifier — status-poll endpoint.
  // Reads from the durable DB row (the in-memory map is best-effort cache).
  if (readLimiter) router.get("/:nullifier", readLimiter);
  router.get("/:nullifier", ((req: Request, res: Response) => {
    const nullifier = req.params.nullifier;
    const row = _db?.getAuthorizeOrder(nullifier) ?? null;
    if (row) {
      const cached = authorizeOrders.get(nullifier);
      const order = cached?.order ?? safeParseOrder(row.orderJson);
      res.json(buildStatusReply(row, order));
      return;
    }
    const cached = authorizeOrders.get(nullifier);
    if (cached) {
      // `cached.submittedAt` is epoch-ms now (see POST handler); the
      // previous `* 1000` multiplication dates from when it was seconds.
      res.json({
        status: cached.status,
        submittedAt: cached.submittedAt,
        updatedAt: cached.submittedAt,
        attempt: 0,
        settleTxHash: cached.settleTxHash ?? null,
        error: null,
        expiresAt: Number(cached.order.publicSignals.expiry),
      });
      return;
    }
    res.status(404).json({ error: "Order not found" });
  }) as RequestHandler);

  // DELETE /api/authorize-orders/:nullifier — cancel a pending order
  // [Copilot #3062066619] Cancel is disabled until an authenticated
  // mechanism is implemented. Without proof of ownership (e.g., an EdDSA
  // signature over the nullifier), anyone who knows the nullifier can
  // cancel another user's order — a trivial DoS vector. The nullifier
  // is part of the public on-chain trace, so it is not secret.
  router.delete("/:nullifier", ((req: Request, res: Response) => {
    res.status(501).json({
      error: "Unauthenticated cancel is disabled. Use order expiry or contact the relayer operator.",
    });
  }) as RequestHandler);

  return router;
}

// ─── Simple matching logic ──────────────────────────────────────

// Token/price compatibility mirrors settleAuth on-chain (steps 3-4).
export function findMatch(incoming: StoredAuthorizeOrder): AuthorizeMatch | null {
  const inPs = incoming.order.publicSignals;
  for (const [, candidate] of lookupAuthorizeOrdersByCounterPair(inPs.sellToken, inPs.buyToken)) {
    if (candidate === incoming) continue;
    // Live = in the queue, eligible to be paired. In-flight rows
    // ('matched'/'settling') are mid-tx; terminal rows are done.
    if (!isLiveStatus(candidate.status)) continue;

    const cPs = candidate.order.publicSignals;
    if (!isTokenCompatible(cPs, inPs)) continue;
    if (!isPriceCompatible(cPs, inPs)) continue;

    return { maker: candidate, taker: incoming };
  }
  return null;
}

/**
 * [R-7] Drain all pending authorize orders — cancel them and return count.
 * Called by admin API to clear the order queue before maintenance or shutdown.
 */
export function drainAuthorizeOrders(): number {
  const toDelete: Array<[string, StoredAuthorizeOrder]> = [];
  for (const [key, stored] of authorizeOrders) {
    if (!isLiveStatus(stored.status)) continue;
    stored.status = "cancelled";
    if (stored.pubKeyAx && stored.pubKeyAy) {
      decPubKeyCount(stored.pubKeyAx, stored.pubKeyAy);
    }
    _db?.updateAuthorizeOrderStatus(key, "cancelled");
    if (_sharedClient) {
      void _sharedClient.cancelOrder(nullifierToOfferHandle(key)).catch(() => {});
    }
    toDelete.push([key, stored]);
  }
  for (const [key, stored] of toDelete) {
    unindexAuthorizeOrder(key, stored.order);
    authorizeOrders.delete(key);
  }
  return toDelete.length;
}

/** Get current authorize order counts by status. */
export function getAuthorizeOrderStats(): { pending: number; matched: number; total: number } {
  let pending = 0;
  let matched = 0;
  for (const [, stored] of authorizeOrders) {
    if (stored.status === "pending") pending++;
    else if (stored.status === "matched") matched++;
  }
  return { pending, matched, total: authorizeOrders.size };
}

/**
 * Purge non-pending and expired orders from the in-memory store.
 * Call periodically (e.g. from a setInterval in index.ts) to prevent
 * unbounded memory growth. Removes:
 *   - orders with status != "pending" (settled, cancelled, etc.)
 *   - pending orders past their expiry timestamp
 * Returns the number of entries removed.
 */
export function purgeNonPendingAuthorizeOrders(): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  let removed = 0;
  for (const [key, stored] of authorizeOrders) {
    // Skip anything the worker is actively settling — yanking it from
    // the in-memory map mid-flight would strand the match's counterparty
    // reference.
    if (isInFlightStatus(stored.status)) continue;

    const isLive = isLiveStatus(stored.status);
    const expired = Number(stored.order.publicSignals.expiry) < nowSeconds;

    if (isTerminalStatus(stored.status) || (isLive && expired)) {
      if (isLive && expired && stored.pubKeyAx && stored.pubKeyAy) {
        decPubKeyCount(stored.pubKeyAx, stored.pubKeyAy);
      }
      if (_sharedClient) {
        void _sharedClient.cancelOrder(nullifierToOfferHandle(key)).catch(() => {});
      }
      unindexAuthorizeOrder(key, stored.order);
      authorizeOrders.delete(key);
      removed++;
    }
  }
  // [R-6] Also purge from DB
  _db?.purgeNonPendingAuthorizeOrdersDB();
  return removed;
}
