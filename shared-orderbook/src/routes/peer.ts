import { Router } from "express";
import type { RequestHandler } from "express";
import type { SharedOrderbook } from "../core/orderbook.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";

/**
 * Peer discovery routes — enables P2P fallback when server is down.
 *
 * Each relayer can fetch the list of known peers (other relayers + their URLs).
 * If the shared orderbook server goes offline, relayers can use these cached
 * peer lists to communicate directly and exchange order summaries peer-to-peer.
 *
 * Steam analogy: even if the marketplace site goes down, bots that already
 * know each other can still trade directly via Steam Trade Offers.
 */
export function createPeerRoutes(
  orderbook: SharedOrderbook,
  readLimiter: RequestHandler,
): Router {
  const router = Router();

  /**
   * GET /api/peers — Get all registered relayer endpoints for P2P fallback
   * Returns addresses + URLs so relayers can cache peer info locally.
   * Requires relayer auth (only registered relayers can see peers).
   */
  router.get("/", readLimiter, relayerAuth, (req, res) => {
    const { relayerAddress } = req as AuthenticatedRequest;
    const relayers = orderbook.getActiveRelayers();

    // Exclude self from peer list
    const peers = relayers
      .filter(r => r.address !== relayerAddress)
      .map(r => ({
        address: r.address,
        url: r.url,
        name: r.name,
        orderCount: r.orderCount,
        lastHeartbeat: r.lastHeartbeat,
      }));

    res.json({ peers, count: peers.length });
  });

  return router;
}
