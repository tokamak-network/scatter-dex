import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { Orderbook } from "./core/orderbook.js";
import { Matcher } from "./core/matcher.js";
import { Submitter } from "./core/submitter.js";
import { OrderDB } from "./core/db.js";
import { createOrderRoutes } from "./routes/orders.js";
import { createOrderbookRoutes } from "./routes/orderbook.js";
import { createInfoRoutes } from "./routes/info.js";
import { ethers } from "ethers";

const MAX_ORDERBOOK_SIZE = 10_000;

async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  const db = new OrderDB();
  const orderbook = new Orderbook(MAX_ORDERBOOK_SIZE);
  orderbook.setDB(db);
  const restored = orderbook.loadFromDB();
  if (restored > 0) {
    console.log(`Restored ${restored} pending orders from DB`);
  }
  const matcher = new Matcher(orderbook);
  const submitter = new Submitter();

  const app = express();

  // Security: CORS whitelist
  const allowedOrigins = (process.env.CORS_ORIGINS?.split(",") || ["http://localhost:3000"])
    .map(s => s.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));

  // Security: body size limit
  app.use(express.json({ limit: "10kb" }));

  // Security: rate limiting
  const orderLimiter = rateLimit({
    windowMs: 60_000,
    max: 30, // 30 orders per minute per IP
    message: { error: "too many requests" },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: 120, // 120 reads per minute per IP
    message: { error: "too many requests" },
  });

  app.use("/api/orders", createOrderRoutes(orderbook, matcher, submitter, chainId, orderLimiter, readLimiter));
  app.use("/api/orderbook", readLimiter, createOrderbookRoutes(orderbook));
  app.use("/api/info", readLimiter, createInfoRoutes(orderbook, submitter));

  // Periodic expired order cleanup
  setInterval(() => {
    const removed = orderbook.purgeExpired();
    if (removed > 0) {
      console.log(`Purged ${removed} expired orders`);
    }
  }, 60_000);

  const server = app.listen(config.port, () => {
    console.log(`ScatterDEX Relayer running on port ${config.port}`);
    console.log(`Chain ID: ${chainId}`);
    console.log(`Relayer address: ${submitter.getAddress()}`);
    console.log(`Settlement: ${config.settlementAddress}`);
    console.log(`Fee: ${config.relayerFee} bps`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
