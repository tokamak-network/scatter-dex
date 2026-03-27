import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  relayerPrivateKey: requireEnv("RELAYER_PRIVATE_KEY"),
  settlementAddress: requireEnv("SETTLEMENT_ADDRESS"),
  relayerFee: parseInt(process.env.RELAYER_FEE || "30"),
  port: parseInt(process.env.PORT || "3001"),
};
