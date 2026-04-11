/**
 * [R-3] Health check endpoint for k8s/load-balancer readiness probes.
 */

import { Router, Request, Response } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";

const startedAt = Date.now();

export function createHealthRoutes(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    const checks: Record<string, "ok" | "error"> = {};
    let healthy = true;

    // 1. RPC provider connectivity
    try {
      await (submitter.getProvider() as any).getBlockNumber();
      checks.rpc = "ok";
    } catch {
      checks.rpc = "error";
      healthy = false;
    }

    // 2. DB connectivity
    try {
      db.setMeta("health_check", Date.now().toString());
      checks.db = "ok";
    } catch {
      checks.db = "error";
      healthy = false;
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "degraded",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    });
  });

  return router;
}
