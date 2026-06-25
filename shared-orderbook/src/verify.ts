/**
 * Verifier daemon entry. Reads RPC + contract address + DB path from
 * env, attaches to the same SQLite file the orderbook server writes,
 * and runs the verify loop until SIGINT/SIGTERM. One-shot mode (no
 * --watch) runs a single pass and exits — useful for cron-driven
 * operators.
 *
 * Multi-network: one verifier process runs a loop per chain, each binding its
 * own RPC + settlement contract but sharing the one SQLite DB (rows are
 * scoped by chain_id). Configure either a single chain via the legacy env
 * vars, or several via CHAINS.
 *
 * Env:
 *   CHAINS                         — JSON array of per-chain configs, e.g.
 *                                    [{"chainId":11155111,"rpcUrl":"https://…",
 *                                      "settlementAddress":"0x…"}, …].
 *                                    When set, takes precedence over the
 *                                    single-chain vars below.
 *   RPC_URL                        — JSON-RPC endpoint (single-chain fallback)
 *   PRIVATE_SETTLEMENT_ADDRESS     — 0x… (single-chain fallback)
 *   CHAIN_ID                       — chainId for the single-chain fallback
 *                                    (default 11155111 / Sepolia)
 *   DB_PATH                        — same path the API uses (default shared-orderbook.db)
 *   VERIFIER_POLL_INTERVAL_SEC     — watch-mode pass interval (default 30)
 *   VERIFIER_BLOCK_SAFETY_MARGIN   — confirmations to skip (default 6)
 *   VERIFIER_LIMIT_PER_PASS        — max rows per pass (default 500)
 *
 * Modes:
 *   node dist/verify.js             # one-shot pass per chain, exit 0 on success
 *   node dist/verify.js --watch     # loop per chain until SIGINT/SIGTERM
 */
import "dotenv/config";
import { JsonRpcProvider, isAddress } from "ethers";
import { OrderbookDB } from "./core/db.js";
import { runVerifyPass } from "./core/verifier.js";
import { makeEventFetcher, runVerifyLoop, VerifyMonitor } from "./core/verify-runtime.js";
import { DEFAULT_CHAIN_ID } from "./core/chain.js";

interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  settlementAddress: string;
}

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

/**
 * Resolve the set of chains to verify. CHAINS (a JSON array) wins; otherwise
 * fall back to the single-chain env vars so existing single-network
 * deployments keep working unchanged.
 */
function resolveChains(): ChainConfig[] {
  const raw = process.env.CHAINS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[verifier] CHAINS is not valid JSON");
      process.exit(2);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[verifier] CHAINS must be a non-empty JSON array");
      process.exit(2);
    }
    return parsed.map((c, i) => {
      if (typeof c !== "object" || c === null) {
        console.error(`[verifier] CHAINS[${i}] must be an object`);
        process.exit(2);
      }
      const o = c as Record<string, unknown>;
      // Trim surrounding whitespace so a stray space in config doesn't make an
      // address silently never match on-chain.
      const reqStr = (field: string): string => {
        const v = o[field];
        if (typeof v !== "string" || !v.trim()) {
          console.error(`[verifier] CHAINS[${i}].${field} must be a non-empty string`);
          process.exit(2);
        }
        return v.trim();
      };
      const chainId = Number(o.chainId);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        console.error(`[verifier] CHAINS[${i}].chainId must be a positive integer`);
        process.exit(2);
      }
      const settlementAddress = reqStr("settlementAddress");
      if (!isAddress(settlementAddress)) {
        console.error(`[verifier] CHAINS[${i}].settlementAddress is not a valid EVM address`);
        process.exit(2);
      }
      return { chainId, rpcUrl: reqStr("rpcUrl"), settlementAddress };
    });
  }
  // Single-chain fallback.
  const settlementAddress = envRequired("PRIVATE_SETTLEMENT_ADDRESS").trim();
  if (!isAddress(settlementAddress)) {
    console.error("[verifier] PRIVATE_SETTLEMENT_ADDRESS is not a valid EVM address");
    process.exit(2);
  }
  return [{
    chainId: envInt("CHAIN_ID", DEFAULT_CHAIN_ID),
    rpcUrl: envRequired("RPC_URL"),
    settlementAddress,
  }];
}

async function main(): Promise<void> {
  const chains = resolveChains();
  const dbPath = process.env.DB_PATH ?? "shared-orderbook.db";
  const watch = process.argv.includes("--watch");
  const safety = envInt("VERIFIER_BLOCK_SAFETY_MARGIN", 6);
  const limit = envInt("VERIFIER_LIMIT_PER_PASS", 500);
  // Cap the getLogs window per pass so a stuck low-block row can't stretch the
  // fetch range across millions of blocks and trip an RPC's "range too large"
  // limit (which would throw and stall the quarantine). 10k stays under the
  // common provider caps (Infura ~10k, Alchemy response-size bound); tune per
  // RPC. The verifier just makes progress in 10k-block steps.
  const maxBlockRange = envInt("VERIFIER_MAX_BLOCK_RANGE", 10000);
  // One DB handle shared by every chain's loop — rows are partitioned by
  // chain_id, so the loops never collide.
  const db = new OrderbookDB(dbPath);

  if (!watch) {
    // One-shot — useful for cron-driven backends. Run each chain in turn.
    for (const c of chains) {
      const provider = new JsonRpcProvider(c.rpcUrl);
      const fetcher = makeEventFetcher({ rpcUrl: c.rpcUrl, contractAddress: c.settlementAddress, provider });
      const latest = await provider.getBlockNumber();
      const maxBlock = Math.max(0, latest - safety);
      const r = await runVerifyPass(db, fetcher, { chainId: c.chainId, maxBlock, limit, maxBlockRange });
      console.log(
        `[verifier] one-shot chain=${c.chainId}: scanned=${r.scanned} flipped=${r.flipped} unmatched=${r.report.unmatched.length} maxBlock=${maxBlock}`,
      );
    }
    db.close();
    return;
  }

  const ac = new AbortController();
  const shutdown = (sig: string): void => {
    console.log(`[verifier] received ${sig}; draining current passes and exiting`);
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const intervalSec = envInt("VERIFIER_POLL_INTERVAL_SEC", 30);
  console.log(`[verifier] watch mode, db=${dbPath}, chains=[${chains.map((c) => c.chainId).join(",")}]`);

  // One loop per chain, all sharing the abort signal so SIGINT drains them
  // together. Each gets its own provider + fetcher + monitor.
  await Promise.all(chains.map((c) => {
    const provider = new JsonRpcProvider(c.rpcUrl);
    const fetcher = makeEventFetcher({ rpcUrl: c.rpcUrl, contractAddress: c.settlementAddress, provider });
    console.log(`[verifier] chain=${c.chainId} @ ${c.rpcUrl}, contract=${c.settlementAddress}`);
    return runVerifyLoop(db, fetcher, {
      chainId: c.chainId,
      intervalSec,
      blockSafetyMargin: safety,
      limitPerPass: limit,
      maxBlockRange,
      provider,
      monitor: new VerifyMonitor(),
      signal: ac.signal,
      onPass: (s) => {
        const parts = [
          `chain=${c.chainId}`,
          `scanned=${s.scanned}`,
          `flipped=${s.flipped}`,
          `unmatched=${s.unmatched}`,
          `maxBlock=${s.maxBlock}`,
        ];
        if (s.error) parts.push(`error=${s.error}`);
        console.log(`[verifier] pass: ${parts.join(" ")}`);
      },
    });
  }));
  db.close();
}

main().catch((err) => {
  console.error("[verifier] fatal:", err);
  process.exit(1);
});
