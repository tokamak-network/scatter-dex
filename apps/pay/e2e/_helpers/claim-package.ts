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
 * Wire format matches `encodeClaimPackage` in the SDK exactly —
 * JSON.stringify → UTF-8 bytes → base64url (no padding, `+`→`-`,
 * `/`→`_`). We re-encode inline rather than importing the SDK
 * barrel to keep the spec's bundle small.
 */

const ANVIL_USDC_DEFAULT = "0x610178dA211FEF7D417bC0e6FeD39F05609AD788";

export interface ClaimPackageFixtureOptions {
  /** Recipient EOA — must match the wallet the spec installs so the
   *  /claim page's "you are the recipient" gate clears. */
  recipient: string;
  /** Chain ID baked into the package. Defaults to the env-resolved
   *  `NEXT_PUBLIC_PAY_CHAIN_ID` (31337 on dev). Override to a value
   *  that doesn't match the Pay build's chainId to exercise the
   *  /claim "wrong deployment" banner. */
  chainId?: number;
  /** Settlement contract address. Defaults to the env-resolved
   *  PrivateSettlement that start-e2e-env.sh writes to .env.local. */
  settlementAddress?: string;
  /** Token address. Defaults to USDC from .env.local. */
  token?: string;
  /** Display symbol the /claim page renders. Defaults to USDC for
   *  the env's MockToken USDC; override when pointing the fixture
   *  at a different token. */
  tokenSymbol?: string;
  /** Token decimals — defaults to 6 (USDC). Must match the on-chain
   *  decimals of `token` so the amount renders correctly. */
  tokenDecimals?: number;
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

// Standard `.env` line shape: KEY = "quoted value" # comment.
// Captures the value between the optional quotes, stopping at the
// closing quote (when present) or at the first whitespace / `#` —
// preserves any internal spaces a quoted value contains, unlike a
// greedy `\S+` that would truncate at the first space.
const ENV_LINE_RE = /^([A-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'\s#][^\s#]*))/;

/** Locate `apps/pay/.env.local`. start-e2e-env.sh writes it next to
 *  the Pay app, so the file location is stable. We try a few cwd-
 *  rooted candidates so an invocation from the monorepo root, the
 *  apps/pay directory, or anywhere underneath e2e/ all find it. We
 *  intentionally don't use `fileURLToPath(import.meta.url)` — the
 *  tsx loader Playwright runs under treats `import.meta` inconsistently
 *  across ESM/CJS contexts (see commit history of verify-wallet.ts),
 *  so cwd walks are the dependable cross-loader path. */
function envLocalPath(): string {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "apps/pay/.env.local"),
    path.resolve(process.cwd(), "../apps/pay/.env.local"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // Fall through to the cwd-rooted path — the read step will see
  // the absent file and return an empty map, and callers throw a
  // clear "NEXT_PUBLIC_PAY_* not set" message instead of crashing
  // on an unreachable absolute path.
  return candidates[0];
}

let cachedEnv: Record<string, string> | null = null;
function readEnvLocal(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  const envPath = envLocalPath();
  if (!fs.existsSync(envPath)) {
    cachedEnv = {};
    return cachedEnv;
  }
  const txt = fs.readFileSync(envPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(ENV_LINE_RE);
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4];
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
    chainId: opts.chainId ?? Number(envLookup("NEXT_PUBLIC_PAY_CHAIN_ID") ?? 31337),
    settlementAddress: settlement,
    claimsRoot: "0x" + "1".repeat(64),
    recipient: opts.recipient,
    token,
    tokenSymbol: opts.tokenSymbol ?? "USDC",
    tokenDecimals: opts.tokenDecimals ?? 6,
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
