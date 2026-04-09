import { Router } from "express";
import type { RequestHandler } from "express";
import type { SharedOrderbook } from "../core/orderbook.js";

export function createStatsRoutes(
  orderbook: SharedOrderbook,
  readLimiter: RequestHandler,
): Router {
  const router = Router();

  /**
   * GET /api/stats — Orderbook statistics
   */
  router.get("/", readLimiter, (_req, res) => {
    res.json(orderbook.getStats());
  });

  return router;
}
