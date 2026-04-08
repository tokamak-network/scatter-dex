import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { config } from "../config.js";

const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function claim(address token) external",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
];

export function createVaultRoutes(
  wallet: ethers.Wallet,
  writeLimiter?: RequestHandler,
): Router {
  const router = Router();

  if (!config.feeVaultAddress) {
    // FeeVault not configured — return empty routes
    router.get("/", (_req: Request, res: Response) => {
      res.json({ enabled: false, message: "FeeVault not configured" });
    });
    return router;
  }

  const provider = wallet.provider!;
  const vault = new ethers.Contract(config.feeVaultAddress, FEE_VAULT_ABI, wallet);
  const relayerAddress = wallet.address;

  // GET /api/vault — get vault info + relayer balances
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const [platformFeeBps, treasury] = await Promise.all([
        vault.platformFeeBps(),
        vault.treasury(),
      ]);

      // Get balances for whitelisted tokens from settlement
      const settlementAbi = ["function whitelistedTokens(address) view returns (bool)"];
      const settlement = new ethers.Contract(config.privateSettlementAddress, settlementAbi, provider);

      // Read token list from env (same format as frontend NEXT_PUBLIC_TOKENS)
      const tokenEntries = (process.env.TOKEN_LIST || "").split(",").filter(Boolean);
      const tokenBalances: { token: string; symbol: string; balance: string }[] = [];

      for (const entry of tokenEntries) {
        const [addr, symbol] = entry.split(":");
        if (!addr) continue;
        try {
          const bal = await vault.balances(relayerAddress, addr);
          tokenBalances.push({
            token: addr,
            symbol: symbol || addr.slice(0, 10),
            balance: bal.toString(),
          });
        } catch { /* skip */ }
      }

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

  // POST /api/vault/claim — claim fees for a specific token
  if (writeLimiter) router.post("/claim", writeLimiter);
  router.post("/claim", async (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
        res.status(400).json({ error: "token must be a valid address" });
        return;
      }

      const balance = await vault.balances(relayerAddress, token);
      if (balance === 0n) {
        res.status(400).json({ error: "No fees to claim for this token" });
        return;
      }

      const tx = await vault.claim(token);
      const receipt = await tx.wait();
      const txHash = receipt.hash ?? receipt.transactionHash;

      console.log(`FeeVault claim: ${txHash} (token: ${token}, balance: ${balance})`);
      res.json({ status: "claimed", txHash, balance: balance.toString() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("Vault claim failed:", msg);
      res.status(500).json({ error: `Claim failed: ${msg}` });
    }
  });

  return router;
}
