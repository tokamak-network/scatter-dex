import dotenv from "dotenv";
import { readFileSync } from "fs";
dotenv.config();

// Note: this module deliberately does NOT import the structured
// logger. logger.ts reads from `config` at module load, so wiring
// a logger here would create an init cycle that breaks under
// vitest's ESM loader. Config-load warnings stay on `console.warn`
// — they fire once at startup, before the logger ring buffer
// matters anyway.

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function loadPrivateKey(): string {
  // RELAYER_PRIVATE_KEY_FILE takes precedence (for Docker secrets / mounted files)
  const keyFile = process.env.RELAYER_PRIVATE_KEY_FILE;
  if (keyFile) {
    let key: string;
    try {
      key = readFileSync(keyFile, "utf-8").trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      throw new Error(`Cannot read RELAYER_PRIVATE_KEY_FILE (${keyFile}): ${msg}`);
    }
    if (!key) throw new Error(`RELAYER_PRIVATE_KEY_FILE (${keyFile}) is empty`);
    if (!key.startsWith("0x") || key.length !== 66) {
      throw new Error(`RELAYER_PRIVATE_KEY_FILE (${keyFile}): invalid key format (expected 0x-prefixed 64 hex chars)`);
    }
    return key;
  }
  return requireEnv("RELAYER_PRIVATE_KEY");
}

export const config = {
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  // EVM network this relayer trades on. Stamped onto orders / settlements
  // pushed to the (multi-network) shared orderbook and used to scope reads.
  // Defaults to Sepolia; validated (positive integer) like other numeric env.
  chainId: parseEnvInt("CHAIN_ID", 11155111, 1),
  // [R-4] Comma-separated fallback RPC URLs (optional)
  rpcUrlsFallback: (process.env.RPC_URLS_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean),
  relayerPrivateKey: loadPrivateKey(),
  commitmentPoolAddress: requireEnv("COMMITMENT_POOL_ADDRESS"),
  privateSettlementAddress: requireEnv("PRIVATE_SETTLEMENT_ADDRESS"),
  feeVaultAddress: requireEnv("FEE_VAULT_ADDRESS"),
  // Per-recipient claim-gasless reserve charged at settle time, on
  // top of the bps service fee. The platform sets this so all
  // relayers in the network charge the same per-token amount —
  // operators don't have to compare claim-fee schedules across
  // relayers. Read from `CLAIM_FEE_<SYMBOL>` env vars (e.g.
  // `CLAIM_FEE_USDC=0.05`). The Pay wizard reads this from
  // /api/info, multiplies by recipient count, and adds to the
  // service fee before computing the proof's `maxFee` cap.
  claimFees: parsePerTokenDecimalEnv("CLAIM_FEE_"),
  adminApiKey: (() => {
    const key = process.env.ADMIN_API_KEY;
    if (!key) return null;
    if (Buffer.byteLength(key, "utf8") < 32) throw new Error("ADMIN_API_KEY must be at least 32 bytes");
    return Buffer.from(key);
  })(),
  // Wallet-signature admin auth: the operator hits POST /api/admin/session
  // with a signed challenge, and the server verifies the recovered
  // address is `isActiveRelayer()` on this RelayerRegistry. Optional so
  // the API-key-only deploy path still boots; admin SIWE simply won't
  // be exposed when the var is missing. Set on operator deploys that
  // want the wallet flow.
  relayerRegistryAddress: process.env.RELAYER_REGISTRY_ADDRESS || null,
  relayerFee: parseInt(process.env.RELAYER_FEE || "30", 10),
  port: parseInt(process.env.PORT || "3002", 10),

  // Shared orderbook (optional — omit to run in local-only mode)
  sharedOrderbookUrl: process.env.SHARED_ORDERBOOK_URL || null,
  relayerPublicUrl: process.env.RELAYER_PUBLIC_URL || null,
  relayerName: process.env.RELAYER_NAME || undefined,

  // [R-10] Sanctions pubKey blocklist file (optional JSON array of {pubKeyAx, pubKeyAy})
  sanctionsPubKeyList: process.env.SANCTIONS_PUBKEY_LIST || null,

  // Stay this many blocks behind tip when indexing CommitmentInserted.
  // Trade-off: too low → reorgs invalidate cached roots; too high →
  // CommitmentPool's root ring buffer (default ROOT_HISTORY_SIZE=30)
  // can rotate the relayer's lagged root out before clients submit
  // proofs, causing on-chain `isKnownRoot` to fail. Pick the smallest
  // value that survives expected reorg depth on the target chain.
  // Anvil/fork: 0 (no reorgs). Post-merge L1: 1-2 is enough; 12 is
  // only safe when deposits-per-12-blocks << ROOT_HISTORY_SIZE.
  indexConfirmations: parseEnvInt("INDEX_CONFIRMATIONS", 0, 0),

  // Max blocks per `eth_getLogs` window when (re)scanning event history.
  // A restart re-scans from the deploy/INDEX_FROM_BLOCK in chunks of this
  // size; without chunking a single wide `queryFilter` exceeds the provider's
  // range cap (publicnode 50 000, Alchemy free 10) and crash-loops. Default
  // 10 000 is safe on publicnode; drop to 10 on Alchemy free.
  indexBlockRange: parseEnvInt("INDEX_BLOCK_RANGE", 10000, 1),

  // [R-1] Gas guard: max gas price in gwei.
  maxGasPriceGwei: parseEnvInt("MAX_GAS_PRICE_GWEI", 100, 1),

  // Optional outbound webhook (Slack/Discord/Telegram/...) for
  // operator alerts. Posts a JSON payload on health transitions
  // and other significant events. No retry queue — single POST
  // per event with a 5s timeout; missed alerts are logged but
  // not redelivered, so the channel must be reasonably available.
  webhookUrl: process.env.WEBHOOK_URL || null,

  // Number of consecutive terminal settlement failures (failed +
  // dead_letter) that trip a critical webhook alert. Reset to 0
  // on the next settled order. Only tripped once per streak so a
  // sustained outage doesn't repeatedly page the channel.
  settlementFailureThreshold: parseEnvInt("SETTLEMENT_FAILURE_THRESHOLD", 5, 1),

  // ETH balance below which the relayer wallet is considered low
  // and a warn alert is emitted (units: wei). Recovery alert fires
  // once the balance climbs back above the threshold. Default ≈
  // 0.05 ETH — enough headroom for several settlement txs at
  // typical L1 gas. Override with LOW_BALANCE_ETH (decimal ETH).
  lowBalanceWei: parseLowBalanceWei("LOW_BALANCE_ETH", "0.05"),

  // Tokens to monitor for FeeVault claim-reminder alerts.
  // Comma-separated 0x-prefixed addresses; an empty list disables
  // the monitor (default — operators opt in once they know which
  // fee tokens accrue meaningfully). Per-token alert thresholds
  // are configured via PUT /api/admin/claim-thresholds and stored
  // in relayer_meta, not here.
  feeClaimTokens: (process.env.FEE_CLAIM_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)),

  // Probe cadence for the claim monitor. 5 min default — claim
  // accruals move on the order of settled-trade frequency, so a
  // sub-minute probe would just thrash the RPC.
  feeClaimProbeIntervalMs: parseEnvInt(
    "FEE_CLAIM_PROBE_INTERVAL_MS",
    5 * 60_000,
    10_000,
  ),
};

