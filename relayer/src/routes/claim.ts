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

      if (!secret || !recipient || !signature || deadline === undefined || relayerTip === undefined) {
        res.status(400).json({ error: "missing required fields (secret, recipient, relayerTip, deadline, signature)" });
        return;
      }

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
