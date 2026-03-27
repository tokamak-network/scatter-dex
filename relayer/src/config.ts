import dotenv from "dotenv";
dotenv.config();

export const config = {
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || "",
  settlementAddress: process.env.SETTLEMENT_ADDRESS || "",
  relayerFee: parseInt(process.env.RELAYER_FEE || "30"), // basis points
  port: parseInt(process.env.PORT || "3001"),
};
