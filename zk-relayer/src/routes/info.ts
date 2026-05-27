import { Router, Request, Response } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
import { config } from "../config.js";
import { authorizeOrders } from "./authorize-orders.js";
import { getProfile } from "../core/profile.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("info");

function countPending(): number {
  let n = 0;
  for (const o of authorizeOrders.values()) {
    if (o.status === "pending") n++;
  }
  return n;
}

export function createInfoRoutes(submitter: PrivateSubmitter, db: PrivateOrderDB): Router {
  const router = Router();

  // Cached chainId — read once from the provider on first request
  // and reused for every subsequent `/api/info` response. Avoids an
  // RPC roundtrip on the hot info path while still surfacing the
  // value clients (Pay/Pro discovery, the operator-register probe)
  // use to validate they're pointing at a relayer on the right
  // chain.
  let cachedChainId: number | null = null;
  async function chainId(): Promise<number | null> {
    if (cachedChainId !== null) return cachedChainId;
    try {
      const net = await submitter.getProvider().getNetwork();
      cachedChainId = Number(net.chainId);
      return cachedChainId;
    } catch (err) {
      log.warn("getNetwork() failed; chainId will be omitted from /api/info", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  router.get("/", async (_req: Request, res: Response) => {
    res.json({
      // `RELAYER_NAME` env distinguishes co-running relayers in the
      // same dev stack (Relayer-A / Relayer-B). Falls back to the
      // generic product name when the operator hasn't set one.
      name: config.relayerName ?? "ScatterDEX ZK Relayer",
      version: "0.1.0",
      // EVM chainId of the network this relayer is wired to. Cached
      // on first read so the hot info path doesn't fan out to RPC
      // on every request. Pay/Pro consumers cross-check this
      // against their own active network's chainId before routing
      // orders to the relayer; the operators register-page probe
      // surfaces a mismatch warning.
      chainId: await chainId(),
      address: submitter.getAddress(),
      fee: config.relayerFee,
      // Counts *pending* authorize orders only — `Map.size` would also
      // include matched/settled rows that haven't been purged yet, which
      // misrepresents the relayer's queue depth.
      orderCount: countPending(),
      commitmentPool: config.commitmentPoolAddress,
      privateSettlement: config.privateSettlementAddress,
      // Operator-set cosmetic metadata (name, description, logoUrl, ...).
      // Empty object when nothing has been configured.
      profile: getProfile(db),
      // Per-recipient claim-gasless reserve. Multiplied by the run's
      // recipient count and added to the service fee at settle time
      // — operators see a single combined "Relayer fee" line and the
      // proof's `maxFee` cap stretches to cover the sum. Empty when
      // the platform hasn't published a policy; in that case the Pay
      // wizard falls back to service-fee-only behavior (legacy).
      claim_fees: config.claimFees,
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
      log.error("Failed to get merkle proof", {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to compute merkle proof" });
    }
  });

  return router;
}
