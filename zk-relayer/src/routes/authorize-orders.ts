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

/**
 * In-memory store for authorize orders. Keyed by nullifier (unique per
 * commitment spend). A production deployment would persist to SQLite.
 */
const authorizeOrders = new Map<string, StoredAuthorizeOrder>();

export function createAuthorizeOrderRoutes(
  submitter: AuthorizeSubmitter,
  writeLimiter?: RequestHandler,
  relayerAddress?: string,
): Router {
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

      // ── 3. Dedup by nullifier ──
      const nullifier = order.publicSignals.nullifier;
      if (authorizeOrders.has(nullifier)) {
        res.status(409).json({ error: "Order with this nullifier already exists" });
        return;
      }

      // ── 4. Store the order ──
      const stored: StoredAuthorizeOrder = {
        order,
        status: "pending",
        submittedAt: nowSeconds,
      };
      authorizeOrders.set(nullifier, stored);

      console.log(
        `[authorize-orders] New order: sell=${order.publicSignals.sellToken} ` +
        `buy=${order.publicSignals.buyToken} ` +
        `amount=${order.publicSignals.sellAmount} ` +
        `nullifier=${nullifier.slice(0, 18)}...`,
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
      const message = err instanceof Error ? err.message : String(err);
      console.error("[authorize-orders] Error:", message);
      res.status(500).json({ error: message });
    }
  }) as RequestHandler);

  // GET /api/authorize-orders/:nullifier — check order status
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
  router.delete("/:nullifier", ((req: Request, res: Response) => {
    const stored = authorizeOrders.get(req.params.nullifier);
    if (!stored) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (stored.status !== "pending") {
      res.status(400).json({ error: `Cannot cancel order in '${stored.status}' status` });
      return;
    }
    stored.status = "cancelled";
    res.json({ status: "cancelled" });
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

    // Token compatibility (same as settleAuth step 3)
    if (!isTokenCompatible(inPs, cPs) && !isTokenCompatible(cPs, inPs)) continue;

    // Determine which side is maker (the existing order) and taker (the incoming)
    // Convention: the first order to arrive is maker, the incoming is taker.
    const makerPs = cPs;
    const takerPs = inPs;

    // Check token compatibility in the maker/taker direction
    if (!isTokenCompatible(makerPs, takerPs)) continue;

    // Price compatibility (same as settleAuth step 4)
    if (!isPriceCompatible(makerPs, takerPs)) continue;

    return {
      maker: candidate,
      taker: incoming,
    };
  }

  return null;
}
