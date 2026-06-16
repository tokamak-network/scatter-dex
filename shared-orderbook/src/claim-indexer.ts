/**
 * Claim-indexer daemon entry. Reads RPC + PrivateSettlement address + deploy
 * block from env, attaches to the same SQLite file the orderbook server reads
 * from, and indexes `PrivateClaim` nullifiers so `GET /api/claim-nullifiers`
 * can serve spent-claim lookups. Mirrors `src/commitment-indexer.ts`.
 *
 * Multi-network: one process runs a loop per chain, each binding its own RPC +
 * settlement but sharing the one SQLite DB (rows are scoped by chain_id).
 *
 * Env:
 *   CLAIM_CHAINS              — JSON array of per-chain configs, e.g.
 *                              [{"chainId":11155111,"rpcUrl":"https://…",
 *                                "settlementAddress":"0x…",
 *                                "deployBlock":11008264}, …]. Wins over the
 *                              single-chain vars below.
 *   RPC_URL                   — JSON-RPC endpoint (single-chain fallback)
 *   SETTLEMENT_ADDRESS        — 0x… (single-chain fallback)
 *   CLAIM_DEPLOY_BLOCK        — settlement deploy block (single-chain fallback)
 *   CHAIN_ID                  — chainId for the single-chain fallback
 *                              (default 11155111 / Sepolia)
 *   DB_PATH                   — same path the API uses (default shared-orderbook.db)
 *   CLAIM_POLL_INTERVAL_SEC   — watch-mode pass interval (default 30)
 *   CLAIM_BLOCK_SAFETY_MARGIN — confirmations to stay behind head (default 6)
 *   CLAIM_INDEX_BLOCK_RANGE   — max blocks per getLogs window (default 50000)
 *
 * Modes:
 *   node dist/claim-indexer.js          # one-shot pass per chain, exit 0
 *   node dist/claim-indexer.js --watch  # loop per chain until SIGINT/SIGTERM
 */
import "dotenv/config";
import { JsonRpcProvider, isAddress } from "ethers";
import { OrderbookDB } from "./core/db.js";
import {
  makeClaimNullifierFetcher,
  runClaimIndexLoop,
  runClaimIndexPass,
} from "./core/claim-indexer.js";
import { DEFAULT_CHAIN_ID } from "./core/chain.js";

interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  settlementAddress: string;
  deployBlock: number;
}

