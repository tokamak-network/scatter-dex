import { Router, Request, Response } from "express";
import type { PrivateOrderbook } from "../core/orderbook.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { config } from "../config.js";

export function createInfoRoutes(
  orderbook: PrivateOrderbook,
  submitter: PrivateSubmitter,
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "ScatterDEX ZK Relayer",
      version: "0.1.0",
      address: submitter.getAddress(),
      fee: config.relayerFee,
      orderCount: orderbook.getOrderCount(),
      commitmentPool: config.commitmentPoolAddress,
      privateSettlement: config.privateSettlementAddress,
    });
  });

  return router;
}
