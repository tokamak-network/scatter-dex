import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { Orderbook } from "./core/orderbook.js";
import { Matcher } from "./core/matcher.js";
import { Submitter } from "./core/submitter.js";
import { createOrderRoutes } from "./routes/orders.js";
import { createOrderbookRoutes } from "./routes/orderbook.js";
import { createInfoRoutes } from "./routes/info.js";
import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  const orderbook = new Orderbook();
  const matcher = new Matcher(orderbook);
  const submitter = new Submitter();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/api/orders", createOrderRoutes(orderbook, matcher, submitter, chainId));
  app.use("/api/orderbook", createOrderbookRoutes(orderbook));
  app.use("/api/info", createInfoRoutes(orderbook, submitter));

  // Periodic expired order cleanup
  setInterval(() => {
    const removed = orderbook.purgeExpired();
    if (removed > 0) {
      console.log(`Purged ${removed} expired orders`);
    }
  }, 60_000);

  app.listen(config.port, () => {
    console.log(`ScatterDEX Relayer running on port ${config.port}`);
    console.log(`Chain ID: ${chainId}`);
    console.log(`Relayer address: ${submitter.getAddress()}`);
    console.log(`Settlement: ${config.settlementAddress}`);
    console.log(`Fee: ${config.relayerFee} bps`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
