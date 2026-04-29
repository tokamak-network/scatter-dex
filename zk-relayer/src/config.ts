import dotenv from "dotenv";
import { readFileSync } from "fs";
dotenv.config();

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
};

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
