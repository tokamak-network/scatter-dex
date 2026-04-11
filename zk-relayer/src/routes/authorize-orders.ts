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

/**
 * [R-6] In-memory cache backed by SQLite. On startup, pending orders
 * are reloaded from DB so they survive relayer restarts.
 */
const authorizeOrders = new Map<string, StoredAuthorizeOrder>();
const MAX_AUTHORIZE_ORDERS = 10_000;
let _db: PrivateOrderDB | null = null;

export function createAuthorizeOrderRoutes(
  submitter: AuthorizeSubmitter,
  writeLimiter?: RequestHandler,
  relayerAddress?: string,
  readLimiter?: RequestHandler,
  db?: PrivateOrderDB,
): Router {
  // [R-6] Persist authorize orders to SQLite
  if (db) {
    _db = db;
    const rows = db.loadPendingAuthorizeOrders();
    for (const row of rows) {
      authorizeOrders.set(row.nullifier, {
        order: JSON.parse(row.orderJson),
        status: row.status as StoredAuthorizeOrder["status"],
        submittedAt: row.submittedAt,
        pubKeyAx: row.pubKeyAx,
        pubKeyAy: row.pubKeyAy,
        settleTxHash: row.settleTx ?? undefined,
      });
    }
    if (rows.length > 0) {
      console.log(`[R-6] Restored ${rows.length} pending authorize orders from DB`);
    }
  }
  const router = Router();

  // POST /api/authorize-orders — submit a Half-proof order
  if (writeLimiter) router.post("/", writeLimiter);
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

      // ── 5. Store the order ──
      const stored: StoredAuthorizeOrder = {
        order,
        status: "pending",
        submittedAt: nowSeconds,
        pubKeyAx: pubKeyAx ?? null,
        pubKeyAy: pubKeyAy ?? null,
      };
      authorizeOrders.set(nullifier, stored);
      _db?.saveAuthorizeOrder(nullifier, "pending", nowSeconds, JSON.stringify(order), pubKeyAx, pubKeyAy);

      console.log(
        `[authorize-orders] New order: sell=${order.publicSignals.sellToken} ` +
        `buy=${order.publicSignals.buyToken} ` +
        `amount=${order.publicSignals.sellAmount} ` +
        `nullifier=${nullifier.slice(0, 18)}...` +
        (pubKeyAx ? ` pubKey=${pubKeyAx.slice(0, 12)}...` : ""),
      );

      // ── 5. Try to match ──
      const match = findMatch(stored);
      if (match) {
        console.log("[authorize-orders] Match found! Submitting settleAuth...");
        try {
          // Mark both as matched
          match.maker.status = "matched";
          match.taker.status = "matched";

          // Submit on-chain (fee = 0 for now; configurable in follow-up)
          const txHash = await submitter.submitAuthSettle(match, 0n);

          // Mark both as settled
          match.maker.status = "settled";
          match.maker.settleTxHash = txHash;
          match.taker.status = "settled";
          match.taker.settleTxHash = txHash;
          _db?.updateAuthorizeOrderStatus(match.maker.order.publicSignals.nullifier, "settled", txHash);
          _db?.updateAuthorizeOrderStatus(match.taker.order.publicSignals.nullifier, "settled", txHash);

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

/**
 * Find a matching counterparty for the given order among pending
 * authorize orders. Uses the same token/price compatibility checks
 * as settleAuth on-chain (steps 3 and 4).
 *
 * This is a basic O(n) scan — sufficient for an MVP. A production
 * deployment would use the pair-indexed orderbook from orderbook.ts.
 */
function findMatch(incoming: StoredAuthorizeOrder): AuthorizeMatch | null {
  const inPs = incoming.order.publicSignals;

  for (const [, candidate] of authorizeOrders) {
    if (candidate === incoming) continue;
    if (candidate.status !== "pending") continue;

    const cPs = candidate.order.publicSignals;

    // Convention: the existing order is maker, the incoming is taker.
    // isTokenCompatible is symmetric (A.sell==B.buy ∧ B.sell==A.buy),
    // so only one call is needed.
    if (!isTokenCompatible(cPs, inPs)) continue;

    // Price compatibility (same as settleAuth step 4)
    if (!isPriceCompatible(cPs, inPs)) continue;

    return {
      maker: candidate,
      taker: incoming,
    };
  }

  return null;
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
    const expired = Number(stored.order.publicSignals.expiry) < nowSeconds;
    if (stored.status !== "pending" || expired) {
      authorizeOrders.delete(key);
      removed++;
    }
  }
  // [R-6] Also purge from DB
  _db?.purgeNonPendingAuthorizeOrdersDB();
  return removed;
}
