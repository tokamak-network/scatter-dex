import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config, updateRelayerFee } from "./config.js";
import { PrivateSubmitter } from "./core/private-submitter.js";
import { PrivateOrderDB } from "./core/db.js";
import { createPrivateOrderRoutes } from "./routes/orders.js";
import { createInfoRoutes } from "./routes/info.js";
import { createPrivateClaimRoutes } from "./routes/claim.js";
import { createVaultRoutes } from "./routes/vault.js";
import { createRelayerStatsRoutes } from "./routes/relayer-stats.js";
import { SharedOrderbookClient } from "./core/shared-orderbook-client.js";
import { RemoteOrderStore } from "./core/remote-orderbook.js";
import { createP2PRoutes } from "./routes/p2p.js";
import { AuthorizeCrossRelayerMatchService } from "./core/authorize-cross-relayer-matcher.js";
import { AuthorizeSubmitter } from "./core/authorize-submitter.js";
import { createAuthorizeOrderRoutes, purgeNonPendingAuthorizeOrders, drainAuthorizeOrders, getAuthorizeOrderStats, pubKeyId, authorizeOrders } from "./routes/authorize-orders.js";
import { createHealthRoutes } from "./routes/health.js";
import { createAdminRoutes, isPaused } from "./routes/admin.js";
import { loadSanctionsFile } from "./core/sanctions-list.js";

const MAX_ORDERBOOK_SIZE = 10_000;

