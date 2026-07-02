/**
 * [R-3] Health check endpoint for k8s/load-balancer readiness probes.
 */

import { Router, Request, Response } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
import { createTtlSingleFlight } from "../lib/ttl-cache.js";

const startedAt = Date.now();

// The deep check does an `eth_getBlockNumber` + a DB write per call.
// `/health` is unauthenticated and hit frequently by k8s/LB probes by
// design, so a hard rate limit would break those probes; instead the
// result is cached briefly (single-flight) so a burst of probes — or a
// flood — collapses to at most one RPC + DB write per window rather than
// amplifying into the relayer's metered RPC quota.
const HEALTH_TTL_MS = 3_000;

interface HealthResult {
  healthy: boolean;
  checks: Record<string, "ok" | "error">;
}

export function createHealthRoutes(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
): Router {
  const router = Router();

  const getHealth = createTtlSingleFlight(HEALTH_TTL_MS, async (): Promise<HealthResult> => {
    const checks: Record<string, "ok" | "error"> = {};
    let healthy = true;

    // 1. RPC provider connectivity
    try {
      await submitter.getProvider().getBlockNumber();
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

    return { healthy, checks };
  });

  router.get("/", async (_req: Request, res: Response) => {
    const result = await getHealth();

    res.status(result.healthy ? 200 : 503).json({
      status: result.healthy ? "healthy" : "degraded",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      checks: result.checks,
    });
  });

  return router;
}
