import { Router } from "express";
import type { RequestHandler } from "express";
import type { SharedOrderbook } from "../core/orderbook.js";
import type { OrderBroadcaster } from "../core/broadcaster.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertSafeOutboundUrl, UnsafeUrlError } from "../lib/url-guard.js";

export function createRelayerRoutes(
  orderbook: SharedOrderbook,
  broadcaster: OrderBroadcaster,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
  relayerWriteLimiter?: RequestHandler,
): Router {
  const router = Router();

  /**
   * POST /api/relayers/register — Register or update relayer
   * Body: { name?: string }
   * Requires relayer authentication.
   */
  const registerMiddleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) registerMiddleware.push(relayerWriteLimiter);
  router.post("/register", ...registerMiddleware, async (req, res) => {
    try {
      const { relayerAddress, relayerUrl } = req as AuthenticatedRequest;
      const name = req.body.name as string | undefined;

      // SSRF guard — see /api/orders for context. Reject before the
      // address is admitted into the registry so cross-relayer matchers
      // never see a private-IP URL.
      try {
        await assertSafeOutboundUrl(relayerUrl);
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          res.status(400).json({ error: `unsafe relayer URL: ${e.message}` });
          return;
        }
        throw e;
      }

      const info = orderbook.registerRelayer(relayerAddress, relayerUrl, name);

      broadcaster.broadcast({
        type: "relayer:registered",
        relayer: relayerAddress,
        url: relayerUrl,
      });

      res.json(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/relayers/heartbeat — Heartbeat (keep-alive)
   * Requires relayer authentication.
   */
  const heartbeatMiddleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) heartbeatMiddleware.push(relayerWriteLimiter);
  router.post("/heartbeat", ...heartbeatMiddleware, (req, res) => {
    const { relayerAddress } = req as AuthenticatedRequest;
    const ok = orderbook.heartbeat(relayerAddress);
    if (!ok) {
      res.status(404).json({ error: "relayer not registered" });
      return;
    }
    res.json({ status: "ok", relayer: relayerAddress });
  });

  /**
   * GET /api/relayers — List active relayers
   */
  router.get("/", readLimiter, (req, res) => {
    const relayers = orderbook.getActiveRelayers();
    res.json({
      relayers: relayers.map(r => ({
        address: r.address,
        url: r.url,
        name: r.name,
        orderCount: r.orderCount,
        lastHeartbeat: r.lastHeartbeat,
      })),
      count: relayers.length,
    });
  });

  /**
   * GET /api/relayers/:address — Get specific relayer info
   */
  router.get("/:address", readLimiter, (req, res) => {
    const info = orderbook.getRelayer(req.params.address);
    if (!info) {
      res.status(404).json({ error: "relayer not found" });
      return;
    }
    res.json(info);
  });

  return router;
}
