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
  type AuthorizeOrderFile,
  type AuthorizePublicSignals,
  type StoredAuthorizeOrder,
  type AuthorizeMatch,
} from "../types/authorize-order.js";
import type { AuthorizeSubmitter } from "../core/authorize-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
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
        authorizeOrders.set(row.nullifier, {
          order: orderObj,
          status: row.status as StoredAuthorizeOrder["status"],
          submittedAt: row.submittedAt,
          pubKeyAx: row.pubKeyAx,
          pubKeyAy: row.pubKeyAy,
          settleTxHash: row.settleTx ?? undefined,
        });
        indexAuthorizeOrder(row.nullifier, orderObj);
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
      };

      // ── 2. Validate structure + public signals ──
      const nowSeconds = Math.floor(Date.now() / 1000);
      const addr = relayerAddress ?? submitter.getAddress();
      const error = validateAuthorizeOrder(order, addr, nowSeconds);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      // ── 3. Dedup by nullifier (before size cap so retries get 409, not 503) ──
      const nullifier = order.publicSignals.nullifier;
      if (authorizeOrders.has(nullifier)) {
        res.status(409).json({ error: "Order with this nullifier already exists" });
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
      // Increment immediately to prevent race conditions across concurrent requests
      incPubKeyCount(pubKeyAx, pubKeyAy);

      // ── 5. Store the order ──
      const stored: StoredAuthorizeOrder = {
        order,
        status: "pending",
        submittedAt: nowSeconds,
        pubKeyAx,
        pubKeyAy,
      };
      authorizeOrders.set(nullifier, stored);
      indexAuthorizeOrder(nullifier, order);
      _db?.saveAuthorizeOrder(nullifier, "pending", nowSeconds, JSON.stringify(order), pubKeyAx, pubKeyAy);
      // [R-8] Record order submission for throughput metrics
      recordOrderSubmitted();

      console.log(
        `[authorize-orders] New order: sell=${order.publicSignals.sellToken} ` +
        `buy=${order.publicSignals.buyToken} ` +
        `amount=${order.publicSignals.sellAmount} ` +
        `nullifier=${nullifier.slice(0, 18)}...` +
        (pubKeyAx ? ` pubKey=${pubKeyAx.slice(0, 12)}...` : ""),
      );

      // ── 5a. Same-token scatter — no counterparty needed ──
      const isSameToken = BigInt(order.publicSignals.sellToken) === BigInt(order.publicSignals.buyToken);
      if (isSameToken) {
        console.log("[authorize-orders] Same-token order detected — submitting scatterDirectAuth...");
        stored.status = "matched";
        try {
          // Use the relayer's configured fee so the fee is actually routed
          // to the FeeVault (capped by the user's signed maxFee inside
          // `computeFee`). Previously hard-coded to 0n, which meant every
          // scatter settled with fee=0 and no vault deposit.
          const txHash = await submitter.submitScatterDirectAuth(order, BigInt(config.relayerFee));
          stored.status = "settled";
          stored.settleTxHash = txHash;
          decPubKeyCount(pubKeyAx, pubKeyAy);
          _db?.updateAuthorizeOrderStatus(nullifier, "settled", txHash);
          res.json({ status: "settled", txHash, nullifier });
          return;
        } catch (err) {
          // Keep a tombstone entry (status=cancelled) to prevent resubmission
          // of the same nullifier — the TX may have been broadcast but not confirmed.
          stored.status = "cancelled";
          decPubKeyCount(pubKeyAx, pubKeyAy);
          _db?.updateAuthorizeOrderStatus(nullifier, "cancelled");
          console.error("[authorize-orders] scatterDirectAuth failed:", err);
          res.status(500).json({
            status: "scatter_failed",
            error: "scatterDirectAuth submission failed — generate a new proof to retry",
            nullifier,
          });
          return;
        }
      }

      // ── 5b. Publish to shared orderbook for cross-relayer visibility ──
      if (_sharedClient) {
        const ps = order.publicSignals;
        const offerHandle = nullifierToOfferHandle(nullifier);
        const orderbookId = await _sharedClient.postOrder({
          id: offerHandle,
          sellToken: "0x" + BigInt(ps.sellToken).toString(16).padStart(40, "0"),
          buyToken: "0x" + BigInt(ps.buyToken).toString(16).padStart(40, "0"),
          sellAmount: ps.sellAmount,
          buyAmount: ps.buyAmount,
          minFillAmount: ps.buyAmount,
          maxFee: Number(ps.maxFee),
          expiry: Number(ps.expiry),
        });
        if (orderbookId) {
          console.log(`[authorize-orders] Published to shared orderbook: ${orderbookId}`);
        }
      }

      // ── 6. Try to match ──
      const match = findMatch(stored);
      if (match) {
        console.log("[authorize-orders] Match found! Submitting settleAuth...");
        try {
          // Mark both as matched
          match.maker.status = "matched";
          match.taker.status = "matched";

          // Use the relayer's configured fee — `computeFee` caps each
          // side by the respective maker/taker maxFee, so the signed
          // bound is always respected. Hard-coding 0n here silently
          // skipped the fee deposit to FeeVault on every cross-token
          // settlement.
          const txHash = await submitter.submitAuthSettle(match, BigInt(config.relayerFee));

          match.maker.status = "settled";
          match.maker.settleTxHash = txHash;
          decPubKeyCount(match.maker.pubKeyAx!, match.maker.pubKeyAy!);
          match.taker.status = "settled";
          match.taker.settleTxHash = txHash;
          decPubKeyCount(match.taker.pubKeyAx!, match.taker.pubKeyAy!);
          _db?.updateAuthorizeOrderStatus(match.maker.order.publicSignals.nullifier, "settled", txHash);
          _db?.updateAuthorizeOrderStatus(match.taker.order.publicSignals.nullifier, "settled", txHash);

          // Cancel both sides from shared orderbook. Best-effort —
          // a 404 here is harmless (already cancelled / expired).
          if (_sharedClient) {
            const makerOid = nullifierToOfferHandle(match.maker.order.publicSignals.nullifier);
            const takerOid = nullifierToOfferHandle(match.taker.order.publicSignals.nullifier);
            void _sharedClient.cancelOrder(makerOid).catch(() => {});
            void _sharedClient.cancelOrder(takerOid).catch(() => {});
          }

          res.json({
            status: "settled",
            txHash,
            nullifier,
          });
          return;
        } catch (err) {
          // Settlement failed — revert both to pending for retry
          match.maker.status = "pending";
          match.taker.status = "pending";

          console.error("[authorize-orders] settleAuth failed:", err);
          res.json({
            status: "pending",
            nullifier,
            message: "Order stored; matched but settlement failed — will retry",
          });
          return;
        }
      }

      res.json({
        status: "pending",
        nullifier,
        message: "Order stored; waiting for counterparty",
      });
    } catch (err: unknown) {
      console.error("[authorize-orders] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }) as RequestHandler);

  // GET /api/authorize-orders/:nullifier — check order status
  if (readLimiter) router.get("/:nullifier", readLimiter);
  router.get("/:nullifier", ((req: Request, res: Response) => {
    const stored = authorizeOrders.get(req.params.nullifier);
    if (!stored) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.json({
      status: stored.status,
      submittedAt: stored.submittedAt,
      settleTxHash: stored.settleTxHash ?? null,
    });
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
function findMatch(incoming: StoredAuthorizeOrder): AuthorizeMatch | null {
  const inPs = incoming.order.publicSignals;
  for (const [, candidate] of lookupAuthorizeOrdersByCounterPair(inPs.sellToken, inPs.buyToken)) {
    if (candidate === incoming) continue;
    if (candidate.status !== "pending") continue;

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
    if (stored.status !== "pending") continue;
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
    const isPending = stored.status === "pending";
    const expired = Number(stored.order.publicSignals.expiry) < nowSeconds;

    // Skip "matched" orders — they're being settled on-chain right now
    if (stored.status === "matched") continue;

    // Purge: terminal states (settled/cancelled) or expired pending orders
    if (stored.status === "settled" || stored.status === "cancelled" || (isPending && expired)) {
      // Only decrement counter for expired pending orders.
      // Settled orders already had their counter decremented on settlement.
      if (isPending && expired && stored.pubKeyAx && stored.pubKeyAy) {
        decPubKeyCount(stored.pubKeyAx, stored.pubKeyAy);
      }
      // Cancel from shared orderbook if still listed (best-effort).
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
