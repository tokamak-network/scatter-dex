import { Router, Request, Response, RequestHandler } from "express";
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

      if (!secret || !recipient || !signature) {
        res.status(400).json({ error: "missing required fields (secret, recipient, signature)" });
        return;
      }

      const txHash = await submitter.submitGaslessClaim({
        secret,
        recipient,
        relayerTip: relayerTip || "0",
        deadline: deadline || Math.floor(Date.now() / 1000) + 3600,
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
