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
import { createRelayerStatsRoutes } from "./routes/relayer-stats.js";
import { SharedOrderbookClient } from "./core/shared-orderbook-client.js";
import { RemoteOrderStore } from "./core/remote-orderbook.js";
import { CrossRelayerMatchService } from "./core/cross-relayer-matcher.js";
import { createP2PRoutes } from "./routes/p2p.js";
import { AuthorizeSubmitter } from "./core/authorize-submitter.js";
import { createAuthorizeOrderRoutes, purgeNonPendingAuthorizeOrders } from "./routes/authorize-orders.js";

const MAX_ORDERBOOK_SIZE = 10_000;

async function main() {
  const db = new PrivateOrderDB();
  db.setMeta("started_at", Date.now().toString());
  const orderbook = new PrivateOrderbook(MAX_ORDERBOOK_SIZE);
  orderbook.setDB(db);
  const restored = orderbook.loadFromDB();
  if (restored > 0) {
    console.log(`Restored ${restored} pending private orders from DB`);
  }

  const submitter = new PrivateSubmitter();
  submitter.setDB(db);

  // Index existing commitments on startup
  console.log("Indexing on-chain commitments...");
  await submitter.indexCommitments();

  // ─── Shared orderbook integration (optional) ───
  let sharedClient: SharedOrderbookClient | null = null;
  let remoteOrderbook: RemoteOrderStore | null = null;
  let crossRelayerService: CrossRelayerMatchService | null = null;
  const orderIdMap = new Map<string, string>();

  // Create matcher (with remote orderbook if available)
  if (config.sharedOrderbookUrl && config.relayerPublicUrl) {
    remoteOrderbook = new RemoteOrderStore();
  }
  const matcher = new PrivateMatcher(orderbook, remoteOrderbook);
  matcher.setRelayerAddress(submitter.getAddress());

  if (config.sharedOrderbookUrl && config.relayerPublicUrl && remoteOrderbook) {
    sharedClient = new SharedOrderbookClient({
      serverUrl: config.sharedOrderbookUrl,
      relayerWallet: submitter.getWallet(),
      relayerUrl: config.relayerPublicUrl,
      relayerName: config.relayerName,
    });

    crossRelayerService = new CrossRelayerMatchService(
      orderbook, remoteOrderbook, matcher, submitter, sharedClient, orderIdMap, db,
    );

    sharedClient.onOrder((summary) => {
      remoteOrderbook!.add(summary);
      // Reactive matching: try to match against local pending orders
      crossRelayerService!.onRemoteOrderArrived(summary).catch((err) => {
        console.warn("[cross-relayer] Reactive match error:", err instanceof Error ? err.message : "unknown");
      });
    });

    sharedClient.onCancel((orderId) => {
      remoteOrderbook!.remove(orderId);
    });

    try {
      await sharedClient.start();
      console.log(`[shared-orderbook] Connected to ${config.sharedOrderbookUrl}`);
    } catch (err) {
      console.warn("[shared-orderbook] Failed to connect:", err instanceof Error ? err.message : "unknown");
    }
  }

  const app = express();

  // Security: CORS whitelist
  const allowedOrigins = (
    process.env.CORS_ORIGINS?.trim()
      ? process.env.CORS_ORIGINS.split(",")
      : [
          "http://localhost:3000",
          "http://localhost:3002",
          "http://localhost:3003",
        ]
  ).map(s => s.trim()).filter(Boolean);
  const corsWildcard = allowedOrigins.includes("*");
  if (corsWildcard) {
    console.warn("[WARN] CORS_ORIGINS includes '*' — all origins allowed. Set explicit origins for production.");
  }
  app.use(cors({ origin: corsWildcard ? "*" : allowedOrigins }));

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

  app.use("/api/private-orders", createPrivateOrderRoutes(
    orderbook, matcher, submitter, writeLimiter, readLimiter,
    sharedClient, crossRelayerService, orderIdMap,
  ));
  app.use("/api/private-orderbook", readLimiter, createOrderbookRoutes(orderbook));
  app.use("/api/info", readLimiter, createInfoRoutes(orderbook, submitter));
  app.use("/api/private-claim", createPrivateClaimRoutes(submitter, db, writeLimiter));
  app.use("/api/vault", createVaultRoutes(submitter, writeLimiter));
  app.use("/api/relayer", createRelayerStatsRoutes(db, orderbook, submitter, readLimiter));

  // Half-proof (trustless) order routes — settleAuth path
  const authSubmitter = new AuthorizeSubmitter();
  app.use("/api/authorize-orders", createAuthorizeOrderRoutes(
    authSubmitter, writeLimiter, authSubmitter.getAddress(), readLimiter,
  ));

  // P2P routes (relayer-to-relayer communication)
  app.use("/api/p2p", createP2PRoutes(
    (order) => { remoteOrderbook?.add(order); },
    (orderId) => { remoteOrderbook?.remove(orderId); },
    crossRelayerService
      ? (offer, addr) => crossRelayerService!.handleTradeOffer(offer, addr)
      : undefined,
  ));

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

  // Periodic remote order cleanup
  const remoteExpireInterval = setInterval(() => {
    if (remoteOrderbook) {
      const removed = remoteOrderbook.purgeExpired();
      if (removed > 0) console.log(`Purged ${removed} expired remote orders`);
    }
  }, 60_000);

  // Periodic authorize-order cleanup (settled/cancelled/expired)
  const authPurgeInterval = setInterval(() => {
    const removed = purgeNonPendingAuthorizeOrders();
    if (removed > 0) console.log(`Purged ${removed} non-pending authorize orders`);
  }, 60_000);

  const server = app.listen(config.port, () => {
    console.log(`ScatterDEX ZK Relayer running on port ${config.port}`);
    console.log(`Relayer address: ${submitter.getAddress()}`);
    console.log(`CommitmentPool: ${config.commitmentPoolAddress}`);
    console.log(`PrivateSettlement: ${config.privateSettlementAddress}`);
    console.log(`Fee: ${config.relayerFee} bps`);
    if (config.feeVaultAddress) {
      console.log(`FeeVault: ${config.feeVaultAddress}`);
    }
    if (config.sharedOrderbookUrl) {
      console.log(`Shared Orderbook: ${config.sharedOrderbookUrl}`);
      console.log(`Public URL: ${config.relayerPublicUrl}`);
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
    clearInterval(remoteExpireInterval);
    clearInterval(authPurgeInterval);
    sharedClient?.stop();
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