async function main() {
  const db = new PrivateOrderDB();
  db.setMeta("started_at", Date.now().toString());

  // [R-7] Restore runtime fee from DB (if previously changed via admin API)
  const savedFee = db.getMeta("relayerFee");
  if (savedFee !== null) {
    const parsedFee = parseInt(savedFee, 10);
    if (Number.isFinite(parsedFee) && parsedFee >= 0 && parsedFee <= 10_000) {
      updateRelayerFee(parsedFee);
      console.log(`[admin] Restored fee from DB: ${parsedFee} bps`);
    }
  }

  // [R-10] Load sanctions pubKey blocklist (optional)
  if (config.sanctionsPubKeyList) {
    loadSanctionsFile(config.sanctionsPubKeyList);
  }

  const submitter = new PrivateSubmitter();
  submitter.setDB(db);

  // Authorize (half-proof) submitter — instantiated here so the cross-relayer
  // service below can depend on it before the route is mounted.
  const authSubmitter = new AuthorizeSubmitter();
  authSubmitter.setDB(db);

  // R-2: Recover pending TXs from previous run (receipt check only, no resend)
  const pendingTxs = db.getPendingTxs();
  if (pendingTxs.length > 0) {
    console.log(`[tx-recovery] Found ${pendingTxs.length} pending TX(s) from previous run`);
    const provider = submitter.getProvider();
    await Promise.all(pendingTxs.map(async (ptx) => {
      try {
        const receipt = await provider.getTransactionReceipt(ptx.tx_hash);
        if (receipt) {
          const status = receipt.status === 1 ? "confirmed" : "reverted";
          console.log(`[tx-recovery] ${ptx.label} ${ptx.tx_hash.slice(0, 18)}... → ${status}`);
          db.removePendingTx(ptx.tx_hash);
        } else {
          const ageMin = Math.round((Date.now() - ptx.created_at) / 60_000);
          console.warn(
            `[tx-recovery] ${ptx.label} ${ptx.tx_hash.slice(0, 18)}... still pending (${ageMin}min old). Check manually.`,
          );
        }
      } catch (err) {
        console.warn(`[tx-recovery] Failed to check ${ptx.tx_hash.slice(0, 18)}...:`, err);
      }
    }));
  }

  // Index existing commitments on startup
  console.log("Indexing on-chain commitments...");
  await submitter.indexCommitments();

  // ─── Shared orderbook integration (optional) ───
  let sharedClient: SharedOrderbookClient | null = null;
  let remoteOrderbook: RemoteOrderStore | null = null;
  let authorizeCrossRelayerService: AuthorizeCrossRelayerMatchService | null = null;

  if (config.sharedOrderbookUrl && config.relayerPublicUrl) {
    remoteOrderbook = new RemoteOrderStore();
    sharedClient = new SharedOrderbookClient({
      serverUrl: config.sharedOrderbookUrl,
      relayerWallet: submitter.getWallet(),
      relayerUrl: config.relayerPublicUrl,
      relayerName: config.relayerName,
    });

    authorizeCrossRelayerService = new AuthorizeCrossRelayerMatchService(
      authorizeOrders, sharedClient, authSubmitter, authSubmitter.getAddress(), db,
    );

    sharedClient.onOrder((summary) => {
      remoteOrderbook!.add(summary);
      authorizeCrossRelayerService!.onRemoteOrderArrived(summary).catch((err) => {
        console.warn("[authorize-cross] Reactive match error:", err instanceof Error ? err.message : "unknown");
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

  // Security: rate limiting — two layers to mitigate multi-IP bypass.
  // Layer 1: IP-based global limiter (catches naive floods)
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

  // Layer 2: pubKey-based limiter for authorize-orders POST.
  // Even if the attacker rotates IPs, each ZK identity is limited to
  // 10 writes/min. The key is extracted from the request body.
  const authWriteLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    message: { error: "too many requests for this identity" },
    keyGenerator: (req) => {
      const body = req.body as Record<string, unknown>;
      const ax = body.pubKeyAx as string | undefined;
      const ay = body.pubKeyAy as string | undefined;
      if (ax && ay) {
        try { return `pubkey:${pubKeyId(ax, ay)}`; }
        catch { /* fall through to IP */ }
      }
      return req.ip ?? "unknown";
    },
  });

  // [R-7] Admin API — fee, pause/resume, drain, balance
  app.use("/api/admin", createAdminRoutes({
    submitter, db,
    drainAuthorizeOrders, getAuthorizeOrderStats,
    writeLimiter,
  }));

  // [R-7] Pause guard — reject new order submissions (POST only) when paused
  const pauseGuard: express.RequestHandler = (req, res, next) => {
    if (isPaused() && req.method === "POST") {
      res.status(503).json({ error: "Relayer is paused — not accepting new orders" });
      return;
    }
    next();
  };

  app.use("/api/private-orders", readLimiter, pauseGuard, createPrivateOrderRoutes(writeLimiter));
  app.use("/api/info", readLimiter, createInfoRoutes(submitter));
  app.use("/api/private-claim", createPrivateClaimRoutes(submitter, db, writeLimiter));
  app.use("/api/vault", createVaultRoutes(submitter, writeLimiter));
  app.use("/api/relayer", createRelayerStatsRoutes(db, submitter, readLimiter));

  // Half-proof (trustless) order routes — settleAuth path.
  // `authSubmitter` was instantiated earlier so the cross-relayer service
  // could depend on it; here we just mount the HTTP routes.
  app.use("/api/authorize-orders", pauseGuard, createAuthorizeOrderRoutes(
    authSubmitter, writeLimiter, authSubmitter.getAddress(), readLimiter, db,
    sharedClient, authWriteLimiter,
  ));

  // [R-3] Health check (no rate limiting — used by k8s/load-balancers)
  app.use("/health", createHealthRoutes(submitter, db));

  // P2P routes (relayer-to-relayer communication)
  app.use("/api/p2p", createP2PRoutes(
    (order) => {
      remoteOrderbook?.add(order);
      // NOTE: the P2P fallback path (POST /api/p2p/orders) validates fields
      // like `nonce`/`pubKeyAx`/`pubKeyAy` that don't exist on the shared
      // `OrderSummary` shape used by the shared-OB WS stream (see routes/p2p.ts
      // :60-68). Authorize summaries will 400 before reaching this callback
      // today — tracker #30. Keep the hook so the schema-alignment PR
      // turns this back on without further wiring.
      authorizeCrossRelayerService?.onRemoteOrderArrived(order).catch((err) => {
        console.warn("[authorize-cross] P2P match error:", err instanceof Error ? err.message : "unknown");
      });
    },
    (orderId) => { remoteOrderbook?.remove(orderId); },
    undefined,  // Private-flow trade-offer handler retired (tracker #29 cleanup)
    authorizeCrossRelayerService
      ? (offer, addr) => authorizeCrossRelayerService!.handleTradeOffer(offer, addr)
      : undefined,
  ));

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
