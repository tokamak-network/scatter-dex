import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";

const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
  "function totalTracked(address token) view returns (uint256)",
];

// Parse token list once at module load (addr:symbol:decimals)
const TOKEN_ENTRIES = (process.env.TOKEN_LIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const parts = entry.split(":");
    return { addr: parts[0]?.trim(), symbol: parts[1]?.trim() || parts[0]?.slice(0, 10) || "?", decimals: parseInt(parts[2] || "18", 10) };
  })
  .filter((e) => e.addr);

/** Simple admin auth middleware using ADMIN_API_KEY env var. */
function adminAuth(req: Request, res: Response, next: () => void) {
  const key = config.adminApiKey;
  if (!key) {
    // No key configured — reject all admin requests
    res.status(403).json({ error: "Admin API key not configured on this relayer" });
    return;
  }
  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string") {
    res.status(401).json({ error: "Invalid admin API key" });
    return;
  }
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length !== key.length || !timingSafeEqual(providedBuf, key)) {
    res.status(401).json({ error: "Invalid admin API key" });
    return;
  }
  next();
}

export function createVaultRoutes(
  submitter: PrivateSubmitter,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  // FEE_VAULT_ADDRESS is required (requireEnv in config.ts)
  const provider = submitter.getWallet().provider!;
  const vault = new ethers.Contract(config.feeVaultAddress, FEE_VAULT_ABI, provider);
  const relayerAddress = submitter.getAddress();

  // GET /api/vault — vault info + relayer balances (public, read-only)
  router.get("/", async (_req: Request, res: Response) => {
    try {
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

      res.json({
        enabled: true,
        vaultAddress: config.feeVaultAddress,
        relayerAddress,
        platformFeeBps: Number(platformFeeBps),
        treasury,
        balances: tokenBalances,
      });
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
      console.error("Vault claim failed:", msg);
      if (msg.includes("No fees to claim")) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: `Claim failed: ${msg}` });
      }
    }
  });

  return router;
}
