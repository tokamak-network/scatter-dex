/**
 * [R-7] Admin API — runtime relayer management endpoints.
 *
 * All endpoints require x-admin-key header (timing-safe comparison).
 *
 * GET    /api/admin/status   — relayer status overview
 * GET    /api/admin/balance  — ETH balance of relayer wallet
 * PUT    /api/admin/fee      — change relayer fee (bps)
 * POST   /api/admin/pause    — pause order acceptance
 * POST   /api/admin/resume   — resume order acceptance
 * POST   /api/admin/drain    — cancel all pending orders
 */

import { Router, Request, Response, RequestHandler } from "express";
import { adminAuth } from "../middleware/admin-auth.js";
import { config } from "../config.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
import type { PrivateOrderbook } from "../core/orderbook.js";

/** Shared pause state — checked by order submission routes. */
let paused = false;

export function isPaused(): boolean {
  return paused;
}

export function createAdminRoutes(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
  orderbook: PrivateOrderbook,
  drainAuthorizeOrdersFn: () => number,
  getAuthorizeOrderStatsFn: () => { pending: number; matched: number; total: number },
  writeLimiter?: RequestHandler,
): Router {
  // Restore pause state from DB on startup
  const savedPause = db.getMeta("paused");
  if (savedPause === "true") {
    paused = true;
    console.log("[admin] Relayer is paused (restored from DB)");
  }

  const router = Router();

  // All admin routes require authentication
  router.use(adminAuth);

  // GET /api/admin/status — relayer overview
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const provider = submitter.getProvider();
      const wallet = submitter.getWallet();
      const ethBalance = await provider.getBalance(wallet.address);
      const stats = db.getRelayerStats();
      const authStats = getAuthorizeOrderStatsFn();

      res.json({
        paused,
        relayerAddress: submitter.getAddress(),
        feeBps: config.relayerFee,
        ethBalance: ethBalance.toString(),
        maxGasPriceGwei: config.maxGasPriceGwei,
        privateOrders: {
          pending: orderbook.pendingOrderCount,
        },
        authorizeOrders: authStats,
        stats: {
          totalOrders: stats.totalOrders,
          settledOrders: stats.settledOrders,
          successRate: stats.successRate,
          crossRelayerSettled: stats.crossRelayerSettled,
          avgSettleTimeMs: stats.avgSettleTimeMs,
          uptimeSince: stats.uptimeSince,
        },
        pendingTxs: db.getPendingTxs().length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      res.status(500).json({ error: `Failed to get status: ${msg}` });
    }
  });

  // GET /api/admin/balance — ETH balance details
  router.get("/balance", async (_req: Request, res: Response) => {
    try {
      const provider = submitter.getProvider();
      const wallet = submitter.getWallet();
      const [ethBalance, network] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getNetwork(),
      ]);

      res.json({
        address: wallet.address,
        ethBalance: ethBalance.toString(),
        chainId: Number(network.chainId),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      res.status(500).json({ error: `Failed to get balance: ${msg}` });
    }
  });

  // PUT /api/admin/fee — update relayer fee at runtime
  if (writeLimiter) router.put("/fee", writeLimiter);
  router.put("/fee", (req: Request, res: Response) => {
    const { feeBps } = req.body;
    if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      res.status(400).json({ error: "feeBps must be an integer between 0 and 10000" });
      return;
    }

    const oldFee = config.relayerFee;
    (config as { relayerFee: number }).relayerFee = feeBps;
    db.setMeta("relayerFee", feeBps.toString());

    console.log(`[admin] Fee changed: ${oldFee} → ${feeBps} bps`);
    res.json({ status: "updated", oldFeeBps: oldFee, newFeeBps: feeBps });
  });

  // POST /api/admin/pause — stop accepting new orders
  if (writeLimiter) router.post("/pause", writeLimiter);
  router.post("/pause", (_req: Request, res: Response) => {
    if (paused) {
      res.status(409).json({ error: "Relayer is already paused" });
      return;
    }
    paused = true;
    db.setMeta("paused", "true");
    console.log("[admin] Relayer PAUSED — new orders will be rejected");
    res.json({ status: "paused" });
  });

  // POST /api/admin/resume — start accepting new orders again
  if (writeLimiter) router.post("/resume", writeLimiter);
  router.post("/resume", (_req: Request, res: Response) => {
    if (!paused) {
      res.status(409).json({ error: "Relayer is not paused" });
      return;
    }
    paused = false;
    db.setMeta("paused", "false");
    console.log("[admin] Relayer RESUMED — accepting orders");
    res.json({ status: "resumed" });
  });

  // POST /api/admin/drain — cancel all pending orders
  if (writeLimiter) router.post("/drain", writeLimiter);
  router.post("/drain", (_req: Request, res: Response) => {
    // Drain private orders (legacy path)
    const privateRemoved = orderbook.cancelAll();

    // Drain authorize orders (half-proof path)
    const authRemoved = drainAuthorizeOrdersFn();

    console.log(`[admin] Drained orders: ${privateRemoved} private, ${authRemoved} authorize`);
    res.json({
      status: "drained",
      privateOrdersCancelled: privateRemoved,
      authorizeOrdersCancelled: authRemoved,
    });
  });

  return router;
}
