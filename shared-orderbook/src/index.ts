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

  // Body size limit
  app.use(express.json({ limit: "10kb" }));

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
      const addr = (req as Record<string, unknown>).relayerAddress as string | undefined;
      return addr ? `relayer:${addr}` : (req.ip ?? "unknown");
    },
  });

  // Routes
  app.use("/api/orders", createOrderRoutes(orderbook, db, broadcaster, writeLimiter, readLimiter, relayerWriteLimiter));
  app.use("/api/relayers", createRelayerRoutes(orderbook, broadcaster, writeLimiter, readLimiter, relayerWriteLimiter));
  app.use("/api/stats", createStatsRoutes(orderbook, readLimiter));
  app.use("/api/peers", createPeerRoutes(orderbook, readLimiter));

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
