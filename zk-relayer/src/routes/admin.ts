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
import { config, updateRelayerFee } from "../config.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
import type { PrivateOrderbook } from "../core/orderbook.js";

let paused = false;

export function isPaused(): boolean {
  return paused;
}

export interface AdminRouteDeps {
  submitter: PrivateSubmitter;
  db: PrivateOrderDB;
  orderbook: PrivateOrderbook;
  drainAuthorizeOrders: () => number;
  getAuthorizeOrderStats: () => { pending: number; matched: number; total: number };
  writeLimiter?: RequestHandler;
}

export function createAdminRoutes(deps: AdminRouteDeps): Router {
  const { submitter, db, orderbook, drainAuthorizeOrders: drainAuthFn, getAuthorizeOrderStats: getAuthStatsFn, writeLimiter } = deps;

  // Restore pause state from DB on startup
  const savedPause = db.getMeta("paused");
  paused = savedPause === "true";
  if (paused) {
    console.log("[admin] Relayer is paused (restored from DB)");
  }

  const router = Router();
  const wl = writeLimiter ? [writeLimiter] : [];

  router.use(adminAuth);

  // GET /api/admin/status — relayer overview
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const wallet = submitter.getWallet();
      const ethBalancePromise = submitter.getProvider().getBalance(wallet.address);
      const stats = db.getRelayerStats();
      const authStats = getAuthStatsFn();
      const ethBalance = await ethBalancePromise;

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

  router.put("/fee", ...wl, (req: Request, res: Response) => {
    const { feeBps } = req.body;
    if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      res.status(400).json({ error: "feeBps must be an integer between 0 and 10000" });
      return;
    }

    const oldFee = config.relayerFee;
    updateRelayerFee(feeBps);
    db.setMeta("relayerFee", feeBps.toString());

    console.log(`[admin] Fee changed: ${oldFee} → ${feeBps} bps`);
    res.json({ status: "updated", oldFeeBps: oldFee, newFeeBps: feeBps });
  });

  router.post("/pause", ...wl, (_req: Request, res: Response) => {
    if (paused) {
      res.status(409).json({ error: "Relayer is already paused" });
      return;
    }
    paused = true;
    db.setMeta("paused", "true");
    console.log("[admin] Relayer PAUSED — new orders will be rejected");
    res.json({ status: "paused" });
  });

  router.post("/resume", ...wl, (_req: Request, res: Response) => {
    if (!paused) {
      res.status(409).json({ error: "Relayer is not paused" });
      return;
    }
    paused = false;
    db.setMeta("paused", "false");
    console.log("[admin] Relayer RESUMED — accepting orders");
    res.json({ status: "resumed" });
  });

  router.post("/drain", ...wl, (_req: Request, res: Response) => {
    const privateRemoved = orderbook.cancelAll();
    const authRemoved = drainAuthFn();

    console.log(`[admin] Drained orders: ${privateRemoved} private, ${authRemoved} authorize`);
    res.json({
      status: "drained",
      privateOrdersCancelled: privateRemoved,
      authorizeOrdersCancelled: authRemoved,
    });
  });

  return router;
}
