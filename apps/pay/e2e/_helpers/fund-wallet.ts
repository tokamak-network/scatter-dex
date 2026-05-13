import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { DEV_STACK_ENDPOINTS } from "./stack";
import { ANVIL_DEFAULT } from "./test-wallet";
import { providerFor } from "./anvil-snapshot";

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
  /** Target balance as a decimal string ("100" → ensure recipient
   *  ends up with ≥100 tokens, scaled by the token's decimals at
   *  mint time). Defaults to "100" — comfortably covers a 1-USDC
   *  deposit run with slack. */
  amount?: string;
  signerKey?: string;
  rpcUrl?: string;
  tokenAddress?: string;
}

// Tolerate quoted values and trailing `# comment` blocks the same
// way standard .env loaders do, so an operator-edited file doesn't
// silently drop into the unknown-address fallback. The captured
// group stops at the first quote / whitespace / `#`.
const ENV_USDC_RE = /^NEXT_PUBLIC_PAY_USDC\s*=\s*["']?([^"'\s#]+)["']?/m;

let cachedUsdcFromFile: string | null | undefined;
function readUsdcFromEnvFile(): string | undefined {
  if (cachedUsdcFromFile !== undefined) return cachedUsdcFromFile ?? undefined;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    cachedUsdcFromFile = null;
    return undefined;
  }
  const txt = fs.readFileSync(envPath, "utf8");
  const match = txt.match(ENV_USDC_RE);
  cachedUsdcFromFile = match?.[1] ?? null;
  return cachedUsdcFromFile ?? undefined;
}

export async function fundUsdc(opts: FundWalletOptions): Promise<void> {
  // Mirror verifyTestWallet's resolution order: explicit arg →
  // process.env → .env.local file. Matters when CI sets
  // `NEXT_PUBLIC_PAY_USDC=…` directly without writing a file.
  const tokenAddress =
    opts.tokenAddress
    ?? process.env.NEXT_PUBLIC_PAY_USDC
    ?? readUsdcFromEnvFile();
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
    throw new Error(
      "fundUsdc: NEXT_PUBLIC_PAY_USDC not set — boot the stack so " +
        "start-e2e-env.sh writes apps/pay/.env.local first.",
    );
  }
  const rpcUrl = opts.rpcUrl ?? DEV_STACK_ENDPOINTS.rpcUrl;
  const provider = providerFor(rpcUrl);
  const signer = new ethers.Wallet(opts.signerKey ?? ANVIL_DEFAULT.privateKey, provider);
  const token = new ethers.Contract(tokenAddress, MOCK_TOKEN_ABI, signer);
  // ethers v6 returns `bigint` from `decimals()` in some build paths;
  // parseUnits' second arg accepts number | bigint but is typed as
  // `number` historically, so coerce explicitly to keep the call
  // robust across SDK versions.
  const decimals = Number(await token.decimals());
  const target = ethers.parseUnits(opts.amount ?? "100", decimals);
  const current: bigint = await token.balanceOf(opts.account);
  // Top-up semantics: ensure final balance ≥ target. Mint only the
  // difference so repeat calls don't keep stacking balance — the
  // previous version minted the full target each time, which made
  // the no-op check misleading and grew the balance unboundedly
  // across spec runs in the same anvil session.
  if (current >= target) return;
  const tx = await token.mint(opts.account, target - current);
  await tx.wait();
}
