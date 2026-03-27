import { Router, Request, Response } from "express";
import { Orderbook } from "../core/orderbook.js";
import { pairKey } from "../types/order.js";

export function createOrderbookRoutes(orderbook: Orderbook): Router {
  const router = Router();

  // GET /api/orderbook/:pair — get orderbook for a pair (e.g., "0xTokenA-0xTokenB")
  router.get("/:pair", (req: Request, res: Response) => {
    const pair = req.params.pair.toLowerCase();

    const sells = orderbook.getSellOrders(pair).map((o) => ({
      maker: o.order.maker,
      sellAmount: o.order.sellAmount.toString(),
      buyAmount: o.order.buyAmount.toString(),
      price: Number(o.order.sellAmount) / Number(o.order.buyAmount),
    }));

    const buys = orderbook.getBuyOrders(pair).map((o) => ({
      maker: o.order.maker,
      sellAmount: o.order.sellAmount.toString(),
      buyAmount: o.order.buyAmount.toString(),
      price: Number(o.order.buyAmount) / Number(o.order.sellAmount),
    }));

    res.json({ pair, sells, buys });
  });

  return router;
}
