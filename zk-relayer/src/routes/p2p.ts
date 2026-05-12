import { createHash } from "crypto";
import { Router } from "express";
import { verifyMessage } from "ethers";
import type { OrderSummary } from "../types/order.js";
import { eqAddr } from "../lib/address.js";

const EMPTY_BODY_SHA256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function bodyHashOf(rawBody: Buffer | undefined): string {
  if (!rawBody || rawBody.length === 0) return EMPTY_BODY_SHA256;
  return "0x" + createHash("sha256").update(rawBody).digest("hex");
}
import type {
  AuthorizeTradeOfferRequest,
  AuthorizeTradeOfferResponse,
} from "../core/authorize-cross-relayer-matcher.js";

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
  // Slot retained for API stability; the Private-flow trade-offer
  // handler was retired with tracker #29. Optional so existing 2-arg
  // callers don't have to pass an explicit `undefined`.
  _onTradeOfferRetired?: undefined,
  onAuthorizeTradeOffer?: (offer: AuthorizeTradeOfferRequest, relayerAddress: string) => Promise<AuthorizeTradeOfferResponse>,
  /** Lookup the relayer address that posted `orderId`. Used by DELETE
   *  to verify the cancelling peer owns the order — replaces the old
   *  `{relayer}-{nonce}` ID-prefix check, which only worked for the
   *  retired Private flow's id format. Authorize ids are bytes32(nullifier)
   *  with no relayer prefix. */
  lookupOrderRelayer?: (orderId: string) => string | null,
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

    const method = req.method.toUpperCase();
    const path = req.originalUrl.split("?")[0];
    const relayerUrl = (req.headers["x-relayer-url"] as string) || "";
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const bodyHash = bodyHashOf(rawBody);

    // Try the body-bound message first, fall back to the legacy
    // (no body hash) shape for one release. Set REQUIRE_BODY_HASH=1
    // to disable the fallback once every peer is upgraded.
    const messageWithBody = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}:${bodyHash}`;
    try {
      if (eqAddr(verifyMessage(messageWithBody, signature), address)) return true;
    } catch {
      // fall through
    }
    if (process.env.REQUIRE_BODY_HASH === "1") return false;
    const messageLegacy = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}`;
    try {
      const ok = eqAddr(verifyMessage(messageLegacy, signature), address);
      if (ok) {
        console.warn(
          `[deprecated-body-hash] peer ${address} signed ${method} ${path} without body binding; upgrade peer.`,
        );
      }
      return ok;
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
      // Validate all required OrderSummary fields. `nonce` was here from
      // the retired Private flow's id format ({relayer}-{nonce}); not on
      // the canonical `OrderSummary` (packages/types) so authorize
      // summaries used to 400 here before the matcher could see them.
      const required = ["id", "relayer", "relayerUrl", "sellToken", "buyToken",
        "sellAmount", "buyAmount", "minFillAmount", "maxFee", "expiry", "createdAt"] as const;
      for (const field of required) {
        if (raw[field] === undefined || raw[field] === null || raw[field] === "") {
          res.status(400).json({ error: `missing field: ${field}` });
          return;
        }
      }
      // Verify the order's relayer matches the authenticated peer
      const peerAddress = req.headers["x-relayer-address"] as string;
      if (!eqAddr(raw.relayer, peerAddress)) {
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
   * Only the owning relayer can cancel.
   */
  router.delete("/orders/:id", (req, res) => {
    if (!verifyRelayerAuth(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const peerAddress = (req.headers["x-relayer-address"] as string).toLowerCase();
    const orderId = req.params.id;

    // Ownership check: look up who posted this order. The retired
    // {relayer}-{nonce} prefix scheme didn't work for authorize-flow
    // ids (bytes32 nullifier, no embedded relayer). If `lookupOrderRelayer`
    // wasn't wired we have no way to enforce ownership — fail closed
    // rather than silently accept arbitrary deletes (any authenticated
    // peer cancelling any order would be a regression vs the old
    // prefix check). If the order is in cache and matches the peer,
    // accept; if owner is unknown (`null`), treat as already-cancelled /
    // never-seen and 200 idempotently.
    if (!lookupOrderRelayer) {
      res.status(403).json({ error: "ownership verification not configured" });
      return;
    }
    // Defensive lowercase even though `RemoteOrderStore.getRelayer`
    // already normalises — guards against future callers that don't.
    const owner = lookupOrderRelayer(orderId)?.toLowerCase() ?? null;
    if (owner !== null && owner !== peerAddress) {
      res.status(403).json({ error: "cannot cancel another relayer's order" });
      return;
    }

    onRemoteCancel(orderId);
    res.json({ status: "cancelled" });
  });

  // POST /api/p2p/trade-offer (Private flow) was retired with tracker #29.
  // Authorize-flow trade offers use /api/p2p/authorize-trade-offer below.

  /**
   * POST /api/p2p/authorize-trade-offer — Authorize-flow counterpart of the
   * trade-offer endpoint. Receives a taker's pre-generated authorize proof,
   * looks up the local maker by nullifier, and calls settleAuth on-chain.
   */
  if (onAuthorizeTradeOffer) {
    router.post("/authorize-trade-offer", async (req, res) => {
      if (!verifyRelayerAuth(req)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const relayerAddress = (req.headers["x-relayer-address"] as string).toLowerCase();

      try {
        const offer = req.body as AuthorizeTradeOfferRequest;
        if (!offer || typeof offer !== "object") {
          res.status(400).json({ error: "request body must be a JSON object" });
          return;
        }
        if (!offer.makerNullifier || !offer.takerOrder) {
          res.status(400).json({ error: "missing required fields: makerNullifier, takerOrder" });
          return;
        }
        if (typeof offer.makerNullifier !== "string" || !/^0x[0-9a-f]{64}$/i.test(offer.makerNullifier)) {
          res.status(400).json({ error: "makerNullifier must be a 0x-prefixed 32-byte hex string" });
          return;
        }
        if (typeof offer.takerOrder !== "object" || offer.takerOrder === null || Array.isArray(offer.takerOrder)) {
          res.status(400).json({ error: "takerOrder must be an object" });
          return;
        }

        const result = await onAuthorizeTradeOffer(offer, relayerAddress);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        // Reserve "rejected" for validated-but-declined offers; use "error"
        // for the unexpected-exception path so the sending relayer can
        // distinguish network/infra failures from business rejects.
        res.status(500).json({ status: "error", reason: msg } satisfies AuthorizeTradeOfferResponse);
      }
    });
  }

  return router;
}
