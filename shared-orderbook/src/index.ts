import http from "http";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { OrderbookDB } from "./core/db.js";
import { SharedOrderbook } from "./core/orderbook.js";
import { OrderBroadcaster } from "./core/broadcaster.js";
import { createOrderRoutes } from "./routes/orders.js";
import { createRelayerRoutes } from "./routes/relayers.js";
import { createStatsRoutes } from "./routes/stats.js";
import { createPeerRoutes } from "./routes/peer.js";
import { createSettlementRoutes, createSettlementStatsRoutes } from "./routes/settlements.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createKycRoutes } from "./routes/kyc.js";
import { createCaRoutes } from "./routes/ca.js";
import { VerifyMonitor } from "./core/verify-runtime.js";
import { makeAdminSiweFromAllowlist } from "./core/admin-siwe.js";
import { makeAdminAuth } from "./middleware/admin-auth.js";

async function main() {
  const db = new OrderbookDB();
  const orderbook = new SharedOrderbook();
  const broadcaster = new OrderBroadcaster();

  // Restore open orders from DB
  const openOrders = db.loadAllOpen();
  const restored = orderbook.loadFromStored(openOrders);
  if (restored > 0) {
    console.log(`Restored ${restored} open orders from DB`);
  }

  const app = express();

  // CORS
  const corsWildcard = config.corsOrigins.includes("*");
  if (corsWildcard) {
    console.warn("[WARN] CORS_ORIGINS includes '*' — all origins allowed. Set explicit origins for production.");
  }
  app.use(cors({
    origin: corsWildcard ? "*" : config.corsOrigins,
  }));

  // Body size limit + capture raw bytes for `relayerAuth`. The auth
  // middleware needs to hash the exact bytes the client signed; the
  // `verify` callback fires before JSON.parse and gets us those
  // bytes verbatim. See `middleware/auth.ts` for why this matters.
  app.use(
    express.json({
      limit: "10kb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Rate limiters — two layers to mitigate multi-IP bypass.
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: config.writeRateLimit,
    message: { error: "too many requests" },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: config.readRateLimit,
    message: { error: "too many requests" },
  });

  // Layer 2: relayer-identity-based limiter for write endpoints.
  // Even if the attacker rotates IPs, each authenticated relayer is
  // limited independently. Stricter than the IP limiter.
  const relayerWriteLimiter = rateLimit({
    windowMs: 60_000,
    max: Math.max(1, Math.floor(config.writeRateLimit / 2)),
    message: { error: "too many requests for this relayer" },
    keyGenerator: (req) => {
      const addr = (req as unknown as Record<string, unknown>).relayerAddress as string | undefined;
      return addr ? `relayer:${addr}` : (req.ip ?? "unknown");
    },
    validate: { keyGeneratorIpFallback: false },
  });

  // Routes
  app.use("/api/orders", createOrderRoutes(orderbook, db, broadcaster, writeLimiter, readLimiter, relayerWriteLimiter));
  app.use("/api/relayers", createRelayerRoutes(orderbook, broadcaster, writeLimiter, readLimiter, relayerWriteLimiter));
  app.use("/api/stats", createStatsRoutes(orderbook, readLimiter));
  app.use("/api/peers", createPeerRoutes(orderbook, readLimiter));
  app.use("/api/settlements", createSettlementRoutes(db, writeLimiter, readLimiter, relayerWriteLimiter));
  // Per-relayer + network read views from the settlements indexer. Mounted
  // at root so the URLs read naturally (/api/relayers/:addr/stats etc).
  app.use("/api", createSettlementStatsRoutes(db, readLimiter));

  // Admin auth — a single SIWE handle + a shared gate accepting a SIWE
  // session token or the static ADMIN_TOKEN. Both /api/admin and the KYC
  // review routes mount the same gate; the SIWE challenge/session endpoints
  // live under /api/admin.
  const adminSiwe = makeAdminSiweFromAllowlist(config.adminAddresses);
  const adminAuth = makeAdminAuth({ siwe: adminSiwe, staticToken: config.adminToken });

  // Relayer operator KYC onboarding. Public submit/status; admin review
  // endpoints behind adminAuth.
  app.use("/api/kyc", createKycRoutes(db, writeLimiter, readLimiter, adminAuth));

  // Public Root CA store: admin publishes the public .der, anyone downloads it
  // (X.509 anchor for operator cert-chain verification).
  app.use("/api/ca", createCaRoutes(db, adminAuth, readLimiter, writeLimiter));

  // Operator-only — single shared monitor instance. The verifier daemon
  // (`src/verify.ts`) is the writer; this server is the read-side
  // surface that ops dashboards poll. The two processes don't share
  // memory, so the monitor here only reflects in-process activity —
  // production deployments rely on the DB (`hasUnverifiedRows`) for
  // alerting, not on `lastPass`.
  const verifyMonitor = new VerifyMonitor();
  app.use("/api/admin", createAdminRoutes({ db, monitor: verifyMonitor, adminAuth, siwe: adminSiwe, writeLimiter }));

  // Health check
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Create HTTP server and attach WebSocket
  const server = http.createServer(app);
  broadcaster.attach(server);

  // Periodic cleanup — sync expired IDs explicitly to avoid in-memory/DB drift
  const expireInterval = setInterval(() => {
    const expiredIds = orderbook.purgeExpired();
    if (expiredIds.length > 0) {
      console.log(`Purged ${expiredIds.length} expired orders`);
      db.expireByIds(expiredIds);
    }
  }, 60_000);

  // Purge stale relayers (no heartbeat for 10 min)
  const staleInterval = setInterval(() => {
    const stale = orderbook.purgeStaleRelayers(600);
    if (stale.length > 0) {
      console.log(`Removed ${stale.length} stale relayers: ${stale.join(", ")}`);
      for (const addr of stale) {
        broadcaster.broadcast({ type: "relayer:offline", relayer: addr });
      }
    }
  }, 120_000);

  server.listen(config.port, () => {
    console.log(`zkScatter Shared Orderbook running on port ${config.port}`);
    console.log(`WebSocket: ws://localhost:${config.port}/ws/orders`);
    console.log(`Endpoints:`);
    console.log(`  POST   /api/orders          — post order summary`);
    console.log(`  GET    /api/orders           — list open orders`);
    console.log(`  GET    /api/orders/:pair      — orders by pair`);
    console.log(`  DELETE /api/orders/:id        — cancel order`);
    console.log(`  POST   /api/relayers/register — register relayer`);
    console.log(`  POST   /api/relayers/heartbeat — heartbeat`);
    console.log(`  GET    /api/relayers          — list relayers`);
    console.log(`  GET    /api/stats             — orderbook stats`);
    console.log(`  GET    /api/peers             — peer list (P2P fallback)`);
    console.log(`  POST   /api/settlements              — push settlement record (auth)`);
    console.log(`  GET    /api/settlements              — list rows (relayer/pair/since filters)`);
    console.log(`  GET    /api/relayers/:addr/stats     — per-relayer aggregates`);
    console.log(`  GET    /api/network/totals           — network-wide totals`);
    console.log(`  GET    /api/leaderboard              — top relayers by metric`);
    console.log(`  POST   /api/kyc/submit               — submit operator KYC (multipart)`);
    console.log(`  GET    /api/kyc/status?wallet=       — KYC submission status`);
    console.log(`  GET    /api/kyc/submissions          — admin: review queue`);
    console.log(`  GET    /api/kyc/submissions/:id      — admin: submission detail`);
    console.log(`  GET    /api/kyc/submissions/:id/file/:kind — admin: stream document`);
    console.log(`  POST   /api/kyc/submissions/:id/status     — admin: set review status`);
    if (adminSiwe) {
      console.log(`  GET    /api/admin/challenge          — admin SIWE: request nonce`);
      console.log(`  POST   /api/admin/session            — admin SIWE: exchange signature for token`);
    }
    console.log(`  GET    /api/admin/audit              — admin: append-only audit log`);
    console.log(`  POST   /api/ca/root                  — admin: publish public Root CA (.der)`);
    console.log(`  GET    /api/ca/root                  — download active Root CA`);
    console.log(`  GET    /api/ca/root/info             — Root CA metadata`);
  });

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("Shutting down...");
    clearInterval(expireInterval);
    clearInterval(staleInterval);
    broadcaster.close();
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
