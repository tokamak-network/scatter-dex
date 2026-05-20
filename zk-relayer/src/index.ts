import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
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
import { createAuthorizeOrderRoutes, purgeNonPendingAuthorizeOrders, drainAuthorizeOrders, getAuthorizeOrderStats, pubKeyId, authorizeOrders, lookupAuthorizeOrdersByCounterPair, findMatch as findAuthorizeMatch, decPubKeyCount as decAuthorizePubKeyCount, nullifierToOfferHandle, applyOnChainAuthorizeCancel } from "./routes/authorize-orders.js";
import { SettlementWorker } from "./core/settlement-worker.js";
import { createHealthRoutes } from "./routes/health.js";
import { createMetricsRoutes } from "./routes/metrics.js";
import { startHealthMonitor, stopHealthMonitor } from "./core/health-monitor.js";
import { startBalanceMonitor, stopBalanceMonitor } from "./core/balance-monitor.js";
import { startClaimMonitor, stopClaimMonitor } from "./core/claim-monitor.js";
import { createAdminRoutes, isPaused } from "./routes/admin.js";
import { loadSanctionsFile } from "./core/sanctions-list.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("main");
const adminLog = createLogger("admin");
const txRecoveryLog = createLogger("tx-recovery");
const sharedOBLog = createLogger("shared-orderbook");
const authCrossLog = createLogger("authorize-cross");
const diagLog = createLogger("diag-auth");
const settlementLog = createLogger("settlement-worker");
const expiryLog = createLogger("expiry-sweeper");
const netLog = createLogger("net");

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
      adminLog.info("Restored fee from DB", { feeBps: parsedFee });
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
  // Settlement push hook is wired below once `sharedClient` exists.

  // R-2: Recover pending TXs from previous run (receipt check only, no resend)
  const pendingTxs = db.getPendingTxs();
  if (pendingTxs.length > 0) {
    txRecoveryLog.info("Found pending TX(s) from previous run", { count: pendingTxs.length });
    const provider = submitter.getProvider();
    await Promise.all(pendingTxs.map(async (ptx) => {
      try {
        const receipt = await provider.getTransactionReceipt(ptx.tx_hash);
        if (receipt) {
          const status = receipt.status === 1 ? "confirmed" : "reverted";
          txRecoveryLog.info("pending tx resolved", {
            label: ptx.label,
            txHash: ptx.tx_hash.slice(0, 18) + "...",
            status,
          });
          db.removePendingTx(ptx.tx_hash);
        } else {
          const ageMin = Math.round((Date.now() - ptx.created_at) / 60_000);
          txRecoveryLog.warn("tx still pending — check manually", {
            label: ptx.label,
            txHash: ptx.tx_hash.slice(0, 18) + "...",
            ageMin,
          });
        }
      } catch (err) {
        txRecoveryLog.warn("Failed to check tx", {
          txHash: ptx.tx_hash.slice(0, 18) + "...",
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }

  // Index existing commitments on startup
  log.info("Indexing on-chain commitments...");
  await submitter.indexCommitments();

  // ─── On-chain PrivateCancel: local cleanup (always-on) ───
  // Solo relayers (no shared orderbook configured) still need to
  // reconcile their in-memory `authorizeOrders` map and the SQLite
  // row when a user submits cancelPrivate() directly on-chain.
  // Without this callback the local row stays in "pending" state
  // indefinitely and shows up as a zombie in `getAuthorizeOrderStats`
  // / `loadPendingAuthorizeOrders` until the next restart purge.
  // Registered BEFORE the listener attaches so we don't miss the
  // first event after `startCancelEventListener` below.
  authSubmitter.onCancel((escrowNullifier) => {
    applyOnChainAuthorizeCancel(BigInt(escrowNullifier).toString());
  });

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
      lookupAuthorizeOrdersByCounterPair,
    );

    sharedClient.onOrder((summary) => {
      remoteOrderbook!.add(summary);
      authorizeCrossRelayerService!.onRemoteOrderArrived(summary).catch((err) => {
        authCrossLog.warn("Reactive match error", { err: err instanceof Error ? err.message : "unknown" });
      });
    });

    sharedClient.onCancel((orderId) => {
      remoteOrderbook!.remove(orderId);
    });

    // Bridge on-chain `PrivateCancel` events into the shared orderbook.
    // The user submits cancelPrivate() directly on-chain (the relayer
    // does NOT submit cancel because there's no fee incentive), so
    // without this bridge a self-cancelled listing stays visible in
    // the shared OB on every OTHER relayer indefinitely — only the
    // origin relayer's local cleanup callback above wipes its own
    // map / DB. We pick `escrowNullifier` because that's exactly the
    // value `nullifierToOfferHandle` consumed at publish time, so the
    // canonical `offerHandle` round-trips and the shared-OB DELETE
    // matches the published row.
    //
    // `cancelOrder` resolves to `boolean` (true = HTTP ok or P2P
    // broadcast queued) and swallows network errors internally, so
    // `.catch` would never fire — surface the `ok=false` case via a
    // warning instead so a silently-failed propagation is visible
    // in the relayer log without taking down the listener queue.
    authSubmitter.onCancel((escrowNullifier) => {
      const offerHandle = nullifierToOfferHandle(BigInt(escrowNullifier).toString());
      sharedClient!.cancelOrder(offerHandle).then((ok) => {
        if (!ok) {
          sharedOBLog.warn("Shared OB rejected propagated cancel", { offerHandle });
        }
      });
    });

    // Phase 2.5a: wire the settlement push hook. Both the cross-relayer
    // matcher and the same-relayer settle path go through
    // `authSubmitter.submitAuthSettle`, so a single hook here covers both.
    // The pusher already swallows network failures (fire-and-forget), so
    // it's safe even when the shared OB is down.
    authSubmitter.setSettlementPusher((ctx) => {
      // makerRelayer is always us when we're the settling relayer;
      // takerRelayer is filled by the cross-relayer matcher when the
      // counterparty came from a different relayer.
      const ourAddr = authSubmitter.getAddress().toLowerCase();
      sharedClient!.pushSettlement({
        ...ctx,
        makerRelayer: ourAddr,
        takerRelayer: ctx.takerRelayer ?? ourAddr,
      });
    });

    try {
      await sharedClient.start();
      sharedOBLog.info("Connected", { url: config.sharedOrderbookUrl });
    } catch (err) {
      sharedOBLog.warn("Failed to connect", { err: err instanceof Error ? err.message : "unknown" });
    }
  }

  // ─── On-chain PrivateCancel: backfill + live listener (always-on) ───
  // Runs AFTER the shared-OB handshake completes (when one exists) so
  // the propagation callback registered inside the `if` block above
  // can write through immediately. Solo relayers still need this for
  // the local-cleanup callback registered above — without it a cancel
  // that landed while the relayer was down leaves a zombie row in
  // `authorizeOrders` / SQLite. Match the same `INDEX_FROM_BLOCK` env
  // the commitments indexer consumes (private-submitter.ts) so we
  // don't re-process the entire chain on every boot.
  const indexFromBlockRaw = process.env.INDEX_FROM_BLOCK;
  const indexFromBlock = Number.isFinite(Number(indexFromBlockRaw))
    ? Math.max(0, Math.floor(Number(indexFromBlockRaw)))
    : 0;
  try {
    await authSubmitter.indexCancels(indexFromBlock);
  } catch (err) {
    log.warn("PrivateCancel backfill failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  authSubmitter.startCancelEventListener();

  const app = express();

  // Security: CORS whitelist. Default covers every localhost dev port
  // scatter-dex's dev stack might call from — frontend (3000),
  // relayer A/B (3002/3003), and the four --apps mode apps (4001-4004,
  // per `scripts/dev.sh` APP_PORTS). dev.sh passes CORS_ORIGINS
  // explicitly when it starts the relayer, so this default mostly
  // matters for ad-hoc `npm run dev` from this directory without env.
  const allowedOrigins = (
    process.env.CORS_ORIGINS?.trim()
      ? process.env.CORS_ORIGINS.split(",")
      : [
          "http://localhost:3000", // frontend (legacy)
          "http://localhost:3002", // zk-relayer A
          "http://localhost:3003", // zk-relayer B
          "http://localhost:4001", // apps/pay
          "http://localhost:4002", // apps/drop
          "http://localhost:4003", // apps/pro
          "http://localhost:4004", // apps/operators
        ]
  ).map(s => s.trim()).filter(Boolean);
  const corsWildcard = allowedOrigins.includes("*");
  if (corsWildcard) {
    log.warn("CORS_ORIGINS includes '*' — all origins allowed. Set explicit origins for production.");
  }
  app.use(cors({ origin: corsWildcard ? "*" : allowedOrigins }));

  // SPIKE diagnostic — log the full server-side timeline of every
  // /api/authorize-orders request so we can compare against the iOS
  // client's POST/Aborted timestamps and locate the stall (body upload?
  // body parser? handler? response flush?). Mounted *before*
  // `express.json` so the `req.on('data'/'end')` events still fire on
  // the raw stream — once the JSON body parser consumes the request,
  // those events never fire again. Remove once root cause is found.
  app.use("/api/authorize-orders", (req, res, next) => {
    const t0 = Date.now();
    const cl = req.headers["content-length"] ?? "?";
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 60);
    diagLog.info("REQ", { method: req.method, cl, ua, t: 0 });
    let firstChunk = -1;
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      if (firstChunk < 0) {
        firstChunk = Date.now() - t0;
        diagLog.info("FIRST_CHUNK", { ms: firstChunk });
      }
      bytes += chunk.length;
    });
    req.on("end", () => {
      diagLog.info("BODY_END", { ms: Date.now() - t0, bytes });
    });
    req.on("aborted", () => {
      diagLog.info("ABORTED", { ms: Date.now() - t0, bytes });
    });
    res.on("finish", () => {
      diagLog.info("RES_FINISH", { ms: Date.now() - t0, status: res.statusCode });
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        diagLog.info("RES_CLOSE_EARLY", { ms: Date.now() - t0 });
      }
    });
    next();
  });

  // Security: body size limit + capture raw bytes for relayer-auth
  // signature verification (see routes/p2p.ts `verifyRelayerAuth`).
  // The verify hook runs before JSON.parse so the bytes we hash are
  // exactly what the peer signed.
  app.use(
    express.json({
      limit: "10kb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

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
  app.use("/api/info", readLimiter, createInfoRoutes(submitter, db));
  app.use("/api/private-claim", createPrivateClaimRoutes(submitter, db, writeLimiter));
  app.use("/api/vault", createVaultRoutes(submitter, writeLimiter));
  app.use("/api/relayer", createRelayerStatsRoutes(db, submitter, readLimiter));

  // Half-proof (trustless) order routes — settleAuth path.
  // `authSubmitter` was instantiated earlier so the cross-relayer service
  // could depend on it; here we just mount the HTTP routes.
  // (Server-side request timeline diagnostics for /api/authorize-orders
  // are mounted before `express.json` above so the raw-body data/end
  // events still fire — see the diag-auth middleware near the CORS setup.)
  app.use("/api/authorize-orders", pauseGuard, createAuthorizeOrderRoutes(
    authSubmitter, writeLimiter, authSubmitter.getAddress(), readLimiter, db,
    sharedClient, authWriteLimiter,
  ));

  // [R-3] Health check (no rate limiting — used by k8s/load-balancers)
  app.use("/health", createHealthRoutes(submitter, db));

  // Prometheus exposition (no rate limiting — Prometheus scrapes at a
  // fixed cadence configured on the scraper side, typically every 15s).
  app.use("/metrics", createMetricsRoutes(db));

  // P2P routes (relayer-to-relayer communication)
  app.use("/api/p2p", createP2PRoutes(
    (order) => {
      remoteOrderbook?.add(order);
      // P2P fallback (when shared-OB server is down): peer relayer POSTs
      // an OrderSummary directly to /api/p2p/orders. Tracker #30 aligned
      // the route's validation with the canonical OrderSummary shape, so
      // authorize summaries now reach this matcher hook.
      authorizeCrossRelayerService?.onRemoteOrderArrived(order).catch((err) => {
        authCrossLog.warn("P2P match error", { err: err instanceof Error ? err.message : "unknown" });
      });
    },
    (orderId) => { remoteOrderbook?.remove(orderId); },
    undefined,  // Private-flow trade-offer handler retired (tracker #29 cleanup)
    authorizeCrossRelayerService
      ? (offer, addr) => authorizeCrossRelayerService!.handleTradeOffer(offer, addr)
      : undefined,
    (orderId) => remoteOrderbook?.getRelayer(orderId) ?? null,
  ));

  // Periodic commitment re-indexing (stay in sync with on-chain state)
  const reindexInterval = setInterval(async () => {
    try {
      await submitter.indexCommitments();
    } catch (err) {
      log.error("Commitment re-indexing failed", { err: err instanceof Error ? err.message : "unknown" });
    }
  }, 5 * 60_000);

  // Periodic remote order cleanup
  const remoteExpireInterval = setInterval(() => {
    if (remoteOrderbook) {
      const removed = remoteOrderbook.purgeExpired();
      if (removed > 0) log.info("Purged expired remote orders", { removed });
    }
  }, 60_000);

  // Periodic authorize-order cleanup (settled/cancelled/expired)
  const authPurgeInterval = setInterval(() => {
    const removed = purgeNonPendingAuthorizeOrders();
    if (removed > 0) log.info("Purged non-pending authorize orders", { removed });
  }, 60_000);

  // Async-settlement sprint #1: reset orphaned 'settling' rows from a prior
  // crash, then start the worker that drains the accepted/retrying queue.
  // See docs/design/async-settlement-protocol.md.
  const orphans = db.resetOrphanedSettlingOrders();
  if (orphans > 0) settlementLog.info("Reset orphaned 'settling' rows to 'accepted'", { orphans });
  const settlementWorker = new SettlementWorker({
    db,
    submitter: authSubmitter,
    authorizeOrders,
    findMatch: findAuthorizeMatch,
    decPubKeyCount: decAuthorizePubKeyCount,
    sharedClient,
    nullifierToOfferHandle,
    getFeeBps: () => BigInt(config.relayerFee),
  });
  settlementWorker.start();
  settlementLog.info("Started");

  // Expiry sweeper — bulk-mark accepted/retrying/settling rows whose
  // circuit expiry passed without settlement (design §2.8).
  const expirySweepInterval = setInterval(() => {
    const expired = db.sweepExpiredAuthorizeOrders();
    if (expired > 0) expiryLog.info("Marked expired authorize order(s)", { expired });
  }, 60_000);

  // Periodic health probe — emits webhook alerts on healthy↔degraded
  // transitions. The /health route still serves k8s/load-balancer
  // readiness; this monitor adds proactive operator notifications.
  startHealthMonitor(submitter, db);
  // Balance monitor reuses the PrivateSubmitter (same wallet key as
  // authSubmitter today; keeps the API surface narrow — only
  // getProvider + getWallet are needed). Emits warn/info alerts on
  // healthy↔low transitions per LOW_BALANCE_ETH.
  startBalanceMonitor(submitter);
  // Per-token FeeVault claim-reminder monitor. No-op when
  // FEE_CLAIM_TOKENS is empty — operators opt in once tokens are
  // worth tracking.
  startClaimMonitor(submitter, db);

  const server = app.listen(config.port, () => {
    log.info("ScatterDEX ZK Relayer started", {
      port: config.port,
      relayerAddress: submitter.getAddress(),
      commitmentPool: config.commitmentPoolAddress,
      privateSettlement: config.privateSettlementAddress,
      feeBps: config.relayerFee,
      indexConfirmations: config.indexConfirmations,
      feeVault: config.feeVaultAddress || undefined,
      sharedOrderbookUrl: config.sharedOrderbookUrl || undefined,
      publicUrl: config.relayerPublicUrl || undefined,
    });
  });
  // Disable Nagle's algorithm on every accepted TCP connection.
  // Express's default keeps Nagle on, which interacts with TCP
  // delayed-ACK to delay our small JSON responses on loopback / LAN.
  // On iOS Simulator and Android real-device loopback that delay
  // stretches into seconds (see #401, #414, #421). Flushing
  // immediately costs nothing for our short responses and cuts the
  // perceived submit latency on the client side.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });

  // Latency probe endpoints (mobile NetProbe). Echoes input back so
  // wall-clock differences isolate the transport. Bypass-prone, so
  // gated behind DIAG_AUTH_ORDERS like the diag middleware.
  if (process.env.DIAG_AUTH_ORDERS === "1") {
    app.post("/api/echo", express.json({ limit: "1mb" }), (req, res) => {
      res.status(200).json({ echo: req.body, t: Date.now() });
    });
    const wss = new WebSocketServer({ server, path: "/ws/echo" });
    wss.on("connection", (ws) => {
      ws.on("message", (data, isBinary) => {
        // ws@8 hands us RawData (Buffer/ArrayBuffer/Buffer[]); echo it
        // back unchanged with the original binary/text framing.
        ws.send(data, { binary: isBinary });
      });
    });
    netLog.info("echo probe enabled at POST /api/echo and WS /ws/echo");
  }

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info("Shutting down...");
    clearInterval(reindexInterval);
    clearInterval(remoteExpireInterval);
    clearInterval(authPurgeInterval);
    clearInterval(expirySweepInterval);
    // Stop the periodic probes before draining the worker so we
    // don't kick off an extra DB write (or alert) once shutdown
    // is in motion.
    stopHealthMonitor();
    stopBalanceMonitor();
    stopClaimMonitor();
    authSubmitter.stopCancelEventListener();
    sharedClient?.stop();
    // `settlementWorker.stop()` awaits any in-flight tick, which itself
    // runs SQLite statements through `db`. If we closed `db` before the
    // tick drained, the worker would hit a closed handle. Chain stop →
    // server.close → db.close so the order is strict.
    void settlementWorker.stop().finally(() => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("Fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
