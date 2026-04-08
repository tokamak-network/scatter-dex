import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { PrivateOrderbook } from "./core/orderbook.js";
import { PrivateMatcher } from "./core/matcher.js";
import { PrivateSubmitter } from "./core/private-submitter.js";
import { PrivateOrderDB } from "./core/db.js";
import { createPrivateOrderRoutes } from "./routes/orders.js";
import { createOrderbookRoutes } from "./routes/orderbook.js";
import { createInfoRoutes } from "./routes/info.js";
import { createPrivateClaimRoutes } from "./routes/claim.js";
import { createVaultRoutes } from "./routes/vault.js";

const MAX_ORDERBOOK_SIZE = 10_000;

async function main() {
  const db = new PrivateOrderDB();
  const orderbook = new PrivateOrderbook(MAX_ORDERBOOK_SIZE);
  orderbook.setDB(db);
  const restored = orderbook.loadFromDB();
  if (restored > 0) {
    console.log(`Restored ${restored} pending private orders from DB`);
  }

  const matcher = new PrivateMatcher(orderbook);
  const submitter = new PrivateSubmitter();
  submitter.setDB(db);

  // Index existing commitments on startup
  console.log("Indexing on-chain commitments...");
  await submitter.indexCommitments();

  const app = express();

  // Security: CORS whitelist
  const allowedOrigins = (process.env.CORS_ORIGINS?.split(",") || ["http://localhost:3000", "http://localhost:3002"])
    .map(s => s.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));

  // Security: body size limit
  app.use(express.json({ limit: "10kb" }));

  // Security: rate limiting
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: { error: "too many requests" },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    message: { error: "too many requests" },
  });

  app.use("/api/private-orders", createPrivateOrderRoutes(orderbook, matcher, submitter, writeLimiter, readLimiter));
  app.use("/api/private-orderbook", readLimiter, createOrderbookRoutes(orderbook));
  app.use("/api/info", readLimiter, createInfoRoutes(orderbook, submitter));
  app.use("/api/private-claim", createPrivateClaimRoutes(submitter, db, writeLimiter));

  // FeeVault API (relayer fee management)
  app.use("/api/vault", createVaultRoutes(submitter.getWallet(), writeLimiter));

  // Periodic expired order cleanup
  const expireInterval = setInterval(() => {
    const removed = orderbook.purgeExpired();
    if (removed > 0) {
      console.log(`Purged ${removed} expired private orders`);
    }
  }, 60_000);

  // Periodic commitment re-indexing (stay in sync with on-chain state)
  const reindexInterval = setInterval(async () => {
    try {
      await submitter.indexCommitments();
    } catch (err) {
      console.error("Commitment re-indexing failed:", err instanceof Error ? err.message : "unknown");
    }
  }, 5 * 60_000);

  const server = app.listen(config.port, () => {
    console.log(`ScatterDEX ZK Relayer running on port ${config.port}`);
    console.log(`Relayer address: ${submitter.getAddress()}`);
    console.log(`CommitmentPool: ${config.commitmentPoolAddress}`);
    console.log(`PrivateSettlement: ${config.privateSettlementAddress}`);
    console.log(`Fee: ${config.relayerFee} bps`);
    if (config.feeVaultAddress) {
      console.log(`FeeVault: ${config.feeVaultAddress}`);
    }
  });

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("Shutting down...");
    clearInterval(expireInterval);
    clearInterval(reindexInterval);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
