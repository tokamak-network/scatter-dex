import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { DEV_STACK_ENDPOINTS } from "./stack";

/**
 * Mint MockToken USDC to a test wallet so deposit-flow specs have
 * something to actually deposit. `DeployLocal` only mints to anvil
 * accounts #0-#4; the verified-wallet specs use anvil #5 (see PR
 * #727 for the per-account isolation rationale), which has zero
 * token balance by default.
 *
 * The MockToken's `mint` is intentionally unauthenticated so any
 * funded anvil key can top it up. Reads the USDC address from
 * `apps/pay/.env.local` the same way `verifyTestWallet` reads the
 * IdentityGate — keeps callers from threading addresses through
 * every spec.
 */

const MOCK_TOKEN_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export interface FundWalletOptions {
  account: string;
  /** Token amount as a decimal string ("100" → 100 tokens, scaled
   *  by the token's decimals at mint time). Defaults to "100"
   *  which comfortably covers a 1-USDC deposit run with slack. */
  amount?: string;
  signerKey?: string;
  rpcUrl?: string;
  tokenAddress?: string;
}

const ANVIL_DEFAULT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let cachedUsdcFromFile: string | null | undefined;
function readUsdcFromEnvFile(): string | undefined {
  if (cachedUsdcFromFile !== undefined) return cachedUsdcFromFile ?? undefined;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    cachedUsdcFromFile = null;
    return undefined;
  }
  const txt = fs.readFileSync(envPath, "utf8");
  const match = txt.match(/^NEXT_PUBLIC_PAY_USDC\s*=\s*(\S+)/m);
  cachedUsdcFromFile = match?.[1] ?? null;
  return cachedUsdcFromFile ?? undefined;
}

const providerCache = new Map<string, ethers.JsonRpcProvider>();
function providerFor(rpcUrl: string): ethers.JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new ethers.JsonRpcProvider(rpcUrl);
    providerCache.set(rpcUrl, p);
  }
  return p;
}

export async function fundUsdc(opts: FundWalletOptions): Promise<void> {
  const tokenAddress = opts.tokenAddress ?? readUsdcFromEnvFile();
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
    throw new Error(
      "fundUsdc: NEXT_PUBLIC_PAY_USDC not set — boot the stack so " +
        "start-e2e-env.sh writes apps/pay/.env.local first.",
    );
  }
  const rpcUrl = opts.rpcUrl ?? DEV_STACK_ENDPOINTS.rpcUrl;
  const provider = providerFor(rpcUrl);
  const signer = new ethers.Wallet(opts.signerKey ?? ANVIL_DEFAULT_KEY, provider);
  const token = new ethers.Contract(tokenAddress, MOCK_TOKEN_ABI, signer);
  const decimals: number = await token.decimals();
  const amount = ethers.parseUnits(opts.amount ?? "100", decimals);
  // No-op early if balance already covers the requested mint — keeps
  // back-to-back specs cheap.
  const current: bigint = await token.balanceOf(opts.account);
  if (current >= amount) return;
  const tx = await token.mint(opts.account, amount);
  await tx.wait();
}
