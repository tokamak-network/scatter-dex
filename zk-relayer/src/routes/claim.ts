import { Router, Request, Response, RequestHandler } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";

export function createPrivateClaimRoutes(
  submitter: PrivateSubmitter,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  // POST /api/private-claim — gasless claim (relayer pays gas)
  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { proofA, proofB, proofC, claimsRoot, claimNullifier, amount, token, recipient, releaseTime } = req.body;

      if (!proofA || !proofB || !proofC || !claimsRoot || !claimNullifier || !amount || !token || !recipient || releaseTime === undefined) {
        res.status(400).json({ error: "missing required fields" });
        return;
      }

      // Validate hex strings
      for (const [name, val] of Object.entries({ claimsRoot, claimNullifier, token, recipient })) {
        if (typeof val !== "string" || !/^0x[0-9a-fA-F]+$/.test(val)) {
          res.status(400).json({ error: `${name} must be a hex string` });
          return;
        }
      }

      const txHash = await submitter.submitClaim({
        proofA: proofA.map(BigInt) as [bigint, bigint],
        proofB: proofB.map((row: string[]) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
        proofC: proofC.map(BigInt) as [bigint, bigint],
        claimsRoot,
        claimNullifier,
        amount: BigInt(amount),
        token,
        recipient,
        releaseTime: BigInt(releaseTime),
      });

      res.json({ status: "claimed", txHash });
    } catch (err: unknown) {
      console.error("gasless ZK claim failed:", err instanceof Error ? err.message : "unknown");
      res.status(500).json({ error: err instanceof Error ? err.message : "claim failed" });
    }
  });

  return router;
}
