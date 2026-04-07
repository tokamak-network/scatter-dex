import { Router } from "express";
export function createOrderbookRoutes(orderbook) {
    const router = Router();
    // GET /api/orderbook/:pair — get orderbook for a pair (e.g., "0xTokenA-0xTokenB")
    router.get("/:pair", (req, res) => {
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
