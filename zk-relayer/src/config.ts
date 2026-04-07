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
    const key = readFileSync(keyFile, "utf-8").trim();
    if (!key) throw new Error(`RELAYER_PRIVATE_KEY_FILE (${keyFile}) is empty`);
    return key;
  }
  return requireEnv("RELAYER_PRIVATE_KEY");
}

export const config = {
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  relayerPrivateKey: loadPrivateKey(),
  commitmentPoolAddress: requireEnv("COMMITMENT_POOL_ADDRESS"),
  privateSettlementAddress: requireEnv("PRIVATE_SETTLEMENT_ADDRESS"),
  relayerFee: parseInt(process.env.RELAYER_FEE || "30"),
  port: parseInt(process.env.PORT || "3002"),
};
