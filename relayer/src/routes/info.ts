import { Router, Request, Response } from "express";
import { Orderbook } from "../core/orderbook.js";
import { Submitter } from "../core/submitter.js";
import { config } from "../config.js";

export function createInfoRoutes(
  orderbook: Orderbook,
  submitter: Submitter
): Router {
  const router = Router();

  // GET /api/info — relayer information
  router.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "ScatterDEX Relayer",
      version: "0.1.0",
      address: submitter.getAddress(),
      fee: config.relayerFee,
      orderCount: orderbook.getOrderCount(),
      settlement: config.settlementAddress,
    });
  });

  return router;
}
