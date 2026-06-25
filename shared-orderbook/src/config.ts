import "dotenv/config";
import { isAddress } from "ethers";

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

function envInt(key: string, fallback: string): number {
  const val = Number(env(key, fallback));
  if (Number.isNaN(val) || !Number.isFinite(val)) {
    throw new Error(`Invalid numeric env: ${key}`);
  }
  return val;
}

/** Per-chain RelayerRegistry wiring for the settlements membership gate. */
export interface RelayerRegistryChain {
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
}

/**
 * Parse RELAYER_REGISTRY_CHAINS — a JSON array of
 * `{ chainId, rpcUrl, registryAddress }`. Unset/empty → `[]`, which leaves the
 * settlements membership gate OFF (back-compat). Present-but-malformed throws
 * (fail-fast: a typo in a security gate's config must not silently disable it).
 */
function parseRegistryChains(raw: string | undefined): RelayerRegistryChain[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RELAYER_REGISTRY_CHAINS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("RELAYER_REGISTRY_CHAINS must be a JSON array");
  return parsed.map((c, i) => {
    const o = c as Record<string, unknown>;
    const chainId = Number(o?.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error(`RELAYER_REGISTRY_CHAINS[${i}].chainId must be a positive integer`);
    }
    const rpcUrl = typeof o?.rpcUrl === "string" ? o.rpcUrl.trim() : "";
    if (!rpcUrl) throw new Error(`RELAYER_REGISTRY_CHAINS[${i}].rpcUrl must be a non-empty string`);
    const registryAddress = typeof o?.registryAddress === "string" ? o.registryAddress.trim() : "";
    // Reject the zero address explicitly: it passes isAddress but every
    // isActiveRelayer call against it reverts, which the gate treats as an RPC
    // error and FAILS OPEN — silently disabling a gate the operator believes is
    // configured. Better to fail-fast at startup.
    if (!isAddress(registryAddress) || /^0x0{40}$/i.test(registryAddress)) {
      throw new Error(`RELAYER_REGISTRY_CHAINS[${i}].registryAddress must be a valid non-zero EVM address`);
    }
    return { chainId, rpcUrl, registryAddress };
  });
}

export const config = {
  port: envInt("PORT", "4000"),
  dbPath: env("DB_PATH", "shared-orderbook.db"),

  // Rate limiting
  writeRateLimit: envInt("WRITE_RATE_LIMIT", "60"),    // per minute per IP
  readRateLimit: envInt("READ_RATE_LIMIT", "300"),      // per minute per IP

  // CORS — explicit origin list required in production.
  // Default allows localhost dev ports; set CORS_ORIGINS=* to allow all (not recommended).
  // The 4001–4006 range matches `scripts/dev.sh`'s APP_PORTS dictionary
  // (pay / drop / pro / operators / admin / hub). Keep these two lists
  // in sync — dev.sh now passes CORS_ORIGINS explicitly when it starts
  // this server, so this default is mostly a safety net for ad-hoc
  // `npm run dev` runs from this directory without env vars.
  corsOrigins: (
    process.env.CORS_ORIGINS?.trim()
      ? process.env.CORS_ORIGINS.split(",")
      : [
          "http://localhost:3000", // frontend (legacy)
          "http://localhost:3002", // zk-relayer A
          "http://localhost:3003", // zk-relayer B
          "http://localhost:4001", // apps/pay
          "http://localhost:4002", // apps/drop
          "http://localhost:4003", // apps/pro
          "http://localhost:4004", // apps/operators
          "http://localhost:4005", // apps/admin
          "http://localhost:4006", // apps/hub
        ]
  ).map(s => s.trim()).filter(Boolean),

  // Webhook timeout (ms)
  webhookTimeout: envInt("WEBHOOK_TIMEOUT", "5000"),

  // Max orders per relayer
  maxOrdersPerRelayer: envInt("MAX_ORDERS_PER_RELAYER", "1000"),

  // Total max orders in memory
  maxOrders: envInt("MAX_ORDERS", "50000"),

  // Hard ceiling on stored settlement rows. POST /api/settlements is
  // relayer-signed but not registry-gated (any valid keypair passes), so
  // without a cap the table grows without bound — a disk DoS that also slows
  // the per-relayer aggregation reads which stream every matching row. The
  // periodic prune deletes the oldest rows (by server-stamped created_at) once
  // the count exceeds this. Sized well above expected testnet volume; operators
  // needing full history should archive off-box.
  maxSettlements: envInt("MAX_SETTLEMENTS", "200000"),

  // How many verify passes may fail to match a settlement row to an on-chain
  // event before it's treated as "verify-impossible" and quarantined out of
  // the active unverified set (verify-stats alerts + the verifier's re-scan).
  // Rows are only scanned once they're confirmation-deep (VERIFIER_BLOCK_SAFETY_MARGIN),
  // so a handful of misses means the tx genuinely never landed — not RPC lag.
  // Default 5 absorbs transient fetch flakiness before giving up.
  maxVerifyAttempts: envInt("MAX_VERIFY_ATTEMPTS", "5"),

  // Admin endpoints (verify-stats + KYC review). Static bearer token —
  // unset = disabled (the legacy / fallback path). We never default this to
  // a fixed value: an unset env must mean "off" or every default deployment
  // exposes the surface.
  adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,

  // Wallet-signature (SIWE) admin auth. Comma-separated allowlist of admin
  // EOA addresses; a signer must be on this list to mint a session. Empty =
  // SIWE disabled (challenge/session endpoints 404, only the static token
  // works). For local dev, set this to the anvil #0 deployer address.
  adminAddresses: (process.env.ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Relayer operator KYC onboarding (Stage 1). Uploaded liveness videos +
  // ID documents land under `kycUploadDir/<submissionId>/`. Kept out of the
  // repo (.gitignore) and wiped by `scripts/dev.sh`'s DB reset.
  kycUploadDir: env("KYC_UPLOAD_DIR", "kyc-uploads"),

  // Per-file upload ceiling for KYC submissions. A liveness video is the
  // largest piece; 25 MB covers a short clip without inviting abuse of the
  // public submit endpoint. Applied per file by multer.
  kycMaxFileBytes: envInt("KYC_MAX_FILE_BYTES", String(25 * 1024 * 1024)),

  // Require an EIP-191 wallet-ownership proof on POST /api/kyc/submit. The
  // endpoint is public, so without it anyone can submit (and overwrite the
  // pending row + burn disk for) any victim's wallet address. Secure by
  // default; set KYC_REQUIRE_WALLET_SIG=0 (or "false") only as a transition
  // window while the operators register form ships the matching signature.
  // Accept both "0" and "false" (case-insensitive) as off — "false" would
  // otherwise read as on and surprise an operator trying to disable it.
  kycRequireWalletSig: !["0", "false"].includes((process.env.KYC_REQUIRE_WALLET_SIG ?? "1").trim().toLowerCase()),

  // Per-chain RelayerRegistry wiring for the settlements membership gate
  // (A-3 follow-up). When non-empty, POST /api/settlements rejects a submitter
  // that isn't an active relayer on-chain. Empty (default) → gate off.
  relayerRegistryChains: parseRegistryChains(process.env.RELAYER_REGISTRY_CHAINS),
};
