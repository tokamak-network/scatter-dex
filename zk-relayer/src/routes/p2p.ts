import { Router } from "express";
import { verifyMessage } from "ethers";
import type { OrderSummary } from "../core/shared-orderbook-client.js";

/**
 * P2P order exchange routes — enables direct relayer-to-relayer communication.
 *
 * When the shared orderbook server is down, relayers fall back to P2P mode:
 * they POST order summaries directly to each other's /api/p2p/orders endpoint.
 *
 * Steam analogy: two Steam bots can trade directly via Trade Offers without
 * needing the marketplace site to be online.
 */
export function createP2PRoutes(
  onRemoteOrder: (order: OrderSummary) => void,
  onRemoteCancel: (orderId: string) => void,
): Router {
  const router = Router();

  // Auth: verify relayer signature with method+path binding (matches client format)
  function verifyRelayerAuth(req: import("express").Request): boolean {
    const address = req.headers["x-relayer-address"] as string | undefined;
    const signature = req.headers["x-relayer-signature"] as string | undefined;
    const timestamp = req.headers["x-relayer-timestamp"] as string | undefined;
    if (!address || !signature || !timestamp) return false;

    const ts = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(ts) || Math.abs(now - ts) > 300) return false;

    try {
      const method = req.method.toUpperCase();
      const path = req.originalUrl.split("?")[0];
      const relayerUrl = (req.headers["x-relayer-url"] as string) || "";
      const message = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}`;
      const recovered = verifyMessage(message, signature);
      return recovered.toLowerCase() === address.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * POST /api/p2p/orders — Receive order summary from peer relayer
   */
  router.post("/orders", (req, res) => {
    if (!verifyRelayerAuth(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const raw = req.body;
      if (!raw || typeof raw !== "object") {
        res.status(400).json({ error: "invalid request body" });
        return;
      }
      // Validate all required OrderSummary fields
      const required = ["id", "relayer", "relayerUrl", "nonce", "sellToken", "buyToken",
        "sellAmount", "buyAmount", "minFillAmount", "maxFee", "expiry", "createdAt"] as const;
      for (const field of required) {
        if (raw[field] === undefined || raw[field] === null || raw[field] === "") {
          res.status(400).json({ error: `missing field: ${field}` });
          return;
        }
      }
      // Verify the order's relayer matches the authenticated peer
      const peerAddress = (req.headers["x-relayer-address"] as string).toLowerCase();
      if (raw.relayer?.toLowerCase() !== peerAddress) {
        res.status(403).json({ error: "order relayer does not match peer identity" });
        return;
      }
      onRemoteOrder(raw as OrderSummary);
      res.json({ status: "received" });
    } catch {
      res.status(400).json({ error: "invalid request" });
    }
  });

  /**
   * DELETE /api/p2p/orders/:id — Peer notifies order cancellation
   * Only the owning relayer can cancel (order ID format: "{relayerAddress}-{nonce}")
   */
  router.delete("/orders/:id", (req, res) => {
    if (!verifyRelayerAuth(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const peerAddress = (req.headers["x-relayer-address"] as string);

    // Verify the peer owns this order (ID starts with their address)
    const orderId = req.params.id;
    if (!orderId.startsWith(peerAddress.toLowerCase() + "-")) {
      res.status(403).json({ error: "cannot cancel another relayer's order" });
      return;
    }

    onRemoteCancel(orderId);
    res.json({ status: "cancelled" });
  });

  return router;
}
