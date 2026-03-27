import { Router, Request, Response } from "express";
import { Orderbook } from "../core/orderbook.js";

export function createOrderbookRoutes(orderbook: Orderbook): Router {
  const router = Router();

  // GET /api/orderbook/:pair — get orderbook for a pair (e.g., "0xTokenA-0xTokenB")
  router.get("/:pair", (req: Request, res: Response) => {
    const pair = req.params.pair.toLowerCase();

    const sells = orderbook.getSellOrders(pair).map((o) => ({
      maker: o.order.maker,
      sellAmount: o.order.sellAmount.toString(),
      buyAmount: o.order.buyAmount.toString(),
    }));

    const buys = orderbook.getBuyOrders(pair).map((o) => ({
      maker: o.order.maker,
      sellAmount: o.order.sellAmount.toString(),
      buyAmount: o.order.buyAmount.toString(),
    }));

    res.json({ pair, sells, buys });
  });

  return router;
}
