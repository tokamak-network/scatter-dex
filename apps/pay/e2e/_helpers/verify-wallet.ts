import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { DEV_STACK_ENDPOINTS } from "./stack";
import { providerFor } from "./anvil-snapshot";

/**
 * Mark a test wallet as zk-X509 verified by writing directly to the
 * MockIdentityRegistry behind Pay's configured IdentityGate. Lets
 * live-stack specs that exercise post-gate surfaces (`/payouts/new`
 * wizard, claim flow, etc.) reach the actual wizard instead of
 * stopping at the `Verify your identity` modal.
 *
 * Reads `Pay`'s gate address from the same NEXT_PUBLIC_PAY_IDENTITY_GATE
 * env that the Next bundle does — so a stale `.env.local` would surface
 * here as an error instead of as a silently-unverified spec run. The
 * helper then calls `gate.getRegistries()[0]` to find the
 * MockIdentityRegistry, and writes `setVerified(account, true)` against
 * it. `setVerified` is intentionally public on the mock (no auth gate),
 * so any test wallet with anvil funds can flip its own status.
 *
 * Stays node-side — uses the same RPC URL the stack helpers point at
 * (default `http://127.0.0.1:8545`) so the test doesn't need to thread
 * a provider through Playwright's `page` context for this.
 */

const IDENTITY_GATE_ABI = [
  "function getRegistries() view returns (address[])",
];
const MOCK_IDENTITY_REGISTRY_ABI = [
  "function setVerified(address user, bool status) external",
  "function isVerified(address user) view returns (bool)",
];

export interface VerifyTestWalletOptions {
  /** The wallet that should appear verified to Pay. */
  account: string;
  /** Funded anvil key that submits the `setVerified` tx. The mock
   *  registry doesn't gate by caller, so any key works — defaulting
   *  to anvil #0 keeps callers from threading it through. */
  signerKey?: string;
  /** RPC URL the helper broadcasts against. Defaults to the same anvil
   *  port `DEV_STACK_ENDPOINTS` already documents. */
  rpcUrl?: string;
  /** IdentityGate address. Defaults to the env var Pay's `network.ts`
   *  reads, so a misconfigured `.env.local` fails loud at the test
   *  rather than producing an unverified-but-silent run. */
  gateAddress?: string;
}

const ANVIL_DEFAULT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Read `NEXT_PUBLIC_PAY_IDENTITY_GATE` from apps/pay/.env.local.
 *  Next loads `.env.local` for the dev server it boots, but the
 *  Playwright runner process itself doesn't — `process.env.NEXT_PUBLIC_*`
 *  is empty there even though the Pay frontend the browser hits is
 *  correctly configured. Parse the file directly so callers don't
 *  have to thread the gate address through every spec or wire up
 *  dotenv in `playwright.config.ts`. */
// `.env.local` doesn't change during a Playwright run, so cache the
// parse to keep verifyTestWallet's hot path from re-reading + regex-
// matching the file once per spec. Sentinel `null` distinguishes
// "tried and not found" from "not yet tried" (which is `undefined`).
let cachedGateFromFile: string | null | undefined;
function readGateFromEnvFile(): string | undefined {
  if (cachedGateFromFile !== undefined) return cachedGateFromFile ?? undefined;
  // Playwright runs from apps/pay (its `testDir: "./e2e"` is relative
  // to the package), so cwd-based lookup is stable across spec files
  // without needing `import.meta.url` (transpiler treats it
  // inconsistently across ESM/CJS). Caller-supplied `gateAddress`
  // remains the explicit escape hatch.
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    cachedGateFromFile = null;
    return undefined;
  }
  const txt = fs.readFileSync(envPath, "utf8");
  // Tolerate quoted values + trailing comments the same way standard
  // .env loaders do; operator-edited files shouldn't silently drop
  // into the unknown-gate fallback.
  const match = txt.match(/^NEXT_PUBLIC_PAY_IDENTITY_GATE\s*=\s*["']?([^"'\s#]+)["']?/m);
  cachedGateFromFile = match?.[1] ?? null;
  return cachedGateFromFile ?? undefined;
}

export async function verifyTestWallet(opts: VerifyTestWalletOptions): Promise<void> {
  const gateAddress =
    opts.gateAddress
    ?? process.env.NEXT_PUBLIC_PAY_IDENTITY_GATE
    ?? readGateFromEnvFile();
  if (!gateAddress || gateAddress === ethers.ZeroAddress) {
    throw new Error(
      "verifyTestWallet: NEXT_PUBLIC_PAY_IDENTITY_GATE not set — " +
        "start-e2e-env.sh writes it to apps/pay/.env.local after deploy; " +
        "if you're running tests directly, boot the stack first.",
    );
  }
  const rpcUrl = opts.rpcUrl ?? DEV_STACK_ENDPOINTS.rpcUrl;
  const provider = providerFor(rpcUrl);
  const gate = new ethers.Contract(gateAddress, IDENTITY_GATE_ABI, provider);
  const registries = await gate.getRegistries();
  if (!registries.length) {
    throw new Error(
      `verifyTestWallet: IdentityGate ${gateAddress} has no registries — ` +
        "Pay was deployed against a gate that isn't wired to a registry.",
    );
  }
  const wallet = new ethers.Wallet(opts.signerKey ?? ANVIL_DEFAULT_KEY, provider);
  const registry = new ethers.Contract(registries[0], MOCK_IDENTITY_REGISTRY_ABI, wallet);
  // No-op early if already verified — keeps repeated calls cheap
  // and avoids noisy "already true" event spam in the anvil log.
  if (await registry.isVerified(opts.account)) return;
  const tx = await registry.setVerified(opts.account, true);
  await tx.wait();
}
