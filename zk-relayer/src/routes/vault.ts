import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { config } from "../config.js";
import { adminAuth } from "../middleware/admin-auth.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { createLogger } from "../core/logger.js";
import { parseTokenList } from "../lib/tokens.js";
import { createTtlSingleFlight } from "../lib/ttl-cache.js";

const log = createLogger("vault");

const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
  "function totalTracked(address token) view returns (uint256)",
];

const TOKEN_ENTRIES = parseTokenList(process.env.TOKEN_LIST);

export function createVaultRoutes(
  submitter: PrivateSubmitter,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  // FEE_VAULT_ADDRESS is required (requireEnv in config.ts)
  const provider = submitter.getWallet().provider!;
  const vault = new ethers.Contract(config.feeVaultAddress, FEE_VAULT_ABI, provider);
  const relayerAddress = submitter.getAddress();

  // GET /api/vault is public and unauthenticated, and each miss fans out
  // 2 + |TOKEN_LIST| `eth_call`s. Without throttling, a flood would exhaust
  // the relayer's metered RPC quota and stall indexing/settlement. Two
  // guards: this route is mounted behind `readLimiter` (index.ts), and the
  // on-chain snapshot is cached for a few seconds with single-flight
  // coalescing so concurrent misses collapse to one fan-out.
  const getSnapshot = createTtlSingleFlight(5_000, async () => {
    const [platformFeeBps, treasury] = await Promise.all([
      vault.platformFeeBps(),
      vault.treasury(),
    ]);
    const tokenBalances = (
      await Promise.all(
        TOKEN_ENTRIES.map(async ({ addr, symbol, decimals }) => {
          try {
            const bal = await vault.balances(relayerAddress, addr);
            return { token: addr, symbol, decimals, balance: bal.toString() };
          } catch { return null; }
        })
      )
    ).filter((b): b is NonNullable<typeof b> => b !== null);

    return {
      enabled: true,
      vaultAddress: config.feeVaultAddress,
      relayerAddress,
      platformFeeBps: Number(platformFeeBps),
      treasury,
      balances: tokenBalances,
    };
  });

  // GET /api/vault — vault info + relayer balances (public, read-only)
  router.get("/", async (_req: Request, res: Response) => {
    try {
      res.json(await getSnapshot());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      res.status(500).json({ error: `Failed to query vault: ${msg}` });
    }
  });

  // POST /api/vault/claim — claim fees (admin-only, uses tx mutex)
  if (writeLimiter) router.post("/claim", writeLimiter);
  router.post("/claim", adminAuth, async (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
        res.status(400).json({ error: "token must be a valid address" });
        return;
      }

      const txHash = await submitter.claimVaultFee(config.feeVaultAddress, token);
      res.json({ status: "claimed", txHash });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      log.error("Vault claim failed", { err: msg });
      if (msg.includes("No fees to claim")) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: `Claim failed: ${msg}` });
      }
    }
  });

  return router;
}
