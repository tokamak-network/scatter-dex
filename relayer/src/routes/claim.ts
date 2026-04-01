import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { Submitter } from "../core/submitter.js";

export function createClaimRoutes(
  submitter: Submitter,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { secret, recipient, relayerTip, deadline, signature, asEth } = req.body;

      if (!secret || !recipient || !signature || deadline === undefined || relayerTip === undefined) {
        res.status(400).json({ error: "missing required fields (secret, recipient, relayerTip, deadline, signature)" });
        return;
      }

      // Input validation
      if (!ethers.isAddress(recipient)) {
        res.status(400).json({ error: "recipient must be a valid Ethereum address" });
        return;
      }
      if (typeof secret !== "string" || !/^0x[0-9a-fA-F]+$/.test(secret)) {
        res.status(400).json({ error: "secret must be a hex string starting with 0x" });
        return;
      }
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        res.status(400).json({ error: "signature must be a hex string" });
        return;
      }
      if (typeof asEth !== "undefined" && typeof asEth !== "boolean") {
        res.status(400).json({ error: "asEth must be a boolean" });
        return;
      }

      // NOTE: relayerTip "0" is allowed by design. The relayer operator can
      // choose to accept or reject zero-tip claims via configuration or policy.
      const txHash = await submitter.submitGaslessClaim({
        secret,
        recipient,
        relayerTip,
        deadline,
        signature,
        asEth: !!asEth,
      });

      res.json({ status: "claimed", txHash });
    } catch (err: unknown) {
      console.error("gasless claim failed:", err instanceof Error ? err.message : "unknown");
      res.status(500).json({ error: err instanceof Error ? err.message : "gasless claim failed" });
    }
  });

  return router;
}
