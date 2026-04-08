import { Router, Request, Response, RequestHandler } from "express";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";

const HEX_RE = /^0x[0-9a-fA-F]+$/;

function validateProofArray(arr: unknown, name: string, len: number): string[] {
  if (!Array.isArray(arr) || arr.length !== len) {
    throw new Error(`${name} must be an array of ${len} elements`);
  }
  for (const v of arr) {
    if (typeof v !== "string" && typeof v !== "number") {
      throw new Error(`${name} elements must be strings or numbers`);
    }
  }
  return arr as string[];
}

export function createPrivateClaimRoutes(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
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

      // Validate proof structure
      const pA = validateProofArray(proofA, "proofA", 2);
      if (!Array.isArray(proofB) || proofB.length !== 2) {
        res.status(400).json({ error: "proofB must be a 2x2 array" });
        return;
      }
      const pB = proofB.map((row: unknown, i: number) => validateProofArray(row, `proofB[${i}]`, 2));
      const pC = validateProofArray(proofC, "proofC", 2);

      // Validate hex strings with expected byte lengths
      const hexChecks: [string, unknown, number][] = [
        ["claimsRoot", claimsRoot, 66],     // 0x + 64 hex = 32 bytes
        ["claimNullifier", claimNullifier, 66],
        ["token", token, 42],               // 0x + 40 hex = 20 bytes
        ["recipient", recipient, 42],
      ];
      for (const [name, val, expectedLen] of hexChecks) {
        if (typeof val !== "string" || !HEX_RE.test(val)) {
          res.status(400).json({ error: `${name} must be a hex string` });
          return;
        }
        if ((val as string).length !== expectedLen) {
          res.status(400).json({ error: `${name} must be ${expectedLen - 2} hex chars (${(expectedLen - 2) / 2} bytes)` });
          return;
        }
      }

      // Only pay gas for claims from orders this relayer settled (early reject)
      if (!db.hasSettledClaimsRoot(claimsRoot)) {
        res.status(403).json({ error: "claims root not settled by this relayer" });
        return;
      }

      // Validate BigInt-parsable
      let parsedAmount: bigint;
      let parsedReleaseTime: bigint;
      try {
        parsedAmount = BigInt(amount);
        parsedReleaseTime = BigInt(releaseTime);
      } catch {
        res.status(400).json({ error: "amount and releaseTime must be valid numbers" });
        return;
      }

      const txHash = await submitter.submitClaim({
        proofA: pA.map(BigInt) as [bigint, bigint],
        proofB: pB.map((row) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
        proofC: pC.map(BigInt) as [bigint, bigint],
        claimsRoot,
        claimNullifier,
        amount: parsedAmount,
        token,
        recipient,
        releaseTime: parsedReleaseTime,
      });

      res.json({ status: "claimed", txHash });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("gasless ZK claim failed:", msg);
      // Client errors (invalid proof, spent nullifier) → 400
      if (msg.includes("Invalid claim proof") || msg.includes("nullifier already spent")) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: "claim failed" });
      }
    }
  });

  return router;
}