function envRequired(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[claim-indexer] missing required env: ${key}`);
    process.exit(2);
  }
  return v;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  // These are all block numbers / counts / seconds — require a non-negative
  // integer so a stray "1.5" or "0x10" fails loudly instead of silently
  // truncating mid-scan.
  if (!Number.isInteger(n) || n < 0) {
    console.error(`[claim-indexer] invalid numeric env: ${key}=${raw}`);
    process.exit(2);
  }
  return n;
}

/** CLAIM_CHAINS (a JSON array) wins; otherwise fall back to single-chain env vars. */
function resolveChains(): ChainConfig[] {
  const raw = process.env.CLAIM_CHAINS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[claim-indexer] CLAIM_CHAINS is not valid JSON");
      process.exit(2);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[claim-indexer] CLAIM_CHAINS must be a non-empty JSON array");
      process.exit(2);
    }
    return parsed.map((c, i) => {
      if (typeof c !== "object" || c === null) {
        console.error(`[claim-indexer] CLAIM_CHAINS[${i}] must be an object`);
        process.exit(2);
      }
      const o = c as Record<string, unknown>;
      const reqStr = (field: string): string => {
        const v = o[field];
        if (typeof v !== "string" || !v.trim()) {
          console.error(`[claim-indexer] CLAIM_CHAINS[${i}].${field} must be a non-empty string`);
          process.exit(2);
        }
        return v.trim();
      };
      const chainId = Number(o.chainId);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        console.error(`[claim-indexer] CLAIM_CHAINS[${i}].chainId must be a positive integer`);
        process.exit(2);
      }
      const deployBlock = Number(o.deployBlock);
      if (!Number.isInteger(deployBlock) || deployBlock < 0) {
        console.error(`[claim-indexer] CLAIM_CHAINS[${i}].deployBlock must be a non-negative integer`);
        process.exit(2);
      }
      const settlementAddress = reqStr("settlementAddress");
      if (!isAddress(settlementAddress)) {
        console.error(`[claim-indexer] CLAIM_CHAINS[${i}].settlementAddress is not a valid EVM address`);
        process.exit(2);
      }
      return { chainId, rpcUrl: reqStr("rpcUrl"), settlementAddress, deployBlock };
    });
  }
  // Single-chain fallback.
  const settlementAddress = envRequired("SETTLEMENT_ADDRESS").trim();
  if (!isAddress(settlementAddress)) {
    console.error("[claim-indexer] SETTLEMENT_ADDRESS is not a valid EVM address");
    process.exit(2);
  }
  return [{
    chainId: envInt("CHAIN_ID", DEFAULT_CHAIN_ID),
    rpcUrl: envRequired("RPC_URL"),
    settlementAddress,
    deployBlock: envInt("CLAIM_DEPLOY_BLOCK", 0),
  }];
}

async function main(): Promise<void> {
  const chains = resolveChains();
  const dbPath = process.env.DB_PATH ?? "shared-orderbook.db";
  const watch = process.argv.includes("--watch");
  const safety = envInt("CLAIM_BLOCK_SAFETY_MARGIN", 6);
  const chunkSize = envInt("CLAIM_INDEX_BLOCK_RANGE", 50_000);
  const db = new OrderbookDB(dbPath);

  if (!watch) {
    // One-shot — useful for cron. Track failures so the process exits
    // non-zero if any chain's pass errored (the pass catches + returns the
    // error rather than throwing), instead of a misleading exit 0.
    let failed = false;
    for (const c of chains) {
      // Isolate each chain: a thrown getBlockNumber (RPC hiccup / 429) on one
      // chain must not abort the remaining chains' passes. Record the failure
      // so the process still exits non-zero.
      try {
        const provider = new JsonRpcProvider(c.rpcUrl);
        const fetcher = makeClaimNullifierFetcher({
          rpcUrl: c.rpcUrl,
          settlementAddress: c.settlementAddress,
          provider,
        });
        const latest = await provider.getBlockNumber();
        const toBlock = Math.max(0, latest - safety);
        const s = await runClaimIndexPass(db, fetcher, {
          chainId: c.chainId,
          settlementAddress: c.settlementAddress,
          deployBlock: c.deployBlock,
          toBlock,
          chunkSize,
        });
        if (s.error) failed = true;
        console.log(
          `[claim-indexer] one-shot chain=${c.chainId}: indexed=${s.indexed} ` +
            `range=[${s.fromBlock},${s.toBlock}]${s.error ? ` error=${s.error}` : ""}`,
        );
      } catch (err) {
        failed = true;
        console.error(
          `[claim-indexer] one-shot chain=${c.chainId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    db.close();
    if (failed) process.exit(1);
    return;
  }

  const ac = new AbortController();
  const shutdown = (sig: string): void => {
    console.log(`[claim-indexer] received ${sig}; draining and exiting`);
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const intervalSec = envInt("CLAIM_POLL_INTERVAL_SEC", 30);
  console.log(`[claim-indexer] watch mode, db=${dbPath}, chains=[${chains.map((c) => c.chainId).join(",")}]`);

  await Promise.all(chains.map((c) => {
    const provider = new JsonRpcProvider(c.rpcUrl);
    const fetcher = makeClaimNullifierFetcher({
      rpcUrl: c.rpcUrl,
      settlementAddress: c.settlementAddress,
      provider,
    });
    console.log(`[claim-indexer] chain=${c.chainId} @ ${c.rpcUrl}, settlement=${c.settlementAddress}, deployBlock=${c.deployBlock}`);
    return runClaimIndexLoop(db, fetcher, {
      chainId: c.chainId,
      settlementAddress: c.settlementAddress,
      deployBlock: c.deployBlock,
      intervalSec,
      blockSafetyMargin: safety,
      chunkSize,
      provider,
      signal: ac.signal,
      onPass: (s) => {
        const parts = [`chain=${c.chainId}`, `indexed=${s.indexed}`, `range=[${s.fromBlock},${s.toBlock}]`];
        if (s.error) parts.push(`error=${s.error}`);
        console.log(`[claim-indexer] pass: ${parts.join(" ")}`);
      },
    });
  }));
  db.close();
}

main().catch((err) => {
  console.error("[claim-indexer] fatal:", err);
  process.exit(1);
});
