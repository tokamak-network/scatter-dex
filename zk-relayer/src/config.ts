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
  relayerPrivateKey: loadPrivateKey(),
  commitmentPoolAddress: requireEnv("COMMITMENT_POOL_ADDRESS"),
  privateSettlementAddress: requireEnv("PRIVATE_SETTLEMENT_ADDRESS"),
  relayerFee: parseInt(process.env.RELAYER_FEE || "30", 10),
  port: parseInt(process.env.PORT || "3002", 10),
};
