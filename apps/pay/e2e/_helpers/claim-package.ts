import fs from "node:fs";
import path from "node:path";

/**
 * Build a syntactically valid v1 ClaimPackage for live-stack /claim
 * specs. The package passes `isClaimPackage` in
 * `packages/sdk/src/notes/claimPackage.ts` so the /claim page enters
 * its happy-path render — but it is NOT backed by a real settled
 * claims group on anvil. Specs that need the actual claim tx to
 * land have to set up the group via a separate scatterDirect helper
 * (substantial; tracked as a follow-up). This helper covers
 * everything before the on-chain probe: parsing, header copy,
 * recipient-match gating, relayer-availability badge.
 *
 * Why not encode the package here too? The /claim page calls
 * `decodeClaimPackage(fragment)`, and Pay's encoder is the same one
 * the spec needs to match — duplicating it here would drift. Re-use
 * the SDK's encoder via a base64url-roundable JSON.stringify; we
 * encode inline with `Buffer.from(json).toString("base64url")` to
 * avoid pulling the SDK barrel into the spec's bundle.
 */

const ANVIL_USDC_DEFAULT = "0x610178dA211FEF7D417bC0e6FeD39F05609AD788";

export interface ClaimPackageFixtureOptions {
  /** Recipient EOA — must match the wallet the spec installs so the
   *  /claim page's "you are the recipient" gate clears. */
  recipient: string;
  /** Settlement contract address. Defaults to the env-resolved
   *  PrivateSettlement that start-e2e-env.sh writes to .env.local. */
  settlementAddress?: string;
  /** Token address. Defaults to USDC from .env.local. */
  token?: string;
  /** Release timestamp (Unix seconds). Defaults to 1 hour in the
   *  past so the page's `isAvailable` branch renders ✓ Available. */
  releaseTimeUnix?: number;
  /** Decimal amount in the token's smallest unit. Defaults to
   *  "1000000" — 1 USDC at 6 decimals. */
  amountRaw?: string;
  /** Optional relayer URL — sets the gasless-claim button. Pass
   *  the dev relayer-A URL for specs exercising the gasless badge;
   *  omit for the self-pay-only render. */
  relayerUrl?: string;
}

let cachedEnv: Record<string, string> | null = null;
function readEnvLocal(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    cachedEnv = {};
    return cachedEnv;
  }
  const txt = fs.readFileSync(envPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*["']?([^"'\s#]+)["']?/);
    if (m) out[m[1]] = m[2];
  }
  cachedEnv = out;
  return out;
}

function envLookup(name: string): string | undefined {
  return process.env[name] ?? readEnvLocal()[name];
}

/** Base64url encode (no padding) — matches `encodeClaimPackage` in
 *  `packages/sdk/src/notes/claimPackage.ts`. */
function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Produce a `?id=…#<fragment>` claim URL pointing at /claim. The
 *  fragment encodes a v1 ClaimPackage with the supplied recipient
 *  and reasonable defaults for the on-chain bits. The pathElements /
 *  pathIndices are filled with valid-shape decimal strings — the
 *  proof generator will reject them at submit time, but every UI
 *  surface up to the wallet-connect → claim-button flow renders. */
export function buildClaimUrlFragment(opts: ClaimPackageFixtureOptions): {
  href: string;
  fragment: string;
} {
  const settlement =
    opts.settlementAddress
    ?? envLookup("NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT");
  if (!settlement) {
    throw new Error(
      "buildClaimUrlFragment: NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT not set — " +
        "boot start-e2e-env.sh so apps/pay/.env.local is populated.",
    );
  }
  const token = opts.token ?? envLookup("NEXT_PUBLIC_PAY_USDC") ?? ANVIL_USDC_DEFAULT;
  const releaseTime = String(opts.releaseTimeUnix ?? Math.floor(Date.now() / 1000) - 3600);

  // Tier-16 depth = 4 — the smallest claim tier `CLAIMS_PATH_LENS`
  // accepts. Random-looking-but-decimal strings; the page accepts
  // any decimal-valid path element.
  const depth = 4;
  const pathElements = Array.from(
    { length: depth },
    (_, i) => String(BigInt(`0x${(0xdead + i).toString(16)}`)),
  );
  const pathIndices = Array.from({ length: depth }, () => 0);

  const pkg = {
    version: 1,
    chainId: Number(envLookup("NEXT_PUBLIC_PAY_CHAIN_ID") ?? 31337),
    settlementAddress: settlement,
    claimsRoot: "0x" + "1".repeat(64),
    recipient: opts.recipient,
    token,
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    amount: opts.amountRaw ?? "1000000",
    releaseTime,
    secret: "12345678901234567890",
    leafIndex: 0,
    pathElements,
    pathIndices,
    ...(opts.relayerUrl ? { relayerUrl: opts.relayerUrl } : {}),
  };

  const fragment = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(pkg)),
  );
  const href = `/claim?id=fixture#${fragment}`;
  return { href, fragment };
}