/** Decimal-ETH env var → wei. Falls back on bad input with a warn. */
function parseLowBalanceWei(name: string, fallback: string): bigint {
  const raw = (process.env[name] ?? fallback).trim();
  if (/^[0-9]*\.?[0-9]+$/.test(raw)) {
    const [whole, frac = ""] = raw.split(".");
    const fracPadded = frac.slice(0, 18).padEnd(18, "0");
    return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
  }
  // Invalid env value — parse the fallback directly, never recurse
  // through `process.env[name]` again or we'd stack-overflow on a
  // permanently bad value.
  console.warn(`[config] Invalid ${name}="${raw}", using ${fallback} ETH`);
  const [whole, frac = ""] = fallback.split(".");
  const fracPadded = frac.slice(0, 18).padEnd(18, "0");
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
}

/** Scan `process.env` for `<prefix><SYMBOL>` keys and return a
 *  symbol→decimal-string map. Refuses negatives, hex, or junk so a
 *  typo in the operator's env doesn't silently degrade fee policy. */
function parsePerTokenDecimalEnv(prefix: string): Record<string, string> {
  const re = new RegExp(`^${prefix}([A-Z0-9]+)$`);
  const out: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const m = key.match(re);
    if (!m) continue;
    const value = (process.env[key] ?? "").trim();
    if (!value) continue;
    if (!/^\d+(\.\d+)?$/.test(value)) {
      throw new Error(`${key} must be a non-negative decimal (got "${value}")`);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Parse a non-negative integer env var with a default. Logs a warn and
 *  uses the default when the value is missing, non-numeric, or below `min`. */
function parseEnvInt(name: string, defaultValue: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    console.warn(`[config] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/** [R-7] Update relayer fee at runtime (admin API). */
export function updateRelayerFee(feeBps: number): void {
  config.relayerFee = feeBps;
}
