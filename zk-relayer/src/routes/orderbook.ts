import { Router, Request, Response } from "express";
import type { PrivateOrderbook } from "../core/orderbook.js";

export function createOrderbookRoutes(orderbook: PrivateOrderbook): Router {
  const router = Router();

  // GET /api/private-orderbook — aggregated orderbook (no sensitive info)
  router.get("/", (_req: Request, res: Response) => {
    // Aggregate all pairs with order counts and best prices
    const pairs: Record<string, { sellCount: number; buyCount: number }> = {};

    // We don't expose individual orders for privacy.
    // Just report total pending count.
    res.json({
      totalOrders: orderbook.getOrderCount(),
    });
  });

  return router;
}
