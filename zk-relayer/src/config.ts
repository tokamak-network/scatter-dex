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
  // [R-4] Comma-separated fallback RPC URLs (optional)
  rpcUrlsFallback: (process.env.RPC_URLS_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean),
  relayerPrivateKey: loadPrivateKey(),
  commitmentPoolAddress: requireEnv("COMMITMENT_POOL_ADDRESS"),
  privateSettlementAddress: requireEnv("PRIVATE_SETTLEMENT_ADDRESS"),
  feeVaultAddress: requireEnv("FEE_VAULT_ADDRESS"),
  // Optional: address of the deployed `StealthTransferAccount` — the
  // delegate contract recipients use for gasless transfers via
  // EIP-7702. Unset disables the /api/transfer-7702 endpoint, so an
  // older operator deployment doesn't accidentally expose a
  // misconfigured route. Validate at startup: this address acts as
  // the allowlist for delegation, so a typo or stray whitespace
  // would cause every legitimate request to fail with "unauthorized
  // delegate" — fail-fast here so the operator notices.
  stealthTransferAccountAddress: (() => {
    const raw = (process.env.STEALTH_TRANSFER_ACCOUNT_ADDRESS || "").trim();
    if (!raw) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      throw new Error(
        "STEALTH_TRANSFER_ACCOUNT_ADDRESS must be a 0x-prefixed 20-byte address",
      );
    }
    return raw;
  })(),
  adminApiKey: (() => {
    const key = process.env.ADMIN_API_KEY;
    if (!key) return null;
    if (Buffer.byteLength(key, "utf8") < 32) throw new Error("ADMIN_API_KEY must be at least 32 bytes");
    return Buffer.from(key);
  })(),
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
