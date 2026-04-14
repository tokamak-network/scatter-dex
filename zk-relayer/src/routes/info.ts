import { Router, Request, Response } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { config } from "../config.js";
import { authorizeOrders } from "./authorize-orders.js";

export function createInfoRoutes(submitter: PrivateSubmitter): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "ScatterDEX ZK Relayer",
      version: "0.1.0",
      address: submitter.getAddress(),
      fee: config.relayerFee,
      // Counts pending authorize orders. The legacy private_orders Map was
      // retired (tracker #29) — its `orderCount` was always 0 anyway.
      orderCount: authorizeOrders.size,
      commitmentPool: config.commitmentPoolAddress,
      privateSettlement: config.privateSettlementAddress,
    });
  });

  /**
   * GET /api/info/merkle-proof?leafIndex=42
   * Returns the Merkle proof for a commitment leaf in the on-chain tree.
   * Used by the frontend to generate authorize proofs without downloading
   * all commitment leaves. Falls back to on-chain query if relayer is unavailable.
   */
  router.get("/merkle-proof", async (req: Request, res: Response) => {
    try {
      const leafIndex = Number(req.query.leafIndex);
      if (!Number.isFinite(leafIndex) || leafIndex < 0) {
        res.status(400).json({ error: "Invalid leafIndex" });
        return;
      }
      const proof = await submitter.getCommitmentMerkleProof(leafIndex);
      res.json(proof);
    } catch (err) {
      console.error("[info] Failed to get merkle proof:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Failed to compute merkle proof" });
    }
  });

  return router;
}
