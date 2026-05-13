/**
 * Verifier daemon entry. Reads RPC + contract address + DB path from
 * env, attaches to the same SQLite file the orderbook server writes,
 * and runs the verify loop until SIGINT/SIGTERM. One-shot mode (no
 * --watch) runs a single pass and exits — useful for cron-driven
 * operators.
 *
 * Env:
 *   RPC_URL                        — JSON-RPC endpoint (required)
 *   PRIVATE_SETTLEMENT_ADDRESS     — 0x… (required)
 *   DB_PATH                        — same path the API uses (default shared-orderbook.db)
 *   VERIFIER_POLL_INTERVAL_SEC     — watch-mode pass interval (default 30)
 *   VERIFIER_BLOCK_SAFETY_MARGIN   — confirmations to skip (default 6)
 *   VERIFIER_LIMIT_PER_PASS        — max rows per pass (default 500)
 *
 * Modes:
 *   node dist/verify.js             # one-shot pass, exit code 0 on success
 *   node dist/verify.js --watch     # loop until SIGINT/SIGTERM
 */
import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import { OrderbookDB } from "./core/db.js";
import { runVerifyPass } from "./core/verifier.js";
import { makeEventFetcher, runVerifyLoop, VerifyMonitor } from "./core/verify-runtime.js";

function envRequired(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[verifier] missing required env: ${key}`);
    process.exit(2);
  }
  return v;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[verifier] invalid numeric env: ${key}=${raw}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const rpcUrl = envRequired("RPC_URL");
  const contractAddress = envRequired("PRIVATE_SETTLEMENT_ADDRESS");
  const dbPath = process.env.DB_PATH ?? "shared-orderbook.db";
  const watch = process.argv.includes("--watch");

  const provider = new JsonRpcProvider(rpcUrl);
  const fetcher = makeEventFetcher({ rpcUrl, contractAddress, provider });
  const db = new OrderbookDB(dbPath);

  if (!watch) {
    // One-shot — useful for cron-driven backends.
    const latest = await provider.getBlockNumber();
    const safety = envInt("VERIFIER_BLOCK_SAFETY_MARGIN", 6);
    const limit = envInt("VERIFIER_LIMIT_PER_PASS", 500);
    const maxBlock = Math.max(0, latest - safety);
    const r = await runVerifyPass(db, fetcher, { maxBlock, limit });
    console.log(
      `[verifier] one-shot: scanned=${r.scanned} flipped=${r.flipped} unmatched=${r.report.unmatched.length} maxBlock=${maxBlock}`,
    );
    db.close();
    return;
  }

  const monitor = new VerifyMonitor();
  const ac = new AbortController();
  const shutdown = (sig: string): void => {
    console.log(`[verifier] received ${sig}; draining current pass and exiting`);
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`[verifier] watch mode @ ${rpcUrl}, contract=${contractAddress}, db=${dbPath}`);
  await runVerifyLoop(db, fetcher, {
    intervalSec: envInt("VERIFIER_POLL_INTERVAL_SEC", 30),
    blockSafetyMargin: envInt("VERIFIER_BLOCK_SAFETY_MARGIN", 6),
    limitPerPass: envInt("VERIFIER_LIMIT_PER_PASS", 500),
    provider,
    monitor,
    signal: ac.signal,
    onPass: (s) => {
      const parts = [
        `scanned=${s.scanned}`,
        `flipped=${s.flipped}`,
        `unmatched=${s.unmatched}`,
        `maxBlock=${s.maxBlock}`,
      ];
      if (s.error) parts.push(`error=${s.error}`);
      console.log(`[verifier] pass: ${parts.join(" ")}`);
    },
  });
  db.close();
}

main().catch((err) => {
  console.error("[verifier] fatal:", err);
  process.exit(1);
});
