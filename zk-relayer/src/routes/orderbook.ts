import { Router, Request, Response } from "express";
import type { PrivateOrderbook } from "../core/orderbook.js";

export function createOrderbookRoutes(orderbook: PrivateOrderbook): Router {
  const router = Router();

  // GET /api/private-orderbook — orderbook summary (no sensitive info)
  router.get("/", (_req: Request, res: Response) => {
    // We don't expose individual orders for privacy.
    // Just report the total pending count.
    res.json({
      totalOrders: orderbook.getOrderCount(),
    });
  });

  return router;
}
